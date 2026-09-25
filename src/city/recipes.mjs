// Build recipes: the record of how a building's model was produced, and the rule generators that
// produce it.
//
// A recipe is kept because a model without one is a dead end -- nobody can tell whether a block is a
// measured survey, a rule applied to a footprint, or something an agent drew by hand, and nobody can
// rebuild it after the input changes. So the recipe pins: the building, the input resources and
// their digests, the hard constraints, the generator and its version, the parameters, the seed, and
// the asset that came out.
//
// The generators here are RULES. An agent chooses the rule and fills the parameters; it does not get
// to emit geometry directly, because then the recipe would describe nothing. A one-off shape goes
// through the "script" generator, which records the command and its output instead of pretending it
// was parametric.
import { createHash } from "node:crypto";
import { bboxOf, distance, mm, polygonArea, ringCentroid } from "./geo.mjs";

export const RECIPE_SCHEMA = "SSWorldCityRecipe/1";
export const GENERATOR_VERSION = "1";

const digestOf = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;

/**
 * One canonical text for a recipe, so the digest means the same thing in this module and in the
 * Python modeller (ssdl_city.recipes). Keys are sorted, separators are tight, and a float whose
 * value is a whole number is written as an integer -- Python prints 15.0 where JavaScript prints 15,
 * and a digest that disagrees across the two tools is worse than no digest at all.
 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) ? String(Math.trunc(value)) : JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export const recipeDigest = (recipe) => `sha256:${createHash("sha256").update(canonicalJson({ ...recipe, recipe_digest: "" })).digest("hex")}`;

export const GENERATORS = {
  /** The plain block: the real footprint, extruded to the stated height. */
  footprint_extrusion: {
    parameters: { floor_height_m: { type: "number", default: 3, min: 2 } },
    build({ footprint, height_m, parameters }) {
      const floors = Math.max(1, Math.round(height_m / (parameters.floor_height_m ?? 3)));
      return {
        kind: "parametric",
        nodes: [{ type: "ExtrudedPolygon", role: "mass", outer: footprint, height: mm(height_m) }],
        dimensions: { height_m: mm(height_m), floors, floor_height_m: parameters.floor_height_m ?? 3 },
      };
    },
  },
  /** Block plus a pitched roof: the commonest real shape the plain extrusion gets wrong. */
  footprint_extrusion_roof: {
    parameters: {
      floor_height_m: { type: "number", default: 3, min: 2 },
      roof_style: { type: "string", default: "gable", enum: ["gable", "hip", "shed"] },
      roof_pitch_deg: { type: "number", default: 30, min: 1, max: 70 },
      roof_overhang_m: { type: "number", default: 0.4, min: 0 },
    },
    build({ footprint, height_m, parameters }) {
      const pitch = parameters.roof_pitch_deg ?? 30;
      const style = parameters.roof_style ?? "gable";
      const span = shortestSpan(footprint);
      const radians = pitch * (Math.PI / 180);   // the same grouping CPython's math.radians uses
      const roofHeight = style === "shed" ? Math.tan(radians) * span : (Math.tan(radians) * span) / 2;
      const wallHeight = Math.max(2, height_m - roofHeight);
      return {
        kind: "parametric",
        nodes: [
          { type: "ExtrudedPolygon", role: "mass", outer: footprint, height: mm(wallHeight) },
          { type: "Roof", role: "roof", outer: footprint, style, pitch, overhang: parameters.roof_overhang_m ?? 0.4, base_z: mm(wallHeight) },
        ],
        dimensions: { height_m: mm(wallHeight + roofHeight), wall_height_m: mm(wallHeight), roof_height_m: mm(roofHeight),
          floors: Math.max(1, Math.round(wallHeight / (parameters.floor_height_m ?? 3))) },
      };
    },
  },
  /** Setback tower: a podium and a smaller shaft, the other shape a single extrusion cannot express. */
  podium_tower: {
    parameters: {
      podium_height_m: { type: "number", default: 12, min: 3 },
      tower_inset_m: { type: "number", default: 6, min: 0.5 },
      floor_height_m: { type: "number", default: 3, min: 2 },
    },
    build({ footprint, height_m, parameters }) {
      const podium = Math.min(parameters.podium_height_m ?? 12, height_m - 3);
      const inset = parameters.tower_inset_m ?? 6;
      return {
        kind: "parametric",
        nodes: [
          { type: "ExtrudedPolygon", role: "podium", outer: footprint, height: mm(podium) },
          { type: "ExtrudedPolygon", role: "tower", outer: footprint, height: mm(height_m - podium), base_z: mm(podium), taper: inset },
        ],
        dimensions: { height_m: mm(height_m), podium_height_m: mm(podium), tower_inset_m: inset,
          floors: Math.max(1, Math.round(height_m / (parameters.floor_height_m ?? 3))) },
      };
    },
  },
  /** The escape hatch: whatever an external tool produced, recorded as what it is. */
  script: {
    parameters: { command: { type: "string" }, asset_ref: { type: "string" } },
    build({ parameters, height_m, footprint }) {
      if (!parameters.command) throw Object.assign(new Error("the script generator needs a command"), { code: "recipe_parameter_missing" });
      if (!parameters.asset_ref) throw Object.assign(new Error("the script generator needs the asset_ref it produced"), { code: "recipe_parameter_missing" });
      return {
        kind: "script_output",
        nodes: [{ type: "Model", role: "mass", source: parameters.asset_ref }],
        dimensions: { height_m: mm(height_m), footprint_area_m2: mm(polygonArea([footprint])) },
        script: { command: parameters.command, command_digest: digestOf(parameters.command) },
      };
    },
  },
};

