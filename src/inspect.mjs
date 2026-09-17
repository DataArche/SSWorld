// Scene inspection from the compiled IR (scene.ir.json) plus the source scan: hierarchy and budget
// attribution per subtree / per file, an axis-aligned extent of the primitive geometry, and the
// camera pose the scene requests (derived from Camera.initialView). Everything here is computed from
// the compiled artefacts, never measured on the GPU; render statistics are reported as unavailable.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { scanProject } from "./diagnose.mjs";
import { budgetUsage } from "./compile.mjs";

const EARTH_M_PER_DEG = 111320;

export function readIR(directory) {
  const file = path.join(directory, "scene.ir.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function readBindingIR(directory) {
  const file = path.join(directory, "binding.ir.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function readAnchor(directory) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, "showcase.manifest.json"), "utf8"));
    if (manifest.anchor && Number.isFinite(manifest.anchor.lon)) return manifest.anchor;
  } catch {}
  try {
    const html = readFileSync(path.join(directory, "index.html"), "utf8");
    const match = html.match(/anchor:\s*\{\s*lon:\s*(-?[\d.]+),\s*lat:\s*(-?[\d.]+),\s*height:\s*(-?[\d.]+)\s*\}/);
    if (match) return { lon: Number(match[1]), lat: Number(match[2]), height: Number(match[3]) };
  } catch {}
  return null;
}

const prop = (node, name) => (node.properties || []).find((item) => item.property === name || item.property.endsWith(`.${name}`))?.value;
const vec = (value) => value && typeof value === "object" ? [value.x || 0, value.y || 0, value.z || 0] : Array.isArray(value) ? value : null;

/** Local ENU metres -> approximate WGS84 (flat-earth around the anchor; fine for city-scale scenes). */
export function localToGeo(anchor, [x, y, z]) {
  if (!anchor) return null;
  const lat = anchor.lat + y / EARTH_M_PER_DEG;
  const lon = anchor.lon + x / (EARTH_M_PER_DEG * Math.cos(anchor.lat * Math.PI / 180));
  return { longitude: lon, latitude: lat, height: anchor.height + z };
}

/** The CameraView the scene starts on, with heading/pitch derived from position/lookAt. */
export function requestedCamera(ir, anchor) {
  if (!ir) return null;
  const camera = (ir.nodes || []).find((node) => node.type === "Camera");
  const viewId = camera ? prop(camera, "initialView") : null;
  const view = (ir.nodes || []).find((node) => node.type === "CameraView" && (viewId ? node.id === viewId : true));
  if (!view) return null;
  const position = vec(prop(view, "position"));
  const lookAt = vec(prop(view, "lookAt"));
  const out = { view: view.id, ...(camera ? { camera: camera.id } : {}) };
  for (const name of ["fov", "nearPlane", "farPlane", "heading", "pitch", "longitude", "latitude", "height"]) {
    const value = prop(view, name);
    if (value !== undefined) out[name] = value;
  }
  if (position) {
    out.position = position;
    const geo = localToGeo(anchor, position);
    if (geo) Object.assign(out, { longitude: geo.longitude, latitude: geo.latitude, height: geo.height, geo_note: "approximate flat-earth conversion of position around the anchor" });
  }
  if (lookAt) {
    out.lookAt = lookAt;
    if (position) {
      const [dx, dy, dz] = [lookAt[0] - position[0], lookAt[1] - position[1], lookAt[2] - position[2]];
      const flat = Math.hypot(dx, dy);
      if (out.heading === undefined) out.heading = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
      if (out.pitch === undefined) out.pitch = Math.atan2(dz, flat) * 180 / Math.PI;
      out.distance_to_target = Math.hypot(flat, dz);
    }
  }
  return out;
}

const GEOMETRY_EXTENT = {
  Box: (node) => [prop(node, "width") ?? 1, prop(node, "depth") ?? 1, prop(node, "height") ?? 1],
  Plane: (node) => [prop(node, "width") ?? 1, prop(node, "depth") ?? 1, 0],
  Sphere: (node) => { const r = prop(node, "radius") ?? 0.5; return [2 * r, 2 * r, 2 * r]; },
  Cylinder: (node) => { const r = prop(node, "radius") ?? 0.5; return [2 * r, 2 * r, prop(node, "height") ?? 1]; },
  Cone: (node) => { const r = prop(node, "radius") ?? 0.5; return [2 * r, 2 * r, prop(node, "height") ?? 1]; },
  Capsule: (node) => { const r = prop(node, "radius") ?? 0.5; return [2 * r, 2 * r, prop(node, "height") ?? 2]; },
  Torus: (node) => { const r = (prop(node, "radius") ?? 1) + (prop(node, "tube") ?? 0.25); return [2 * r, 2 * r, 2 * (prop(node, "tube") ?? 0.25)]; },
  Stairs: (node) => {
    const steps = prop(node, "steps") ?? 1, run = prop(node, "run") ?? 0.3, rise = prop(node, "rise") ?? 0.2;
    return [steps * run + (prop(node, "landing") ?? 0), prop(node, "width") ?? 1, steps * rise];
  },
};

export function inspectScene(directory, { subtree = null, top = 12 } = {}) {
  const ir = readIR(directory);
  if (!ir) throw Object.assign(new Error("scene.ir.json missing; call ssworld_compile first"), { code: "not_compiled" });
  const nodes = ir.nodes || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map();
  for (const node of nodes) { if (!children.has(node.parent)) children.set(node.parent, []); children.get(node.parent).push(node); }
  const sizes = new Map();
  const types = new Map();
  const subtreeOf = (id) => {
    if (sizes.has(id)) return sizes.get(id);
    let count = 1;
    const mix = { [byId.get(id).type]: 1 };
    for (const child of children.get(id) || []) {
      count += subtreeOf(child.id);
      for (const [type, n] of Object.entries(types.get(child.id))) mix[type] = (mix[type] || 0) + n;
    }
    sizes.set(id, count); types.set(id, mix);
    return count;
  };
  for (const node of nodes) subtreeOf(node.id);
  const root = subtree ? byId.get(subtree) : nodes.find((node) => node.parent === null) || nodes[0];
  if (!root) throw Object.assign(new Error(`node '${subtree}' not in the compiled scene`), { code: "node_not_found" });
  const describe = (node) => ({ id: node.id, type: node.type, nodes: sizes.get(node.id), ...(sizes.get(node.id) > 1 ? { node_types: types.get(node.id), children: (children.get(node.id) || []).length } : {}) });
  const directNodes = children.get(root.id) || [];
  const direct = directNodes.filter((node) => sizes.get(node.id) > 1).map(describe).sort((a, b) => b.nodes - a.nodes);
  const leafTypes = {};
  for (const node of directNodes) if (sizes.get(node.id) === 1) leafTypes[node.type] = (leafTypes[node.type] || 0) + 1;
  const largest = nodes.filter((node) => node.id !== root.id && sizes.get(node.id) > 1).sort((a, b) => sizes.get(b.id) - sizes.get(a.id)).slice(0, top).map(describe);
  // File attribution from the source scan (ids declared per file).
  const byFile = {};
  const idFile = new Map();
  for (const { file, scan } of scanProject(directory)) for (const block of scan.blocks) if (block.id && block.type && !idFile.has(block.id)) idFile.set(block.id, file);
  const fileOf = (node) => { for (let current = node; current; current = byId.get(current.parent)) if (idFile.has(current.id)) return idFile.get(current.id); return "(expanded)"; };
  for (const node of nodes) { const file = fileOf(node); byFile[file] = (byFile[file] || 0) + 1; }
  // Extent: primitive geometry with accumulated parent positions; rotation/scale ignored.
  const worldPosition = (node) => {
    let acc = [0, 0, 0];
    for (let current = node; current; current = byId.get(current.parent)) {
      const p = vec(prop(current, "position"));
      if (p) acc = [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]];
    }
    return acc;
  };
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let counted = 0;
  const ignored = {};
  let lowest = null, highest = null;
  for (const node of nodes) {
    if (subtree && !isDescendant(node, root.id, byId)) continue;
    const extent = GEOMETRY_EXTENT[node.type];
    if (!extent) { if (!["Scene", "Camera", "CameraView"].includes(node.type)) ignored[node.type] = (ignored[node.type] || 0) + 1; continue; }
    const centre = worldPosition(node);
    const half = extent(node).map((v) => Math.abs(v) / 2);
    for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], centre[axis] - half[axis]); max[axis] = Math.max(max[axis], centre[axis] + half[axis]); }
    counted += 1;
    const bottom = centre[2] - half[2], topZ = centre[2] + half[2];
    if (!lowest || bottom < lowest.z) lowest = { id: node.id, z: bottom };
    if (!highest || topZ > highest.z) highest = { id: node.id, z: topZ };
  }
  const round = (v) => Number(v.toFixed(3));
  const bounds = counted ? { min: min.map(round), max: max.map(round), size: max.map((v, i) => round(v - min[i])), primitives_counted: counted,
    lowest_bottom: lowest, highest_top: highest, ...(Object.keys(ignored).length ? { not_measured: ignored } : {}),
    note: "axis-aligned, local metres, from Box/Plane/Sphere/Cylinder/Cone/Capsule/Torus/Stairs sizes plus ancestor positions; rotation/scale/Model/polygons ignored" } : null;
  let budgets = {};
  try { budgets = JSON.parse(readFileSync(path.join(directory, "showcase.manifest.json"), "utf8")).budgets || {}; } catch {}
  const { node_types: _nodeTypes, ...budget } = budgetUsage({ scene_ir: ir, binding_ir: readBindingIR(directory) }, budgets);
  return {
    ok: true, root: describe(root), node_count: nodes.length,
    budget,
    ...(subtree ? {} : { dynamic: dynamicSection(directory, budget) }),
    child_subtrees: direct.slice(0, top), ...(direct.length > top ? { child_subtrees_omitted: direct.length - top } : {}),
    leaf_children: { count: directNodes.length - direct.length, by_type: leafTypes },
    largest_subtrees: largest, by_file: byFile, bounds,
    requested_camera: requestedCamera(ir, readAnchor(directory)),
    render_stats: { draw_calls: "unavailable", triangles: "unavailable", gpu_memory: "unavailable", reason: "not measured by this runtime; node counts above are compile-time facts" },
  };
}

