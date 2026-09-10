// In-process SSDL 0.3 compilation, mirroring src/ssdl/compiler/src/compile-showcase.mjs.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SSDL_ROOT } from "./paths.mjs";
import { checkRuntimeSupport } from "./runtime-support.mjs";

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
  const project = { schema_version: "SSDLSourceProject/1", language: "SSDL/QML-Subset/0.3", entry, files, asset_refs: [], source_digest: "" };
  project.source_digest = hash(JSON.stringify(stable({
    version: 1, language: project.language, entry, asset_refs: [],
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
  };
  const out = {};
  for (const [key, value] of Object.entries(used)) {
    const limit = Number.isFinite(budgets?.[key]) ? budgets[key] : null;
    out[key] = { used: value, limit, ...(limit ? { ratio: Number((value / limit).toFixed(3)) } : {}) };
  }
  const types = {};
  for (const node of nodes) types[node.type] = (types[node.type] || 0) + 1;
  out.node_types = types;
  return out;
}

/** Compile `directory/scene.ssdl` (+ siblings) into the same directory and refresh showcase.manifest.json. */
export async function compileProject(directory, { name, budgets } = {}) {
  const { compileSceneModuleProject } = await loadCompiler();
  const manifestPath = path.join(directory, "showcase.manifest.json");
  const hybrid = JSON.parse(await readFile(manifestPath, "utf8"));
  const project = await buildSourceProject(directory);
  let result;
  try {
    result = compileSceneModuleProject(project, {
      entry: "scene.generated.mjs", mapName: "scene.generated.mjs.map",
      name: name || hybrid.name, budgets: budgets || hybrid.budgets,
    });
  } catch (error) {
    const diagnostic = error?.diagnostic || {};
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
  });
  hybrid.module_digest = hash(await readFile(path.join(directory, hybrid.entry)));
  await writeFile(manifestPath, JSON.stringify(hybrid, null, 2) + "\n", "utf8");
  return {
    ok: true,
    scene_ir_digest: hybrid.scene_ir_digest, binding_ir_digest: hybrid.binding_ir_digest,
    catalog_digest: hybrid.catalog_digest, compiler_profile: hybrid.compiler_profile,
    source_digest: project.source_digest, source_files: project.files.map((file) => file.path),
    node_count: Array.isArray(result.scene_ir?.nodes) ? result.scene_ir.nodes.length : undefined,
    usage: budgetUsage(result, budgets || hybrid.budgets),
  };
}
