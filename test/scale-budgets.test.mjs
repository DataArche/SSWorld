import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// paths.mjs resolves the workspace once at import time, so the home has to move first.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-scale-home-"));
process.env.SSWORLD_HOME = home;
const { DEFAULT_BUDGETS, ENGINE_CEILINGS, resolveBudgets, MAX_SCENE_DEPTH, MAX_MODEL_INSTANCES,
  MAX_TEXTURE_BYTES_TOTAL } = await import("../src/budgets.mjs");
const { budgetUsage } = await import("../src/compile.mjs");

test.after(() => rmSync(home, { recursive: true, force: true }));

test("the dimensions the engine owns are clamped, not merely defaulted", () => {
  // A manifest asking for more timers than AnimationFacade has would otherwise compile and then
  // fail to mount -- exactly the failure the budgets exist to turn into a compile error.
  const asked = resolveBudgets({ timers: 4096, timelines: 4096, textures: 256, locators: 65536, native_objects: 32768 });
  assert.equal(asked.timers, ENGINE_CEILINGS.timers);
  assert.equal(asked.timelines, ENGINE_CEILINGS.timelines);
  assert.equal(asked.textures, ENGINE_CEILINGS.textures);
  assert.equal(asked.locators, ENGINE_CEILINGS.locators);
  // native_objects is a guardrail, not an engine ceiling: a project may raise it.
  assert.equal(asked.native_objects, 32768);
});

test("the shipped budgets sit where the real machine put them", () => {
  // 1500 bindings mount and run once the native property batch is chunked; 64 was the wall before.
  assert.ok(DEFAULT_BUDGETS.bindings >= 1500, "measured: 1500 bindings mount at 44 fps");
  assert.ok(DEFAULT_BUDGETS.handlers >= 600, "measured: 600 handlers mount");
  // 409600 instance rows across 200 prefabs mount at 61 fps for 200 native objects.
  assert.ok(DEFAULT_BUDGETS.instances >= 409600, "measured: 409600 instance rows");
  assert.ok(DEFAULT_BUDGETS.prefabs >= 200, "measured: 200 prefabs");
  // 4001 native objects capture; 5001 kills the readback. The budget must not promise past that.
  assert.ok(DEFAULT_BUDGETS.native_objects >= 4001, "4001 objects were captured on real hardware");
  assert.ok(DEFAULT_BUDGETS.native_objects < 5001, "5001 objects lose ssworld_capture_frame to a wasm OOB");
});

test("Group locators are counted apart from nodes, because the engine pools them apart", () => {
  const ir = { scene_ir: { nodes: [
    { id: "main", type: "Scene", parent: null, properties: [] },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `g${index}`, type: "Group", parent: "main", properties: [] })),
    ...Array.from({ length: 7 }, (_, index) => ({ id: `b${index}`, type: "Box", parent: "main", properties: [] })),
  ] } };
  const usage = budgetUsage(ir, {});
  assert.equal(usage.locators.used, 5);
  assert.equal(usage.locators.limit, ENGINE_CEILINGS.locators);
  assert.equal(usage.native_objects.used, 12, "a Group is both a node and a locator");
});

test("the engine ceilings that have no budget dimension are still named", () => {
  assert.equal(MAX_SCENE_DEPTH, 16);           // SceneGraphFacade.max_depth
  assert.equal(MAX_MODEL_INSTANCES, 64);       // ModelFacade.max_model_instances
  assert.equal(MAX_TEXTURE_BYTES_TOTAL, 67108864); // MaterialFacade.max_texture_bytes_total
});
