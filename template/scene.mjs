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

export async function mount(ctx) {
  const graph = await generated.mount(ctx);
  if (!sceneIR.nodes.some((node) => node.type === "Camera")) {
    ctx.runtime.createCameraView({ id: "default-view", longitude: ctx.anchor.lon, latitude: ctx.anchor.lat,
      height: ctx.anchor.height + 150, duration: 1 });
    ctx.runtime.createCamera({ id: "default-camera", initialView: "default-view" }).activateInitial({ duration: 1 });
  }
  ctx.document.body.dataset.runtime = "ready";
  ctx.ui.state.textContent = "SSDL";
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