function shortestSpan(ring) {
  const [minX, minY, maxX, maxY] = bboxOf(ring);
  return Math.min(maxX - minX, maxY - minY);
}

/**
 * Build a candidate for one building. Returns the candidate AND the checks it passed or failed --
 * a candidate that fails a hard constraint is returned WITH the failure rather than thrown away, so
 * the caller can see what the rule actually produced.
 */
export function buildCandidate(model, {
  building_id, generator_id = "footprint_extrusion", parameters = {}, seed = 0,
  constraints = {}, input_refs = [], tool_versions = {}, recipe_id = null, source_digests = {},
}) {
  const building = model.objects.buildings.find((item) => item.id === building_id);
  if (!building) throw Object.assign(new Error(`no building '${building_id}'`), { code: "building_not_found" });
  const generator = GENERATORS[generator_id];
  if (!generator) {
    throw Object.assign(new Error(`unknown generator '${generator_id}'; known: ${Object.keys(GENERATORS).sort().join(", ")}`), { code: "generator_not_found" });
  }
  const survey = model.objects.surveys.find((item) => item.building_id === building_id) ?? null;
  const footprint = (constraints.footprint ?? building.geometry.coordinates[0]).map(([x, y]) => [mm(x), mm(y)]);
  const ring = footprint[0][0] === footprint[footprint.length - 1][0] && footprint[0][1] === footprint[footprint.length - 1][1]
    ? footprint.slice(0, -1) : footprint;
  const height = constraints.height_m ?? survey?.height_m ?? building.height_m;
  if (height === null || height === undefined) {
    throw Object.assign(new Error(`building '${building_id}' has no height, and the recipe gave no constraint`), { code: "recipe_input_missing" });
  }
  const resolved = Object.fromEntries(Object.entries(generator.parameters).map(([name, spec]) =>
    [name, parameters[name] ?? spec.default]));
  for (const [name, spec] of Object.entries(generator.parameters)) {
    const value = resolved[name];
    if (value === undefined) continue;
    if (spec.min !== undefined && value < spec.min) throw Object.assign(new Error(`${name} must be at least ${spec.min}`), { code: "recipe_parameter_invalid" });
    if (spec.max !== undefined && value > spec.max) throw Object.assign(new Error(`${name} must be at most ${spec.max}`), { code: "recipe_parameter_invalid" });
    if (spec.enum && !spec.enum.includes(value)) throw Object.assign(new Error(`${name} must be one of ${spec.enum.join(", ")}`), { code: "recipe_parameter_invalid" });
  }
  const candidate = generator.build({ footprint: ring, height_m: height, parameters: resolved, seed, building, survey });

  const recipe = {
    schema_version: RECIPE_SCHEMA,
    recipe_id: recipe_id ?? `recipe-${building_id}-${generator_id}`,
    building_id,
    input_refs: input_refs.length ? input_refs : [`buildings.geojson#${building_id}`, ...(survey ? [`modeling_survey.geojson#${survey.id}`] : [])],
    source_digests,
    constraints: { footprint_source: constraints.footprint ? "command" : `building:${building_id}`, height_m: height,
      ...(survey ? { survey_width_m: survey.width_m, survey_depth_m: survey.depth_m, survey_height_m: survey.height_m } : {}) },
    generator_id, generator_version: GENERATOR_VERSION, parameters: resolved, seed, tool_versions,
    regeneration_mode: candidate.kind === "script_output" ? "recorded_script" : "parametric",
    output_asset_ref: candidate.kind === "script_output" ? resolved.asset_ref : null,
    photos: survey?.photos ?? [],
  };
  recipe.recipe_digest = recipeDigest(recipe);

  return { recipe, candidate, checks: checkCandidate(model, building, candidate, { survey, constraints, footprint: ring }) };
}

