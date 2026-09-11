// In-process SSDL 0.3 compilation, mirroring src/ssdl/compiler/src/compile-showcase.mjs.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SSDL_ROOT } from "./paths.mjs";
import { ensureAssetCapablePage } from "./page.mjs";
import { ASSET_LIMITS, ASSET_MEDIA, ASSETS_DIR, checkRuntimeSupport, TIMELINE_LIMIT, timelineNodes } from "./runtime-support.mjs";

let compilerPromise = null;
function loadCompiler() {
  compilerPromise ??= import(pathToFileURL(path.join(SSDL_ROOT, "compiler", "src", "compiler-0.3.mjs")).href);
  return compilerPromise;
}

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;

async function discover(directory, out = []) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) await discover(absolute, out);
    else if (item.isFile() && item.name.endsWith(".ssdl")) out.push(absolute);
  }
  return out;
}

// Managed assets live under <project>/assets/ and are referenced by their project-relative path
// (`Model { source: "assets/tree.glb" }`, `Texture { source: "assets/bark.png" }`). The compiler embeds
// the AssetRef (digest + size) into SceneIR; the preview page fetches the bytes by that path and verifies them.
export async function discoverAssets(directory) {
  const root = path.join(directory, ASSETS_DIR);
  if (!existsSync(root)) return [];
  const files = [];
  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) await walk(absolute);
      else if (item.isFile() && Object.hasOwn(ASSET_MEDIA, path.extname(item.name).toLowerCase())) files.push(absolute);
    }
  }
  await walk(root);
  const refs = await Promise.all(files.map(async (file) => {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    const bytes = await readFile(file);
    const { kind, media_type } = ASSET_MEDIA[path.extname(file).toLowerCase()];
    return { path: relative, asset: { asset_id: relative, kind, media_type, content_digest: hash(bytes), size_bytes: bytes.byteLength, dependencies: [] } };
  }));
  refs.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return refs;
}

/** Compile-time asset budget: the runtime would reject an oversize AssetRef only at mount. */
export function checkAssetBudget(refs) {
  const problems = [];
  for (const { path: file, asset } of refs) {
    const limit = ASSET_LIMITS[asset.kind];
    if (asset.size_bytes > limit) problems.push({ code: "asset_budget", file, message: `${file} is ${(asset.size_bytes / 1048576).toFixed(1)} MiB; a ${asset.kind} asset is at most ${limit / 1048576} MiB (the page would fail at mount)` });
  }
  if (refs.length > ASSET_LIMITS.count) problems.push({ code: "asset_budget", file: refs[ASSET_LIMITS.count].path, message: `${refs.length} assets under ${ASSETS_DIR}/; a project takes at most ${ASSET_LIMITS.count}` });
  return problems;
}

export function assetUsage(refs, sceneIR) {
  const referenced = new Set();
  for (const node of sceneIR?.nodes || []) for (const item of node.properties || []) {
    if (item.value && typeof item.value === "object" && typeof item.value.asset_id === "string") referenced.add(item.value.asset_id);
  }
  return {
    count: refs.length, limit: ASSET_LIMITS.count,
    bytes: refs.reduce((sum, item) => sum + item.asset.size_bytes, 0),
    files: refs.map((item) => ({ path: item.path, kind: item.asset.kind, size_bytes: item.asset.size_bytes, referenced: referenced.has(item.asset.asset_id) })),
    limits: { model_bytes: ASSET_LIMITS.model, texture_bytes: ASSET_LIMITS.texture },
    note: `assets are discovered under ${ASSETS_DIR}/ (glb, png, jpg) and referenced by project-relative path`,
  };
}

export class CompileError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.diagnostic = diagnostic;
  }
}

export async function buildSourceProject(directory, entry = "scene.ssdl") {
  const sources = await discover(directory);
  const files = await Promise.all(sources.map(async (file) => ({
    path: path.relative(directory, file).split(path.sep).join("/"),
    content: await readFile(file, "utf8"),
  })));
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const assetRefs = await discoverAssets(directory);
  const project = { schema_version: "SSDLSourceProject/1", language: "SSDL/QML-Subset/0.3", entry, files, asset_refs: assetRefs, source_digest: "" };
  project.source_digest = hash(JSON.stringify(stable({
    version: 1, language: project.language, entry, asset_refs: assetRefs,
    files: files.map((file) => ({ path: file.path, content_digest: hash(file.content), size_bytes: Buffer.byteLength(file.content) })),
  })));
  return project;
}

