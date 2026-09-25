// The city's command surface. One place that knows what a change MEANS, so the store only has to
// know how to record it and the run host only has to know what it invalidated.
//
// Every command declares:
//   scope       - the objects it touches, for the page and for "what did this change"
//   invalidates - which derived results stop being true (routing / traffic / flood / display).
//                 Swapping a building's appearance invalidates display and nothing else; moving a
//                 gate invalidates routing; changing a water level invalidates flood and, through
//                 it, routing. This is the whole of section 10.3 and it lives here, not in six
//                 call sites that each remember a different half of it.
import { materialize } from "./revision.mjs";
import { pointInAnyPolygon, ringCentroid, polygonArea, distance, mm } from "./geo.mjs";

export const COMMAND_SCHEMA = "SSWorldCityCommand/1";

const refuse = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, extra }); };
const find = (list, id) => list.find((item) => item.id === id) ?? null;

/** Land-use plans the first version knows how to build. Anything else is refused rather than guessed. */
export const LAND_USE_PLANS = Object.freeze({
  park: { requires: [], produces: { resident_count: 0 }, default_impervious_fraction: 0.15 },
  mixed: { requires: ["gross_floor_area_m2"], produces: {}, default_impervious_fraction: 0.75 },
  residential: { requires: [], produces: {}, default_impervious_fraction: 0.6 },
  commercial: { requires: [], produces: {}, default_impervious_fraction: 0.8 },
});

