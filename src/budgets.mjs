// Shared MCP manifest defaults. Materials are capped at one shell per legacy native-object slot;
// textures stay intentionally small because identical sources are shared rather than duplicated.
export const DEFAULT_BUDGETS = Object.freeze({
  native_objects: 2048,
  materials: 2048,
  textures: 32,
  // Instancing accounting: a Prefab is one native object (one entity, one renderer, one draw call) and
  // its instances are rows in that renderer's instance buffer, not nodes. The per-prefab ceiling is the
  // engine's own (PrefabFacade/v2 max_instances_per_prefab); `instances` counts rows across all batches.
  prefabs: 64,
  instances: 2048,
  bindings: 256,
  handlers: 128,
  timers: 32,
  timelines: 256,
});

/** Fill absent or invalid (non-negative safe integer) manifest entries from the backwards-compatible defaults. */
export function resolveBudgets(budgets = {}) {
  const provided = budgets && typeof budgets === "object" && !Array.isArray(budgets) ? budgets : {};
  return Object.fromEntries(Object.entries(DEFAULT_BUDGETS).map(([key, fallback]) => [
    key,
    Number.isSafeInteger(provided[key]) && provided[key] >= 0 ? provided[key] : fallback,
  ]));
}
