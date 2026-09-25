// The city demo: the plan's first delivery chain, driven end to end from one command.
//
// It adds no city surface of its own. Every step below is the SAME call the MCP tool and the preview
// page make (importCity / commandCity / impactReport / startRun / buildBuilding), in the order the
// plan promises them:
//
//     a real site opens -> its demand is routed -> one door closes and the route lengthens ->
//     one building's model is rebuilt without moving a traveller -> the river rises 1 m ->
//     an imported landslide is activated and the site evacuates
//
// Each step returns the numbers that have to move, so the same code can be watched in a browser and
// checked headlessly (mcp/test/city-demo.test.mjs). Nothing here is hard-coded to the synthetic
// dataset: the door, the water body and the hazard are RESOLVED from the imported city, and a
// dataset that cannot supply one says so instead of the demo quietly skipping a step.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT, SSDL_ROOT } from "../paths.mjs";
import { createProject, projectDir, compileNamed } from "../project.mjs";
import { importCity, commandCity, impactReport, startRun, buildBuilding, cityStatus, hasCity, derive } from "./host.mjs";
import { blockingFrom } from "./network.mjs";

export const DEMO_PROJECT = "riverside";

// A horizon long enough for the fixture's 08:00 departures to clear, sampled so the page has frames
// to play back. display_rows caps the moving layer; the batch is written with the rows there are.
const TRAFFIC = { kind: "traffic", horizon_s: 6000, sample_interval_s: 60, display_rows: 400 };
const EVACUATION = { kind: "evacuation", horizon_s: 7200, sample_interval_s: 60, display_rows: 400 };
const RIVER_RISE_M = 1;

const refuse = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, extra }); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => (typeof value === "number" ? Math.round(value * 100) / 100 : value);

/** The dataset that ships with this copy: repository tree (src/ssdl/fixtures) or packed package. */
export function demoDataset() {
  const candidates = [path.join(PACKAGE_ROOT, "fixtures", "city", "synthetic-riverside"),
    path.join(SSDL_ROOT, "fixtures", "city", "synthetic-riverside")];
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "dataset.json")));
  if (!found) refuse("demo_dataset_missing", `no demo dataset; looked in ${candidates.join(", ")}`);
  return found;
}

/**
 * Get the demo project to its baseline: created, imported, compiled. Idempotent -- an existing
 * project is reused (and reported as reused) rather than overwritten, because a city baseline is
 * immutable and re-importing over one is exactly what the store refuses.
 */
export async function prepareDemo({ project = DEMO_PROJECT, dataset = null, reset = false, log = () => {} } = {}) {
  const datasetDirectory = dataset ? path.resolve(String(dataset)) : demoDataset();
  if (!existsSync(path.join(datasetDirectory, "dataset.json"))) {
    refuse("dataset_not_found", `no dataset.json under ${datasetDirectory}`);
  }
  const directory = projectDir(project, { mustExist: false });
  if (reset && existsSync(directory)) {
    rmSync(directory, { recursive: true, force: true });
    log(`reset: removed ${directory}`);
  }
  const created = !existsSync(directory);
  if (created) await createProject(project, { template: "empty" });
  let imported = null;
  if (!hasCity(directory)) {
    imported = importCity(directory, datasetDirectory);
    log(`imported ${imported.dataset.id}: ${imported.revision}, ${imported.node_count} scene nodes, ${imported.data_gaps.length} data gaps`);
  } else {
    log(`reusing the city already in ${project}`);
  }
  const compiled = await compileNamed(project);
  if (!compiled.ok) refuse("compile_failed", `the city scene did not compile: ${compiled.diagnostic?.message ?? "unknown"}`, { diagnostic: compiled.diagnostic });
  const status = cityStatus(directory);
  return {
    project, directory, dataset: datasetDirectory, created, imported,
    compile: { ok: true, native_objects: compiled.usage?.native_objects?.used ?? null, node_count: compiled.node_count ?? null },
    revision: status.revision, revision_index: status.revision_index,
    population_total: status.population_total, data_gaps: status.data_gaps,
  };
}

