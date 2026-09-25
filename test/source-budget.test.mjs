import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// paths.mjs resolves the workspace once at import time, so the home has to move first.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-source-budget-"));
process.env.SSWORLD_HOME = home;
const { compileProject, SOURCE_LIMITS } = await import("../src/compile.mjs");
const { ASSET_LIMITS } = await import("../src/runtime-support.mjs");
const { writeSource } = await import("../src/project.mjs");
test.after(() => rmSync(home, { recursive: true, force: true }));

function writeProject(name, files) {
  const directory = path.join(home, "projects", name);
  mkdirSync(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(directory, file), content, "utf8");
  writeFileSync(path.join(directory, "scene.mjs"), "export default {};\n", "utf8");
  writeFileSync(path.join(directory, "showcase.manifest.json"), JSON.stringify({ schema_version: "SceneModuleManifest/1", name, entry: "scene.mjs" }) + "\n", "utf8");
  return directory;
}

const padded = (bytes) => `Scene {\n  id: main\n}\n//${"x".repeat(bytes - 20)}\n`;

test("the MCP server reads its source limits from the compiler instead of repeating them", () => {
  assert.deepEqual(Object.keys(SOURCE_LIMITS).sort(), ["asset_refs", "file_bytes", "files", "project_bytes"]);
  assert.equal(ASSET_LIMITS.count, SOURCE_LIMITS.asset_refs);
});

test("an oversize source file is named with its size, and the largest files are listed", async () => {
  const directory = writeProject("OversizeFile", {
    "scene.ssdl": "Scene {\n  id: main\n}\n",
    "Big.ssdl": padded(SOURCE_LIMITS.file_bytes + 1024),
    "Small.ssdl": padded(4096),
  });
  await assert.rejects(compileProject(directory), (error) => {
    assert.equal(error.diagnostic.code, "source_budget");
    assert.equal(error.diagnostic.file, "Big.ssdl");
    assert.match(error.message, /Big\.ssdl is \d+\.\d\d MiB; one source file takes at most/);
    assert.match(error.message, /Largest: Big\.ssdl .*Small\.ssdl/);
    assert.deepEqual(error.diagnostic.files.map((item) => item.file), ["Big.ssdl", "Small.ssdl", "scene.ssdl"]);
    assert.deepEqual(error.diagnostic.limits, SOURCE_LIMITS);
    return true;
  });
});

test("too many source files is a source_budget that says how many, not a schema error", async () => {
  const files = { "scene.ssdl": "Scene {\n  id: main\n}\n" };
  for (let index = 0; index < SOURCE_LIMITS.files; index++) files[`Part${index}.ssdl`] = `Group {\n  id: part${index}\n}\n`;
  const directory = writeProject("TooManyFiles", files);
  await assert.rejects(compileProject(directory), (error) => {
    assert.equal(error.diagnostic.code, "source_budget");
    assert.match(error.message, new RegExp(`${SOURCE_LIMITS.files + 1} \\.ssdl files; a project takes at most ${SOURCE_LIMITS.files}`));
    return true;
  });
});

test("the source tools refuse a file over the limit with source_budget and the limit in the message", () => {
  writeProject("WriteLimit", { "scene.ssdl": "Scene {\n  id: main\n}\n" });
  assert.throws(() => writeSource("WriteLimit", "Big.ssdl", padded(SOURCE_LIMITS.file_bytes + 1), "new"), (error) => {
    assert.equal(error.code, "source_budget");
    assert.match(error.message, new RegExp(`at most ${SOURCE_LIMITS.file_bytes / 1048576} MiB`));
    return true;
  });
});

test("importing runtime-support does not pin the ssworld home, so a test can still move it", () => {
  // Tests import runtime-support.mjs statically, which runs before they point SSWORLD_HOME at a
  // temporary directory; when it pulled in paths.mjs, their projects landed in the real ~/.ssworld.
  const src = (name) => pathToFileURL(path.join(import.meta.dirname, "..", "src", name)).href;
  const script = `await import(${JSON.stringify(src("runtime-support.mjs"))});
process.env.SSWORLD_HOME = ${JSON.stringify(home)};
const { HOME } = await import(${JSON.stringify(src("paths.mjs"))});
process.stdout.write(HOME);`;
  const env = { ...process.env };
  delete env.SSWORLD_HOME;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, path.resolve(home));
});
