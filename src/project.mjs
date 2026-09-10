// Project workspace under $SSWORLD_HOME/projects/<name>: create, list, read, write, compile.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT, TEMPLATE_ROOT } from "./paths.mjs";
import { compileProject, buildSourceProject, CompileError, HOST_INTERFACES_FILE } from "./compile.mjs";
import { locateNode, editNodeInText } from "./diagnose.mjs";

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const DEFAULT_BUDGETS = { native_objects: 2048, bindings: 256, handlers: 128, timers: 32 };
export const DEFAULT_ANCHOR = { lon: 114.0579, lat: 22.5431, height: 150 };

export function projectDir(name, { mustExist = true } = {}) {
  if (!NAME_RE.test(name)) throw new Error("project name must start with a letter and contain only letters, digits, '_' or '-'");
  const directory = path.join(PROJECTS_ROOT, name);
  if (mustExist && !(existsSync(path.join(directory, "scene.ssdl")) && existsSync(path.join(directory, "showcase.manifest.json")))) {
    throw new Error(`project '${name}' not found; call ssworld_project_create first`);
  }
  return directory;
}

export function sourcePath(directory, file) {
  const target = path.resolve(directory, file);
  const relative = path.relative(directory, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("file must stay inside the project");
  if (!isSourceFile(relative)) throw new Error(`only .ssdl files, ${HOST_LOGIC_FILE} and ${HOST_INTERFACES_FILE} are readable/writable through this tool`);
  return target;
}

/** Host logic (page-owned JavaScript) and its contract live next to scene.ssdl and are editable like sources. */
export const HOST_LOGIC_FILE = "logic.mjs";
export const isSourceFile = (relative) => relative.endsWith(".ssdl") || relative === HOST_LOGIC_FILE || relative === HOST_INTERFACES_FILE;

const digestOf = (data) => createHash("sha256").update(data).digest("hex");

export function listProjects() {
  if (!existsSync(PROJECTS_ROOT)) return [];
  return readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(path.join(PROJECTS_ROOT, item.name, "scene.ssdl")))
    .map((item) => {
      const directory = path.join(PROJECTS_ROOT, item.name);
      let manifest = {};
      try { manifest = JSON.parse(readFileSync(path.join(directory, "showcase.manifest.json"), "utf8")); } catch {}
      return { project: item.name, directory, scene_ir_digest: manifest.scene_ir_digest || null,
        compiled: existsSync(path.join(directory, "scene.generated.mjs")),
        modified: new Date(statSync(path.join(directory, "scene.ssdl")).mtimeMs).toISOString() };
    });
}

function render(template, values) {
  return template.replace(/__([A-Z_]+)__/g, (match, key) => (key in values ? values[key] : match));
}

const EMPTY_SCENE = `Scene {
  id: main
  // Local metres around the anchor (x east, y north, z up). Add nodes here.
  CameraView { id: startView; position: [60, -80, 40]; lookAt: [0, 0, 0]; fov: 50 }
  Camera { id: mainCamera; initialView: startView }
}
`;

export async function createProject(name, { anchor = DEFAULT_ANCHOR, title, template = "starter" } = {}) {
  if (!["starter", "empty"].includes(template)) throw new Error(`unknown template '${template}'; use 'starter' or 'empty'`);
  const directory = projectDir(name, { mustExist: false });
  if (existsSync(directory)) throw new Error(`project '${name}' already exists; pick another name or edit it with ssworld_source_write`);
  mkdirSync(directory, { recursive: true });
  const values = {
    NAME: name, NAME_JSON: JSON.stringify(name), TITLE: title || name,
    ANCHOR_LON: String(anchor.lon), ANCHOR_LAT: String(anchor.lat), ANCHOR_HEIGHT: String(anchor.height),
    WATCH_PATH: `projects/${name}`,
  };
  for (const file of readdirSync(TEMPLATE_ROOT)) {
    const raw = readFileSync(path.join(TEMPLATE_ROOT, file), "utf8");
    writeFileSync(path.join(directory, file), file === "style.css" ? raw : render(raw, values), "utf8");
  }
  if (template === "empty") writeFileSync(path.join(directory, "scene.ssdl"), EMPTY_SCENE, "utf8");
  const manifestPath = path.join(directory, "showcase.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.name = name;
  manifest.budgets = DEFAULT_BUDGETS;
  manifest.anchor = anchor;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const compiled = await compileProject(directory, { name, budgets: DEFAULT_BUDGETS });
  return { project: name, directory, anchor, template, ...compiled };
}

function listSourceFiles(directory) {
  const files = [];
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) walk(absolute);
      else {
        const relative = path.relative(directory, absolute).split(path.sep).join("/");
        if (isSourceFile(relative)) files.push(relative);
      }
    }
  })(directory);
  return files.sort();
}