/** The door this city's demand actually walks through, resolved from the current shortest routes. */
function chooseGate(directory) {
  const state = derive(directory);
  const blocked = blockingFrom(state.impact);
  for (const row of state.demand) {
    let route = null;
    try { route = state.network.route(row.origin_node, row.destination_node, row.mode ?? "walk", { blocked }); }
    catch { continue; }                       // a demand row naming a node this network does not have
    if (!route) continue;
    const gateEdge = route.edge_ids
      .map((id) => state.model.network.edges.find((edge) => edge.id === id))
      .find((edge) => edge?.portal_id);
    if (!gateEdge) continue;
    return { demand_id: row.id, origin_node: row.origin_node, destination_node: row.destination_node,
      mode: row.mode ?? "walk", portal_id: gateEdge.portal_id, route };
  }
  refuse("no_gate_on_any_route", "no demand row in this city walks through a portal, so there is no door to close");
}

function countsOf(state) {
  return Object.fromEntries(Object.entries(state.model.objects)
    .map(([kind, items]) => [kind, Array.isArray(items) ? items.length : 1]));
}

/**
 * Play the chain on a city that is at its baseline. Returns one record per step: what was called,
 * what moved, and the one line a watcher should check on screen.
 *
 * `pause` is wall-clock breathing room for a human watching the page hot reload; tests pass 0.
 */
