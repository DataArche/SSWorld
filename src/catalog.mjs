import { readFileSync } from "node:fs";
import path from "node:path";
import { SSDL_ROOT } from "./paths.mjs";
import { CONVENTIONS, UNAVAILABLE_ALTERNATIVES, memberNotes } from "./runtime-support.mjs";

let cached = null;
function catalog() {
  cached ??= JSON.parse(readFileSync(path.join(SSDL_ROOT, "catalog", "builtin-catalog-v1.source.json"), "utf8"));
  return cached;
}

export function catalogSummary() {
  const source = catalog();
  const components = Object.fromEntries(Object.entries(source.components).map(([name, value]) => [name, {
    supported: Boolean(value.factory), adapter: value.adapter ?? null, summary: value.summary || value.description || undefined,
  }]));
  return { language: "SSDL/QML-Subset/0.3", coordinate_system: "right_handed_z_up", units: "metres, degrees for lon/lat",
    conventions: CONVENTIONS, schema_version: source.schema_version, components, unavailable_components: unavailable(source) };
}

function unavailable(source) {
  return Object.fromEntries(Object.entries(source.unavailable_components || {}).map(([name, reason]) => [name,
    UNAVAILABLE_ALTERNATIVES[name] ? { reason, alternative: UNAVAILABLE_ALTERNATIVES[name] } : reason]));
}

export function catalogComponent(name) {
  const source = catalog();
  const contract = source.components[name];
  if (!contract) {
    const known = Object.keys(source.components);
    throw new Error(`unknown component '${name}'; known: ${known.join(", ")}`);
  }
  const members = Object.fromEntries(Object.entries(contract.members || {}).map(([member, descriptor]) => {
    const notes = memberNotes(name, member);
    return [member, notes ? { ...descriptor, ...notes } : descriptor];
  }));
  const extra = name === "DirectionalLight"
    ? { runtime_note: "atmosphereSunLight: true adopts the engine sun (drives the sky); only intensity/lightColor/castShadows/temperature/indirect/volumetric and sunAzimuth/sunElevation are writable on it. Leave it false for an owned light with full members." }
    : name === "CameraView" ? { runtime_note: CONVENTIONS.camera } : {};
  return { component: name, contract: { ...contract, members }, ...extra };
}
