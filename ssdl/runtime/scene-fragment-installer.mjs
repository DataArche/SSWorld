// Dynamic fragments: installing a compiled `pragma spawnable` component into a graph that is already
// mounted. The declarative half of SSDL says what a part IS; this is where host JS says how many of
// them there are, where, and for how long.
//
// Nothing here compiles anything. A fragment IR is the same node/binding shape installGraph mounts,
// produced by the same expander and the same compiler pass, so one component cannot mean two things.
import { installComponentsSync } from "./scene-component-installer.mjs";

/** Every dimension the budget ledger prices. Fragment IR carries exactly these keys. */
export const BUDGET_KEYS = Object.freeze(["native_objects", "materials", "textures", "bindings",
  "handlers", "timers", "locators", "prefabs", "instances", "timelines"]);

/** AnimationFacade.captureBatch takes 64 items, so a frame installs at most this many fragments. */
export const MAX_SPAWNS_PER_FRAME = 64;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A heading in degrees is a yaw about +Z in this right-handed, Z-up world. */
export function headingQuaternion(degrees) {
  const half = (degrees * Math.PI) / 360;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

function vector3(value, what) {
  const parts = Array.isArray(value) ? value
    : isPlainObject(value) ? [value.x, value.y, value.z] : null;
  if (!parts || parts.length !== 3 || !parts.every((item) => Number.isFinite(item))) {
    fail(`${what} must be [x, y, z] metres or {x, y, z}`, "spawn_placement_invalid");
  }
  return { x: parts[0], y: parts[1], z: parts[2] };
}

/** Encode one parameter value the way the compiler encodes a literal of that type. */
function encodeParameter(parameter, value) {
  const { name, value_type: type, unit, divisor } = parameter;
  if (type === "boolean") {
    if (typeof value !== "boolean") fail(`parameter '${name}' must be a boolean`, "spawn_parameter_invalid");
    return { literal: value };
  }
  if (type === "string" || type === "color") {
    if (typeof value !== "string") fail(`parameter '${name}' must be a string`, "spawn_parameter_invalid");
    return { literal: value };
  }
  if (!Number.isFinite(value)) fail(`parameter '${name}' must be a finite number`, "spawn_parameter_invalid");
  const encoded = Math.round(value * divisor);
  if (!Number.isSafeInteger(encoded)) fail(`parameter '${name}' is out of range`, "spawn_parameter_invalid");
  return { literal: encoded, ...(unit ? { unit } : {}) };
}

/** Replace every read of the fragment's parameter node with the literal the caller supplied. */
function substitute(value, paramsNode, literals) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, paramsNode, literals));
  if (!isPlainObject(value)) return value;
  if (value.ref?.segments?.[0] === paramsNode) {
    const literal = literals.get(value.ref.segments[1]);
    if (!literal) fail(`fragment reads undeclared parameter '${value.ref.segments[1]}'`, "spawn_parameter_invalid");
    return clone(literal);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, paramsNode, literals)]));
}

function containsRef(value) {
  if (Array.isArray(value)) return value.some(containsRef);
  if (!isPlainObject(value)) return false;
  if (value.ref) return true;
  return Object.values(value).some(containsRef);
}

function decode(result, expected) {
  if (expected.value_type === "vector3" || expected.value_type === "quaternion") {
    const axes = expected.value_type === "quaternion" ? ["x", "y", "z", "w"] : ["x", "y", "z"];
    return Object.fromEntries(axes.map((axis, index) => [axis, result.value[index].value / expected.divisor]));
  }
  if (expected.value_type === "scalar") return result.value / expected.divisor;
  return result.value;
}

/**
 * The scope one spawned fragment owns. It resolves its own nodes first and the mounted graph second,
 * so a fragment's binding can read the scene's logical properties without being able to install
 * anything into the scene's own ledger.
 */
class FragmentGraph {
  constructor(parent, handle) {
    this.parent = parent;
    this.handle = handle;
    this.components = new Map();
    this.owned = [];
    this.disposed = false;
  }