function fileMeta(directory, file) {
  const data = readFileSync(path.join(directory, file));
  const text = data.toString("utf8");
  return { file, digest: digestOf(data), bytes: data.length, lines: text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0 };
}

function readManifest(directory) {
  try { return JSON.parse(readFileSync(path.join(directory, "showcase.manifest.json"), "utf8")); } catch { return {}; }
}

/** Compile-state summary shared by metadata reads, inspect and the capture receipt. */
export async function sourceState(directory) {
  const manifest = readManifest(directory);
  const project = await buildSourceProject(directory);
  const compiled = existsSync(path.join(directory, "scene.generated.mjs"));
  const hostFile = path.join(directory, HOST_INTERFACES_FILE);
  const hostDigest = existsSync(hostFile) ? `sha256:${digestOf(readFileSync(hostFile))}` : null;
  const hostStale = compiled && Object.hasOwn(manifest, "host_interfaces_digest") && manifest.host_interfaces_digest !== hostDigest;
  return {
    source_digest: project.source_digest,
    compiled_source_digest: manifest.source_digest || null,
    scene_ir_digest: manifest.scene_ir_digest || null,
    compiled_at: manifest.compiled_at || null,
    host_interfaces_digest: hostDigest,
    compiled,
    stale: !compiled || hostStale || (manifest.source_digest ? manifest.source_digest !== project.source_digest : null),
  };
}

const DEFAULT_MAX_CHARS = 100000;

/**
 * Read source. mode 'content' (default) returns text bounded by max_chars / offset+limit lines with
 * has_more/next_offset; 'metadata' returns digests, sizes and compile state without text; 'node'
 * returns the block that declares node id (source range + compiled properties).
 */
export async function readSource(name, file = "scene.ssdl", { mode = "content", offset = 1, limit, maxChars = DEFAULT_MAX_CHARS, node } = {}) {
  const directory = projectDir(name);
  const files = listSourceFiles(directory);
  if (node) mode = "node";
  if (!["content", "metadata", "node"].includes(mode)) throw new Error("mode must be 'content', 'metadata' or 'node'");
  if (mode === "metadata") {
    const metas = files.map((item) => fileMeta(directory, item));
    return { project: name, mode, files: metas, total_bytes: metas.reduce((sum, meta) => sum + meta.bytes, 0), ...(await sourceState(directory)) };
  }
  if (mode === "node") {
    if (!node) throw new Error("node id required for mode 'node'");
    const hits = locateNode(directory, node);
    if (!hits.length) throw Object.assign(new Error(`node '${node}' not found in ${files.join(", ")}`), { code: "node_not_found" });
    let properties = null;
    try { properties = (JSON.parse(readFileSync(path.join(directory, "scene.ir.json"), "utf8")).nodes || []).find((item) => item.id === node)?.properties ?? null; } catch {}
    const [first] = hits;
    return { project: name, mode, node, file: first.file, type: first.type, line_start: first.line_start, line_end: first.line_end,
      content: first.text, digest: fileMeta(directory, first.file).digest, compiled_properties: properties,
      ...(hits.length > 1 ? { duplicates: hits.slice(1).map((hit) => `${hit.file}:${hit.line_start}`) } : {}) };
  }
  const readOne = (item) => {
    const data = readFileSync(sourcePath(directory, item));
    const text = data.toString("utf8");
    const lines = text.split("\n");
    const total = lines.length - (text.endsWith("\n") ? 1 : 0);
    const from = Math.max(1, Math.trunc(offset) || 1);
    let count = limit ? Math.max(1, Math.trunc(limit)) : total - from + 1;
    let chunk = lines.slice(from - 1, from - 1 + count);
    let content = chunk.join("\n") + (from - 1 + count <= total - 1 || text.endsWith("\n") ? "\n" : "");
    let truncated = false;
    if (content.length > maxChars) {
      let acc = 0, kept = 0;
      for (const line of chunk) { if (acc + line.length + 1 > maxChars) break; acc += line.length + 1; kept += 1; }
      chunk = chunk.slice(0, Math.max(1, kept)); count = chunk.length; content = chunk.join("\n") + "\n"; truncated = true;
    }
    const next = from + count;
    const hasMore = next <= total;
    return { file: item, content, digest: digestOf(data), bytes: data.length, lines: total,
      range: { offset: from, count, lines: total }, has_more: hasMore, ...(hasMore ? { next_offset: next } : {}),
      ...(truncated ? { truncated: true, truncated_reason: `max_chars ${maxChars}` } : {}) };
  };
  if (file === "*") return { project: name, files, sources: files.map(readOne) };
  return { project: name, ...readOne(file), files };
}

