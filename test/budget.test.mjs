import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSourceProject, budgetUsage, compileProject, CompileError } from "../src/compile.mjs";
import { resolveBudgets } from "../src/budgets.mjs";
import { inspectScene } from "../src/inspect.mjs";
import { SSDL_ROOT } from "../src/paths.mjs";
import { DEFAULT_BUDGETS } from "../src/project.mjs";

const { compileSceneModuleProject } = await import(pathToFileURL(path.join(SSDL_ROOT, "compiler", "src", "compiler-0.3.mjs")).href);

function sceneWithMaterials(textureSources) {
  const declarations = textureSources.flatMap((source, index) => [
    `Box { id: box${index}; width: 1; depth: 1; height: 1 }`,
    `Texture { id: texture${index}; source: "assets/${source}" }`,
    `PrincipledMaterial { id: material${index}; target: box${index}; baseColorMap: texture${index} }`,
  ]);
  return `Scene {\n  id: main\n  ${declarations.join("\n  ")}\n}\n`;
}

async function compileBudgetScene(t, textureSources, { contentsBySource = {} } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ssworld-budget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "assets"));
  for (const [index, source] of [...new Set(textureSources)].entries()) {
    writeFileSync(path.join(directory, "assets", source), contentsBySource[source] ?? Buffer.alloc(index + 3, index + 1));
  }
  writeFileSync(path.join(directory, "scene.ssdl"), sceneWithMaterials(textureSources), "utf8");
  const project = await buildSourceProject(directory);
  return compileSceneModuleProject(project, {
    entry: "scene.generated.mjs",
    mapName: "scene.generated.mjs.map",
    name: "BudgetScene",
    budgets: DEFAULT_BUDGETS,
  });
}

async function compileSharedTextureAcrossMaterialSlots(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ssworld-budget-mr-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "assets"));
  const packedTexture = Buffer.from([1, 2, 3, 4]);
  writeFileSync(path.join(directory, "assets", "packed-orm.png"), packedTexture);
  writeFileSync(path.join(directory, "scene.ssdl"), `Scene {
  id: main
  Box { id: floor; width: 1; depth: 1; height: 1 }
  Texture { id: packedOrm; source: "assets/packed-orm.png" }
  PrincipledMaterial {
    id: floorMaterial
    target: floor
    baseColorMap: packedOrm
    metallicRoughnessMap: packedOrm
  }
}
`, "utf8");
  const project = await buildSourceProject(directory);
  return compileSceneModuleProject(project, {
    entry: "scene.generated.mjs",
    mapName: "scene.generated.mjs.map",
    name: "BudgetMaterialSlots",
    budgets: DEFAULT_BUDGETS,
  });
}

function writeBudgetProject(t, textureSources, { budgets = DEFAULT_BUDGETS, contentsBySource = {} } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ssworld-budget-project-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "assets"));
  for (const [index, source] of [...new Set(textureSources)].entries()) {
    writeFileSync(path.join(directory, "assets", source), contentsBySource[source] ?? Buffer.alloc(index + 3, index + 1));
  }
  writeFileSync(path.join(directory, "scene.ssdl"), sceneWithMaterials(textureSources), "utf8");
  writeFileSync(path.join(directory, "scene.mjs"), "export default {};\n", "utf8");
  writeFileSync(path.join(directory, "showcase.manifest.json"), JSON.stringify({
    schema_version: "SceneModuleManifest/1",
    name: "BudgetProject",
    entry: "scene.mjs",
    budgets,
  }, null, 2) + "\n", "utf8");
  return directory;
}

test("budget usage shares one texture entry for two materials with the same source", async (t) => {
  const result = await compileBudgetScene(t, ["shared.png", "shared.png"]);
  const usage = budgetUsage(result, DEFAULT_BUDGETS);

  assert.equal(usage.materials.used, 2);
  assert.equal(usage.textures.used, 1);
  assert.equal(usage.textures.distinct, 1);
  assert.equal(usage.textures.encoded_bytes, 3);
  assert.equal(usage.textures.bytes, undefined);
});

