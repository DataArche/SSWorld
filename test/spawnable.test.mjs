import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// paths.mjs resolves the workspace once at import time, so the home has to move first.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-spawn-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");
const { inspectScene } = await import("../src/inspect.mjs");

const SCENE = `Scene {
  id: main
  property real hour: 8
  Plane { id: ground; width: 200; depth: 200 }
  CameraView { id: v; position: [0, -80, 40]; lookAt: [0, 0, 0] }
  Camera { id: cam; initialView: v }
}
`;
const HOUSE = `pragma spawnable
Group {
  id: root
  property length width: 8
  property real floors: 3
  property string tint: "#c8b49a"
  Box {
    id: shell
    width: width
    depth: width
    height: floors * 3
    position: [0, 0, floors * 1.5]
    PrincipledMaterial { id: paint; baseColor: tint }
  }
}
`;

test("a spawnable component is compiled, priced and reported without being mounted", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await createProject("town", { template: "empty" });
  const directory = projectDir("town");
  writeFileSync(path.join(directory, "scene.ssdl"), SCENE, "utf8");
  writeFileSync(path.join(directory, "House.ssdl"), HOUSE, "utf8");
  const receipt = await compileNamed("town");
  assert.equal(receipt.ok, true);

  assert.deepEqual(receipt.spawnable.map((item) => item.name), ["House"]);
  const house = receipt.spawnable[0];
  assert.equal(house.source_file, "House.ssdl");
  assert.deepEqual(house.parameters.map((item) => item.name), ["width", "floors", "tint"]);
  assert.equal(house.cost_per_copy.native_objects, 2);
  // The fragment is not part of the mounted scene: a spawnable House costs nothing until spawn().
  assert.equal(receipt.usage.native_objects.used, 1, "only the ground plane mounts");
  assert.equal(receipt.usage.locators.used, 0, "the fragment's Group is not a mounted locator");

  const inspected = inspectScene(directory);
  assert.deepEqual(inspected.dynamic.spawnable.map((item) => item.name), ["House"]);
  const entry = inspected.dynamic.spawnable[0];
  assert.equal(entry.limited_by, "locators");
  assert.equal(entry.copies_left, 1024, "one locator each against SceneGraphFacade.max_locators");
  assert.equal(entry.cost_per_copy.materials, 1);
});

test("a project with no spawnable component says so rather than reporting nothing", async () => {
  await createProject("plain", { template: "empty" });
  writeFileSync(path.join(projectDir("plain"), "scene.ssdl"), SCENE, "utf8");
  const receipt = await compileNamed("plain");
  assert.equal(receipt.spawnable, undefined);
  const inspected = inspectScene(projectDir("plain"));
  assert.deepEqual(inspected.dynamic.spawnable, []);
  assert.match(inspected.dynamic.note, /pragma spawnable/);
});
