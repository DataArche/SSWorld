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
