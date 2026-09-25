// In-process SSDL 0.3 compilation, mirroring src/ssdl/compiler/src/compile-showcase.mjs.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { SSDL_ROOT } from "./paths.mjs";
import { resolveBudgets, MAX_SCENE_DEPTH, MAX_MODEL_INSTANCES, MAX_TEXTURE_BYTES_TOTAL } from "./budgets.mjs";
import { ensureAssetCapablePage } from "./page.mjs";
import { ASSET_LIMITS, ASSET_MEDIA, ASSETS_DIR, checkRuntimeSupport, GEO_LAYER_BUDGETS, TIMELINE_LIMIT, timelineNodes } from "./runtime-support.mjs";

let compilerPromise = null;
const COMPILER_PATH = path.join(SSDL_ROOT, "compiler", "src", "compiler-0.3.mjs");
function loadCompiler() {
  compilerPromise ??= import(pathToFileURL(COMPILER_PATH).href);
  return compilerPromise;
}

// A worker inherits the parent's node flags, and the eval ones (a server started with `node -e` or
// --input-type) make a worker refuse to start at all. Only then is execArgv passed: an explicit list
// is validated flag by flag, and process-wide flags that the default inheritance filters out quietly
// (as under node --test) would be refused.
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
function workerExecArgv() {
  const isEval = (flag) => EVAL_FLAGS.has(flag) || flag.startsWith("--input-type") || flag.startsWith("--eval=") || flag.startsWith("--print=");
  if (!process.execArgv.some(isEval)) return undefined;
  const kept = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const flag = process.execArgv[index];
    if (EVAL_FLAGS.has(flag)) { index++; continue; }
    if (flag.startsWith("--input-type") || flag.startsWith("--eval=") || flag.startsWith("--print=")) continue;
    kept.push(flag);
  }
  return kept;
}

/** compileSceneModuleProject in a worker thread (compile-worker.mjs), with the compiler's own error shape. */
function compileInWorker(project, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./compile-worker.mjs", import.meta.url), {
      workerData: { compilerPath: COMPILER_PATH, project, options }, execArgv: workerExecArgv(),
    });
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    worker.once("message", (message) => {
      if (message.ok) settle(resolve, message.result);
      else settle(reject, Object.assign(new Error(message.error.message), { code: message.error.code, diagnostic: message.error.diagnostic }));
    });
    // An out-of-memory compile ends here (ERR_WORKER_OUT_OF_MEMORY) instead of taking the server down.
    worker.once("error", (error) => settle(reject, error));
    worker.once("exit", (code) => settle(reject, new Error(`the compiler worker exited with code ${code} before answering`)));
  });
}

// Instance rows are counted with the compiler's own placement resolver, so the receipt cannot
// disagree with the runtime.  It is loaded here rather than lazily because budgetUsage() is
// synchronous and is also reached from inspect(), which never compiles anything.
const { checkInstances, SOURCE_LIMITS } = await loadCompiler();
export { SOURCE_LIMITS };

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
    limits: { model_bytes: ASSET_LIMITS.model, texture_bytes: ASSET_LIMITS.texture, geojson_bytes: ASSET_LIMITS.geojson },
    note: `assets are discovered under ${ASSETS_DIR}/ (glb, png, jpg, geojson) and referenced by project-relative path`,
  };
}

// GeoJSON geometry families, by the SSDL `geometry` member that draws them. A layer whose document
// holds none of its own kind renders nothing at all and reports no error, so the mismatch is caught
// here -- the compiler cannot do it, because only this layer has a filesystem.
const GEOJSON_FAMILIES = Object.freeze({
  polygon: ["Polygon", "MultiPolygon"],
  line: ["LineString", "MultiLineString"],
  point: ["Point", "MultiPoint"],
});

function geometryTypes(node, out = new Set(), depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return out;
  if (node.type === "FeatureCollection") for (const feature of node.features || []) geometryTypes(feature, out, depth + 1);
  else if (node.type === "Feature") geometryTypes(node.geometry, out, depth + 1);
  else if (node.type === "GeometryCollection") for (const geometry of node.geometries || []) geometryTypes(geometry, out, depth + 1);
  else if (typeof node.type === "string") out.add(node.type);
  return out;
}

