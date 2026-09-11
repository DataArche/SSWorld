// SSDL source scanning shared by runtime-error localisation, node-range reads, node-level edits and
// scene inspection. The emitted source map carries no mappings (mappings: ""), so positions are
// recovered by a small character-level scanner over the project's .ssdl files: it tracks braces,
// `Type {` block openers, `id:` statements and `member:` assignments with their value spans.
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

export function sourceFiles(directory) {
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

const isIdentStart = (ch) => /[A-Za-z_]/.test(ch);
const isIdent = (ch) => /[A-Za-z0-9_]/.test(ch);

/**
 * Scan one SSDL text. Returns blocks ({type, id, start, end, line, column, depth, parent, body_start})
 * and members ({block, name, line, column, value_start, value_end}) with 0-based char offsets;
 * `end`/`value_end` are exclusive. Strings and comments never open or close blocks.
 */
export function scanSsdl(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
  const position = (offset) => {
    let low = 0, high = lineStarts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (lineStarts[mid] <= offset) low = mid; else high = mid - 1; }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };
  const blocks = [];
  const members = [];
  const stack = [];
  let i = 0;
  const skipSpace = (from) => { let j = from; while (j < text.length && /[ \t\r\n]/.test(text[j])) j += 1; return j; };
  const skipString = (from) => { let j = from + 1; while (j < text.length && text[j] !== text[from]) { if (text[j] === "\\") j += 1; j += 1; } return j + 1; };
  // Value span: until `;`, newline or a `}` that closes the enclosing block, outside brackets/strings.
  const valueEnd = (from) => {
    let j = from, depth = 0;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '"' || ch === "'") { j = skipString(j); continue; }
      if (ch === "/" && text[j + 1] === "/") break;
      if (ch === "[" || ch === "(" || ch === "{") depth += 1;
      else if (ch === "]" || ch === ")") depth -= 1;
      else if (ch === "}") { if (depth === 0) break; depth -= 1; }
      else if ((ch === ";" || ch === "\n") && depth === 0) break;
      j += 1;
    }
    while (j > from && /[ \t\r]/.test(text[j - 1])) j -= 1;
    return j;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipString(i); continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (ch === "/" && text[i + 1] === "*") { const close = text.indexOf("*/", i + 2); i = close < 0 ? text.length : close + 2; continue; }
    if (ch === "{") { stack.push({ type: null, id: null, start: i, ...position(i), depth: stack.length, parent: stack[stack.length - 1] || null, body_start: i + 1 }); blocks.push(stack[stack.length - 1]); i += 1; continue; }
    if (ch === "}") { const block = stack.pop(); if (block) block.end = i + 1; i += 1; continue; }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < text.length && (isIdent(text[j]) || text[j] === ".")) j += 1;
      const word = text.slice(i, j);
      const next = skipSpace(j);
      if (text[next] === "{" && /^[A-Z]/.test(word)) {
        const block = { type: word, id: null, start: i, ...position(i), depth: stack.length, parent: stack[stack.length - 1] || null, body_start: next + 1 };
        stack.push(block); blocks.push(block); i = next + 1; continue;
      }
      if (text[next] === ":" && text[next + 1] !== ":" && !word.includes(".") && stack.length) {
        const valueStart = skipSpace(next + 1);
        const end = valueEnd(valueStart);
        const block = stack[stack.length - 1];
        const member = { block, name: word, start: i, ...position(i), value_start: valueStart, value_end: end };
        members.push(member);
        if (word === "id" && !block.id) block.id = text.slice(valueStart, end).trim();
        i = Math.max(end, valueStart); continue;
      }
      i = j; continue;
    }
    i += 1;
  }
  for (const block of stack) block.end = text.length; // unterminated: best effort
  return { blocks, members, position };
}

/** Scan every .ssdl file of a project: [{file, text, scan}]. */
export function scanProject(directory) {
  return sourceFiles(directory).map((file) => {
    const text = readFileSync(file, "utf8");
    return { file: path.relative(directory, file).split(path.sep).join("/"), text, scan: scanSsdl(text) };
  });
}

