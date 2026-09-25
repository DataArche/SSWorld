// M3: a water level becomes a connected extent, and that extent becomes closures the rest of the
// city can read. The four cases the milestone names are each here: a connected hollow, a hollow
// behind a levee, a bridge deck, and a low doorway.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cityFixture } from "./city-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATASET = cityFixture(here);
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-city-flood-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");
const { importCity, commandCity, impactReport, derive } = await import("../src/city/host.mjs");
const { importDataset } = await import("../src/city/dataset.mjs");
const { computeFlood, floodImpact } = await import("../src/city/flood.mjs");

const checks = JSON.parse(readFileSync(path.join(DATASET, "sample_checks.json"), "utf8"));
const model = importDataset(DATASET);

test.after(() => rmSync(home, { recursive: true, force: true }));

test("the extent at the baseline and at +1 m is the one the dataset computed", () => {
  const baseline = computeFlood(model, { waterLevelOverrides: { "river-1": 10 } });
  assert.equal(baseline.area_m2, checks.baseline_water_area_m2);
  const risen = computeFlood(model, { waterLevelOverrides: { "river-1": 11 } });
  assert.equal(risen.area_m2, checks.rise_1m_water_area_m2);
  assert.equal(risen.area_m2 - baseline.area_m2, checks.new_water_area_m2);
  assert.equal(risen.bodies[0].level_source, "scenario_override");
  assert.equal(risen.unknown_cells, 0);
});

test("the closures at +1 m are exactly the ones the dataset listed", () => {
  const field = computeFlood(model, { waterLevelOverrides: { "river-1": 11 } });
  const impact = floodImpact(model, field);
  const closed = impact.edges.filter((entry) => entry.status === "closed").map((entry) => entry.edge_id).sort();
  assert.deepEqual(closed, [...checks.water_closed_edge_ids].sort());
  assert.deepEqual(impact.edges.filter((entry) => entry.status === "unknown"), []);
});

test("a bridge is judged on its deck, not on the ground under it", () => {
  const field = computeFlood(model, { waterLevelOverrides: { "river-1": 11 } });
  const impact = floodImpact(model, field);
  const bridges = model.network.edges.filter((edge) => edge.bridge).map((edge) => edge.id);
  assert.ok(bridges.length);
  for (const id of bridges) {
    // The channel under these decks is 2 m deep; the deck itself is at 13 m and stays open.
    const line = model.network.edges.find((edge) => edge.id === id).polyline;
    const midpoint = [(line[0][0] + line[line.length - 1][0]) / 2, (line[0][1] + line[line.length - 1][1]) / 2];
    const under = field.surfaceAt(...midpoint);
    assert.equal(under.status, "wet");
    assert.ok(under.depth_m > 1.5, "the water under the bridge really is deep");
    assert.ok(!impact.edges.some((entry) => entry.edge_id === id), `${id} was closed by the water under it`);
  }
  assert.equal(checks.bridge_edges_remain_open, true);
});

test("a hollow behind an un-overtopped levee does not fill", async () => {
  const { TerrainGrid } = await import("../src/city/geo.mjs");
  // 6 x 1 cells of 10 m: a channel at x = 5, a 3 m crest at x = 25, and a pit at x = 45 that is
  // BELOW the water surface but on the far side of the crest.
  const pocket = {
    ...model,
    terrain: { width: 6, height: 1, cell_size_m: 10, origin_sw_m: [0, 0], row_order: "south_to_north",
      nodata: -9999, vertical_datum: "test", sample_location: "cell_center",
      values: [[0, 0, 3, 0.5, 0.5, 3]] },
    objects: {
      ...model.objects,
      water: [{ id: "channel", geometry: { type: "Polygon", coordinates: [[[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]]] },
        centroid: [10, 5], area_m2: 200, bbox: [0, 0, 20, 10], baseline_level_m: 0.5,
        provenance: { source_file: "test", quality_status: "authored" } }],
      hydraulic_structures: [{ id: "levee", kind: "bank", crest_elevation_m: 3,
        geometry: { type: "LineString", coordinates: [[25, -5], [25, 15]] },
        provenance: { source_file: "test", quality_status: "authored" } }],
    },
  };
  const grid = new TerrainGrid({ ...pocket.terrain, values: pocket.terrain.values });
  assert.equal(grid.valueAtCell(4, 0), 0.5, "the pit really is below the water surface");

  const held = computeFlood(pocket, { waterLevelOverrides: { channel: 2 } });
  // Two channel cells fill. The pit does not: the crest at 3 m is higher than the 2 m surface.
  assert.equal(held.area_m2, 200);
  assert.equal(held.surfaceAt(45, 5).status, "dry");

  // Raise the water over the crest and the pit fills, because now it really is connected.
  const overtopped = computeFlood(pocket, { waterLevelOverrides: { channel: 3.5 } });
  assert.equal(overtopped.surfaceAt(45, 5).status, "wet");
  assert.ok(overtopped.area_m2 > held.area_m2);
});

