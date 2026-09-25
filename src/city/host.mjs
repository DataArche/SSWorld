// The city run host: one place that turns a revision into a usable city, applies commands to it and
// runs simulations on it. The MCP tools and the preview page are both thin callers of this file.
//
// Derivation order is fixed and one-way:
//     baseline + overrides -> model -> flood -> impact -> network -> run
// so "the water went up" reaches routing, and "a gate moved" cannot silently change the flood.
// Derived state is cached per (project, revision): a command makes a NEW revision, which is how the
// cache is invalidated -- there is no "clear the cache" call to forget.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { importDataset } from "./dataset.mjs";
import { CityStore } from "./store.mjs";
import { materialize, effectiveDemand, effectivePopulation } from "./revision.mjs";
import { applyCommand, commandCatalog, COMMANDS } from "./commands.mjs";
import { computeFlood, floodImpact, DEFAULT_PASSABLE_DEPTH_M } from "./flood.mjs";
import { ImpactState, hazardImpact, CAUSES } from "./impact.mjs";
import { CityNetwork, blockingFrom } from "./network.mjs";
import { runTraffic } from "./traffic.mjs";
import { runEvacuation, buildingExitNodes } from "./evacuation.mjs";
import { buildCandidate, generatorCatalog } from "./recipes.mjs";
import { buildScene, CITY_HOST_INTERFACES, sceneOrigin } from "./scene.mjs";
import { cityLogicSource } from "./page.mjs";

export const CITY_HOST_SCHEMA = "SSWorldCityHost/1";

const derived = new Map();       // `${directory}\0${revision}` -> derivation
const baselines = new Map();     // directory -> baseline model

const digestOf = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;

export function cityStore(directory) { return new CityStore(directory); }

export function hasCity(directory) { return new CityStore(directory).exists; }

function baselineModel(store) {
  if (!baselines.has(store.root)) baselines.set(store.root, store.baseline().model);
  return baselines.get(store.root);
}

/** Everything a revision implies, computed once and cached under that revision's id. */
export function derive(directory, revisionName = null) {
  const store = new CityStore(directory);
  const head = store.head();
  const name = revisionName || head.revision;
  const key = `${store.root}\u0000${name}`;
  if (derived.has(key)) return derived.get(key);

  const revision = store.revision(name);
  const baseline = baselineModel(store);
  const state = materialize(baseline, revision.overrides);
  const model = state.model;

  let flood = null, floodReport = null;
  try {
    flood = computeFlood(model, { waterLevelOverrides: state.water_level_overrides });
    floodReport = floodImpact(model, flood);
  } catch (error) {
    if (error.code !== "terrain_missing") throw error;
    floodReport = { edges: [], portals: [], buildings: [], limitations: ["no elevation grid: flood extent cannot be computed"] };
  }

  const impact = new ImpactState();
  impact.setCause(CAUSES.FLOOD, { edges: floodReport.edges.filter((entry) => entry.status === "closed"),
    portals: floodReport.portals.filter((entry) => entry.status === "closed"), buildings: floodReport.buildings });
  impact.setCause(CAUSES.LANDSLIDE, hazardImpact(model, state.active_hazards));
  impact.setCause(CAUSES.MANUAL, { edges: state.manual_edge_closures });

  const network = new CityNetwork(model);
  const demand = effectiveDemand(model, revision.overrides);
  const population = effectivePopulation(model, revision.overrides);

  const value = {
    directory, revision: name, revision_index: revision.index, overrides: revision.overrides,
    baseline_digest: revision.baseline_digest, model, flood, flood_report: floodReport, impact, network,
    demand, population, active_hazards: state.active_hazards, water_levels: state.water_level_overrides,
    assets: revision.overrides.assets ?? {}, changes: state.changes,
  };
  derived.set(key, value);
  return value;
}

/** Forget cached derivations for a project directory (used by tests and by a re-import). */
export function forget(directory) {
  const root = path.join(directory, "city");
  for (const key of [...derived.keys()]) if (key.startsWith(`${root}\u0000`)) derived.delete(key);
  baselines.delete(root);
}

// --- M1: import ---------------------------------------------------------------------------------