function featureCount(document) {
  if (document?.type === "FeatureCollection") return Array.isArray(document.features) ? document.features.length : 0;
  return document?.type ? 1 : 0;
}

/** Parse and type-check every managed GeoJSON document the compiled scene references. */
export async function checkGeoJsonAssets(directory, sceneIR) {
  const problems = [];
  const layers = [];
  for (const node of sceneIR?.nodes || []) {
    if (node.type !== "GeoJsonLayer") continue;
    const properties = new Map((node.properties || []).map((item) => [item.property, item.value]));
    const asset = properties.get("source");
    const geometry = properties.get("geometry");
    if (!asset || typeof asset !== "object" || typeof asset.asset_id !== "string") {
      layers.push({ node: node.id, geometry, source: properties.get("url") ?? null, kind: "url" });
      continue;
    }
    let document;
    try { document = JSON.parse(await readFile(path.join(directory, asset.asset_id), "utf8")); }
    catch (error) {
      problems.push({ code: "geojson_invalid", node: node.id, file: asset.asset_id,
        message: `GeoJsonLayer '${node.id}': ${asset.asset_id} is not valid JSON (${error.message}); the engine would build an empty layer and report nothing` });
      continue;
    }
    const found = [...geometryTypes(document)];
    const wanted = GEOJSON_FAMILIES[geometry] || [];
    if (!found.some((type) => wanted.includes(type))) {
      problems.push({ code: "geojson_geometry_mismatch", node: node.id, file: asset.asset_id,
        message: `GeoJsonLayer '${node.id}': geometry: "${geometry}" draws ${wanted.join(" / ")}, but ${asset.asset_id} holds ${found.length ? found.join(" / ") : "no geometry at all"}; the layer would render nothing. Change geometry, or point at a document of that kind` });
      continue;
    }
    layers.push({ node: node.id, geometry, source: asset.asset_id, kind: "asset",
      feature_count: featureCount(document), geometry_types: found.sort() });
  }
  return { problems, layers };
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
/** ParticleEmitter defaults that the runtime materialises; the compiler needs the same three numbers. */
const PARTICLE_DEFAULT_MAX = 500;
const PARTICLE_DEFAULT_RATE = 20;
const PARTICLE_DEFAULT_LIFETIME_MAX = 2;

function particleProperty(node, name) {
  return (node.properties || []).find((entry) => entry.property === name)?.value;
}

/** ParticleEmitter.maxParticles, with the runtime's own default when the author left it out. */
function particleCeiling(node) {
  const value = particleProperty(node, "maxParticles");
  return Number.isFinite(value) && value > 0 ? Math.round(value) : PARTICLE_DEFAULT_MAX;
}

// PostProcessVolume members in the SDK facade's "eyeAdaptation" group (ssdl_postprocess_bindings.cpp):
// writing any one of them switches eye adaptation on.
const EYE_ADAPTATION_MEMBERS = ["autoExposureMethod", "autoExposureBias", "autoExposureMinBrightness", "autoExposureMaxBrightness",
  "autoExposureSpeedUp", "autoExposureSpeedDown", "lowPercent", "highPercent", "histogramLogMin", "histogramLogMax"];

function structuralProblems(result, usage) {
  const nodes = result.scene_ir?.nodes || [];
  const problems = [];

  // The engine runs at a FIXED exposure; an exposure member does not tune it, it switches eye
  // adaptation on. The frame then re-exposes from scene brightness (about +6 stops at the defaults)
  // and keeps adapting, so a night brightens until its lamps blow out.
  for (const node of nodes.filter((entry) => entry.type === "PostProcessVolume")) {
    const written = EYE_ADAPTATION_MEMBERS.filter((name) => (node.properties || []).some((item) => item.property === `settings.${name}`));
    if (!written.length) continue;
    problems.push({ code: "eye_adaptation_on", severity: "warning", node: node.id, members: written,
      message: `PostProcessVolume '${node.id}' writes settings.${written.join(", settings.")}, which switches eye adaptation on: exposure then follows scene brightness (about +6 stops brighter at the defaults) and a night scene keeps brightening until its lamps blow out. Without these the exposure is fixed; brighten or darken the scene with light intensities instead. If adaptation is what you want, equal autoExposureMinBrightness and autoExposureMaxBrightness pin it at one level` });
  }

  // At night the moon is the only light, and its default intensity (0.2) reads as black: the DaxiongHall
  // night was black until moonIntensity was written. The light does not follow the phase -- the renderer
  // hands moonIntensity to the moon light as is (skyatmosphererendercommon.cpp); the phase shapes the disk.
  for (const node of nodes.filter((entry) => entry.type === "Environment")) {
    const props = new Map((node.properties || []).map((item) => [item.property, item.value]));
    if (props.has("moonIntensity") || props.get("moonEnabled") === false) continue;
    const clockBound = (result.binding_ir?.bindings || []).some((binding) => binding.target?.node === node.id && ["dateTime", "timeScale"].includes(binding.target?.property));
    const timeScale = props.get("timeScale");
    if (!clockBound && !(typeof timeScale === "number" && timeScale > 0)) continue;
    problems.push({ code: "night_without_moonlight", severity: "warning", node: node.id,
      message: `Environment '${node.id}': the clock can reach night, where the moon is the only light, and moonIntensity is not written; its default (0.2) makes the night read as black. For a readable night write moonIntensity (4 gave a moonlit blue night)` });
  }

  // The trap this names: rate x lifetime.max past maxParticles clips the effect, and it looks
  // exactly like "rate is not taking effect" rather than like a budget.
  for (const node of nodes.filter((entry) => entry.type === "ParticleEmitter")) {
    const rate = particleProperty(node, "rate") ?? PARTICLE_DEFAULT_RATE;
    const lifetime = particleProperty(node, "lifetime");
    const lifetimeMax = Number.isFinite(lifetime?.y) ? lifetime.y : PARTICLE_DEFAULT_LIFETIME_MAX;
    const ceiling = particleCeiling(node);
    const steady = Math.ceil(rate * lifetimeMax);
    if (steady > ceiling) {
      problems.push({ code: "particle_budget", severity: "warning", node: node.id,
        used: steady, limit: ceiling,
        message: `'${node.id}' spawns ${rate}/s for up to ${lifetimeMax}s, which needs ${steady} live particles but maxParticles is ${ceiling}; the emitter will clip and look like rate is being ignored. Raise maxParticles or lower rate/lifetime.` });
    }
    const shape = particleProperty(node, "shape");
    const shapeSize = particleProperty(node, "shapeSize");
    if (shape === "cone" && !(Number.isFinite(shapeSize?.x) && shapeSize.x > 0)) {
      problems.push({ code: "particle_shape_invalid", node: node.id,
        message: `'${node.id}' uses shape: "cone" but has no shapeSize[0]; the cone needs a base radius in metres.` });
    }
    // Soft particles reach the engine -- the member parses, the uniform arrives and the soft shader
    // variant is selected -- but on the 2026-09-19 build the depth fade produces no visible change
    // on real hardware.  Refusing it is the honest answer: a member that is accepted and does
    // nothing is exactly the kind of silence this project spends its afternoons chasing.
    const softness = particleProperty(node, "softness");
    if (Number.isFinite(softness) && softness > 0) {
      problems.push({ code: "particle_softness_unavailable", node: node.id,
        message: `'${node.id}' sets softness: ${softness}, but soft particles do not work on this engine build (the depth fade has no visible effect; verified on real hardware 2026-09-19). Use softness: 0 and keep the effect away from surfaces it would visibly cut into.` });
    }
  }

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
  const props = Object.fromEntries((node.properties || []).map((item) => [item.property, item.value]));
  // `count` is absent from every along_path batch spaced by `step`, and from ring / grid only when
  // the author wrote something the compiler already refused.  Reading the property alone reported 0
  // rows for a batch the runtime then filled with instances, which is exactly the receipt-versus-
  // runtime disagreement authors kept hitting.  checkInstances is the same resolver the compiler and
  // the runtime use, so the three numbers are one number.
  try { return checkInstances(props).count; } catch { /* invalid batch: fall back to what is written */ }
  const positions = props.positions;
  if (Array.isArray(positions)) return positions.length;
  const count = props.count;
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
    // A ParticleEmitter costs its maxParticles ceiling, not one node: the simulation ticks every
    // live particle every frame whether or not the author ever reaches the cap.
    particles: nodes.filter((node) => node.type === "ParticleEmitter")
      .reduce((sum, node) => sum + particleCeiling(node), 0),
  };
  // Reported alongside the manifest dimensions, but the ceiling itself is the compiler's (geo_budget):
  // each layer carries its own tile cache, so these are memory walls rather than manifest choices.
  const geo = Object.fromEntries(Object.entries(GEO_LAYER_BUDGETS).map(([type, limit]) => {
    const count = nodes.filter((node) => node.type === type).length;
    return [type === "Globe" ? "globe" : type === "ImageryLayer" ? "imagery_layers" : type === "Tileset" ? "tilesets" : "geojson_layers",
      { used: count, limit, ratio: Number((count / limit).toFixed(3)) }];
  }));
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
  if (Object.values(geo).some((entry) => entry.used > 0)) out.geo = geo;
  return out;
}