/** Hard checks a candidate must pass before it may replace a standing building. */
export function checkCandidate(model, building, candidate, { survey = null, constraints = {}, footprint } = {}) {
  const checks = [];
  const record = (name, passed, detail) => checks.push({ check: name, passed, ...detail });

  const area = mm(polygonArea([footprint]));
  record("footprint_area", Math.abs(area - building.area_m2) <= Math.max(0.5, building.area_m2 * 0.01),
    { candidate_m2: area, building_m2: building.area_m2 });

  const centroid = ringCentroid(footprint);
  record("position", distance(centroid, building.centroid) <= 1.0, { candidate: centroid, building: building.centroid });

  const height = candidate.dimensions.height_m;
  const target = constraints.height_m ?? survey?.height_m ?? building.height_m;
  record("height", target === null || target === undefined || Math.abs(height - target) <= Math.max(0.25, target * 0.02),
    { candidate_m: height, target_m: target ?? null });

  if (survey) {
    const [minX, minY, maxX, maxY] = bboxOf(footprint);
    const width = mm(maxX - minX), depth = mm(maxY - minY);
    record("survey_dimensions", (survey.width_m === null || Math.abs(width - survey.width_m) <= 0.5)
      && (survey.depth_m === null || Math.abs(depth - survey.depth_m) <= 0.5),
      { candidate: [width, depth], survey: [survey.width_m, survey.depth_m] });
  }

  // Portals must still be reachable from outside the new mass: a candidate that swallows its own
  // door looks fine in a screenshot and is unusable.
  const portals = model.objects.portals.filter((portal) => portal.building_id === building.id);
  const swallowed = portals.filter((portal) => pointInRingStrict(portal.position, footprint));
  record("portals_clear", swallowed.length === 0, { portals: portals.map((portal) => portal.id), swallowed: swallowed.map((portal) => portal.id) });

  // No overlap with a neighbour: two masses in the same place is the "double image" failure.
  const overlaps = model.objects.buildings.filter((other) => other.id !== building.id)
    .filter((other) => boxesOverlap(bboxOf(footprint), other.bbox)).map((other) => other.id);
  record("no_neighbour_overlap", overlaps.length === 0, { overlaps });

  return { passed: checks.every((check) => check.passed), checks };
}

function pointInRingStrict(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function boxesOverlap(a, b) {
  return a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
}

export function generatorCatalog() {
  return Object.entries(GENERATORS).map(([id, generator]) => ({
    generator_id: id, generator_version: GENERATOR_VERSION,
    parameters: Object.fromEntries(Object.entries(generator.parameters).map(([name, spec]) => [name, { ...spec }])),
  }));
}