/**
 * The spawnable half of the scene: what host JS can build at runtime, what one copy costs, and how
 * many more the scene's own budget still has room for. `budget` above is the STATIC scene; a spawn
 * is checked against static + already spawned + this fragment, so "headroom" is what is left after
 * the static half, not a promise that nothing else has taken it.
 */
function dynamicSection(directory, budget) {
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(path.join(directory, "showcase.generated.manifest.json"), "utf8")); } catch {}
  const fragments = manifest?.fragments || {};
  const names = Object.keys(fragments).sort();
  if (!names.length) {
    return { spawnable: [], note: "no component is marked `pragma spawnable`, so nothing in this project can be created at runtime" };
  }
  return {
    spawnable: names.map((name) => {
      const fragment = fragments[name];
      const headroom = Object.entries(fragment.budget)
        .filter(([key, cost]) => cost > 0 && Number.isSafeInteger(budget[key]?.limit))
        .map(([key, cost]) => ({ key, copies: Math.max(0, Math.floor((budget[key].limit - budget[key].used) / cost)) }))
        .sort((a, b) => a.copies - b.copies);
      return {
        name, source_file: fragment.source_file, parameters: fragment.parameters,
        cost_per_copy: fragment.budget,
        ...(headroom.length ? { copies_left: headroom[0].copies, limited_by: headroom[0].key } : {}),
      };
    }),
    note: "api.scene.spawn(name, params, { at, heading, parent, tag }) in logic.mjs; ssworld_logic_read reports what a running page has actually spawned",
  };
}

function isDescendant(node, rootId, byId) {
  for (let current = node; current; current = byId.get(current.parent)) if (current.id === rootId) return true;
  return false;
}