export const COMMANDS = {
  // --- M2: gates ---------------------------------------------------------------------------
  "portal.move": {
    invalidates: ["routing", "traffic", "display"],
    run(overrides, { model, params }) {
      const portal = find(model.objects.portals, params.portal_id) ?? refuse("portal_not_found", `no portal '${params.portal_id}'`);
      if (!Array.isArray(params.position) || params.position.length !== 2) refuse("invalid_position", "position must be [x, y] in local metres");
      const parcel = portal.parcel_id ? find(model.objects.parcels, portal.parcel_id) : null;
      // A gate has to stay on its own parcel boundary; a portal dropped in the middle of a block or
      // across the river would route people through a wall.
      if (parcel && !pointInAnyPolygon(params.position, parcel.geometry)) {
        const onBoundary = parcel.geometry.coordinates[0].some((point, index, ring) =>
          index < ring.length - 1 && pointToSegment(params.position, point, ring[index + 1]) <= 1.0);
        if (!onBoundary) refuse("portal_off_parcel", `position is neither inside nor within 1 m of parcel '${parcel.id}'`, { parcel_id: parcel.id });
      }
      const moved_m = mm(distance(portal.position, params.position));
      overrides.portals[portal.id] = { ...(overrides.portals[portal.id] ?? {}), position: [mm(params.position[0]), mm(params.position[1])],
        ...(params.elevation_m === undefined ? {} : { elevation_m: params.elevation_m }) };
      return { overrides, effect: { portal_id: portal.id, moved_m, from: portal.position, to: params.position,
        affected_edges: model.network.edges.filter((edge) => edge.from_node === portal.node_id || edge.to_node === portal.node_id).map((edge) => edge.id) } };
    },
  },
  "portal.set": {
    invalidates: ["routing", "traffic"],
    run(overrides, { model, params }) {
      const portal = find(model.objects.portals, params.portal_id) ?? refuse("portal_not_found", `no portal '${params.portal_id}'`);
      const patch = {};
      if (params.direction !== undefined) {
        if (!["both", "in", "out"].includes(params.direction)) refuse("invalid_direction", "direction must be 'both', 'in' or 'out'");
        patch.direction = params.direction;
      }
      for (const field of ["walk_capacity_person_s", "car_capacity_vehicle_s"]) {
        if (params[field] === undefined) continue;
        if (!(params[field] > 0)) refuse("invalid_capacity", `${field} must be greater than zero`);
        patch[field] = params[field];
      }
      if (params.modes !== undefined) {
        if (!Array.isArray(params.modes) || !params.modes.length) refuse("invalid_modes", "modes must be a non-empty array");
        patch.modes = params.modes;
      }
      if (!Object.keys(patch).length) refuse("empty_command", "portal.set needs at least one of direction, modes or a capacity");
      overrides.portals[portal.id] = { ...(overrides.portals[portal.id] ?? {}), ...patch };
      return { overrides, effect: { portal_id: portal.id, patch } };
    },
  },
  "portal.close": {
    invalidates: ["routing", "traffic"],
    control: true,
    run(overrides, { model, params }) {
      const portal = find(model.objects.portals, params.portal_id) ?? refuse("portal_not_found", `no portal '${params.portal_id}'`);
      overrides.portals[portal.id] = { ...(overrides.portals[portal.id] ?? {}), open: false, closed_reason: params.reason ?? "closed_by_command" };
      return { overrides, effect: { portal_id: portal.id, open: false, reason: params.reason ?? "closed_by_command" } };
    },
  },
  "portal.open": {
    invalidates: ["routing", "traffic"],
    control: true,
    run(overrides, { model, params }) {
      const portal = find(model.objects.portals, params.portal_id) ?? refuse("portal_not_found", `no portal '${params.portal_id}'`);
      overrides.portals[portal.id] = { ...(overrides.portals[portal.id] ?? {}), open: true, closed_reason: null };
      return { overrides, effect: { portal_id: portal.id, open: true } };
    },
  },

  // --- M3: water ---------------------------------------------------------------------------
  "water.set_level": {
    invalidates: ["flood", "routing", "traffic", "display"],
    run(overrides, { model, params }) {
      const body = find(model.objects.water, params.water_id) ?? refuse("water_not_found", `no water body '${params.water_id}'`);
      if (typeof params.level_m !== "number" || !Number.isFinite(params.level_m)) refuse("invalid_level", "level_m must be a finite number");
      if (body.baseline_level_m === null || body.baseline_level_m === undefined) {
        refuse("baseline_level_unknown", `water body '${body.id}' has no baseline water surface, so a level change has no datum to sit on`);
      }
      overrides.water[body.id] = { level_m: params.level_m };
      return { overrides, effect: { water_id: body.id, level_m: params.level_m, baseline_level_m: body.baseline_level_m,
        delta_m: mm(params.level_m - body.baseline_level_m) } };
    },
  },
  "water.reset_level": {
    invalidates: ["flood", "routing", "traffic", "display"],
    run(overrides, { model, params }) {
      const body = find(model.objects.water, params.water_id) ?? refuse("water_not_found", `no water body '${params.water_id}'`);
      delete overrides.water[body.id];
      return { overrides, effect: { water_id: body.id, level_m: body.baseline_level_m, restored: "dataset_baseline",
        note: "clearing the water level clears FLOOD closures only; operator and hazard closures stay" } };
    },
  },

  // --- M6: hazards --------------------------------------------------------------------------
  "hazard.activate": {
    invalidates: ["routing", "traffic", "display"],
    run(overrides, { model, params }) {
      let hazard = find(model.objects.hazards, params.hazard_id);
      if (!hazard && params.extent) {
        hazard = { id: params.hazard_id, geometry: params.extent, hazard_type: params.hazard_type ?? "landslide",
          input_type: params.input_type ?? "authored_extent", name: params.name ?? params.hazard_id,
          centroid: ringCentroid(params.extent.coordinates[0]), area_m2: mm(polygonArea(params.extent.coordinates)),
          provenance: { source_file: "command:hazard.activate", source_id: params.hazard_id, quality_status: params.quality_status ?? "authored_assumption", synthetic: false, source_ref: params.source_ref ?? null } };
        overrides.hazards[params.hazard_id] = { active: true, added: hazard, effective_at_s: params.effective_at_s ?? null, source_ref: params.source_ref ?? null };
      } else if (hazard) {
        overrides.hazards[hazard.id] = { ...(overrides.hazards[hazard.id] ?? {}), active: true, effective_at_s: params.effective_at_s ?? null, source_ref: params.source_ref ?? hazard.provenance?.source_ref ?? null };
      } else refuse("hazard_not_found", `no hazard '${params.hazard_id}' and no extent given to create one`);
      return { overrides, effect: { hazard_id: params.hazard_id, hazard_type: hazard.hazard_type,
        input_type: hazard.input_type, effective_at_s: params.effective_at_s ?? null,
        limitation: "an authored extent carries no runout, trigger probability or failure timing" } };
    },
  },
  "hazard.deactivate": {
    invalidates: ["routing", "traffic", "display"],
    run(overrides, { params }) {
      if (!overrides.hazards[params.hazard_id]) refuse("hazard_not_active", `hazard '${params.hazard_id}' is not active`);
      overrides.hazards[params.hazard_id] = { ...overrides.hazards[params.hazard_id], active: false };
      return { overrides, effect: { hazard_id: params.hazard_id, active: false,
        note: "clearing a hazard clears its own closures only; flood and operator closures stay" } };
    },
  },

  // --- operator closures ----------------------------------------------------------------------
  "road.close": {
    invalidates: ["routing", "traffic"],
    control: true,
    run(overrides, { model, params }) {
      const edge = model.network.edges.find((item) => item.id === params.edge_id) ?? refuse("edge_not_found", `no network edge '${params.edge_id}'`);
      overrides.closures.edges[edge.id] = { reason: params.reason ?? "closed_by_operator", cause: "manual", at: new Date().toISOString() };
      return { overrides, effect: { edge_id: edge.id, status: "closed", cause: "manual", reason: params.reason ?? "closed_by_operator" } };
    },
  },
  "road.open": {
    invalidates: ["routing", "traffic"],
    control: true,
    run(overrides, { params }) {
      if (!overrides.closures.edges[params.edge_id]) refuse("edge_not_closed", `edge '${params.edge_id}' carries no operator closure (a flood or hazard closure is cleared by its own cause)`);
      delete overrides.closures.edges[params.edge_id];
      return { overrides, effect: { edge_id: params.edge_id, status: "open", cause: "manual" } };
    },
  },

  // --- M4: buildings --------------------------------------------------------------------------
  "building.replace_asset": {
    invalidates: ["display"],
    run(overrides, { model, params }) {
      const building = find(model.objects.buildings, params.building_id) ?? refuse("building_not_found", `no building '${params.building_id}'`);
      if (!params.asset || typeof params.asset !== "object") refuse("invalid_asset", "asset must be an object describing the generated model");
      const previous = overrides.buildings[building.id]?.asset ?? null;
      overrides.buildings[building.id] = { ...(overrides.buildings[building.id] ?? {}),
        asset: { ...params.asset, replaced_at: new Date().toISOString() },
        recipe_id: params.recipe_id ?? building.recipe_id ?? null };
      overrides.assets[building.id] = { previous, current: params.asset, locked: params.locked === true };
      return { overrides, effect: { building_id: building.id, asset_kind: params.asset.kind ?? null,
        recipe_id: params.recipe_id ?? null, replaced_previous: Boolean(previous),
        note: "appearance only: footprint, population and demand are unchanged" } };
    },
  },
  "building.set_geometry": {
    invalidates: ["routing", "traffic", "flood", "display"],
    run(overrides, { model, params }) {
      const building = find(model.objects.buildings, params.building_id) ?? refuse("building_not_found", `no building '${params.building_id}'`);
      const patch = {};
      if (params.height_m !== undefined) {
        if (!(params.height_m > 0)) refuse("invalid_height", "height_m must be greater than zero");
        patch.height_m = params.height_m;
      }
      if (params.footprint) {
        if (params.footprint.type !== "Polygon") refuse("invalid_footprint", "footprint must be a GeoJSON-shaped Polygon in local metres");
        patch.geometry = params.footprint;
      }
      if (params.floor_elevation_m !== undefined) patch.floor_elevation_m = params.floor_elevation_m;
      if (!Object.keys(patch).length) refuse("empty_command", "building.set_geometry needs height_m, footprint or floor_elevation_m");
      overrides.buildings[building.id] = { ...(overrides.buildings[building.id] ?? {}), ...patch };
      return { overrides, effect: { building_id: building.id, patch: Object.keys(patch) } };
    },
  },
  "building.set_use": {
    invalidates: ["traffic", "display"],
    run(overrides, { model, params }) {
      const building = find(model.objects.buildings, params.building_id) ?? refuse("building_not_found", `no building '${params.building_id}'`);
      if (!params.use) refuse("empty_command", "building.set_use needs a use");
      overrides.buildings[building.id] = { ...(overrides.buildings[building.id] ?? {}), use: params.use };
      if (params.resident_count !== undefined) {
        overrides.population[building.id] = { ...(overrides.population[building.id] ?? {}), count: params.resident_count };
      }
      return { overrides, effect: { building_id: building.id, use: params.use, resident_count: params.resident_count ?? null } };
    },
  },

  // --- M5: land use ----------------------------------------------------------------------------
  "parcel.set_use": {
    invalidates: ["routing", "traffic", "flood", "display"],
    transaction: true,
    run(overrides, { model, params, baseline }) {
      const parcel = find(model.objects.parcels, params.parcel_id) ?? refuse("parcel_not_found", `no parcel '${params.parcel_id}'`);
      const plan = LAND_USE_PLANS[params.new_use] ?? refuse("unsupported_land_use",
        `land use '${params.new_use}' has no plan in this version; known plans: ${Object.keys(LAND_USE_PLANS).join(", ")}`);
      for (const field of plan.requires) {
        if (params[field] === undefined) refuse("plan_input_missing", `the '${params.new_use}' plan needs ${field}`);
      }
      const demolish = params.demolish ?? [];
      const replace = params.replace ?? [];
      // An OMITTED retain list keeps every gate the parcel has; an EMPTY one asks to keep none,
      // which is not a plan. The two must not collapse into each other.
      const retainGiven = Array.isArray(params.retain_portals);
      if (retainGiven && !params.retain_portals.length) {
        refuse("plan_has_no_access", `the plan retains no portal for parcel '${params.parcel_id}', so nothing could reach it; omit retain_portals to keep them all`);
      }
      const retain = new Set(params.retain_portals ?? []);
      const parcelBuildings = model.objects.buildings.filter((building) => building.parcel_id === parcel.id).map((building) => building.id);
      for (const id of [...demolish, ...replace]) {
        if (!parcelBuildings.includes(id)) refuse("building_not_on_parcel", `building '${id}' is not on parcel '${parcel.id}'`, { parcel_id: parcel.id, buildings: parcelBuildings });
      }
      const parcelPortals = model.objects.portals.filter((portal) => portal.parcel_id === parcel.id);
      for (const id of retain) {
        if (!parcelPortals.some((portal) => portal.id === id)) refuse("portal_not_on_parcel", `portal '${id}' is not on parcel '${parcel.id}'`);
      }
      // A plan that keeps no way in is not a plan. Checked before anything is written, so a refused
      // plan leaves the previous one exactly as it was.
      const keptPortals = retain.size ? [...retain] : parcelPortals.map((portal) => portal.id);
      if (!keptPortals.length) refuse("plan_has_no_access", `parcel '${parcel.id}' would keep no portal, so nothing could reach it`);

      const impervious = params.impervious_fraction ?? plan.default_impervious_fraction;
      overrides.parcels[parcel.id] = { ...(overrides.parcels[parcel.id] ?? {}), land_use: params.new_use, impervious_fraction: impervious,
        plan: { new_use: params.new_use, gross_floor_area_m2: params.gross_floor_area_m2 ?? null,
          residential_fraction: params.residential_fraction ?? null, commercial_fraction: params.commercial_fraction ?? null,
          jobs: params.jobs ?? null, visitor_peak_person: params.visitor_peak_person ?? null,
          activity_hours: params.activity_hours ?? null, demolish, replace, retain_portals: [...retain] } };
      for (const id of demolish) overrides.buildings[id] = { ...(overrides.buildings[id] ?? {}), removed: true };
      for (const id of replace) {
        const building = find(model.objects.buildings, id);
        const area = params.gross_floor_area_m2 ?? null;
        const floors = area && building?.area_m2 ? Math.max(1, Math.round(area / building.area_m2)) : null;
        overrides.buildings[id] = { ...(overrides.buildings[id] ?? {}), use: params.new_use,
          ...(floors ? { floors, height_m: floors * (params.floor_height_m ?? 3) } : {}) };
      }
      for (const portal of parcelPortals) {
        if (retain.size && !retain.has(portal.id)) overrides.portals[portal.id] = { ...(overrides.portals[portal.id] ?? {}), open: false, closed_reason: `not retained by ${params.new_use} plan` };
        else if (retain.has(portal.id)) overrides.portals[portal.id] = { ...(overrides.portals[portal.id] ?? {}), open: true, closed_reason: null };
      }
      // Demand and population move with the plan, in the same transaction as the geometry.
      const baselinePopulation = baseline.population.filter((row) => parcelBuildings.includes(row.building_id));
      for (const row of baselinePopulation) {
        if (demolish.includes(row.building_id)) { overrides.population[row.building_id] = { count: 0 }; continue; }
        if (params.resident_count !== undefined && replace.includes(row.building_id)) overrides.population[row.building_id] = { count: params.resident_count };
      }
      if (params.resident_count !== undefined && !replace.length && !demolish.length) {
        for (const id of parcelBuildings) overrides.population[id] = { count: params.resident_count };
      }
      const removedDemand = baseline.demand.filter((row) =>
        parcelPortals.some((portal) => !keptPortals.includes(portal.id) && row.origin_node === portal.node_id)).map((row) => row.id);
      overrides.demand.removed = [...new Set([...(overrides.demand.removed ?? []), ...removedDemand])];

      return { overrides, effect: { parcel_id: parcel.id, new_use: params.new_use, demolished: demolish, replaced: replace,
        retained_portals: keptPortals, closed_portals: parcelPortals.map((portal) => portal.id).filter((id) => !keptPortals.includes(id)),
        impervious_fraction: impervious, resident_count: params.resident_count ?? null, jobs: params.jobs ?? null,
        visitor_peak_person: params.visitor_peak_person ?? null,
        hydrology_note: "surface cover is recorded; the static water-level model computes no runoff, so a permeability change does not move the flood extent" } };
    },
  },

  // --- demand ------------------------------------------------------------------------------
  "demand.add": {
    invalidates: ["traffic"],
    run(overrides, { model, params }) {
      const row = params.row ?? refuse("empty_command", "demand.add needs a row");
      for (const field of ["id", "origin_node", "destination_node", "count"]) {
        if (row[field] === undefined) refuse("demand_field_missing", `demand row needs ${field}`);
      }
      for (const node of [row.origin_node, row.destination_node]) {
        if (!model.network.nodes.some((item) => item.id === node)) refuse("node_not_found", `demand row references unknown node '${node}'`);
      }
      if (model.demand.some((item) => item.id === row.id) || (overrides.demand.added ?? []).some((item) => item.id === row.id)) {
        refuse("demand_id_taken", `demand row '${row.id}' already exists`);
      }
      overrides.demand.added = [...(overrides.demand.added ?? []), {
        id: row.id, origin_node: row.origin_node, destination_node: row.destination_node,
        departure_start_s: row.departure_start_s ?? 0, departure_end_s: row.departure_end_s ?? row.departure_start_s ?? 0,
        count: row.count, unit: row.unit ?? "person", mode: row.mode ?? "walk", synthetic: false,
      }];
      return { overrides, effect: { demand_id: row.id, count: row.count, unit: row.unit ?? "person" } };
    },
  },
  "demand.remove": {
    invalidates: ["traffic"],
    run(overrides, { model, params }) {
      const id = params.demand_id ?? refuse("empty_command", "demand.remove needs demand_id");
      const known = model.demand.some((row) => row.id === id) || (overrides.demand.added ?? []).some((row) => row.id === id);
      if (!known) refuse("demand_not_found", `no demand row '${id}'`);
      overrides.demand.added = (overrides.demand.added ?? []).filter((row) => row.id !== id);
      overrides.demand.removed = [...new Set([...(overrides.demand.removed ?? []), id])];
      return { overrides, effect: { demand_id: id, removed: true } };
    },
  },
};

function pointToSegment(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return distance(point, [a[0] + t * dx, a[1] + t * dy]);
}

/** Apply a command to an override document. Pure: the store calls it, and so does log replay. */
export function applyCommand(overrides, { kind, params, baseline }) {
  const command = COMMANDS[kind];
  if (!command) refuse("unknown_command", `unknown city command '${kind}'; known: ${Object.keys(COMMANDS).sort().join(", ")}`);
  const { model } = materialize(baseline, overrides);
  const result = command.run(overrides, { model, params: params ?? {}, baseline });
  return { overrides: result.overrides, effect: { kind, invalidates: command.invalidates, control: command.control === true, ...result.effect } };
}

export function commandCatalog() {
  return Object.entries(COMMANDS).map(([kind, command]) => ({
    kind, invalidates: command.invalidates, control: command.control === true, transaction: command.transaction === true,
  })).sort((a, b) => a.kind.localeCompare(b.kind));
}
