// Local preview server: serves projects, the SSDL browser runtime and the engine pair with the
// COOP/COEP headers WebGPU + wasm threads need, plus the /__ssdl_dev/version hot-reload endpoint
// the project page polls. Reuses an already running instance on the same port.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { PROJECTS_ROOT, SSDL_ROOT, PREVIEW_PORT, PACKAGE, PACKAGE_ROOT } from "./paths.mjs";
import { engineStatus, ensureEngine } from "./engine.mjs";
import { compileProject, CompileError } from "./compile.mjs";

const STATUS_ROUTE = "/__ssworld/status";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".json": "application/json", ".map": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".ssdl": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream" };

const RUNTIME_FILES = {
  "ssdl-builtins.js": path.join(SSDL_ROOT, "runtime", "ssdl-builtins.js"),
  "scene-module-host.mjs": path.join(SSDL_ROOT, "runtime", "scene-module-host.mjs"),
  "scene-runtime-bridge.mjs": path.join(SSDL_ROOT, "runtime", "scene-runtime-bridge.mjs"),
  "scene-component-installer.mjs": path.join(SSDL_ROOT, "runtime", "scene-component-installer.mjs"),
  "ssdl-builtin-catalog-v1.js": path.join(SSDL_ROOT, "runtime", "ssdl-builtin-catalog-v1.js"),
  "qtloader.js": path.join(SSDL_ROOT, "engine-support", "qtloader.js"),
  "integer-codec.js": path.join(SSDL_ROOT, "engine-support", "integer-codec.js"),
  "expression-runtime.js": path.join(SSDL_ROOT, "engine-support", "expression-runtime.js"),
};

const compileFailures = new Map();

function watchToken(directory) {
  const digest = createHash("sha256");
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) { walk(absolute); continue; }
      const stat = statSync(absolute);
      digest.update(path.relative(directory, absolute)).update(String(stat.mtimeMs)).update(String(stat.size));
    }
  })(directory);
  return digest.digest("hex");
}

function sendJson(response, value, status = 200) {
  const payload = Buffer.from(JSON.stringify(value) + "\n");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length });
  response.end(payload);
}

function sendFile(response, file) {
  if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end("not found"); return; }
  response.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Content-Length": statSync(file).size });
  createReadStream(file).pipe(response);
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).some((part) => part.startsWith(".") )) return null;
  return target;
}

async function versionEndpoint(query, response) {
  const raw = query.get("path") || "";
  const match = raw.match(/^projects\/([A-Za-z][A-Za-z0-9_-]{0,63})$/);
  const directory = match ? path.join(PROJECTS_ROOT, match[1]) : null;
  if (!directory || !existsSync(path.join(directory, "scene.ssdl"))) return sendJson(response, { ok: false, error: "watch_path_missing" }, 404);
  const generated = path.join(directory, "scene.generated.mjs");
  let stamp = 0;
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) walk(absolute);
      else if (item.name.endsWith(".ssdl")) stamp = Math.max(stamp, statSync(absolute).mtimeMs);
    }
  })(directory);
  if (!existsSync(generated) || stamp > statSync(generated).mtimeMs) {
    const cached = compileFailures.get(directory);
    if (cached && cached.stamp === stamp) return sendJson(response, { ok: false, error: "compile_failed", message: cached.message }, 422);
    try {
      await compileProject(directory);
      compileFailures.delete(directory);
    } catch (error) {
      const message = error instanceof CompileError ? error.message : `SSDL compile failed: ${error.message}`;
      compileFailures.set(directory, { stamp, message });
      return sendJson(response, { ok: false, error: "compile_failed", message }, 422);
    }
  }
  sendJson(response, { ok: true, token: watchToken(directory) });
}

async function handle(request, response) {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cache-Control", "no-store");
  const url = new URL(request.url, "http://127.0.0.1");
  const route = decodeURIComponent(url.pathname);
  if (route === STATUS_ROUTE) return sendJson(response, { ok: true, service: "ssworld-preview", version: PACKAGE.version, engine: engineStatus() });
  if (route === "/__ssdl_dev/status") return sendJson(response, { ok: true, schema_version: "SSDLDevServer/1" });
  if (route === "/__ssdl_dev/version") return versionEndpoint(url.searchParams, response);
  if (route === "/" ) return sendJson(response, { ok: true, service: "ssworld-preview", hint: "open /projects/<name>/index.html" });
  if (route.startsWith("/projects/")) {
    const relative = route.slice("/projects/".length);
    const target = safeJoin(PROJECTS_ROOT, relative);
    if (!target) return sendJson(response, { ok: false, error: "forbidden" }, 403);
    // Engine-side asset lookups (fonts for Label3D) are page-relative; fall back to the package assets.
    const shared = relative.match(/^[^/]+\/(assets\/.+)$/);
    if (!existsSync(target) && shared) {
      const fallback = safeJoin(path.join(PACKAGE_ROOT, "assets"), shared[1].slice("assets/".length));
      if (fallback && existsSync(fallback)) return sendFile(response, fallback);
    }
    return sendFile(response, target);
  }
  if (route.startsWith("/runtime/")) {
    const file = RUNTIME_FILES[route.slice("/runtime/".length)];
    return file ? sendFile(response, file) : sendJson(response, { ok: false, error: "unknown runtime file" }, 404);
  }
  if (route.startsWith("/engine/")) {
    const engine = engineStatus();
    if (!engine.ready) return sendJson(response, { ok: false, error: "engine_not_installed", hint: "run: ssworld-mcp engine" }, 503);
    const target = safeJoin(engine.dir, route.slice("/engine/".length));
    return target ? sendFile(response, target) : sendJson(response, { ok: false, error: "forbidden" }, 403);
  }
  sendJson(response, { ok: false, error: "not_found" }, 404);
}

export async function previewStatus(port = PREVIEW_PORT) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${STATUS_ROUTE}`, { signal: AbortSignal.timeout(800) });
    const body = await response.json();
    return body.service === "ssworld-preview" ? body : null;
  } catch { return null; }
}

let server = null;
export async function startPreview({ port = PREVIEW_PORT, log = () => {} } = {}) {
  if (server) return { port, reused: true, in_process: true };
  const existing = await previewStatus(port);
  if (existing) return { port, reused: true, in_process: false, version: existing.version };
  await ensureEngine({ log });
  server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      log(`preview error: ${error.stack || error}`);
      if (!response.headersSent) sendJson(response, { ok: false, error: String(error.message || error) }, 500);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", (error) => { server = null; reject(new Error(`preview port ${port} unavailable (${error.code}); set SSWORLD_PREVIEW_PORT`)); });
    server.listen(port, "127.0.0.1", resolve);
  });
  server.unref();
  log(`preview listening on http://127.0.0.1:${port}`);
  return { port, reused: false, in_process: true };
}

export function projectUrl(name, port = PREVIEW_PORT) {
  return `http://127.0.0.1:${port}/projects/${name}/index.html`;
}

export async function serveForever(port = PREVIEW_PORT) {
  const started = await startPreview({ port, log: (line) => process.stderr.write(`${line}\n`) });
  if (started.reused && !started.in_process) { process.stderr.write(`preview already running on port ${port}\n`); return; }
  server.ref();
  await new Promise(() => {});
}
