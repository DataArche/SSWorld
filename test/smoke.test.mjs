import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ssworld-mcp.mjs");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const HOME = mkdtempSync(path.join(os.tmpdir(), "ssworld-test-"));

class Client {
  constructor() {
    this.child = spawn(process.execPath, [BIN], { env: { ...process.env, SSWORLD_HOME: HOME, SSWORLD_PREVIEW_PORT: String(PORT) }, stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.pending = new Map();
    this.nextId = 1;
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      const resolve = this.pending.get(message.id);
      this.pending.delete(message.id);
      resolve?.(message);
    });
  }
  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async call(name, args = {}) {
    const response = await this.request("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    const body = JSON.parse(response.result.content[0].text);
    return { isError: response.result.isError === true, body };
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}

test("ssworld-mcp end to end over stdio", async (t) => {
  const client = new Client();
  t.after(() => client.close());

  const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.serverInfo.name, "ssworld");
  assert.match(init.result.instructions, /SSDL/);

  const list = await client.request("tools/list", {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["ssworld_catalog", "ssworld_project_list", "ssworld_project_create", "ssworld_source_read",
    "ssworld_source_write", "ssworld_compile", "ssworld_preview", "ssworld_capture_frame", "ssworld_engine_status"]);
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, "object", tool.name);

  const catalog = await client.call("ssworld_catalog");
  assert.equal(catalog.isError, false);
  assert.ok(catalog.body.components.Box?.supported, "Box must be a supported component");
  assert.match(catalog.body.conventions.quaternion_order, /\[x, y, z, w\]/);
  const sun = await client.call("ssworld_catalog", { component: "DirectionalLight" });
  assert.match(sun.body.contract.members.lightSourceAngle.runtime_writable, /atmosphereSunLight/);
  const view = await client.call("ssworld_catalog", { component: "CameraView" });
  for (const member of ["position", "lookAt", "fov", "nearPlane", "farPlane"]) assert.ok(view.body.contract.members[member], `CameraView.${member}`);
  const box = await client.call("ssworld_catalog", { component: "Box" });
  assert.ok(box.body.contract.properties || box.body.contract, "component contract");
  const unknown = await client.call("ssworld_catalog", { component: "Nope" });
  assert.equal(unknown.isError, true);

  const created = await client.call("ssworld_project_create", { name: "demo", longitude: 116.39, latitude: 39.9, height: 50 });
  assert.equal(created.isError, false, JSON.stringify(created.body));
  assert.match(created.body.scene_ir_digest, /^sha256:/);
  assert.deepEqual(created.body.anchor, { lon: 116.39, lat: 39.9, height: 50 });
  const expected = process.env.SSWORLD_EXPECTED_PROFILE_DIGEST;
  if (expected) {
    const manifest = JSON.parse(readFileSync(path.join(HOME, "projects", "demo", "showcase.manifest.json"), "utf8"));
    assert.equal(manifest.compiler_profile_digest, expected, "compiler closure must reproduce the repository profile digest");
  }
  const html = readFileSync(path.join(HOME, "projects", "demo", "index.html"), "utf8");
  assert.match(html, /path: "projects\/demo"/);
  assert.match(html, /lon: 116\.39, lat: 39\.9, height: 50/);
  assert.doesNotMatch(html, /__[A-Z_]+__/);

  const duplicate = await client.call("ssworld_project_create", { name: "demo" });
  assert.equal(duplicate.isError, true);

  const listed = await client.call("ssworld_project_list");
  assert.equal(listed.body.projects.length, 1);
  assert.equal(listed.body.projects[0].compiled, true);

  const read = await client.call("ssworld_source_read", { project: "demo" });
  assert.match(read.body.content, /Scene \{/);
  assert.deepEqual(read.body.files, ["scene.ssdl"]);

  const stale = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: "x", expected_digest: "bad" });
  assert.equal(stale.isError, true);
  const broken = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: "Scene { id: main\n Box { width: }\n}", expected_digest: read.body.digest });
  assert.equal(broken.isError, false);
  const failed = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(failed.isError, true);
  assert.equal(failed.body.error, "compile_failed");
  assert.match(failed.body.message, /scene\.ssdl:\d+:\d+/);

  // Accepted by the compiler, rejected by the engine: the adopted atmosphere sun has no lightSourceAngle.
  const sunScene = "Scene { id: main\n DirectionalLight { id: sun; atmosphereSunLight: true; lightSourceAngle: 2 }\n}";
  const sunWrite = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: sunScene, expected_digest: broken.body.digest });
  assert.equal(sunWrite.isError, false);
  const sunCompile = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(sunCompile.isError, true);
  assert.equal(sunCompile.body.diagnostic.code, "runtime_unsupported");
  assert.match(sunCompile.body.message, /lightSourceAngle cannot be written when atmosphereSunLight is true/);
  assert.equal(sunCompile.body.diagnostic.node, "sun");
  const restore = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: read.body.content, expected_digest: sunWrite.body.digest });
  assert.equal(restore.isError, false);

  const good = read.body.content.replace("width: 24", "width: 40");
  const rewritten = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: good, expected_digest: restore.body.digest });
  assert.equal(rewritten.isError, false);
  const compiled = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(compiled.isError, false, JSON.stringify(compiled.body));
  assert.notEqual(compiled.body.scene_ir_digest, created.body.scene_ir_digest);
  const ir = JSON.parse(readFileSync(path.join(HOME, "projects", "demo", "scene.ir.json"), "utf8"));
  const startView = ir.nodes.find((node) => node.type === "CameraView");
  assert.ok(startView, "template declares a local-frame CameraView");
  assert.deepEqual(startView.properties.find((item) => item.property === "lookAt").value, { x: 0, y: 0, z: 12 });

  const engine = await client.call("ssworld_engine_status");
  if (!engine.body.ready) { t.diagnostic("engine pair not available; preview checks skipped (set SSWORLD_ENGINE_DIR)"); return; }

  const preview = await client.call("ssworld_preview", { project: "demo" });
  assert.equal(preview.isError, false, JSON.stringify(preview.body) + client.stderr);
  assert.equal(preview.body.viewer_url, `http://127.0.0.1:${PORT}/projects/demo/index.html`);
  assert.equal(preview.body.render_verified, false);
  assert.equal(preview.body.page.connected, false);

  // No page open yet: the capture tool must say so instead of hanging.
  const notOpen = await client.call("ssworld_capture_frame", { project: "demo" });
  assert.equal(notOpen.isError, true);
  assert.equal(notOpen.body.error, "page_not_open");
  assert.equal(notOpen.body.viewer_url, preview.body.viewer_url);

  // A fake page: heartbeat through /__ssworld/sync, answer the capture command with a 2x2 PNG.
  const syncUrl = `http://127.0.0.1:${PORT}/__ssworld/sync`;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P4z8DwHwyBFJDxHwzhTAAB1Qv/N+qaVAAAAABJRU5ErkJggg==";
  const status = { state: "ready", generation: "1", errors: [], hint: "ok" };
  const sync = (results = []) => fetch(syncUrl, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "demo", client: "fake", status, results }) }).then((r) => r.json());
  assert.deepEqual((await sync()).commands, []);
  const pageSeen = await client.call("ssworld_preview", { project: "demo" });
  assert.equal(pageSeen.body.page.connected, true);
  const pump = setInterval(async () => {
    const { commands } = await sync();
    for (const command of commands) {
      assert.equal(command.kind, "capture");
      assert.equal(command.params.width, 640);
      await sync([{ id: command.id, ok: true, png_base64: png,
        stats: { width: 2, height: 2, distinct_colors: 4, non_black_ratio: 1, overexposed_ratio: 0, mean_luma: 90 },
        camera: { heading: 0 }, status }]);
    }
  }, 100);
  t.after(() => clearInterval(pump));
  const captureResponse = await client.request("tools/call", { name: "ssworld_capture_frame", arguments: { project: "demo", width: 640 } });
  clearInterval(pump);
  assert.equal(captureResponse.result.isError, undefined, JSON.stringify(captureResponse.result));
  const captureBody = JSON.parse(captureResponse.result.content[0].text);
  assert.equal(captureBody.ok, true);
  assert.equal(captureBody.render_verified, false, "a 4-colour frame counts as blank");
  assert.match(captureBody.verdict, /blank/);
  assert.equal(captureBody.stats.distinct_colors, 4);
  assert.ok(captureBody.capture_path.endsWith(".png"));
  assert.equal(readFileSync(captureBody.capture_path).subarray(1, 4).toString(), "PNG");
  const image = captureResponse.result.content.find((item) => item.type === "image");
  assert.equal(image?.mimeType, "image/png");
  assert.equal(image?.data, png);

  // A page that stopped syncing (tab closed) is reported as not open again after the heartbeat goes stale.
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const closed = await client.call("ssworld_capture_frame", { project: "demo" });
  assert.equal(closed.isError, true);
  assert.equal(closed.body.error, "page_not_open");

  const page = await fetch(preview.body.viewer_url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.match(await page.text(), /\/engine\/SSmap\.js/);
  for (const route of ["/engine/SSmap.js", "/runtime/ssdl-builtins.js", "/runtime/scene-runtime-bridge.mjs", "/runtime/qtloader.js",
    "/runtime/ssdl-builtin-catalog-v1.js", "/projects/demo/scene.generated.mjs", "/projects/demo/showcase.manifest.json"]) {
    const response = await fetch(`http://127.0.0.1:${PORT}${route}`);
    assert.equal(response.status, 200, route);
    await response.arrayBuffer();
  }
  const wasm = await fetch(`http://127.0.0.1:${PORT}/engine/SSmap.wasm`, { method: "GET", headers: { Range: "bytes=0-3" } });
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  wasm.body?.cancel();

  const version = await fetch(`http://127.0.0.1:${PORT}/__ssdl_dev/version?path=projects/demo`).then((r) => r.json());
  assert.equal(version.ok, true);
  assert.match(version.token, /^[0-9a-f]{64}$/);
  const escape = await fetch(`http://127.0.0.1:${PORT}/projects/../package.json`);
  assert.notEqual(escape.status, 200);
  const missing = await fetch(`http://127.0.0.1:${PORT}/__ssdl_dev/version?path=projects/nope`);
  assert.equal(missing.status, 404);
});