const TIMER_TYPES = new Set(["Timer"]);
/** Declared budget vs what the compiled IR actually uses; limits come from showcase.manifest.json. */
export function budgetUsage(result, budgets = {}) {
  const nodes = result.scene_ir?.nodes || [];
  const used = {
    native_objects: nodes.length,
    bindings: (result.binding_ir?.bindings || []).length,
    handlers: nodes.reduce((sum, node) => sum + (node.handlers?.length || 0), 0),
    timers: nodes.filter((node) => TIMER_TYPES.has(node.type)).length,
    timelines: timelineNodes(result.scene_ir).length,
  };
  const out = {};
  for (const [key, value] of Object.entries(used)) {
    // timelines is a native cap (AnimationFacade max_active_timelines), not a manifest choice.
    const limit = key === "timelines" ? TIMELINE_LIMIT : Number.isFinite(budgets?.[key]) ? budgets[key] : null;
    out[key] = { used: value, limit, ...(limit ? { ratio: Number((value / limit).toFixed(3)) } : {}) };
  }
  const types = {};
  for (const node of nodes) types[node.type] = (types[node.type] || 0) + 1;
  out.node_types = types;
  return out;
}

/** Compile `directory/scene.ssdl` (+ siblings) into the same directory and refresh showcase.manifest.json. */
export async function compileProject(directory, { name, budgets } = {}) {
  const { compileSceneModuleProject, MESH_GENERATORS, MESH_MAX_VERTICES } = await loadCompiler();
  const manifestPath = path.join(directory, "showcase.manifest.json");
  const hybrid = JSON.parse(await readFile(manifestPath, "utf8"));
  const project = await buildSourceProject(directory);
  const overBudget = checkAssetBudget(project.asset_refs);
  if (overBudget.length) throw new CompileError(`${overBudget[0].file}:1:1: asset_budget: ${overBudget[0].message}`, { code: "asset_budget", file: overBudget[0].file, line: 1, column: 1, problems: overBudget });
  const host = await readHostInterfaces(directory);
  let result;
  try {
    result = compileSceneModuleProject(project, {
      entry: "scene.generated.mjs", mapName: "scene.generated.mjs.map",
      name: name || hybrid.name, budgets: budgets || hybrid.budgets,
      hostInterfaces: host.contract,
    });
  } catch (error) {
    const diagnostic = error?.diagnostic || (error?.code === "host_interfaces_invalid" ? { file: HOST_INTERFACES_FILE, line: 1, column: 1 } : {});
    const location = diagnostic.file ? `${diagnostic.file}:${diagnostic.line || 1}:${diagnostic.column || 1}: ` : "";
    const code = error?.code ? `${error.code}: ` : "";
    throw new CompileError(`${location}${code}${error?.message || String(error)}`, { ...diagnostic, code: error?.code });
  }
  const unsupported = checkRuntimeSupport(result.scene_ir);
  if (unsupported.length) {
    const first = unsupported[0];
    throw new CompileError(`${first.code}: ${first.message}`, { code: first.code, node: first.node, property: first.property, problems: unsupported });
  }
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "scene.generated.mjs"), result.emitted.module, "utf8"),
    writeFile(path.join(directory, "scene.generated.mjs.map"), result.emitted.source_map, "utf8"),
    writeFile(path.join(directory, "showcase.generated.manifest.json"), result.emitted.manifest, "utf8"),
    writeFile(path.join(directory, "scene.ir.json"), JSON.stringify(result.scene_ir, null, 2) + "\n", "utf8"),
    writeFile(path.join(directory, "binding.ir.json"), JSON.stringify(result.binding_ir, null, 2) + "\n", "utf8"),
  ]);
  const generated = JSON.parse(result.emitted.manifest);
  Object.assign(hybrid, {
    compiler_profile: generated.compiler_profile, compiler_profile_digest: generated.compiler_profile_digest,
    catalog_digest: generated.catalog_digest, runtime_abi_digest: generated.runtime_abi_digest,
    scene_ir_digest: generated.scene_ir_digest, binding_ir_digest: generated.binding_ir_digest,
    source_digest: project.source_digest, compiled_at: new Date().toISOString(),
    host_interfaces_digest: host.digest,
  });
  hybrid.module_digest = hash(await readFile(path.join(directory, hybrid.entry)));
  await writeFile(manifestPath, JSON.stringify(hybrid, null, 2) + "\n", "utf8");
  const assets = assetUsage(project.asset_refs, result.scene_ir);
  const page = ensureAssetCapablePage(directory, { name: name || hybrid.name, anchor: hybrid.anchor || { lon: 114.0579, lat: 22.5431, height: 150 }, usesAssets: assets.files.some((file) => file.referenced) });
  return {
    ok: true,
    ...(page ? { page } : {}),
    scene_ir_digest: hybrid.scene_ir_digest, binding_ir_digest: hybrid.binding_ir_digest,
    catalog_digest: hybrid.catalog_digest, compiler_profile: hybrid.compiler_profile,
    source_digest: project.source_digest, source_files: project.files.map((file) => file.path),
    node_count: Array.isArray(result.scene_ir?.nodes) ? result.scene_ir.nodes.length : undefined,
    usage: { ...budgetUsage(result, budgets || hybrid.budgets), mesh: meshUsage(result.scene_ir, MESH_GENERATORS, MESH_MAX_VERTICES), assets },
    logic: logicSummary(result.scene_ir),
  };
}

