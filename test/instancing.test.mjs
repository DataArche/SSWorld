import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-instancing-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");
const { DEFAULT_BUDGETS } = await import("../src/budgets.mjs");

async function compileScene(name, scene) {
  await createProject(name, { template: "empty" });
  writeFileSync(path.join(projectDir(name), "scene.ssdl"), scene, "utf8");
  return compileNamed(name);
}

const GRID = `Scene {
  id: main
  Cylinder { id: lampPost; radius: 0.12; height: 6; position: [0, 0, 3] }
  Prefab { id: pfLamp; source: lampPost }
  Instances { id: lamps; prefab: pfLamp; placement: "grid"; origin: [0, 0, 3]; spacing: [18, 40]; columns: 20; count: 240 }
}
`;

// The whole point of instancing: 240 lamp posts must not cost 240 native objects.  If this number ever
// tracks the instance count again, the batch has stopped being a batch.
test("an Instances batch costs instance rows, not native objects", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await compileScene("lampGrid", GRID);
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result));
  assert.equal(result.usage.instances.used, 240);
  assert.equal(result.usage.prefabs.used, 1);
  // The source cylinder plus the prefab's own entity+renderer.  Not 242.
  assert.equal(result.usage.native_objects.used, 2);
  // Pinned to the shared default rather than a copied number: the point is that the batch is
  // measured against the instance-row budget, not that the budget is any given size.
  assert.equal(result.usage.instances.limit, DEFAULT_BUDGETS.instances);
});

test("explicit placement counts the positions it was given", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await compileScene("lampRow", GRID.replace(
    'placement: "grid"; origin: [0, 0, 3]; spacing: [18, 40]; columns: 20; count: 240',
    'placement: "explicit"; positions: [[0, 0, 3], [12, 0, 3], [24, 0, 3]]'));
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result));
  assert.equal(result.usage.instances.used, 3);
  assert.equal(result.usage.native_objects.used, 2);
});

// Pose reaches the engine only if the compiler lets these six members through the catalog in the
// first place; an unknown_property here is what an author would hit before ever seeing a page.
const POSED = `Scene {
  id: main
  Cylinder { id: trunk; radius: 0.2; height: 5; position: [0, 0, 2.5] }
  Prefab { id: pfTrunk; source: trunk }
  Instances { id: rowA; prefab: pfTrunk; positions: [[0,0,0],[6,0,0],[12,0,0]]; rotations_z: [0,137,58]; scales_uniform: [1,1.3,0.85] }
  Instances { id: rowB; prefab: pfTrunk; positions: [[0,10,0],[6,10,0]]; rotations: [[0,0,90],[12,0,45]]; scales: [[1,1,2],[2,1,1]] }
  Instances { id: gridC; prefab: pfTrunk; placement: "grid"; count: 4; columns: 2; origin: [0,20,0]; spacing: [5,5]; rotation_z: 45; scale: [1.5,1.5,1.5] }
}
`;

test("per-instance rotation and scale compile through the packaged catalog", async () => {
  const result = await compileScene("posedRows", POSED);
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result));
  assert.equal(result.usage.instances.used, 9);
  assert.equal(result.usage.prefabs.used, 1);
});

// along_path spaced by `step` carries no `count` property at all, so a receipt that read the
// property alone reported 0 rows for a batch the runtime then filled -- the compile numbers and the
// running scene disagreed about how many instances exist.  100 m of path at 10 m spacing is 11.
test("along_path spaced by step counts the rows the runtime will place", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await compileScene("lampPath", GRID.replace(
    'placement: "grid"; origin: [0, 0, 3]; spacing: [18, 40]; columns: 20; count: 240',
    'placement: "along_path"; path: [[0, 0, 3], [100, 0, 3]]; step: 10'));
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result));
  assert.equal(result.usage.instances.used, 11);
  assert.equal(result.usage.native_objects.used, 2);
});

test("ring placement counts its instances", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await compileScene("lampRing", GRID.replace(
    'placement: "grid"; origin: [0, 0, 3]; spacing: [18, 40]; columns: 20; count: 240',
    'placement: "ring"; center: [0, 0, 3]; radius: 20; count: 7; faceCenter: true'));
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result));
  assert.equal(result.usage.instances.used, 7);
});
