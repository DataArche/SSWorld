// In-process SSDL 0.3 compilation, mirroring src/ssdl/compiler/src/compile-showcase.mjs.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SSDL_ROOT } from "./paths.mjs";
import { resolveBudgets, MAX_SCENE_DEPTH, MAX_MODEL_INSTANCES, MAX_TEXTURE_BYTES_TOTAL } from "./budgets.mjs";
import { ensureAssetCapablePage } from "./page.mjs";
import { ASSET_LIMITS, ASSET_MEDIA, ASSETS_DIR, checkRuntimeSupport, TIMELINE_LIMIT, timelineNodes } from "./runtime-support.mjs";

let compilerPromise = null;
function loadCompiler() {
  compilerPromise ??= import(pathToFileURL(path.join(SSDL_ROOT, "compiler", "src", "compiler-0.3.mjs")).href);
  return compilerPromise;
}

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Hash an asset stream so large image files never need to reside in memory as one Buffer. */
async function digestFile(file) {
  const digest = createHash("sha256");
  let size_bytes = 0;
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
    size_bytes += chunk.byteLength;
  }
  return { content_digest: `sha256:${digest.digest("hex")}`, size_bytes };
}

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
    const { kind, media_type } = ASSET_MEDIA[path.extname(file).toLowerCase()];
    const { content_digest, size_bytes } = await digestFile(file);
    return { path: relative, asset: { asset_id: relative, kind, media_type, content_digest, size_bytes, dependencies: [] } };
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

// Two kinds of dimension. The engine-owned ones are gates: exceeding them is a mount failure, so a
// compile error is the only place the author can still see why. The rest stay reporting-only -- they
// are performance guardrails, and a scene that wants 9000 boxes should get a usage ratio, not a wall.
const ENFORCED_COMPILE_BUDGET_DIMENSIONS = ["materials", "textures", "timers", "timelines", "locators"];

/**
 * Ceilings the engine publishes but that no budget dimension covers. Each one is a mount failure
 * rather than a slow frame, so the compiler is the last place the author can still be told which
 * node is at fault.
 */
function structuralProblems(result, usage) {
  const nodes = result.scene_ir?.nodes || [];
  const problems = [];

  // SceneGraphFacade.max_depth: how deeply the native graph will accept a parent chain.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depthOf = (node, seen = new Set()) => {
    let depth = 0;
    let current = node;
    while (current?.parent && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parent);
      depth += 1;
    }
    return depth;
  };
  const deepest = nodes.reduce((worst, node) => {
    const depth = depthOf(node);
    return depth > worst.depth ? { depth, node } : worst;
  }, { depth: 0, node: null });
  if (deepest.depth > MAX_SCENE_DEPTH) {
    problems.push({ code: "scene_depth_exceeded", node: deepest.node?.id, depth: deepest.depth, limit: MAX_SCENE_DEPTH,
      message: `'${deepest.node?.id}' nests ${deepest.depth} levels deep; the native scene graph takes at most ${MAX_SCENE_DEPTH} (SceneGraphFacade.max_depth). Flatten the Groups, or place the parts as siblings with absolute positions.` });
  }

  // ModelFacade.max_model_instances: how many glb mounts one scene may hold.
  const models = nodes.filter((node) => node.type === "Model").length;
  if (models > MAX_MODEL_INSTANCES) {
    problems.push({ code: "model_budget", used: models, limit: MAX_MODEL_INSTANCES,
      message: `${models} Model nodes; the engine mounts at most ${MAX_MODEL_INSTANCES} (ModelFacade.max_model_instances). Use one Model as a Prefab source and instance it instead of mounting a copy per placement.` });
  }

  // MaterialFacade.max_texture_bytes_total: the decoded images added up, not the per-file limit.
  const bytes = usage.textures?.encoded_bytes;
  if (Number.isSafeInteger(bytes) && bytes > MAX_TEXTURE_BYTES_TOTAL) {
    problems.push({ code: "texture_budget", used: bytes, limit: MAX_TEXTURE_BYTES_TOTAL,
      message: `${(bytes / 1048576).toFixed(1)} MiB of distinct images; the engine holds at most ${MAX_TEXTURE_BYTES_TOTAL / 1048576} MiB in total (MaterialFacade.max_texture_bytes_total), however small each file is.` });
  }
  return problems;
}

