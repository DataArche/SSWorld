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

export async function createProject(name, { anchor = DEFAULT_ANCHOR, title } = {}) {
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
  const manifestPath = path.join(directory, "showcase.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.name = name;
  manifest.budgets = DEFAULT_BUDGETS;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const compiled = await compileProject(directory, { name, budgets: DEFAULT_BUDGETS });
  return { project: name, directory, anchor, ...compiled };
}

export function readSource(name, file = "scene.ssdl") {
  const directory = projectDir(name);
  const data = readFileSync(sourcePath(directory, file));
  const files = [];
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) walk(absolute);
      else if (item.name.endsWith(".ssdl")) files.push(path.relative(directory, absolute).split(path.sep).join("/"));
    }
  })(directory);
  return { project: name, file, content: data.toString("utf8"), digest: digestOf(data), files: files.sort() };
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
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, target);
  return { ok: true, project: name, file, digest: digestOf(data), compiled: false, next_action: "call ssworld_compile" };
}

export async function compileNamed(name) {
  const directory = projectDir(name);
  return { project: name, ...(await compileProject(directory)) };
}