test("budget counts one metallic-roughness texture shared with baseColorMap", async (t) => {
  const result = await compileSharedTextureAcrossMaterialSlots(t);
  const usage = budgetUsage(result, DEFAULT_BUDGETS);
  const material = result.scene_ir.nodes.find((node) => node.type === "PrincipledMaterial");
  const slots = material.properties.filter((item) =>
    ["baseColorMap", "metallicRoughnessMap"].includes(item.property));

  assert.deepEqual(slots.map((item) => item.property), ["baseColorMap", "metallicRoughnessMap"]);
  assert.equal(slots[0].value.content_digest, slots[1].value.content_digest);
  assert.equal(usage.materials.used, 1);
  assert.equal(usage.textures.used, 1);
  assert.equal(usage.textures.distinct, 1);
  assert.equal(usage.textures.encoded_bytes, 4);
});

test("budget usage deduplicates different texture asset paths with the same content digest", async (t) => {
  const shared = Buffer.from([7, 8, 9]);
  const result = await compileBudgetScene(t, ["copy-a.png", "copy-b.png"], {
    contentsBySource: { "copy-a.png": shared, "copy-b.png": shared },
  });
  const usage = budgetUsage(result, DEFAULT_BUDGETS);

  assert.equal(usage.textures.used, 1);
  assert.equal(usage.textures.distinct, 1);
  assert.equal(usage.textures.encoded_bytes, shared.byteLength);
});

test("budget usage counts two texture content digests", async (t) => {
  const result = await compileBudgetScene(t, ["albedo.png", "detail.jpg"]);
  const usage = budgetUsage(result, DEFAULT_BUDGETS);

  assert.equal(usage.textures.used, 2);
  assert.equal(usage.textures.distinct, 2);
  assert.equal(usage.textures.encoded_bytes, 7);
  assert.equal(usage.textures.bytes, undefined);
});

test("budget usage excludes PrincipledMaterial shells from native objects", async (t) => {
  const result = await compileBudgetScene(t, ["a.png", "b.png", "c.png"]);
  const usage = budgetUsage(result, DEFAULT_BUDGETS);

  assert.equal(usage.materials.used, 3);
  assert.equal(usage.native_objects.used, 3);
  assert.ok(usage.native_objects.used < result.scene_ir.nodes.length);
});

test("legacy manifests use material and texture defaults during compile and inspection", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ssworld-legacy-budget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "scene.ssdl"), sceneWithMaterials(["legacy.png"]), "utf8");
  writeFileSync(path.join(directory, "scene.mjs"), "export default {};\n", "utf8");
  mkdirSync(path.join(directory, "assets"));
  writeFileSync(path.join(directory, "assets", "legacy.png"), Buffer.alloc(5, 1));
  const legacyBudgets = { native_objects: 16, bindings: 8, handlers: 4, timers: 2, timelines: 256 };
  writeFileSync(path.join(directory, "showcase.manifest.json"), JSON.stringify({
    schema_version: "SceneModuleManifest/1",
    name: "LegacyBudget",
    entry: "scene.mjs",
    budgets: legacyBudgets,
  }, null, 2) + "\n", "utf8");

  const compiled = await compileProject(directory);
  assert.equal(compiled.usage.materials.limit, DEFAULT_BUDGETS.materials);
  assert.equal(compiled.usage.textures.limit, DEFAULT_BUDGETS.textures);
  const persisted = JSON.parse(readFileSync(path.join(directory, "showcase.manifest.json"), "utf8"));
  assert.equal(persisted.budgets.materials, DEFAULT_BUDGETS.materials);
  assert.equal(persisted.budgets.textures, DEFAULT_BUDGETS.textures);
  writeFileSync(path.join(directory, "showcase.manifest.json"), JSON.stringify({ ...persisted, budgets: legacyBudgets }, null, 2) + "\n", "utf8");

  const inspected = inspectScene(directory);
  assert.equal(inspected.budget.native_objects.used, 1);
  assert.equal(inspected.budget.materials.used, 1);
  assert.equal(inspected.budget.materials.limit, DEFAULT_BUDGETS.materials);
  assert.equal(inspected.budget.textures.distinct, 1);
  assert.equal(inspected.budget.textures.limit, DEFAULT_BUDGETS.textures);
});

test("budget usage omits encoded texture bytes when a source has no resolved asset size", () => {
  const usage = budgetUsage({ scene_ir: { nodes: [{
    id: "unknown", type: "Texture", properties: [{ property: "source", value: "assets/unknown.png" }],
  }] } }, DEFAULT_BUDGETS);

  assert.equal(usage.textures.distinct, 1);
  assert.equal(usage.textures.encoded_bytes, undefined);
  assert.equal(usage.textures.bytes, undefined);
});