export function importCity(directory, datasetDirectory, { importedBy = "ssworld_city_import" } = {}) {
  const store = new CityStore(directory);
  const model = importDataset(datasetDirectory);
  const { baseline, revision } = store.initialise(model, { datasetDirectory, importedBy });
  forget(directory);
  const written = writeCityProject(directory, revision.revision);
  return {
    schema_version: CITY_HOST_SCHEMA,
    dataset: model.dataset, frame: model.frame,
    revision: revision.revision,
    baseline_digest: baseline.model_digest,
    counts: {
      ...Object.fromEntries(Object.entries(model.objects).map(([kind, items]) => [kind, items.length])),
      network_nodes: model.network.nodes.length, network_edges: model.network.edges.length,
      demand_rows: model.demand.length, population_rows: model.population.length,
      population_total: model.population.reduce((sum, row) => sum + row.count, 0),
    },
    data_gaps: model.data_gaps,
    scenarios: model.scenarios.map((scenario) => ({ id: scenario.id, description: scenario.description ?? null })),
    ...written,
  };
}

/** Write scene.ssdl + logic.mjs + host_interfaces.json for a revision. Returns what changed. */
export function writeCityProject(directory, revisionName = null, { travellers = 480 } = {}) {
  const state = derive(directory, revisionName);
  const scene = buildScene(state.model, {
    flood: state.flood, impact: state.impact, hazards: state.active_hazards,
    assets: state.assets, travellers, revision: state.revision,
  });
  const sceneFile = path.join(directory, "scene.ssdl");
  const previous = existsSync(sceneFile) ? readFileSync(sceneFile, "utf8") : null;
  writeFileSync(sceneFile, scene.source, "utf8");
  writeFileSync(path.join(directory, "host_interfaces.json"), `${JSON.stringify(CITY_HOST_INTERFACES, null, 2)}\n`, "utf8");
  writeFileSync(path.join(directory, "logic.mjs"), cityLogicSource(), "utf8");
  const manifest = {
    schema_version: CITY_HOST_SCHEMA, revision: state.revision, origin_m: scene.origin_m,
    node_ids: scene.node_ids, traveller_batch: scene.traveller_batch,
    water_levels: state.water_levels, active_hazards: state.active_hazards.map((hazard) => hazard.id),
  };
  mkdirSync(path.join(directory, "city"), { recursive: true });
  writeFileSync(path.join(directory, "city", "scene-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { scene_bytes: scene.source.length, scene_changed: previous !== scene.source,
    scene_digest: digestOf(scene.source), node_count: Object.keys(scene.node_ids).length, origin_m: scene.origin_m };
}

// --- M1: query ----------------------------------------------------------------------------------

const OBJECT_KINDS = ["site", "parcels", "buildings", "roads", "access_links", "portals", "water", "hazards", "shelters", "surface_cover", "hydraulic_structures", "surveys"];

export function queryCity(directory, { id = null, kind = null, bbox = null, revision = null, limit = 200 } = {}) {
  const state = derive(directory, revision);
  const model = state.model;
  if (id) return describeObject(state, id);
  const kinds = kind ? [pluralise(kind)] : OBJECT_KINDS;
  const items = [];
  for (const collection of kinds) {
    for (const object of model.objects[collection] ?? []) {
      if (bbox && !withinBbox(object, bbox)) continue;
      items.push({ id: object.id, kind: singular(collection), name: object.name ?? null,
        centroid: object.centroid ?? object.position ?? null,
        quality_status: object.provenance?.quality_status ?? null,
        blocked: state.impact.blocked(collection === "portals" ? "portals" : collection === "buildings" ? "buildings" : "edges", object.id) || object.open === false });
      if (items.length >= limit) break;
    }
  }
  return { schema_version: CITY_HOST_SCHEMA, revision: state.revision, count: items.length, items,
    kinds: OBJECT_KINDS.map(singular) };
}

function describeObject(state, id) {
  const model = state.model;
  for (const collection of OBJECT_KINDS) {
    const object = (model.objects[collection] ?? []).find((item) => item.id === id);
    if (!object) continue;
    const kind = singular(collection);
    const impactKind = collection === "portals" ? "portals" : collection === "buildings" ? "buildings" : "edges";
    const gaps = model.data_gaps.filter((item) => item.object_id === id);
    const relations = relationsOf(model, object, kind);
    return { schema_version: CITY_HOST_SCHEMA, revision: state.revision, kind, object: strip(object),
      data_gaps: gaps, relations, impact: state.impact.reasons(impactKind, id),
      id_map: model.id_map[id] ?? null };
  }
  const edge = model.network.edges.find((item) => item.id === id);
  if (edge) {
    return { schema_version: CITY_HOST_SCHEMA, revision: state.revision, kind: edge.kind, object: edge,
      data_gaps: [], relations: { from_node: edge.from_node, to_node: edge.to_node, portal_id: edge.portal_id },
      impact: state.impact.reasons("edges", id), id_map: model.id_map[id] ?? null };
  }
  const node = model.network.nodes.find((item) => item.id === id);
  if (node) {
    return { schema_version: CITY_HOST_SCHEMA, revision: state.revision, kind: "network_node", object: node,
      data_gaps: [], relations: { edges: model.network.edges.filter((item) => item.from_node === id || item.to_node === id).map((item) => item.id) },
      impact: state.impact.reasons("nodes", id), id_map: null };
  }
  throw Object.assign(new Error(`no city object '${id}' in ${state.revision}`), { code: "object_not_found" });
}

function relationsOf(model, object, kind) {
  if (kind === "building") {
    return { parcel_id: object.parcel_id,
      portals: model.objects.portals.filter((portal) => portal.building_id === object.id).map((portal) => portal.id),
      exit_node: buildingExitNodes(model).get(object.id) ?? null,
      population: model.population.filter((row) => row.building_id === object.id),
      recipe_id: object.recipe_id ?? null };
  }
  if (kind === "parcel") {
    return { buildings: model.objects.buildings.filter((item) => item.parcel_id === object.id).map((item) => item.id),
      portals: model.objects.portals.filter((portal) => portal.parcel_id === object.id).map((portal) => portal.id) };
  }
  if (kind === "portal") {
    return { parcel_id: object.parcel_id, building_id: object.building_id, node_id: object.node_id,
      edges: model.network.edges.filter((edge) => edge.portal_id === object.id).map((edge) => edge.id) };
  }
  if (kind === "shelter") return { node_id: object.node_id };
  return {};
}

const strip = (object) => JSON.parse(JSON.stringify(object));
const pluralise = (kind) => (OBJECT_KINDS.includes(kind) ? kind : OBJECT_KINDS.find((item) => singular(item) === kind) ?? kind);
const singular = (collection) => ({ site: "site", parcels: "parcel", buildings: "building", roads: "road",
  access_links: "access_link", portals: "portal", water: "water", hazards: "hazard", shelters: "shelter",
  surface_cover: "surface_cover", hydraulic_structures: "hydraulic_structure", surveys: "survey" })[collection] ?? collection;

function withinBbox(object, bbox) {
  const box = object.bbox ?? (object.position ? [object.position[0], object.position[1], object.position[0], object.position[1]] : null);
  if (!box) return false;
  return box[0] <= bbox[2] && bbox[0] <= box[2] && box[1] <= bbox[3] && bbox[1] <= box[3];
}

// --- M2/M3/M4/M5/M6: commands ---------------------------------------------------------------------

export function commandCity(directory, { command_id = null, kind, params = {}, expected_revision = null, effective_at_s = null, source = null, regenerate = true }) {
  const store = new CityStore(directory);
  const baseline = baselineModel(store);
  const record = store.applyCommand({ command_id, kind, params, expected_revision, effective_at_s, source },
    (overrides) => applyCommand(overrides, { kind, params, baseline }));
  if (record.replayed) {
    return { schema_version: CITY_HOST_SCHEMA, replayed: true, ...record,
      note: "this command_id was already applied; the original result is returned and nothing was applied twice" };
  }
  forget(directory);
  const written = regenerate ? writeCityProject(directory, record.applied_revision) : null;
  const state = derive(directory, record.applied_revision);
  return {
    schema_version: CITY_HOST_SCHEMA, replayed: false, seq: record.seq, command_id: record.command_id,
    kind, params, source_revision: record.source_revision, revision: record.applied_revision,
    effect: record.effect, invalidates: record.effect?.invalidates ?? [],
    display: written,
    impact_summary: impactSummary(state),
  };
}

function impactSummary(state) {
  return {
    closed_edges: state.impact.blockedEdgeIds().length,
    closed_portals: state.impact.blockedPortalIds().length,
    flooded_area_m2: state.flood?.area_m2 ?? null,
    water_levels: Object.fromEntries((state.flood?.bodies ?? []).map((body) => [body.id, body.level_m])),
    active_hazards: state.active_hazards.map((hazard) => hazard.id),
  };
}

// --- M3: impact report -----------------------------------------------------------------------------

export function impactReport(directory, { revision = null, reference_nodes = null, mode = "walk", passable_depth_m = DEFAULT_PASSABLE_DEPTH_M } = {}) {
  const state = derive(directory, revision);
  const flood = state.flood;
  const report = flood ? floodImpact(state.model, flood, { passableDepth: passable_depth_m }) : state.flood_report;
  const blocked = blockingFrom(state.impact);

  // Directly hit vs cut off: an object nobody can reach is a different answer from a flooded one,
  // and the two get confused unless reachability is computed after the closures are applied.
  const references = reference_nodes ?? state.model.objects.shelters.map((shelter) => shelter.node_id).filter(Boolean);
  const reachable = references.length ? state.network.reachableFrom(references, mode, { blocked }) : new Set();
  const exits = buildingExitNodes(state.model);
  const isolated = [];
  if (references.length) {
    for (const building of state.model.objects.buildings) {
      const exit = exits.get(building.id);
      if (!exit || reachable.has(exit)) continue;
      const flooded = report.buildings.some((entry) => entry.building_id === building.id);
      isolated.push({ building_id: building.id, exit_node: exit,
        status: flooded ? "inundated_and_cut_off" : "cut_off_not_inundated" });
    }
  }

  return {
    schema_version: CITY_HOST_SCHEMA, revision: state.revision,
    flood: flood ? flood.summary() : { status: "unavailable", reason: "no elevation grid" },
    flood_impact: report,
    hazards: state.active_hazards.map((hazard) => ({ hazard_id: hazard.id, hazard_type: hazard.hazard_type,
      input_type: hazard.input_type, effective_at_s: hazard.effective_at_s ?? null })),
    impact: state.impact.toJSON(),
    reachability: { reference_nodes: references, mode, reachable_nodes: reachable.size, isolated },
    limitations: [...(flood?.limitations ?? []), "static conditions only: no propagation time, velocity or drainage"],
  };
}

// --- M2/M6: runs ------------------------------------------------------------------------------------

export function startRun(directory, {
  kind = "traffic", revision = null, run_id = null, horizon_s = 7200, step_s = 1,
  sample_interval_s = 60, display_rows = 0, controls = [], demand = null, departure_window_s = 0, mode = "walk",
} = {}) {
  const state = derive(directory, revision);
  const store = new CityStore(directory);
  const id = run_id || `run-${state.revision}-${kind}-${String(store.runs().length + 1).padStart(3, "0")}`;
  const resolvedControls = controls.map((control) => resolveControl(state, control));

  const started = Date.now();
  let result;
  if (kind === "traffic") {
    result = runTraffic(state.model, state.network, {
      demand: demand ?? state.demand, horizon_s, step_s, impact: state.impact,
      controls: resolvedControls, collectSamples: sample_interval_s, capturePositions: display_rows,
    });
  } else if (kind === "evacuation") {
    result = runEvacuation(state.model, state.network, {
      population: state.population, impact: state.impact, horizon_s, step_s,
      departure_window_s, mode, collectSamples: sample_interval_s, capturePositions: display_rows,
    });
  } else {
    throw Object.assign(new Error(`unknown run kind '${kind}'; use 'traffic' or 'evacuation'`), { code: "run_kind_unknown" });
  }
  const { travellers, ...stored } = result;

  const run = {
    schema_version: CITY_HOST_SCHEMA, run_id: id, kind, revision: state.revision,
    created_at: new Date().toISOString(), elapsed_ms: Date.now() - started,
    inputs: { horizon_s, step_s, sample_interval_s, display_rows, departure_window_s, mode,
      demand_digest: digestOf(demand ?? state.demand), controls: resolvedControls.map((control) => ({ at_s: control.at_s, kind: control.kind, command_id: control.command_id ?? null })) },
    log_cursor: store.head().seq,
    scene_origin_m: sceneOrigin(state.model),
    result: stored,
  };
  store.writeRun(run);
  return run;
}

/** A mid-run control: either explicit blocking, or a city command replayed as a control. */
function resolveControl(state, control) {
  if (control.command) {
    const command = COMMANDS[control.command.kind];
    if (!command) throw Object.assign(new Error(`unknown control command '${control.command.kind}'`), { code: "unknown_command" });
    if (!command.control) {
      throw Object.assign(new Error(`'${control.command.kind}' changes geometry or topology, so it cannot be applied inside a run; apply it as a command and start a new run from the same demand`),
        { code: "control_not_applicable", extra: { kind: control.command.kind, invalidates: command.invalidates } });
    }
    const { kind, params } = control.command;
    const portalState = {};
    const blockedEdges = [...state.impact.blockedEdgeIds()];
    const blockedPortals = [...state.impact.blockedPortalIds()];
    if (kind === "portal.close") portalState[params.portal_id] = { open: false };
    if (kind === "portal.open") portalState[params.portal_id] = { open: true };
    if (kind === "road.close") blockedEdges.push(params.edge_id);
    if (kind === "road.open") {
      const index = blockedEdges.indexOf(params.edge_id);
      if (index >= 0) blockedEdges.splice(index, 1);
    }
    return { at_s: control.at_s ?? 0, kind, command_id: control.command_id ?? null, portal_state: portalState,
      blocked_edges: blockedEdges, blocked_portals: blockedPortals };
  }
  return { at_s: control.at_s ?? 0, kind: control.kind ?? "control", command_id: control.command_id ?? null,
    blocked_edges: control.blocked_edges ?? [...state.impact.blockedEdgeIds()],
    blocked_portals: control.blocked_portals ?? [...state.impact.blockedPortalIds()],
    portal_state: control.portal_state ?? {} };
}

export function readRun(directory, runId) { return new CityStore(directory).readRun(runId); }
export function listRuns(directory) { return new CityStore(directory).runs(); }

// --- M4: building candidates --------------------------------------------------------------------------

export function buildBuilding(directory, { building_id, generator_id, parameters, seed, constraints, revision = null, recipe_id = null }) {
  const state = derive(directory, revision);
  const store = new CityStore(directory);
  const baseline = store.baseline();
  const built = buildCandidate(state.model, { building_id, generator_id, parameters, seed, constraints, recipe_id,
    source_digests: { dataset: baseline.model_digest, revision: state.revision },
    tool_versions: { ssworld_city: CITY_HOST_SCHEMA } });
  return { schema_version: CITY_HOST_SCHEMA, revision: state.revision, ...built, generators: generatorCatalog() };
}

// --- status ---------------------------------------------------------------------------------------------

export function cityStatus(directory) {
  const store = new CityStore(directory);
  if (!store.exists) return { schema_version: CITY_HOST_SCHEMA, imported: false };
  const head = store.head();
  const state = derive(directory, head.revision);
  return {
    schema_version: CITY_HOST_SCHEMA, imported: true, revision: head.revision, revision_index: head.index,
    log_cursor: head.seq, revisions: store.revisions(), runs: store.runs(),
    dataset: state.model.dataset, frame: state.model.frame,
    scene_origin_m: sceneOrigin(state.model),
    impact: impactSummary(state),
    demand_rows: state.demand.length,
    population_total: state.population.reduce((sum, row) => sum + row.count, 0),
    data_gaps: state.model.data_gaps.length,
    commands: commandCatalog(),
    generators: generatorCatalog(),
  };
}

export { commandCatalog, generatorCatalog };

// --- playback for the page -------------------------------------------------------------------------

/** The run a page should be showing: the newest one, unless a specific id was asked for. */
export function activeRun(directory, runId = null) {
  const store = new CityStore(directory);
  const runs = store.runs();
  if (runId) return store.readRun(runId);
  if (!runs.length) return null;
  return store.readRun(runs[runs.length - 1].run_id);
}

/**
 * One playback frame. The cursor is a SAMPLE INDEX, not a wall clock: the page advances it at
 * whatever rate it can, and a slow page sees fewer frames of the same run rather than a different
 * run. Positions are offset into the scene's local frame here, so the page does no geometry.
 */
export function runFrame(directory, { run_id = null, cursor = 0 } = {}) {
  const run = activeRun(directory, run_id);
  if (!run) return { run_id: null, reason: "no run has been started for this city" };
  const samples = run.result?.samples ?? [];
  if (!samples.length) {
    return { run_id: run.run_id, kind: run.kind, revision: run.revision, t_s: run.result?.sim_time_s ?? 0,
      counts: run.result?.counts ?? null, positions: [], batch: null, next_cursor: 0, closed: true,
      note: "this run captured no display samples; start it with sample_interval_s to play it back" };
  }
  const index = Math.max(0, Math.min(samples.length - 1, Math.trunc(cursor)));
  const sample = samples[index];
  const origin = run.scene_origin_m ?? [0, 0];
  const manifest = readSceneManifest(directory);
  return {
    run_id: run.run_id, kind: run.kind, revision: run.revision,
    t_s: sample.t_s, counts: sample.counts,
    // Half the traveller capsule's height, so the marker stands ON the road rather than half in it.
    positions: (sample.positions ?? []).map(([x, y, z]) => [round(x - origin[0]), round(y - origin[1]), round(z + 6)]),
    queues: sample.queues ?? [], occupancy: sample.occupancy ?? [],
    batch: manifest?.traveller_batch ?? null,
    next_cursor: index + 1 >= samples.length ? index : index + 1,
    closed: index + 1 >= samples.length,
    sample_index: index, sample_count: samples.length,
  };
}

function readSceneManifest(directory) {
  const file = path.join(directory, "city", "scene-manifest.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

const round = (value) => Math.round(value * 1000) / 1000;