test("a doorway below the water line closes and a raised one does not", () => {
  const field = computeFlood(model, { waterLevelOverrides: { "river-1": 11 } });
  const impact = floodImpact(model, field);
  const closedPortals = impact.portals.map((entry) => entry.portal_id);
  assert.ok(closedPortals.includes("portal-05-a"), "a 10.6 m doorway under an 11 m surface must close");
  assert.ok(!closedPortals.includes("portal-01-a"), "a doorway on the 12 m terrace must not");
  const low = model.objects.portals.find((portal) => portal.id === "portal-05-a");
  assert.ok(low.elevation_m < 11);
});

test("an unknown datum stays unknown instead of becoming zero", () => {
  const nodatum = { ...model, objects: { ...model.objects,
    water: [{ ...model.objects.water[0], baseline_level_m: null }] } };
  const field = computeFlood(nodatum, {});
  assert.equal(field.bodies[0].status, "unknown");
  assert.equal(field.area_m2, 0);
  assert.match(field.bodies[0].reason, /no baseline water surface/);
});

test("the display layer and the impact list describe the same water", () => {
  const field = computeFlood(model, { waterLevelOverrides: { "river-1": 11 } });
  const runs = field.wetRuns();
  const area = runs.reduce((sum, [x0, y0, x1, y1]) => sum + (x1 - x0) * (y1 - y0), 0);
  assert.equal(area, field.area_m2, "the overlay must cover exactly the wet cells, no more and no less");
  for (const [, , , , surface] of runs) assert.equal(surface, 11);
});

test("clearing the water clears flood closures and leaves an operator closure standing", async () => {
  await createProject("cityFlood", { template: "empty" });
  const directory = projectDir("cityFlood");
  importCity(directory, DATASET);

  commandCity(directory, { command_id: "f1", kind: "water.set_level", params: { water_id: "river-1", level_m: 11 } });
  commandCity(directory, { command_id: "f2", kind: "road.close", params: { edge_id: "road-h-100-100", reason: "works" } });
  const flooded = derive(directory);
  assert.ok(flooded.impact.blockedEdgeIds().includes("road-v-400-100"));
  assert.ok(flooded.impact.blockedEdgeIds().includes("road-h-100-100"));
  assert.deepEqual(flooded.impact.reasons("edges", "road-h-100-100").map((reason) => reason.cause), ["manual"]);

  const reset = commandCity(directory, { command_id: "f3", kind: "water.reset_level", params: { water_id: "river-1" } });
  const dry = derive(directory, reset.revision);
  assert.ok(!dry.impact.blockedEdgeIds().includes("road-v-400-100"), "the flood closure must lift with the water");
  assert.ok(dry.impact.blockedEdgeIds().includes("road-h-100-100"), "the operator closure must survive the water going down");
});

test("cut off but dry is a different answer from inundated", async () => {
  await createProject("cityFlood2", { template: "empty" });
  const directory = projectDir("cityFlood2");
  importCity(directory, DATASET);
  commandCity(directory, { command_id: "w", kind: "water.set_level", params: { water_id: "river-1", level_m: 11 } });
  commandCity(directory, { command_id: "h", kind: "hazard.activate", params: { hazard_id: "slide-1" } });
  const report = impactReport(directory);
  const statuses = new Set(report.reachability.isolated.map((entry) => entry.status));
  assert.ok(statuses.has("inundated_and_cut_off"), "the buildings in the water must say so");
  assert.ok(statuses.has("cut_off_not_inundated"), "a dry building behind the landslide must not be called flooded");
  assert.ok(report.limitations.some((line) => /no propagation time/.test(line)));
  // Recompiling after the water rose still produces a valid scene, with the flood overlay in it.
  const compiled = await compileNamed("cityFlood2");
  assert.equal(compiled.ok, true, JSON.stringify(compiled.problems ?? compiled.diagnostic));
  assert.match(readFileSync(path.join(directory, "scene.ssdl"), "utf8"), /Mesh \{ id: waterSurface;/);
});
