import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "ssworld-mcp.mjs");
const RELEASE = path.join(ROOT, ".release");

// The download runs while this process serves the assets, so the child must not block the event loop.
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("engine download verifies the pinned pair", { skip: !existsSync(path.join(RELEASE, "SSmap.wasm")) && "no .release assets" }, async (t) => {
  const lock = JSON.parse(readFileSync(path.join(ROOT, "engine.lock.json"), "utf8"));
  const tampered = mkdtempSync(path.join(os.tmpdir(), "ssworld-release-"));
  writeFileSync(path.join(tampered, "SSmap.js"), readFileSync(path.join(RELEASE, "SSmap.js")));
  const server = http.createServer((request, response) => {
    const name = path.basename(request.url.split("?")[0]);
    const dir = request.url.startsWith("/bad/") ? tampered : RELEASE;
    const file = path.join(dir, name);
    if (!existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Length": statSync(file).size });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-engine-"));
  const base = { ...process.env, SSWORLD_HOME: home };
  delete base.SSWORLD_ENGINE_DIR;
  const missing = spawnSync(process.execPath, [BIN, "doctor"], { env: base, encoding: "utf8" });
  assert.equal(JSON.parse(missing.stdout).engine.ready, false);

  const good = await run(["engine"], { ...base, SSWORLD_ENGINE_BASE: `http://127.0.0.1:${port}/good/` });
  assert.equal(good.status, 0, good.stderr);
  const status = JSON.parse(good.stdout);
  assert.equal(status.ready, true);
  assert.equal(status.source, "cache");
  assert.equal(status.verified, true);
  assert.equal(status.dir, path.join(home, "engine", lock.engine_id));
  for (const asset of lock.assets) assert.equal(statSync(path.join(status.dir, asset.name)).size, asset.size);

  // A wrong wasm must be rejected and must not poison the cache.
  const home2 = mkdtempSync(path.join(os.tmpdir(), "ssworld-engine-"));
  writeFileSync(path.join(tampered, "SSmap.wasm"), Buffer.alloc(lock.assets.find((a) => a.name === "SSmap.wasm").size, 1));
  const bad = await run(["engine"], { ...base, SSWORLD_HOME: home2, SSWORLD_ENGINE_BASE: `http://127.0.0.1:${port}/bad/` });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /sha256 mismatch/);
  assert.equal(existsSync(path.join(home2, "engine", lock.engine_id, "SSmap.wasm")), false);
});
