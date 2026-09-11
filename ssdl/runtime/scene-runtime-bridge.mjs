import { installComponents } from './scene-component-installer.mjs';

function invariant(condition, message, code = "scene_runtime_invalid") {
  if (condition) return;
  throw Object.assign(new Error(message), { code });
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class PropertyBridge {
  constructor(runtime) {
    this.runtime = runtime;
    this.anchor = runtime.anchor;
    this.sequence = 0;
  }

  captureBatch(items) {
    return Object.freeze({
      schema_version: "PropertyCaptureReceipt/v1",
      capture_id: ++this.sequence,
      items: items.map(({ target, property }) => ({
        target,
        property,
        value: clone(this.runtime.readLogical(target, property)),
      })),
    });
  }

  writeBatch(capture, writes) {
    const facts = [];
    try {
      for (const write of writes) {
        const before = capture.items.find((item) => item.target === write.target
          && item.property === write.property);
        invariant(before, "writeBatch target was not captured", "property_batch_uncaptured");
        const result = this.runtime.writeProperty(write.target, write.property, write.value);
        invariant(result?.ok !== false, result?.message || "native property write was refused",
          result?.error_code || "property_batch_write_refused");
        facts.push({ target: write.target.id, property: write.property,
          old_value: before.value, new_value: clone(write.value), native_applied: result?.ok !== false });
      }
      return Object.freeze({ ok: true, status: "committed", items: facts });
    } catch (error) {
      let restored = true;
      for (const fact of [...facts].reverse()) {
        const original = capture.items.find((item) => item.target.id === fact.target
          && item.property === fact.property);
        try { this.runtime.writeProperty(original.target, original.property, original.value); }
        catch (_) { restored = false; }
      }
      return Object.freeze({
        ok: false,
        status: restored ? "restored" : "recovery_required",
        error_code: error.code || "property_batch_failed",
        items: facts,
      });
    }
  }

  readbackBatch(items) {
    return Object.freeze(items.map(({ target, property }) => ({
      target: target.id,
      property,
      logical: clone(this.runtime.readLogical(target, property)),
      presentation: clone(this.runtime.readProperty(target, property)),
    })));
  }

  restoreBatch(capture, appliedItems = capture.items) {
    return this.writeBatch(this.captureBatch(appliedItems),
      appliedItems.map((item) => ({ target: item.target, property: item.property, value: item.value })));
  }
}

class InstalledGraph {
  constructor(bridge, sceneIR, bindingIR, metadata) {
    this.bridge = bridge;
    this.sceneIR = sceneIR;
    this.bindingIR = bindingIR;
    this.metadata = metadata;
    this.components = new Map();
    this.owned = [];
    this.bindingOwned = [];
    this.bindingGeneration = 1;
    this.lastBatch = null;
    this.disposed = false;
  }

  own(id, component) {
    this.components.set(id, component);
    this.owned.push(component);
    return component;
  }

  ownBinding(id, component) {
    this.components.set(id, component);
    this.owned.push(component);
    this.bindingOwned.push({ id, component });
    return component;
  }

  disposeBindings() {
    for (const { id, component } of [...this.bindingOwned].reverse()) {
      try { component?.dispose?.({ restore: false }); } catch (_) {}
      if (this.components.get(id) === component) this.components.delete(id);
      const index = this.owned.indexOf(component);
      if (index >= 0) this.owned.splice(index, 1);
    }
    this.bindingOwned.length = 0;
  }

  get(id) {
    const component = this.components.get(id);
    invariant(component, `unknown SceneIR node '${id}'`, "unknown_reference");
    return component;
  }

  commitEventBatch(writes) {
    this.lastBatch = this.bridge.commitEventBatch(writes);
    return this.lastBatch;
  }

  snapshot() {
    return {
      ok: !this.disposed,
      schema_version: "SceneRuntimeSnapshot/1",
      execution_profile: this.bridge.executionProfile,
      scope_id: this.bridge.scopeId,
      generation: this.bridge.generation,
      binding_generation: this.bindingGeneration,
      scene_ir_digest: this.bridge.sceneIRDigest,
      binding_ir_digest: this.bridge.bindingIRDigest,
      nodes: [...this.components].map(([id, component]) => ({
        id,
        component_type: component.component_type || component.constructor?.name || "component",
      })),
      last_batch: clone(this.lastBatch),
      runtime: this.bridge.runtime.snapshot(),
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const component of [...this.owned].reverse()) {
      try { component?.dispose?.({ restore: false }); } catch (_) {}
    }
    this.owned.length = 0;
    this.components.clear();
  }
}

function properties(node) {
  return Object.fromEntries(node.properties.map((item) => [item.property, clone(item.value)]));
}

export class SceneRuntimeBridge {
  constructor(runtime, options = {}) {
    invariant(runtime && typeof runtime.createBox === "function", "SceneRuntimeBridge needs an SSDL built-in runtime");
    this.runtime = runtime;
    this.anchor = runtime.anchor;
    this.scopeId = options.scopeId || "scene-module";
    this.generation = options.generation || 1;
    this.executionProfile = options.executionProfile || "trusted-local";
    this.sceneIRDigest = options.sceneIRDigest || null;
    this.bindingIRDigest = options.bindingIRDigest || null;
    this.propertyBridge = new PropertyBridge(runtime);
    this.batchSequence = 0;
    this.graph = null;
    this.interactionRoot = options.interactionRoot || null;
    this.catalog = options.catalog || runtime.builtinCatalog || null;
    // Host logic reachable from SSDL `Iface.method(arg: expr)` actions; validated against the
    // scene's host_interfaces contract when the graph is installed, never evaluated as code.
    this.hostInterfaces = options.hostInterfaces || null;
    this.hostCallErrors = [];
    // Binding failures the runtime reports (a binding whose value the target refused, or a flush that
    // threw): kept per generation so pages and tools can show why a batch rolled back instead of
    // silently freezing. options.onBindingError receives each enriched entry as it happens.
    this.bindingErrors = [];
    this.onBindingError = typeof options.onBindingError === "function" ? options.onBindingError : null;
    this.unsubscribeBindingError = typeof runtime.on === "function"
      ? runtime.on("bindingerror", (detail) => this.#noteBindingError(detail)) : null;
  }

  #noteBindingError(detail = {}) {
    const binding = detail.binding !== null && detail.binding !== undefined && typeof this.runtime.bindings?.get === "function"
      ? this.runtime.bindings.get(detail.binding) : null;
    let target = null, property = null;
    try { target = binding ? this.runtime.ownerId(binding.target) ?? null : null; property = binding?.property ?? null; } catch (_) {}
    const entry = {
      binding: detail.binding ?? null, target, property,
      code: detail.code || detail.error?.code || "binding_failed",
      message: String(detail.error?.message || detail.error || detail.code || "binding failed").slice(0, 500),
      generation: this.generation, at: Date.now(),
    };
    if (this.bindingErrors.length >= 20) this.bindingErrors.shift();
    this.bindingErrors.push(entry);
    if (this.onBindingError) { try { this.onBindingError(entry); } catch (_) {} }
    return entry;
  }

  /** Bindings the runtime marked invalid (their last value was refused; the batch that carried it was rolled back). */
  invalidBindings() {
    const out = [];
    if (typeof this.runtime.bindings?.values !== "function") return out;
    for (const binding of this.runtime.bindings.values()) {
      if (binding?.disposed || binding?.state !== "invalid") continue;
      let target = null;
      try { target = this.runtime.ownerId(binding.target) ?? null; } catch (_) {}
      const lastError = [...this.bindingErrors].reverse().find((item) => item.binding === binding.id) || null;
      out.push({ id: binding.id, target, property: binding.property ?? null, expression_digest: binding.expression_digest ?? null,
        ...(lastError ? { code: lastError.code, message: lastError.message } : {}) });
    }
    return out;
  }

  /** Throws host_interface_missing unless every declared interface method is implemented by the page. */
  assertHostInterfaces(declared) {
    for (const [name, iface] of Object.entries(declared || {})) {
      const implementation = this.hostInterfaces?.[name];
      invariant(implementation && typeof implementation === "object",
        `scene declares host interface '${name}' but the page provided no implementation (SceneRuntimeBridge option hostInterfaces.${name})`,
        "host_interface_missing");
      for (const method of Object.keys(iface.methods || {})) {
        invariant(typeof implementation[method] === "function",
          `scene declares host interface method '${name}.${method}' but the page implementation has no such function`,
          "host_interface_missing");
      }
    }
  }

  /** Runs one compiled call action against the page implementation; errors are recorded and re-thrown. */
  invokeHost(action, args) {
    const implementation = this.hostInterfaces?.[action.interface]?.[action.method];
    invariant(typeof implementation === "function",
      `host interface ${action.interface}.${action.method} is not implemented`, "host_interface_missing");
    try {
      implementation(args);
    } catch (error) {
      if (this.hostCallErrors.length >= 20) this.hostCallErrors.shift();
      this.hostCallErrors.push({ interface: action.interface, method: action.method, args: clone(args),
        message: String(error?.message || error).slice(0, 500), generation: this.generation, at: Date.now() });
      throw Object.assign(new Error(`host call ${action.interface}.${action.method} failed: ${error?.message || error}`),
        { code: "host_call_failed", cause: error });
    }
  }

  /** Logical state of the installed graph: declared scene properties, State.when values, host call errors. */
  logicalState() {
    const properties = {}, states = {};
    for (const [id, component] of this.graph?.components || []) {
      if (component?.component_type === "LogicalPropertyBag") {
        for (const [name] of Object.entries(component.values || {})) properties[name] = clone(this.runtime.readLogical(component, name));
      } else if (component?.component_type === "State") {
        states[id] = clone(this.runtime.readLogical(component, "when"));
      }
    }
    const invalid = this.invalidBindings();
    return { scope_id: this.scopeId, generation: this.generation, properties, states, host_call_errors: this.hostCallErrors.slice(),
      bindings: { total: typeof this.runtime.bindings?.size === "number" ? this.runtime.bindings.size : null, invalid },
      binding_errors: this.bindingErrors.slice() };
  }

  /** Writes one declared scene property through the event transaction (rejected values leave the scene untouched). */
  writeLogical(property, value) {
    return this.writeLogicalBatch({ [property]: value });
  }

  /** Writes several declared scene properties in ONE event transaction; a refused value rolls back all of them. */
  writeLogicalBatch(values) {
    invariant(this.graph && !this.graph.disposed, "no installed graph", "scene_graph_missing");
    invariant(values && typeof values === "object" && !Array.isArray(values), "writeLogicalBatch needs {property: value}", "logical_write_invalid");
    const names = Object.keys(values);
    invariant(names.length > 0, "writeLogicalBatch needs at least one property", "logical_write_invalid");
    const receipt = this.commitEventBatch(names.map((property) => ({ target: this.graph.sceneIR.scope_id, property, value: values[property] })));
    if (!receipt.ok) {
      const failure = receipt.failure;
      const where = failure?.target ? ` on ${failure.target}.${failure.property}` : "";
      throw Object.assign(new Error(`logical write ${names.join(", ")} was rejected and rolled back (${receipt.status}${failure ? `: ${failure.code}${where}: ${failure.message}` : ""})`),
        { code: "logical_write_rejected", receipt });
    }
    return receipt;
  }

  #installBindings(graph, bindingIR) {
    for (const item of bindingIR.bindings) {
      for (const dependency of [...(item.dependencies || []), ...(item.when_dependencies || [])]) {
        this.runtime.ensureLogicalSlot(graph.get(dependency.node), dependency.property);
      }
    }
    for (const item of bindingIR.bindings) {
      const binding = graph.ownBinding(item.id, this.runtime.createBinding({
        id: item.id,
        target: graph.get(item.target.node),
        property: item.target.property,
        expression: item.expression,
        when: typeof item.when?.literal === "boolean" ? item.when.literal : false,
      }));
      if (typeof item.when?.literal !== "boolean") {
        graph.ownBinding(`${item.id}$when`, this.runtime.createBinding({
          id: `${item.id}$when`,
          target: binding,
          property: "when",
          expression: item.when,
        }));
      }
    }
  }

  async installGraph(sceneIR, bindingIR, { metadata } = {}) {
    invariant(sceneIR?.ir_version === "SceneIR/5", "SceneRuntimeBridge requires SceneIR/5");
    invariant(bindingIR?.schema_version === "BindingIR/2", "SceneRuntimeBridge requires BindingIR/2");
    invariant(sceneIR.scope_id === bindingIR.scope_id, "SceneIR and BindingIR scope mismatch");
    invariant(!this.graph || this.graph.disposed, "this generation already has an installed graph",
      "scene_graph_already_installed");
    const graph = new InstalledGraph(this, sceneIR, bindingIR, metadata);
    this.graph = graph;
    const root = sceneIR.nodes.find((node) => node.type === "Scene");
    invariant(root, "SceneIR/5 root Scene is missing");
    this.assertHostInterfaces(sceneIR.host_interfaces);
    graph.own(root.id, this.runtime.createScene({ id: root.id, key: `${root.id}:${this.generation}` }));
    if (sceneIR.logical_properties?.length) {
      const bag = this.runtime.createPropertyBag({
        id: root.id,
        properties: Object.fromEntries(sceneIR.logical_properties.map((item) => [item.property, item])),
      });
      graph.components.set(root.id, bag);
      graph.owned.push(bag);
    }
    if (this.catalog?.components?.Sphere?.factory) {
      const installed = await installComponents(this, graph, sceneIR, this.catalog);
      this.#installBindings(graph, bindingIR);
      graph.lastBatch = this.runtime.commit();
      if (this.runtime.pendingBindings?.size) graph.lastBatch = this.runtime.commit();
      invariant(graph.lastBatch?.ok !== false, `Initial SSDL bindings failed: ${JSON.stringify(this.runtime.lastPropertyBridgeReceipt || graph.lastBatch)}`, 'scene_binding_failed');
      installed.start();
      return graph;
    }
    for (const node of sceneIR.nodes.filter((item) => item.type === "State")) {
      const value = properties(node);
      graph.own(node.id, this.runtime.createState({
        id: node.id, name: value.name || node.id, when: value.when ?? false,
      }));
    }
    for (const node of sceneIR.nodes.filter((item) => item.type === "Box")) {
      const value = properties(node);
      graph.own(node.id, this.runtime.createBox({
        id: node.id,
        params: { width: value.width, depth: value.depth, height: value.height },
        position: value["transform.position"] || { x: 0, y: 0, z: value.height / 2 },
        color: value["material.color"],
        opacity: value["material.opacity"],
      }));
    }
    for (const node of sceneIR.nodes.filter((item) => item.type === "Behavior")) {
      const value = properties(node), target = graph.get(value.target);
      graph.own(node.id, this.runtime.createBehavior({
        id: node.id,
        target,
        property: value.property,
        enabled: value.enabled ?? true,
        animation: {
          type: value.property === "transform.position" ? "Vector3dAnimation" : "NumberAnimation",
          duration: value.duration ?? 250,
          easing: { type: value.easing || "Easing.OutCubic" },
        },
      }));
    }
    this.#installBindings(graph, bindingIR);
    graph.lastBatch = this.runtime.commit();
    if (this.runtime.pendingBindings?.size) graph.lastBatch = this.runtime.commit();
    return graph;
  }

  canReplaceBindings(sceneIR, bindingIR) {
    if (!this.graph || this.graph.disposed || sceneIR?.ir_version !== "SceneIR/5"
        || bindingIR?.schema_version !== "BindingIR/2"
        || sceneIR.scope_id !== this.graph.sceneIR.scope_id
        || bindingIR.scope_id !== sceneIR.scope_id) return false;
    const targets = (value) => [...new Set(value.bindings.map((item) =>
      `${item.target.node}\u0000${item.target.property}`))].sort();
    if (!equalJson(targets(this.graph.bindingIR), targets(bindingIR))) return false;
    const strip = (value) => ({
      ir_version: value.ir_version,
      coordinate_system: value.coordinate_system,
      scope_id: value.scope_id,
      logical_properties: value.logical_properties,
      nodes: value.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        parent: node.parent,
        handlers: node.handlers,
        source_order: node.source_order,
        properties: node.properties.filter((item) =>
          !targets(bindingIR).includes(`${node.id}\u0000${item.property}`)),
      })),
    });
    return equalJson(strip(this.graph.sceneIR), strip(sceneIR));
  }

  replaceBindings(bindingIR, options = {}) {
    invariant(this.graph && !this.graph.disposed, "no active graph can accept binding replacement",
      "scene_graph_inactive");
    invariant(bindingIR?.schema_version === "BindingIR/2", "SceneRuntimeBridge requires BindingIR/2");
    invariant(bindingIR.scope_id === this.graph.sceneIR.scope_id, "BindingIR scope mismatch");
    invariant(options.expectedGeneration === undefined || options.expectedGeneration === this.generation,
      `stale generation ${options.expectedGeneration}; active generation is ${this.generation}`,
      "scene_module_generation_stale");
    const previous = this.graph.bindingIR;
    this.graph.disposeBindings();
    try {
      this.#installBindings(this.graph, bindingIR);
      let batch = this.runtime.commit();
      if (this.runtime.pendingBindings?.size) batch = this.runtime.commit();
      invariant(batch?.ok !== false, "replacement binding batch failed",
        batch?.error_code || "binding_replace_failed");
      this.graph.bindingIR = bindingIR;
      if (options.sceneIR) this.graph.sceneIR = options.sceneIR;
      this.graph.bindingGeneration += 1;
      this.graph.lastBatch = batch;
      this.sceneIRDigest = options.sceneIRDigest || this.sceneIRDigest;
      this.bindingIRDigest = options.bindingIRDigest || this.bindingIRDigest;
      return Object.freeze({
        schema_version: "BindingReplaceReceipt/1",
        ok: true,
        status: "committed",
        scope_id: this.scopeId,
        generation: this.generation,
        binding_generation: this.graph.bindingGeneration,
        native_nodes_reused: this.graph.sceneIR.nodes.filter((item) => item.type === "Box").length,
        batch: clone(batch),
      });
    } catch (error) {
      this.graph.disposeBindings();
      let restored = false;
      try {
        this.#installBindings(this.graph, previous);
        let restoreBatch = this.runtime.commit();
        if (this.runtime.pendingBindings?.size) restoreBatch = this.runtime.commit();
        restored = restoreBatch?.ok !== false;
        this.graph.lastBatch = restoreBatch;
      } catch (_) {}
      throw Object.assign(error, {
        bindingReplaceReceipt: Object.freeze({
          schema_version: "BindingReplaceReceipt/1",
          ok: false,
          status: restored ? "restored" : "recovery_required",
          scope_id: this.scopeId,
          generation: this.generation,
          binding_generation: this.graph.bindingGeneration,
          error_code: error.code || "binding_replace_failed",
        }),
      });
    }
  }

  commitEventBatch(writes, expectedGeneration = this.generation) {
    invariant(Array.isArray(writes), "commitEventBatch writes must be an array");
    invariant(expectedGeneration === this.generation,
      `stale generation ${expectedGeneration}; active generation is ${this.generation}`,
      "scene_module_generation_stale");
    const resolved = writes.map((item) => ({
      target: typeof item.target === "string" ? this.graph.get(item.target) : item.target,
      property: item.property,
      value: item.value,
    }));
    const capture = this.propertyBridge.captureBatch(resolved);
    const errorsBefore = this.bindingErrors.length;
    const writeReceipt = this.propertyBridge.writeBatch(capture, resolved);
    const bindingReceipt = writeReceipt.ok ? this.runtime.commit()
      : { ok: false, evaluated: 0, committed: 0, failed: 1 };
    const bindingPropertyReceipt = clone(this.runtime.lastPropertyBridgeReceipt) || null;
    let restoreReceipt = null;
    if (writeReceipt.ok && !bindingReceipt.ok) {
      restoreReceipt = this.propertyBridge.restoreBatch(capture);
    }
    const ok = writeReceipt.ok && bindingReceipt.ok;
    // Status names what happened to the AUTHOR's writes, never the restore batch's own outcome
    // (0.7.2 reported "committed" for a rolled-back write because the restore had committed).
    const status = ok ? "committed"
      : !writeReceipt.ok ? writeReceipt.status
      : restoreReceipt?.ok ? "rolled_back" : "recovery_required";
    const newErrors = this.bindingErrors.slice(errorsBefore);
    const failure = ok ? null : newErrors.length
      ? { ...newErrors[newErrors.length - 1], phase: "bindings" }
      : !writeReceipt.ok
        ? { code: writeReceipt.error_code || "property_batch_failed", phase: "write", target: null, property: null,
          message: `a native property write was refused (${writeReceipt.error_code || "property_batch_failed"})` }
        : { code: bindingPropertyReceipt?.error_code || "binding_commit_failed", phase: "bindings", target: null, property: null,
          message: "a binding refused its new value; see property_batch.items" };
    return Object.freeze({
      schema_version: "FrameCoordinatorReceipt/1",
      batch_id: ++this.batchSequence,
      t0: Date.now(),
      scope_id: this.scopeId,
      generation: this.generation,
      status,
      ok,
      evaluated: bindingReceipt.evaluated || 0,
      changed: writeReceipt.items.length + (bindingPropertyReceipt?.items?.length || 0),
      committed: bindingReceipt.committed || 0,
      verified: ok
        ? writeReceipt.items.length + (bindingPropertyReceipt?.verified || 0)
        : 0,
      items: [...writeReceipt.items, ...(bindingPropertyReceipt?.items || [])],
      property_batch: bindingPropertyReceipt,
      restore: restoreReceipt,
      failure,
      binding_errors: newErrors,
    });
  }

  get(id) { return this.graph.get(id); }
  createTapHandler(spec) { return this.runtime.createTapHandler(spec); }
  createCamera(spec) { return this.runtime.createCamera(spec); }
  createCameraView(spec) { return this.runtime.createCameraView(spec); }
  readLogical(target, property) { return this.runtime.readLogical(target, property); }
  readProperty(target, property) { return this.runtime.readProperty(target, property); }
  snapshot() { return this.runtime.snapshot(); }
  dispose() {
    if (this.unsubscribeBindingError) { try { this.unsubscribeBindingError(); } catch (_) {} this.unsubscribeBindingError = null; }
    return this.runtime.dispose();
  }
}
