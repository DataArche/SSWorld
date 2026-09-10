// Runtime error post-processing for ssworld_capture_frame: collapse duplicate reports and map
// "<Component>.<member> ..." runtime invariants back to the SSDL source line that set the member.
// The emitted source map carries no mappings (mappings: ""), so the location is recovered by
// scanning the project's .ssdl files with a brace tracker, narrowed by the scene IR node ids.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MEMBER_RE = /\b([A-Z][A-Za-z0-9]*)\.([a-z][A-Za-z0-9]*)\b/;
const NOISE_KINDS = new Set(["console.error"]);

/** Keep one entry per underlying failure: a console.error that repeats a scene_module message is dropped. */
export function dedupeErrors(errors = []) {
  const kept = [];
  for (const error of errors) {
    const message = String(error.message || "");
    const duplicate = kept.find((other) => other.message === message
      || (NOISE_KINDS.has(error.kind) && message.startsWith(other.message))
      || (NOISE_KINDS.has(other.kind) && other.message.startsWith(message)));
    if (!duplicate) { kept.push({ ...error, message }); continue; }
    if (NOISE_KINDS.has(duplicate.kind) && !NOISE_KINDS.has(error.kind)) Object.assign(duplicate, { kind: error.kind, message });
    duplicate.repeats = (duplicate.repeats || 1) + 1;
  }
  return kept;
}

function stripLiterals(line) {
  // Remove string literals and line comments so their braces do not disturb the tracker.
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, "");
}

function sourceFiles(directory) {
  const out = [];
  (function walk(current) {
    if (!existsSync(current)) return;
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) walk(absolute);
      else if (item.name.endsWith(".ssdl")) out.push(absolute);
    }
  })(directory);
  return out.sort();
}

/** Find `member:` assignments inside `<type> { … }` blocks, optionally restricted to node ids. */
export function locateMember(directory, type, member, ids = null) {
  const hits = [];
  const wanted = ids && ids.length ? new Set(ids) : null;
  const memberRe = new RegExp(`(?:^|[;{\\s])${member}\\s*:`);
  for (const file of sourceFiles(directory)) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const stack = [];
    lines.forEach((raw, index) => {
      const line = stripLiterals(raw);
      const open = line.match(/^\s*([A-Z][A-Za-z0-9]*)\s*\{/);
      if (open) stack.push({ type: open[1], id: null });
      const frame = stack[stack.length - 1];
      if (frame) {
        const idMatch = line.match(/(?:^|[;{\s])id\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/);
        if (idMatch && !frame.id) frame.id = idMatch[1];
        const memberMatch = frame.type === type ? line.match(memberRe) : null;
        if (memberMatch) hits.push({ file: relative, line: index + 1, column: memberMatch.index + memberMatch[0].indexOf(member) + 1, frame });
      }
      let first = Boolean(open);
      for (const ch of line) {
        if (ch === "{") { if (first) first = false; else stack.push({ type: null, id: null }); }
        else if (ch === "}") stack.pop();
      }
    });
  }
  const resolved = hits.map(({ frame, ...hit }) => ({ ...hit, node: frame.id }));
  return wanted ? resolved.filter((hit) => !hit.node || wanted.has(hit.node)) : resolved;
}

/** Attach { component, member, source } to runtime errors that name a component member. */
export function locateRuntimeErrors(directory, errors = []) {
  let nodes = null;
  const irPath = path.join(directory, "scene.ir.json");
  if (existsSync(irPath)) {
    try { nodes = JSON.parse(readFileSync(irPath, "utf8")).nodes || []; } catch { nodes = null; }
  }
  return errors.map((error) => {
    const match = MEMBER_RE.exec(String(error.message || ""));
    if (!match) return error;
    const [, component, member] = match;
    const ids = nodes ? nodes.filter((node) => node.type === component && (node.properties || []).some((item) => item.property === member)).map((node) => node.id) : null;
    const hits = locateMember(directory, component, member, ids);
    const located = { ...error, component, member };
    if (hits.length) {
      const [first] = hits;
      located.source = { file: first.file, line: first.line, column: first.column, ...(first.node ? { node: first.node } : {}) };
      if (hits.length > 1) located.other_sources = hits.slice(1).map((hit) => `${hit.file}:${hit.line}:${hit.column}`);
    }
    return located;
  });
}