/** Find `member:` assignments inside `<type> { … }` blocks, optionally restricted to node ids. */
export function locateMember(directory, type, member, ids = null) {
  const wanted = ids && ids.length ? new Set(ids) : null;
  const hits = [];
  for (const { file, scan } of scanProject(directory)) {
    for (const item of scan.members) {
      if (item.name !== member || item.block.type !== type) continue;
      hits.push({ file, line: item.line, column: item.column, node: item.block.id });
    }
  }
  return wanted ? hits.filter((hit) => !hit.node || wanted.has(hit.node)) : hits;
}

/** Locate a node block by id across the project: {file, type, line_start, line_end, start, end, text}. */
export function locateNode(directory, id) {
  const out = [];
  for (const { file, text, scan } of scanProject(directory)) {
    for (const block of scan.blocks) {
      if (block.id !== id || !block.type) continue;
      const endPos = scan.position(Math.max(block.start, block.end - 1));
      out.push({ file, node: id, type: block.type, line_start: block.line, column: block.column, line_end: endPos.line, start: block.start, end: block.end, text: text.slice(block.start, block.end) });
    }
  }
  return out;
}

const ANONYMOUS_RE = /^anonymous_([A-Z][A-Za-z0-9]*)_\d+$/;

/**
 * Find `member:` inside the block with this node id (a bound property path like transform.position matches its
 * last segment). Compiler-named anonymous nodes (anonymous_PrincipledMaterial_0) have no id in the source: they are
 * found by type inside their parent's block (parent from SceneIR when available), or by type alone when unique.
 */
export function locateNodeMember(directory, nodeId, member, irNodes = null) {
  const candidates = [...new Set([member, member.split(".").pop()])];
  const project = scanProject(directory);
  for (const { file, scan } of project) {
    for (const name of candidates) {
      const hit = scan.members.find((item) => item.block.id === nodeId && item.name === name);
      if (hit) return { file, line: hit.line, column: hit.column, node: nodeId, member: name };
    }
  }
  const irNode = irNodes?.find((node) => node.id === nodeId) || null;
  const type = irNode?.type || ANONYMOUS_RE.exec(nodeId)?.[1] || null;
  if (type) {
    const enclosed = (block, id) => { for (let current = block.parent; current; current = current.parent) if (current.id === id) return true; return false; };
    const search = (parentId) => {
      const hits = [];
      for (const { file, scan } of project) {
        for (const name of candidates) {
          for (const item of scan.members) {
            if (item.name !== name || item.block.type !== type || item.block.id) continue;
            if (parentId && !enclosed(item.block, parentId)) continue;
            hits.push({ file, line: item.line, column: item.column, node: nodeId, member: name, ...(parentId ? { parent: parentId } : {}) });
          }
          if (hits.length) break;
        }
        if (hits.length) break;
      }
      return hits;
    };
    // The IR may be stale (sources edited since the last compile), so a parent that no longer matches falls back to type alone.
    const withParent = irNode?.parent ? search(irNode.parent) : [];
    if (withParent.length) return withParent[0];
    const byType = search(null);
    if (byType.length === 1) return byType[0];
  }
  const block = locateNode(directory, nodeId)[0];
  return block ? { file: block.file, line: block.line_start, column: block.column, node: nodeId, member: null } : null;
}

const NODE_MEMBER_RE = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_.]*):/;