function enforcedBudgetProblems(usage) {
  const problems = [];
  for (const dimension of ENFORCED_COMPILE_BUDGET_DIMENSIONS) {
    const entry = usage[dimension];
    if (!entry || entry.used <= entry.limit) continue;
    const message = `${dimension} budget exceeded: used=${entry.used}, limit=${entry.limit}`;
    problems.push({ code: "budget_exceeded", dimension, used: entry.used, limit: entry.limit, message });
  }
  return problems;
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
const NATIVE_OBJECT_ADAPTERS = new Set(["geometry", "group", "model"]);
const NATIVE_OBJECT_EXISTENCE_TYPES = new Set([
  "GeoAnchor", // SceneGraphFacade.createLocator creates one native locator per declaration.
  "PostProcessVolume", // Budget charges each declaration; PostProcessFacade materializes a native post-process proxy on use.
  "Prefab", // One entity + one renderer per prefab; its instances are rows in that renderer, not objects.
]);
const OWNED_LIGHT_TYPES = new Set([
  "PointLight", "SpotLight", "RectLight", // EnvironmentFacade creates an owned LiEntity + light.
]);
let cachedBudgetNodeKinds = null;

function budgetNodeKinds() {
  if (cachedBudgetNodeKinds) return cachedBudgetNodeKinds;
  const native = new Set(["Group", "Label", "Model", ...NATIVE_OBJECT_EXISTENCE_TYPES]);
  const materials = new Set();
  try {
    const source = JSON.parse(readFileSync(path.join(SSDL_ROOT, "catalog", "builtin-catalog-v1.source.json"), "utf8"));
    for (const [type, component] of Object.entries(source.components || {})) {
      if (NATIVE_OBJECT_ADAPTERS.has(component.adapter) || type === "Label" || type.includes("Mesh")) native.add(type);
      if (component.adapter === "material" || type.endsWith("Material")) materials.add(type);
    }
  } catch {
    // The checked-in package always includes the catalog. Keep the named public categories usable for isolated callers.
  }
  cachedBudgetNodeKinds = { native, materials };
  return cachedBudgetNodeKinds;
}

function isNativeObjectNode(node) {
  const type = node?.type;
  if (typeof type !== "string") return false;
  if (NATIVE_OBJECT_EXISTENCE_TYPES.has(type) || OWNED_LIGHT_TYPES.has(type)) return true;
  // DirectionalLight adopts the scene sun when atmosphereSunLight is true; otherwise EnvironmentFacade
  // allocates an owned light entity. SkyLight, SkyAtmosphere and fog always adopt scene-owned slots.
  if (type === "DirectionalLight") return nodeProperty(node, "atmosphereSunLight") !== true;
  const { native } = budgetNodeKinds();
  return native.has(type) || type.includes("Mesh");
}

function instanceRowCount(node) {
  const positions = nodeProperty(node, "positions");
  if (Array.isArray(positions)) return positions.length;
  const count = nodeProperty(node, "count");
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function isMaterialNode(type) {
  if (typeof type !== "string") return false;
  const { materials } = budgetNodeKinds();
  return materials.has(type) || type.endsWith("Material");
}

function nodeProperty(node, property) {
  return (node.properties || []).find((item) => item.property === property)?.value;
}

function textureSourceKey(source, fallback) {
  if (typeof source === "string") return `path:${source}`;
  if (source && typeof source === "object") {
    if (typeof source.asset_id === "string") return `asset:${source.asset_id}`;
    if (typeof source.source === "string") return `path:${source.source}`;
    return `value:${JSON.stringify(stable(source))}`;
  }
  return `unresolved:${fallback}`;
}

function textureContentKey(source, fallback) {
  if (source && typeof source === "object" && typeof source.content_digest === "string" && source.content_digest.length) {
    return `digest:${source.content_digest}`;
  }
  // Isolated callers can pass unresolved IR; successful project compiles always carry an AssetRef digest.
  return textureSourceKey(source, fallback);
}

/**
 * `encoded_bytes` is the deduplicated on-disk file size, not decoded texture memory.
 * The runtime facade reports decoded memory as `shared_texture_bytes`; compile time does not estimate it.
 */
function textureBudgetUsage(nodes) {
  const sources = new Map();
  for (const node of nodes) {
    if (node.type !== "Texture") continue;
    const source = nodeProperty(node, "source");
    const key = textureContentKey(source, node.id);
    const size = source && typeof source === "object" && Number.isSafeInteger(source.size_bytes) && source.size_bytes >= 0
      ? source.size_bytes
      : null;
    const known = sources.get(key);
    if (!known) sources.set(key, { size });
    else if (known.size === null && size !== null) known.size = size;
  }
  const distinct = sources.size;
  const values = [...sources.values()];
  const encoded_bytes = distinct && values.every((entry) => entry.size !== null)
    ? values.reduce((sum, entry) => sum + entry.size, 0)
    : null;
  return { used: distinct, distinct, ...(encoded_bytes !== null ? { encoded_bytes } : {}) };
}

/** Declared budget vs what the compiled IR actually uses; absent manifest keys use project defaults. */
export function budgetUsage(result, budgets = {}) {
  const nodes = result.scene_ir?.nodes || [];
  const textures = textureBudgetUsage(nodes);
  const used = {
    native_objects: nodes.filter((node) => isNativeObjectNode(node)).length,
    materials: nodes.filter((node) => isMaterialNode(node.type)).length,
    textures: textures.used,
    bindings: (result.binding_ir?.bindings || []).length,
    handlers: nodes.reduce((sum, node) => sum + (node.handlers?.length || 0), 0),
    timers: nodes.filter((node) => TIMER_TYPES.has(node.type)).length,
    // A Group is a native locator (SceneGraphFacade.max_locators), a far smaller pool than nodes.
    locators: nodes.filter((node) => node.type === "Group").length,
    prefabs: nodes.filter((node) => node.type === "Prefab").length,
    // The cost of an Instances batch is its row count, not one node: 240 lamp posts are 240 instances
    // and 0 extra native objects. Explicit placement carries its own count in `positions`.
    instances: nodes.filter((node) => node.type === "Instances")
      .reduce((sum, node) => sum + instanceRowCount(node), 0),
    timelines: timelineNodes(result.scene_ir).length,
  };
  const resolvedBudgets = resolveBudgets(budgets);
  const out = {};
  for (const [key, value] of Object.entries(used)) {
    // timelines is a native cap (AnimationFacade max_active_timelines), not a manifest choice.
    const limit = key === "timelines" ? TIMELINE_LIMIT : resolvedBudgets[key];
    out[key] = { used: value, limit, ...(limit ? { ratio: Number((value / limit).toFixed(3)) } : {}) };
  }
  out.textures.distinct = textures.distinct;
  if (Object.hasOwn(textures, "encoded_bytes")) out.textures.encoded_bytes = textures.encoded_bytes;
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
  const effectiveBudgets = resolveBudgets(budgets ?? hybrid.budgets);
  const project = await buildSourceProject(directory);
  const overBudget = checkAssetBudget(project.asset_refs);
  if (overBudget.length) throw new CompileError(`${overBudget[0].file}:1:1: asset_budget: ${overBudget[0].message}`, { code: "asset_budget", file: overBudget[0].file, line: 1, column: 1, problems: overBudget });
  const host = await readHostInterfaces(directory);
  let result;
  try {
    result = compileSceneModuleProject(project, {
      entry: "scene.generated.mjs", mapName: "scene.generated.mjs.map",
      name: name || hybrid.name, budgets: effectiveBudgets,
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
  const usage = budgetUsage(result, effectiveBudgets);
  const budgetProblems = [...structuralProblems(result, usage), ...enforcedBudgetProblems(usage)];
  if (budgetProblems.length) {
    const first = budgetProblems[0];
    throw new CompileError(`${first.code}: ${first.message}`, {
      code: first.code, dimension: first.dimension, node: first.node, used: first.used, limit: first.limit, problems: budgetProblems,
    });
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
    budgets: effectiveBudgets,
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
    usage: { ...usage, mesh: meshUsage(result.scene_ir, MESH_GENERATORS, MESH_MAX_VERTICES), assets },
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
