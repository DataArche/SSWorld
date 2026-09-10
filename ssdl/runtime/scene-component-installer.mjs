// Catalog-driven SceneIR/5 construction. No author JavaScript is evaluated.
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function assert(ok, message, code = 'scene_component_invalid') {
  if (!ok) throw Object.assign(new Error(message), { code });
}
function nestedSet(object, path, value) {
  const keys = path.split('.');
  assert(keys.every(key => !['__proto__', 'prototype', 'constructor'].includes(key)), 'unsafe member name');
  for (const key of keys.slice(0, -1)) object = object[key] ||= {};
  object[keys.at(-1)] = value;
}

export async function installComponents(bridge, graph, sceneIR, catalog) {
  const runtime = bridge.runtime;
  const nodes = new Map(sceneIR.nodes.map(node => [node.id, node]));
  const constructing = new Set();
  const definitions = new Set();
  const deferredStarts = [];
  const descriptions = catalog.components;
  const childrenOf = id => sceneIR.nodes.filter(item => item.parent === id)
    .sort((a,b) => (a.source_order ?? 0) - (b.source_order ?? 0));
  const getValues = node => Object.fromEntries(node.properties.map(item => [item.property, clone(item.value)]));
  const descriptor = node => descriptions[node.type];
  const resolveProperty = (target, property) => {
    const type = nodes.get(target)?.type;
    return descriptions[type]?.members[property]?.runtime_property || property;
  };
  const typedReference = reference => {
    const [id, property] = reference.segments;
    const slot = runtime.ensureLogicalSlot(graph.get(id), property);
    const value = runtime.readLogical(slot.owner, property);
    const type = slot.descriptor;
    if (type.value_type === 'vector3' || type.value_type === 'quaternion') {
      const axes = type.value_type === 'quaternion' ? ['x','y','z','w'] : ['x','y','z'];
      return { type: 'array', unit: type.unit, element_type: 'scalar', value: axes.map(axis => ({ type:'scalar', unit:type.unit, value:Math.round(value[axis] * type.divisor) })) };
    }
    return { type:type.value_type === 'color' ? 'string' : type.value_type, unit:type.unit,
      value:type.value_type === 'scalar' ? Math.round(value * type.divisor) : value };
  };
  const execute = actions => {
    // Evaluate sequential assignments against a local transaction overlay.
    const writes = [], overlay = new Map(), calls = [];
    for (const action of actions) {
      const target = graph.get(action.target.node);
      if (action.kind === 'invoke') { calls.push(() => target[action.method]()); continue; }
      const result = runtime.expressionEvaluate(action.expression, reference => overlay.get(reference.segments.join('\0')) || typedReference(reference));
      const expected = action.expected;
      const value = expected.value_type === 'vector3' || expected.value_type === 'quaternion'
        ? Object.fromEntries((expected.value_type === 'quaternion' ? ['x','y','z','w'] : ['x','y','z']).map((axis,i) => [axis,result.value[i].value / expected.divisor]))
        : expected.value_type === 'scalar' ? result.value / expected.divisor : result.value;
      overlay.set([action.target.node,action.target.property].join('\0'),result);
      const prior = writes.find(item => item.target === target && item.property === action.target.property);
      if (prior) prior.value = value;
      else writes.push({ target, property:action.target.property, value });
    }
    if (writes.length) {
      const receipt = graph.commitEventBatch(writes);
      assert(receipt.ok !== false, 'SSDL event transaction failed', 'ssdl_event_failed');
    }
    for (const call of calls) call();
  };
  function specFor(node, animationDefinition = false) {
    const desc = descriptor(node), value = getValues(node), spec = {};
    for (const [author, member] of Object.entries(desc.members)) {
      const key = member.runtime_property || author;
      if (!(key in value)) continue;
      const raw = value[key];
      if (member.value_type === 'object_ref') {
        if (author === 'initialView') { construct(raw); spec[author] = raw; }
        else spec[author] = construct(raw);
      } else nestedSet(spec, author, raw);
    }
    if (desc.implicit_target && !spec.target && node.parent && nodes.get(node.parent)?.type !== 'Scene') spec.target = construct(node.parent);
    if (spec.property && spec.target) spec.property = resolveProperty(value.target || node.parent, spec.property);
    if (!animationDefinition) for (const handler of node.handlers || []) spec[handler.signal] = () => execute(handler.actions);
    return spec;
  }
  function animationSpec(node) {
    definitions.add(node.id);
    const spec = specFor(node, true);
    if (descriptor(node).adapter === 'animation_group') spec.animations = childrenOf(node.id).map(animationSpec);
    return { type:node.type, ...spec };
  }
  function construct(id) {
    if (graph.components.has(id)) return graph.get(id);
    assert(!constructing.has(id), `component reference cycle at '${id}'`, 'component_reference_cycle');
    const node = nodes.get(id); assert(node, `unknown node '${id}'`);
    const desc = descriptor(node); assert(desc?.factory && typeof runtime[desc.factory] === 'function', `SSDL '${node.type}' has no runtime factory`);
    constructing.add(id);
    const parent = nodes.get(node.parent);
    if (parent && ['animation_group','behavior'].includes(descriptor(parent)?.adapter)) {
      constructing.delete(id);
      return animationSpec(node);
    }
    let spec = specFor(node);
    const ownedLight = ['PointLight','SpotLight','RectLight'].includes(node.type)
      || (node.type === 'DirectionalLight' && spec.atmosphereSunLight !== true);
    if (ownedLight && parent && ['geometry','group'].includes(descriptor(parent)?.adapter)) spec.parent = construct(parent.id);
    if (desc.adapter === 'geometry' || desc.adapter === 'group' || desc.adapter === 'model') {
      if (!spec.parent && parent && ['geometry','group'].includes(descriptor(parent)?.adapter)) spec.parent = construct(parent.id);
    }
    if (desc.adapter === 'geometry') {
      spec.params = {};
      for (const key of desc.params) { if (spec[key] !== undefined) spec.params[key] = spec[key]; delete spec[key]; }
      if (node.type === 'Cylinder' && spec.params.radius !== undefined) {
        spec.params.top_radius = spec.params.bottom_radius = spec.params.radius;
        delete spec.params.radius;
      }
      if (node.type === 'Box' && !spec.position) spec.position = { x:0,y:0,z:(spec.params.height || 1)/2 };
    }
    if (desc.adapter === 'behavior') {
      const children = childrenOf(id);
      assert(children.length <= 1, 'Behavior needs one animation child');
      if (children.length) spec.animation = animationSpec(children[0]);
      else spec.animation = { type:spec.property === 'transform.position' ? 'Vector3dAnimation' : 'NumberAnimation', duration:spec.duration ?? 250, easing:{type:spec.easing || 'Easing.OutCubic'} };
      delete spec.duration; delete spec.easing;
    }
    if (desc.adapter === 'animation_group') spec.animations = childrenOf(id).map(animationSpec);
    if (desc.adapter === 'interaction') {
      spec.root = bridge.interactionRoot;
      assert(spec.root, 'SSDL interactionRoot is missing');
      for (const signal of desc.signals) spec[signal] ||= () => {};
    }
    const isAnimation = ['animation','animation_group'].includes(desc.adapter);
    const run = spec.running, pause = spec.paused;
    if (isAnimation) { spec.running = false; spec.paused = false; }
    if (node.type === 'Timer') spec.running = false;
    if (desc.adapter === 'animation_definition') {
      definitions.add(id); constructing.delete(id); return spec;
    }
    if (!isAnimation) spec.id = id;
    if (desc.adapter === 'model') {
      // Models load asynchronously; they are staged up front by the async pre-pass below.
      constructing.delete(id);
      const pending = runtime[desc.factory](spec);
      assert(typeof pending?.then === 'function', `${node.type} factory must be asynchronous`);
      return pending;
    }
    const component = runtime[desc.factory](spec);
    assert(!component?.then, `${node.type} needs an async construction adapter`);
    if (isAnimation) {
      component.id = id;
      component.component_type = node.type;
      for (const property of ['running','paused','loops']) runtime.ensureLogicalSlot(component, property);
      if (run === true) deferredStarts.push(() => { component.start(); if (pause) component.pause(); });
    }
    graph.own(id, component);
    if (node.type === 'Timer' && run === true) deferredStarts.push(() => component.start());
    if (desc.adapter === 'camera' && spec.initialView) deferredStarts.push(() => component.activateInitial());
    constructing.delete(id);
    return component;
  }
  try {
    for (const node of sceneIR.nodes) {
      if (descriptor(node)?.adapter !== 'model') continue;
      const model = await construct(node.id);
      graph.own(node.id, model);
    }
    for (const node of sceneIR.nodes) if (node.type !== 'Scene') construct(node.id);
    return { start() { for (const start of deferredStarts) start(); }, definitions:[...definitions] };
  } catch (error) {
    // The owning host still disposes the runtime; keep the original error.
    for (const component of [...graph.owned].reverse()) { try { component?.dispose?.({restore:false}); } catch (_) {} }
    throw error;
  }
}