test("budget usage counts GeoAnchor and PostProcessVolume native instances", () => {
  const usage = budgetUsage({ scene_ir: { nodes: [
    { id: "anchor", type: "GeoAnchor", properties: [] },
    { id: "post", type: "PostProcessVolume", properties: [] },
    { id: "group", type: "Group", properties: [] },
  ] } }, DEFAULT_BUDGETS);

  assert.equal(usage.native_objects.used, 3);
});

test("budget usage excludes scene-owned environment slots and counts only owned lights", () => {
  const usage = budgetUsage({ scene_ir: { nodes: [
    { id: "sun", type: "DirectionalLight", properties: [{ property: "atmosphereSunLight", value: true }] },
    { id: "skyLight", type: "SkyLight", properties: [] },
    { id: "sky", type: "SkyAtmosphere", properties: [] },
    { id: "fog", type: "ExponentialHeightFog", properties: [] },
    { id: "ownedSun", type: "DirectionalLight", properties: [{ property: "atmosphereSunLight", value: false }] },
    { id: "point", type: "PointLight", properties: [] },
  ] } }, DEFAULT_BUDGETS);

  assert.equal(usage.native_objects.used, 2);
});

test("compile rejects 33 different texture contents before writing artifacts", async (t) => {
  const sources = Array.from({ length: 33 }, (_, index) => `texture-${index}.png`);
  const directory = writeBudgetProject(t, sources);

  await assert.rejects(
    () => compileProject(directory),
    (error) => {
      assert.ok(error instanceof CompileError);
      assert.equal(error.message, "budget_exceeded: textures budget exceeded: used=33, limit=32");
      assert.equal(error.diagnostic.code, "budget_exceeded");
      assert.deepEqual(error.diagnostic.problems, [{
        code: "budget_exceeded", dimension: "textures", used: 33, limit: 32,
        message: "textures budget exceeded: used=33, limit=32",
      }]);
      return true;
    },
  );
  assert.equal(existsSync(path.join(directory, "scene.generated.mjs")), false);
  assert.equal(existsSync(path.join(directory, "scene.ir.json")), false);
});

test("compile permits 33 texture paths when two files have the same content digest", async (t) => {
  const sources = Array.from({ length: 33 }, (_, index) => `texture-${index}.png`);
  const shared = Buffer.from([44, 55, 66, 77]);
  const directory = writeBudgetProject(t, sources, {
    contentsBySource: { [sources[0]]: shared, [sources.at(-1)]: shared },
  });

  const compiled = await compileProject(directory);
  assert.equal(compiled.usage.textures.used, 32);
  assert.equal(compiled.usage.textures.distinct, 32);
});

test("compile rejects material shells over the manifest limit", async (t) => {
  const directory = writeBudgetProject(t, ["one.png", "two.png"], {
    budgets: { ...DEFAULT_BUDGETS, materials: 1 },
  });

  await assert.rejects(
    () => compileProject(directory),
    (error) => {
      assert.ok(error instanceof CompileError);
      assert.equal(error.message, "budget_exceeded: materials budget exceeded: used=2, limit=1");
      assert.equal(error.diagnostic.code, "budget_exceeded");
      assert.deepEqual(error.diagnostic.problems, [{
        code: "budget_exceeded", dimension: "materials", used: 2, limit: 1,
        message: "materials budget exceeded: used=2, limit=1",
      }]);
      return true;
    },
  );
});

test("compile leaves legacy native-object overages as reporting only", async (t) => {
  const directory = writeBudgetProject(t, ["one.png"], {
    budgets: { ...DEFAULT_BUDGETS, native_objects: 0 },
  });

  const compiled = await compileProject(directory);
  assert.equal(compiled.usage.native_objects.used, 1);
  assert.equal(compiled.usage.native_objects.limit, 0);
});

test("budget defaults reject invalid values and retain zero", () => {
  const resolved = resolveBudgets({
    native_objects: 0,
    materials: -1,
    textures: 1.5,
    bindings: Number.MAX_SAFE_INTEGER + 1,
  });

  assert.equal(resolved.native_objects, 0);
  assert.equal(resolved.materials, DEFAULT_BUDGETS.materials);
  assert.equal(resolved.textures, DEFAULT_BUDGETS.textures);
  assert.equal(resolved.bindings, DEFAULT_BUDGETS.bindings);
});
