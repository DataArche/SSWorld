const SCENE_MODULE_VERSION = 1;

function invariant(condition, message, code = "scene_module_invalid") {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function errorFact(error, phase) {
  return Object.freeze({
    phase,
    code: error?.code || "scene_module_failed",
    message: error?.message || String(error),
  });
}

export class ResourceScope {
  constructor(scopeId, generation, globals = globalThis) {
    this.scopeId = scopeId;
    this.generation = generation;
    this.globals = globals;
    this.entries = [];
    this.closed = false;
  }

  track(resource, disposer) {
    invariant(!this.closed, "resource scope is already closed", "scene_module_scope_closed");
    const dispose = disposer || (resource && typeof resource.dispose === "function"
      ? () => resource.dispose()
      : null);
    invariant(typeof dispose === "function", "tracked resource needs a disposer");
    this.entries.push({ resource, dispose });
    return resource;
  }

  listen(target, type, listener, options) {
    invariant(target && typeof target.addEventListener === "function"
      && typeof target.removeEventListener === "function", "listen target must be an EventTarget");
    target.addEventListener(type, listener, options);
    this.track(listener, () => target.removeEventListener(type, listener, options));
    return listener;
  }

  setTimeout(callback, delay, ...args) {
    const handle = this.globals.setTimeout(callback, delay, ...args);
    this.track(handle, () => this.globals.clearTimeout(handle));
    return handle;
  }

  setInterval(callback, delay, ...args) {
    const handle = this.globals.setInterval(callback, delay, ...args);
    this.track(handle, () => this.globals.clearInterval(handle));
    return handle;
  }

  objectUrl(blob) {
    invariant(this.globals.URL && typeof this.globals.URL.createObjectURL === "function",
      "URL.createObjectURL is unavailable");
    const url = this.globals.URL.createObjectURL(blob);
    this.track(url, () => this.globals.URL.revokeObjectURL(url));
    return url;
  }

  async disposeAll() {
    if (this.closed) return [];
    this.closed = true;
    const failures = [];
    for (const entry of this.entries.reverse()) {
      try {
        await entry.dispose(entry.resource);
      } catch (error) {
        failures.push(errorFact(error, "resource_dispose"));
      }
    }
    this.entries.length = 0;
    return failures;
  }
}

function validateModule(module) {
  invariant(module && typeof module === "object", "SceneModule must be an ESM namespace");
  invariant(module.metadata?.sceneModuleVersion === SCENE_MODULE_VERSION,
    `SceneModule metadata.sceneModuleVersion must be ${SCENE_MODULE_VERSION}`);
  invariant(typeof module.mount === "function", "SceneModule must export mount(ctx)");
  invariant(module.snapshot === undefined || typeof module.snapshot === "function",
    "SceneModule snapshot must be a function when present");
  invariant(module.dispose === undefined || typeof module.dispose === "function",
    "SceneModule dispose must be a function when present");
  return module;
}

function validateManifest(manifest, profile) {
  invariant(manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "showcase manifest must be an object");
  invariant(manifest.scene_module_version === SCENE_MODULE_VERSION,
    `manifest.scene_module_version must be ${SCENE_MODULE_VERSION}`);
  invariant(typeof manifest.entry === "string" && manifest.entry.length > 0,
    "manifest.entry is required");
  invariant(["trusted-local", "agent-mcp"].includes(profile),
    `unsupported execution profile '${profile}'`);
  if (manifest.execution_profiles) {
    invariant(Array.isArray(manifest.execution_profiles)
      && manifest.execution_profiles.includes(profile),
    `manifest does not admit execution profile '${profile}'`);
  }
  return manifest;
}

export class SceneModuleHost {
  constructor({ contextFactory, importModule, sandboxLoader, minimumReadback, globals } = {}) {
    invariant(typeof contextFactory === "function", "SceneModuleHost needs contextFactory");
    this.contextFactory = contextFactory;
    this.importModule = importModule || ((url) => import(url));
    this.sandboxLoader = sandboxLoader || null;
    this.minimumReadback = minimumReadback || (async (_record, snapshot) => snapshot);
    this.globals = globals || globalThis;
    this.scopes = new Map();
    this.sequence = 0;
    this.receiptSequence = 0;
  }

  scope(scopeId) {
    let scope = this.scopes.get(scopeId);
    if (!scope) {
      scope = { id: scopeId, generation: 0, current: null, records: new Map() };
      this.scopes.set(scopeId, scope);
    }
    return scope;
  }

  async prepareModule({ module, url, sandboxId, manifest, executionProfile = "trusted-local" }) {
    validateManifest(manifest, executionProfile);
    let namespace = module;
    if (executionProfile === "agent-mcp") {
      invariant(!module && !url,
        "agent-mcp modules must not use the trusted-local module or URL loader",
        "scene_module_sandbox_required");
      invariant(this.sandboxLoader && typeof this.sandboxLoader.prepare === "function",
        "agent-mcp SceneModule sandbox loader is unavailable",
        "scene_module_sandbox_unavailable");
      const id = sandboxId || manifest.module_id || manifest.entry;
      invariant(typeof id === "string" && id.length > 0,
        "agent-mcp SceneModule sandbox id is required");
      namespace = await this.sandboxLoader.prepare({ id, manifest: cloneJson(manifest) });
    } else if (!namespace) {
      invariant(typeof url === "string" && url.length > 0, "SceneModule url is required");
      const separator = url.includes("?") ? "&" : "?";
      namespace = await this.importModule(`${url}${separator}scene_module_load=${++this.sequence}`);
    }
    validateModule(namespace);
    return Object.freeze({ namespace, manifest: cloneJson(manifest), executionProfile,
      url: url || null, sandboxId: sandboxId || null });
  }

  async stageGeneration(scopeId, prepared) {
    invariant(typeof scopeId === "string" && scopeId.length > 0, "scopeId is required");
    const scope = this.scope(scopeId);
    const generation = ++scope.generation;
    const resources = new ResourceScope(scopeId, generation, this.globals);
    const record = {
      scopeId,
      generation,
      state: "stage",
      prepared,
      resources,
      context: null,
      instance: undefined,
      snapshot: null,
      failures: [],
      batchId: `module-${++this.receiptSequence}`,
      t0: Date.now(),
    };
    scope.records.set(generation, record);
    try {
      const base = await this.contextFactory(Object.freeze({
        scopeId,
        generation,
        executionProfile: prepared.executionProfile,
        manifest: cloneJson(prepared.manifest),
      }));
      if (Array.isArray(base?.ownedResources)) {
        for (const resource of base.ownedResources) resources.track(resource);
      }
      record.context = Object.freeze({
        ...(base || {}),
        ownedResources: undefined,
        scopeId,
        generation,
        executionProfile: prepared.executionProfile,
        manifest: cloneJson(prepared.manifest),
        capabilities: prepared.executionProfile === "agent-mcp"
          ? cloneJson(prepared.namespace.capabilities || [])
          : cloneJson(base?.capabilities || []),
        resources,
      });
      record.instance = await prepared.namespace.mount(record.context);
      record.state = "mounted";
      record.snapshot = prepared.namespace.snapshot
        ? await prepared.namespace.snapshot(record.instance, record.context)
        : null;
      const readback = await this.minimumReadback(record, record.snapshot);
      invariant(readback?.ok !== false, "minimum readback rejected staged generation",
        "scene_module_readback_failed");
      return record;
    } catch (error) {
      record.failures.push(errorFact(error, record.state === "stage" ? "mount" : "readback"));
      await this.#disposeRecord(record, "stage_failed");
      throw Object.assign(error, {
        sceneModuleReceipt: this.receipt(record, "rejected"),
      });
    }
  }

  async adoptGeneration(record) {
    invariant(record?.state === "mounted", "only a mounted generation can be adopted");
    const scope = this.scope(record.scopeId);
    const previous = scope.current;
    scope.current = record;
    record.state = "adopted";
    if (previous && previous !== record) await this.#disposeRecord(previous, "replaced");
    return this.receipt(record, "committed", previous?.generation || null);
  }

  async loadAndAdopt({ scopeId, module, url, sandboxId, manifest, executionProfile = "trusted-local" }) {
    const prepared = await this.prepareModule({ module, url, sandboxId, manifest, executionProfile });
    const current = this.scopes.get(scopeId)?.current;
    const previousManifest = current?.prepared.manifest;
    const bindingOnly = current
      && previousManifest.module_digest === prepared.manifest.module_digest
      && previousManifest.compiler_profile_digest === prepared.manifest.compiler_profile_digest
      && previousManifest.binding_ir_digest !== prepared.manifest.binding_ir_digest
      && prepared.namespace.sceneIR
      && prepared.namespace.bindingIR
      && typeof current.context?.runtime?.replaceBindings === "function"
      && current.context.runtime.canReplaceBindings?.(
        prepared.namespace.sceneIR, prepared.namespace.bindingIR);
    if (bindingOnly) {
      const previous = current.prepared;
      const replacement = current.context.runtime.replaceBindings(prepared.namespace.bindingIR, {
        expectedGeneration: current.generation,
        sceneIR: prepared.namespace.sceneIR,
        sceneIRDigest: prepared.manifest.scene_ir_digest,
        bindingIRDigest: prepared.manifest.binding_ir_digest,
      });
      try {
        const snapshot = prepared.namespace.snapshot
          ? await prepared.namespace.snapshot(current.instance, current.context)
          : current.snapshot;
        const readback = await this.minimumReadback(current, snapshot);
        invariant(readback?.ok !== false, "minimum readback rejected binding replacement",
          "scene_module_readback_failed");
        current.prepared = prepared;
        Object.assign(current.context.manifest, cloneJson(prepared.manifest));
        current.snapshot = snapshot;
      } catch (error) {
        current.failures.push(errorFact(error, "binding_readback"));
        try {
          current.context.runtime.replaceBindings(previous.namespace.bindingIR, {
            expectedGeneration: current.generation,
            sceneIR: previous.namespace.sceneIR,
            sceneIRDigest: previous.manifest.scene_ir_digest,
            bindingIRDigest: previous.manifest.binding_ir_digest,
          });
        } catch (restoreError) {
          current.failures.push(errorFact(restoreError, "binding_restore"));
        }
        throw Object.assign(error, {
          sceneModuleReceipt: this.receipt(current,
            current.failures.some((item) => item.phase === "binding_restore")
              ? "recovery_required" : "restored"),
        });
      }
      return Object.freeze({
        ...this.receipt(current, "committed"),
        binding_generation: replacement.binding_generation,
        native_nodes_reused: replacement.native_nodes_reused,
        replacement_kind: "bindings_only",
      });
    }
    const record = await this.stageGeneration(scopeId, prepared);
    return this.adoptGeneration(record);
  }

  async snapshotGeneration(scopeId, generation) {
    const scope = this.scopes.get(scopeId);
    const record = generation === undefined ? scope?.current : scope?.records.get(generation);
    invariant(record && ["mounted", "adopted"].includes(record.state),
      "requested generation is not active", "scene_module_generation_inactive");
    record.snapshot = record.prepared.namespace.snapshot
      ? await record.prepared.namespace.snapshot(record.instance, record.context)
      : record.snapshot;
    return cloneJson(record.snapshot);
  }

  async retireGeneration(scopeId, generation) {
    const scope = this.scopes.get(scopeId);
    const record = scope?.records.get(generation);
    if (!record) return null;
    if (scope.current === record) scope.current = null;
    await this.#disposeRecord(record, "retired");
    return this.receipt(record, record.state === "disposed" ? "committed" : "recovery_required");
  }

  async disposeScope(scopeId) {
    const scope = this.scopes.get(scopeId);
    if (!scope) return Object.freeze({ ok: true, scope_id: scopeId, disposed_generations: [] });
    const disposed = [];
    for (const record of [...scope.records.values()].reverse()) {
      if (!["disposed", "recovery_required"].includes(record.state)) {
        await this.#disposeRecord(record, "scope_dispose");
      }
      disposed.push(record.generation);
    }
    scope.current = null;
    this.scopes.delete(scopeId);
    return Object.freeze({
      ok: [...scope.records.values()].every((record) => record.state === "disposed"),
      scope_id: scopeId,
      disposed_generations: disposed,
    });
  }

  receipt(record, status, replacedGeneration = null) {
    const batch = record.snapshot?.last_batch || record.snapshot?.graph?.last_batch || {};
    return Object.freeze({
      schema_version: "SceneModuleHostReceipt/1",
      status,
      execution_profile: record.prepared.executionProfile,
      scope_id: record.scopeId,
      generation: record.generation,
      incarnation: record.generation,
      batch_id: record.batchId,
      t0: record.t0,
      replaced_generation: replacedGeneration,
      state: record.state,
      module_digest: record.prepared.manifest.module_digest || null,
      scene_ir_digest: record.prepared.manifest.scene_ir_digest || null,
      binding_ir_digest: record.prepared.manifest.binding_ir_digest || null,
      compiler_profile_digest: record.prepared.manifest.compiler_profile_digest || null,
      runtime_abi_digest: record.context?.runtimeAbiDigest || null,
      catalog_digest: record.context?.catalogDigest || null,
      evaluated: batch.evaluated || 0,
      changed: batch.changed || 0,
      committed: batch.committed || 0,
      verified: batch.verified || 0,
      capabilities: cloneJson(record.context?.capabilities || []),
      snapshot: cloneJson(record.snapshot),
      failures: cloneJson(record.failures),
    });
  }

  async #disposeRecord(record, reason) {
    if (["disposed", "recovery_required"].includes(record.state)) return;
    record.state = "retiring";
    if (record.instance !== undefined && typeof record.prepared.namespace.dispose === "function") {
      try {
        await record.prepared.namespace.dispose(record.instance, record.context, reason);
      } catch (error) {
        record.failures.push(errorFact(error, "module_dispose"));
      }
    }
    const resourceFailures = await record.resources.disposeAll();
    record.failures.push(...resourceFailures);
    record.state = resourceFailures.length ? "recovery_required" : "disposed";
  }
}

export const SceneModule = Object.freeze({ version: SCENE_MODULE_VERSION });