  own(id, component) {
    this.components.set(id, component);
    this.owned.push(component);
    return component;
  }

  ownBinding(id, component) { return this.own(id, component); }

  get(id) {
    const own = this.components.get(id);
    if (own) return own;
    return this.parent.get(id);
  }

  commitEventBatch(writes) { return this.parent.commitEventBatch(writes); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const component of [...this.owned].reverse()) {
      try { component?.dispose?.({ restore: false }); } catch (_) { /* keep releasing the rest */ }
    }
    this.owned.length = 0;
    this.components.clear();
  }
}

export class FragmentDirector {
  constructor(bridge, { fragments = {}, usage = {}, budgets = {}, globals = globalThis, onLog = null } = {}) {
    this.bridge = bridge;
    this.runtime = bridge.runtime;
    this.catalog = bridge.catalog;
    this.fragments = fragments;
    this.staticUsage = Object.fromEntries(BUDGET_KEYS.map((key) => [key, usage[key] || 0]));
    this.budgets = budgets;
    this.globals = globals;
    this.generation = bridge.generation;
    this.sequence = 0;
    this.handlerSequence = 0;
    // Called with the spawn log after every change, so the page can replay this world into the next
    // generation when the author saves a file. It is the only reason a hot reload does not empty a city.
    this.onLog = typeof onLog === "function" ? onLog : null;
    this.live = new Map();
    this.queue = [];
    this.installedThisFrame = 0;
    this.frameScheduled = false;
    this.replayFailures = [];
  }