/** Attach { component, member, source } to runtime errors that name a component member, or {node, member, source} to binding errors (`<node>.<property>: …`). */
export function locateRuntimeErrors(directory, errors = []) {
  let nodes = null;
  const irPath = path.join(directory, "scene.ir.json");
  if (existsSync(irPath)) {
    try { nodes = JSON.parse(readFileSync(irPath, "utf8")).nodes || []; } catch { nodes = null; }
  }
  return errors.map((error) => {
    if (error.kind === "binding_error") {
      const bound = NODE_MEMBER_RE.exec(String(error.message || ""));
      if (!bound) return error;
      const [, node, property] = bound;
      const hit = locateNodeMember(directory, node, property, nodes);
      return { ...error, node, member: property, ...(hit ? { source: { file: hit.file, line: hit.line, column: hit.column, node, ...(hit.parent ? { parent: hit.parent } : {}) } } : {}) };
    }
    const match = MEMBER_RE.exec(String(error.message || ""));
    if (!match) return error;
    const [, component, member] = match;
    const ids = nodes ? nodes.filter((node) => node.type === component && (node.properties || []).some((item) => item.property === member || item.property.endsWith(`.${member}`))).map((node) => node.id) : null;
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

/** Serialise a JSON value as SSDL literal text; {raw: "…"} passes through for ids, enums and expressions. */
export function ssdlLiteral(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.raw === "string") return value.raw;
    if (["x", "y", "z"].every((key) => typeof value[key] === "number")) return `[${value.x}, ${value.y}, ${value.z}]`;
    throw new Error("object values must be {x, y, z} or {raw: \"<ssdl text>\"}");
  }
  if (Array.isArray(value)) return `[${value.map(ssdlLiteral).join(", ")}]`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(`unsupported value ${JSON.stringify(value)}`);
}

/**
 * Set / unset properties directly on the block with the given id (own members only, not children).
 * Returns the new text and what changed; throws {code} on ambiguity or a missing node.
 */
export function editNodeInText(text, nodeId, { set = {}, unset = [] } = {}) {
  const scan = scanSsdl(text);
  const blocks = scan.blocks.filter((block) => block.id === nodeId && block.type);
  if (!blocks.length) throw Object.assign(new Error(`node '${nodeId}' not found`), { code: "node_not_found" });
  if (blocks.length > 1) throw Object.assign(new Error(`id '${nodeId}' is declared ${blocks.length} times`), { code: "node_ambiguous" });
  const [block] = blocks;
  const own = scan.members.filter((member) => member.block === block);
  const edits = []; // {start, end, replacement}
  const changed = { set: [], unset: [], inserted: [] };
  for (const name of unset) {
    const member = own.find((item) => item.name === name);
    if (!member) continue;
    let start = member.start, end = member.value_end;
    let back = start;
    while (back > block.body_start && /[ \t]/.test(text[back - 1])) back -= 1;
    if (text[back - 1] === ";") start = back - 1; // "a: 1; b: 2" -> drop "; b: 2"
    else {
      if (text[end] === ";") end += 1;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = text.indexOf("\n", end);
      if (/^[ \t]*$/.test(text.slice(lineStart, start)) && lineEnd >= 0 && /^[ \t]*$/.test(text.slice(end, lineEnd))) { start = lineStart; end = lineEnd + 1; }
    }
    edits.push({ start, end, replacement: "" });
    changed.unset.push(name);
  }
  const inserts = [];
  for (const [name, value] of Object.entries(set)) {
    if (name === "id") throw new Error("use a text patch to rename a node id");
    const literal = ssdlLiteral(value);
    const member = own.find((item) => item.name === name);
    if (member) { edits.push({ start: member.value_start, end: member.value_end, replacement: literal }); changed.set.push(name); }
    else { inserts.push(`${name}: ${literal}`); changed.inserted.push(name); }
  }
  if (inserts.length) {
    const openLine = text.slice(block.body_start).split("\n")[0];
    const singleLine = openLine.includes("}") || own.some((item) => item.line === block.line && text.slice(block.body_start, item.value_end).includes(";"));
    if (singleLine) edits.push({ start: block.body_start, end: block.body_start, replacement: ` ${inserts.join("; ")};` });
    else {
      const first = own.find((item) => item.line > block.line);
      const indent = first ? text.slice(text.lastIndexOf("\n", first.start - 1) + 1, first.start).match(/^[ \t]*/)[0]
        : text.slice(text.lastIndexOf("\n", block.start) + 1, block.start).match(/^[ \t]*/)[0] + "  ";
      const at = text.indexOf("\n", block.body_start);
      const insertAt = at < 0 || at >= block.end ? block.body_start : at + 1;
      edits.push({ start: insertAt, end: insertAt, replacement: inserts.map((item) => `${indent}${item}\n`).join("") });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return { text: out, file_line: block.line, ...changed };
}
