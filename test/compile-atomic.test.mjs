import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMPILE_LOCK, compileProject } from "../src/compile.mjs";

const COMPILE_MODULE = fileURLToPath(new URL("../src/compile.mjs", import.meta.url));

// Enough nodes that writing the module takes long enough for two writers to overlap.
function writeProject(t, boxes = 400) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ssworld-atomic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const nodes = Array.from({ length: boxes }, (_, index) =>
    `  Box { id: box${index}; position: [${index % 20}, ${Math.floor(index / 20)}, 0.5]; width: 0.5; depth: 0.5; height: ${1 + (index % 7) / 4} }`);
  writeFileSync(path.join(directory, "scene.ssdl"), `Scene {\n  id: main\n${nodes.join("\n")}\n}\n`, "utf8");
  writeFileSync(path.join(directory, "scene.mjs"), "export default {};\n", "utf8");
  writeFileSync(path.join(directory, "showcase.manifest.json"), JSON.stringify({
    schema_version: "SceneModuleManifest/1", name: "AtomicProject", entry: "scene.mjs",
  }, null, 2) + "\n", "utf8");
  return directory;
}

function lockOwner(overrides = {}) {
  return JSON.stringify({ pid: process.pid, platform: process.platform, host: os.hostname(), since: Date.now(), ...overrides });
}

function leftovers(directory) {
  return readdirSync(directory).filter((name) => name.endsWith(".tmp") || name === COMPILE_LOCK);
}