  /** Object refs are node ids, so they move with the nodes when a fragment is installed under a prefix. */
  #objectRefProperties(type) {
    const members = this.catalog?.components?.[type]?.members || {};
    return new Set(Object.entries(members)
      .filter(([, member]) => member.value_type === "object_ref")
      .map(([name, member]) => member.runtime_property || name));
  }

  #assertActive() {
    if (this.generation !== this.bridge.generation) {
      fail(`stale generation ${this.generation}; active generation is ${this.bridge.generation}`,
        "scene_module_generation_stale");
    }
    if (!this.bridge.graph || this.bridge.graph.disposed) fail("no installed graph", "scene_graph_missing");
  }

  dynamicUsage() {
    const dynamic = Object.fromEntries(BUDGET_KEYS.map((key) => [key, 0]));
    for (const record of this.live.values()) {
      for (const key of BUDGET_KEYS) dynamic[key] += record.budget[key] || 0;
    }
    return dynamic;
  }

  usage() {
    const dynamic = this.dynamicUsage();
    const total = Object.fromEntries(BUDGET_KEYS.map((key) => [key, this.staticUsage[key] + dynamic[key]]));
    return {
      static: { ...this.staticUsage }, dynamic, total,
      limits: Object.fromEntries(BUDGET_KEYS.filter((key) => Number.isSafeInteger(this.budgets[key]))
        .map((key) => [key, this.budgets[key]])),
      spawned: this.live.size, queued: this.queue.length,
    };
  }

  #checkBudget(name, budget) {
    const ledger = this.usage();
    for (const key of BUDGET_KEYS) {
      const limit = ledger.limits[key];
      if (limit === undefined) continue;
      const after = ledger.total[key] + (budget[key] || 0);
      if (after <= limit) continue;
      fail(`spawning ${name} would take ${key} to ${after} (limit ${limit}; ${ledger.static[key]} static + ${ledger.dynamic[key]} already spawned); dispose something first or raise the budget in showcase.manifest.json`,
        "spawn_budget");
    }
  }

  #resolveParameters(fragment, params) {
    const supplied = isPlainObject(params) ? params : {};
    const declared = new Map(fragment.parameters.map((item) => [item.name, item]));
    for (const name of Object.keys(supplied)) {
      if (!declared.has(name)) {
        fail(`${fragment.name} has no parameter '${name}' (it declares ${fragment.parameters.map((item) => item.name).join(", ") || "none"})`,
          "spawn_parameter_invalid");
      }
    }
    const values = new Map(), literals = new Map();
    for (const parameter of fragment.parameters) {
      const value = Object.hasOwn(supplied, parameter.name) ? supplied[parameter.name] : parameter.default;
      literals.set(parameter.name, encodeParameter(parameter, value));
      values.set(parameter.name, value);
    }
    return { values, literals };
  }

  /** Build the installable node/binding set for one spawn: ids prefixed, parameters folded in. */
  #materialize(fragment, handle, literals, parentId) {
    const prefix = `${handle}/`;
    const own = new Set(fragment.nodes.map((node) => node.id));
    const rename = (id) => (own.has(id) ? prefix + id : id);
    const nodes = fragment.nodes.map((node) => {
      const refs = this.#objectRefProperties(node.type);
      return {
        ...node,
        id: prefix + node.id,
        parent: node.id === fragment.root ? parentId : rename(node.parent),
        properties: (node.properties || []).map((item) => (refs.has(item.property) && typeof item.value === "string"
          ? { ...item, value: rename(item.value) } : clone(item))),
        ...(node.handlers ? {
          handlers: node.handlers.map((handler) => ({
            signal: handler.signal,
            actions: handler.actions.map((action) => {
              const next = substitute(clone(action), fragment.params_node, literals);
              if (next.target?.node) next.target = { ...next.target, node: rename(next.target.node) };
              return this.#renameRefs(next, own, prefix);
            }),
          })),
        } : {}),
      };
    });
    const bindings = fragment.bindings.map((binding) => {
      const next = substitute(clone(binding), fragment.params_node, literals);
      return {
        ...next,
        id: prefix + next.id,
        target: { ...next.target, node: rename(next.target.node) },
        expression: this.#renameRefs(next.expression, own, prefix),
        when: this.#renameRefs(next.when, own, prefix),
        dependencies: (next.dependencies || []).map((item) => ({ ...item, node: rename(item.node) })),
        ...(next.when_dependencies ? { when_dependencies: next.when_dependencies.map((item) => ({ ...item, node: rename(item.node) })) } : {}),
      };
    });
    const slots = fragment.parameter_slots.map((slot) => ({
      ...slot, node: prefix + slot.node,
      expression: this.#renameRefs(substitute(clone(slot.expression), fragment.params_node, literals), own, prefix),
    }));
    return { nodes, bindings, slots, prefix };
  }

  #renameRefs(value, own, prefix) {
    if (Array.isArray(value)) return value.map((item) => this.#renameRefs(item, own, prefix));
    if (!isPlainObject(value)) return value;
    if (value.ref?.segments && own.has(value.ref.segments[0])) {
      return { ...value, ref: { ...value.ref, segments: [prefix + value.ref.segments[0], ...value.ref.segments.slice(1)] } };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#renameRefs(item, own, prefix)]));
  }

  /** Fold the parameter expressions that are now pure literals into the node property values. */
  #applySlots(nodes, slots) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const slot of slots) {
      // A slot whose expression still reads a node is also carried by a binding; the binding sets it
      // on the first commit, so the compiled default stands until then rather than being guessed at.
      if (containsRef(slot.expression)) continue;
      const node = byId.get(slot.node);
      const property = node?.properties.find((item) => item.property === slot.property);
      if (!property) continue;
      property.value = decode(this.runtime.expressionEvaluate(slot.expression, () => {
        fail("a fragment parameter expression escaped literal folding", "spawn_parameter_invalid");
      }), slot.expected);
    }
  }

  #install(record) {
    const fragment = record.fragment;
    const { nodes, bindings, slots, prefix } = this.#materialize(fragment, record.handle, record.literals, record.parentNodeId);
    this.#applySlots(nodes, slots);
    const placementNodes = record.parentNodeId && record.parentComponent
      ? [{ id: record.parentNodeId, type: "Group", parent: null, properties: [] }, ...nodes] : nodes;
    const graph = new FragmentGraph(this.bridge.graph, record.handle);
    if (record.parentNodeId && record.parentComponent) graph.components.set(record.parentNodeId, record.parentComponent);
    const sceneIR = { ir_version: "SceneIR/5", coordinate_system: fragment.coordinate_system,
      scope_id: record.handle, logical_properties: [], nodes: placementNodes };
    try {
      const installed = installComponentsSync(this.bridge, graph, sceneIR, this.catalog);
      if (record.parentNodeId && record.parentComponent) graph.components.delete(record.parentNodeId);
      this.bridge.installFragmentBindings(graph, bindings);
      const batch = this.runtime.commit();
      if (batch?.ok === false) fail(`spawning ${fragment.name} failed its first binding batch`, "scene_binding_failed");
      installed.start();
      record.graph = graph;
      record.nodeIds = nodes.map((node) => node.id);
      record.root = graph.get(prefix + fragment.root);
      record.slots = slots;
      record.queued = false;
      this.#applyPlacement(record);
      return record;
    } catch (error) {
      graph.dispose();
      this.live.delete(record.handle);
      throw error;
    }
  }

  #applyPlacement(record) {
    const writes = [];
    if (record.placement.at !== undefined) writes.push({ target: record.root, property: "transform.position", value: vector3(record.placement.at, "placement.at") });
    if (record.placement.heading !== undefined) {
      if (!Number.isFinite(record.placement.heading)) fail("placement.heading must be a number of degrees", "spawn_placement_invalid");
      writes.push({ target: record.root, property: "transform.rotation", value: headingQuaternion(record.placement.heading) });
    }
    if (record.placement.visible !== undefined) writes.push({ target: record.root, property: "visible", value: record.placement.visible === true });
    if (!writes.length) return null;
    const receipt = this.bridge.commitEventBatch(writes);
    if (!receipt.ok) fail(`placing ${record.fragment.name} was refused and rolled back (${receipt.status})`, "spawn_placement_invalid");
    return receipt;
  }

  #scheduleDrain() {
    if (this.frameScheduled) return;
    this.frameScheduled = true;
    const run = () => {
      this.frameScheduled = false;
      this.installedThisFrame = 0;
      this.#drain();
    };
    if (typeof this.globals.requestAnimationFrame === "function") this.globals.requestAnimationFrame(run);
    else this.globals.setTimeout(run, 0);
  }

  #drain() {
    while (this.queue.length && this.installedThisFrame < MAX_SPAWNS_PER_FRAME) {
      const record = this.queue.shift();
      if (!this.live.has(record.handle)) continue;
      this.installedThisFrame += 1;
      try { this.#install(record); }
      catch (error) {
        this.replayFailures.push({ code: error.code || "spawn_failed", name: record.fragment.name,
          handle: record.handle, message: String(error.message).slice(0, 500) });
      }
    }
    if (this.queue.length) this.#scheduleDrain();
  }

  /** Flush every queued spawn now, ignoring the per-frame limit. Tests and snapshots need a settled scene. */
  flush() {
    while (this.queue.length) {
      this.installedThisFrame = 0;
      this.#drain();
    }
    return this.live.size;
  }

  spawn(name, params = {}, placement = {}) {
    this.#assertActive();
    const fragment = this.fragments[name];
    if (!fragment) {
      fail(`no spawnable component named '${name}' (this project compiles ${Object.keys(this.fragments).join(", ") || "none"}); add 'pragma spawnable' to the top of ${name}.ssdl`,
        "spawn_unknown_fragment");
    }
    if (!isPlainObject(placement)) fail("placement must be an object", "spawn_placement_invalid");
    const { values, literals } = this.#resolveParameters(fragment, params);
    this.#checkBudget(name, fragment.budget);
    const handle = `spawn:${name}#${++this.sequence}`;
    let parentNodeId = null, parentComponent = null;
    if (placement.parent !== undefined && placement.parent !== null) {
      parentComponent = this.#resolve(placement.parent);
      parentNodeId = `${handle}/$parent`;
    }
    const record = { handle, name, fragment, literals, params: Object.fromEntries(values),
      placement: { ...placement }, tag: placement.tag ?? null, parentNodeId, parentComponent,
      budget: fragment.budget, graph: null, queued: false };
    this.live.set(handle, record);
    if (this.installedThisFrame >= MAX_SPAWNS_PER_FRAME) {
      record.queued = true;
      this.queue.push(record);
      this.#scheduleDrain();
      this.#noteLog();
      return Object.freeze({ handle, budget: { ...fragment.budget }, queued: true });
    }
    this.installedThisFrame += 1;
    this.#scheduleDrain();
    this.#install(record);
    this.#noteLog();
    return Object.freeze({ handle, budget: { ...fragment.budget }, queued: false });
  }

  /** A handle, a live fragment root, or a node id of the mounted scene. */
  #resolve(target) {
    if (typeof target === "string" && this.live.has(target)) {
      const record = this.live.get(target);
      if (!record.root) fail(`fragment '${target}' has not been installed yet; it is still queued`, "spawn_handle_unknown");
      return record.root;
    }
    if (typeof target === "string") {
      try { return this.bridge.graph.get(target); }
      catch (_) { fail(`'${target}' is neither a spawn handle nor a node of this scene`, "spawn_handle_unknown"); }
    }
    fail("expected a spawn handle or a node id", "spawn_handle_unknown");
  }

  #record(handle) {
    const record = this.live.get(handle);
    if (!record) fail(`unknown spawn handle '${handle}'`, "spawn_handle_unknown");
    return record;
  }

  dispose(handle) {
    if (!this.live.has(handle)) return false;
    this.#assertActive();
    const record = this.live.get(handle);
    this.live.delete(handle);
    const queued = this.queue.indexOf(record);
    if (queued >= 0) this.queue.splice(queued, 1);
    record.graph?.dispose();
    this.#noteLog();
    return true;
  }

  move(handle, placement = {}) {
    this.#assertActive();
    const record = this.#record(handle);
    Object.assign(record.placement, placement);
    this.#noteLog();
    if (!record.graph) return Object.freeze({ ok: true, queued: true });
    const receipt = this.#applyPlacement({ ...record, placement });
    return Object.freeze({ ok: true, queued: false, receipt });
  }

  /** Every move in one transaction: 300 cars step together or none of them do. */
  moveBatch(items) {
    this.#assertActive();
    if (!Array.isArray(items)) fail("moveBatch needs a list of { handle, at?, heading?, visible? }", "spawn_placement_invalid");
    const writes = [];
    for (const item of items) {
      const record = this.#record(item?.handle);
      Object.assign(record.placement, item);
      if (!record.graph) continue;
      if (item.at !== undefined) writes.push({ target: record.root, property: "transform.position", value: vector3(item.at, "moveBatch at") });
      if (item.heading !== undefined) {
        if (!Number.isFinite(item.heading)) fail("moveBatch heading must be a number of degrees", "spawn_placement_invalid");
        writes.push({ target: record.root, property: "transform.rotation", value: headingQuaternion(item.heading) });
      }
      if (item.visible !== undefined) writes.push({ target: record.root, property: "visible", value: item.visible === true });
    }
    this.#noteLog();
    if (!writes.length) return Object.freeze({ ok: true, moved: 0 });
    const receipt = this.bridge.commitEventBatch(writes);
    if (!receipt.ok) fail(`moveBatch was refused and rolled back (${receipt.status})`, "spawn_placement_invalid");
    return Object.freeze({ ok: true, moved: items.length, receipt });
  }

  /** A tap on any node of one spawned fragment. The root is a Group, which the picker never returns,
   *  so the pick is unfiltered and attributed by the handle prefix every node of the fragment carries. */
  onTap(handle, listener) { return this.#attach(handle, listener, "createTapHandler", "onTapped"); }

  onHover(handle, listener) { return this.#attach(handle, listener, "createHoverHandler", "onHoveredChanged"); }

  #attach(handle, listener, factory, signal) {
    this.#assertActive();
    const record = this.#record(handle);
    if (!record.graph) fail(`fragment '${handle}' is still queued; attach the listener after it lands`, "spawn_handle_unknown");
    if (typeof listener !== "function") fail(`${signal} needs a function`, "spawn_handle_unknown");
    const id = `${handle}/${signal}#${++this.handlerSequence}`;
    const owned = record.graph.own(id, this.runtime[factory]({
      id, root: this.bridge.interactionRoot,
      [signal]: (event) => {
        const target = event?.target ?? event?.eventPoint?.target ?? null;
        if (signal === "onHoveredChanged" && !event?.hovered) { listener(event); return; }
        if (typeof target === "string" && target.startsWith(`${handle}/`)) listener(event);
      },
    }));
    return () => { try { owned.dispose(); } catch (_) { /* already released with the fragment */ } };
  }

  #noteLog() {
    if (!this.onLog) return;
    try { this.onLog(this.snapshot()); } catch (_) { /* the log is a convenience, never a failure path */ }
  }

  setVisible(handle, visible) {
    if (typeof visible !== "boolean") fail("setVisible needs a boolean", "spawn_placement_invalid");
    return this.move(handle, { visible });
  }

  set(handle, name, value) {
    this.#assertActive();
    const record = this.#record(handle);
    const parameter = record.fragment.parameters.find((item) => item.name === name);
    if (!parameter) fail(`${record.fragment.name} has no parameter '${name}'`, "spawn_parameter_invalid");
    if (!parameter.mutable) {
      fail(`${record.fragment.name}.${name} is a create-time parameter: it feeds a member the engine reads once when the node is built (or an expression baked in at spawn), so changing it means dispose + spawn`,
        "spawn_parameter_immutable");
    }
    record.literals.set(name, encodeParameter(parameter, value));
    record.params[name] = value;
    this.#noteLog();
    if (!record.graph) return Object.freeze({ ok: true, queued: true });
    const { slots } = this.#materialize(record.fragment, record.handle, record.literals, record.parentNodeId);
    const writes = [];
    for (const slot of slots) {
      if (slot.create_only || containsRef(slot.expression)) continue;
      const evaluated = decode(this.runtime.expressionEvaluate(slot.expression, () => {
        fail("a fragment parameter expression escaped literal folding", "spawn_parameter_invalid");
      }), slot.expected);
      writes.push({ target: record.graph.get(slot.node), property: slot.property, value: evaluated });
    }
    if (!writes.length) return Object.freeze({ ok: true, queued: false, changed: 0 });
    const receipt = this.bridge.commitEventBatch(writes);
    if (!receipt.ok) fail(`${record.fragment.name}.${name} was refused and rolled back (${receipt.status})`, "spawn_parameter_invalid");
    return Object.freeze({ ok: true, queued: false, changed: writes.length });
  }

  list({ tag } = {}) {
    return [...this.live.values()]
      .filter((record) => tag === undefined || record.tag === tag)
      .map((record) => Object.freeze({ handle: record.handle, name: record.name, tag: record.tag,
        queued: record.queued, params: { ...record.params },
        placement: clone(record.placement), budget: { ...record.budget } }));
  }

  /** The spawn log: what to replay to rebuild this world in a fresh generation. No handles in it. */
  snapshot() {
    return [...this.live.values()].map((record) => ({
      name: record.name, params: { ...record.params }, placement: clone(record.placement),
    }));
  }

  restore(log) {
    if (!Array.isArray(log)) fail("restore needs the array snapshot() returns", "spawn_replay_failed");
    const failures = [];
    for (const entry of log) {
      try { this.spawn(entry?.name, entry?.params, entry?.placement); }
      catch (error) {
        failures.push({ code: error.code || "spawn_replay_failed", name: entry?.name,
          message: String(error?.message).slice(0, 500) });
      }
    }
    this.replayFailures.push(...failures);
    this.#noteLog();
    return Object.freeze({ replayed: log.length - failures.length, failures: Object.freeze(failures) });
  }

  disposeAll() {
    for (const handle of [...this.live.keys()]) {
      const record = this.live.get(handle);
      this.live.delete(handle);
      record.graph?.dispose();
    }
    this.queue.length = 0;
  }
}