function commitSource(target, data) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, target);
}

/** Replace one unique occurrence (or every occurrence) of old_string in a source file; digest-guarded like writeSource. */
export function patchSource(name, file, oldString, newString, expectedDigest, { replaceAll = false } = {}) {
  const directory = projectDir(name);
  const target = sourcePath(directory, file);
  if (!existsSync(target)) throw Object.assign(new Error(`${file} does not exist; use ssworld_source_write with expected_digest 'new'`), { code: "file_missing" });
  if (typeof oldString !== "string" || !oldString.length) throw new Error("old_string must be a non-empty string");
  const current = readFileSync(target);
  const digest = digestOf(current);
  if (expectedDigest && expectedDigest !== digest) throw Object.assign(new Error("source changed since it was read; call ssworld_source_read again before patching"), { code: "digest_mismatch", extra: { digest } });
  const text = current.toString("utf8");
  const occurrences = text.split(oldString).length - 1;
  if (occurrences === 0) throw Object.assign(new Error(`old_string not found in ${file}; read the file again and copy the text exactly (whitespace included)`), { code: "patch_not_found", extra: { digest } });
  if (occurrences > 1 && !replaceAll) throw Object.assign(new Error(`old_string occurs ${occurrences} times in ${file}; include more surrounding context or pass replace_all: true`), { code: "patch_ambiguous", extra: { occurrences, digest } });
  const patched = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
  const data = Buffer.from(patched, "utf8");
  if (data.length > 1024 * 1024) throw new Error("source exceeds 1 MiB");
  commitSource(target, data);
  const line = text.slice(0, text.indexOf(oldString)).split("\n").length;
  return { ok: true, project: name, file, digest: digestOf(data), replaced: occurrences, first_line: line, compiled: false, next_action: "call ssworld_compile" };
}

export function writeSource(name, file, content, expectedDigest) {
  const directory = projectDir(name);
  const target = sourcePath(directory, file);
  const actual = existsSync(target) ? digestOf(readFileSync(target)) : "new";
  if (expectedDigest !== actual) {
    throw new Error(expectedDigest === "new" ? "file already exists; read it first and pass its digest" : "source changed since it was read; call ssworld_source_read again before editing");
  }
  const data = Buffer.from(content, "utf8");
  if (data.length > 1024 * 1024) throw new Error("source exceeds 1 MiB");
  commitSource(target, data);
  return { ok: true, project: name, file, digest: digestOf(data), compiled: false, next_action: "call ssworld_compile" };
}


/**
 * Apply several edits atomically. edits: [{file?, old_string, new_string, replace_all?} | {file?, node_id, set?, unset?}].
 * Every edit is applied in memory first; any failure leaves the disk untouched. expected_digests: {file: digest}
 * (or expected_digest for a single-file batch). validate: 'none' | 'compile'; rollback_on_validation_error restores
 * the previous sources (and recompiles them) when the compile fails.
 */