/** Generated-mesh cost of the parametric geometry nodes (primitives and models are not tessellated here). */
export function meshUsage(sceneIR, generators = {}, limit = 65535) {
  const nodes = [];
  for (const node of sceneIR?.nodes || []) {
    if (!Object.hasOwn(generators, node.type)) continue;
    const props = Object.fromEntries((node.properties || []).map((item) => [item.property, item.value]));
    try { nodes.push({ id: node.id, type: node.type, ...generators[node.type](props) }); } catch { /* the compiler already rejected it */ }
  }
  return { nodes, vertices: nodes.reduce((sum, item) => sum + item.vertices, 0), triangles: nodes.reduce((sum, item) => sum + item.triangles, 0),
    vertex_limit_per_node: limit, note: "counts the meshes generated from HeightField/Lathe/Tube/Loft parameters; Box/Sphere/... and Model triangles are not estimated" };
}

export const HOST_INTERFACES_FILE = "host_interfaces.json";

/** Optional host_interfaces.json next to scene.ssdl: the contract SSDL `Iface.method(...)` actions are checked against. */
export async function readHostInterfaces(directory) {
  const file = path.join(directory, HOST_INTERFACES_FILE);
  if (!existsSync(file)) return { contract: null, digest: null };
  const raw = await readFile(file, "utf8");
  try {
    return { contract: JSON.parse(raw), digest: hash(raw) };
  } catch (error) {
    throw new CompileError(`${HOST_INTERFACES_FILE}:1:1: host_interfaces_invalid: ${error.message}`, { code: "host_interfaces_invalid", file: HOST_INTERFACES_FILE, line: 1, column: 1 });
  }
}

/** What the compiled scene exposes to host JS and the capture receipt: declared properties, states, host calls. */
export function logicSummary(sceneIR) {
  const nodes = sceneIR?.nodes || [];
  const calls = [];
  for (const node of nodes) for (const handler of node.handlers || []) for (const action of handler.actions || []) {
    if (action.kind === "call") calls.push({ node: node.id, signal: handler.signal, call: `${action.interface}.${action.method}` });
  }
  return {
    properties: (sceneIR?.logical_properties || []).map((item) => ({ name: item.property, value_type: item.value_type, unit: item.unit, initial: item.value })),
    states: nodes.filter((node) => node.type === "State").map((node) => node.id),
    host_interfaces: sceneIR?.host_interfaces ? Object.fromEntries(Object.entries(sceneIR.host_interfaces).map(([name, iface]) => [name, Object.keys(iface.methods)])) : null,
    host_calls: calls,
  };
}
