// M1: a real site opens, its objects carry stable business ids, and what the dataset did not say is
// recorded as a gap rather than filled in.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cityFixture } from "./city-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATASET = cityFixture(here);
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-city-import-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");
const { importCity, queryCity, cityStatus, forget } = await import("../src/city/host.mjs");
const { importDataset } = await import("../src/city/dataset.mjs");

const checks = JSON.parse(readFileSync(path.join(DATASET, "sample_checks.json"), "utf8"));

async function freshProject(name) {
  await createProject(name, { template: "empty" });
  return projectDir(name);
}

test.after(() => rmSync(home, { recursive: true, force: true }));

test("import lands real sizes in local metres, not degrees", () => {
  const model = importDataset(DATASET);
  // building-01's survey says 36 m x 40 m; if the degree->metre conversion were dropped this would
  // be about 0.0003, and everything downstream would still "work".
  const building = model.objects.buildings.find((item) => item.id === "building-01");
  assert.deepEqual(building.bbox, [162, 150, 198, 190]);
  assert.equal(building.area_m2, 1440);
  assert.equal(building.area_m2, building.footprint_area_m2);
  const survey = model.objects.surveys[0];
  assert.equal(building.bbox[2] - building.bbox[0], survey.width_m);
  assert.equal(building.bbox[3] - building.bbox[1], survey.depth_m);
  assert.equal(model.objects.site[0].area_m2, 1000000);
  assert.deepEqual(model.frame.extent_m, [0, 0, 1000, 1000]);
});

test("terrain and buildings sit on the same ground", async () => {
  const { TerrainGrid } = await import("../src/city/geo.mjs");
  const model = importDataset(DATASET);
  assert.equal(model.terrain.row_order, "south_to_north", "the grid is stored south-to-north whatever the file said");
  const terrain = new TerrainGrid({ ...model.terrain, values: model.terrain.values, row_order: model.terrain.row_order });
  // The grid holds CELL-CENTRE samples, so the ground under a building is a bilinear read, not the
  // nearest centre: on the eastern ramp the nearest centre is half a step (0.25 m) out, which is
  // exactly the error that makes a block float.
  for (const building of model.objects.buildings) {
    const ground = terrain.sample(...building.centroid);
    assert.notEqual(ground, null);
    assert.equal(Math.round(ground * 1000) / 1000, building.ground_elevation_m,
      `${building.id} floats above or sinks into the terrain`);
    const nearest = terrain.valueAt(...building.centroid);
    assert.ok(Math.abs(nearest - ground) <= terrain.cellSize * 0.05 + 0.25, `${building.id} is further than half a cell step from the grid`);
  }
});

test("every object has a stable business id and the id map says where it came from", () => {
  const model = importDataset(DATASET);
  const ids = Object.keys(model.id_map);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(model.id_map["building-01"].source_file, "buildings.geojson");
  assert.equal(model.id_map["portal-01-a"].kind, "portal");
  assert.equal(model.id_map["road-v-400-100"].kind, "road");
  // Re-importing the same directory yields the same ids, so a revision written today still resolves.
  assert.deepEqual(Object.keys(importDataset(DATASET).id_map), ids);
});

test("what the dataset did not provide is a recorded gap, not a zero", () => {
  const model = importDataset(DATASET);
  const fields = model.data_gaps.map((gap) => `${gap.scope}:${gap.field}`);
  assert.ok(fields.includes("survey:photos"), "no photos must be a gap on the survey");
  assert.ok(fields.includes("hazard:arrival_time_s"), "an extent-only hazard must say it has no timing");
  assert.ok(fields.includes("demand:unit"), "pedestrian-only demand must say vehicle flow is unsupported");
  for (const gap of model.data_gaps) assert.ok(gap.blocks.length, `${gap.field} does not say what it blocks`);
});

test("the baseline is written once and the scene it generates compiles", async () => {
  const directory = await freshProject("cityA");
  const imported = importCity(directory, DATASET);
  assert.equal(imported.revision, "rev-0000");
  assert.equal(imported.counts.buildings, 16);
  assert.equal(imported.counts.population_total, checks.total_population);
  assert.throws(() => importCity(directory, DATASET), (error) => error.code === "city_baseline_exists");

  const compiled = await compileNamed("cityA");
  assert.equal(compiled.ok, true, JSON.stringify(compiled.problems ?? compiled.diagnostic));
  assert.ok(compiled.usage.native_objects.used < compiled.usage.native_objects.limit);
  const source = readFileSync(path.join(directory, "scene.ssdl"), "utf8");
  assert.match(source, /HeightField \{ id: terrain;/);
  assert.match(source, /City\.select\(objectId: "building-01", kind: "building"\)/);
});

test("selection answers with the business id and the object's own gaps", async () => {
  const directory = await freshProject("cityB");
  importCity(directory, DATASET);
  const answer = queryCity(directory, { id: "building-01" });
  assert.equal(answer.kind, "building");
  assert.equal(answer.object.id, "building-01");
  assert.equal(answer.relations.parcel_id, "parcel-01");
  assert.deepEqual(answer.relations.portals, ["portal-01-a", "portal-01-b"]);
  assert.equal(answer.relations.exit_node, "exit-01");
  assert.equal(answer.relations.population[0].count, 33);
  assert.equal(answer.id_map.source_file, "buildings.geojson");

  const portal = queryCity(directory, { id: "portal-01-a" });
  assert.equal(portal.kind, "portal");
  assert.equal(portal.relations.building_id, "building-01");
  assert.throws(() => queryCity(directory, { id: "no-such-object" }), (error) => error.code === "object_not_found");
});

test("saving and reopening gives the same city", async () => {
  const directory = await freshProject("cityC");
  const first = importCity(directory, DATASET);
  const sceneBefore = readFileSync(path.join(directory, "scene.ssdl"), "utf8");
  const statusBefore = cityStatus(directory);
  // Drop every cache the way a restarted process would, then read it all back off disk.
  forget(directory);
  const statusAfter = cityStatus(directory);
  assert.equal(statusAfter.revision, statusBefore.revision);
  assert.deepEqual(statusAfter.impact, statusBefore.impact);
  assert.equal(statusAfter.population_total, statusBefore.population_total);
  assert.equal(queryCity(directory, { id: "building-01" }).object.height_m, 15);
  // Regenerating the display from the reopened revision must produce the same file, byte for byte.
  const { writeCityProject } = await import("../src/city/host.mjs");
  writeCityProject(directory, first.revision);
  assert.equal(readFileSync(path.join(directory, "scene.ssdl"), "utf8"), sceneBefore);
});

test("a dataset whose ids collide is refused rather than silently merged", () => {
  const copy = mkdtempSync(path.join(os.tmpdir(), "ssworld-city-dup-"));
  for (const file of JSON.parse(readFileSync(path.join(DATASET, "dataset.json"), "utf8")).files.concat("dataset.json")) {
    try { writeFileSync(path.join(copy, file), readFileSync(path.join(DATASET, file))); } catch { /* preview files are not in the fixture */ }
  }
  const buildings = JSON.parse(readFileSync(path.join(copy, "buildings.geojson"), "utf8"));
  buildings.features.push({ ...buildings.features[0] });
  writeFileSync(path.join(copy, "buildings.geojson"), JSON.stringify(buildings));
  assert.throws(() => importDataset(copy), (error) => error.code === "dataset_id_duplicate");
  rmSync(copy, { recursive: true, force: true });
});