export async function playDemo({ directory, log = () => {}, pause = 0 } = {}) {
  const steps = [];
  const record = async (id, title, watch, body) => {
    log("");
    log(`[${steps.length + 1}] ${title}`);
    const { data, lines = [] } = await body();
    for (const line of lines) log(`    ${line}`);
    log(`    on screen: ${watch}`);
    const entry = { id, title, watch, ...data };
    steps.push(entry);
    if (pause) await wait(pause);
    return entry;
  };

  // --- 1. M1: the site is here, and it says what it does not know ----------------------------
  await record("site", "the real site opens", "terrain, roads, parcels and building masses; tap one for its business id", () => {
    const state = derive(directory);
    const counts = countsOf(state);
    const gaps = state.model.data_gaps;
    const blocking = [...new Set(gaps.flatMap((gap) => gap.blocks ?? []))];
    return {
      data: { revision: state.revision, counts, data_gaps: gaps.length, blocked_conclusions: blocking },
      lines: [
        `revision ${state.revision}: ${counts.buildings} buildings, ${counts.parcels} parcels, ${counts.roads} roads, ${counts.portals} portals`,
        `${state.model.network.nodes.length} network nodes / ${state.model.network.edges.length} edges, ${state.demand.length} demand rows, population ${state.population.reduce((sum, row) => sum + row.count, 0)}`,
        `${gaps.length} data gaps; they block: ${blocking.join(", ") || "nothing"}`,
      ],
    };
  });

  // --- 2. M2: route the demand that is actually in the dataset --------------------------------
  const gate = chooseGate(directory);
  const baseline = await record("traffic_baseline", "the demand is routed through the doors", "markers walking the roads; the run line counts arrived / en route", () => {
    const run = startRun(directory, TRAFFIC);
    return {
      data: { run_id: run.run_id, revision: run.revision, counts: run.result.counts, conserved: run.result.conserved,
        samples: run.result.samples?.length ?? 0, gate: { portal_id: gate.portal_id, demand_id: gate.demand_id },
        route: { distance_m: gate.route.distance_m, edges: gate.route.edge_ids.length } },
      lines: [
        `run ${run.run_id}: arrived ${run.result.counts.arrived}, stranded ${run.result.counts.stranded}, conserved ${run.result.conserved}`,
        `demand ${gate.demand_id} walks ${gate.route.distance_m} m through ${gate.portal_id} (${gate.route.edge_ids.length} edges)`,
      ],
    };
  });

  // --- 3. M2: close that door; the route lengthens and the run changes -------------------------
  await record("gate_closed", `one door closes (${gate.portal_id})`, "the closed gate turns red and the markers take the long way round", () => {
    const applied = commandCity(directory, { command_id: "demo-gate-close", kind: "portal.close",
      params: { portal_id: gate.portal_id, reason: "demo: the gate is shut" } });
    const state = derive(directory);
    const after = state.network.route(gate.origin_node, gate.destination_node, gate.mode, { blocked: blockingFrom(state.impact) });
    const run = startRun(directory, TRAFFIC);
    return {
      data: { revision: applied.revision, invalidates: applied.invalidates, portal_id: gate.portal_id,
        scene_changed: applied.display?.scene_changed ?? null,
        route_before_m: gate.route.distance_m, route_after_m: after ? after.distance_m : null,
        detour_m: after ? round(after.distance_m - gate.route.distance_m) : null,
        edges_before: gate.route.edge_ids.length, edges_after: after ? after.edge_ids.length : null,
        run_id: run.run_id, counts: run.result.counts, conserved: run.result.conserved },
      lines: [
        `${applied.revision}: ${gate.portal_id} closed, invalidates ${applied.invalidates.join(" + ")}`,
        after ? `the same trip now walks ${after.distance_m} m instead of ${gate.route.distance_m} m (+${round(after.distance_m - gate.route.distance_m)} m, ${after.edge_ids.length} edges)`
              : `the same trip has no route at all any more`,
        `run ${run.run_id}: arrived ${run.result.counts.arrived}, stranded ${run.result.counts.stranded} (was ${baseline.counts.arrived} / ${baseline.counts.stranded})`,
      ],
    };
  });

  // --- 4. M4: rebuild one building's model; the traffic must not move ---------------------------
  const rebuildTarget = derive(directory).model.objects.buildings[0];
  if (!rebuildTarget) refuse("no_building", "this city has no buildings, so there is nothing to rebuild");
  await record("rebuild_building", `one building is rebuilt from a rule (${rebuildTarget.id})`, "that mass gains a pitched roof; nothing else changes", () => {
    const built = buildBuilding(directory, { building_id: rebuildTarget.id, generator_id: "footprint_extrusion_roof",
      parameters: { roof_style: "hip", roof_pitch_deg: 25 } });
    if (!built.checks.passed) {
      refuse("candidate_rejected", `the rule-built candidate for ${rebuildTarget.id} failed its hard checks`,
        { failed: built.checks.checks.filter((check) => !check.passed).map((check) => check.check) });
    }
    const before = startRun(directory, TRAFFIC);
    const applied = commandCity(directory, { command_id: "demo-rebuild", kind: "building.replace_asset",
      params: { building_id: rebuildTarget.id, recipe_id: built.recipe.recipe_id,
        asset: { kind: "parametric", nodes: built.candidate.nodes, recipe_digest: built.recipe.recipe_digest } } });
    const after = startRun(directory, TRAFFIC);
    const moved = JSON.stringify(after.result.counts) !== JSON.stringify(before.result.counts);
    return {
      data: { building_id: rebuildTarget.id, revision: applied.revision, invalidates: applied.invalidates,
        recipe_id: built.recipe.recipe_id, recipe_digest: built.recipe.recipe_digest,
        checks: built.checks.checks.map((check) => check.check), scene_changed: applied.display?.scene_changed ?? null,
        counts_before: before.result.counts, counts_after: after.result.counts, travellers_moved: moved },
      lines: [
        `${applied.revision}: ${built.recipe.generator_id} v${built.recipe.generator_version}, recipe ${built.recipe.recipe_id}`,
        `hard checks passed: ${built.checks.checks.map((check) => check.check).join(", ")}`,
        `invalidates ${applied.invalidates.join(" + ")} only -- travellers moved: ${moved ? "YES (that would be a bug)" : "no"}`,
      ],
    };
  });

  // --- 5. M3: the river rises one metre ----------------------------------------------------------
  const water = derive(directory).model.objects.water.find((body) => typeof body.baseline_level_m === "number");
  if (!water) refuse("no_water_datum", "no water body in this city has a baseline surface, so a level change has no datum to sit on");
  await record("river_rise", `the river rises ${RIVER_RISE_M} m (${water.id})`, "the water plane climbs and the flooded streets go dark", () => {
    const before = impactReport(directory);
    const applied = commandCity(directory, { command_id: "demo-water-rise", kind: "water.set_level",
      params: { water_id: water.id, level_m: water.baseline_level_m + RIVER_RISE_M } });
    const after = impactReport(directory);
    const isolated = after.reachability.isolated;
    const dry = isolated.filter((entry) => entry.status === "cut_off_not_inundated");
    return {
      data: { revision: applied.revision, water_id: water.id, scene_changed: applied.display?.scene_changed ?? null,
        level_before_m: water.baseline_level_m, level_after_m: water.baseline_level_m + RIVER_RISE_M,
        area_before_m2: before.flood.area_m2, area_after_m2: after.flood.area_m2,
        closed_edges: after.flood_impact.edges.filter((entry) => entry.status === "closed").length,
        closed_portals: after.flood_impact.portals.filter((entry) => entry.status === "closed").length,
        flooded_buildings: after.flood_impact.buildings.length,
        isolated: isolated.length, cut_off_not_inundated: dry.length,
        limitations: after.limitations },
      lines: [
        `${applied.revision}: ${water.baseline_level_m} m -> ${water.baseline_level_m + RIVER_RISE_M} m`,
        `inundation ${before.flood.area_m2} m2 -> ${after.flood.area_m2} m2, ${after.flood_impact.edges.filter((entry) => entry.status === "closed").length} edges closed, ${after.flood_impact.buildings.length} buildings over-topped`,
        `${isolated.length} buildings cut off, of which ${dry.length} are dry but unreachable`,
        `limits: ${after.limitations.join("; ")}`,
      ],
    };
  });

  // --- 6. M6: the landslide, then evacuate ---------------------------------------------------------
  const hazard = derive(directory).model.objects.hazards[0];
  if (!hazard) refuse("no_hazard", "this city carries no hazard extent, so there is nothing to evacuate from");
  await record("evacuation", `the landslide extent is activated (${hazard.id}) and the site evacuates`, "the hazard patch appears; the markers head for the shelters", () => {
    const applied = commandCity(directory, { command_id: "demo-hazard", kind: "hazard.activate", params: { hazard_id: hazard.id } });
    // The river from the previous step is STILL UP, so the closures the evacuation runs against come
    // from two causes at once. They are counted apart here: rounding them into one number is exactly
    // how "the landslide cut the city off" gets claimed for streets the flood closed.
    const state = derive(directory);
    const closuresByCause = {};
    for (const [, reasons] of state.impact.edges) {
      for (const reason of reasons.values()) closuresByCause[reason.cause] = (closuresByCause[reason.cause] ?? 0) + 1;
    }
    const exposedBuildings = [...state.impact.buildings]
      .filter(([, reasons]) => reasons.has("landslide")).map(([id]) => id);
    const run = startRun(directory, EVACUATION);
    const result = run.result;
    // Everyone who did not reach a shelter, and why: stranded EN ROUTE and never assigned a shelter
    // in the first place are different answers, and the demo must not round either into "incomplete".
    const notFinished = [
      ...(result.stranded ?? []).map((group) => ({ count: group.count, reason: group.code ?? "unknown", where: group.origin ?? null })),
      ...(result.unassigned ?? []).map((group) => ({ count: group.count, reason: group.reason ?? "unassigned", where: group.building_id ?? group.origin_node ?? null })),
    ];
    const reasons = notFinished.map((entry) => `${entry.count} x ${entry.reason}${entry.where ? ` (${entry.where})` : ""}`);
    return {
      data: { revision: applied.revision, hazard_id: hazard.id, run_id: run.run_id,
        scene_changed: applied.display?.scene_changed ?? null,
        population_total: result.population_total ?? result.total ?? null,
        counts: result.counts, incomplete: result.incomplete ?? null,
        completion_time_s: result.completion_time_s ?? null,
        population_closed: result.population_closed ?? null, conserved: result.traffic?.conserved ?? null,
        closures_by_cause: closuresByCause, exposed_buildings: exposedBuildings,
        not_finished: notFinished, stranded_reasons: reasons, shelters: result.shelters ?? null,
        limitations: result.limitations ?? [],
        limitation: applied.effect?.limitation ?? null },
      lines: [
        `${applied.revision}: ${hazard.id} active (${applied.effect?.input_type ?? "imported extent"}), ${exposedBuildings.length} buildings inside the extent`,
        `closed edges by cause: ${Object.entries(closuresByCause).map(([cause, count]) => `${cause} ${count}`).join(", ") || "none"} (the river from the previous step is still up)`,
        `run ${run.run_id}: arrived ${result.counts.arrived}, stranded ${result.counts.stranded}, unassigned ${result.counts.unassigned ?? 0}, incomplete ${result.incomplete ?? 0}`,
        `shelters: ${(result.shelters ?? []).map((shelter) => `${shelter.shelter_id} ${shelter.assigned}/${shelter.capacity_person}`).join(", ") || "none"}`,
        reasons.length ? `why they did not finish: ${reasons.join("; ")}` : "everyone reached a shelter",
        applied.effect?.limitation ? `limit: ${applied.effect.limitation}` : "",
      ].filter(Boolean),
    };
  });

  return { steps };
}

