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
import { ASSETS_DIR } from "./runtime-support.mjs";

const STATUS_ROUTE = "/__ssworld/status";
const SYNC_ROUTE = "/__ssworld/sync";      // page -> server: status heartbeat + command results; server -> page: pending commands
const PAGE_ROUTE = "/__ssworld/page";      // tool -> server: last known page status for a project
const COMMAND_ROUTE = "/__ssworld/command"; // tool -> server: queue a command for the page and wait for its result
const PAGE_STALE_MS = 3000;
const MAX_BODY = 32 * 1024 * 1024;

// Per-project page state, one record per syncing client: a desktop preview pane and an automation
// browser can both have the same project open, and a capture must say which of them answered.
// A page is "connected" when it synced within PAGE_STALE_MS; records are forgotten after PAGE_FORGET_MS.
const pages = new Map();     // project -> Map(clientId -> { client, seen, status })
const commands = new Map();  // `${project}\0${clientId}` -> [{ id, kind, params }]
const results = new Map();   // command id -> { result, waiters: [resolve] }
let commandSequence = 0;
const PAGE_FORGET_MS = 60000;

function clientKey(project, client) { return `${project}\0${client ?? ""}`; }

function describeClient(record) {
  const status = record.status || {};
  return {
    id: record.client, seen_ms_ago: Date.now() - record.seen, visibility: status.visibility ?? null, state: status.state ?? null,
    canvas: status.canvas ? { ...status.canvas, device_pixel_ratio: status.device_pixel_ratio ?? null } : null,
    user_agent: status.user_agent ?? null,
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

/**
 * Which page answers for a project: the requested client id, else the most recently synced VISIBLE
 * page, else the most recent one. `clients` lists every connected page so a caller can see that two
 * browsers are open; `selection` says how the answering page was chosen.
 */
export function pageStatus(project, { client = null } = {}) {
  const records = pages.get(project);
  const now = Date.now();
  if (records) for (const [id, record] of records) if (now - record.seen > PAGE_FORGET_MS) records.delete(id);
  const live = records ? [...records.values()].filter((record) => now - record.seen <= PAGE_STALE_MS).sort((a, b) => b.seen - a.seen) : [];
  const clients = live.map(describeClient);
  const visible = (record) => !record.status?.visibility || record.status.visibility === "visible";
  let chosen = null, selection = null;
  if (client !== null && client !== undefined && client !== "") {
    chosen = live.find((record) => String(record.client) === String(client)) || null;
    selection = chosen ? "requested" : "requested_client_not_connected";
  } else if (live.length) {
    chosen = live.find(visible) || live[0];
    selection = visible(chosen) ? "most_recent_visible" : "most_recent";
  }
  const requested = client !== null && client !== undefined && client !== "" ? { requested_client: String(client) } : {};
  if (!chosen) return { connected: false, seen_ms_ago: null, status: null, client: null, clients, selection, ...requested };
  return { connected: true, seen_ms_ago: now - chosen.seen, status: chosen.status, client: describeClient(chosen), clients, selection, ...requested };
}

function syncEndpoint(body, response) {
  const project = typeof body.project === "string" ? body.project : null;
  if (!project) return sendJson(response, { ok: false, error: "project_required" }, 400);
  const clientId = body.client === null || body.client === undefined ? "" : String(body.client);
  let records = pages.get(project);
  if (!records) pages.set(project, records = new Map());
  records.set(clientId, { client: clientId || null, seen: Date.now(), status: body.status || null });
  for (const item of Array.isArray(body.results) ? body.results : []) {
    const slot = results.get(item.id);
    if (!slot) continue;
    slot.result = item;
    for (const resolve of slot.waiters) resolve(item);
    slot.waiters = [];
  }
  const key = clientKey(project, clientId);
  const pending = commands.get(key) || [];
  commands.delete(key);
  sendJson(response, { ok: true, commands: pending });
}

async function commandEndpoint(body, response) {
  const project = typeof body.project === "string" ? body.project : null;
  if (!project) return sendJson(response, { ok: false, error: "project_required" }, 400);
  const timeout = Math.min(Math.max(Number(body.timeout_ms) || 15000, 1000), 120000);
  const page = pageStatus(project, { client: body.client ?? null });
  if (!page.connected) return sendJson(response, { ok: false, error: page.clients.length ? "client_not_connected" : "page_not_open", page }, 409);
  const id = `cmd-${process.pid}-${++commandSequence}`;
  const slot = { result: null, waiters: [] };
  results.set(id, slot);
  const key = clientKey(project, page.client.id);
  (commands.get(key) || commands.set(key, []).get(key)).push({ id, kind: body.kind, params: body.params || {} });
  const outcome = await new Promise((resolve) => {
    slot.waiters.push(resolve);
    setTimeout(() => resolve(null), timeout);
  });
  results.delete(id);
  if (!outcome) {
    // Never let a stale command reach the page later and be mistaken for a fresh one.
    commands.set(key, (commands.get(key) || []).filter((item) => item.id !== id));
    return sendJson(response, { ok: false, error: "page_timeout", page: pageStatus(project, { client: page.client.id }) }, 504);
  }
  sendJson(response, { ok: true, id, result: outcome, page: pageStatus(project, { client: page.client.id }) });
}

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

// Files whose change must NOT reload the page: capture PNGs (ssworld_capture_frame writes one per call, and a
// reload resets the scene logic) and page backups from template upgrades.
const WATCH_IGNORE_DIRS = new Set(["captures", "node_modules", ".git"]);
const isWatched = (name) => !/^index\.html\.bak-/.test(name) && !name.startsWith(".");

function watchToken(directory) {
  const digest = createHash("sha256");
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) { if (!WATCH_IGNORE_DIRS.has(item.name)) walk(absolute); continue; }
      if (!isWatched(item.name)) continue;
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
      else if (item.name.endsWith(".ssdl") || (current === directory && ["logic.mjs", "host_interfaces.json"].includes(item.name))
        || path.relative(directory, absolute).split(path.sep)[0] === ASSETS_DIR) stamp = Math.max(stamp, statSync(absolute).mtimeMs);
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
  if (route === SYNC_ROUTE && request.method === "POST") return syncEndpoint(await readBody(request), response);
  if (route === COMMAND_ROUTE && request.method === "POST") return commandEndpoint(await readBody(request), response);
  if (route === PAGE_ROUTE) return sendJson(response, { ok: true, project: url.searchParams.get("project"), page: pageStatus(url.searchParams.get("project") || "", { client: url.searchParams.get("client") }) });
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

/** Ask the running preview (in-process or another process on the same port) about a project's page. */
export async function fetchPageStatus(project, { port = PREVIEW_PORT, client = null } = {}) {
  if (server) return pageStatus(project, { client });
  try {
    const query = new URLSearchParams({ project, ...(client ? { client: String(client) } : {}) });
    const response = await fetch(`http://127.0.0.1:${port}${PAGE_ROUTE}?${query}`, { signal: AbortSignal.timeout(1500) });
    return (await response.json()).page;
  } catch { return { connected: false, seen_ms_ago: null, status: null, client: null, clients: [], selection: null, preview_unreachable: true }; }
}

/** Queue a command for the project's open page (a specific client, or the page pageStatus selects) and wait for its result. */
export async function pageCommand(project, kind, params = {}, { port = PREVIEW_PORT, timeoutMs = 15000, client = null } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${COMMAND_ROUTE}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, kind, params, timeout_ms: timeoutMs, ...(client ? { client: String(client) } : {}) }),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });
  return response.json();
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