// Two processes compile the same project: the preview server recompiles when the page polls, and the
// MCP server compiles on ssworld_compile.  Writing the outputs in place let the two interleave and
// leave the tail of the old module behind the new one, so the compile answered ok and the page died
// on "Unexpected token".  Every output is now written to a dot-file (the watcher ignores those) and
// renamed over, and a project compiles under a lock file that both processes take.
export const COMPILE_LOCK = ".ssworld-compile.lock";
const LOCK_WAIT_MS = 180000;
// Only for a lock whose owner cannot be checked (another host, or WSL beside Windows): a compile of
// the largest project allowed takes well under this.
const LOCK_STALE_MS = 300000;
// ~7.6 s of backoff in all: a rename over a file some reader holds open (the preview server streaming
// the module to a browser) keeps failing until that reader lets go.
const RENAME_RETRIES = 12;
const TRANSIENT_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
const compileQueues = new Map();

async function writeAtomic(file, data) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temporary, data, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(temporary, file);
    } catch (error) {
      // Windows refuses to rename over a file that a scanner or an editor holds open, briefly.
      if (attempt >= RENAME_RETRIES || !TRANSIENT_RENAME.has(error.code)) {
        await rm(temporary, { force: true });
        throw error;
      }
      await sleep(Math.min(25 * 2 ** attempt, 1000));
    }
  }
}

