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

// The spawn log lives on the page, not in this module: this file is re-imported for every
// generation, so anything it holds is gone the moment the author saves a file. Keyed by scope and
// stamped with the generation that wrote it, so the OUTGOING generation's teardown cannot erase the
// world the incoming one just replayed.
function spawnLogStore(ctx) {
  const store = ctx.window.__ssworld_spawn_log ||= new Map();
  return {
    read() { return store.get(ctx.scopeId)?.log || []; },
    write(log) {
      const previous = store.get(ctx.scopeId);
      if (previous && previous.generation > ctx.generation) return;
      store.set(ctx.scopeId, { generation: ctx.generation, log });
    },
  };
}

/** api.scene / api.instances / api.input: the half of a living world that only host JS can hold. */
function worldApi(ctx) {
  // The director only exists once the graph is installed, and host_interfaces are resolved before
  // that (SSDL's own calls have to be wired before the first commit). So every entry point reads the
  // director when it is CALLED, which is always after mount.
  const director = () => {
    const live = ctx.runtime.director;
    if (!live) throw Object.assign(new Error("api.scene is only available once the scene has mounted"), { code: "scene_graph_missing" });
    return live;
  };
  const batch = (id) => {
    const component = ctx.runtime.graph.get(id);
    if (typeof component?.setRows !== "function") {
      throw Object.assign(new Error(`'${id}' is not an Instances batch`), { code: "placement_invalid" });
    }
    return component;
  };
  return {
    scene: Object.freeze({
      spawn: (name, params, placement) => director().spawn(name, params, placement),
      dispose: (handle) => director().dispose(handle),
      move: (handle, placement) => director().move(handle, placement),
      moveBatch: (items) => director().moveBatch(items),
      setVisible: (handle, visible) => director().setVisible(handle, visible),
      set: (handle, name, value) => director().set(handle, name, value),
      list: (filter) => director().list(filter),
      onTap: (handle, listener) => director().onTap(handle, listener),
      onHover: (handle, listener) => director().onHover(handle, listener),
      budget: () => director().usage(),
      flush: () => director().flush(),
      snapshot: () => director().snapshot(),
      restore: (log) => director().restore(log),
      fragments: () => Object.entries(generated.fragments || {}).map(([name, fragment]) => ({
        name, parameters: fragment.parameters.map(({ name: parameter, type, default: value, mutable }) =>
          ({ name: parameter, type, default: value, mutable })), budget: fragment.budget })),
    }),
    instances: Object.freeze({
      set: (id, rows) => batch(id).setRows(rows),
      count: (id) => batch(id).count,
    }),
    input: Object.freeze({ ray: (x, y) => ctx.runtime.runtime.pickRay(x, y) }),
  };
}

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
    ...worldApi(ctx),
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
  const store = spawnLogStore(ctx);
  ctx.runtime.director.onLog = (log) => store.write(log);
  // Hot reload is a whole new generation, so nothing a previous one spawned survives on its own.
  // Replaying the log is what keeps a city standing while its author edits one lamp post; an entry
  // the edited component no longer accepts becomes a spawn_replay_failed and does not stop the mount.
  const replay = store.read();
  if (replay.length) ctx.runtime.director.restore(replay);
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
