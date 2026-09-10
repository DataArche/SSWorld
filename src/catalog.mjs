import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SSDL_ROOT } from "./paths.mjs";
import { CONVENTIONS, UNAVAILABLE_ALTERNATIVES, NOTES_VERSION, memberNotes, componentNotes } from "./runtime-support.mjs";

let cached = null;
function catalog() {
  if (!cached) {
    const raw = readFileSync(path.join(SSDL_ROOT, "catalog", "builtin-catalog-v1.source.json"));
    cached = { source: JSON.parse(raw.toString("utf8")), digest: `sha256:${createHash("sha256").update(raw).update(`notes/${NOTES_VERSION}`).digest("hex")}` };
  }
  return cached;
}

/** Stable digest of the catalog source plus the runtime notes merged into it; changes when either changes. */
export function catalogDigest() { return catalog().digest; }

export function catalogSummary() {
  const { source, digest } = catalog();
  const components = Object.fromEntries(Object.entries(source.components).map(([name, value]) => [name, {
    supported: Boolean(value.factory), adapter: value.adapter ?? null, summary: value.summary || value.description || undefined,
  }]));
  return { language: "SSDL/QML-Subset/0.3", catalog_digest: digest, coordinate_system: "right_handed_z_up", units: "metres, degrees for lon/lat",
    conventions: CONVENTIONS, schema_version: source.schema_version, components, unavailable_components: unavailable(source),
    batch_hint: "ssworld_catalog { components: [...], detail: 'compact' } reads several contracts in one call; pass if_digest to skip an unchanged catalog" };
}

function unavailable(source) {
  return Object.fromEntries(Object.entries(source.unavailable_components || {}).map(([name, reason]) => [name,
    UNAVAILABLE_ALTERNATIVES[name] ? { reason, alternative: UNAVAILABLE_ALTERNATIVES[name] } : reason]));
}

function suggestions(name, known) {
  const lower = name.toLowerCase();
  return known.filter((item) => item.toLowerCase().includes(lower) || lower.includes(item.toLowerCase())).slice(0, 5);
}

function fullContract(name) {
  const { source } = catalog();
  const contract = source.components[name];
  if (!contract) {
    const known = Object.keys(source.components);
    const alternative = UNAVAILABLE_ALTERNATIVES[name];
    throw Object.assign(new Error(`unknown component '${name}'${alternative ? `; ${alternative}` : ""}; known: ${known.join(", ")}`),
      { code: "unknown_component", extra: { component: name, suggestions: suggestions(name, known), ...(alternative ? { alternative } : {}) } });
  }
  const members = Object.fromEntries(Object.entries(contract.members || {}).map(([member, descriptor]) => {
    const notes = memberNotes(name, member, descriptor);
    return [member, notes ? { ...descriptor, ...notes } : descriptor];
  }));
  return { component: name, contract: { ...contract, members }, ...componentNotes(name) };
}

/** Compact projection: members as "value_type[ unit]" strings, notes kept as member_notes only where present. */
function compact(entry) {
  const members = {};
  const notes = {};
  for (const [member, descriptor] of Object.entries(entry.contract.members || {})) {
    const unit = descriptor.unit && descriptor.unit !== "scalar" ? ` ${descriptor.unit}` : "";
    members[member] = `${descriptor.value_type}${unit}${descriptor.update_class === "create_only" ? " create_only" : ""}`;
    const note = descriptor.note || descriptor.runtime_writable;
    if (note) notes[member] = note;
  }
  const { members: _members, ...rest } = entry.contract;
  return { component: entry.component, supported: Boolean(rest.factory), adapter: rest.adapter ?? null,
    ...(rest.children ? { children: rest.children } : {}), members, ...(Object.keys(notes).length ? { member_notes: notes } : {}),
    ...(entry.runtime_note ? { runtime_note: entry.runtime_note } : {}) };
}

export function catalogComponent(name) { return { catalog_digest: catalogDigest(), ...fullContract(name) }; }

/**
 * Read several contracts at once. Unknown names are reported per item instead of failing the call.
 * Members identical across every requested component are hoisted into shared_members (compact only).
 */
export function catalogComponents(names, { detail = "full" } = {}) {
  if (!["full", "compact"].includes(detail)) throw new Error("detail must be 'full' or 'compact'");
  const components = {};
  const unknown = [];
  for (const name of [...new Set(names)]) {
    try { const entry = fullContract(name); components[name] = detail === "compact" ? compact(entry) : entry; }
    catch (error) { unknown.push({ component: name, error: error.message.split(";")[0], ...(error.extra || {}) }); }
  }
  const out = { catalog_digest: catalogDigest(), detail, components, ...(unknown.length ? { unknown } : {}) };
  const listed = Object.values(components);
  if (detail === "compact" && listed.length > 1) {
    const shared = {};
    for (const [member, spec] of Object.entries(listed[0].members)) {
      if (listed.every((entry) => entry.members[member] === spec)) shared[member] = spec;
    }
    if (Object.keys(shared).length) {
      out.shared_members = shared;
      out.shared_members_note = "declared by every component listed here (same type/unit); omitted from each components[*].members";
      for (const entry of listed) for (const member of Object.keys(shared)) delete entry.members[member];
    }
  }
  return out;
}