async function lockIsStale(file) {
  let owner = null;
  let since;
  try {
    const raw = await readFile(file, "utf8");
    try { owner = JSON.parse(raw); } catch { /* still being written, or foreign: judge by age */ }
    since = Number.isFinite(owner?.since) ? owner.since : (await stat(file)).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (owner && owner.platform === process.platform && owner.host === os.hostname() && Number.isSafeInteger(owner.pid)) {
    if (owner.pid === process.pid) return false;
    try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  }
  return Date.now() - since > LOCK_STALE_MS;
}

async function withCompileLock(directory, waitMs, body) {
  const file = path.join(directory, COMPILE_LOCK);
  const owner = JSON.stringify({ pid: process.pid, platform: process.platform, host: os.hostname(), since: Date.now() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(file, owner, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    // Two waiters can both judge the same dead lock stale and the second then removes the first's
    // fresh one; the readback check after writing still catches the collision that could follow.
    if (await lockIsStale(file)) { await rm(file, { force: true }); continue; }
    if (Date.now() >= deadline) {
      throw new CompileError(`compile_busy: another compile of this project has held ${COMPILE_LOCK} for over ${Math.round(waitMs / 1000)} s; if no compile is running, delete that file and compile again`, { code: "compile_busy", file: COMPILE_LOCK });
    }
    await sleep(100);
  }
  try {
    return await body();
  } finally {
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === owner) await rm(file, { force: true });
  }
}

/**
 * Compile `directory/scene.ssdl` (+ siblings) into the same directory and refresh showcase.manifest.json.
 * Compiles of one project run one at a time, in this process and across processes. `isStale`, when
 * given, is asked again once the lock is held: a caller that queued behind another compile of the
 * same sources gets `{ ok: true, skipped: "up_to_date" }` instead of a second identical compile.
 */
export function compileProject(directory, { lockWaitMs = LOCK_WAIT_MS, isStale, ...options } = {}) {
  const resolved = path.resolve(directory);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const run = (compileQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => withCompileLock(resolved, lockWaitMs, () => {
    if (isStale && !isStale()) return { ok: true, skipped: "up_to_date" };
    return compileUnlocked(resolved, options);
  }));
  compileQueues.set(key, run);
  run.finally(() => { if (compileQueues.get(key) === run) compileQueues.delete(key); }).catch(() => {});
  return run;
}

async function compileUnlocked(directory, { name, budgets } = {}) {
  const { MESH_GENERATORS, MESH_MAX_VERTICES } = await loadCompiler();
  const manifestPath = path.join(directory, "showcase.manifest.json");
  const hybrid = JSON.parse(await readFile(manifestPath, "utf8"));
  const effectiveBudgets = resolveBudgets(budgets ?? hybrid.budgets);
  const project = await buildSourceProject(directory);
  const overBudget = checkAssetBudget(project.asset_refs);
  if (overBudget.length) throw new CompileError(`${overBudget[0].file}:1:1: asset_budget: ${overBudget[0].message}`, { code: "asset_budget", file: overBudget[0].file, line: 1, column: 1, problems: overBudget });
  const host = await readHostInterfaces(directory);
  let result;
  try {
    result = await compileInWorker(project, {
      entry: "scene.generated.mjs", mapName: "scene.generated.mjs.map",
      name: name || hybrid.name, budgets: effectiveBudgets,
      hostInterfaces: host.contract,
    });
  } catch (error) {
    const diagnostic = error?.diagnostic || (error?.code === "host_interfaces_invalid" ? { file: HOST_INTERFACES_FILE, line: 1, column: 1 } : {});
    const location = diagnostic.file ? `${diagnostic.file}:${diagnostic.line || 1}:${diagnostic.column || 1}: ` : "";
    const code = error?.code ? `${error.code}: ` : "";
    if (error?.code === "source_budget") {
      // Which files to split or slim is the whole question, and the compiler names only the one that tipped it over.
      const sizes = project.files.map((file) => ({ file: file.path, bytes: Buffer.byteLength(file.content) })).sort((a, b) => b.bytes - a.bytes);
      const total = sizes.reduce((sum, item) => sum + item.bytes, 0);
      const largest = sizes.slice(0, 5).map((item) => `${item.file} ${(item.bytes / 1048576).toFixed(2)} MiB`).join(", ");
      throw new CompileError(`${location}${code}${error.message}. Largest: ${largest}; ${sizes.length} files, ${(total / 1048576).toFixed(2)} MiB in all. Repeated geometry costs ~40 characters per copy as a Prefab + Instances instead of one node per copy`,
        { ...diagnostic, code: error.code, limits: SOURCE_LIMITS, files: sizes, total_bytes: total });
    }
    throw new CompileError(`${location}${code}${error?.message || String(error)}`, { ...diagnostic, code: error?.code });
  }
  // Some runtime findings are advice, not refusals: the scene still mounts and renders, just not as written
  // (a fog value the Environment overrides, a second directional light that re-tints the sun).
  const runtimeFindings = checkRuntimeSupport(result.scene_ir);
  const unsupported = runtimeFindings.filter((problem) => problem.severity !== "warning");
  if (unsupported.length) {
    const first = unsupported[0];
    throw new CompileError(`${first.code}: ${first.message}`, { code: first.code, node: first.node, property: first.property, problems: unsupported });
  }
  const geojson = await checkGeoJsonAssets(directory, result.scene_ir);
  if (geojson.problems.length) {
    const first = geojson.problems[0];
    throw new CompileError(`${first.file}:1:1: ${first.code}: ${first.message}`,
      { code: first.code, file: first.file, line: 1, column: 1, node: first.node, problems: geojson.problems });
  }
  const usage = budgetUsage(result, effectiveBudgets);
  const allProblems = [...structuralProblems(result, usage), ...enforcedBudgetProblems(usage)];
  // A warning is reported, never fatal: a clipped particle emitter still mounts and still renders.
  const budgetProblems = allProblems.filter((problem) => problem.severity !== "warning");
  const budgetWarnings = [...runtimeFindings, ...allProblems].filter((problem) => problem.severity === "warning");
  if (budgetProblems.length) {
    const first = budgetProblems[0];
    throw new CompileError(`${first.code}: ${first.message}`, {
      code: first.code, dimension: first.dimension, node: first.node, used: first.used, limit: first.limit, problems: budgetProblems,
    });
  }
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeAtomic(path.join(directory, "scene.generated.mjs.map"), result.emitted.source_map),
    writeAtomic(path.join(directory, "showcase.generated.manifest.json"), result.emitted.manifest),
    // Compact: every reader parses these, and indented they were ~4x the source on disk.
    writeAtomic(path.join(directory, "scene.ir.json"), JSON.stringify(result.scene_ir) + "\n"),
    writeAtomic(path.join(directory, "binding.ir.json"), JSON.stringify(result.binding_ir) + "\n"),
  ]);
  // The module goes last, so a page reloaded by its change finds the rest already in place.
  const modulePath = path.join(directory, "scene.generated.mjs");
  await writeAtomic(modulePath, result.emitted.module);
  // A writer that does not take the lock (an ssworld-mcp from before it existed, still serving a
  // preview port) can still land in between; say so rather than answer ok over a foreign module.
  if (await readFile(modulePath, "utf8") !== result.emitted.module) {
    throw new CompileError(`generated_write_conflict: scene.generated.mjs changed while this compile was writing it; another process compiled the same project (an older ssworld-mcp on a preview port does not take ${COMPILE_LOCK}). Compile again once it is done`, { code: "generated_write_conflict", file: "scene.generated.mjs" });
  }
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
  await writeAtomic(manifestPath, JSON.stringify(hybrid, null, 2) + "\n");
  const assets = assetUsage(project.asset_refs, result.scene_ir);
  const page = ensureAssetCapablePage(directory, { name: name || hybrid.name, anchor: hybrid.anchor || { lon: 114.0579, lat: 22.5431, height: 150 }, usesAssets: assets.files.some((file) => file.referenced) });
  return {
    ok: true,
    ...(page ? { page } : {}),
    scene_ir_digest: hybrid.scene_ir_digest, binding_ir_digest: hybrid.binding_ir_digest,
    catalog_digest: hybrid.catalog_digest, compiler_profile: hybrid.compiler_profile,
    source_digest: project.source_digest, source_files: project.files.map((file) => file.path),
    node_count: Array.isArray(result.scene_ir?.nodes) ? result.scene_ir.nodes.length : undefined,
    // Components marked `pragma spawnable`: compiled, priced, and installed only when host JS asks
    // for one. They are NOT in node_count or usage -- nothing mounts them.
    ...(generated.fragments ? { spawnable: Object.entries(generated.fragments).map(([name, item]) => ({
      name, source_file: item.source_file, parameters: item.parameters, cost_per_copy: item.budget })) } : {}),
    usage: { ...usage, mesh: meshUsage(result.scene_ir, MESH_GENERATORS, MESH_MAX_VERTICES), assets,
      ...(geojson.layers.length ? { geojson: geojson.layers } : {}) },
    ...(budgetWarnings.length ? { warnings: budgetWarnings } : {}),
    logic: logicSummary(result.scene_ir),
  };
}

/** Generated-mesh cost of the parametric geometry nodes (primitives and models are not tessellated here). */
export function meshUsage(sceneIR, generators = {}, limit = 65535) {
  const nodes = [];
  for (const node of sceneIR?.nodes || []) {
    if (!Object.hasOwn(generators, node.type)) continue;
    const props = Object.fromEntries((node.properties || []).map((item) => [item.property, item.value]));
    try {
      const estimate = generators[node.type](props);
      if (estimate) nodes.push({ id: node.id, type: node.type, ...estimate });
    } catch { /* the compiler already rejected it */ }
  }
  return { nodes, vertices: nodes.reduce((sum, item) => sum + item.vertices, 0), triangles: nodes.reduce((sum, item) => sum + item.triangles, 0),
    vertex_limit_per_node: limit, note: "counts the meshes generated from HeightField/Lathe/Tube/Loft/Sweep/Torus/Mesh/Roof/Stairs parameters and from ExtrudedPolygon on its bevel/taper/axis lane; Box/Sphere/Capsule/... and Model triangles are not estimated" };
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
