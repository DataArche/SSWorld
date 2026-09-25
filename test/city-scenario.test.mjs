// M4 / M5 / M6: replacing one building, changing what a parcel is for, and evacuating it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cityFixture } from "./city-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATASET = cityFixture(here);
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-city-scenario-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");
const { importCity, commandCity, buildBuilding, startRun, derive, queryCity } = await import("../src/city/host.mjs");
const { CityStore } = await import("../src/city/store.mjs");

let counter = 0;
async function city() {
  const name = `cityScen${counter += 1}`;
  await createProject(name, { template: "empty" });
  const directory = projectDir(name);
  importCity(directory, DATASET);
  return { name, directory };
}

test.after(() => rmSync(home, { recursive: true, force: true }));

// --- M4 -------------------------------------------------------------------------------------------

test("a rule-built candidate keeps the footprint, the dimensions and the doorways", async () => {
  const { directory } = await city();
  const built = buildBuilding(directory, { building_id: "building-01", generator_id: "footprint_extrusion_roof",
    parameters: { roof_style: "hip", roof_pitch_deg: 25 } });
  assert.equal(built.checks.passed, true, JSON.stringify(built.checks.checks.filter((check) => !check.passed)));
  const names = built.checks.checks.map((check) => check.check);
  for (const required of ["footprint_area", "position", "height", "survey_dimensions", "portals_clear", "no_neighbour_overlap"]) {
    assert.ok(names.includes(required), `${required} is not checked`);
  }
  assert.equal(built.candidate.dimensions.height_m, 15, "the candidate must hit the surveyed height");
  // The recipe pins everything needed to rebuild it after the inputs change.
  for (const field of ["building_id", "input_refs", "constraints", "generator_id", "generator_version", "parameters", "seed", "recipe_digest"]) {
    assert.ok(built.recipe[field] !== undefined, `the recipe does not record ${field}`);
  }
  assert.ok(built.recipe.input_refs.includes("modeling_survey.geojson#survey-01"));
  assert.deepEqual(built.recipe.photos, [], "this building has no photos and the recipe must say so");
});

test("a candidate that misses the surveyed shape fails its checks instead of being applied", async () => {
  const { directory } = await city();
  const wrong = buildBuilding(directory, { building_id: "building-01",
    constraints: { footprint: [[162, 150], [178, 150], [178, 170], [162, 170]], height_m: 15 } });
  assert.equal(wrong.checks.passed, false);
  const failed = wrong.checks.checks.filter((check) => !check.passed).map((check) => check.check);
  assert.ok(failed.includes("footprint_area"));
  assert.ok(failed.includes("survey_dimensions"));
});