export async function batchEdit(name, { edits, expectedDigests = {}, expectedDigest, validate = "none", rollbackOnValidationError = true } = {}) {
  const directory = projectDir(name);
  if (!Array.isArray(edits) || !edits.length) throw new Error("edits must be a non-empty array");
  if (!["none", "compile"].includes(validate)) throw new Error("validate must be 'none' or 'compile'");
  const files = listSourceFiles(directory);
  const texts = new Map(); // file -> { before: Buffer, text }
  const load = (file) => {
    if (!texts.has(file)) {
      const target = sourcePath(directory, file);
      if (!existsSync(target)) throw Object.assign(new Error(`${file} does not exist`), { code: "file_missing", extra: { file } });
      const before = readFileSync(target);
      texts.set(file, { before, text: before.toString("utf8") });
    }
    return texts.get(file);
  };
  const guards = { ...expectedDigests };
  if (expectedDigest) {
    const named = [...new Set(edits.map((edit) => edit.file).filter(Boolean))];
    if (named.length > 1) throw new Error("expected_digest only works for a single-file batch; pass expected_digests {file: digest}");
    guards[named[0] || "scene.ssdl"] = expectedDigest;
  }
  for (const [file, digest] of Object.entries(guards)) {
    const actual = digestOf(load(file).before);
    if (digest !== actual) throw Object.assign(new Error(`${file} changed since it was read; call ssworld_source_read again`), { code: "digest_mismatch", extra: { file, digest: actual } });
  }
  const applied = [];
  edits.forEach((edit, index) => {
    const fail = (message, code, extra = {}) => { throw Object.assign(new Error(`edit ${index}: ${message}`), { code, extra: { edit_index: index, ...extra } }); };
    try {
      if (edit.node_id) {
        let file = edit.file;
        if (!file) {
          const owners = files.filter((item) => locateNode(directory, edit.node_id).some((hit) => hit.file === item));
          if (!owners.length) fail(`node '${edit.node_id}' not found`, "node_not_found");
          if (owners.length > 1) fail(`node '${edit.node_id}' is declared in ${owners.join(", ")}; pass file`, "node_ambiguous");
          file = owners[0];
        }
        const slot = load(file);
        const result = editNodeInText(slot.text, edit.node_id, { set: edit.set || {}, unset: edit.unset || [] });
        slot.text = result.text;
        applied.push({ index, file, node_id: edit.node_id, set: result.set, inserted: result.inserted, unset: result.unset, line: result.file_line });
      } else {
        const file = edit.file || "scene.ssdl";
        if (typeof edit.old_string !== "string" || !edit.old_string.length) fail("old_string must be a non-empty string", "invalid_edit");
        const slot = load(file);
        const occurrences = slot.text.split(edit.old_string).length - 1;
        if (occurrences === 0) fail(`old_string not found in ${file}`, "patch_not_found", { file });
        if (occurrences > 1 && !edit.replace_all) fail(`old_string occurs ${occurrences} times in ${file}`, "patch_ambiguous", { file, occurrences });
        const line = slot.text.slice(0, slot.text.indexOf(edit.old_string)).split("\n").length;
        slot.text = edit.replace_all ? slot.text.split(edit.old_string).join(edit.new_string ?? "") : slot.text.replace(edit.old_string, () => edit.new_string ?? "");
        applied.push({ index, file, replaced: occurrences, line });
      }
    } catch (error) {
      if (error.code) throw error;
      fail(error.message, "invalid_edit");
    }
  });
  const changed = [...texts.entries()].filter(([, slot]) => slot.text !== slot.before.toString("utf8"));
  for (const [, slot] of changed) if (Buffer.byteLength(slot.text, "utf8") > 1024 * 1024) throw new Error("source exceeds 1 MiB");
  const restore = () => { for (const [file, slot] of changed) commitSource(sourcePath(directory, file), slot.before); };
  try { for (const [file, slot] of changed) commitSource(sourcePath(directory, file), Buffer.from(slot.text, "utf8")); }
  catch (error) { restore(); throw Object.assign(new Error(`write failed, previous sources restored: ${error.message}`), { code: "write_failed" }); }
  const out = { ok: true, project: name, edits_applied: applied,
    files: changed.map(([file, slot]) => ({ file, digest_before: digestOf(slot.before), digest: digestOf(Buffer.from(slot.text, "utf8")) })), compiled: false };
  if (validate !== "compile") return { ...out, next_action: "call ssworld_compile" };
  try {
    const compiled = await compileProject(directory);
    return { ...out, compiled: true, compile: compiled };
  } catch (error) {
    const diagnostic = error instanceof CompileError ? { message: error.message, ...error.diagnostic } : { message: String(error.message || error) };
    if (!rollbackOnValidationError) return { ...out, ok: false, compiled: false, compile_failed: diagnostic, rolled_back: false, next_action: "sources were written but do not compile; fix them and call ssworld_compile" };
    restore();
    let recompiled = null;
    try { recompiled = await compileProject(directory); } catch { recompiled = null; }
    throw Object.assign(new Error(`compile failed after the batch, sources rolled back: ${diagnostic.message}`), { code: "validation_failed",
      extra: { compile_failed: diagnostic, rolled_back: true, files: changed.map(([file, slot]) => ({ file, digest: digestOf(slot.before) })), previous_recompiled: Boolean(recompiled) } });
  }
}

export async function compileNamed(name) {
  const directory = projectDir(name);
  return { project: name, ...(await compileProject(directory)) };
}
