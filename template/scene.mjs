// SSWorld project host. The compiled scene lives in scene.generated.mjs; this file only adds a
// default camera when the SSDL source does not declare one and mirrors state into the page panel.
const generatedUrl = new URL("./scene.generated.mjs", import.meta.url);
generatedUrl.search = new URL(import.meta.url).search;
const generated = await import(generatedUrl.href);

export const sceneIR = generated.sceneIR;
export const bindingIR = generated.bindingIR;
export const metadata = Object.freeze({
  sceneModuleVersion: 1,
  name: __NAME_JSON__,
  sourceKind: "hybrid",
  compilerProfile: generated.metadata.compilerProfile,
  compilerProfileDigest: generated.metadata.compilerProfileDigest,
});

// Host logic (optional logic.mjs next to scene.ssdl). It is re-imported for every generation, so its
// module state resets on hot reload; SSDL reaches it only through host_interfaces.json calls.
async function loadHostInterfaces(ctx) {
  const declared = sceneIR.host_interfaces;
  if (!declared) return null;
  const logicUrl = new URL("./logic.mjs", import.meta.url);
  logicUrl.search = `?scene_module_load=${ctx.generation}`;
  let logic;
  try { logic = await import(logicUrl.href); }
  catch (error) { throw Object.assign(new Error(`scene declares host interfaces ${Object.keys(declared).join(", ")} but logic.mjs could not be loaded: ${error.message}`), { code: "host_interface_missing" }); }
  if (typeof logic.createHostInterfaces !== "function") throw Object.assign(new Error("logic.mjs must export createHostInterfaces(api)"), { code: "host_interface_missing" });
  const api = Object.freeze({
    generation: ctx.generation, scopeId: ctx.scopeId, anchor: ctx.anchor,
    logical: Object.freeze({ read: () => ctx.runtime.logicalState(), write: (name, value) => ctx.runtime.writeLogical(name, value) }),
    declared,
  });
  return await logic.createHostInterfaces(api);
}

function logicalLine(ctx) {
  try {
    const state = ctx.runtime.logicalState();
    const parts = [...Object.entries(state.properties).map(([k, v]) => `${k}=${JSON.stringify(v)}`), ...Object.entries(state.states).map(([k, v]) => `${k}.when=${v}`)];
    return parts.length ? parts.join(" · ") : "no declared properties";
  } catch { return "SSDL"; }
}

export async function mount(ctx) {
  ctx.runtime.hostInterfaces = await loadHostInterfaces(ctx);
  const graph = await generated.mount(ctx);
  ctx.ui.logicalLine = () => logicalLine(ctx);
  if (!sceneIR.nodes.some((node) => node.type === "Camera")) {
    ctx.runtime.createCameraView({ id: "default-view", longitude: ctx.anchor.lon, latitude: ctx.anchor.lat,
      height: ctx.anchor.height + 150, duration: 1 });
    ctx.runtime.createCamera({ id: "default-camera", initialView: "default-view" }).activateInitial({ duration: 1 });
  }
  ctx.document.body.dataset.runtime = "ready";
  ctx.ui.state.textContent = logicalLine(ctx);
  ctx.ui.generation.textContent = String(ctx.generation);
  ctx.ui.batch.textContent = graph.lastBatch ? `${graph.lastBatch.ok ? "committed" : "failed"} · ${graph.lastBatch.committed} binding writes` : "compiled scene mounted";
  ctx.ui.hint.textContent = "Edit scene.ssdl and compile to hot reload";
  return graph;
}

export function snapshot(graph, ctx) {
  return { ok: true, schema_version: "SSWorldSnapshot/1", generation: ctx.generation, graph: graph.snapshot() };
}

export async function dispose(graph) {
  await generated.dispose(graph);
}