test("replacing the model changes the display and nothing else, and can be undone", async () => {
  const { name, directory } = await city();
  const before = startRun(directory, { kind: "traffic", horizon_s: 6000 });
  const built = buildBuilding(directory, { building_id: "building-01", generator_id: "footprint_extrusion_roof" });
  const applied = commandCity(directory, { command_id: "swap", kind: "building.replace_asset",
    params: { building_id: "building-01", recipe_id: built.recipe.recipe_id, asset: { kind: "parametric", nodes: built.candidate.nodes, recipe_digest: built.recipe.recipe_digest } } });
  assert.deepEqual(applied.invalidates, ["display"], "an appearance swap must not claim to change traffic");
  assert.equal(applied.display.scene_changed, true);

  const after = startRun(directory, { kind: "traffic", horizon_s: 6000 });
  assert.deepEqual(after.result.counts, before.result.counts, "swapping a model must not move a single traveller");
  const source = readFileSync(path.join(directory, "scene.ssdl"), "utf8");
  assert.match(source, /Roof \{ id: n_building_01_roof;/);
  // Exactly one mass and one roof for this building: no old block left standing behind the new one.
  // (The tap handler carries an id of its own, so the count is over geometry nodes only.)
  assert.equal((source.match(/(?:ExtrudedPolygon|Model|Box) \{ id: n_building_01\b/g) || []).length, 1);
  assert.equal((source.match(/Roof \{ id: n_building_01_roof\b/g) || []).length, 1);
  assert.equal((source.match(/TapHandler \{ id: n_building_01_tap\b/g) || []).length, 1, "the mass must still be tappable");
  const compiled = await compileNamed(name);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.problems ?? compiled.diagnostic));

  // Identity and relationships survive the swap, and the earlier revision still describes the old one.
  const now = queryCity(directory, { id: "building-01" });
  assert.equal(now.relations.parcel_id, "parcel-01");
  assert.deepEqual(now.relations.portals, ["portal-01-a", "portal-01-b"]);
  const undone = queryCity(directory, { id: "building-01", revision: "rev-0000" });
  assert.equal(undone.object.asset, undefined, "the baseline revision must still show the original");
});

// --- M5 -------------------------------------------------------------------------------------------

test("a park plan updates layout, access, population and cover in one transaction", async () => {
  const { directory } = await city();
  const populationBefore = derive(directory).population.find((row) => row.building_id === "building-01").count;
  assert.equal(populationBefore, 33);

  const park = commandCity(directory, { command_id: "park", kind: "parcel.set_use", params: {
    parcel_id: "parcel-01", new_use: "park", demolish: ["building-01"],
    retain_portals: ["portal-01-a", "portal-01-b"], resident_count: 0, visitor_peak_person: 60, impervious_fraction: 0.15 } });
  const state = derive(directory, park.revision);
  assert.equal(state.model.objects.buildings.some((item) => item.id === "building-01"), false, "the demolished building is gone");
  assert.equal(state.model.objects.parcels.find((item) => item.id === "parcel-01").land_use, "park");
  assert.equal(state.population.some((row) => row.building_id === "building-01"), false, "its residents went with it");
  assert.equal(state.model.objects.surface_cover.find((item) => item.id === "cover-parcel-01").impervious_fraction, 0.15);
  // Both gates are still open, so the park is still reachable.
  for (const id of ["portal-01-a", "portal-01-b"]) {
    assert.notEqual(state.model.objects.portals.find((item) => item.id === id).open, false);
  }
  // A permeability change is recorded, not turned into a flood answer the model cannot produce.
  assert.match(park.effect.hydrology_note, /computes no runoff/);
});

test("a plan that would leave no way in is refused and changes nothing", async () => {
  const { directory } = await city();
  const before = new CityStore(directory).head();
  assert.throws(() => commandCity(directory, { command_id: "bad", kind: "parcel.set_use",
    params: { parcel_id: "parcel-01", new_use: "park", retain_portals: [] } }), (error) => error.code === "plan_has_no_access");
  assert.throws(() => commandCity(directory, { command_id: "bad2", kind: "parcel.set_use",
    params: { parcel_id: "parcel-01", new_use: "resort" } }), (error) => error.code === "unsupported_land_use");
  assert.throws(() => commandCity(directory, { command_id: "bad3", kind: "parcel.set_use",
    params: { parcel_id: "parcel-01", new_use: "mixed" } }), (error) => error.code === "plan_input_missing");
  assert.throws(() => commandCity(directory, { command_id: "bad4", kind: "parcel.set_use",
    params: { parcel_id: "parcel-01", new_use: "park", demolish: ["building-02"] } }), (error) => error.code === "building_not_on_parcel");
  const after = new CityStore(directory).head();
  assert.deepEqual(after, before, "a refused plan must not leave a revision behind");
  assert.deepEqual(new CityStore(directory).log(), [], "nor a command record");
});

test("a mixed-use plan raises the capacity the demand is computed from", async () => {
  const { directory } = await city();
  const mixed = commandCity(directory, { command_id: "mixed", kind: "parcel.set_use", params: {
    parcel_id: "parcel-01", new_use: "mixed", replace: ["building-01"], gross_floor_area_m2: 7200,
    residential_fraction: 0.7, commercial_fraction: 0.3, resident_count: 120, jobs: 60 } });
  const state = derive(directory, mixed.revision);
  const building = state.model.objects.buildings.find((item) => item.id === "building-01");
  assert.equal(building.use, "mixed");
  assert.equal(building.floors, 5, "7200 m2 over a 1440 m2 footprint is five floors");
  assert.equal(state.population.find((row) => row.building_id === "building-01").count, 120,
    "the plan's residents must reach the population the evacuation uses");
  assert.equal(mixed.effect.jobs, 60);
});

// --- M6 -------------------------------------------------------------------------------------------

test("an evacuation closes on the population and never exceeds a shelter", async () => {
  const { directory } = await city();
  commandCity(directory, { command_id: "slide", kind: "hazard.activate", params: { hazard_id: "slide-1" } });
  const run = startRun(directory, { kind: "evacuation", horizon_s: 9000, sample_interval_s: 300 });
  const result = run.result;
  assert.equal(result.population_total, 888);
  assert.equal(result.population_closed, true, JSON.stringify(result.counts));
  for (const shelter of result.shelters) {
    assert.ok(shelter.assigned <= shelter.capacity_person, `${shelter.shelter_id} was over-filled`);
  }
  for (const destination of result.destinations) {
    assert.ok(destination.admitted <= destination.capacity, `${destination.node} admitted more than it holds`);
  }
  // Anybody who did not make it says why, in words.
  for (const group of [...result.stranded, ...result.unassigned]) {
    assert.ok(group.code || group.reason, JSON.stringify(group));
    assert.ok(group.count > 0);
  }
  if (result.incomplete > 0) {
    assert.equal(result.completion_time_s, null, "a partial evacuation must not report a completion time");
  }
});

test("an evacuation route never runs through a blocked link", async () => {
  const { directory } = await city();
  commandCity(directory, { command_id: "slide", kind: "hazard.activate", params: { hazard_id: "slide-1" } });
  commandCity(directory, { command_id: "flood", kind: "water.set_level", params: { water_id: "river-1", level_m: 11 } });
  const state = derive(directory);
  const blocked = new Set(state.impact.blockedEdgeIds());
  assert.ok(blocked.size > 60, "this scenario really does close a lot of links");

  const { assignShelters } = await import("../src/city/evacuation.mjs");
  const { blockingFrom } = await import("../src/city/network.mjs");
  const plan = assignShelters(state.model, state.network, state.population, { blocked: blockingFrom(state.impact) });
  for (const assignment of plan.assignments) {
    const route = state.network.route(assignment.origin_node, assignment.shelter_node, "walk", { blocked: blockingFrom(state.impact) });
    assert.ok(route, `${assignment.building_id} was assigned a shelter it cannot reach`);
    for (const id of route.edge_ids) assert.ok(!blocked.has(id), `${assignment.building_id} is routed through closed ${id}`);
  }
  const assigned = plan.assignments.reduce((sum, item) => sum + item.count, 0);
  const unassigned = plan.unassigned.reduce((sum, item) => sum + item.count, 0);
  assert.equal(assigned + unassigned, 888, "everyone is either assigned or explained");
  assert.ok(unassigned > 0, "with the river up and the slope gone, some groups must be reported unreachable");
  for (const group of plan.unassigned) assert.match(group.reason, /no_reachable_shelter|all_reachable_shelters_full|no_exit_node/);
});

test("a shelter that is itself in the hazard does not take anybody", async () => {
  const { directory } = await city();
  const state = derive(directory);
  const shelter = state.model.objects.shelters[0];
  const { runEvacuation } = await import("../src/city/evacuation.mjs");
  const { ImpactState } = await import("../src/city/impact.mjs");
  const impact = new ImpactState().setCause("landslide", { nodes: [{ node_id: shelter.node_id, status: "closed", hazard_id: "slide-1" }] });
  const result = runEvacuation(state.model, state.network, { population: state.population, impact, horizon_s: 9000 });
  assert.ok(result.shelter_exposure.some((entry) => entry.shelter_id === shelter.id && entry.status === "unavailable"));
  assert.equal(result.shelters.some((entry) => entry.shelter_id === shelter.id), false,
    "an unusable shelter must not appear in the capacity table as if it took people");
  assert.equal(result.population_closed, true);
});

// --- the rule generators are shared with the Python modeller -----------------------------------------

test("the service builds the same candidates the Python modeller is checked against", async () => {
  const { GENERATORS, canonicalJson } = await import("../src/city/recipes.mjs");
  const { createHash } = await import("node:crypto");
  const vectors = JSON.parse(readFileSync(path.join(DATASET, "..", "candidates", "building-01.json"), "utf8"));
  assert.ok(vectors.cases.length, "the vector file is empty");
  for (const item of vectors.cases) {
    const candidate = GENERATORS[item.generator_id].build({
      footprint: item.footprint, height_m: item.height_m, parameters: item.parameters, seed: item.seed });
    assert.deepEqual(candidate, item.candidate, `${item.generator_id} drifted from the frozen candidate`);
    assert.equal(`sha256:${createHash("sha256").update(canonicalJson(candidate)).digest("hex")}`, item.candidate_digest);
  }
  // The canonical text is the contract the two implementations hash, not a convenience.
  assert.equal(canonicalJson({ b: 1.0, a: [2.5, 3.0], c: null, d: true }), '{"a":[2.5,3],"b":1,"c":null,"d":true}');
  assert.equal(canonicalJson(15.0), "15");
});