/**
 * The CLI demo: prepare the city, serve it, wait for a browser to join, then play the chain.
 *
 * The preview server is left RUNNING in this process; the caller keeps it alive (bin does that with
 * serveForever, which reuses this same in-process server). Playing is refused on a city that has
 * already moved past its baseline -- re-running the commands would return the original results and
 * nothing on screen would move, which reads exactly like a broken demo.
 */
export async function cityDemo({ project = DEMO_PROJECT, dataset = null, port = null, reset = false,
  play = true, replay = false, pause = 6000, waitForPageMs = 120000, serve = true, log = () => {} } = {}) {
  const prepared = await prepareDemo({ project, dataset, reset, log });
  log(`project ${prepared.project} at ${prepared.directory}`);
  log(`dataset ${prepared.dataset}`);
  log(`${prepared.compile.native_objects ?? "?"} native objects, population ${prepared.population_total}, ${prepared.data_gaps} data gaps, head ${prepared.revision}`);

  let url = null;
  if (serve) {
    const { startPreview, projectUrl, fetchPageStatus } = await import("../preview.mjs");
    const started = await startPreview({ port: port ?? undefined, log });
    url = projectUrl(prepared.project, started.port);
    log("");
    log(`open this in a WebGPU browser (Chrome/Edge) and leave it visible:`);
    log(`    ${url}`);
    if (play && (prepared.revision_index === 0 || replay)) {
      const deadline = Date.now() + waitForPageMs;
      let joined = false;
      while (Date.now() < deadline) {
        const page = await fetchPageStatus(prepared.project, { port: started.port });
        if (page.connected) { joined = true; break; }
        await wait(1000);
      }
      log(joined ? "a page joined; playing the chain" : "no page joined in time; playing the chain anyway (nothing to watch)");
    }
  }

  if (!play) return { ...prepared, url, steps: [] };
  if (prepared.revision_index > 0 && !replay) {
    log("");
    log(`this city is already at ${prepared.revision} (index ${prepared.revision_index}), past its baseline:`);
    log("re-running the demo commands would replay the originals and nothing would move on screen.");
    log("start over with --reset, or pass --replay to run the steps against the city as it stands.");
    return { ...prepared, url, steps: [], played: false, reason: "city_past_baseline" };
  }
  const { steps } = await playDemo({ directory: prepared.directory, log, pause });
  log("");
  log(`played ${steps.length} steps; the preview keeps serving (Ctrl-C to stop).`);
  return { ...prepared, url, steps, played: true };
}
