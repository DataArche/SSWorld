// Project workspace under $SSWORLD_HOME/projects/<name>: create, list, read, write, compile.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT, TEMPLATE_ROOT } from "./paths.mjs";
import { compileProject } from "./compile.mjs";

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
  if (!target.endsWith(".ssdl")) throw new Error("only .ssdl source files are readable/writable through this tool");
  return target;
}

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
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const compiled = await compileProject(directory, { name, budgets: DEFAULT_BUDGETS });
  return { project: name, directory, anchor, template, ...compiled };
}

export function readSource(name, file = "scene.ssdl") {
  const directory = projectDir(name);
  const files = [];
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) walk(absolute);
      else if (item.name.endsWith(".ssdl")) files.push(path.relative(directory, absolute).split(path.sep).join("/"));
    }
  })(directory);
  files.sort();
  if (file === "*") {
    const contents = files.map((item) => { const data = readFileSync(path.join(directory, item)); return { file: item, content: data.toString("utf8"), digest: digestOf(data) }; });
    return { project: name, files, sources: contents };
  }
  const data = readFileSync(sourcePath(directory, file));
  return { project: name, file, content: data.toString("utf8"), digest: digestOf(data), files };
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

export async function compileNamed(name) {
  const directory = projectDir(name);
  return { project: name, ...(await compileProject(directory)) };
}
