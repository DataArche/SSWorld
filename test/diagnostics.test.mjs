import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileProject } from "../src/compile.mjs";

const SCENE_HEAD = "Scene {\n  id: main\n  property real timeOfDay: 12\n";
const LAMP = (visible) => `Group {\n  id: root\n  property real tod: 12\n  Box { id: bulb; width: 1; depth: 1; height: 1; visible: ${visible} }\n}\n`;

function project(t, files) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ssworld-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(directory, file), content, "utf8");
  writeFileSync(path.join(directory, "scene.mjs"), "export default {};\n", "utf8");
  writeFileSync(path.join(directory, "showcase.manifest.json"), JSON.stringify({ schema_version: "SceneModuleManifest/1", name: "Diagnostics", entry: "scene.mjs" }) + "\n", "utf8");
  return directory;
}

async function compileError(t, files) {
  const directory = project(t, files);
  try {
    await compileProject(directory);
  } catch (error) {
    return error;
  }
  assert.fail("the compile was expected to fail");
}

const bindings = (directory) => JSON.parse(readFileSync(path.join(directory, "binding.ir.json"), "utf8")).bindings;

test("root.<declared property> inside a component reads the same live value as the bare name", async (t) => {
  const viaRoot = project(t, { "scene.ssdl": `${SCENE_HEAD}  Lamp { id: lamp; tod: main.timeOfDay }\n}\n`, "Lamp.ssdl": LAMP("root.tod > 18") });
  const bare = project(t, { "scene.ssdl": `${SCENE_HEAD}  Lamp { id: lamp; tod: main.timeOfDay }\n}\n`, "Lamp.ssdl": LAMP("tod > 18") });
  await compileProject(viaRoot);
  await compileProject(bare);
  const [binding] = bindings(viaRoot);
  assert.deepEqual(binding.dependencies, [{ node: "main", property: "timeOfDay" }]);
  assert.deepEqual(bindings(viaRoot).map(({ expression, dependencies, target }) => ({ expression, dependencies, target })),
    bindings(bare).map(({ expression, dependencies, target }) => ({ expression, dependencies, target })));
});

test("a component may read a scene property directly and stays bound to it", async (t) => {
  const directory = project(t, { "scene.ssdl": `${SCENE_HEAD}  Lamp { id: lamp }\n}\n`, "Lamp.ssdl": LAMP("main.timeOfDay > 18") });
  await compileProject(directory);
  assert.deepEqual(bindings(directory)[0].dependencies, [{ node: "main", property: "timeOfDay" }]);
});

test("a scene property initialised from an expression says to write the expression where it is used", async (t) => {
  const error = await compileError(t, { "scene.ssdl": "Scene {\n  id: main\n  property real timeOfDay: 12\n  property bool night: main.timeOfDay > 18\n}\n" });
  assert.equal(error.diagnostic.code, "constant_required");
  assert.match(error.message, /^scene\.ssdl:4:\d+: constant_required: property 'night' must start from a constant, not an expression: write the expression where the value is used/);
});

test("reading a component's inner node from outside names the instance it lives in", async (t) => {
  const error = await compileError(t, {
    "scene.ssdl": `${SCENE_HEAD}  Lamp { id: lamp }\n  Box { id: b; width: 1; depth: 1; height: 1; visible: bulb.visible }\n}\n`,
    "Lamp.ssdl": LAMP("true"),
  });
  assert.equal(error.diagnostic.code, "unknown_reference");
  assert.match(error.message, /'bulb' is a node inside the component instance 'lamp'.*cannot be read from outside it/);
});

test("reading a component's declared property through the instance id says it is a parameter", async (t) => {
  const error = await compileError(t, {
    "scene.ssdl": `${SCENE_HEAD}  Lamp { id: lamp; tod: 20 }\n  Box { id: b; width: 1; depth: 1; height: 1; visible: lamp.tod > 18 }\n}\n`,
    "Lamp.ssdl": LAMP("tod > 18"),
  });
  assert.match(error.message, /'lamp' is an instance of Lamp\.ssdl, and the properties a component declares are parameters/);
});

test("misspelt references and members come with the closest real name", async (t) => {
  const member = await compileError(t, { "scene.ssdl": `${SCENE_HEAD}  Box { id: a; width: 1; depth: 1; height: 1 }\n  Box { id: b; width: 1; depth: 1; height: a.hieght }\n}\n` });
  assert.match(member.message, /Box 'a' has no readable member 'hieght'; did you mean 'height'\?/);
  const declared = await compileError(t, { "scene.ssdl": `${SCENE_HEAD}  Box { id: b; width: 1; depth: 1; height: 1; visible: main.timeOfDy > 18 }\n}\n` });
  assert.match(declared.message, /did you mean 'timeOfDay'\?/);
  const property = await compileError(t, { "scene.ssdl": `${SCENE_HEAD}  Box { id: b; widht: 3; depth: 1; height: 1 }\n}\n` });
  assert.equal(property.diagnostic.code, "unknown_property");
  assert.match(property.message, /Box has no member 'widht'; did you mean 'width'\?/);
  const unrelated = await compileError(t, { "scene.ssdl": `${SCENE_HEAD}  Box { id: b; flavour: 3; width: 1; depth: 1; height: 1 }\n}\n` });
  assert.doesNotMatch(unrelated.message, /did you mean/);
});

test("x/y/z on a node points at position", async (t) => {
  const error = await compileError(t, { "scene.ssdl": `${SCENE_HEAD}  Box { id: b; x: 3; width: 1; depth: 1; height: 1 }\n}\n` });
  assert.match(error.message, /Box has no member 'x'; place a node with position: \[x, y, z\]/);
});

test("an expression in a create-only list says the list is fixed at creation", async (t) => {
  const error = await compileError(t, { "scene.ssdl": `${SCENE_HEAD}  Mesh { id: m; vertices: [0, 0, 0, 1, 0, main.timeOfDay, 0, 1, 0]; faces: [0, 1, 2] }\n}\n` });
  assert.equal(error.diagnostic.code, "constant_required");
  assert.match(error.message, /Mesh\.vertices is fixed when the node is created/);
});