function assertModuleParses(directory) {
  const checked = spawnSync(process.execPath, ["--check", path.join(directory, "scene.generated.mjs")], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
}

function compileInChild(directory) {
  const script = `import { compileProject } from ${JSON.stringify(pathToFileURL(COMPILE_MODULE).href)};
const result = await compileProject(${JSON.stringify(directory)});
process.stdout.write(JSON.stringify({ ok: result.ok }));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`child compile exited ${code}: ${stderr}`))));
  });
}

test("concurrent compiles in one process run one at a time and leave one whole module", async (t) => {
  const directory = writeProject(t);
  const results = await Promise.all([compileProject(directory), compileProject(directory), compileProject(directory)]);
  assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
  assertModuleParses(directory);
  assert.deepEqual(leftovers(directory), []);
});

test("a compile in another process and one in this process both finish and leave one whole module", async (t) => {
  const directory = writeProject(t);
  const reference = await compileProject(directory);
  const expected = readFileSync(path.join(directory, "scene.generated.mjs"), "utf8");
  rmSync(path.join(directory, "scene.generated.mjs"));
  const [child, local] = await Promise.all([compileInChild(directory), compileProject(directory)]);
  assert.equal(child.ok, true);
  assert.equal(local.ok, true);
  assert.equal(reference.scene_ir_digest, local.scene_ir_digest);
  assert.equal(readFileSync(path.join(directory, "scene.generated.mjs"), "utf8"), expected);
  assertModuleParses(directory);
  assert.deepEqual(leftovers(directory), []);
});

test("a page reading the module while it is rewritten sees the old or the new one, never a partial file", async (t) => {
  const directory = writeProject(t, 6000);
  await compileProject(directory);
  const modulePath = path.join(directory, "scene.generated.mjs");
  const before = readFileSync(modulePath, "utf8");
  const beforeId = statSync(modulePath, { bigint: true }).ino;
  writeFileSync(path.join(directory, "scene.ssdl"), "Scene {\n  id: main\n  Box { id: only; width: 1; depth: 1; height: 1 }\n}\n", "utf8");
  // The reader samples the size in a tight loop: an in-place rewrite truncates the file and grows it
  // again, so it shows sizes that are neither the old module's nor the new one's. A stat holds the
  // file only for an instant, which leaves Windows room to rename over it (a reader that keeps the
  // file open blocks the rename for as long as it reads).
  let done = false;
  const sizes = new Set();
  const reader = (async () => {
    while (!done) {
      try { sizes.add(statSync(modulePath).size); } catch (error) { if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) sizes.add(error.code); }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  try {
    await compileProject(directory);
  } finally {
    done = true;
    await reader;
  }
  const after = readFileSync(modulePath, "utf8");
  assert.notEqual(after, before);
  // Deterministic half: a rename puts a NEW file at the path; rewriting in place keeps the old one.
  assert.notEqual(statSync(modulePath, { bigint: true }).ino, beforeId, "the module was rewritten in place");
  const expected = new Set([Buffer.byteLength(before), Buffer.byteLength(after)]);
  assert.deepEqual([...sizes].filter((size) => !expected.has(size)), []);
});

test("a compile waits for a lock held by a live compile and proceeds once it is released", async (t) => {
  const directory = writeProject(t, 4);
  const lock = path.join(directory, COMPILE_LOCK);
  writeFileSync(lock, lockOwner());
  const started = Date.now();
  setTimeout(() => rmSync(lock, { force: true }), 300);
  const result = await compileProject(directory);
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started >= 280, "the compile did not wait for the lock");
  assert.deepEqual(leftovers(directory), []);
});

test("a compile that cannot get the lock says compile_busy and leaves the other owner's lock alone", async (t) => {
  const directory = writeProject(t, 4);
  const lock = path.join(directory, COMPILE_LOCK);
  const owner = lockOwner();
  writeFileSync(lock, owner);
  await assert.rejects(compileProject(directory, { lockWaitMs: 200 }), (error) => error.diagnostic?.code === "compile_busy");
  assert.equal(readFileSync(lock, "utf8"), owner);
  assert.equal(existsSync(path.join(directory, "scene.generated.mjs")), false);
});

test("a lock left by a dead compile is taken over, by pid on this host and by age elsewhere", async (t) => {
  const exited = spawnSync(process.execPath, ["-e", ""]);
  for (const owner of [lockOwner({ pid: exited.pid }), lockOwner({ platform: "elsewhere", since: Date.now() - 10 * 60 * 1000 })]) {
    const directory = writeProject(t, 4);
    writeFileSync(path.join(directory, COMPILE_LOCK), owner);
    const result = await compileProject(directory, { lockWaitMs: 2000 });
    assert.equal(result.ok, true);
    assert.deepEqual(leftovers(directory), []);
  }
});

test("a compile queued behind one that already produced the module is skipped when it is no longer stale", async (t) => {
  const directory = writeProject(t, 4);
  await compileProject(directory);
  const generated = path.join(directory, "scene.generated.mjs");
  const before = statSync(generated).mtimeMs;
  const result = await compileProject(directory, { isStale: () => false });
  assert.deepEqual(result, { ok: true, skipped: "up_to_date" });
  assert.equal(statSync(generated).mtimeMs, before);
});

test("the compiler runs off the event loop, so the preview server keeps answering during a compile", async (t) => {
  const directory = writeProject(t, 3000);
  let last = performance.now();
  let gap = 0;
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 10);
  const result = await compileProject(directory);
  clearInterval(timer);
  assert.equal(result.ok, true);
  assert.ok(gap < 100, `the event loop stalled for ${Math.round(gap)} ms during the compile`);
});

test("a compile error from the worker keeps its code and source location", async (t) => {
  const directory = writeProject(t, 1);
  writeFileSync(path.join(directory, "scene.ssdl"), "Scene {\n  id: main\n  Box { id: b; nonsense: 1 }\n}\n", "utf8");
  await assert.rejects(compileProject(directory), (error) => {
    assert.equal(error.diagnostic.code, "unknown_property");
    assert.equal(error.diagnostic.file, "scene.ssdl");
    assert.equal(error.diagnostic.line, 3);
    assert.match(error.message, /^scene\.ssdl:3:\d+: unknown_property/);
    return true;
  });
});
