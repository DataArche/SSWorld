// Shared MCP manifest defaults.
//
// Every number here is either the engine's own published ceiling or a value confirmed on real
// hardware by src/ssdl/tools/probe_scale_limits.py, which raises the manifest budgets and builds a
// scene past them.  Measured 2026-09-12 on the SSmap 32e8d76ff2d51b21 build:
//
//   6401 native objects + 200 prefabs + 409600 instance rows + 200 timers
//       -> compiles in 1.2 s, mounts in 4.0 s, runs at 61 fps, no runtime errors
//   3915 native objects + 1500 bindings + 600 handlers + 914 locators
//       -> mounts in 2.2 s, runs at 44 fps, no runtime errors
//   2001 / 4001 native objects -> render AND capture (render_verified, ~21k distinct colours)
//   5001 / 6001 native objects -> render at 60 fps but the capture readback dies with
//       "memory access out of bounds", so the scene runs and cannot be screenshotted
//
// A budget that is the engine's own limit is marked as such and must not be raised here: the engine
// answers with it in capabilities(), so raising it only moves a mount failure out of the compiler.
export const DEFAULT_BUDGETS = Object.freeze({
  // No facade publishes a node ceiling, and rendering is not what runs out: 6401 objects still held
  // 61 fps.  The wall is the offscreen readback behind ssworld_capture_frame, which dies of a wasm
  // out-of-bounds somewhere between 4001 (captures fine) and 5001 (does not).  A scene past this
  // still runs, so this stays a reported ratio rather than a compile error -- but the author loses
  // the only evidence channel they have, which is why the number sits just under the failure.
  native_objects: 4096,
  materials: 4096,
  // MaterialFacade.max_shared_textures -- the engine's own number, not a choice.
  textures: 32,
  // Instancing accounting: a Prefab is one native object (one entity, one renderer, one draw call) and
  // its instances are rows in that renderer's instance buffer, not nodes.  PrefabFacade publishes no
  // ceiling on the number of prefabs, so this only has to stay under native_objects; `instances`
  // counts rows across all batches, while the engine's real ceilings are per batch (512) and per
  // prefab (2048), both still enforced where the batch is built.
  prefabs: 1024,
  instances: 524288,
  // AnimationFacade.captureBatch takes at most 64 items per call, so the runtime flushes bindings in
  // chunks of 64; before that, 65 bindings in the first frame failed the whole mount.  What is left
  // is per-frame evaluation cost, and 1500 bindings still held 44 fps.
  bindings: 4096,
  handlers: 2048,
  // AnimationFacade.max_active_timers -- the engine's own number.
  timers: 256,
  // AnimationFacade.max_active_timelines -- the engine's own number.
  timelines: 256,
  // SceneGraphFacade.max_locators -- the engine's own number.  A Group is a native locator, so a
  // Group-heavy scene hits this long before it hits native_objects.
  locators: 1024,
});

/** Engine ceilings that a manifest may not raise: the engine answers with these in capabilities(). */
export const ENGINE_CEILINGS = Object.freeze({
  textures: 32,
  timers: 256,
  timelines: 256,
  locators: 1024,
});

/** SceneGraphFacade.max_depth: how deeply Groups may nest before the native graph refuses the parent. */
export const MAX_SCENE_DEPTH = 16;

/** ModelFacade.max_model_instances: how many Model nodes one scene may mount. */
export const MAX_MODEL_INSTANCES = 64;

/** MaterialFacade.max_texture_bytes_total: every distinct image decoded into the scene, added up. */
export const MAX_TEXTURE_BYTES_TOTAL = 67108864;

/**
 * Fill absent or invalid (non-negative safe integer) manifest entries from the defaults, and clamp
 * every dimension the engine owns: a project that asks for 64 timers would otherwise compile and
 * then fail to mount, which is exactly the failure the budgets exist to turn into a compile error.
 */
export function resolveBudgets(budgets = {}) {
  const provided = budgets && typeof budgets === "object" && !Array.isArray(budgets) ? budgets : {};
  return Object.fromEntries(Object.entries(DEFAULT_BUDGETS).map(([key, fallback]) => {
    const asked = Number.isSafeInteger(provided[key]) && provided[key] >= 0 ? provided[key] : fallback;
    const ceiling = ENGINE_CEILINGS[key];
    return [key, ceiling === undefined ? asked : Math.min(asked, ceiling)];
  }));
}
