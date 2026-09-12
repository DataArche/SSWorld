(function registerSSDLBuiltins(root, factory) {
  "use strict";
  const api = factory(root.SSEngineSSDLBuiltinCatalogV1 || null);
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.defineProperty(root, "SSEngineSSDLBuiltins", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: api,
  });
})(typeof globalThis === "object" ? globalThis : this, function createSSDLBuiltinsModule(catalogProjection) {
  "use strict";

  const SCHEMA_VERSION = "SSDLBuiltinRuntime/v1";
  // Native post-processing composes all volumes through one scene proxy.
  // Share its owner across overlapping SceneModule generations, so staging a
  // replacement does not mistake the previous generation for an unmanaged volume.
  const sharedPostProcessFacades = new WeakMap();
  let runtimeSequence = 0;
  function acquirePostProcessFacade(viewer, Constructor) {
    if (typeof Constructor !== "function") return { facade:null, release() {} };
    let entry = sharedPostProcessFacades.get(viewer);
    if (!entry) {
      entry = { facade:new Constructor(), references:0 };
      sharedPostProcessFacades.set(viewer, entry);
    }
    entry.references += 1;
    let released = false;
    return { facade:entry.facade, release() {
      if (released) return;
      released = true;
      if (--entry.references === 0) {
        entry.facade.delete?.();
        sharedPostProcessFacades.delete(viewer);
      }
    } };
  }
  const COMPONENT_TYPES = Object.freeze([
    "Scene",
    "SceneObject",
    "Group",
    "GeoAnchor",
    "Box",
    "Plane",
    "Sphere",
    "Cylinder",
    "Cone",
    "Polyline",
    "Polygon",
    "ExtrudedPolygon",
    "HeightField",
    "Lathe",
    "Tube",
    "Loft",
    "Label",
    "Model",
    "Texture",
    "PrincipledMaterial",
    "Prefab",
    "Instances",
    "Repeater",
    "Animation",
    "PropertyAnimation",
    "NumberAnimation",
    "Vector3dAnimation",
    "QuaternionAnimation",
    "ColorAnimation",
    "RotationAnimation",
    "PauseAnimation",
    "ParallelAnimation",
    "SequentialAnimation",
    "Binding",
    "Behavior",
    "State",
    "PropertyChanges",
    "Transition",
    "PropertyAction",
    "Timeline",
    "KeyframeGroup",
    "Keyframe",
    "TimelineAnimation",
    "SSE.OrbitAnimation",
    "SSE.Path3DAnimation",
    "Camera",
    "CameraView",
    "LightComponent",
    "SunSky",
    "DirectionalLight",
    "PointLight",
    "SpotLight",
    "RectLight",
    "SkyLight",
    "SkyAtmosphere",
    "VolumetricCloud",
    "ExponentialHeightFog",
    "PostProcessVolume",
    "TapHandler",
    "HoverHandler",
    "KeyHandler",
    "Timer",
  ]);

  function invariant(condition, message) {
    if (!condition) throw new Error(message);
  }

  function finite(value, field) {
    invariant(Number.isFinite(value), `${field} must be finite`);
    return value;
  }

  const ANIMATION_COMMON_MEMBERS = Object.freeze([
    "alwaysRunToEnd", "loops", "paused", "running",
    "onStarted", "onStopped", "onFinished", "onRunningChanged", "onPausedChanged",
    // Compatibility spellings retained for the existing imperative examples;
    // QML/SSDL authors use running, loops and duration.
    "autoplay", "loop", "initial_ms",
  ]);

  function assertAnimationMembers(spec, type, ownMembers) {
    const allowed = new Set([...ANIMATION_COMMON_MEMBERS, ...ownMembers]);
    const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
    invariant(!unsupported, `member_unsupported: ${type}.${unsupported}`);
    for (const signal of ["onStarted", "onStopped", "onFinished", "onRunningChanged", "onPausedChanged"]) {
      invariant(spec[signal] === undefined || typeof spec[signal] === "function",
        `${type}.${signal} must be a function`);
    }
  }

  function propertyAnimationDuration(spec, type) {
    invariant(spec.duration === undefined || Number.isInteger(spec.duration),
      `${type}.duration must be an integer`);
    invariant(spec.duration_ms === undefined || Number.isInteger(spec.duration_ms),
      `${type}.duration_ms must be an integer`);
    invariant(spec.duration === undefined || spec.duration_ms === undefined
      || spec.duration === spec.duration_ms,
    `${type}.duration and legacy duration_ms disagree`);
    const duration = spec.duration ?? spec.duration_ms ?? 250;
    invariant(duration >= 1, `${type}.duration must be >= 1`);
    return duration;
  }

  const QML_EASING_KINDS = Object.freeze({
    Linear: "linear",
    InQuad: "in_quad",
    OutQuad: "out_quad",
    InOutQuad: "in_out_quad",
    InCubic: "in_cubic",
    OutCubic: "out_cubic",
    InOutCubic: "in_out_cubic",
    InSine: "in_sine",
    OutSine: "out_sine",
    InOutSine: "in_out_sine",
  });

  function propertyAnimationEasing(value, type) {
    if (value === undefined) return { kind: "linear" };
    invariant(value && typeof value === "object" && !Array.isArray(value),
      `${type}.easing must be an object`);
    if (typeof value.kind === "string") {
      invariant(value.type === undefined, `${type}.easing cannot mix type with legacy kind`);
      return { ...value };
    }
    const allowed = new Set(["type", "amplitude", "bezierCurve", "overshoot", "period"]);
    const unknown = Object.keys(value).find((name) => !allowed.has(name));
    invariant(!unknown, `member_unsupported: ${type}.easing.${unknown}`);
    invariant(typeof value.type === "string", `${type}.easing.type is required`);
    const qmlType = value.type.replace(/^Easing\./, "");
    for (const parameter of ["amplitude", "overshoot", "period"]) {
      invariant(value[parameter] === undefined,
        `member_unsupported: ${type}.easing.${parameter} needs an unsupported ${qmlType} evaluator`);
    }
    if (qmlType === "BezierSpline") {
      invariant(Array.isArray(value.bezierCurve) && value.bezierCurve.length === 6,
        `${type}.easing.bezierCurve supports exactly one cubic segment`);
      const curve = value.bezierCurve.map((item, index) => finite(item,
        `${type}.easing.bezierCurve[${index}]`));
      invariant(curve[0] >= 0 && curve[0] <= 1 && curve[2] >= 0 && curve[2] <= 1
        && curve[1] >= -2 && curve[1] <= 2 && curve[3] >= -2 && curve[3] <= 2
        && curve[4] === 1 && curve[5] === 1,
      `${type}.easing.bezierCurve must end at 1,1 with supported control points`);
      return {
        kind: "cubic_bezier",
        x1_milli: Math.round(curve[0] * 1000),
        y1_milli: Math.round(curve[1] * 1000),
        x2_milli: Math.round(curve[2] * 1000),
        y2_milli: Math.round(curve[3] * 1000),
      };
    }
    invariant(value.bezierCurve === undefined,
      `${type}.easing.bezierCurve requires Easing.BezierSpline`);
    const kind = QML_EASING_KINDS[qmlType];
    invariant(kind,
      `member_unsupported: ${type}.easing.type Easing.${qmlType} has no native evaluator`);
    return { kind };
  }

  function nativeResult(raw, operation) {
    let value;
    try {
      value = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (error) {
      throw new Error(`${operation} returned invalid JSON`, { cause: error });
    }
    if (!value || value.ok !== true) {
      const detail = value?.message || value?.error_code || "native operation failed";
      throw Object.assign(new Error(`${operation}: ${detail}`), { result: value });
    }
    return value;
  }

  // An author writes #rrggbb the way every colour picker and PBR pipeline means it: sRGB-encoded.  The
  // engine's shading is linear and takes the material/light colour straight from the float it is given
  // (UniformValue(QColor) reads redF() with no decode), so the sRGB -> linear transfer has to happen
  // here, at the one place author colours enter the runtime.  Without it #808080 arrives as linear 0.5
  // and renders like sRGB 188 -- "every flat colour is about 3x too bright".  Alpha stays linear.
  function srgbToLinear(channel) {
    return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(channel) {
    return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  }

  function hexColor(value) {
    invariant(typeof value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value),
      "color must be #rrggbb or #rrggbbaa");
    const channels = value.slice(1).match(/../g).map((part) => Number.parseInt(part, 16));
    if (channels.length === 3) channels.push(255);
    const [r, g, b] = channels.slice(0, 3).map((channel) => Math.round(srgbToLinear(channel / 255) * 65535));
    return { r_u16: r, g_u16: g, b_u16: b, a_u16: Math.round(channels[3] * 65535 / 255) };
  }

  function quaternionZ(degrees = 0) {
    const half = finite(degrees, "rotation_z") * Math.PI / 360;
    return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
  }

  function quaternion(value, field) {
    invariant(value && typeof value === "object", `${field} must be a quaternion`);
    const candidate = {
      x: finite(value.x, `${field}.x`),
      y: finite(value.y, `${field}.y`),
      z: finite(value.z, `${field}.z`),
      w: finite(value.w, `${field}.w`),
    };
    const length = Math.hypot(candidate.x, candidate.y, candidate.z, candidate.w);
    invariant(length > 1e-12, `${field} must not be a zero quaternion`);
    return {
      x: candidate.x / length,
      y: candidate.y / length,
      z: candidate.z / length,
      w: candidate.w / length,
    };
  }

  function vector3(value, fallback, field) {
    const candidate = value || fallback;
    invariant(candidate && typeof candidate === "object", `${field} must be a vector`);
    return {
      x: finite(candidate.x, `${field}.x`),
      y: finite(candidate.y, `${field}.y`),
      z: finite(candidate.z, `${field}.z`),
    };
  }

  function nodePosition(spec, field) {
    const position = vector3(spec.position, { x: 0, y: 0, z: 0 }, `${field}.position`);
    for (const axis of ["x", "y", "z"]) {
      if (spec[axis] !== undefined) position[axis] = finite(spec[axis], `${field}.${axis}`);
    }
    return position;
  }

  function meshPoint(value, field) {
    if (Array.isArray(value)) {
      invariant(value.length === 2 || value.length === 3, `${field} must have 2 or 3 coordinates`);
      return {
        x: finite(value[0], `${field}[0]`),
        y: finite(value[1], `${field}[1]`),
        z: finite(value[2] ?? 0, `${field}[2]`),
      };
    }
    return vector3({ ...value, z: value?.z ?? 0 }, null, field);
  }

  function polygonParams(params) {
    invariant(params && typeof params === "object", "Polygon.params is required");
    const allowed = new Set(["outer", "holes"]);
    const unknown = Object.keys(params).find((name) => !allowed.has(name));
    invariant(!unknown, `member_unsupported: Polygon.params.${unknown}`);
    invariant(Array.isArray(params.outer), "Polygon.params.outer must be an array");
    invariant(params.holes === undefined || Array.isArray(params.holes),
      "Polygon.params.holes must be an array");
    return {
      outer: params.outer.map((point, index) => meshPoint(point, `Polygon.params.outer[${index}]`)),
      holes: (params.holes || []).map((ring, ringIndex) => {
        invariant(Array.isArray(ring), `Polygon.params.holes[${ringIndex}] must be an array`);
        return ring.map((point, pointIndex) => meshPoint(point,
          `Polygon.params.holes[${ringIndex}][${pointIndex}]`));
      }),
    };
  }

  function extrudeParams(params) {
    invariant(params && typeof params === "object", "ExtrudedPolygon.params is required");
    const allowed = new Set(["outer", "holes", "height", "cap", "bevel"]);
    const unknown = Object.keys(params).find((name) => !allowed.has(name));
    invariant(!unknown, `member_unsupported: ExtrudedPolygon.params.${unknown}`);
    invariant(Array.isArray(params.outer), "ExtrudedPolygon.params.outer must be an array");
    invariant(params.holes === undefined || Array.isArray(params.holes),
      "ExtrudedPolygon.params.holes must be an array");
    // GeometrySpec/v2 extrude rings are planar: the native parser accepts exactly x/y per point.
    const planar = (point, field) => { const { x, y } = meshPoint(point, field); return { x, y }; };
    const result = {
      outer: params.outer.map((point, index) => planar(point, `ExtrudedPolygon.params.outer[${index}]`)),
      height: finite(params.height, "ExtrudedPolygon.params.height"),
    };
    if (params.holes !== undefined) {
      result.holes = params.holes.map((ring, ringIndex) => {
        invariant(Array.isArray(ring), `ExtrudedPolygon.params.holes[${ringIndex}] must be an array`);
        return ring.map((point, pointIndex) => planar(point,
          `ExtrudedPolygon.params.holes[${ringIndex}][${pointIndex}]`));
      });
    }
    if (params.cap !== undefined) {
      invariant(typeof params.cap === "boolean", "ExtrudedPolygon.params.cap must be boolean");
      result.cap = params.cap;
    }
    if (params.bevel !== undefined) result.bevel = params.bevel;
    return result;
  }

  function polylineMesh(params) {
    invariant(params && typeof params === "object", "Polyline.params is required");
    const allowed = new Set(["points", "width"]);
    const unknown = Object.keys(params).find((name) => !allowed.has(name));
    invariant(!unknown, `member_unsupported: Polyline.params.${unknown}`);
    invariant(Array.isArray(params.points) && params.points.length >= 2 && params.points.length <= 256,
      "Polyline.params.points must hold 2..256 points");
    const points = params.points.map((point, index) => meshPoint(point, `Polyline.params.points[${index}]`));
    const width = finite(params.width, "Polyline.params.width");
    invariant(width > 0, "Polyline.params.width must be > 0");
    const positions = [], indices = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index], b = points[index + 1];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const length = Math.hypot(dx, dy, dz);
      invariant(length > 1e-12, "Polyline.params.points must not repeat adjacent points");
      const ux = dx / length, uy = dy / length, uz = dz / length;
      const reference = Math.abs(uz) < .9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
      let sx = reference.y * uz - reference.z * uy;
      let sy = reference.z * ux - reference.x * uz;
      let sz = reference.x * uy - reference.y * ux;
      const sideLength = Math.hypot(sx, sy, sz);
      sx = sx / sideLength * width / 2;
      sy = sy / sideLength * width / 2;
      sz = sz / sideLength * width / 2;
      const base = positions.length;
      positions.push(
        { x: a.x + sx, y: a.y + sy, z: a.z + sz },
        { x: a.x - sx, y: a.y - sy, z: a.z - sz },
        { x: b.x + sx, y: b.y + sy, z: b.z + sz },
        { x: b.x - sx, y: b.y - sy, z: b.z - sz },
      );
      indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
    return { positions, indices };
  }

  function wireValue(property, value) {
    if (property === "material.color" || property === "material.glow_color") {
      return typeof value === "string" ? hexColor(value) : value;
    }
    if (property === "visible" || property === "material.glow"
      || property === "material.receive_shadow" || property === "material.cast_shadow"
      || property === "material.both_sided") return { value: Boolean(value) };
    if (property === "transform.position") {
      return { x_um: Math.round(value.x * 1e6), y_um: Math.round(value.y * 1e6), z_um: Math.round(value.z * 1e6) };
    }
    if (property === "transform.scale") {
      return { x_milli: Math.round(value.x * 1000), y_milli: Math.round(value.y * 1000), z_milli: Math.round(value.z * 1000) };
    }
    if (property === "transform.rotation") {
      return {
        x_micro: Math.round(value.x * 1e6), y_micro: Math.round(value.y * 1e6),
        z_micro: Math.round(value.z * 1e6), w_micro: Math.round(value.w * 1e6),
      };
    }
    return { value_milli: Math.round(value * 1000) };
  }

  // Native property targets: geometry objects, Models (external nodes) and locator rigs
  // (Group/GeoAnchor expose transform.* and visible through the same animation table).
  function propertyTarget(target, runtime = null) {
    invariant((target instanceof SceneObject || target instanceof Model
      || target instanceof Group || target instanceof GeoAnchor) && !target.disposed
      && typeof target.handle === "string",
    "property target must be a live SceneObject, Model, Group or GeoAnchor");
    invariant(runtime === null || target.runtime === runtime,
      "property target must belong to the same runtime");
    return { kind: "object", object_handle: target.handle };
  }

  // Locator rigs and Model roots carry no material: only transform.* and visible bind natively.
  function assertAnimatableProperty(target, property, type) {
    if (target instanceof Group || target instanceof GeoAnchor || target instanceof Model) {
      invariant(typeof property === "string" && (property.startsWith("transform.") || property === "visible"),
        `property_not_animatable: ${type} cannot animate ${target.component_type}.${property}; ${target.component_type} exposes only position/rotation/scale/visible`);
    }
  }

  function writeNativeProperty(runtime, target, property, value) {
    return writeNativeWireProperty(runtime, target, property, wireValue(property, value));
  }

  function writeNativeWireProperty(runtime, target, property, value) {
    return nativeResult(runtime.animationFacade.writeProperty(JSON.stringify({
      schema_version: "PropertyWriteSpec/v1",
      target: propertyTarget(target, runtime),
      property,
      value,
    })), "AnimationFacade.writeProperty");
  }

  function authorValue(property, value) {
    if (property === "material.color" || property === "material.glow_color") {
      // The inverse of hexColor: the wire and the native material hold linear light, the author reads sRGB.
      const clamp = (channel) => Math.max(0, Math.min(255, Math.round(channel)));
      const unit = Object.hasOwn(value, "r_u16")
        ? [value.r_u16, value.g_u16, value.b_u16, value.a_u16].map((channel) => channel / 65535)
        : [value.r, value.g, value.b, value.a];
      const channels = [...unit.slice(0, 3).map((channel) => clamp(linearToSrgb(channel) * 255)), clamp(unit[3] * 255)];
      return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    }
    if (property === "visible" || property === "material.glow"
      || property === "material.receive_shadow" || property === "material.cast_shadow"
      || property === "material.both_sided") return typeof value === "boolean" ? value : Boolean(value.value);
    if (property === "transform.position") {
      return Object.hasOwn(value, "x_um")
        ? { x: value.x_um / 1e6, y: value.y_um / 1e6, z: value.z_um / 1e6 }
        : { x: value.x, y: value.y, z: value.z };
    }
    if (property === "transform.scale") {
      return Object.hasOwn(value, "x_milli")
        ? { x: value.x_milli / 1000, y: value.y_milli / 1000, z: value.z_milli / 1000 }
        : { x: value.x, y: value.y, z: value.z };
    }
    if (property === "transform.rotation") {
      return Object.hasOwn(value, "x_micro")
        ? {
          x: value.x_micro / 1e6, y: value.y_micro / 1e6,
          z: value.z_micro / 1e6, w: value.w_micro / 1e6,
        }
        : { x: value.x, y: value.y, z: value.z, w: value.w };
    }
    return typeof value === "number" ? value : value.value_milli / 1000;
  }

  function readNativeProperty(runtime, target, property) {
    return nativeResult(runtime.animationFacade.readProperty(JSON.stringify({
      schema_version: "PropertyAccessSpec/v1",
      target: propertyTarget(target, runtime),
      property,
    })), "AnimationFacade.readProperty");
  }

  function nativePropertyBatch(runtime, proposals) {
    const items = proposals.map(({ binding }) => ({
      target: propertyTarget(binding.target, runtime),
      property: binding.property,
    }));
    const capture = nativeResult(runtime.animationFacade.captureBatch(JSON.stringify({
      schema_version: "PropertyBatchCaptureSpec/v1",
      items,
    })), "PropertyBridge.captureBatch");
    const receipt = nativeResult(runtime.animationFacade.writeBatch(capture.capture_handle, JSON.stringify({
      schema_version: "PropertyBatchWriteSpec/v1",
      writes: proposals.map(({ binding, next }) => ({
        target: propertyTarget(binding.target, runtime),
        property: binding.property,
        value: wireValue(binding.property, next),
      })),
    })), "PropertyBridge.writeBatch");
    return { capture, receipt };
  }

  const NATIVE_SCALAR_PROPERTIES = Object.freeze(new Set([
    "material.opacity", "material.brightness", "material.contrast", "material.saturation",
    "material.gamma", "material.emissive_intensity", "material.mask_threshold", "material.roughness",
  ]));
  const NATIVE_BOOLEAN_PROPERTIES = Object.freeze(new Set([
    "visible", "material.glow", "material.receive_shadow", "material.cast_shadow", "material.both_sided",
  ]));
  const NATIVE_COLOR_PROPERTIES = Object.freeze(new Set(["material.color", "material.glow_color"]));
  const UNSUPPORTED_REBUILD_BINDINGS = Object.freeze(new Set([
    "ssdl_box.width", "ssdl_box.depth", "ssdl_box.height", "ssdl_box.baseZ", "ssdl_box.x", "ssdl_box.y",
  ]));

  function codedError(code, message = code) {
    return Object.assign(new Error(message), { code });
  }

  function nativeLogicalDescriptor(property) {
    if (UNSUPPORTED_REBUILD_BINDINGS.has(property)) {
      throw codedError("binding_update_class_unsupported",
        `${property} requires geometry rebuild and cannot be bound in the current runtime`);
    }
    if (NATIVE_COLOR_PROPERTIES.has(property)) {
      return { kind: "native", value_type: "color", unit: null, length: 1, divisor: 1 };
    }
    if (NATIVE_BOOLEAN_PROPERTIES.has(property)) {
      return { kind: "native", value_type: "boolean", unit: null, length: 1, divisor: 1 };
    }
    if (NATIVE_SCALAR_PROPERTIES.has(property)) {
      const ranges = {
        "material.opacity": [0, 1], "material.mask_threshold": [0, 1],
        "material.roughness": [0, 1],
        "material.brightness": [0, 4], "material.contrast": [0, 4],
        "material.saturation": [0, 4], "material.gamma": [.1, 4],
        "material.emissive_intensity": [0, 100],
      };
      const [minimum, maximum] = ranges[property];
      return {
        kind: "native", value_type: "scalar", unit: "scalar", length: 1, divisor: 1e6,
        validate: (value, field) => invariant(value >= minimum && value <= maximum,
          `${field} must be in ${minimum}..${maximum}`),
      };
    }
    if (property === "transform.position") {
      return { kind: "native", value_type: "vector3", unit: "m", length: 3, divisor: 1e6 };
    }
    if (property === "transform.scale") {
      return {
        kind: "native", value_type: "vector3", unit: "scalar", length: 3, divisor: 1e6,
        validate: (value, field) => invariant(value.x >= .001 && value.y >= .001 && value.z >= .001
          && value.x <= 1000 && value.y <= 1000 && value.z <= 1000,
        `${field} components must be in 0.001..1000`),
      };
    }
    if (property === "transform.rotation") {
      return { kind: "native", value_type: "quaternion", unit: "scalar", length: 4, divisor: 1e6 };
    }
    throw codedError("member_unsupported", `member_unsupported: Binding.${property}`);
  }

  function cloneLogical(value) {
    return value && typeof value === "object" ? { ...value } : value;
  }

  function normalizeLogical(descriptor, value, field) {
    if (descriptor.value_type === "color") {
      try { hexColor(value); }
      catch (error) { throw codedError("type_mismatch", error.message); }
      return value.toLowerCase();
    }
    if (descriptor.value_type === "boolean") {
      invariant(typeof value === "boolean", `${field} must be boolean`);
      return value;
    }
    let normalized;
    if (descriptor.value_type === "scalar") normalized = finite(value, field);
    else if (descriptor.value_type === "string") {
      invariant(typeof value === "string", `${field} must be a string`);
      normalized = value;
    } else if (descriptor.value_type === "vector3") normalized = vector3(value, null, field);
    else if (descriptor.value_type === "quaternion") normalized = quaternion(value, field);
    else throw codedError("type_mismatch");
    if (descriptor.validate) descriptor.validate(normalized, field);
    return normalized;
  }

  function logicalEqual(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
  }

  // An expression result carries a unit tag that need not match the target's -- units are tags, not
  // dimensions, and every scalar the 0.3 compiler emits already sits in the same fixed-point lane. So
  // the tag is not checked here; the target's own divisor is what decodes the number.
  function safeCanonicalInteger(value, field, divisor = 1e6) {
    const encoded = Math.round(finite(value, field) * divisor);
    invariant(Number.isSafeInteger(encoded), `${field} is outside the canonical integer range`);
    return encoded;
  }

  function logicalExpressionValue(descriptor, value) {
    if (descriptor.value_type === "color") return { type: "string", unit: null, value };
    if (descriptor.value_type === "boolean") return { type: "boolean", unit: null, value };
    if (descriptor.value_type === "string") return { type: "string", unit: null, value };
    if (descriptor.value_type === "scalar") {
      const encoded = safeCanonicalInteger(value, "binding scalar", descriptor.divisor);
      return { type: "scalar", unit: descriptor.unit, value: encoded };
    }
    const components = descriptor.value_type === "vector3"
      ? [value.x, value.y, value.z] : [value.x, value.y, value.z, value.w];
    const items = components.map((component, index) => ({
      type: "scalar", unit: descriptor.unit,
      value: safeCanonicalInteger(component, `binding component[${index}]`, descriptor.divisor),
    }));
    return { type: "array", unit: descriptor.unit, element_type: "scalar", value: items };
  }

  function bindingResultValue(descriptor, result, field) {
    invariant(result && typeof result === "object", `${field} returned no typed value`);
    if (descriptor.value_type === "color") {
      if (result.type !== "string") throw codedError("type_mismatch");
      return normalizeLogical(descriptor, result.value, field);
    }
    if (descriptor.value_type === "boolean") {
      if (result.type !== "boolean") throw codedError("type_mismatch");
      return normalizeLogical(descriptor, result.value, field);
    }
    if (descriptor.value_type === "string") {
      if (result.type !== "string") throw codedError("type_mismatch");
      return normalizeLogical(descriptor, result.value, field);
    }
    if (descriptor.value_type === "scalar") {
      if (result.type !== "scalar") throw codedError("type_mismatch");
      invariant(Number.isSafeInteger(result.value), `${field} returned an unsafe integer`);
      return normalizeLogical(descriptor, result.value / descriptor.divisor, field);
    }
    if (result.type !== "array" || result.element_type !== "scalar"
      || !Array.isArray(result.value) || result.value.length !== descriptor.length) {
      throw codedError("type_mismatch");
    }
    const values = result.value.map((item) => {
      if (item?.type !== "scalar" || !Number.isSafeInteger(item.value)) throw codedError("type_mismatch");
      return item.value / descriptor.divisor;
    });
    const candidate = descriptor.value_type === "vector3"
      ? { x: values[0], y: values[1], z: values[2] }
      : { x: values[0], y: values[1], z: values[2], w: values[3] };
    return normalizeLogical(descriptor, candidate, field);
  }

  function canonicalJson(value, ancestors = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw codedError("invalid_expression",
        "invalid_expression: Binding.expression contains a non-finite number");
      return JSON.stringify(value);
    }
    if (!value || typeof value !== "object") {
      throw codedError("invalid_expression", "invalid_expression: Binding.expression must contain JSON values only");
    }
    if (ancestors.has(value)) throw codedError("invalid_expression", "invalid_expression: Binding.expression contains a cycle");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        invariant(Object.keys(value).length === value.length,
          "invalid_expression: Binding.expression arrays must not contain holes or named properties");
        return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      invariant(prototype === Object.prototype || prototype === null,
        "invalid_expression: Binding.expression objects must be plain JSON objects");
      return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }

  function freezeJson(value) {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freezeJson(child);
      Object.freeze(value);
    }
    return value;
  }

  function sha256Text(text) {
    const bytes = new TextEncoder().encode(text);
    const total = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(total);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const bitLength = bytes.length * 8;
    const view = new DataView(data.buffer);
    view.setUint32(total - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(total - 4, bitLength >>> 0, false);
    const constants = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    const state = new Uint32Array([
      0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
      for (let index = 16; index < 64; index += 1) {
        const a = words[index - 15], b = words[index - 2];
        const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
        const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = state;
      for (let index = 0; index < 64; index += 1) {
        const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choice = (e & f) ^ (~e & g);
        const t1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
        const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      for (const [index, value] of [a,b,c,d,e,f,g,h].entries()) state[index] = (state[index] + value) >>> 0;
    }
    return [...state].map((value) => value.toString(16).padStart(8, "0")).join("");
  }

  function expressionReferences(expression) {
    const references = [];
    const visit = (value) => {
      invariant(value && typeof value === "object" && !Array.isArray(value), "Binding.expression must be ExpressionAST/2");
      if (value.ref !== undefined) {
        const ref = value.ref;
        invariant(Object.keys(value).length === 1 && ref && ref.root === "node" && ref.channel === "logical"
          && Array.isArray(ref.segments) && ref.segments.length === 2
          && ref.segments.every((segment) => typeof segment === "string" && segment.length > 0),
        "binding_rate_unsupported");
        references.push(ref);
        return;
      }
      if (value.args !== undefined) {
        invariant(Array.isArray(value.args), "Binding.expression must be ExpressionAST/2");
        for (const argument of value.args) visit(argument);
      }
    };
    visit(expression);
    return references;
  }

  class Animation {
    constructor() {
      throw new Error("type_abstract: Animation cannot be instantiated");
    }
  }

  class NativeTimelineAnimation {
    constructor(runtime, spec, timeline, nativeMethod = "createTimeline", completion_ms = timeline.duration_ms) {
      invariant(spec.running === undefined || typeof spec.running === "boolean",
        "Animation.running must be boolean");
      invariant(spec.paused === undefined || typeof spec.paused === "boolean",
        "Animation.paused must be boolean");
      invariant(spec.autoplay === undefined || typeof spec.autoplay === "boolean",
        "Animation.autoplay must be boolean");
      invariant(spec.running === undefined || spec.autoplay === undefined || spec.running === spec.autoplay,
        "Animation.running and legacy autoplay disagree");
      invariant(spec.alwaysRunToEnd === undefined || typeof spec.alwaysRunToEnd === "boolean",
        "Animation.alwaysRunToEnd must be boolean");
      const legacyLoop = spec.loop === undefined ? undefined : (spec.loop ? -1 : 1);
      invariant(spec.loops === undefined || legacyLoop === undefined || spec.loops === legacyLoop,
        "Animation.loops and legacy loop disagree");
      const loops = spec.loops ?? legacyLoop ?? 1;
      invariant(Number.isInteger(loops) && (loops === -1 || loops >= 1),
        "Animation.loops must be Animation.Infinite (-1) or an integer >= 1");
      const shouldRun = spec.running ?? spec.autoplay ?? false;
      const shouldPause = spec.paused ?? false;
      invariant(!shouldPause || shouldRun, "Animation.paused requires running=true");
      this.runtime = runtime;
      this.spec = { ...spec };
      this.duration = timeline.duration_ms;
      this.completion_ms = completion_ms;
      this.loops = loops;
      this.alwaysRunToEnd = spec.alwaysRunToEnd ?? false;
      this.running = false;
      this.paused = false;
      this.onStarted = typeof spec.onStarted === "function" ? spec.onStarted : null;
      this.onStopped = typeof spec.onStopped === "function" ? spec.onStopped : null;
      this.onFinished = typeof spec.onFinished === "function" ? spec.onFinished : null;
      this.onRunningChanged = typeof spec.onRunningChanged === "function" ? spec.onRunningChanged : null;
      this.onPausedChanged = typeof spec.onPausedChanged === "function" ? spec.onPausedChanged : null;
      timeline.loop = loops === -1;
      invariant(typeof runtime.animationFacade[nativeMethod] === "function",
        `AnimationFacade.${nativeMethod} is unavailable`);
      invariant(typeof runtime.animationFacade.configureLifecycle === "function"
        && typeof runtime.animationFacade.controlLifecycle === "function",
      "AnimationFacade lifecycle is unavailable");
      const receipt = nativeResult(runtime.animationFacade[nativeMethod](JSON.stringify(timeline), runtime.scene),
        `AnimationFacade.${nativeMethod}`);
      this.handle = receipt.animation_handle;
      this.disposed = false;
      try {
        nativeResult(runtime.animationFacade.configureLifecycle(this.handle, JSON.stringify({
          schema_version: "AnimationLifecycleSpec/v1",
          loops: this.loops,
          always_run_to_end: this.alwaysRunToEnd,
        }), (payload) => this.lifecycleEvent(payload)), "AnimationFacade.configureLifecycle");
        runtime.animations.set(this.handle, this);
        if (spec.initial_ms !== undefined) this.seek(spec.initial_ms);
        if (shouldRun) {
          this.start();
          if (shouldPause) this.pause();
        }
        const targetHandle = timeline.target?.kind === "object" ? timeline.target.object_handle : null;
        this.targetOwner = [...runtime.objects.values(), ...runtime.models.values(), ...runtime.groups.values()]
          .find((item) => item.handle === targetHandle) || null;
        invariant(this.targetOwner, "Animation target owner disappeared during initialization");
        runtime.registerTargetDependent(this.targetOwner, this);
      } catch (error) {
        runtime.unregisterTargetDependent(this);
        try {
          nativeResult(runtime.animationFacade.dispose(this.handle), "AnimationFacade.dispose");
        } catch (cleanupError) {
          runtime.animations.set(this.handle, this);
          throw new AggregateError([error, cleanupError],
            "Animation initialization and cleanup failed; runtime retains the handle for disposal");
        }
        runtime.animations.delete(this.handle);
        this.running = false;
        this.paused = false;
        this.disposed = true;
        throw error;
      }
    }

    control(action) {
      invariant(!this.disposed, "PropertyAnimation is disposed");
      return nativeResult(this.runtime.animationFacade.controlLifecycle(this.handle, JSON.stringify(action)),
        `AnimationFacade.controlLifecycle(${action.kind})`);
    }

    unchanged(action) {
      return {
        ok: true, animation_handle: this.handle, action, changed: false,
        running: this.running, paused: this.paused,
      };
    }

    lifecycleEvent(payload) {
      if (this.disposed) return;
      const event = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (event?.schema_version !== "AnimationLifecycleEvent/v1"
        || event.animation_handle !== this.handle) return;
      const emitStopped = event.emit_stopped === true;
      const emitFinished = event.emit_finished === true;
      this.setState(false, false, () => {
        if (emitStopped) this.onStopped?.();
        if (emitFinished) this.onFinished?.();
      });
    }

    setState(running, paused, signal) {
      const runningChanged = this.running !== running;
      const pausedChanged = this.paused !== paused;
      this.running = running;
      this.paused = paused;
      for (const [property, value] of [["running", running], ["paused", paused]]) {
        const slot = this.runtime.slotKey(this, property);
        if (slot) this.runtime.writeLogical(this, property, value, { write: false, explicit: false, binding:slot.binding });
      }
      if (runningChanged) this.onRunningChanged?.(running);
      if (pausedChanged) this.onPausedChanged?.(paused);
      signal?.();
    }

    start() {
      if (this.running) return this.unchanged("start");
      const receipt = this.control({ kind: "start" });
      this.setState(true, false, () => this.onStarted?.());
      return receipt;
    }

    pause() {
      if (!this.running || this.paused) return this.unchanged("pause");
      const receipt = this.control({ kind: "pause" });
      this.setState(true, true);
      return receipt;
    }

    resume() {
      if (!this.running || !this.paused) return this.unchanged("resume");
      const receipt = this.control({ kind: "resume" });
      this.setState(true, false);
      return receipt;
    }

    stop() {
      if (!this.running) return this.unchanged("stop");
      const receipt = this.control({ kind: "stop" });
      this.setState(false, false, this.alwaysRunToEnd ? null : () => this.onStopped?.());
      return receipt;
    }

    restart() {
      this.stop();
      return this.start();
    }

    complete() {
      if (!this.running) return this.unchanged("complete");
      const receipt = this.control({ kind: "complete" });
      this.setState(false, false, () => this.onStopped?.());
      return receipt;
    }

    setRunning(value) {
      invariant(typeof value === "boolean", "Animation.running must be boolean");
      return value ? this.start() : this.stop();
    }

    setPaused(value) {
      invariant(typeof value === "boolean", "Animation.paused must be boolean");
      return value ? this.pause() : this.resume();
    }

    seek(local_ms) {
      invariant(Number.isFinite(local_ms), "Animation.seek local_ms must be finite");
      return this.control({ kind: "seek", local_ms: Math.max(0, Math.round(local_ms)) });
    }
    speed(rate_milli) { return this.control({ kind: "speed", rate_milli: Math.max(0, Math.round(rate_milli)) }); }
    setLoops(loops) {
      invariant(Number.isInteger(loops) && (loops === -1 || loops >= 1),
        "Animation.loops must be Animation.Infinite (-1) or an integer >= 1");
      const receipt = this.control({ kind: "set_loops", loops });
      this.loops = loops;
      return receipt;
    }
    setLoop(loop) {
      return this.setLoops(loop ? -1 : 1);
    }

    describe() {
      invariant(!this.disposed, "PropertyAnimation is disposed");
      const receipt = nativeResult(this.runtime.animationFacade.describe(this.handle), "AnimationFacade.describe");
      return {
        ...receipt, running: this.running, paused: this.paused,
        loops: this.loops, alwaysRunToEnd: this.alwaysRunToEnd,
      };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      const result = nativeResult(this.runtime.animationFacade.dispose(this.handle), "AnimationFacade.dispose");
      this.runtime.animations.delete(this.handle);
      this.runtime.unregisterTargetDependent(this);
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  class PropertyAnimation extends NativeTimelineAnimation {
    constructor(runtime, spec, type = "PropertyAnimation", additionalMembers = []) {
      invariant(spec && typeof spec === "object", "PropertyAnimation needs a spec");
      assertAnimationMembers(spec, type, [
        "target", "targets", "property", "properties", "exclude",
        "from", "to", "duration", "duration_ms", "easing", "keys",
        ...additionalMembers,
      ]);
      for (const member of ["targets", "properties", "exclude"]) {
        invariant(spec[member] === undefined,
          `member_unsupported: ${type}.${member} needs multi-target timeline ownership`);
      }
      propertyTarget(spec.target, runtime);
      invariant(typeof spec.property === "string", "PropertyAnimation.property is required");
      assertAnimatableProperty(spec.target, spec.property, type);
      invariant(spec.from !== undefined, "PropertyAnimation.from is required");
      const duration = propertyAnimationDuration(spec, type);
      const easing = propertyAnimationEasing(spec.easing, type);
      const keys = Array.isArray(spec.keys)
        ? spec.keys.map((key) => ({ at_ppm: key.at_ppm, value: wireValue(spec.property, key.value) }))
        : [
          { at_ppm: 0, value: wireValue(spec.property, spec.from) },
          { at_ppm: 1000000, value: wireValue(spec.property, spec.to ?? spec.from) },
        ];
      invariant(keys.length >= 2, "PropertyAnimation.keys needs at least two entries");
      let previous = -1;
      for (const key of keys) {
        invariant(Number.isInteger(key.at_ppm) && key.at_ppm >= 0 && key.at_ppm <= 1000000,
          "PropertyAnimation.keys[].at_ppm must be an integer in 0..1000000");
        invariant(key.at_ppm > previous, "PropertyAnimation.keys[].at_ppm must strictly increase");
        previous = key.at_ppm;
      }
      super(runtime, spec, {
        schema_version: "TimelineSpec/v1",
        duration_ms: duration,
        loop: Boolean(spec.loop),
        target: { kind: "object", object_handle: spec.target.handle },
        tracks: [{ property: spec.property, easing, keys }],
      });
    }
  }

  class NumberAnimation extends PropertyAnimation {
    constructor(runtime, spec) {
      invariant(typeof spec?.from === "number" && (spec.to === undefined || typeof spec.to === "number"),
        "NumberAnimation accepts numeric from/to values only");
      invariant(typeof spec.property === "string" && !spec.property.startsWith("transform.")
        && spec.property !== "visible" && !spec.property.endsWith(".color")
        && !spec.property.endsWith(".glow"),
      "NumberAnimation requires a scalar material property");
      super(runtime, spec, "NumberAnimation");
    }
  }

  class Vector3dAnimation extends PropertyAnimation {
    constructor(runtime, spec) {
      invariant(spec?.property === "transform.position" || spec?.property === "transform.scale",
        "Vector3dAnimation requires transform.position or transform.scale");
      const from = vector3(spec.from, null, "Vector3dAnimation.from");
      const to = vector3(spec.to ?? spec.from, null, "Vector3dAnimation.to");
      super(runtime, { ...spec, from, to }, "Vector3dAnimation");
    }
  }

  class QuaternionAnimation extends PropertyAnimation {
    constructor(runtime, spec) {
      invariant(spec?.property === "transform.rotation",
        "QuaternionAnimation requires transform.rotation");
      const from = quaternion(spec.from, "QuaternionAnimation.from");
      const to = quaternion(spec.to ?? spec.from, "QuaternionAnimation.to");
      super(runtime, { ...spec, from, to }, "QuaternionAnimation");
    }
  }

  class ColorAnimation extends PropertyAnimation {
    constructor(runtime, spec) {
      invariant(spec?.property === "material.color" || spec?.property === "material.glow_color",
        "ColorAnimation requires material.color or material.glow_color");
      hexColor(spec.from);
      hexColor(spec.to ?? spec.from);
      super(runtime, spec, "ColorAnimation");
    }
  }

  function directedRotationDelta(from, to, direction) {
    const raw = to - from;
    if (direction === "Numerical") return raw;
    if (direction === "Clockwise") return ((raw % 360) + 360) % 360;
    if (direction === "Counterclockwise") return -(((-raw % 360) + 360) % 360);
    const shortest = ((raw + 180) % 360 + 360) % 360 - 180;
    return shortest === -180 ? 180 : shortest;
  }

  class RotationAnimation extends PropertyAnimation {
    constructor(runtime, spec) {
      invariant(spec?.property === "transform.rotation",
        "RotationAnimation currently supports Z-up transform.rotation");
      const from = finite(spec.from, "RotationAnimation.from");
      const to = finite(spec.to ?? spec.from, "RotationAnimation.to");
      const direction = spec.direction || "Numerical";
      invariant(["Numerical", "Clockwise", "Counterclockwise", "Shortest"].includes(direction),
        "RotationAnimation.direction is unsupported");
      const delta = directedRotationDelta(from, to, direction);
      const segmentCount = Math.max(1, Math.ceil(Math.abs(delta) / 179));
      const keys = Array.from({ length: segmentCount + 1 }, (_, index) => ({
        at_ppm: Math.round(index * 1000000 / segmentCount),
        value: quaternionZ(from + delta * index / segmentCount),
      }));
      super(runtime, { ...spec, from: keys[0].value, to: keys[keys.length - 1].value, keys },
        "RotationAnimation", ["direction"]);
      this.direction = direction;
    }
  }

  class PauseAnimation {
    constructor(spec = {}) {
      const allowed = new Set(["duration", "duration_ms"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: PauseAnimation.${unsupported}`);
      const duration = propertyAnimationDuration(spec, "PauseAnimation");
      this.type = "PauseAnimation";
      this.duration = duration;
      // Compatibility for existing imperative callers. SSDL/QML authors use
      // the official `duration` property.
      this.duration_ms = duration;
      Object.freeze(this);
    }
  }

  function animationDefinition(runtime, spec) {
    invariant(spec && typeof spec === "object", "animation definition must be an object");
    const type = spec.type || "PropertyAnimation";
    if (type === "PauseAnimation") {
      const allowed = new Set(["type", "duration", "duration_ms"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: PauseAnimation.${unsupported}`);
      const duration = propertyAnimationDuration(spec, type);
      return { type, duration_ms: duration, property: null, keys: [] };
    }
    const allowed = new Set([
      "type", "target", "property", "from", "to", "duration", "duration_ms", "easing",
      ...(type === "RotationAnimation" ? ["direction"] : []),
    ]);
    const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
    invariant(!unsupported, `member_unsupported: ${type}.${unsupported}`);
    propertyTarget(spec.target, runtime);
    invariant(typeof spec.property === "string", `${type}.property is required`);
    assertAnimatableProperty(spec.target, spec.property, type);
    invariant(spec.from !== undefined, `${type}.from is required`);
    const duration = propertyAnimationDuration(spec, type);
    let from = spec.from;
    let to = spec.to ?? spec.from;
    let keys;
    if (type === "NumberAnimation") {
      invariant(typeof from === "number" && typeof to === "number", "NumberAnimation accepts numeric from/to values only");
      invariant(!spec.property.startsWith("transform.") && spec.property !== "visible"
        && !spec.property.endsWith(".color") && !spec.property.endsWith(".glow"),
      "NumberAnimation requires a scalar material property");
    } else if (type === "Vector3dAnimation") {
      invariant(spec.property === "transform.position" || spec.property === "transform.scale",
        "Vector3dAnimation requires transform.position or transform.scale");
      from = vector3(from, null, "Vector3dAnimation.from");
      to = vector3(to, null, "Vector3dAnimation.to");
    } else if (type === "QuaternionAnimation") {
      invariant(spec.property === "transform.rotation", "QuaternionAnimation requires transform.rotation");
      from = quaternion(from, "QuaternionAnimation.from");
      to = quaternion(to, "QuaternionAnimation.to");
    } else if (type === "ColorAnimation") {
      invariant(spec.property === "material.color" || spec.property === "material.glow_color",
        "ColorAnimation requires material.color or material.glow_color");
      hexColor(from);
      hexColor(to);
    } else if (type === "RotationAnimation") {
      invariant(spec.property === "transform.rotation",
        "RotationAnimation currently supports Z-up transform.rotation");
      from = finite(from, "RotationAnimation.from");
      to = finite(to, "RotationAnimation.to");
      const direction = spec.direction || "Numerical";
      invariant(["Numerical", "Clockwise", "Counterclockwise", "Shortest"].includes(direction),
        "RotationAnimation.direction is unsupported");
      const delta = directedRotationDelta(from, to, direction);
      const count = Math.max(1, Math.ceil(Math.abs(delta) / 179));
      keys = Array.from({ length: count + 1 }, (_, index) => ({
        at_ppm: Math.round(index * 1000000 / count),
        value: quaternionZ(from + delta * index / count),
      }));
    } else {
      invariant(type === "PropertyAnimation", `unsupported animation type '${type}'`);
    }
    return {
      type,
      target_handle: spec.target.handle,
      property: spec.property,
      duration_ms: duration,
      easing: propertyAnimationEasing(spec.easing, type),
      keys: keys || [{ at_ppm: 0, value: from }, { at_ppm: 1000000, value: to }],
    };
  }

  function appendKey(keys, at_ppm, value, context) {
    const last = keys[keys.length - 1];
    if (last?.at_ppm === at_ppm) {
      invariant(JSON.stringify(last.value) === JSON.stringify(value),
        `${context} has discontinuous values at a shared boundary`);
      return;
    }
    invariant(!last || at_ppm > last.at_ppm, `${context} keys must be ordered`);
    keys.push({ at_ppm, value });
  }

  function compositeTimeline(runtime, spec, mode) {
    invariant(spec && Array.isArray(spec.animations) && spec.animations.length > 0,
      `${mode}Animation.animations must not be empty`);
    const definitions = spec.animations.map((item) => animationDefinition(runtime, item));
    const active = definitions.filter((item) => item.property !== null);
    invariant(active.length > 0, `${mode}Animation needs at least one property animation`);
    const targetHandle = active[0].target_handle;
    invariant(active.every((item) => item.target_handle === targetHandle),
      `${mode}Animation children must share one target`);

    let duration;
    const tracks = [];
    if (mode === "Parallel") {
      duration = Math.max(...definitions.map((item) => item.duration_ms));
      const properties = new Set();
      for (const item of active) {
        invariant(!properties.has(item.property),
          `ParallelAnimation has multiple writers for '${item.property}'`);
        properties.add(item.property);
        const keys = item.keys.map((key) => ({
          at_ppm: Math.round(key.at_ppm * item.duration_ms / duration),
          value: wireValue(item.property, key.value),
        }));
        if (keys[keys.length - 1].at_ppm < 1000000) {
          keys.push({ at_ppm: 1000000, value: keys[keys.length - 1].value });
        }
        tracks.push({ property: item.property, easing: item.easing, keys });
      }
    } else {
      duration = definitions.reduce((total, item) => total + item.duration_ms, 0);
      const byProperty = new Map();
      let cursor = 0;
      for (const item of definitions) {
        if (item.property !== null) {
          let track = byProperty.get(item.property);
          if (!track) {
            track = { property: item.property, easing: item.easing, keys: [] };
            byProperty.set(item.property, track);
          } else {
            invariant(JSON.stringify(track.easing) === JSON.stringify(item.easing),
              `SequentialAnimation requires one easing per property '${item.property}'`);
          }
          const first = item.keys[0].value;
          if (track.keys.length === 0 && cursor > 0) appendKey(track.keys, 0, first, item.property);
          for (const key of item.keys) {
            const at = Math.round((cursor + key.at_ppm * item.duration_ms / 1000000) * 1000000 / duration);
            appendKey(track.keys, at, key.value, item.property);
          }
        }
        cursor += item.duration_ms;
      }
      for (const track of byProperty.values()) {
        const last = track.keys[track.keys.length - 1];
        if (last.at_ppm < 1000000) appendKey(track.keys, 1000000, last.value, track.property);
        track.keys = track.keys.map((key) => ({
          at_ppm: key.at_ppm,
          value: wireValue(track.property, key.value),
        }));
        tracks.push(track);
      }
    }
    return {
      schema_version: "TimelineSpec/v1",
      duration_ms: duration,
      loop: Boolean(spec.loop),
      target: { kind: "object", object_handle: targetHandle },
      tracks,
    };
  }

  class ParallelAnimation extends NativeTimelineAnimation {
    constructor(runtime, spec) {
      assertAnimationMembers(spec, "ParallelAnimation", ["animations"]);
      super(runtime, spec, compositeTimeline(runtime, spec, "Parallel"));
    }
  }

  class SequentialAnimation extends NativeTimelineAnimation {
    constructor(runtime, spec) {
      assertAnimationMembers(spec, "SequentialAnimation", ["animations"]);
      super(runtime, spec, compositeTimeline(runtime, spec, "Sequential"));
    }
  }

  class Keyframe {
    constructor(spec = {}) {
      invariant(Object.keys(spec).every((name) => ["frame", "value"].includes(name)),
        "member_unsupported: Keyframe only supports frame and value");
      this.frame = finite(spec.frame, "Keyframe.frame");
      invariant(spec.value !== undefined, "Keyframe.value is required");
      this.value = spec.value;
      Object.freeze(this);
    }
  }

  class KeyframeGroup {
    constructor(spec = {}) {
      invariant(Object.keys(spec).every((name) => ["target", "property", "keyframes"].includes(name)),
        "member_unsupported: KeyframeGroup only supports target, property and keyframes");
      invariant(spec.target && typeof spec.target.handle === "string", "KeyframeGroup.target is required");
      invariant(typeof spec.property === "string" && spec.property.length > 0,
        "KeyframeGroup.property is required");
      invariant(Array.isArray(spec.keyframes) && spec.keyframes.length >= 2,
        "KeyframeGroup.keyframes needs at least two entries");
      this.target = spec.target;
      this.property = spec.property;
      this.keyframes = spec.keyframes.map((item) => item instanceof Keyframe ? item : new Keyframe(item));
      for (let index = 1; index < this.keyframes.length; ++index) {
        invariant(this.keyframes[index].frame > this.keyframes[index - 1].frame,
          "KeyframeGroup frames must strictly increase");
      }
      Object.freeze(this.keyframes);
      Object.freeze(this);
    }
  }

  class Timeline {
    constructor(runtime, spec = {}) {
      invariant(Object.keys(spec).every((name) => ["id", "key", "startFrame", "endFrame", "currentFrame", "enabled", "keyframeGroups"].includes(name)),
        "member_unsupported: Timeline member has no adapter");
      this.id = spec.id || spec.key || null;
      this.startFrame = finite(spec.startFrame ?? 0, "Timeline.startFrame");
      this.endFrame = finite(spec.endFrame, "Timeline.endFrame");
      invariant(this.endFrame > this.startFrame, "Timeline.endFrame must be greater than startFrame");
      this.currentFrame = finite(spec.currentFrame ?? this.startFrame, "Timeline.currentFrame");
      invariant(this.currentFrame >= this.startFrame && this.currentFrame <= this.endFrame,
        "Timeline.currentFrame must lie in startFrame..endFrame");
      invariant(spec.enabled === undefined || typeof spec.enabled === "boolean",
        "Timeline.enabled must be boolean");
      this.enabled = spec.enabled !== false;
      invariant(Array.isArray(spec.keyframeGroups) && spec.keyframeGroups.length > 0,
        "Timeline.keyframeGroups must not be empty");
      this.keyframeGroups = spec.keyframeGroups.map((item) => item instanceof KeyframeGroup ? item : new KeyframeGroup(item));
      for (const group of this.keyframeGroups) propertyTarget(group.target, runtime);
      const target = this.keyframeGroups[0].target.handle;
      invariant(this.keyframeGroups.every((group) => group.target.handle === target),
        "Timeline keyframe groups must share one target in the current native capability");
      const properties = new Set();
      for (const group of this.keyframeGroups) {
        invariant(!properties.has(group.property), `Timeline has multiple KeyframeGroups for '${group.property}'`);
        properties.add(group.property);
        invariant(group.keyframes[0].frame >= this.startFrame
          && group.keyframes[group.keyframes.length - 1].frame <= this.endFrame,
        `KeyframeGroup '${group.property}' frames must lie inside Timeline bounds`);
      }
      Object.freeze(this.keyframeGroups);
    }

    toNative(duration_ms, loop) {
      invariant(Number.isInteger(duration_ms) && duration_ms >= 1,
        "TimelineAnimation.duration_ms must be an integer >= 1");
      const span = this.endFrame - this.startFrame;
      return {
        schema_version: "TimelineSpec/v1",
        duration_ms,
        loop: Boolean(loop),
        target: { kind: "object", object_handle: this.keyframeGroups[0].target.handle },
        tracks: this.keyframeGroups.map((group) => ({
          property: group.property,
          easing: { kind: "linear" },
          keys: group.keyframes.map((keyframe) => ({
            at_ppm: Math.round((keyframe.frame - this.startFrame) * 1000000 / span),
            value: wireValue(group.property, keyframe.value),
          })),
        })),
      };
    }
  }

  class TimelineAnimation extends NativeTimelineAnimation {
    constructor(runtime, spec = {}) {
      assertAnimationMembers(spec, "TimelineAnimation", [
        "timeline", "duration", "duration_ms", "from", "to", "pingPong",
      ]);
      invariant(spec.timeline instanceof Timeline, "TimelineAnimation.timeline must be a Timeline");
      invariant(spec.pingPong === undefined || typeof spec.pingPong === "boolean",
        "TimelineAnimation.pingPong must be boolean");
      const from = finite(spec.from ?? spec.timeline.startFrame, "TimelineAnimation.from");
      const to = finite(spec.to ?? spec.timeline.endFrame, "TimelineAnimation.to");
      invariant(from >= spec.timeline.startFrame && from <= spec.timeline.endFrame,
        "TimelineAnimation.from must lie in Timeline.startFrame..endFrame");
      invariant(to >= spec.timeline.startFrame && to <= spec.timeline.endFrame,
        "TimelineAnimation.to must lie in Timeline.startFrame..endFrame");
      const duration = propertyAnimationDuration(spec, "TimelineAnimation");
      const span = spec.timeline.endFrame - spec.timeline.startFrame;
      const fromPpm = Math.round((from - spec.timeline.startFrame) * 1000000 / span);
      const toPpm = Math.round((to - spec.timeline.startFrame) * 1000000 / span);
      const directedSpan = to - from;
      const progress = directedSpan === 0 ? 0
        : Math.max(0, Math.min(1, (spec.timeline.currentFrame - from) / directedSpan));
      const initial_ms = spec.initial_ms ?? Math.round(
        progress * duration,
      );
      const native = spec.timeline.toNative(duration, spec.loop);
      native.schema_version = "SSDLTimelineAnimationSpec/v1";
      native.ping_pong = spec.pingPong ?? false;
      native.window_from_ppm = fromPpm;
      native.window_to_ppm = toPpm;
      super(runtime, { ...spec, initial_ms }, native, "createTimelineAnimation",
        duration * (native.ping_pong ? 2 : 1));
      this.timeline = spec.timeline;
      this.from = from;
      this.to = to;
      this.pingPong = native.ping_pong;
      if (!this.timeline.enabled) this.pause();
    }
  }

  class DriverAnimation {
    constructor(runtime, spec, kind, params) {
      invariant(spec?.target instanceof SceneObject && !spec.target.disposed,
        `${spec?.component_type || "DriverAnimation"}.target must be a live scene object`);
      this.runtime = runtime;
      this.target = spec.target;
      this.component_type = spec.component_type;
      const receipt = nativeResult(runtime.animationFacade.createDriver(JSON.stringify({
        schema_version: "DriverSpec/v1",
        kind,
        target: { kind: "object", object_handle: this.target.handle },
        params,
      }), runtime.scene), "AnimationFacade.createDriver");
      this.handle = receipt.animation_handle;
      this.disposed = false;
      runtime.drivers.set(this.handle, this);
      this.target.drivers.push(this);
      if (spec.autoplay !== false) this.start();
    }

    control(kind) {
      invariant(!this.disposed, `${this.component_type} is disposed`);
      return nativeResult(this.runtime.animationFacade.control(this.handle, JSON.stringify({ kind })),
        `AnimationFacade.control(${kind})`);
    }

    start() { return this.control("start"); }
    pause() { return this.control("pause"); }
    stop() { return this.control("stop"); }
    restart() { this.stop(); return this.start(); }
    describe() {
      invariant(!this.disposed, `${this.component_type} is disposed`);
      return nativeResult(this.runtime.animationFacade.describe(this.handle), "AnimationFacade.describe");
    }
    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      const result = nativeResult(this.runtime.animationFacade.dispose(this.handle), "AnimationFacade.dispose");
      this.runtime.drivers.delete(this.handle);
      const index = this.target.drivers.indexOf(this);
      if (index >= 0) this.target.drivers.splice(index, 1);
      this.disposed = true;
      return result;
    }
  }

  class OrbitAnimation extends DriverAnimation {
    constructor(runtime, spec = {}) {
      const allowed = new Set(["target", "center", "radius", "axis", "angularSpeed", "phase", "faceTravel", "autoplay"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: SSE.OrbitAnimation.${unsupported}`);
      const center = vector3(spec.center, null, "SSE.OrbitAnimation.center");
      const radius = finite(spec.radius, "SSE.OrbitAnimation.radius");
      const angularSpeed = finite(spec.angularSpeed, "SSE.OrbitAnimation.angularSpeed");
      const phase = finite(spec.phase ?? 0, "SSE.OrbitAnimation.phase");
      invariant(["x", "y", "z"].includes(spec.axis || "z"), "SSE.OrbitAnimation.axis is unsupported");
      super(runtime, { ...spec, component_type: "SSE.OrbitAnimation" }, "transform_orbit", {
        axis: spec.axis || "z",
        center_um: { x_um: Math.round(center.x * 1e6), y_um: Math.round(center.y * 1e6), z_um: Math.round(center.z * 1e6) },
        radius_um: Math.round(radius * 1e6),
        angular_speed_mdeg_per_s: Math.round(angularSpeed * 1000),
        phase_mdeg: ((Math.round(phase * 1000) % 360000) + 360000) % 360000,
        face_travel: Boolean(spec.faceTravel),
      });
    }
  }

  class Path3DAnimation extends DriverAnimation {
    constructor(runtime, spec = {}) {
      const allowed = new Set(["target", "path", "speed", "loopMode", "orient", "phaseSeed", "autoplay"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: SSE.Path3DAnimation.${unsupported}`);
      invariant(Array.isArray(spec.path) && spec.path.length >= 2 && spec.path.length <= 1024,
        "SSE.Path3DAnimation.path needs 2..1024 points");
      const points = spec.path.map((point, index) => meshPoint(point, `SSE.Path3DAnimation.path[${index}]`));
      for (let index = 1; index < points.length; ++index) {
        invariant(points[index].x !== points[index - 1].x || points[index].y !== points[index - 1].y
          || points[index].z !== points[index - 1].z,
        "SSE.Path3DAnimation.path must not repeat adjacent points");
      }
      const speed = finite(spec.speed, "SSE.Path3DAnimation.speed");
      const phaseSeed = spec.phaseSeed ?? 0;
      invariant(Number.isInteger(phaseSeed) && phaseSeed >= 0 && phaseSeed <= 0xffffffff,
        "SSE.Path3DAnimation.phaseSeed must be a uint32");
      const loopMode = spec.loopMode || "loop";
      const orient = spec.orient || "none";
      invariant(["loop", "once", "ping_pong"].includes(loopMode), "SSE.Path3DAnimation.loopMode is unsupported");
      invariant(["none", "tangent"].includes(orient), "SSE.Path3DAnimation.orient is unsupported");
      super(runtime, { ...spec, component_type: "SSE.Path3DAnimation" }, "follow_path", {
        path: {
          kind: "explicit",
          waypoints_um: points.map((point) => ({
            x_um: Math.round(point.x * 1e6), y_um: Math.round(point.y * 1e6), z_um: Math.round(point.z * 1e6),
          })),
        },
        speed_mm_per_s: Math.round(speed * 1000),
        loop_mode: loopMode,
        orient,
        phase_seed: phaseSeed,
      });
    }
  }

  class CurrentTransitionAnimation {
    constructor(runtime, receipt, spec, onSettled = null) {
      this.runtime = runtime;
      this.handle = receipt.animation_handle;
      this.spec = spec;
      this.disposed = false;
      this.onSettled = onSettled;
      runtime.animations.set(this.handle, this);
    }

    settle() {
      const callback = this.onSettled;
      this.onSettled = null;
      callback?.();
    }

    nativeCompleted() {
      if (this.disposed) return;
      try { this.dispose(); }
      catch (error) {
        // The native completion boundary is authoritative even if later
        // record cleanup is refused. Keep the handle in runtime.animations so
        // runtime disposal can retry, but do not leave Transition.running true.
        this.settle();
        this.runtime.emit("animationerror", Object.freeze({
          animation: this.handle, code: "completion_cleanup_failed", error,
        }));
      }
    }

    control(kind, extra = {}) {
      invariant(!this.disposed, "transition animation is disposed");
      return nativeResult(this.runtime.animationFacade.control(this.handle, JSON.stringify({ kind, ...extra })),
        `AnimationFacade.control(${kind})`);
    }

    start() { return this.control("start"); }
    pause() { return this.control("pause"); }
    stop() { return this.control("stop"); }
    restart() { this.stop(); return this.start(); }
    complete() {
      this.control("seek", { local_ms: this.spec.duration_ms + (this.spec.delay_ms || 0) });
      return this.pause();
    }
    describe() {
      invariant(!this.disposed, "transition animation is disposed");
      return nativeResult(this.runtime.animationFacade.describe(this.handle), "AnimationFacade.describe");
    }
    superseded() {
      this.runtime.animations.delete(this.handle);
      this.disposed = true;
      this.settle();
    }
    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      const result = nativeResult(this.runtime.animationFacade.dispose(this.handle), "AnimationFacade.dispose");
      this.runtime.animations.delete(this.handle);
      this.disposed = true;
      this.settle();
      return result;
    }
  }

  function behaviorAnimationDefinition(spec, property) {
    if (spec.animation === undefined) {
      invariant(Number.isInteger(spec.duration_ms) && spec.duration_ms >= 1,
        "Behavior.duration_ms must be an integer >= 1");
      return Object.freeze({
        type: "PropertyAnimation",
        duration_ms: spec.duration_ms,
        easing: propertyAnimationEasing(spec.easing, "Behavior"),
      });
    }
    invariant(spec.duration_ms === undefined && spec.easing === undefined,
      "Behavior.animation cannot be combined with legacy duration_ms/easing");
    const animation = spec.animation;
    invariant(animation && typeof animation === "object" && !Array.isArray(animation),
      "Behavior.animation must be an animation definition");
    const type = animation.type || "PropertyAnimation";
    const allowed = new Set(["type", "duration", "duration_ms", "easing"]);
    const unsupported = Object.keys(animation).find((name) => !allowed.has(name));
    invariant(!unsupported, `member_unsupported: Behavior.animation.${unsupported}`);
    invariant([
      "PropertyAnimation", "NumberAnimation", "Vector3dAnimation",
      "QuaternionAnimation", "ColorAnimation",
    ].includes(type), `member_unsupported: Behavior.animation type '${type}'`);
    if (type === "NumberAnimation") {
      invariant(!property.startsWith("transform.") && property !== "visible"
        && !property.endsWith(".color") && !property.endsWith(".glow_color"),
      "Behavior NumberAnimation requires a scalar material property");
    } else if (type === "Vector3dAnimation") {
      invariant(property === "transform.position" || property === "transform.scale",
        "Behavior Vector3dAnimation requires transform.position or transform.scale");
    } else if (type === "QuaternionAnimation") {
      invariant(property === "transform.rotation",
        "Behavior QuaternionAnimation requires transform.rotation");
    } else if (type === "ColorAnimation") {
      invariant(property === "material.color" || property === "material.glow_color",
        "Behavior ColorAnimation requires material.color or material.glow_color");
    }
    return Object.freeze({
      type,
      duration_ms: propertyAnimationDuration(animation, type),
      easing: propertyAnimationEasing(animation.easing, type),
    });
  }

  function behaviorTargetValue(animation, value) {
    if (animation.type === "NumberAnimation") {
      return finite(value, "Behavior NumberAnimation target");
    }
    if (animation.type === "Vector3dAnimation") {
      return vector3(value, null, "Behavior Vector3dAnimation target");
    }
    if (animation.type === "QuaternionAnimation") {
      return quaternion(value, "Behavior QuaternionAnimation target");
    }
    if (animation.type === "ColorAnimation") {
      hexColor(value);
      return value;
    }
    return value;
  }

  class Binding {
    constructor(runtime, spec = {}) {
      const allowed = new Set(["id", "key", "target", "property", "expression", "when"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: Binding.${unsupported}`);
      invariant(runtime.expressionEvaluate, "expression_runtime_unavailable");
      invariant(spec.target && typeof spec.target === "object" && spec.target.runtime === runtime
        && spec.target.disposed !== true,
      "Binding.target must be a live component from the same runtime");
      invariant(typeof spec.property === "string" && spec.property.length > 0,
        "Binding.property is required");
      invariant(spec.expression && typeof spec.expression === "object" && !Array.isArray(spec.expression),
        "Binding.expression must be ExpressionAST/2");
      invariant(spec.when === undefined || typeof spec.when === "boolean", "Binding.when must be boolean");
      this.runtime = runtime;
      this.id = spec.id || spec.key || `binding-${++runtime.bindingSequence}`;
      invariant(typeof this.id === "string" && this.id.length > 0, "Binding.id or key must be a non-empty string");
      invariant(!runtime.bindings.has(this.id), `Binding '${this.id}' is already registered`);
      this.target = spec.target;
      this.property = spec.property;
      const expressionJson = canonicalJson(spec.expression);
      this.expression = freezeJson(JSON.parse(expressionJson));
      this.expression_digest = `sha256:${sha256Text(expressionJson)}`;
      this.when = spec.when !== false;
      this.state = this.when ? "pending" : "inactive";
      this.version = 0;
      this.value = undefined;
      this.disposed = false;
      this.slot = runtime.ensureLogicalSlot(this.target, this.property);
      invariant(this.slot.descriptor.writable !== false,
        `member_readonly: '${runtime.ownerId(this.target)}.${this.property}' cannot be a Binding target`);
      invariant(this.slot.binding === null,
        `property_bound: '${runtime.ownerId(this.target)}.${this.property}' already has a Binding`);
      const references = expressionReferences(this.expression);
      const unique = new Map();
      for (const reference of references) {
        const slot = runtime.slotByReference(reference.segments[0], reference.segments[1]);
        if (!slot || slot.removed) {
          throw codedError("unknown_reference",
            `unknown_reference: '${reference.segments[0]}.${reference.segments[1]}'`);
        }
        unique.set(slot.key, slot);
      }
      this.dependencies = Object.freeze([...unique.values()]);
      this.slot.binding = this;
      for (const dependency of this.dependencies) dependency.dependents.add(this);
      runtime.bindings.set(this.id, this);
      try {
        runtime.bindingOrder();
      } catch (error) {
        runtime.bindings.delete(this.id);
        this.slot.binding = null;
        for (const dependency of this.dependencies) dependency.dependents.delete(this);
        throw error;
      }
      runtime.registerLogicalSlot(this, "when", this.when);
      if (this.when) runtime.queueBinding(this);
    }

    setWhen(value) {
      invariant(!this.disposed, "Binding is disposed");
      invariant(typeof value === "boolean", "Binding.when must be boolean");
      return this.runtime.writeLogical(this, "when", value, { skipIfSame: true });
    }

    applyWhen(value) {
      if (this.when === value) return { ok: true, changed: false, state: this.state };
      if (value) {
        this.when = true;
        this.state = "pending";
        this.runtime.queueBinding(this);
      } else {
        const previousState = this.state;
        this.when = false;
        try {
          this.runtime.restoreBindingValue(this);
          this.state = "inactive";
        } catch (error) {
          this.when = true;
          this.state = previousState;
          throw error;
        }
      }
      return { ok: true, changed: true, state: this.state };
    }

    invalidate(code, error = codedError(code), options = {}) {
      if (this.disposed) return;
      this.state = "invalid";
      this.slot.valid = false;
      this.runtime.emit("bindingerror", Object.freeze({ binding: this.id, code, error }));
      if (options.propagate !== false && !this.slot.removed) this.runtime.markSlotChanged(this.slot);
    }

    describe() {
      return {
        id: this.id,
        target: this.runtime.ownerId(this.target),
        property: this.property,
        expression_digest: this.expression_digest,
        state: this.state,
        version: this.version,
        value: cloneLogical(this.value),
      };
    }

    dispose(options = {}) {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      const restore = options.restore !== false && !this.slot.removed;
      const previousWhen = this.when;
      if (restore) {
        this.when = false;
        try { this.runtime.restoreSlotExplicitValue(this.slot); }
        catch (error) { this.when = previousWhen; throw error; }
      }
      this.runtime.bindings.delete(this.id);
      this.runtime.pendingBindings.delete(this);
      if (this.slot.binding === this) this.slot.binding = null;
      for (const dependency of this.dependencies) dependency.dependents.delete(this);
      this.runtime.disposeOwnerSlots(this);
      this.disposed = true;
      this.state = "disposed";
      return { ok: true, removed: true, idempotent: false };
    }
  }

  class Behavior {
    constructor(runtime, spec = {}) {
      const allowed = new Set([
        "id", "key", "target", "property", "animation", "enabled",
        // Compatibility fields for existing imperative callers. SSDL/QML
        // authors declare one animation child instead.
        "duration_ms", "easing",
      ]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: Behavior.${unsupported}`);
      propertyTarget(spec.target, runtime);
      invariant(typeof spec.property === "string" && spec.property.length > 0,
        "Behavior.property is required");
      assertAnimatableProperty(spec.target, spec.property, "Behavior");
      invariant(spec.enabled === undefined || typeof spec.enabled === "boolean",
        "Behavior.enabled must be boolean");
      invariant(![...runtime.behaviors].some((item) => !item.disposed
        && item.target.handle === spec.target.handle && item.property === spec.property),
      `Behavior already registered for '${spec.property}' on this target`);
      const animation = behaviorAnimationDefinition(spec, spec.property);
      this.runtime = runtime;
      this.id = spec.id || spec.key || null;
      this.component_type = "Behavior";
      runtime.assertReferenceIdAvailable(this.id);
      this.target = spec.target;
      this.property = spec.property;
      this.targetProperty = Object.freeze({ object: this.target, name: this.property });
      this.animation = animation;
      this.duration_ms = animation.duration_ms;
      this.easing = animation.easing;
      this.enabled = spec.enabled !== false;
      this.logicalTarget = undefined;
      this.motion = null;
      this.disposed = false;
      // Locator rigs keep member-kind slots (writes go through SceneGraphFacade) but animate natively.
      this.slot = this.target instanceof Group || this.target instanceof GeoAnchor
        ? runtime.ensureLogicalSlot(this.target, this.property)
        : runtime.ensureNativeSlot(this.target, this.property);
      invariant(!this.slot.behavior, `Behavior already registered for '${spec.property}' on this target`);
      this.slot.behavior = this;
      runtime.behaviors.add(this);
      runtime.registerLogicalSlot(this, "enabled", this.enabled);
      runtime.registerTargetDependent(this.target, this);
    }

    get targetValue() { return this.logicalTarget; }

    setTarget(value, previousMotion = this.motion) {
      invariant(!this.disposed, "Behavior is disposed");
      return this.runtime.writeLogical(this.target, this.property,
        behaviorTargetValue(this.animation, value), { previousMotion });
    }

    presentLogical(value, previousMotion = this.motion) {
      invariant(!this.disposed, "Behavior is disposed");
      if (!this.enabled) {
        if (this.motion) {
          this.motion.dispose();
          this.motion = null;
        }
        const receipt = writeNativeProperty(this.runtime, this.target, this.property, value);
        this.logicalTarget = value;
        return receipt;
      }
      const request = {
        schema_version: "CurrentTransitionSpec/v1",
        duration_ms: this.duration_ms,
        target: propertyTarget(this.target, this.runtime),
        property: this.property,
        to: wireValue(this.property, value),
        easing: this.easing,
      };
      if (previousMotion) request.replace_handle = previousMotion.handle;
      const previous = previousMotion;
      let motion = null;
      const receipt = nativeResult(this.runtime.animationFacade.createCurrentTransition(
        JSON.stringify(request), this.runtime.scene, () => motion?.nativeCompleted()),
      "AnimationFacade.createCurrentTransition");
      if (previous) previous.superseded();
      motion = new CurrentTransitionAnimation(this.runtime, receipt, request, () => {
        if (this.motion === motion) this.motion = null;
      });
      this.motion = motion;
      this.logicalTarget = value;
      return receipt;
    }

    setEnabled(value) {
      invariant(!this.disposed, "Behavior is disposed");
      invariant(typeof value === "boolean", "Behavior.enabled must be boolean");
      if (this.enabled === value) return { ok: true, changed: false, enabled: value };
      return this.runtime.writeLogical(this, "enabled", value);
    }

    applyEnabled(value) {
      const enabled = value;
      if (!enabled) {
        if (this.motion) {
          this.motion.dispose();
          this.motion = null;
        }
        if (this.logicalTarget !== undefined) {
          writeNativeProperty(this.runtime, this.target, this.property, this.logicalTarget);
        }
      }
      this.enabled = enabled;
      return { ok: true, changed: true, enabled };
    }

    complete() { return this.motion?.complete() || null; }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.runtime.disposeTargetDependents(this);
      if (this.motion) this.motion.dispose();
      this.runtime.behaviors.delete(this);
      this.runtime.unregisterTargetDependent(this);
      if (this.slot?.behavior === this) this.slot.behavior = null;
      this.motion = null;
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return { ok: true, removed: true, idempotent: false };
    }
  }

  class PropertyChanges {
    constructor(spec = {}) {
      const allowed = new Set(["target", "values", "restoreEntryValues"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: PropertyChanges.${unsupported}`);
      invariant(spec.target && typeof spec.target.handle === "string", "PropertyChanges.target is required");
      invariant(spec.values && typeof spec.values === "object" && !Array.isArray(spec.values),
        "PropertyChanges.values must be an object");
      invariant(Object.keys(spec.values).length > 0, "PropertyChanges.values must not be empty");
      invariant(spec.restoreEntryValues === undefined || typeof spec.restoreEntryValues === "boolean",
        "PropertyChanges.restoreEntryValues must be boolean");
      this.target = spec.target;
      this.values = Object.freeze({ ...spec.values });
      this.restoreEntryValues = spec.restoreEntryValues ?? true;
      Object.freeze(this);
    }
  }

  class State {
    constructor(runtime, spec = {}) {
      const allowed = new Set(["id", "key", "name", "when", "changes", "extend"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: State.${unsupported}`);
      invariant(typeof spec.name === "string" && spec.name.length > 0, "State.name is required");
      invariant(spec.id === undefined || typeof spec.id === "string" && spec.id.length > 0,
        "State.id must be a non-empty string");
      invariant(spec.key === undefined || typeof spec.key === "string" && spec.key.length > 0,
        "State.key must be a non-empty string");
      invariant(spec.when === undefined || typeof spec.when === "boolean", "State.when must be boolean");
      invariant(spec.extend === undefined || typeof spec.extend === "string", "State.extend must be a string");
      invariant(spec.changes === undefined || Array.isArray(spec.changes), "State.changes must be an array");
      this.runtime = runtime;
      this.id = spec.id || spec.key || spec.name;
      this.key = spec.key || this.id;
      this.component_type = "State";
      this.name = spec.name;
      this.when = spec.when ?? false;
      this.extend = spec.extend || "";
      this.changes = (spec.changes || []).map((item) =>
        item instanceof PropertyChanges ? item : new PropertyChanges(item));
      Object.freeze(this.changes);
      this.controller = null;
      this.disposed = false;
    }

    attachController(controller) {
      invariant(!this.disposed, `State '${this.name}' is disposed`);
      invariant(this.runtime === controller.runtime,
        `State '${this.name}' must belong to the same runtime as its StateController`);
      invariant(this.controller === null || this.controller === controller,
        `State '${this.name}' already belongs to another StateController`);
      this.controller = controller;
    }

    detachController(controller) {
      if (this.controller === controller) this.controller = null;
    }

    setWhen(value) {
      invariant(!this.disposed, "State is disposed");
      invariant(typeof value === "boolean", "State.when must be boolean");
      return this.runtime.writeLogical(this, "when", value, { skipIfSame: true });
    }

    applyWhen(value) {
      if (this.controller) {
        const destination = this.controller.whenStateFor(this, value);
        this.controller.setState(destination);
      }
      this.when = value;
      return { ok: true, changed: true, when: value };
    }
  }

  class PropertyAction {
    constructor(spec = {}) {
      const allowed = new Set(["target", "property", "value"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: PropertyAction.${unsupported}`);
      invariant(spec.target && typeof spec.target.handle === "string", "PropertyAction.target is required");
      invariant(typeof spec.property === "string" && spec.property.length > 0, "PropertyAction.property is required");
      invariant(spec.value !== undefined, "PropertyAction.value is required");
      this.target = spec.target;
      this.property = spec.property;
      this.value = spec.value;
      Object.freeze(this);
    }

    run(runtime) { return runtime.writeLogical(this.target, this.property, this.value, { direct: true }); }
  }

  function statePattern(value, field) {
    invariant(typeof value === "string",
      `${field} must be a state name, comma-separated state names or '*'`);
    return value;
  }

  function statePatternScore(pattern, state) {
    const names = pattern.split(",").map((name) => name.trim());
    if (names.includes(state)) return 1;
    return names.includes("*") ? 0 : -1;
  }

  function transitionAnimationAcceptsProperty(type, property) {
    if (type === "NumberAnimation") {
      return !property.startsWith("transform.") && property !== "visible"
        && !property.endsWith(".color") && !property.endsWith(".glow_color");
    }
    if (type === "Vector3dAnimation") {
      return property === "transform.position" || property === "transform.scale";
    }
    if (type === "QuaternionAnimation") return property === "transform.rotation";
    if (type === "ColorAnimation") {
      return property === "material.color" || property === "material.glow_color";
    }
    return type === "PropertyAnimation";
  }

  function transitionAnimationDefinition(spec) {
    invariant(spec && typeof spec === "object" && !Array.isArray(spec),
      "Transition.animations[] must be an animation definition");
    const type = spec.type || "PropertyAnimation";
    const allowed = new Set(["type", "property", "properties", "duration", "duration_ms", "easing"]);
    const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
    invariant(!unsupported, `member_unsupported: Transition.${type}.${unsupported}`);
    invariant([
      "PropertyAnimation", "NumberAnimation", "Vector3dAnimation",
      "QuaternionAnimation", "ColorAnimation",
    ].includes(type), `member_unsupported: Transition animation type '${type}'`);
    invariant(spec.property === undefined || (typeof spec.property === "string" && spec.property.length > 0),
      `Transition.${type}.property must be a non-empty string`);
    invariant(spec.properties === undefined || typeof spec.properties === "string",
      `Transition.${type}.properties must be a comma-separated string`);
    invariant(spec.property === undefined || spec.properties === undefined,
      `Transition.${type} cannot combine property and properties`);
    const properties = spec.property === undefined && spec.properties === undefined
      ? null
      : (spec.property === undefined ? spec.properties.split(",") : [spec.property])
        .map((name) => name.trim()).filter(Boolean);
    invariant(properties === null || properties.length > 0,
      `Transition.${type}.properties must name at least one property`);
    invariant(properties === null || properties.every((property) => transitionAnimationAcceptsProperty(type, property)),
      `Transition.${type} property type is incompatible`);
    return Object.freeze({
      type,
      properties: properties === null ? null : Object.freeze(properties),
      duration_ms: propertyAnimationDuration(spec, type),
      easing: propertyAnimationEasing(spec.easing, type),
    });
  }

  function transitionPropertyActionDefinition(spec) {
    const allowed = new Set(["type", "target", "property", "value"]);
    const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
    invariant(!unsupported, `member_unsupported: Transition.PropertyAction.${unsupported}`);
    invariant(spec.target === undefined || (spec.target && typeof spec.target.handle === "string"),
      "Transition.PropertyAction.target must be a scene object");
    invariant(spec.property === undefined || (typeof spec.property === "string" && spec.property.length > 0),
      "Transition.PropertyAction.property must be a non-empty string");
    invariant(!Object.hasOwn(spec, "value") || spec.value !== undefined,
      "Transition.PropertyAction cannot explicitly write undefined");
    return Object.freeze({
      type: "PropertyAction",
      target: spec.target || null,
      property: spec.property || null,
      hasValue: Object.hasOwn(spec, "value"),
      value: spec.value,
    });
  }

  function transitionAnimationTree(spec, delayMs = 0) {
    invariant(spec && typeof spec === "object" && !Array.isArray(spec),
      "Transition.animations[] must be an animation definition");
    const type = spec.type || "PropertyAnimation";
    if (type === "PropertyAction") {
      invariant(delayMs === 0, "Transition delayed PropertyAction is unsupported");
      return { animations: [transitionPropertyActionDefinition(spec)], duration_ms: 0 };
    }
    if (type === "PauseAnimation") {
      const allowed = new Set(["type", "duration", "duration_ms"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: Transition.PauseAnimation.${unsupported}`);
      return { animations: [], duration_ms: propertyAnimationDuration(spec, type) };
    }
    if (type === "ParallelAnimation" || type === "SequentialAnimation") {
      const allowed = new Set(["type", "animations"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: Transition.${type}.${unsupported}`);
      invariant(Array.isArray(spec.animations) && spec.animations.length > 0,
        `Transition.${type}.animations must not be empty`);
      const animations = [];
      let duration = 0;
      if (type === "ParallelAnimation") {
        for (const child of spec.animations) {
          const lowered = transitionAnimationTree(child, delayMs);
          animations.push(...lowered.animations);
          duration = Math.max(duration, lowered.duration_ms);
        }
      } else {
        let cursor = 0;
        for (const child of spec.animations) {
          const lowered = transitionAnimationTree(child, delayMs + cursor);
          animations.push(...lowered.animations);
          cursor += lowered.duration_ms;
        }
        duration = cursor;
      }
      return { animations, duration_ms: duration };
    }
    const animation = transitionAnimationDefinition(spec);
    return {
      animations: [Object.freeze({ ...animation, delay_ms: delayMs })],
      duration_ms: animation.duration_ms,
    };
  }

  function reverseTransitionEasing(easing) {
    const pairs = {
      in_quad: "out_quad", out_quad: "in_quad",
      in_cubic: "out_cubic", out_cubic: "in_cubic",
      in_sine: "out_sine", out_sine: "in_sine",
    };
    if (easing.kind === "cubic_bezier") {
      return Object.freeze({
        kind: "cubic_bezier",
        x1_milli: 1000 - easing.x2_milli,
        y1_milli: 1000 - easing.y2_milli,
        x2_milli: 1000 - easing.x1_milli,
        y2_milli: 1000 - easing.y1_milli,
      });
    }
    return Object.freeze({ ...easing, kind: pairs[easing.kind] || easing.kind });
  }

  const transitionActivity = new WeakMap();

  class Transition {
    constructor(spec = {}) {
      const allowed = new Set([
        "from", "to", "animations", "reversible", "enabled", "onRunningChanged",
        // Compatibility fields for the existing imperative state controller.
        "duration_ms", "easing", "properties", "actions",
      ]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: Transition.${unsupported}`);
      invariant(spec.enabled === undefined || typeof spec.enabled === "boolean",
        "Transition.enabled must be boolean");
      invariant(spec.onRunningChanged === undefined || typeof spec.onRunningChanged === "function",
        "Transition.onRunningChanged must be a function");
      this.onRunningChanged = spec.onRunningChanged || null;
      this.enabled = spec.enabled ?? true;
      this.from = statePattern(spec.from ?? "*", "Transition.from");
      this.to = statePattern(spec.to ?? "*", "Transition.to");
      invariant(spec.reversible === undefined || typeof spec.reversible === "boolean",
        "Transition.reversible must be boolean");
      this.reversible = spec.reversible ?? false;
      invariant(spec.properties === undefined || (Array.isArray(spec.properties)
        && spec.properties.every((name) => typeof name === "string" && name.length > 0)),
      "Transition.properties must be an array of property names");
      invariant(spec.animations === undefined || Array.isArray(spec.animations),
        "Transition.animations must be an array");
      invariant(spec.animations === undefined || (spec.duration_ms === undefined
        && spec.easing === undefined && spec.properties === undefined),
      "Transition.animations cannot be combined with legacy duration_ms/easing/properties");
      let composedDuration = 0;
      if (spec.animations !== undefined) {
        const animations = [];
        for (const animation of spec.animations) {
          const lowered = transitionAnimationTree(animation);
          animations.push(...lowered.animations);
          composedDuration = Math.max(composedDuration, lowered.duration_ms);
        }
        this.animations = Object.freeze(animations);
      } else if (spec.duration_ms !== undefined || spec.easing !== undefined || spec.properties !== undefined) {
        invariant(Number.isInteger(spec.duration_ms) && spec.duration_ms >= 1,
          "Transition.duration_ms must be an integer >= 1");
        this.animations = Object.freeze([Object.freeze({
          type: "PropertyAnimation",
          properties: spec.properties ? Object.freeze(spec.properties.slice()) : null,
          duration_ms: spec.duration_ms,
          delay_ms: 0,
          easing: propertyAnimationEasing(spec.easing, "Transition"),
        })]);
        composedDuration = spec.duration_ms;
      } else {
        this.animations = Object.freeze([]);
      }
      this.motionAnimations = Object.freeze(this.animations.filter((animation) =>
        animation.type !== "PropertyAction"));
      this.propertyActions = Object.freeze(this.animations.filter((animation) =>
        animation.type === "PropertyAction"));
      // Compatibility observations for callers that used one flat animation.
      this.duration_ms = this.motionAnimations.length === 0 ? null : composedDuration;
      this.easing = this.motionAnimations.length === 1 ? this.motionAnimations[0].easing : null;
      this.properties = this.motionAnimations.length === 1 ? this.motionAnimations[0].properties : null;
      invariant(spec.actions === undefined || Array.isArray(spec.actions), "Transition.actions must be an array");
      this.actions = Object.freeze((spec.actions || []).map((item) => item instanceof PropertyAction ? item : new PropertyAction(item)));
      transitionActivity.set(this, { count: 0 });
      Object.freeze(this);
    }

    get running() { return transitionActivity.get(this)?.count > 0; }
    motionStarted() {
      const activity = transitionActivity.get(this);
      const wasRunning = activity.count > 0;
      activity.count += 1;
      if (!wasRunning) this.onRunningChanged?.(true);
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        activity.count = Math.max(0, activity.count - 1);
        if (activity.count === 0) this.onRunningChanged?.(false);
      };
    }

    matchScore(from, to) {
      if (!this.enabled) return -1;
      const fromScore = statePatternScore(this.from, from);
      const toScore = statePatternScore(this.to, to);
      const direct = fromScore < 0 || toScore < 0 ? -1 : fromScore + toScore;
      if (!this.reversible) return direct;
      const reverseFrom = statePatternScore(this.to, from);
      const reverseTo = statePatternScore(this.from, to);
      const reverse = reverseFrom < 0 || reverseTo < 0 ? -1 : reverseFrom + reverseTo;
      return Math.max(direct, reverse);
    }
    matches(from, to) { return this.matchScore(from, to) >= 0; }
    isReverse(from, to) {
      if (!this.reversible) return false;
      const directFrom = statePatternScore(this.from, from);
      const directTo = statePatternScore(this.to, to);
      const direct = directFrom < 0 || directTo < 0 ? -1 : directFrom + directTo;
      const reverseFrom = statePatternScore(this.to, from);
      const reverseTo = statePatternScore(this.from, to);
      const reverse = reverseFrom < 0 || reverseTo < 0 ? -1 : reverseFrom + reverseTo;
      return reverse > direct;
    }
    animationFor(property, from = null, to = null) {
      const matches = this.motionAnimations.filter((animation) =>
        (animation.properties === null || animation.properties.includes(property))
        && transitionAnimationAcceptsProperty(animation.type, property));
      invariant(matches.length <= 1,
        `Transition has multiple animations for '${property}'`);
      const match = matches[0] || null;
      if (!match || from === null || !this.isReverse(from, to)) return match;
      return Object.freeze({
        ...match,
        delay_ms: this.duration_ms - match.delay_ms - match.duration_ms,
        easing: reverseTransitionEasing(match.easing),
      });
    }
    propertyActionFor(target, property) {
      const matches = this.propertyActions.filter((action) =>
        (action.target === null || action.target.handle === target.handle)
        && (action.property === null || action.property === property));
      invariant(matches.length <= 1,
        `Transition has multiple PropertyActions for '${property}'`);
      return matches[0] || null;
    }
    animates(property) { return this.animationFor(property) !== null; }
  }

  class StateController {
    constructor(runtime, spec = {}) {
      const allowed = new Set(["id", "key", "states", "transitions", "initialState"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `StateController.${unsupported} is unsupported`);
      invariant(Array.isArray(spec.states) && spec.states.length > 0, "StateController.states must not be empty");
      this.runtime = runtime;
      this.id = spec.id || spec.key || `state-controller-${runtime.stateControllers.size + 1}`;
      invariant(!runtime.stateControllers.has(this.id), `StateController '${this.id}' is already registered`);
      this.states = new Map();
      for (const item of spec.states) {
        const state = item instanceof State ? item : new State(runtime, item);
        invariant(!this.states.has(state.name), `State '${state.name}' is duplicated`);
        invariant(!state.disposed && state.runtime === runtime,
          `State '${state.name}' must be live and belong to the same runtime as its StateController`);
        invariant(state.controller === null || state.controller === this,
          `State '${state.name}' already belongs to another StateController`);
        this.states.set(state.name, state);
      }
      this.resolvedChanges = new Map();
      const resolving = new Set();
      const resolveChanges = (state) => {
        if (this.resolvedChanges.has(state.name)) return this.resolvedChanges.get(state.name);
        invariant(!resolving.has(state.name), `State.extend cycle includes '${state.name}'`);
        resolving.add(state.name);
        const inherited = [];
        if (state.extend) {
          const base = this.states.get(state.extend);
          invariant(base, `State '${state.name}' extends unknown state '${state.extend}'`);
          inherited.push(...resolveChanges(base));
        }
        resolving.delete(state.name);
        const resolved = Object.freeze([...inherited, ...state.changes]);
        this.resolvedChanges.set(state.name, resolved);
        return resolved;
      };
      for (const state of this.states.values()) resolveChanges(state);
      this.entryValues = new Map();
      for (const changes of this.resolvedChanges.values()) {
        for (const change of changes) {
          invariant(change.target.runtime === runtime && change.target.disposed !== true,
            "PropertyChanges.target must be a live component from the same runtime");
          for (const property of Object.keys(change.values)) {
            const key = `${change.target.handle}|${property}`;
            if (this.entryValues.has(key)) continue;
            const slot = runtime.ensureLogicalSlot(change.target, property);
            const value = cloneLogical(slot.value);
            this.entryValues.set(key, Object.freeze({
              target: change.target,
              property,
              value: value && typeof value === "object" ? Object.freeze(value) : value,
              wireValue: slot.descriptor.kind === "native"
                ? Object.freeze(wireValue(property, value)) : null,
            }));
          }
        }
      }
      this.transitions = (spec.transitions || []).map((item) => item instanceof Transition ? item : new Transition(item));
      for (const transition of this.transitions) {
        for (const action of transition.actions) {
          invariant(action.target.runtime === runtime && action.target.disposed !== true,
            "PropertyAction.target must be a live component from the same runtime");
        }
        for (const action of transition.propertyActions) {
          invariant(action.target === null
            || (action.target.runtime === runtime && action.target.disposed !== true),
          "Transition.PropertyAction.target must be a live component from the same runtime");
        }
      }
      this.motions = new Map();
      this.current = null;
      this.disposed = false;
      runtime.stateControllers.set(this.id, this);
      const selected = spec.initialState !== undefined
        ? spec.initialState
        : [...this.states.values()].find((state) => state.when)?.name ?? "";
      try {
        for (const state of this.states.values()) state.attachController(this);
        if (selected === "") this.current = "";
        else this.setState(selected, { immediate: true });
        const targets = new Set();
        for (const changes of this.resolvedChanges.values()) {
          for (const change of changes) targets.add(change.target);
        }
        for (const transition of this.transitions) {
          for (const action of transition.actions) targets.add(action.target);
          for (const action of transition.propertyActions) {
            if (action.target) targets.add(action.target);
          }
        }
        for (const target of targets) runtime.registerTargetDependent(target, this);
      } catch (error) {
        for (const state of this.states.values()) state.detachController(this);
        runtime.unregisterTargetDependent(this);
        runtime.stateControllers.delete(this.id);
        this.disposed = true;
        throw error;
      }
    }

    whenStateFor(changedState = null, changedWhen = false) {
      return [...this.states.values()].find((state) =>
        (state === changedState ? changedWhen : state.when))?.name ?? "";
    }

    valuesForState(name) {
      const effectiveEntryValues = new Map(this.entryValues);
      const entryUpdates = new Map();
      const destinationChanges = name === "" ? [] : this.resolvedChanges.get(name);
      const destinationKeys = new Set(destinationChanges.flatMap((changes) =>
        Object.keys(changes.values).map((property) => `${changes.target.handle}|${property}`)));
      if (this.current && this.current !== "") {
        for (const changes of this.resolvedChanges.get(this.current)) {
          if (changes.restoreEntryValues) continue;
          for (const [property, value] of Object.entries(changes.values)) {
            const key = `${changes.target.handle}|${property}`;
            const slot = this.runtime.ensureLogicalSlot(changes.target, property);
            const logicalValue = normalizeLogical(slot.descriptor, value,
              `${changes.target.component_type || "SceneObject"}.${property}`);
            const entry = Object.freeze({
              target: changes.target,
              property,
              value: logicalValue && typeof logicalValue === "object"
                ? Object.freeze(cloneLogical(logicalValue)) : logicalValue,
              wireValue: slot.descriptor.kind === "native"
                ? Object.freeze(wireValue(property, logicalValue)) : null,
            });
            effectiveEntryValues.set(key, entry);
            entryUpdates.set(key, entry);
          }
        }
      }
      const values = new Map([...effectiveEntryValues].map(([key, entry]) => [key, {
        target: entry.target,
        property: entry.property,
        value: cloneLogical(entry.value),
        wireValue: entry.wireValue,
        fromEntry: true,
      }]));
      for (const key of entryUpdates.keys()) {
        if (!destinationKeys.has(key)) values.delete(key);
      }
      if (name !== "") {
        for (const changes of destinationChanges) {
          for (const [property, value] of Object.entries(changes.values)) {
            values.set(`${changes.target.handle}|${property}`, {
              target: changes.target, property, value, wireValue: null, fromEntry: false,
            });
          }
        }
      }
      return { values: [...values.values()], entryUpdates };
    }

    transitionFor(from, to) {
      let selected = null;
      let bestScore = -1;
      for (const item of this.transitions) {
        const score = item.matchScore(from, to);
        if (score > bestScore) {
          selected = item;
          bestScore = score;
        }
      }
      return selected;
    }

    setState(name, options = {}) {
      invariant(!this.disposed, "StateController is disposed");
      const state = name === "" ? null : this.states.get(name);
      invariant(name === "" || state, `State '${name}' is not registered`);
      if (this.current === name) return { ok: true, unchanged: true, state: name };
      const from = this.current || "";
      const transition = options.immediate ? null : this.transitionFor(from, name);
      let animated = false;
      const stateValues = this.valuesForState(name);
      const plans = stateValues.values.map((entry) => {
        const slot = this.runtime.ensureLogicalSlot(entry.target, entry.property);
        const value = normalizeLogical(slot.descriptor, entry.value,
          `${entry.target.component_type || "SceneObject"}.${entry.property}`);
        const propertyAction = transition?.propertyActionFor(entry.target, entry.property) || null;
        const transitionAnimation = transition?.animationFor(entry.property, from, name) || null;
        const actionValue = propertyAction?.hasValue ? normalizeLogical(slot.descriptor,
          propertyAction.value, `Transition.PropertyAction.${entry.property}`) : value;
        if (transitionAnimation && slot.descriptor.kind === "native") {
          wireValue(entry.property, behaviorTargetValue(transitionAnimation, value));
        }
        return {
          entry: { ...entry, value }, propertyAction, transitionAnimation, slot, actionValue,
        };
      });
      for (const plan of plans) {
        this.runtime.assertLogicalWritable(plan.entry.target, plan.entry.property);
        if (plan.transitionAnimation && plan.slot.descriptor.kind !== "native") {
          throw codedError("property_not_animatable",
            `property_not_animatable: '${this.runtime.ownerId(plan.entry.target)}.${plan.entry.property}' has event-rate writes only`);
        }
      }
      if (transition) {
        for (const action of transition.propertyActions) {
          invariant(plans.some((plan) => plan.propertyAction === action),
            "Transition.PropertyAction must match a property in the destination state");
        }
        for (const action of transition.actions) {
          invariant(action.target.runtime === this.runtime && action.target.disposed !== true,
            "PropertyAction.target must be a live component from the same runtime");
          const slot = this.runtime.assertLogicalWritable(action.target, action.property);
          normalizeLogical(slot.descriptor, action.value, `PropertyAction.${action.property}`);
        }
      }
      for (const plan of plans) {
        plan.behavior = [...this.runtime.behaviors].find((item) => !item.disposed
          && item.target === plan.entry.target && item.property === plan.entry.property) || null;
      }
      // Property setters live behind several native facades, so a State change
      // cannot rely on one native transaction. Capture every affected logical
      // slot before the first mutation and compensate in reverse order if any
      // later setter refuses the transition. This keeps `current` and the
      // presented values on the same side of the state boundary.
      const slotSnapshots = new Map();
      const captureSlot = (target, property) => {
        const slot = this.runtime.ensureLogicalSlot(target, property);
        if (!slotSnapshots.has(slot)) {
          slotSnapshots.set(slot, Object.freeze({
            slot,
            target,
            property,
            value: cloneLogical(slot.value),
            valid: slot.valid,
            explicitValue: cloneLogical(slot.explicitValue),
            wireValue: slot.descriptor.kind === "native"
              ? Object.freeze(wireValue(property, slot.value)) : null,
          }));
        }
      };
      for (const plan of plans) captureSlot(plan.entry.target, plan.entry.property);
      if (transition) {
        for (const action of transition.actions) captureSlot(action.target, action.property);
      }
      const priorMotions = new Map(this.motions);
      const behaviorSnapshots = new Map(plans.filter((plan) => plan.behavior).map((plan) => [
        plan.behavior,
        Object.freeze({
          motion: plan.behavior.motion,
          logicalTarget: cloneLogical(plan.behavior.logicalTarget),
          targetValue: cloneLogical(plan.behavior.targetValue),
        }),
      ]));
      try {
        if (transition) {
          for (const action of transition.actions) action.run(this.runtime);
        }
        for (const plan of plans) {
          const { entry, propertyAction, transitionAnimation, actionValue } = plan;
          const { target, property, value } = entry;
          const key = `${target.handle}|${property}`;
          const previous = this.motions.get(key);
          const behavior = plan.behavior;
          if (propertyAction) {
            if (previous) {
              previous.dispose();
              this.motions.delete(key);
            }
            if (behavior?.motion) {
              behavior.motion.dispose();
              behavior.motion = null;
            }
            if (!propertyAction.hasValue && entry.fromEntry) {
              this.runtime.writeLogical(target, property, value, {
                direct: true, wireValue: entry.wireValue,
              });
            } else {
              this.runtime.writeLogical(target, property, actionValue, { direct: true });
            }
          } else if (transitionAnimation) {
            const request = {
              schema_version: "CurrentTransitionSpec/v1",
              duration_ms: transitionAnimation.duration_ms,
              delay_ms: transitionAnimation.delay_ms,
              target: propertyTarget(target, this.runtime),
              property,
              to: entry.fromEntry
                ? entry.wireValue
                : wireValue(property, behaviorTargetValue(transitionAnimation, value)),
              easing: transitionAnimation.easing,
            };
            const replaced = previous || behavior?.motion;
            if (replaced) request.replace_handle = replaced.handle;
            let motion = null;
            const receipt = nativeResult(this.runtime.animationFacade.createCurrentTransition(
              JSON.stringify(request), this.runtime.scene, () => motion?.nativeCompleted()),
            "AnimationFacade.createCurrentTransition");
            if (replaced) replaced.superseded();
            if (behavior) {
              behavior.motion = null;
              behavior.logicalTarget = value;
            }
            this.runtime.writeLogical(target, property, value, { write: false });
            const settleTransition = transition.motionStarted();
            motion = new CurrentTransitionAnimation(this.runtime, receipt, request, () => {
              settleTransition();
              if (this.motions.get(key) === motion) this.motions.delete(key);
            });
            this.motions.set(key, motion);
            animated = true;
          } else if (!options.immediate && behavior?.enabled) {
            behavior.setTarget(value, previous || behavior.motion);
            this.motions.delete(key);
            animated = true;
          } else {
            if (previous) {
              previous.dispose();
              this.motions.delete(key);
            }
            if (entry.fromEntry) {
              this.runtime.writeLogical(target, property, value, {
                direct: true, wireValue: entry.wireValue,
              });
            } else this.runtime.writeLogical(target, property, value, { direct: true });
          }
        }
        for (const [key, entry] of stateValues.entryUpdates) {
          this.entryValues.set(key, entry);
          this.runtime.promoteExplicit(entry.target, entry.property, entry.value);
        }
        this.current = name;
        this.runtime.emit("statechange", { controller: this.id, from, to: name });
        return { ok: true, unchanged: false, from, state: name, animated };
      } catch (error) {
        const rollbackErrors = [];
        for (const [key, motion] of this.motions) {
          if (priorMotions.get(key) === motion) continue;
          try { motion.dispose(); }
          catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        this.motions.clear();
        for (const [key, motion] of priorMotions) {
          if (!motion.disposed) this.motions.set(key, motion);
        }
        for (const [behavior, snapshot] of behaviorSnapshots) {
          if (behavior.motion && behavior.motion !== snapshot.motion && !behavior.motion.disposed) {
            try { behavior.motion.dispose(); }
            catch (rollbackError) { rollbackErrors.push(rollbackError); }
          }
          behavior.motion = snapshot.motion && !snapshot.motion.disposed ? snapshot.motion : null;
          behavior.logicalTarget = cloneLogical(snapshot.logicalTarget);
          behavior.targetValue = cloneLogical(snapshot.targetValue);
        }
        for (const snapshot of [...slotSnapshots.values()].reverse()) {
          const { slot, target, property } = snapshot;
          if (slot.removed || (!slot.valid && !snapshot.valid)
            || (slot.valid === snapshot.valid && logicalEqual(slot.value, snapshot.value))) continue;
          try {
            this.runtime.writeLogical(target, property, snapshot.value, {
              direct: true,
              explicit: false,
              propagate: false,
              wireValue: snapshot.wireValue,
            });
            slot.valid = snapshot.valid;
            slot.explicitValue = cloneLogical(snapshot.explicitValue);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        error.state_rollback = Object.freeze({
          ok: rollbackErrors.length === 0,
          errors: Object.freeze(rollbackErrors),
        });
        throw error;
      }
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      for (const motion of this.motions.values()) motion.dispose();
      this.motions.clear();
      this.runtime.stateControllers.delete(this.id);
      this.runtime.unregisterTargetDependent(this);
      for (const state of this.states.values()) state.detachController(this);
      this.disposed = true;
      return { ok: true, removed: true, idempotent: false };
    }
  }

  class Scene {
    constructor(runtime, spec = {}) {
      const allowed = new Set(["id", "key"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: Scene.${unsupported}`);
      invariant(runtime.sceneRoot === null, "only one Scene ownership root is allowed per runtime");
      this.runtime = runtime;
      this.id = spec.id || spec.key || "scene";
      this.key = spec.key || this.id;
      this.handle = runtime.locatorHandle;
      runtime.sceneRoot = this;
    }
  }

  class SceneObject {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "SceneObject needs a spec");
      const allowed = new Set([
        "id", "key", "kind", "component_type", "params", "parent",
        "position", "x", "y", "z", "rotation", "rotation_z", "scale", "visible",
        // Compatibility appearance shortcuts; QML authors normally use a
        // PrincipledMaterial child.
        "color", "opacity", "glow",
      ]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: ${(spec.component_type || "SceneObject")}.${unsupported}`);
      invariant(spec.rotation === undefined || spec.rotation_z === undefined,
        `${spec.component_type || "SceneObject"}.rotation and rotation_z are mutually exclusive`);
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "SceneObject.id or key is required");
      invariant(spec.visible === undefined || typeof spec.visible === "boolean",
        `${spec.component_type || "SceneObject"}.visible must be boolean`);
      const position = nodePosition(spec, spec.component_type || "SceneObject");
      const rotation = spec.rotation !== undefined
        ? quaternion(spec.rotation, `${spec.component_type || "SceneObject"}.rotation`)
        : quaternionZ(spec.rotation_z || 0);
      const scale = vector3(spec.scale, { x: 1, y: 1, z: 1 }, `${spec.component_type || "SceneObject"}.scale`);
      normalizeLogical(nativeLogicalDescriptor("transform.scale"), scale,
        `${spec.component_type || "SceneObject"}.scale`);
      const parentHandle = spec.parent?.handle || spec.parent || runtime.locatorHandle;
      invariant(typeof parentHandle === "string", "SceneObject.parent must be a Group, GeoAnchor or locator handle");
      if (spec.parent && typeof spec.parent === "object") {
        invariant(spec.parent.runtime === runtime
          && (spec.parent instanceof Scene || spec.parent instanceof Group || spec.parent instanceof GeoAnchor)
          && spec.parent.disposed !== true,
        "SceneObject.parent must be a live Scene, Group or GeoAnchor from the same runtime");
      }
      if (spec.color !== undefined) wireValue("material.color", spec.color);
      if (spec.opacity !== undefined) normalizeLogical(nativeLogicalDescriptor("material.opacity"), spec.opacity,
        `${spec.component_type || "SceneObject"}.opacity`);
      if (spec.glow !== undefined) {
        invariant(spec.glow && typeof spec.glow === "object" && !Array.isArray(spec.glow),
          "SceneObject.glow must be an object");
        wireValue("material.glow_color", spec.glow.color);
      }
      this.runtime = runtime;
      this.spec = { ...spec, id };
      invariant(!runtime.objects.has(id), `SceneObject id '${id}' is already in use`);
      invariant(!runtime.groups.has(id), `SceneObject id '${id}' is already in use by a group`);
      runtime.assertReferenceIdAvailable(id);
      const kind = spec.kind || "box";
      const createMethod = kind === "polygon" ? "createPolygon"
        : kind === "extrude" ? "createParametric" : kind === "mesh" ? "createMesh" : "createPrimitive";
      invariant(typeof runtime.geometryFacade[createMethod] === "function",
        `GeometryFacade does not provide ${createMethod}`);
      const geometrySpec = {
        schema_version: kind === "polygon" ? "SSDLPolygonSpec/v1" : "GeometrySpec/v2",
        coordinate_system: "right_handed_z_up",
        unit: "m",
        winding: "ccw",
        index_type: "u32",
        params: spec.params,
      };
      if (kind !== "polygon") geometrySpec.kind = kind;
      const created = nativeResult(runtime.geometryFacade[createMethod](JSON.stringify(geometrySpec)),
        `GeometryFacade.${createMethod}`);
      this.handle = created.geometry_handle;
      // Kept verbatim: PrefabFacade rebuilds its own renderer from these exact bytes, so a Prefab that
      // uses this node as its source must hand over the spec that was actually built, not a re-derived one.
      this.geometrySpec = geometrySpec;
      // Older native builds did not return stream metadata; absence means false.
      this.geometryHasUv = created.has_uv === true;
      this.geometryHasTangent = created.has_tangent === true;
      this.animations = [];
      this.drivers = [];
      this.materials = new Set();
      this.disposed = false;
      this.transform = { position, rotation, scale };
      try {
        nativeResult(runtime.geometryFacade.attachObject(this.handle, runtime.scene, JSON.stringify({
          transform: this.transform,
          material_ref: null,
          placement: "scene_root",
        })), "GeometryFacade.attachObject");
        nativeResult(runtime.sceneGraphFacade.reparent(runtime.scene, JSON.stringify({
          target: this.handle,
          parent: parentHandle,
          preserve_world_transform: false,
        })), "SceneGraphFacade.reparent");
        this.visible = spec.visible ?? true;
        runtime.objects.set(id, this);
        runtime.registerNativeSlot(this, "transform.position", position);
        runtime.registerNativeSlot(this, "transform.rotation", rotation);
        runtime.registerNativeSlot(this, "transform.scale", scale);
        runtime.registerNativeSlot(this, "visible", this.visible);
        if (spec.visible !== undefined) runtime.writeLogical(this, "visible", this.visible);
        if (spec.color !== undefined || spec.opacity !== undefined || spec.glow !== undefined) {
          this.style({ color: spec.color, opacity: spec.opacity, glow: spec.glow });
        }
      } catch (error) {
        runtime.objects.delete(id);
        runtime.disposeOwnerSlots(this);
        try { nativeResult(runtime.geometryFacade.dispose(this.handle), "GeometryFacade.dispose(after create failure)"); }
        catch (_) { /* preserve the primary creation failure */ }
        this.disposed = true;
        throw error;
      }
    }

    style(spec) {
      if (spec.color) this.runtime.writeLogical(this, "material.color", spec.color);
      if (spec.opacity !== undefined) this.runtime.writeLogical(this, "material.opacity", spec.opacity);
      if (spec.glow) {
        this.runtime.writeLogical(this, "material.glow", true);
        this.runtime.writeLogical(this, "material.glow_color", spec.glow.color);
      }
      return this;
    }

    animate(spec) {
      invariant(spec && typeof spec.kind === "string", "SceneObject.animate.kind is required");
      return new DriverAnimation(this.runtime, {
        target: this,
        autoplay: spec.autoplay,
        component_type: `SSE.${spec.kind}`,
      }, spec.kind, spec.params);
    }

    setTransform(patch) {
      invariant(!this.disposed, "SceneObject is disposed");
      invariant(patch && typeof patch === "object" && !Array.isArray(patch),
        "SceneObject.setTransform needs a patch");
      const allowed = new Set(["position", "x", "y", "z", "rotation", "rotation_z", "scale"]);
      const unsupported = Object.keys(patch).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: ${(this.spec.component_type || "SceneObject")}.${unsupported}`);
      invariant(patch.rotation === undefined || patch.rotation_z === undefined,
        `${this.spec.component_type || "SceneObject"}.rotation and rotation_z are mutually exclusive`);
      const transform = { target: this.handle, space: "local" };
      const next = { ...this.transform };
      if (patch.position !== undefined || ["x", "y", "z"].some((axis) => patch[axis] !== undefined)) {
        const base = patch.position === undefined ? next.position : vector3(patch.position, null,
          `${this.spec.component_type || "SceneObject"}.position`);
        transform.position = next.position = nodePosition({ position: base, x: patch.x, y: patch.y, z: patch.z },
          this.spec.component_type || "SceneObject");
        this.runtime.assertLogicalWritable(this, "transform.position");
      }
      if (patch.scale !== undefined) {
        transform.scale = next.scale = vector3(patch.scale, null,
          `${this.spec.component_type || "SceneObject"}.scale`);
        this.runtime.assertLogicalWritable(this, "transform.scale");
      }
      if (patch.rotation !== undefined || patch.rotation_z !== undefined) {
        transform.rotation = next.rotation = patch.rotation !== undefined
          ? quaternion(patch.rotation, `${this.spec.component_type || "SceneObject"}.rotation`)
          : quaternionZ(patch.rotation_z);
        this.runtime.assertLogicalWritable(this, "transform.rotation");
      }
      const result = nativeResult(this.runtime.sceneGraphFacade.setTransform(JSON.stringify(transform)),
        "SceneGraphFacade.setTransform");
      for (const property of ["position", "rotation", "scale"]) {
        if (transform[property] !== undefined) {
          this.runtime.writeLogical(this, `transform.${property}`, transform[property], { write: false });
        }
      }
      this.transform = next;
      return result;
    }

    setVisible(value) {
      invariant(!this.disposed, "SceneObject is disposed");
      invariant(typeof value === "boolean", `${this.spec.component_type || "SceneObject"}.visible must be boolean`);
      const result = this.runtime.writeLogical(this, "visible", value);
      this.visible = value;
      return result;
    }

    snapshot() {
      return {
        id: this.spec.id,
        handle: this.handle,
        kind: this.spec.kind || "box",
        component_type: this.spec.component_type || "SceneObject",
        has_uv: this.geometryHasUv,
        has_tangent: this.geometryHasTangent,
      };
    }

    describe() {
      invariant(!this.disposed, "SceneObject is disposed");
      const facade = this.runtime.geometryFacade;
      const receipt = typeof facade.describe === "function"
        ? nativeResult(facade.describe(this.handle), "GeometryFacade.describe")
        : { geometry_handle: this.handle };
      // Preserve creation metadata when an intermediate native facade lacks describe fields.
      if (receipt.has_uv !== undefined) this.geometryHasUv = receipt.has_uv === true;
      if (receipt.has_tangent !== undefined) this.geometryHasTangent = receipt.has_tangent === true;
      return { ...receipt, has_uv: this.geometryHasUv, has_tangent: this.geometryHasTangent };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.runtime.disposeTargetDependents(this);
      for (const material of [...this.materials]) material.dispose();
      for (const item of this.animations) item.dispose();
      for (const driver of [...this.drivers]) driver.dispose();
      const result = nativeResult(this.runtime.geometryFacade.dispose(this.handle), "GeometryFacade.dispose");
      this.runtime.objects.delete(this.spec.id);
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  class Group {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "Group needs a spec");
      const allowed = new Set(["id", "key", "parent", "position", "x", "y", "z", "rotation", "rotation_z", "scale", "visible"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: Group.${unsupported}`);
      invariant(spec.rotation === undefined || spec.rotation_z === undefined,
        "Group.rotation and Group.rotation_z are mutually exclusive");
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "Group.id or key is required");
      invariant(!runtime.groups.has(id) && !runtime.objects.has(id),
        `Group id '${id}' is already in use`);
      runtime.assertReferenceIdAvailable(id);
      this.runtime = runtime;
      this.id = id;
      this.component_type = "Group";
      this.disposed = false;
      const parentHandle = spec.parent?.handle || spec.parent || runtime.locatorHandle;
      invariant(typeof parentHandle === "string", "Group.parent must be a Group, GeoAnchor or locator handle");
      if (spec.parent && typeof spec.parent === "object") {
        invariant(spec.parent.runtime === runtime
          && (spec.parent instanceof Scene || spec.parent instanceof Group || spec.parent instanceof GeoAnchor)
          && spec.parent.disposed !== true,
        "Group.parent must be a live Scene, Group or GeoAnchor from the same runtime");
      }
      this.transform = {
        position: nodePosition(spec, "Group"),
        rotation: spec.rotation !== undefined
          ? quaternion(spec.rotation, "Group.rotation") : quaternionZ(spec.rotation_z || 0),
        scale: vector3(spec.scale, { x: 1, y: 1, z: 1 }, "Group.scale"),
      };
      normalizeLogical(nativeLogicalDescriptor("transform.scale"), this.transform.scale, "Group.scale");
      invariant(spec.visible === undefined || typeof spec.visible === "boolean", "Group.visible must be boolean");
      this.visible = spec.visible !== false;
      const created = nativeResult(runtime.sceneGraphFacade.createLocator(runtime.scene, JSON.stringify({
        anchor: null,
        parent: parentHandle,
        transform: this.transform,
        visible: this.visible,
      })), "SceneGraphFacade.createLocator");
      this.handle = created.locator_handle;
      try {
        runtime.groups.set(this.id, this);
        runtime.registerLogicalSlot(this, "transform.position", this.transform.position);
        runtime.registerLogicalSlot(this, "transform.rotation", this.transform.rotation);
        runtime.registerLogicalSlot(this, "transform.scale", this.transform.scale);
        runtime.registerLogicalSlot(this, "visible", this.visible);
      } catch (error) {
        runtime.groups.delete(this.id);
        runtime.disposeOwnerSlots(this);
        try { nativeResult(runtime.sceneGraphFacade.dispose(runtime.scene, this.handle),
          "SceneGraphFacade.dispose(after create failure)"); } catch (_) { /* preserve the primary failure */ }
        this.disposed = true;
        throw error;
      }
    }

    setTransform(patch) {
      invariant(!this.disposed, `${this.component_type} is disposed`);
      invariant(patch && typeof patch === "object" && !Array.isArray(patch),
        `${this.component_type}.setTransform needs a patch`);
      const allowed = new Set(["position", "x", "y", "z", "rotation", "rotation_z", "scale"]);
      const unsupported = Object.keys(patch).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: ${this.component_type}.${unsupported}`);
      invariant(patch.rotation === undefined || patch.rotation_z === undefined,
        `${this.component_type}.rotation and rotation_z are mutually exclusive`);
      const transform = { target: this.handle, space: "local" };
      const next = { ...this.transform };
      if (patch.position !== undefined || ["x", "y", "z"].some((axis) => patch[axis] !== undefined)) {
        const base = patch.position === undefined ? next.position
          : vector3(patch.position, null, `${this.component_type}.position`);
        transform.position = next.position = nodePosition({
          position: base, x: patch.x, y: patch.y, z: patch.z,
        }, this.component_type);
        this.runtime.assertLogicalWritable(this, "transform.position");
      }
      if (patch.scale !== undefined) {
        transform.scale = next.scale = normalizeLogical(nativeLogicalDescriptor("transform.scale"),
          patch.scale, `${this.component_type}.scale`);
        this.runtime.assertLogicalWritable(this, "transform.scale");
      }
      if (patch.rotation !== undefined || patch.rotation_z !== undefined) {
        transform.rotation = next.rotation = patch.rotation !== undefined
          ? quaternion(patch.rotation, `${this.component_type}.rotation`)
          : quaternionZ(patch.rotation_z);
        this.runtime.assertLogicalWritable(this, "transform.rotation");
      }
      const result = nativeResult(this.runtime.sceneGraphFacade.setTransform(JSON.stringify(transform)),
        "SceneGraphFacade.setTransform");
      for (const property of ["position", "rotation", "scale"]) {
        if (transform[property] !== undefined) {
          this.runtime.writeLogical(this, `transform.${property}`, transform[property], { write: false });
        }
      }
      this.transform = next;
      return result;
    }

    applyTransformProperty(property, value) {
      invariant(!this.disposed, `${this.component_type} is disposed`);
      const member = property.startsWith("transform.") ? property.slice(10) : "";
      invariant(["position", "rotation", "scale"].includes(member),
        `member_unsupported: ${this.component_type}.${property}`);
      const result = nativeResult(this.runtime.sceneGraphFacade.setTransform(JSON.stringify({
        target: this.handle,
        space: "local",
        [member]: value,
      })), "SceneGraphFacade.setTransform");
      this.transform = { ...this.transform, [member]: cloneLogical(value) };
      return result;
    }

    setVisible(value) {
      invariant(!this.disposed, `${this.component_type} is disposed`);
      invariant(typeof value === "boolean", `${this.component_type}.visible must be boolean`);
      const result = this.runtime.writeLogical(this, "visible", value);
      this.visible = value;
      return result;
    }

    applyVisible(value) {
      invariant(!this.disposed, `${this.component_type} is disposed`);
      const result = nativeResult(this.runtime.sceneGraphFacade.setVisible(JSON.stringify({
        target: this.handle,
        visible: value,
      })), "SceneGraphFacade.setVisible");
      this.visible = value;
      return result;
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.runtime.disposeTargetDependents(this);
      const result = nativeResult(this.runtime.sceneGraphFacade.dispose(this.runtime.scene, this.handle),
        "SceneGraphFacade.dispose");
      this.runtime.groups.delete(this.id);
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  class GeoAnchor {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "GeoAnchor needs a spec");
      const allowed = new Set([
        "id", "key", "longitude", "latitude", "altitude",
        "position", "x", "y", "z", "rotation", "rotation_z", "scale", "visible",
      ]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: GeoAnchor.${unsupported}`);
      invariant(spec.rotation === undefined || spec.rotation_z === undefined,
        "GeoAnchor.rotation and GeoAnchor.rotation_z are mutually exclusive");
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "GeoAnchor.id or key is required");
      invariant(!runtime.groups.has(id) && !runtime.objects.has(id),
        `GeoAnchor id '${id}' is already in use`);
      runtime.assertReferenceIdAvailable(id);
      const longitude = finite(spec.longitude, "GeoAnchor.longitude");
      const latitude = finite(spec.latitude, "GeoAnchor.latitude");
      const altitude = finite(spec.altitude ?? 0, "GeoAnchor.altitude");
      invariant(longitude >= -180 && longitude <= 180, "GeoAnchor.longitude must be in -180..180");
      invariant(latitude >= -90 && latitude <= 90, "GeoAnchor.latitude must be in -90..90");
      this.transform = {
        position: nodePosition(spec, "GeoAnchor"),
        rotation: spec.rotation !== undefined
          ? quaternion(spec.rotation, "GeoAnchor.rotation") : quaternionZ(spec.rotation_z || 0),
        scale: vector3(spec.scale, { x: 1, y: 1, z: 1 }, "GeoAnchor.scale"),
      };
      normalizeLogical(nativeLogicalDescriptor("transform.scale"), this.transform.scale, "GeoAnchor.scale");
      invariant(spec.visible === undefined || typeof spec.visible === "boolean", "GeoAnchor.visible must be boolean");
      this.visible = spec.visible !== false;
      const created = nativeResult(runtime.sceneGraphFacade.createLocator(runtime.scene, JSON.stringify({
        anchor: { lon: longitude, lat: latitude, height: altitude },
        parent: null,
        transform: this.transform,
        visible: this.visible,
      })), "SceneGraphFacade.createLocator");
      this.runtime = runtime;
      this.id = id;
      this.component_type = "GeoAnchor";
      this.handle = created.locator_handle;
      this.disposed = false;
      this.anchor = Object.freeze({ longitude, latitude, altitude });
      try {
        runtime.groups.set(this.id, this);
        runtime.registerLogicalSlot(this, "transform.position", this.transform.position);
        runtime.registerLogicalSlot(this, "transform.rotation", this.transform.rotation);
        runtime.registerLogicalSlot(this, "transform.scale", this.transform.scale);
        runtime.registerLogicalSlot(this, "visible", this.visible);
      } catch (error) {
        runtime.groups.delete(this.id);
        runtime.disposeOwnerSlots(this);
        try { nativeResult(runtime.sceneGraphFacade.dispose(runtime.scene, this.handle),
          "SceneGraphFacade.dispose(after create failure)"); } catch (_) { /* preserve the primary failure */ }
        this.disposed = true;
        throw error;
      }
    }

    setTransform(patch) { return Group.prototype.setTransform.call(this, patch); }
    applyTransformProperty(property, value) {
      return Group.prototype.applyTransformProperty.call(this, property, value);
    }
    setVisible(value) { return Group.prototype.setVisible.call(this, value); }
    applyVisible(value) { return Group.prototype.applyVisible.call(this, value); }
    dispose() { return Group.prototype.dispose.call(this); }
  }

  // Parametric mesh generators. Parameters are compile-time constants; each generator is a fixed,
  // reviewed algorithm producing MeshData/v1 (positions + u32 indices, ccw outward, Z-up, metres).
  const MESH_MAX_VERTICES = 65535;
  function meshParams(type, params, allowed) {
    invariant(params && typeof params === "object", `${type}.params is required`);
    const unknown = Object.keys(params).find((name) => !allowed.includes(name));
    invariant(!unknown, `member_unsupported: ${type}.params.${unknown}`);
    return params;
  }
  function meshInteger(value, field, min, max) {
    invariant(Number.isInteger(value) && value >= min && value <= max, `${field} must be an integer in ${min}..${max}`);
    return value;
  }
  function meshPoints(list, field, min) {
    invariant(Array.isArray(list) && list.length >= min && list.length <= 256, `${field} must hold ${min}..256 points`);
    return list.map((point, index) => meshPoint(point, `${field}[${index}]`));
  }
  function meshBudget(type, vertices) {
    invariant(vertices <= MESH_MAX_VERTICES, `${type} would need ${vertices} vertices (limit ${MESH_MAX_VERTICES})`);
  }
  // Grid quads between ring k and k+1 (n points each, indexed k*n + j), outward for ccw rings stacked upward.
  function ringQuads(indices, rings, n, closeRing) {
    for (let k = 0; k < rings - 1; k += 1) {
      const last = closeRing ? n : n - 1;
      for (let j = 0; j < last; j += 1) {
        const j1 = (j + 1) % n;
        const a = k * n + j, b = k * n + j1, c = (k + 1) * n + j1, d = (k + 1) * n + j;
        indices.push(a, b, c, a, c, d);
      }
    }
  }
  // Use a shared coordinate scale so finite author coordinates cannot overflow arc-length math.
  function normalizedArcFractions(points, closed, axes) {
    let scale = 0;
    for (const point of points) {
      for (const axis of axes) scale = Math.max(scale, Math.abs(point[axis]));
    }
    if (!(scale > 0)) return points.map(() => 0);
    const distance = (a, b) => Math.hypot(...axes.map((axis) => a[axis] / scale - b[axis] / scale));
    const lengths = [];
    for (let index = 1; index < points.length; index += 1) lengths.push(distance(points[index - 1], points[index]));
    if (closed) lengths.push(distance(points[points.length - 1], points[0]));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    if (!(total > 0) || !Number.isFinite(total)) return points.map(() => 0);
    let cumulative = 0;
    return points.map((_, index) => {
      if (index > 0) cumulative += lengths[index - 1];
      return Math.min(1, Math.max(0, cumulative / total));
    });
  }
  function ringUvMean(uvs, start, n) {
    let u = 0, v = 0;
    for (let j = 0; j < n; j += 1) {
      u += uvs[start + j].u;
      v += uvs[start + j].v;
    }
    return { u: u / n, v: v / n };
  }
  function ringCap(positions, uvs, indices, start, n, center, up, centerUv) {
    const centerIndex = positions.length;
    positions.push(center);
    uvs.push(centerUv);
    for (let j = 0; j < n; j += 1) {
      const a = start + j, b = start + (j + 1) % n;
      if (up) indices.push(centerIndex, a, b); else indices.push(centerIndex, b, a);
    }
  }

  // M4: analytic tangent frames for the generators. Their UVs are analytic (u = around/varying
  // parameter, v = arc length), so reconstructing dP/du from the (position, uv) triangle pairs is
  // exact here rather than the usual guess over an arbitrary unwrap. Handedness (w = ±1) comes
  // from the orientation of cross(N, T) against the accumulated bitangent, matching the RGBA8
  // SNorm TANGENT stream the native side packs.
  function tangentFrames(positions, uvs, indices) {
    const count = positions.length;
    const accumT = positions.map(() => ({ x: 0, y: 0, z: 0 }));
    const accumB = positions.map(() => ({ x: 0, y: 0, z: 0 }));
    const accumN = positions.map(() => ({ x: 0, y: 0, z: 0 }));
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;
      const p0 = positions[i0], p1 = positions[i1], p2 = positions[i2];
      const w0 = uvs[i0], w1 = uvs[i1], w2 = uvs[i2];
      const e1 = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
      const e2 = { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z };
      const du1 = w1.u - w0.u, dv1 = w1.v - w0.v;
      const du2 = w2.u - w0.u, dv2 = w2.v - w0.v;
      const det = du1 * dv2 - du2 * dv1;
      const face = { x: e1.y * e2.z - e1.z * e2.y, y: e1.z * e2.x - e1.x * e2.z, z: e1.x * e2.y - e1.y * e2.x };
      for (const index of [i0, i1, i2]) {
        accumN[index].x += face.x; accumN[index].y += face.y; accumN[index].z += face.z;
      }
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12) continue;
      const r = 1 / det;
      const tangent = { x: (e1.x * dv2 - e2.x * dv1) * r, y: (e1.y * dv2 - e2.y * dv1) * r, z: (e1.z * dv2 - e2.z * dv1) * r };
      const bitangent = { x: (e2.x * du1 - e1.x * du2) * r, y: (e2.y * du1 - e1.y * du2) * r, z: (e2.z * du1 - e1.z * du2) * r };
      for (const index of [i0, i1, i2]) {
        accumT[index].x += tangent.x; accumT[index].y += tangent.y; accumT[index].z += tangent.z;
        accumB[index].x += bitangent.x; accumB[index].y += bitangent.y; accumB[index].z += bitangent.z;
      }
    }
    return positions.map((_, index) => {
      const n = accumN[index];
      const nLength = Math.hypot(n.x, n.y, n.z);
      const normal = nLength > 0 ? { x: n.x / nLength, y: n.y / nLength, z: n.z / nLength } : { x: 0, y: 0, z: 1 };
      let t = accumT[index];
      const along = t.x * normal.x + t.y * normal.y + t.z * normal.z;
      t = { x: t.x - normal.x * along, y: t.y - normal.y * along, z: t.z - normal.z * along };
      const tLength = Math.hypot(t.x, t.y, t.z);
      if (!(tLength > 1e-12)) {
        // Degenerate u direction (e.g. a collapsed ring): fall back to any axis perpendicular to N.
        const axis = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
        t = { x: axis.y * normal.z - axis.z * normal.y, y: axis.z * normal.x - axis.x * normal.z, z: axis.x * normal.y - axis.y * normal.x };
        const fallback = Math.hypot(t.x, t.y, t.z) || 1;
        t = { x: t.x / fallback, y: t.y / fallback, z: t.z / fallback };
      } else {
        t = { x: t.x / tLength, y: t.y / tLength, z: t.z / tLength };
      }
      const b = accumB[index];
      const cx = normal.y * t.z - normal.z * t.y;
      const cy = normal.z * t.x - normal.x * t.z;
      const cz = normal.x * t.y - normal.y * t.x;
      const handedness = (cx * b.x + cy * b.y + cz * b.z) < 0 ? -1 : 1;
      return [t.x, t.y, t.z, handedness];
    });
  }

  function heightFieldMesh(params) {
    meshParams("HeightField", params, ["width", "depth", "columns", "rows", "heights"]);
    const width = finite(params.width, "HeightField.params.width"), depth = finite(params.depth, "HeightField.params.depth");
    invariant(width > 0 && depth > 0, "HeightField.params.width/depth must be > 0");
    const columns = meshInteger(params.columns, "HeightField.params.columns", 1, 4096);
    const rows = meshInteger(params.rows, "HeightField.params.rows", 1, 4096);
    const count = (columns + 1) * (rows + 1);
    meshBudget("HeightField", count);
    invariant(Array.isArray(params.heights) && params.heights.length === count,
      `HeightField.params.heights needs (columns+1)*(rows+1) = ${count} values`);
    const positions = [], uvs = [], indices = [];
    for (let r = 0; r <= rows; r += 1) {
      for (let c = 0; c <= columns; c += 1) {
        const x = -width / 2 + width * (c / columns);
        const y = -depth / 2 + depth * (r / rows);
        positions.push({ x, y,
          z: finite(params.heights[r * (columns + 1) + c], `HeightField.params.heights[${r * (columns + 1) + c}]`) });
        uvs.push({ u: (x + width / 2) / width, v: (y + depth / 2) / depth });
      }
    }
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        const a = r * (columns + 1) + c, b = a + 1, cc = a + columns + 1, d = cc + 1;
        indices.push(a, b, d, a, d, cc);
      }
    }
    return { positions, uvs, indices, tangents: tangentFrames(positions, uvs, indices) };
  }

  function latheMesh(params) {
    meshParams("Lathe", params, ["profile", "segments", "closed"]);
    const profile = meshPoints(params.profile, "Lathe.params.profile", 2);
    const segments = meshInteger(params.segments, "Lathe.params.segments", 3, 256);
    invariant(profile.every((point) => point.x >= 0), "Lathe.params.profile radius (x) must be >= 0");
    invariant(params.closed === undefined || typeof params.closed === "boolean", "Lathe.params.closed must be boolean");
    meshBudget("Lathe", profile.length * segments + 2);
    const positions = [], uvs = [], indices = [];
    const profileV = normalizedArcFractions(profile, false, ["x", "z"]);
    for (let index = 0; index < profile.length; index += 1) {
      const point = profile[index];
      const uDegenerate = point.x === 0;
      for (let j = 0; j < segments; j += 1) {
        const angle = 2 * Math.PI * j / segments;
        positions.push({ x: point.x * Math.cos(angle), y: point.x * Math.sin(angle), z: point.z });
        uvs.push({ u: uDegenerate ? 0 : j / segments, v: profileV[index] });
      }
    }
    ringQuads(indices, profile.length, segments, true);
    if (params.closed) {
      const first = profile[0], last = profile[profile.length - 1];
      if (first.x > 0) ringCap(positions, uvs, indices, 0, segments,
        { x: 0, y: 0, z: first.z }, first.z > last.z, ringUvMean(uvs, 0, segments));
      if (last.x > 0) {
        const start = (profile.length - 1) * segments;
        ringCap(positions, uvs, indices, start, segments,
          { x: 0, y: 0, z: last.z }, last.z >= first.z, ringUvMean(uvs, start, segments));
      }
    }
    return { positions, uvs, indices, tangents: tangentFrames(positions, uvs, indices) };
  }

  function tubeMesh(params) {
    meshParams("Tube", params, ["path", "radius", "segments", "closed"]);
    const path = meshPoints(params.path, "Tube.params.path", 2);
    const radius = finite(params.radius, "Tube.params.radius");
    invariant(radius > 0, "Tube.params.radius must be > 0");
    const segments = meshInteger(params.segments, "Tube.params.segments", 3, 64);
    invariant(params.closed === undefined || typeof params.closed === "boolean", "Tube.params.closed must be boolean");
    meshBudget("Tube", path.length * segments + 2);
    const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const norm = (v, field) => { const l = Math.hypot(v.x, v.y, v.z); invariant(l > 1e-12, field); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
    const tangents = path.map((point, i) => {
      const prev = i > 0 ? norm(sub(point, path[i - 1]), "Tube.params.path must not repeat adjacent points") : null;
      const next = i < path.length - 1 ? norm(sub(path[i + 1], point), "Tube.params.path must not repeat adjacent points") : null;
      return prev && next ? norm({ x: prev.x + next.x, y: prev.y + next.y, z: prev.z + next.z }, "Tube.params.path folds back on itself") : prev || next;
    });
    // Parallel-transport frame: start perpendicular to the first tangent, then rotate minimally.
    const reference = Math.abs(tangents[0].z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    let normal = norm(cross(reference, tangents[0]), "Tube frame");
    const positions = [], uvs = [], indices = [];
    const pathV = normalizedArcFractions(path, false, ["x", "y", "z"]);
    for (let i = 0; i < path.length; i += 1) {
      if (i > 0) {
        const projected = { x: normal.x - tangents[i].x * dot(normal, tangents[i]), y: normal.y - tangents[i].y * dot(normal, tangents[i]), z: normal.z - tangents[i].z * dot(normal, tangents[i]) };
        normal = Math.hypot(projected.x, projected.y, projected.z) > 1e-9 ? norm(projected, "Tube frame") : normal;
      }
      const binormal = cross(tangents[i], normal);
      for (let j = 0; j < segments; j += 1) {
        const angle = 2 * Math.PI * j / segments, c = Math.cos(angle) * radius, s = Math.sin(angle) * radius;
        positions.push({ x: path[i].x + normal.x * c + binormal.x * s, y: path[i].y + normal.y * c + binormal.y * s, z: path[i].z + normal.z * c + binormal.z * s });
        uvs.push({ u: j / segments, v: pathV[i] });
      }
    }
    ringQuads(indices, path.length, segments, true);
    if (params.closed) {
      ringCap(positions, uvs, indices, 0, segments, path[0], false, ringUvMean(uvs, 0, segments));
      const start = (path.length - 1) * segments;
      ringCap(positions, uvs, indices, start, segments, path[path.length - 1], true,
        ringUvMean(uvs, start, segments));
    }
    return { positions, uvs, indices, tangents: tangentFrames(positions, uvs, indices) };
  }

  function loftMesh(params) {
    meshParams("Loft", params, ["sections", "cap"]);
    invariant(Array.isArray(params.sections) && params.sections.length >= 2 && params.sections.length <= 128, "Loft.params.sections must hold 2..128 rings");
    const sections = params.sections.map((ring, index) => meshPoints(ring, `Loft.params.sections[${index}]`, 3));
    const count = sections[0].length;
    invariant(sections.every((ring) => ring.length === count), "Loft.params.sections must all have the same number of points");
    invariant(params.cap === undefined || typeof params.cap === "boolean", "Loft.params.cap must be boolean");
    meshBudget("Loft", sections.length * count + 2);
    const positions = [], uvs = [], indices = [];
    for (let k = 0; k < sections.length; k += 1) {
      const ring = sections[k];
      const ringU = normalizedArcFractions(ring, true, ["x", "y", "z"]);
      const v = k / (sections.length - 1);
      for (let j = 0; j < ring.length; j += 1) {
        positions.push(ring[j]);
        uvs.push({ u: ringU[j], v });
      }
    }
    ringQuads(indices, sections.length, count, true);
    if (params.cap) {
      const centroid = (ring) => ({ x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length, y: ring.reduce((sum, p) => sum + p.y, 0) / ring.length, z: ring.reduce((sum, p) => sum + p.z, 0) / ring.length });
      ringCap(positions, uvs, indices, 0, count, centroid(sections[0]), false, ringUvMean(uvs, 0, count));
      const start = (sections.length - 1) * count;
      ringCap(positions, uvs, indices, start, count, centroid(sections[sections.length - 1]), true,
        ringUvMean(uvs, start, count));
    }
    return { positions, uvs, indices, tangents: tangentFrames(positions, uvs, indices) };
  }

  function geometryComponentSpec(type, kind, spec) {
    invariant(spec && typeof spec === "object", `${type} needs a spec`);
    invariant(spec.kind === undefined || spec.kind === kind, `${type}.kind cannot be overridden`);
    return { ...spec, kind, component_type: type };
  }

  class Box extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("Box", "box", spec)); }
  }

  class Plane extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("Plane", "plane", spec)); }
  }

  class Sphere extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("Sphere", "sphere", spec)); }
  }

  class Cylinder extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("Cylinder", "cylinder", spec)); }
  }

  class Cone extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("Cone", "cone", spec)); }
  }

  class Polyline extends SceneObject {
    constructor(runtime, spec) {
      super(runtime, geometryComponentSpec("Polyline", "mesh", { ...spec, params: polylineMesh(spec?.params) }));
    }
  }

  class Polygon extends SceneObject {
    constructor(runtime, spec) {
      super(runtime, geometryComponentSpec("Polygon", "polygon", { ...spec, params: polygonParams(spec?.params) }));
    }
  }

  class HeightField extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("HeightField", "mesh", { ...spec, params: heightFieldMesh(spec?.params) })); }
  }
  class Lathe extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("Lathe", "mesh", { ...spec, params: latheMesh(spec?.params) })); }
  }
  class Tube extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("Tube", "mesh", { ...spec, params: tubeMesh(spec?.params) })); }
  }
  class Loft extends SceneObject {
    constructor(runtime, spec) { super(runtime, geometryComponentSpec("Loft", "mesh", { ...spec, params: loftMesh(spec?.params) })); }
  }

  class ExtrudedPolygon extends SceneObject {
    constructor(runtime, spec) {
      super(runtime, geometryComponentSpec("ExtrudedPolygon", "extrude", { ...spec, params: extrudeParams(spec?.params) }));
    }
  }

  function labelAnchor(value, field = "Label.anchor") {
    invariant(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
    const allowed = new Set(["longitude", "latitude", "altitude"]);
    const unknown = Object.keys(value).find((name) => !allowed.has(name));
    invariant(!unknown, `member_unsupported: ${field}.${unknown}`);
    const longitude = finite(value.longitude, `${field}.longitude`);
    const latitude = finite(value.latitude, `${field}.latitude`);
    const altitude = finite(value.altitude ?? 0, `${field}.altitude`);
    invariant(longitude >= -180 && longitude <= 180, `${field}.longitude must be in -180..180`);
    invariant(latitude >= -90 && latitude <= 90, `${field}.latitude must be in -90..90`);
    return { longitude, latitude, altitude };
  }

  function labelStyle(spec, field = "Label") {
    const result = {};
    const colors = [
      ["fontColor", "font_color"], ["backgroundColor", "background_color"], ["strokeColor", "stroke_color"],
    ];
    for (const [publicName, wireName] of colors) {
      if (spec[publicName] !== undefined) result[wireName] = hexColor(spec[publicName]);
    }
    if (spec.fontSize !== undefined) {
      invariant(Number.isInteger(spec.fontSize) && spec.fontSize >= 6 && spec.fontSize <= 256,
        `${field}.fontSize must be an integer in 6..256`);
      result.font_size = spec.fontSize;
    }
    for (const [publicName, wireName] of [
      ["bold", "bold"], ["italic", "italic"], ["underline", "underline"], ["lineToGround", "line_to_ground"],
    ]) {
      if (spec[publicName] !== undefined) {
        invariant(typeof spec[publicName] === "boolean", `${field}.${publicName} must be boolean`);
        result[wireName] = spec[publicName];
      }
    }
    return result;
  }

  function managedAssetRef(value, expectedKind, mediaTypes, maxBytes, field) {
    invariant(value && typeof value === "object" && !Array.isArray(value), `${field} must be an AssetRef`);
    const keys = ["asset_id", "kind", "media_type", "content_digest", "size_bytes", "dependencies"];
    invariant(Object.keys(value).length === keys.length && keys.every((name) => Object.hasOwn(value, name)),
      `${field} must use the closed six-key AssetRef shape`);
    invariant(typeof value.asset_id === "string" && value.asset_id.length > 0,
      `${field}.asset_id is required`);
    invariant(value.kind === expectedKind, `${field}.kind must be '${expectedKind}'`);
    invariant(mediaTypes.includes(value.media_type), `${field}.media_type is unsupported`);
    invariant(typeof value.content_digest === "string" && /^sha256:[0-9a-f]{64}$/.test(value.content_digest),
      `${field}.content_digest must be a lowercase sha256 digest`);
    invariant(Number.isSafeInteger(value.size_bytes) && value.size_bytes >= 0 && value.size_bytes <= maxBytes,
      `${field}.size_bytes must be in 0..${maxBytes}`);
    invariant(Array.isArray(value.dependencies) && value.dependencies.length === 0,
      `${field}.dependencies must be empty for SSDLGLBProfile/1`);
    return Object.freeze({
      asset_id: value.asset_id,
      kind: value.kind,
      media_type: value.media_type,
      content_digest: value.content_digest,
      size_bytes: value.size_bytes,
      dependencies: Object.freeze([]),
    });
  }

  class Label {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "Label needs a spec");
      invariant(runtime.labelFacade, "LabelFacade/v1 is unavailable");
      const allowed = new Set([
        "id", "key", "text", "anchor", "visible", "fontColor", "backgroundColor", "strokeColor",
        "fontSize", "bold", "italic", "underline", "lineToGround",
      ]);
      const unknown = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: Label.${unknown}`);
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "Label.id or key is required");
      invariant(!runtime.labels.has(id), `Label '${id}' is already registered`);
      runtime.assertReferenceIdAvailable(id);
      invariant(typeof spec.text === "string" && spec.text.length <= 4096,
        "Label.text must be a string of at most 4096 characters");
      invariant(spec.visible === undefined || typeof spec.visible === "boolean", "Label.visible must be boolean");
      this.runtime = runtime;
      this.id = id;
      this.component_type = "Label";
      this.text = spec.text;
      this.anchor = labelAnchor(spec.anchor);
      this.visible = spec.visible !== false;
      this.disposed = false;
      const style = labelStyle(spec);
      const receipt = nativeResult(runtime.labelFacade.create(JSON.stringify({
        schema_version: "LabelSpec/v1",
        id,
        text: this.text,
        anchor: this.anchor,
        visible: this.visible,
        style,
      })), "LabelFacade.create");
      this.handle = receipt.label_handle;
      runtime.labels.set(id, this);
      runtime.registerLogicalSlot(this, "text", this.text);
      runtime.registerLogicalSlot(this, "visible", this.visible);
    }

    patch(value) {
      invariant(!this.disposed, "Label is disposed");
      return nativeResult(this.runtime.labelFacade.update(this.handle, JSON.stringify(value)), "LabelFacade.update");
    }

    setText(value) {
      invariant(typeof value === "string" && value.length <= 4096,
        "Label.text must be a string of at most 4096 characters");
      return this.runtime.writeLogical(this, "text", value);
    }

    applyText(value) {
      const receipt = this.patch({ text: value });
      this.text = value;
      return receipt;
    }

    setVisible(value) {
      invariant(typeof value === "boolean", "Label.visible must be boolean");
      return this.runtime.writeLogical(this, "visible", value);
    }

    applyVisible(value) {
      const receipt = this.patch({ visible: value });
      this.visible = value;
      return receipt;
    }

    setAnchor(value) {
      const anchor = labelAnchor(value);
      const receipt = this.patch({ anchor });
      this.anchor = anchor;
      return receipt;
    }

    setStyle(spec) {
      invariant(spec && typeof spec === "object", "Label style must be an object");
      const allowed = new Set([
        "fontColor", "backgroundColor", "strokeColor", "fontSize", "bold", "italic", "underline", "lineToGround",
      ]);
      const unknown = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: Label.${unknown}`);
      return this.patch({ style: labelStyle(spec, "Label") });
    }

    describe() {
      invariant(!this.disposed, "Label is disposed");
      return nativeResult(this.runtime.labelFacade.describe(this.handle), "LabelFacade.describe");
    }

    snapshot() {
      return { id: this.id, handle: this.handle, text: this.text, anchor: { ...this.anchor }, visible: this.visible };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.runtime.disposeTargetDependents(this);
      const result = nativeResult(this.runtime.labelFacade.dispose(this.handle), "LabelFacade.dispose");
      this.runtime.labels.delete(this.id);
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  class Texture {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "Texture needs a spec");
      const allowed = new Set(["id", "key", "source"]);
      const unknown = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: Texture.${unknown}`);
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "Texture.id or key is required");
      invariant(!runtime.textures.has(id) && !runtime.models.has(id) && !runtime.modelReservations.has(id)
        && !runtime.objects.has(id) && !runtime.groups.has(id) && !runtime.labels.has(id)
        && !runtime.materials.has(id) && !runtime.repeaters.has(id),
      `Texture id '${id}' is already in use`);
      this.runtime = runtime;
      this.id = id;
      this.source = managedAssetRef(spec.source, "texture", ["image/png", "image/jpeg"], 8 * 1024 * 1024,
        "Texture.source");
      this.references = new Set();
      this.loadPromise = null;
      this.disposed = false;
      runtime.textures.set(id, this);
    }

    load() {
      invariant(!this.disposed, "Texture is disposed");
      invariant(typeof this.runtime.resolveManagedAsset === "function",
        "Texture requires a managed asset resolver");
      if (!this.loadPromise) {
        this.loadPromise = this.runtime.resolveAsset(this.source, "Texture.source")
          .catch((error) => {
            this.loadPromise = null;
            throw error;
          });
      }
      return this.loadPromise;
    }

    snapshot() {
      return { id: this.id, source: { ...this.source, dependencies: [] }, references: this.references.size };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      invariant(this.references.size === 0,
        `Texture '${this.id}' is still referenced by a Model or PrincipledMaterial`);
      this.runtime.textures.delete(this.id);
      this.disposed = true;
      return { ok: true, removed: true, idempotent: false };
    }
  }

  function sameModelIdentity(left, right) {
    return left && right && left.node === right.node
      && left.owner_scope_id === right.owner_scope_id && left.incarnation === right.incarnation;
  }

  class Model {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "Model needs a spec");
      const allowed = new Set([
        "id", "key", "source", "baseColorTexture", "materialSlot", "parent",
        "position", "x", "y", "z", "rotation", "rotation_z", "scale", "visible",
      ]);
      const unknown = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: Model.${unknown}`);
      invariant(spec.rotation === undefined || spec.rotation_z === undefined,
        "Model.rotation and Model.rotation_z are mutually exclusive");
      invariant(spec.visible === undefined || typeof spec.visible === "boolean", "Model.visible must be boolean");
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "Model.id or key is required");
      invariant(!runtime.models.has(id) && !runtime.modelReservations.has(id)
        && !runtime.textures.has(id) && !runtime.objects.has(id) && !runtime.groups.has(id)
        && !runtime.labels.has(id) && !runtime.materials.has(id) && !runtime.repeaters.has(id),
        `Model id '${id}' is already in use`);
      runtime.assertReferenceIdAvailable(id);
      invariant(runtime.modelFacade, "SSDLSceneFacade/v1 with SSDLModelFacade/1 is unavailable");
      invariant(typeof runtime.resolveManagedAsset === "function",
        "Model requires a managed asset resolver");
      const capabilities = nativeResult(runtime.modelFacade.capabilities(), "SSDLSceneFacade.capabilities");
      invariant(capabilities.facade_version === "SSDLSceneFacade/v1"
        && capabilities.model_support === "SSDLModelFacade/1"
        && capabilities.model_node_surface === "SceneGraphFacade/v2"
        && capabilities.model_animation_surface === "AnimationFacade/v2"
        && capabilities.coordinate_system === "right_handed_z_up",
      "SSDLSceneFacade/v1 does not publish the required Model capability");
      invariant(typeof runtime.modelFacade.stageModel === "function"
        && typeof runtime.modelFacade.activate === "function"
        && typeof runtime.modelFacade.describe === "function"
        && typeof runtime.modelFacade.remove === "function",
      "SSDLSceneFacade/v1 Model lifecycle is incomplete");
      this.runtime = runtime;
      this.id = id;
      this.component_type = "Model";
      this.handle = null;
      this.transform = {
        position: nodePosition(spec, "Model"),
        rotation: spec.rotation !== undefined
          ? quaternion(spec.rotation, "Model.rotation")
          : quaternionZ(spec.rotation_z || 0),
        scale: vector3(spec.scale, { x: 1, y: 1, z: 1 }, "Model.scale"),
      };
      this.visible = spec.visible !== false;
      this.parent = spec.parent ?? runtime.sceneRoot;
      if (spec.parent && typeof spec.parent === "object") {
        invariant(spec.parent.runtime === runtime
          && (spec.parent instanceof Scene || spec.parent instanceof Group || spec.parent instanceof GeoAnchor)
          && spec.parent.disposed !== true,
        "Model.parent must be a live Scene, Group or GeoAnchor from the same runtime");
      }
      this.parentHandle = spec.parent?.handle || spec.parent || runtime.locatorHandle;
      invariant(typeof this.parentHandle === "string",
        "Model.parent must be a Scene, Group, GeoAnchor or locator handle");
      this.source = managedAssetRef(spec.source, "model", ["model/gltf-binary"], 32 * 1024 * 1024,
        "Model.source");
      this.texture = spec.baseColorTexture;
      invariant((this.texture !== undefined) === (spec.materialSlot !== undefined),
        "Model.baseColorTexture and materialSlot must be provided together");
      if (this.texture !== undefined) {
        invariant(this.texture instanceof Texture && !this.texture.disposed && this.texture.runtime === runtime,
          "Model.baseColorTexture must be a live Texture from the same runtime");
        invariant(typeof spec.materialSlot === "string" && /^material_(0|[1-9][0-9]?)$/.test(spec.materialSlot),
          "Model.materialSlot must be material_0..material_99");
      }
      this.materialSlot = spec.materialSlot || null;
      this.identity = Object.freeze({
        node: id,
        owner_scope_id: runtime.modelScopeId,
        incarnation: runtime.nextModelIncarnation(id),
      });
      this.receipt = null;
      this.disposed = false;
      runtime.modelReservations.add(id);
    }

    async initialize() {
      const properties = [{ property: "source", value: this.source }];
      if (this.texture) {
        properties.push({ property: "baseColorTexture", value: this.texture.source });
        properties.push({ property: "materialSlot", value: this.materialSlot });
      }
      const definition = {
        id: this.id,
        type: "Model",
        parent: this.runtime.modelScopeId,
        properties,
        bindings: [],
      };
      const modelBytes = await this.runtime.resolveAsset(this.source, "Model.source");
      const textureBytes = this.texture
        ? await this.texture.load()
        : null;
      const descriptor = (asset) => ({
        content_digest: asset.content_digest,
        size_bytes: asset.size_bytes,
        media_type: asset.media_type,
      });
      let staged = false;
      try {
        const receipt = nativeResult(this.runtime.modelFacade.stageModel(JSON.stringify({
          definition,
          identity: this.identity,
          assets: { model: descriptor(this.source), texture: this.texture ? descriptor(this.texture.source) : null },
        }), modelBytes, textureBytes), "SSDLSceneFacade.stageModel");
        invariant(sameModelIdentity(receipt.identity, this.identity)
          && receipt.state === "staged" && receipt.native_present === true,
        "SSDLSceneFacade.stageModel returned an invalid identity receipt");
        staged = true;
        let observed = null;
        for (let attempt = 0; attempt < this.runtime.modelReadyFrames; ++attempt) {
          const scope = nativeResult(this.runtime.modelFacade.describe(JSON.stringify({
            scope_id: this.runtime.modelScopeId,
          })), "SSDLSceneFacade.describe");
          invariant(Array.isArray(scope.nodes), "SSDLSceneFacade.describe returned malformed nodes");
          observed = scope.nodes.find((item) => sameModelIdentity(item.identity, this.identity)) || null;
          invariant(observed && observed.state === "staged" && observed.native_present === true,
            "staged Model identity disappeared before activation");
          if (observed.model?.state === "ready" || observed.model?.state === "failed") break;
          await this.runtime.nextModelFrame();
        }
        invariant(observed?.model?.state !== "failed",
          observed?.model?.message || observed?.model?.error_code || "Model native load failed");
        invariant(observed?.model?.state === "ready", "Model native load did not settle within the bounded frame budget");
        const active = nativeResult(this.runtime.modelFacade.activate(this.runtime.scene, JSON.stringify({
          target: this.identity,
          parent: { scene: this.runtime.modelScopeId, owner_scope_id: this.runtime.modelScopeId },
          previous: null,
        })), "SSDLSceneFacade.activate");
        invariant(sameModelIdentity(active.identity, this.identity)
          && active.state === "active" && active.native_present === true
          && active.scene_graph_published === true
          && typeof active.node_handle === "string" && active.node_handle.startsWith("external:"),
        "SSDLSceneFacade.activate returned an invalid identity receipt");
        this.handle = active.node_handle;
        nativeResult(this.runtime.sceneGraphFacade.reparent(this.runtime.scene, JSON.stringify({
          target: this.handle,
          parent: this.parentHandle,
          preserve_world_transform: false,
        })), "SceneGraphFacade.reparent(Model)");
        nativeResult(this.runtime.sceneGraphFacade.setTransform(JSON.stringify({
          target: this.handle,
          space: "local",
          ...this.transform,
        })), "SceneGraphFacade.setTransform(Model)");
        this.runtime.registerNativeSlot(this, "transform.position", this.transform.position);
        this.runtime.registerNativeSlot(this, "transform.rotation", this.transform.rotation);
        this.runtime.registerNativeSlot(this, "transform.scale", this.transform.scale);
        this.runtime.registerNativeSlot(this, "visible", this.visible);
        if (!this.visible) this.runtime.writeLogical(this, "visible", false);
        this.receipt = this.describe();
        this.runtime.models.set(this.id, this);
        if (this.texture) this.texture.references.add(this);
        return this;
      } catch (error) {
        this.runtime.disposeOwnerSlots(this);
        if (staged) {
          try { nativeResult(this.runtime.modelFacade.remove(JSON.stringify({ target: this.identity })),
            "SSDLSceneFacade.remove"); } catch (_) { /* preserve the primary failure */ }
        }
        throw error;
      }
    }

    describe() {
      invariant(!this.disposed, "Model is disposed");
      const scope = nativeResult(this.runtime.modelFacade.describe(JSON.stringify({
        scope_id: this.runtime.modelScopeId,
      })), "SSDLSceneFacade.describe");
      const receipt = scope.nodes?.find((item) => sameModelIdentity(item.identity, this.identity));
      invariant(receipt, "Model identity is absent from native readback");
      return receipt;
    }

    setTransform(patch) {
      invariant(!this.disposed && typeof this.handle === "string", "Model is not active");
      invariant(patch && typeof patch === "object", "Model.setTransform needs a patch");
      const allowed = new Set(["position", "x", "y", "z", "rotation", "rotation_z", "scale"]);
      const unknown = Object.keys(patch).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: Model.${unknown}`);
      invariant(patch.rotation === undefined || patch.rotation_z === undefined,
        "Model.rotation and Model.rotation_z are mutually exclusive");
      const request = { target: this.handle, space: "local" };
      const next = { ...this.transform };
      if (patch.position !== undefined || ["x", "y", "z"].some((axis) => patch[axis] !== undefined)) {
        const base = patch.position === undefined ? next.position : vector3(patch.position, null, "Model.position");
        request.position = next.position = nodePosition({
          position: base, x: patch.x, y: patch.y, z: patch.z,
        }, "Model");
        this.runtime.assertLogicalWritable(this, "transform.position");
      }
      if (patch.scale !== undefined) {
        request.scale = next.scale = vector3(patch.scale, null, "Model.scale");
        this.runtime.assertLogicalWritable(this, "transform.scale");
      }
      if (patch.rotation !== undefined || patch.rotation_z !== undefined) {
        request.rotation = next.rotation = patch.rotation !== undefined
          ? quaternion(patch.rotation, "Model.rotation")
          : quaternionZ(patch.rotation_z);
        this.runtime.assertLogicalWritable(this, "transform.rotation");
      }
      const result = nativeResult(this.runtime.sceneGraphFacade.setTransform(JSON.stringify(request)),
        "SceneGraphFacade.setTransform(Model)");
      for (const property of ["position", "rotation", "scale"]) {
        if (request[property] !== undefined) {
          this.runtime.writeLogical(this, `transform.${property}`, request[property], { write: false });
        }
      }
      this.transform = next;
      return result;
    }

    setVisible(value) {
      invariant(typeof value === "boolean", "Model.visible must be boolean");
      const result = this.runtime.writeLogical(this, "visible", value);
      this.visible = value;
      return result;
    }

    snapshot() {
      return {
        id: this.id,
        identity: { ...this.identity },
        source_digest: this.source.content_digest,
        texture: this.texture?.id || null,
        material_slot: this.materialSlot,
        handle: this.handle,
        parent_handle: this.parentHandle,
        transform: {
          position: { ...this.transform.position },
          rotation: { ...this.transform.rotation },
          scale: { ...this.transform.scale },
        },
        visible: this.visible,
        state: this.receipt?.state || "preparing",
      };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      // A Prefab built from this Model BORROWS its leaf geometry and materials -- unlike a geometry
      // prefab, which rebuilds its own copy from frozen spec bytes and does not care what happens to
      // the source.  Removing the glb out from under a live batch would leave the instanced renderers
      // pointing at deleted LiGeometry, so refuse instead.  Dispose the Prefab first.
      const borrowing = [...this.runtime.prefabs.values()]
        .filter((prefab) => !prefab.disposed && prefab.source === this).map((prefab) => prefab.id);
      invariant(borrowing.length === 0,
        `Model '${this.id}' is instanced by Prefab ${borrowing.join(", ")}; dispose the Prefab first`);
      this.runtime.disposeTargetDependents(this);
      const result = nativeResult(this.runtime.modelFacade.remove(JSON.stringify({ target: this.identity })),
        "SSDLSceneFacade.remove");
      this.runtime.models.delete(this.id);
      if (this.texture) this.texture.references.delete(this);
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  const ENVIRONMENT_MEMBERS = Object.freeze({
    DirectionalLight: Object.freeze([
      "position", "rotation", "scale", "visible", "intensity", "lightColor", "castShadows", "useTemperature", "temperature",
      "indirectLightingIntensity", "volumetricScatteringIntensity", "mobility", "lightSourceAngle",
      "lightSourceSoftAngle", "atmosphereSunLight", "atmosphereSunLightIndex",
      "cloudScatteredLuminanceScale",
    ]),
    PointLight: Object.freeze([
      "position", "rotation", "scale", "visible", "intensity", "lightColor", "intensityUnits",
      "castShadows", "useTemperature", "temperature", "indirectLightingIntensity",
      "volumetricScatteringIntensity", "mobility", "attenuationRadius", "sourceRadius",
      "softSourceRadius", "sourceLength",
    ]),
    SpotLight: Object.freeze([
      "position", "rotation", "scale", "visible", "intensity", "lightColor", "intensityUnits",
      "castShadows", "useTemperature", "temperature", "indirectLightingIntensity",
      "volumetricScatteringIntensity", "mobility", "attenuationRadius", "sourceRadius",
      "softSourceRadius", "sourceLength", "innerConeAngle", "outerConeAngle",
    ]),
    RectLight: Object.freeze([
      "position", "rotation", "scale", "visible", "intensity", "lightColor", "intensityUnits",
      "castShadows", "useTemperature", "temperature", "indirectLightingIntensity",
      "volumetricScatteringIntensity", "mobility", "attenuationRadius", "sourceWidth",
      "sourceHeight", "barnDoorAngle", "barnDoorLength",
    ]),
    SkyLight: Object.freeze([
      "intensity", "lightColor", "realTimeCapture", "lowerHemisphereIsBlack", "lowerHemisphereColor",
      "indirectLightingIntensity", "volumetricScatteringIntensity", "mobility",
    ]),
    SkyAtmosphere: Object.freeze([
      "groundAlbedo", "multiScatteringFactor", "rayleighScatteringScale", "rayleighScattering",
      "rayleighExponentialDistribution", "mieScatteringScale", "mieScattering", "mieAbsorptionScale",
      "mieAbsorption", "mieAnisotropy", "mieExponentialDistribution", "otherAbsorptionScale",
      "otherAbsorption", "skyLuminanceFactor", "aerialPespectiveViewDistanceScale",
      "heightFogContribution", "transmittanceMinLightElevationAngle", "aerialPerspectiveStartDepth",
    ]),
    VolumetricCloud: Object.freeze([
      "layerBottomAltitude", "layerHeight", "tracingStartMaxDistance", "tracingMaxDistance",
      "usePerSampleAtmosphericLightTransmittance", "skyLightCloudBottomOcclusion", "viewSampleCountScale",
      "reflectionSampleCountScale", "shadowViewSampleCountScale", "shadowReflectionSampleCountScale",
      "shadowTracingDistance", "stopTracingTransmittanceThreshold",
    ]),
    ExponentialHeightFog: Object.freeze([
      "fogDensity", "fogHeightFalloff", "secondFogData", "fogInscatteringColor", "fogMaxOpacity",
      "startDistance", "fogCutoffDistance", "directionalInscatteringExponent",
      "directionalInscatteringStartDistance", "directionalInscatteringColor", "inscatteringTextureTint",
    ]),
  });

  const ENVIRONMENT_COLOR_MEMBERS = new Set([
    "lightColor", "lowerHemisphereColor", "groundAlbedo", "fogInscatteringColor",
    "directionalInscatteringColor", "inscatteringTextureTint", "cloudScatteredLuminanceScale",
  ]);
  const ENVIRONMENT_BOOLEAN_MEMBERS = new Set([
    "visible", "castShadows", "useTemperature", "atmosphereSunLight", "realTimeCapture",
    "lowerHemisphereIsBlack", "usePerSampleAtmosphericLightTransmittance", "skyLightCloudBottomOcclusion",
  ]);
  const ENVIRONMENT_VECTOR_MEMBERS = new Map([
    ["position", "m"], ["rotation", "deg"], ["scale", "scalar"],
    ["rayleighScattering", "scalar"], ["mieScattering", "scalar"], ["mieAbsorption", "scalar"],
    ["otherAbsorption", "scalar"], ["skyLuminanceFactor", "scalar"],
  ]);
  const ENVIRONMENT_ENUM_MEMBERS = new Set(["mobility", "intensityUnits"]);
  // Author-facing sun orientation for the atmosphere sun light, in local ENU degrees at the runtime anchor.
  // These are not UE 4.27 members; the runtime converts them to the ECEF direction the native sun consumes.
  const SUN_DIRECTION_MEMBERS = new Set(["sunAzimuth", "sunElevation"]);
  // The engine sun is page-global. Hot reload mounts the new generation before the
  // old one is disposed, so only the last writer may release the native direction lock.
  let sunDirectionOwner = null;

  function sunDirectionFromAnchor(anchor, azimuthDeg, elevationDeg) {
    const rad = Math.PI / 180;
    const lon = anchor.lon * rad, lat = anchor.lat * rad;
    const azimuth = azimuthDeg * rad, elevation = elevationDeg * rad;
    const east = Math.sin(azimuth) * Math.cos(elevation);
    const north = Math.cos(azimuth) * Math.cos(elevation);
    const up = Math.sin(elevation);
    // Light travels from the sun towards the ground: negate the ENU sun vector after rotating into ECEF.
    return {
      x: Math.sin(lon) * east + Math.sin(lat) * Math.cos(lon) * north - Math.cos(lat) * Math.cos(lon) * up,
      y: -Math.cos(lon) * east + Math.sin(lat) * Math.sin(lon) * north - Math.cos(lat) * Math.sin(lon) * up,
      z: -Math.cos(lat) * north - Math.sin(lat) * up,
    };
  }

  function environmentMemberValueDescriptor(type, property) {
    if (type === "DirectionalLight" && SUN_DIRECTION_MEMBERS.has(property)) {
      return { kind: "member", value_type: "scalar", unit: "deg", length: 1, divisor: 1e6 };
    }
    invariant(ENVIRONMENT_MEMBERS[type]?.includes(property), `ue_member_unsupported: ${type}.${property}`);
    invariant(property !== "secondFogData",
      "member_unsupported: ExponentialHeightFog.secondFogData cannot be bound as one value");
    if (ENVIRONMENT_COLOR_MEMBERS.has(property)) {
      return { kind: "member", value_type: "color", unit: null, length: 1, divisor: 1 };
    }
    if (ENVIRONMENT_BOOLEAN_MEMBERS.has(property)) {
      return { kind: "member", value_type: "boolean", unit: null, length: 1, divisor: 1 };
    }
    if (ENVIRONMENT_VECTOR_MEMBERS.has(property)) {
      return {
        kind: "member", value_type: "vector3", unit: ENVIRONMENT_VECTOR_MEMBERS.get(property),
        length: 3, divisor: 1e6,
      };
    }
    if (ENVIRONMENT_ENUM_MEMBERS.has(property)) {
      return { kind: "member", value_type: "string", unit: null, length: 1, divisor: 1 };
    }
    return { kind: "member", value_type: "scalar", unit: "scalar", length: 1, divisor: 1e6 };
  }

  const SUN_SKY_CAPABILITY = "environment.sun_position.ue_4_27";
  const SUN_SKY_SCALAR_MEMBERS = Object.freeze([
    "latitude", "longitude", "timeZone", "northOffset", "month", "day",
    "useDaylightSavingTime", "dstStartMonth", "dstStartDay", "dstEndMonth",
    "dstEndDay", "dstSwitchHour", "solarTime",
  ]);
  const SUN_SKY_GROUP_MEMBERS = Object.freeze({
    directionalLight: "DirectionalLight",
    skyLight: "SkyLight",
    skyAtmosphere: "SkyAtmosphere",
  });

  function sunSkyMemberValueDescriptor(property) {
    invariant(SUN_SKY_SCALAR_MEMBERS.includes(property), `member_unsupported: SunSky.${property}`);
    if (property === "useDaylightSavingTime") {
      return { kind: "member", value_type: "boolean", unit: null, length: 1, divisor: 1 };
    }
    const unit = ["latitude", "longitude", "northOffset"].includes(property) ? "deg" : "scalar";
    return { kind: "member", value_type: "scalar", unit, length: 1, divisor: 1e6 };
  }

  function sunSkyNumber(value, field, minimum, maximum, integer = false) {
    invariant(Number.isFinite(value), `${field} must be finite`);
    invariant(!integer || Number.isSafeInteger(value), `${field} must be an integer`);
    invariant(value >= minimum && value <= maximum,
      `${field} must be in ${minimum}..${maximum}`);
    return value;
  }

  function sunSkyDay(month, day, year, prefix) {
    if (month === undefined || day === undefined) return;
    const maximum = new Date(Date.UTC(year, month, 0)).getUTCDate();
    invariant(day <= maximum, `${prefix}.day is invalid for month ${month} in ${year}`);
  }

  function hasCapability(capabilities, id) {
    return Array.isArray(capabilities?.capability_ids) && capabilities.capability_ids.includes(id);
  }

  function environmentProperties(type, spec) {
    const allowed = new Set(["id", "key", ...ENVIRONMENT_MEMBERS[type]]);
    const unknown = Object.keys(spec).find((name) => !allowed.has(name));
    invariant(!unknown, `ue_member_unsupported: ${type}.${unknown}`);
    const properties = {};
    for (const name of ENVIRONMENT_MEMBERS[type]) {
      if (spec[name] === undefined) continue;
      if (name === "secondFogData") {
        invariant(spec.secondFogData && typeof spec.secondFogData === "object" && !Array.isArray(spec.secondFogData),
          "ExponentialHeightFog.secondFogData must be a grouped object");
        const secondNames = ["fogDensity", "fogHeightFalloff", "fogHeightOffset"];
        const nestedUnknown = Object.keys(spec.secondFogData).find((item) => !secondNames.includes(item));
        invariant(!nestedUnknown, `ue_member_unsupported: ExponentialHeightFog.secondFogData.${nestedUnknown}`);
        for (const nested of secondNames) {
          if (spec.secondFogData[nested] !== undefined) {
            properties[`secondFogData.${nested}`] = spec.secondFogData[nested];
          }
        }
      } else if (name === "mobility") {
        invariant(spec[name] === "Movable", "ue_enum_value_unsupported: only Mobility.Movable is supported");
        properties[name] = spec[name];
      } else if (name === "intensityUnits") {
        invariant(["Unitless", "Candelas", "Lumens"].includes(spec[name]),
          "ue_enum_value_unsupported: intensityUnits must be Unitless, Candelas, or Lumens");
        properties[name] = spec[name];
      } else {
        properties[name] = ENVIRONMENT_COLOR_MEMBERS.has(name) ? hexColor(spec[name]) : spec[name];
      }
    }
    return properties;
  }

  function sunSkySpec(spec, resolvedCalendarYear, patch = false) {
    invariant(spec && typeof spec === "object" && !Array.isArray(spec),
      `SunSky ${patch ? "patch" : "needs a spec"}`);
    const allowed = new Set([
      ...(patch ? [] : ["id", "key"]), ...SUN_SKY_SCALAR_MEMBERS,
      ...Object.keys(SUN_SKY_GROUP_MEMBERS),
    ]);
    const unknown = Object.keys(spec).find((name) => !allowed.has(name));
    invariant(!unknown, `ue_member_unsupported: SunSky.${unknown}`);
    invariant(Number.isSafeInteger(resolvedCalendarYear)
      && resolvedCalendarYear >= 1 && resolvedCalendarYear <= 9999,
    "SunSky requires profile resolvedCalendarYear in 1..9999");

    const values = {};
    if (spec.latitude !== undefined) values.latitude = sunSkyNumber(spec.latitude, "SunSky.latitude", -90, 90);
    if (spec.longitude !== undefined) values.longitude = sunSkyNumber(spec.longitude, "SunSky.longitude", -180, 180);
    if (spec.timeZone !== undefined) values.time_zone = sunSkyNumber(spec.timeZone, "SunSky.timeZone", -12, 14);
    if (spec.northOffset !== undefined) values.north_offset = sunSkyNumber(spec.northOffset, "SunSky.northOffset", -360, 360);
    if (spec.month !== undefined) values.month = sunSkyNumber(spec.month, "SunSky.month", 1, 12, true);
    if (spec.day !== undefined) values.day = sunSkyNumber(spec.day, "SunSky.day", 1, 31, true);
    if (spec.useDaylightSavingTime !== undefined) {
      invariant(typeof spec.useDaylightSavingTime === "boolean", "SunSky.useDaylightSavingTime must be boolean");
      values.use_daylight_saving_time = spec.useDaylightSavingTime;
    }
    for (const [author, wire] of [
      ["dstStartMonth", "dst_start_month"], ["dstEndMonth", "dst_end_month"],
    ]) {
      if (spec[author] !== undefined) values[wire] = sunSkyNumber(spec[author], `SunSky.${author}`, 1, 12, true);
    }
    for (const [author, wire] of [
      ["dstStartDay", "dst_start_day"], ["dstEndDay", "dst_end_day"],
    ]) {
      if (spec[author] !== undefined) values[wire] = sunSkyNumber(spec[author], `SunSky.${author}`, 1, 31, true);
    }
    if (spec.dstSwitchHour !== undefined) {
      values.dst_switch_hour = sunSkyNumber(spec.dstSwitchHour, "SunSky.dstSwitchHour", 0, 24);
    }
    if (spec.solarTime !== undefined) values.solar_time = sunSkyNumber(spec.solarTime, "SunSky.solarTime", 0, 24);

    sunSkyDay(spec.month, spec.day, resolvedCalendarYear, "SunSky");
    sunSkyDay(spec.dstStartMonth, spec.dstStartDay, resolvedCalendarYear, "SunSky.dstStart");
    sunSkyDay(spec.dstEndMonth, spec.dstEndDay, resolvedCalendarYear, "SunSky.dstEnd");
    for (const [author, type] of Object.entries(SUN_SKY_GROUP_MEMBERS)) {
      if (spec[author] === undefined) continue;
      invariant(spec[author] && typeof spec[author] === "object" && !Array.isArray(spec[author]),
        `SunSky.${author} must be a grouped object`);
      const identityMember = ["id", "key"].find((name) => spec[author][name] !== undefined);
      invariant(!identityMember, `ue_member_unsupported: SunSky.${author}.${identityMember}`);
      if (author === "directionalLight") {
        invariant(spec[author].rotation === undefined,
          "multiple_writer: SunSky owns directionalLight.rotation");
      }
      values[author.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] =
        environmentProperties(type, spec[author]);
    }
    return values;
  }

  class EnvironmentComponent {
    constructor(runtime, type, spec) {
      invariant(spec && typeof spec === "object", `${type} needs a spec`);
      invariant(runtime.environmentFacade, "EnvironmentFacade/v1 is unavailable");
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, `${type}.id or key is required`);
      invariant(!runtime.environmentComponents.has(id), `environment id '${id}' is already registered`);
      runtime.assertReferenceIdAvailable(id);
      const { parent, ...authorSpec } = spec;
      const properties = environmentProperties(type, authorSpec);
      for (const property of ENVIRONMENT_MEMBERS[type]) {
        if (spec[property] !== undefined && property !== "secondFogData") {
          normalizeLogical(environmentMemberValueDescriptor(type, property), spec[property], `${type}.${property}`);
        }
      }
      const ownedLight = ["PointLight", "SpotLight", "RectLight"].includes(type)
        || (type === "DirectionalLight" && spec.atmosphereSunLight !== true);
      invariant(!parent || ownedLight, `${type} uses a scene-global slot and cannot have a parent`);
      const receipt = nativeResult(runtime.environmentFacade.create(runtime.scene, JSON.stringify({
        schema_version: "EnvironmentComponentSpec/v1",
        id,
        type,
        ...(ownedLight ? { parent: parent?.handle || parent || runtime.locatorHandle } : {}),
        properties,
      })), "EnvironmentFacade.create");
      this.runtime = runtime;
      this.id = id;
      this.type = type;
      this.component_type = type;
      this.handle = receipt.environment_handle;
      this.authorValues = Object.fromEntries(Object.entries(spec)
        .filter(([name]) => name !== "id" && name !== "key" && name !== "parent"));
      this.disposed = false;
      runtime.environmentComponents.set(id, this);
      for (const property of ENVIRONMENT_MEMBERS[type]) {
        if (spec[property] !== undefined && property !== "secondFogData") {
          runtime.registerLogicalSlot(this, property, spec[property]);
        }
      }
    }

    update(patch) {
      invariant(!this.disposed, `${this.type} is disposed`);
      invariant(patch && typeof patch === "object" && !Array.isArray(patch), `${this.type} patch must be an object`);
      invariant(patch.id === undefined && patch.key === undefined,
        `member_unsupported: ${this.type}.${patch.id !== undefined ? "id" : "key"}`);
      const properties = environmentProperties(this.type, patch);
      for (const property of Object.keys(patch)) {
        if (property === "secondFogData") continue;
        const descriptor = environmentMemberValueDescriptor(this.type, property);
        normalizeLogical(descriptor, patch[property], `${this.type}.${property}`);
        const slot = this.runtime.slotKey(this, property);
        if (slot) this.runtime.assertLogicalWritable(this, property);
      }
      const receipt = nativeResult(this.runtime.environmentFacade.update(this.handle,
        JSON.stringify(properties)), "EnvironmentFacade.update");
      for (const property of Object.keys(patch)) {
        this.authorValues[property] = cloneLogical(patch[property]);
        if (property === "secondFogData") continue;
        const slot = this.runtime.slotKey(this, property);
        if (slot) this.runtime.writeLogical(this, property, patch[property], { write: false });
        else this.runtime.registerLogicalSlot(this, property, patch[property]);
      }
      return receipt;
    }

    applyProperty(property, value) {
      const receipt = nativeResult(this.runtime.environmentFacade.update(this.handle,
        JSON.stringify(environmentProperties(this.type, { [property]: value }))), "EnvironmentFacade.update");
      this.authorValues[property] = cloneLogical(value);
      return receipt;
    }

    describe() {
      invariant(!this.disposed, `${this.type} is disposed`);
      return nativeResult(this.runtime.environmentFacade.describe(this.handle), "EnvironmentFacade.describe");
    }

    snapshot() {
      const receipt = this.describe();
      return { id: this.id, type: this.type, handle: this.handle, values: receipt.values };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.runtime.disposeTargetDependents(this);
      const result = nativeResult(this.runtime.environmentFacade.dispose(this.handle), "EnvironmentFacade.dispose");
      this.runtime.environmentComponents.delete(this.id);
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  class DirectionalLight extends EnvironmentComponent {
    constructor(runtime, spec) {
      const { sunAzimuth, sunElevation, ...rest } = spec || {};
      const oriented = sunAzimuth !== undefined || sunElevation !== undefined;
      invariant(!oriented || rest.atmosphereSunLight === true,
        "DirectionalLight.sunAzimuth/sunElevation require atmosphereSunLight: true");
      super(runtime, "DirectionalLight", rest);
      this.sunAzimuth = 0;
      this.sunElevation = 90;
      this.originalSunDirection = null;
      if (oriented) {
        this.sunAzimuth = finite(sunAzimuth ?? 0, "DirectionalLight.sunAzimuth");
        this.sunElevation = finite(sunElevation ?? 90, "DirectionalLight.sunElevation");
        this.authorValues.sunAzimuth = this.sunAzimuth;
        this.authorValues.sunElevation = this.sunElevation;
        this.applySunDirection();
        runtime.registerLogicalSlot(this, "sunAzimuth", this.sunAzimuth);
        runtime.registerLogicalSlot(this, "sunElevation", this.sunElevation);
      }
    }

    applySunDirection() {
      invariant(this.sunElevation >= -90 && this.sunElevation <= 90, "DirectionalLight.sunElevation must be in -90..90 degrees");
      invariant(this.sunAzimuth >= -360 && this.sunAzimuth <= 360, "DirectionalLight.sunAzimuth must be in -360..360 degrees");
      const direction = sunDirectionFromAnchor(this.runtime.anchor, this.sunAzimuth, this.sunElevation);
      const sun = this.runtime.scene?.sun;
      const Vector3 = this.runtime.Module?.Vector3;
      if (!sun || typeof sun.setDirection !== "function" || typeof Vector3?.create !== "function") {
        this.sunDirection = direction;
        return { ok: true, native: false, direction };
      }
      if (!this.originalSunDirection && typeof sun.direction === "function") {
        const current = sun.direction();
        this.originalSunDirection = { x: current.x, y: current.y, z: current.z };
        if (typeof current.delete === "function") current.delete();
      }
      const vector = Vector3.create(direction.x, direction.y, direction.z);
      try { sun.setDirection(vector); } finally { if (typeof vector.delete === "function") vector.delete(); }
      // Engines with setDirectionLocked keep this direction across frames; older
      // engines re-solve the sun from the wall clock every frame and ignore it.
      const nativeLock = typeof sun.setDirectionLocked === "function";
      if (nativeLock) sun.setDirectionLocked(true);
      sunDirectionOwner = this;
      this.sunDirection = direction;
      this.sunDirectionLocked = nativeLock;
      return { ok: true, native: true, locked: nativeLock, direction };
    }

    update(patch) {
      const { sunAzimuth, sunElevation, ...rest } = patch || {};
      const receipt = Object.keys(rest).length ? super.update(rest) : { ok: true };
      for (const [property, value] of [["sunAzimuth", sunAzimuth], ["sunElevation", sunElevation]]) {
        if (value === undefined) continue;
        if (this.runtime.slotKey(this, property)) this.runtime.writeLogical(this, property, value);
        else this.applyProperty(property, value);
      }
      return receipt;
    }

    applyProperty(property, value) {
      if (!SUN_DIRECTION_MEMBERS.has(property)) return super.applyProperty(property, value);
      invariant(this.authorValues.atmosphereSunLight === true,
        `DirectionalLight.${property} requires atmosphereSunLight: true`);
      const previous = this[property];
      this[property] = finite(value, `DirectionalLight.${property}`);
      try { this.applySunDirection(); } catch (error) { this[property] = previous; throw error; }
      this.authorValues[property] = this[property];
      if (!this.runtime.slotKey(this, property)) this.runtime.registerLogicalSlot(this, property, this[property]);
      return { ok: true, property, value: this[property] };
    }

    snapshot() {
      const result = super.snapshot();
      if (this.sunDirection) {
        result.sun = { azimuth: this.sunAzimuth, elevation: this.sunElevation, direction: { ...this.sunDirection },
          locked: this.sunDirectionLocked === true };
      }
      return result;
    }

    dispose() {
      if (!this.disposed && this.originalSunDirection) {
        const sun = this.runtime.scene?.sun;
        const Vector3 = this.runtime.Module?.Vector3;
        const original = this.originalSunDirection;
        this.originalSunDirection = null;
        // A replaced generation must not undo the sun the current generation just set.
        if (sun && sunDirectionOwner === this) {
          sunDirectionOwner = null;
          if (typeof sun.setDirectionLocked === "function") {
            // Hand the sun back to the engine's time-driven solar position.
            sun.setDirectionLocked(false);
          } else if (typeof Vector3?.create === "function") {
            const vector = Vector3.create(original.x, original.y, original.z);
            try { sun.setDirection(vector); } finally { if (typeof vector.delete === "function") vector.delete(); }
          }
        }
      }
      return super.dispose();
    }
  }
  class PointLight extends EnvironmentComponent {
    constructor(runtime, spec) { super(runtime, "PointLight", spec); }
  }
  class SpotLight extends EnvironmentComponent {
    constructor(runtime, spec) { super(runtime, "SpotLight", spec); }
  }
  class RectLight extends EnvironmentComponent {
    constructor(runtime, spec) { super(runtime, "RectLight", spec); }
  }
  class SkyLight extends EnvironmentComponent {
    constructor(runtime, spec) { super(runtime, "SkyLight", spec); }
  }
  class SkyAtmosphere extends EnvironmentComponent {
    constructor(runtime, spec) { super(runtime, "SkyAtmosphere", spec); }
  }
  class VolumetricCloud extends EnvironmentComponent {
    constructor(runtime, spec) { super(runtime, "VolumetricCloud", spec); }
  }
  class ExponentialHeightFog extends EnvironmentComponent {
    constructor(runtime, spec) { super(runtime, "ExponentialHeightFog", spec); }
  }

  class SunSky {
    constructor(runtime, spec) {
      invariant(runtime.environmentFacade, "EnvironmentFacade/v1 is unavailable");
      const id = spec?.id || spec?.key;
      invariant(typeof id === "string" && id.length > 0, "SunSky.id or key is required");
      invariant(!runtime.sunSkies.has(id), `SunSky id '${id}' is already registered`);
      runtime.assertReferenceIdAvailable(id);
      const capabilities = nativeResult(runtime.environmentFacade.capabilities(), "EnvironmentFacade.capabilities");
      invariant(hasCapability(capabilities, SUN_SKY_CAPABILITY),
        `ue_member_unsupported: SunSky requires unavailable capability '${SUN_SKY_CAPABILITY}'`);
      invariant(typeof runtime.environmentFacade.createSunSky === "function",
        `environment_dependency_missing: ${SUN_SKY_CAPABILITY} adapter is unavailable`);
      const values = sunSkySpec(spec, runtime.resolvedCalendarYear);
      const receipt = nativeResult(runtime.environmentFacade.createSunSky(runtime.scene, JSON.stringify({
        schema_version: "SunSkySpec/v1",
        id,
        capability: SUN_SKY_CAPABILITY,
        resolved_calendar_year: runtime.resolvedCalendarYear,
        values,
      })), "EnvironmentFacade.createSunSky");
      this.runtime = runtime;
      this.id = id;
      this.component_type = "SunSky";
      this.handle = receipt.sun_sky_handle;
      this.authorValues = Object.fromEntries(Object.entries(spec).filter(([name]) => name !== "id" && name !== "key"));
      this.disposed = false;
      runtime.sunSkies.set(id, this);
      for (const property of SUN_SKY_SCALAR_MEMBERS) {
        if (spec[property] !== undefined) runtime.registerLogicalSlot(this, property, spec[property]);
      }
    }

    applyPatch(patch) {
      invariant(!this.disposed, "SunSky is disposed");
      invariant(patch && typeof patch === "object" && !Array.isArray(patch), "SunSky patch must be an object");
      const merged = { ...this.authorValues, ...patch };
      for (const group of Object.keys(SUN_SKY_GROUP_MEMBERS)) {
        if (patch[group] !== undefined) merged[group] = { ...(this.authorValues[group] || {}), ...patch[group] };
      }
      const values = sunSkySpec(merged, this.runtime.resolvedCalendarYear, true);
      invariant(typeof this.runtime.environmentFacade.updateSunSky === "function",
        `environment_dependency_missing: ${SUN_SKY_CAPABILITY} update adapter is unavailable`);
      const receipt = nativeResult(this.runtime.environmentFacade.updateSunSky(this.handle, JSON.stringify({
        schema_version: "SunSkyUpdate/v1",
        resolved_calendar_year: this.runtime.resolvedCalendarYear,
        values,
      })), "EnvironmentFacade.updateSunSky");
      this.authorValues = merged;
      return receipt;
    }

    update(patch) {
      invariant(patch && typeof patch === "object" && !Array.isArray(patch), "SunSky patch must be an object");
      for (const property of Object.keys(patch)) {
        if (!SUN_SKY_SCALAR_MEMBERS.includes(property)) continue;
        normalizeLogical(sunSkyMemberValueDescriptor(property), patch[property], `SunSky.${property}`);
        if (this.runtime.slotKey(this, property)) this.runtime.assertLogicalWritable(this, property);
      }
      const receipt = this.applyPatch(patch);
      for (const property of Object.keys(patch)) {
        if (!SUN_SKY_SCALAR_MEMBERS.includes(property)) continue;
        const slot = this.runtime.slotKey(this, property);
        if (slot) this.runtime.writeLogical(this, property, patch[property], { write: false });
        else this.runtime.registerLogicalSlot(this, property, patch[property]);
      }
      return receipt;
    }

    applyProperty(property, value) { return this.applyPatch({ [property]: value }); }

    describe() {
      invariant(!this.disposed, "SunSky is disposed");
      invariant(typeof this.runtime.environmentFacade.describeSunSky === "function",
        `environment_dependency_missing: ${SUN_SKY_CAPABILITY} readback adapter is unavailable`);
      return nativeResult(this.runtime.environmentFacade.describeSunSky(this.handle), "EnvironmentFacade.describeSunSky");
    }

    snapshot() {
      const receipt = this.describe();
      return {
        id: this.id,
        handle: this.handle,
        resolvedCalendarYear: this.runtime.resolvedCalendarYear,
        values: receipt.values,
      };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.runtime.disposeTargetDependents(this);
      invariant(typeof this.runtime.environmentFacade.disposeSunSky === "function",
        `environment_dependency_missing: ${SUN_SKY_CAPABILITY} dispose adapter is unavailable`);
      const result = nativeResult(this.runtime.environmentFacade.disposeSunSky(this.handle), "EnvironmentFacade.disposeSunSky");
      this.runtime.sunSkies.delete(this.id);
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  const POST_PROCESS_SETTING_MEMBERS = Object.freeze([
    "autoExposureMethod", "autoExposureBias", "autoExposureMinBrightness", "autoExposureMaxBrightness",
    "autoExposureSpeedUp", "autoExposureSpeedDown", "lowPercent", "highPercent", "histogramLogMin",
    "histogramLogMax", "bloomMethod", "bloomIntensity", "bloomThreshold", "lensFlareIntensity",
    "lensFlareBokehSize", "lensFlareThreshold", "depthOfFieldFocalDistance", "motionBlurAmount",
    "vignetteIntensity", "filmSlope", "filmToe", "filmShoulder", "filmBlackClip", "filmWhiteClip",
    "temperature", "temperatureTint", "blueCorrection", "expandGamut", "toneCurveAmount",
    "ambientOcclusionFadeRadius", "ambientOcclusionFadeDistance", "ambientOcclusionIntensity",
    "ambientOcclusionPower",
  ]);

  // CameraView pose members are degrees / metres on the author surface.  Angles are converted to radians
  // exactly once, inside CameraView.writeCamera.
  function cameraViewMemberValueDescriptor(property) {
    if (property === "position") {
      return { kind: "member", value_type: "vector3", unit: "m", length: 3, divisor: 1e6 };
    }
    const ranges = {
      longitude: ["deg", -180, 180], latitude: ["deg", -90, 90], height: ["m", -1e7, 1e8],
      heading: ["deg", -360, 360], pitch: ["deg", -90, 90], roll: ["deg", -180, 180],
      fov: ["deg", 1, 170],
    };
    const entry = ranges[property];
    if (!entry) {
      throw codedError("member_unsupported", `member_unsupported: CameraView.${property}`);
    }
    const [unit, minimum, maximum] = entry;
    return {
      kind: "member", value_type: "scalar", unit, length: 1, divisor: 1e6,
      validate: (value, field) => invariant(value >= minimum && value <= maximum,
        `${field} must be in ${minimum}..${maximum}`),
    };
  }

  function postProcessMemberValueDescriptor(property) {
    if (property === "enabled" || property === "unbound") {
      return { kind: "member", value_type: "boolean", unit: null, length: 1, divisor: 1 };
    }
    if (["priority", "blendRadius", "blendWeight"].includes(property)) {
      return {
        kind: "member", value_type: "scalar", unit: "scalar", length: 1, divisor: 1e6,
        validate: property === "blendWeight"
          ? (value, field) => invariant(value >= 0 && value <= 1, `${field} must be in 0..1`)
          : property === "blendRadius"
            ? (value, field) => invariant(value >= 0, `${field} must be >= 0`)
            : undefined,
      };
    }
    if (property.startsWith("settings.")) {
      const setting = property.slice("settings.".length);
      invariant(POST_PROCESS_SETTING_MEMBERS.includes(setting),
        `ue_member_unsupported: PostProcessSettings.${setting}`);
      return ["autoExposureMethod", "bloomMethod"].includes(setting)
        ? { kind: "member", value_type: "string", unit: null, length: 1, divisor: 1 }
        : { kind: "member", value_type: "scalar", unit: "scalar", length: 1, divisor: 1e6 };
    }
    throw codedError("member_unsupported", `member_unsupported: PostProcessVolume.${property}`);
  }

  function postProcessSettings(value, field = "PostProcessVolume.settings") {
    invariant(value && typeof value === "object" && !Array.isArray(value), `${field} must be a grouped object`);
    const unknown = Object.keys(value).find((name) => !POST_PROCESS_SETTING_MEMBERS.includes(name));
    invariant(!unknown, `ue_member_unsupported: PostProcessSettings.${unknown}`);
    if (value.autoExposureMethod !== undefined) {
      invariant(["Histogram", "Basic", "Manual"].includes(value.autoExposureMethod),
        "ue_enum_value_unsupported: autoExposureMethod must be Histogram, Basic, or Manual");
    }
    if (value.bloomMethod !== undefined) {
      invariant(["Standard", "Convolution"].includes(value.bloomMethod),
        "ue_enum_value_unsupported: bloomMethod must be Standard or Convolution");
    }
    return { ...value };
  }

  function postProcessSpec(spec, patch = false) {
    invariant(spec && typeof spec === "object" && !Array.isArray(spec),
      `PostProcessVolume ${patch ? "patch" : "needs a spec"}`);
    const allowed = new Set(["id", "key", "enabled", "unbound", "priority", "blendRadius", "blendWeight", "settings"]);
    const unknown = Object.keys(spec).find((name) => !allowed.has(name));
    invariant(!unknown, `ue_member_unsupported: PostProcessVolume.${unknown}`);
    const result = {};
    if (spec.enabled !== undefined) result.enabled = spec.enabled;
    if (spec.unbound !== undefined) result.unbound = spec.unbound;
    if (spec.priority !== undefined) result.priority = spec.priority;
    if (spec.blendRadius !== undefined) result.blend_radius = spec.blendRadius;
    if (spec.blendWeight !== undefined) result.blend_weight = spec.blendWeight;
    if (spec.settings !== undefined) result.settings = postProcessSettings(spec.settings);
    return result;
  }

  class PostProcessVolume {
    constructor(runtime, spec) {
      invariant(runtime.postProcessFacade, "PostProcessFacade/v1 is unavailable");
      const id = spec?.id || spec?.key;
      invariant(typeof id === "string" && id.length > 0, "PostProcessVolume.id or key is required");
      invariant(!runtime.postProcessVolumes.has(id), `post-process id '${id}' is already registered`);
      runtime.assertReferenceIdAvailable(id);
      const values = postProcessSpec(spec);
      for (const [property, value] of Object.entries({
        enabled: values.enabled ?? true,
        unbound: values.unbound ?? true,
        priority: values.priority ?? 0,
        blendRadius: values.blend_radius ?? 100,
        blendWeight: values.blend_weight ?? 1,
      })) normalizeLogical(postProcessMemberValueDescriptor(property), value, `PostProcessVolume.${property}`);
      for (const [setting, value] of Object.entries(spec.settings || {})) {
        normalizeLogical(postProcessMemberValueDescriptor(`settings.${setting}`), value,
          `PostProcessVolume.settings.${setting}`);
      }
      const receipt = nativeResult(runtime.postProcessFacade.create(JSON.stringify({
        schema_version: "PostProcessVolumeSpec/v1",
        id: `${runtime.nativeIdPrefix}/${id}`,
        enabled: values.enabled ?? true,
        unbound: values.unbound ?? true,
        priority: values.priority ?? 0,
        blend_radius: values.blend_radius ?? 100,
        blend_weight: values.blend_weight ?? 1,
        settings: values.settings || {},
      })), "PostProcessFacade.create");
      this.runtime = runtime;
      this.id = id;
      this.component_type = "PostProcessVolume";
      this.handle = receipt.postprocess_handle;
      this.authorValues = {
        enabled: values.enabled ?? true,
        unbound: values.unbound ?? true,
        priority: values.priority ?? 0,
        blendRadius: values.blend_radius ?? 100,
        blendWeight: values.blend_weight ?? 1,
      };
      this.authorSettings = { ...(spec.settings || {}) };
      this.disposed = false;
      runtime.postProcessVolumes.set(id, this);
      for (const [property, value] of Object.entries(this.authorValues)) {
        runtime.registerLogicalSlot(this, property, value);
      }
      for (const [setting, value] of Object.entries(this.authorSettings)) {
        runtime.registerLogicalSlot(this, `settings.${setting}`, value);
      }
    }

    update(patch) {
      invariant(!this.disposed, "PostProcessVolume is disposed");
      const values = postProcessSpec(patch, true);
      const entries = [];
      for (const property of ["enabled", "unbound", "priority", "blendRadius", "blendWeight"]) {
        if (patch[property] !== undefined) entries.push([property, patch[property]]);
      }
      for (const [setting, value] of Object.entries(patch.settings || {})) {
        entries.push([`settings.${setting}`, value]);
      }
      for (const [property, value] of entries) {
        normalizeLogical(postProcessMemberValueDescriptor(property), value, `PostProcessVolume.${property}`);
        if (this.runtime.slotKey(this, property)) this.runtime.assertLogicalWritable(this, property);
      }
      const receipt = nativeResult(this.runtime.postProcessFacade.update(this.handle, JSON.stringify(values)),
        "PostProcessFacade.update");
      for (const [property, value] of entries) {
        if (property.startsWith("settings.")) this.authorSettings[property.slice(9)] = value;
        else this.authorValues[property] = value;
        const slot = this.runtime.slotKey(this, property);
        if (slot) this.runtime.writeLogical(this, property, value, { write: false });
        else this.runtime.registerLogicalSlot(this, property, value);
      }
      return receipt;
    }

    applyProperty(property, value) {
      const patch = property.startsWith("settings.")
        ? { settings: { [property.slice(9)]: value } } : { [property]: value };
      const values = postProcessSpec(patch, true);
      const receipt = nativeResult(this.runtime.postProcessFacade.update(this.handle, JSON.stringify(values)),
        "PostProcessFacade.update");
      if (property.startsWith("settings.")) this.authorSettings[property.slice(9)] = value;
      else this.authorValues[property] = value;
      return receipt;
    }

    describe() {
      invariant(!this.disposed, "PostProcessVolume is disposed");
      return nativeResult(this.runtime.postProcessFacade.describe(this.handle), "PostProcessFacade.describe");
    }

    snapshot() {
      const receipt = this.describe();
      return {
        id: this.id,
        handle: this.handle,
        enabled: receipt.enabled,
        unbound: receipt.unbound,
        priority: receipt.priority,
        blendRadius: receipt.blend_radius,
        blendWeight: receipt.blend_weight,
        settings: { ...receipt.settings },
        overridePresence: [...receipt.override_presence],
      };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.runtime.disposeTargetDependents(this);
      const result = nativeResult(this.runtime.postProcessFacade.dispose(this.handle), "PostProcessFacade.dispose");
      this.runtime.postProcessVolumes.delete(this.id);
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  function materialUvScale(value) {
    if (value === undefined) return [1, 1];
    let u, v;
    if (Array.isArray(value)) {
      invariant(value.length === 2, "PrincipledMaterial.uvScale must be [u, v] or { x, y }");
      [u, v] = value;
    } else {
      invariant(value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === 2 && Object.hasOwn(value, "x") && Object.hasOwn(value, "y"),
      "PrincipledMaterial.uvScale must be [u, v] or { x, y }");
      ({ x: u, y: v } = value);
    }
    finite(u, "PrincipledMaterial.uvScale.u");
    finite(v, "PrincipledMaterial.uvScale.v");
    invariant(u > 0 && v > 0, "PrincipledMaterial.uvScale components must be > 0");
    return [u, v];
  }

  function emissiveColorComponents(value) {
    let r, g, b;
    if (Array.isArray(value)) {
      invariant(value.length === 3, "PrincipledMaterial.emissiveColor must be [r, g, b] or { x, y, z }");
      [r, g, b] = value;
    } else {
      invariant(value && typeof value === "object"
        && ["x", "y", "z"].every((axis) => Object.hasOwn(value, axis)),
      "PrincipledMaterial.emissiveColor must be [r, g, b] or { x, y, z }");
      ({ x: r, y: g, z: b } = value);
    }
    const components = [r, g, b];
    components.forEach((component, index) => {
      finite(component, `PrincipledMaterial.emissiveColor[${index}]`);
      invariant(component >= 0 && component <= MAX_EMISSIVE_COMPONENT,
        `PrincipledMaterial.emissiveColor[${index}] must be in 0..${MAX_EMISSIVE_COMPONENT}`);
    });
    return components;
  }

  const MANAGED_MATERIAL_TEXTURE_SLOTS = Object.freeze([
    "baseColorMap", "metallicRoughnessMap", "normalMap", "emissiveMap",
  ]);
  // The emissive map is multiplied by this factor in the base pass, so components above 1 are how a
  // neon surface gets bright enough to cross the bloom threshold.  It is deliberately not a 0..1 colour.
  const MAX_EMISSIVE_COMPONENT = 16;

  function requireMaterialFacadeV2(runtime, field) {
    const facade = runtime.materialFacade;
    invariant(facade && typeof facade.capabilities === "function", `MaterialFacade/v2 is required for ${field}`);
    const capabilities = nativeResult(facade.capabilities(), "MaterialFacade.capabilities");
    invariant(capabilities.facade_version === "MaterialFacade/v2"
      && capabilities.texture_profile === "ManagedTexture/v2"
      && Array.isArray(capabilities.texture_slots) && capabilities.texture_slots.includes("baseColorMap")
      && Array.isArray(capabilities.unavailable_properties)
      && typeof facade.write === "function" && typeof facade.read === "function"
      && typeof facade.writeTexture === "function" && typeof facade.readTexture === "function"
      && typeof facade.clearTexture === "function" && typeof facade.setTextureTransform === "function",
    "MaterialFacade/v2 does not publish the required managed baseColorMap capability");
    invariant(Array.isArray(capabilities.properties) && capabilities.properties.includes("baseColorMap"),
      `MaterialFacade/v2 does not publish required property baseColorMap for ${field}`);
    const unavailableProperties = new Set(capabilities.unavailable_properties);
    invariant(!unavailableProperties.has("baseColorMap"),
      `MaterialFacade/v2 declares required property baseColorMap unavailable for ${field}`);
    return {
      facade,
      unavailableProperties,
      properties: new Set(capabilities.properties),
      textureSlots: new Set(capabilities.texture_slots),
    };
  }

  function assertMaterialMemberAvailable(unavailableProperties, property) {
    invariant(!unavailableProperties.has(property),
      `PrincipledMaterial.${property} is unavailable in MaterialFacade/v2`);
  }

  function assertManagedMaterialTextureSlotAvailable(capability, slot) {
    invariant(MANAGED_MATERIAL_TEXTURE_SLOTS.includes(slot),
      `PrincipledMaterial.${slot} is not a managed texture slot`);
    invariant(capability.properties.has(slot) && capability.textureSlots.has(slot),
      `MaterialFacade/v2 does not publish required managed ${slot} capability`);
    assertMaterialMemberAvailable(capability.unavailableProperties, slot);
  }

  function uvScaleReadbackMatches(receipt, expected) {
    return Array.isArray(receipt?.uv_scale) && receipt.uv_scale.length === 2
      && receipt.uv_scale.every((value) => Number.isFinite(value) && value > 0)
      && receipt.uv_scale.every((value, index) => Math.abs(value - expected[index])
        <= 1e-6 * Math.max(1, Math.abs(value), Math.abs(expected[index])));
  }

  class PrincipledMaterial {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "PrincipledMaterial needs a spec");
      const materialCapability = requireMaterialFacadeV2(runtime, "PrincipledMaterial");
      const unavailableMaterialMember = Object.keys(spec).find((name) =>
        materialCapability.unavailableProperties.has(name));
      invariant(!unavailableMaterialMember,
        `PrincipledMaterial.${unavailableMaterialMember} is unavailable in MaterialFacade/v2`);
      const allowed = new Set([
        "id", "key", "target", "baseColor", "opacity", "metalness", "roughness",
        "baseColorMap", "metallicRoughnessMap", "normalMap", "emissiveMap", "normalScale", "uvScale",
        "emissiveColor",
      ]);
      const unknown = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: PrincipledMaterial.${unknown}`);
      invariant(spec.target instanceof SceneObject && !spec.target.disposed,
        "PrincipledMaterial.target must be a live scene object");
      invariant(spec.target.materials.size === 0,
        "PrincipledMaterial.target already has a PrincipledMaterial");
      const id = spec.id || spec.key || `${spec.target.spec.id}/material`;
      invariant(typeof id === "string" && id.length > 0, "PrincipledMaterial.id or key is required");
      invariant(!runtime.materials.has(id), `PrincipledMaterial '${id}' is already registered`);
      invariant(!runtime.objects.has(id) && !runtime.groups.has(id),
        `PrincipledMaterial id '${id}' is already in use by a scene node`);
      const uvScale = materialUvScale(spec.uvScale);
      if (spec.baseColor !== undefined) hexColor(spec.baseColor);
      if (spec.opacity !== undefined) {
        finite(spec.opacity, "PrincipledMaterial.opacity");
        invariant(spec.opacity >= 0 && spec.opacity <= 1, "PrincipledMaterial.opacity must be in 0..1");
      }
      for (const name of ["metalness", "roughness"]) {
        if (spec[name] === undefined) continue;
        finite(spec[name], `PrincipledMaterial.${name}`);
        invariant(spec[name] >= 0 && spec[name] <= 1, `PrincipledMaterial.${name} must be in 0..1`);
      }
      for (const slot of MANAGED_MATERIAL_TEXTURE_SLOTS) {
        const texture = spec[slot];
        if (texture === undefined) continue;
        invariant(texture instanceof Texture && !texture.disposed && texture.runtime === runtime,
          `PrincipledMaterial.${slot} must be a live Texture from the same runtime`);
      }
      this.runtime = runtime;
      this.id = id;
      this.target = spec.target;
      this.values = new Map();
      this.uvScale = uvScale;
      // Slot state and its revision counter come from the same list that drives the allowlist,
      // initial writes, clear, snapshot and teardown: a hand-written pair per slot silently leaves
      // a new slot's revision undefined (NaN never equals itself, so every write reads as
      // "superseded" and the map is dropped without an error the author can see).
      for (const slot of MANAGED_MATERIAL_TEXTURE_SLOTS) {
        this[slot] = null;
        this[`${slot}Revision`] = 0;
      }
      this.disposed = false;
      runtime.materials.set(id, this);
      this.target.materials.add(this);
      try {
        this.applyTextureTransform(uvScale, materialCapability);
        if (spec.baseColor !== undefined) this.setBaseColor(spec.baseColor);
        if (spec.opacity !== undefined) this.setOpacity(spec.opacity);
        if (spec.metalness !== undefined) this.setMetalness(spec.metalness);
        if (spec.roughness !== undefined) this.setRoughness(spec.roughness);
        if (spec.normalScale !== undefined) this.setNormalScale(spec.normalScale);
        if (spec.emissiveColor !== undefined) this.setEmissiveColor(spec.emissiveColor);
      } catch (error) {
        this.dispose();
        throw error;
      }
      const initialTextureSlots = MANAGED_MATERIAL_TEXTURE_SLOTS.filter((slot) => spec[slot] !== undefined);
      if (initialTextureSlots.length === 0) {
        this.ready = Promise.resolve(this);
      } else {
        let initial;
        try {
          initial = Promise.all(initialTextureSlots.map((slot) => this.setManagedTexture(slot, spec[slot])));
        } catch (error) {
          this.dispose();
          throw error;
        }
        this.ready = initial.then(() => this).catch((error) => {
          if (!this.disposed) this.dispose();
          throw error;
        });
      }
    }

    applyTextureTransform(value, capability = null) {
      invariant(!this.disposed, "PrincipledMaterial is disposed");
      const uvScale = materialUvScale(value);
      const materialCapability = capability || requireMaterialFacadeV2(this.runtime, "PrincipledMaterial.uvScale");
      assertMaterialMemberAvailable(materialCapability.unavailableProperties, "uvScale");
      const materialFacade = materialCapability.facade;
      const receipt = nativeResult(materialFacade.setTextureTransform(this.target.handle, JSON.stringify({
        schema_version: "MaterialTextureTransform/v1",
        uv_scale: uvScale,
        offset: [0, 0],
      })), "MaterialFacade.setTextureTransform");
      if (!uvScaleReadbackMatches(receipt, uvScale)) {
        throw new Error("MaterialFacade.setTextureTransform returned an invalid uv_scale readback receipt");
      }
      this.uvScale = [...uvScale];
      return this;
    }

    setProperty(name, property, value, validate) {
      invariant(!this.disposed, "PrincipledMaterial is disposed");
      validate(value);
      this.runtime.writeLogical(this.target, property, value);
      this.values.set(name, cloneLogical(this.runtime.slotKey(this.target, property).value));
      return this;
    }

    setBaseColor(value) {
      return this.setProperty("baseColor", "material.color", value, hexColor);
    }

    setOpacity(value) {
      return this.setProperty("opacity", "material.opacity", value, (candidate) => {
        finite(candidate, "PrincipledMaterial.opacity");
        invariant(candidate >= 0 && candidate <= 1, "PrincipledMaterial.opacity must be in 0..1");
      });
    }

    // emissiveColor is the factor the base pass multiplies emissiveMap by, so it is an [r, g, b]
    // multiplier rather than a 0..1 colour: 1 means "the map as authored" and higher values push a
    // neon surface past the bloom threshold.  It travels on its own frozen shape because
    // PrincipledMaterialProperty/v1 is closed around a scalar value.
    setEmissiveColor(value) {
      invariant(!this.disposed, "PrincipledMaterial is disposed");
      const components = emissiveColorComponents(value);
      const materialCapability = requireMaterialFacadeV2(this.runtime, "PrincipledMaterial.emissiveColor");
      assertMaterialMemberAvailable(materialCapability.unavailableProperties, "emissiveColor");
      const materialFacade = materialCapability.facade;
      invariant(materialCapability.properties.has("emissiveColor")
        && typeof materialFacade.writeColor === "function",
      "MaterialFacade/v2 does not publish the emissiveColor capability");
      const receipt = nativeResult(materialFacade.writeColor(this.target.handle, JSON.stringify({
        schema_version: "PrincipledMaterialColor/v1",
        property: "emissiveColor",
        value: components,
      })), "MaterialFacade.writeColor");
      invariant(receipt.property === "emissiveColor" && Array.isArray(receipt.value)
        && receipt.value.length === 3
        && receipt.value.every((seen, index) => Number.isFinite(seen)
          && Math.abs(seen - components[index]) <= 1e-5),
      "MaterialFacade.writeColor returned an invalid emissiveColor readback receipt");
      this.values.set("emissiveColor", [...components]);
      return this;
    }

    setMaterialScalar(name, value, minimum, maximum) {
      invariant(!this.disposed, "PrincipledMaterial is disposed");
      finite(value, `PrincipledMaterial.${name}`);
      invariant(value >= minimum && value <= maximum, `PrincipledMaterial.${name} must be in ${minimum}..${maximum}`);
      const materialCapability = requireMaterialFacadeV2(this.runtime, `PrincipledMaterial.${name}`);
      assertMaterialMemberAvailable(materialCapability.unavailableProperties, name);
      const materialFacade = materialCapability.facade;
      const receipt = nativeResult(materialFacade.write(this.target.handle, JSON.stringify({
        schema_version: "PrincipledMaterialProperty/v1",
        property: name,
        value,
      })), "MaterialFacade.write");
      this.values.set(name, receipt.value);
      return this;
    }

    setMetalness(value) { return this.setMaterialScalar("metalness", value, 0, 1); }
    setRoughness(value) { return this.setMaterialScalar("roughness", value, 0, 1); }
    setNormalScale(value) { return this.setMaterialScalar("normalScale", value, 0, 2); }

    hasManagedTextureReference(texture) {
      return MANAGED_MATERIAL_TEXTURE_SLOTS.some((slot) => this[slot] === texture);
    }

    releaseManagedTextureReference(texture) {
      if (texture && !this.hasManagedTextureReference(texture)) texture.references.delete(this);
    }

    setManagedTexture(slot, texture) {
      invariant(!this.disposed, "PrincipledMaterial is disposed");
      invariant(texture instanceof Texture && !texture.disposed && texture.runtime === this.runtime,
        `PrincipledMaterial.${slot} must be a live Texture from the same runtime`);
      const materialCapability = requireMaterialFacadeV2(this.runtime, `PrincipledMaterial.${slot}`);
      assertManagedMaterialTextureSlotAvailable(materialCapability, slot);
      const materialFacade = materialCapability.facade;
      const revisionKey = `${slot}Revision`;
      const revision = ++this[revisionKey];
      const update = (async () => {
        const bytes = await texture.load();
        invariant(!this.disposed, "PrincipledMaterial is disposed");
        invariant(!texture.disposed,
          `PrincipledMaterial.${slot} must remain live until native upload completes`);
        invariant(revision === this[revisionKey],
          `PrincipledMaterial.${slot} update was superseded`);
        const receipt = nativeResult(materialFacade.writeTexture(
          this.target.handle,
          JSON.stringify({
            schema_version: "ManagedTexture/v2",
            slot,
            content_digest: texture.source.content_digest,
            size_bytes: texture.source.size_bytes,
            media_type: texture.source.media_type,
          }),
          bytes,
        ), "MaterialFacade.writeTexture");
        if (receipt.slot !== slot
          || receipt.native_present !== true
          || receipt.content_digest !== texture.source.content_digest
          || receipt.media_type !== texture.source.media_type
          || receipt.size_bytes !== texture.source.size_bytes
          || !Number.isSafeInteger(receipt.width) || receipt.width <= 0
          || !Number.isSafeInteger(receipt.height) || receipt.height <= 0) {
          nativeResult(materialFacade.clearTexture(this.target.handle, slot),
            "MaterialFacade.clearTexture(after invalid write receipt)");
          // The native slot is empty again, so the JS binding has to go with it: keeping the old
          // reference would leave snapshot, dispose and hot-reload cleaning up a texture the native
          // material no longer holds (and the material would keep rendering untextured while the
          // runtime reports a map).
          const stale = this[slot];
          this[slot] = null;
          this.releaseManagedTextureReference(stale);
          throw new Error("MaterialFacade.writeTexture returned an invalid native readback receipt");
        }
        const previous = this[slot];
        this[slot] = texture;
        texture.references.add(this);
        if (previous && previous !== texture) this.releaseManagedTextureReference(previous);
        return this;
      })();
      this.ready = update;
      return update;
    }

    setBaseColorMap(texture) { return this.setManagedTexture("baseColorMap", texture); }
    setMetallicRoughnessMap(texture) { return this.setManagedTexture("metallicRoughnessMap", texture); }
    setNormalMap(texture) { return this.setManagedTexture("normalMap", texture); }
    setEmissiveMap(texture) { return this.setManagedTexture("emissiveMap", texture); }

    clearManagedTexture(slot) {
      invariant(!this.disposed, "PrincipledMaterial is disposed");
      const materialCapability = requireMaterialFacadeV2(this.runtime, `PrincipledMaterial.${slot}`);
      assertManagedMaterialTextureSlotAvailable(materialCapability, slot);
      const revisionKey = `${slot}Revision`;
      ++this[revisionKey];
      const receipt = nativeResult(materialCapability.facade.clearTexture(this.target.handle, slot),
        "MaterialFacade.clearTexture");
      const previous = this[slot];
      this[slot] = null;
      this.releaseManagedTextureReference(previous);
      this.ready = Promise.resolve(this);
      return receipt;
    }

    clearBaseColorMap() { return this.clearManagedTexture("baseColorMap"); }
    clearMetallicRoughnessMap() { return this.clearManagedTexture("metallicRoughnessMap"); }
    clearNormalMap() { return this.clearManagedTexture("normalMap"); }
    clearEmissiveMap() { return this.clearManagedTexture("emissiveMap"); }

    managedTextureSnapshot(slot, textureReceipt) {
      const texture = this[slot];
      if (!texture) return null;
      const receipt = textureReceipt?.slots?.[slot] ?? null;
      invariant(receipt && receipt.slot === slot,
        "MaterialFacade.readTexture returned an invalid managed texture slots receipt");
      return {
        texture: texture.id,
        content_digest: receipt.content_digest,
        media_type: receipt.media_type,
        size_bytes: receipt.size_bytes,
        width: receipt.width,
        height: receipt.height,
        native_present: receipt.native_present,
      };
    }

    snapshot() {
      const textureReceipt = MANAGED_MATERIAL_TEXTURE_SLOTS.some((slot) => this[slot])
        ? nativeResult(requireMaterialFacadeV2(this.runtime, "PrincipledMaterial.texture").facade
          .readTexture(this.target.handle),
          "MaterialFacade.readTexture")
        : null;
      return {
        id: this.id,
        target: this.target.spec.id,
        baseColor: this.values.get("baseColor") ?? null,
        opacity: this.values.get("opacity") ?? null,
        metalness: this.values.get("metalness") ?? null,
        roughness: this.values.get("roughness") ?? null,
        normalScale: this.values.get("normalScale") ?? null,
        uvScale: [...this.uvScale],
        baseColorMap: this.managedTextureSnapshot("baseColorMap", textureReceipt),
        metallicRoughnessMap: this.managedTextureSnapshot("metallicRoughnessMap", textureReceipt),
        normalMap: this.managedTextureSnapshot("normalMap", textureReceipt),
      };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      for (const slot of MANAGED_MATERIAL_TEXTURE_SLOTS) {
        const revisionKey = `${slot}Revision`;
        ++this[revisionKey];
        const texture = this[slot];
        if (!texture) continue;
        const materialCapability = requireMaterialFacadeV2(this.runtime, `PrincipledMaterial.${slot}`);
        assertManagedMaterialTextureSlotAvailable(materialCapability, slot);
        nativeResult(materialCapability.facade.clearTexture(this.target.handle, slot),
          "MaterialFacade.clearTexture");
        this[slot] = null;
        this.releaseManagedTextureReference(texture);
      }
      this.runtime.materials.delete(this.id);
      this.target.materials.delete(this);
      this.disposed = true;
      return { ok: true, removed: true, idempotent: false };
    }
  }

  const REPEATER_FACTORIES = Object.freeze({
    Box: "createBox",
    Plane: "createPlane",
    Sphere: "createSphere",
    Cylinder: "createCylinder",
    Cone: "createCone",
    Polyline: "createPolyline",
    Polygon: "createPolygon",
    ExtrudedPolygon: "createExtrudedPolygon",
    HeightField: "createHeightField",
    Lathe: "createLathe",
    Tube: "createTube",
    Loft: "createLoft",
  });

  class Repeater {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "Repeater needs a spec");
      const allowed = new Set(["id", "key", "parent", "items"]);
      const unknown = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: Repeater.${unknown}`);
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "Repeater.id or key is required");
      invariant(!runtime.repeaters.has(id), `Repeater '${id}' is already registered`);
      invariant(!runtime.objects.has(id) && !runtime.groups.has(id) && !runtime.materials.has(id),
        `Repeater id '${id}' is already in use`);
      invariant(Array.isArray(spec.items), "Repeater.items must be an array");
      invariant(spec.items.length <= 256, "Repeater.items exceeds the static limit of 256");
      this.runtime = runtime;
      this.id = id;
      this.instances = [];
      this.disposed = false;
      try {
        for (const item of spec.items) {
          invariant(item && typeof item === "object" && !Array.isArray(item),
            "Repeater.items[] must be an object");
          const method = REPEATER_FACTORIES[item.type];
          invariant(method, `Repeater item type '${item.type}' is unsupported`);
          invariant(item.id !== id && item.key !== id,
            `Repeater item id '${id}' conflicts with its owner`);
          const material = item.material;
          invariant(material?.id !== id && material?.key !== id,
            `Repeater material id '${id}' conflicts with its owner`);
          const { type: itemType, material: itemMaterial, ...childSpec } = item;
          void itemType;
          void itemMaterial;
          const child = runtime[method]({
            ...childSpec,
            parent: item.parent ?? spec.parent,
          });
          this.instances.push(child);
          if (material !== undefined) {
            invariant(material && typeof material === "object" && !Array.isArray(material),
              "Repeater.items[].material must be an object");
            runtime.createPrincipledMaterial({
              id: material.id || material.key || `${child.spec.id}/material`,
              ...material,
              target: child,
            });
          }
        }
      } catch (error) {
        for (const child of [...this.instances].reverse()) child.dispose();
        throw error;
      }
      runtime.repeaters.set(id, this);
      Object.freeze(this.instances);
    }

    snapshot() {
      return { id: this.id, instances: this.instances.map((item) => item.spec.id) };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      for (const child of [...this.instances].reverse()) child.dispose();
      this.runtime.repeaters.delete(this.id);
      this.disposed = true;
      return { ok: true, removed: true, idempotent: false };
    }
  }

  // Local-frame camera authoring: ENU metres at the runtime anchor <-> WGS84 geodetic degrees.
  const WGS84_A = 6378137;
  const WGS84_F = 1 / 298.257223563;
  const WGS84_E2 = WGS84_F * (2 - WGS84_F);
  const DEG = Math.PI / 180;
  function geodeticToEcef(lonDeg, latDeg, height) {
    const lon = lonDeg * DEG, lat = latDeg * DEG;
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    return {
      x: (n + height) * cosLat * Math.cos(lon),
      y: (n + height) * cosLat * Math.sin(lon),
      z: (n * (1 - WGS84_E2) + height) * sinLat,
    };
  }
  function ecefToGeodetic({ x, y, z }) {
    const lon = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - WGS84_E2));
    let height = 0;
    for (let i = 0; i < 8; i += 1) {
      const sinLat = Math.sin(lat);
      const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
      height = p / Math.cos(lat) - n;
      lat = Math.atan2(z, p * (1 - WGS84_E2 * n / (n + height)));
    }
    return { longitude: lon / DEG, latitude: lat / DEG, height };
  }
  function enuAxes(anchor) {
    const lon = anchor.lon * DEG, lat = anchor.lat * DEG;
    const sinLon = Math.sin(lon), cosLon = Math.cos(lon), sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    return {
      east: { x: -sinLon, y: cosLon, z: 0 },
      north: { x: -sinLat * cosLon, y: -sinLat * sinLon, z: cosLat },
      up: { x: cosLat * cosLon, y: cosLat * sinLon, z: sinLat },
    };
  }
  function enuToGeodetic(anchor, local) {
    const origin = geodeticToEcef(anchor.lon, anchor.lat, anchor.height);
    const { east, north, up } = enuAxes(anchor);
    return ecefToGeodetic({
      x: origin.x + east.x * local.x + north.x * local.y + up.x * local.z,
      y: origin.y + east.y * local.x + north.y * local.y + up.y * local.z,
      z: origin.z + east.z * local.x + north.z * local.y + up.z * local.z,
    });
  }
  function geodeticToEnu(anchor, longitude, latitude, height) {
    const origin = geodeticToEcef(anchor.lon, anchor.lat, anchor.height);
    const point = geodeticToEcef(longitude, latitude, height);
    const d = { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
    const { east, north, up } = enuAxes(anchor);
    const dot = (a) => a.x * d.x + a.y * d.y + a.z * d.z;
    return { x: dot(east), y: dot(north), z: dot(up) };
  }

  // ---------------------------------------------------------------------------------------------
  // Instancing.  A Prefab freezes one geometry node's built spec plus the material that node's own
  // renderer owns; an Instances batch draws N copies of it in ONE draw call and ONE native object.
  // That is the answer to "950 material nodes for a city": the copies cost instance rows, not nodes.
  // ---------------------------------------------------------------------------------------------
  const PREFAB_MAX_INSTANCES_PER_BATCH = 512;
  const PREFAB_MAX_INSTANCES_PER_PREFAB = 2048;

  function requirePrefabFacadeV2(runtime, field) {
    const facade = runtime.prefabFacade;
    invariant(facade && typeof facade.capabilities === "function"
      && typeof facade.definePrefab === "function" && typeof facade.instantiate === "function",
    `PrefabFacade/v2 is required for ${field}`);
    const capabilities = nativeResult(facade.capabilities(), "PrefabFacade.capabilities");
    invariant(capabilities.facade_version === "PrefabFacade/v2"
      && capabilities.coordinate_system === "right_handed_z_up"
      && Array.isArray(capabilities.placement_modes)
      && capabilities.placement_modes.includes("explicit") && capabilities.placement_modes.includes("grid"),
    "PrefabFacade/v2 does not publish the required instancing capability");
    // Without material_ref every instance renders with a default white material, which makes the
    // feature useless for the textured props it exists to multiply.  Fail closed rather than ship grey.
    invariant(capabilities.material_ref === true,
      "PrefabFacade/v2 does not support material_ref; instances would render with a default material");
    return { facade, capabilities };
  }

  // A Model prefab borrows the glb's own leaf geometry and materials, which only the native side can do.
  // Checked separately from the base capability so a geometry prefab still works against an engine that
  // predates model instancing instead of failing for a feature it does not use.
  function requirePrefabModelSupport(capability) {
    invariant(capability.capabilities.model_ref === true,
      "PrefabFacade/v2 does not support model_ref; this engine cannot instance a Model");
  }

  class Prefab {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "Prefab needs a spec");
      const allowed = new Set(["id", "key", "source"]);
      const unknown = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: Prefab.${unknown}`);
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "Prefab.id or key is required");
      invariant(!runtime.prefabs.has(id), `Prefab '${id}' is already registered`);
      runtime.assertReferenceIdAvailable(id);
      const source = spec.source;
      const fromModel = source instanceof Model;
      invariant((source instanceof SceneObject || fromModel) && !source.disposed && source.runtime === runtime,
        "Prefab.source must be a live geometry node or Model from the same runtime");
      if (fromModel) {
        // The node handle is only set once activation settled, and a staged-but-not-active Model has no
        // leaves for the native walk to find -- the batch would silently draw zero triangles.  Refuse
        // now, while the author can still see why.
        invariant(typeof source.handle === "string" && source.handle.length > 0,
          `Prefab.source Model '${source.id}' is not loaded yet; instance it after its glb has been activated`);
      } else {
        invariant(source.geometrySpec && source.geometrySpec.schema_version === "GeometrySpec/v2",
          "Prefab.source must be a geometry node built from a GeometrySpec, or a loaded Model (Polygon is not a prefab source)");
      }
      const capability = requirePrefabFacadeV2(runtime, "Prefab");
      if (fromModel) requirePrefabModelSupport(capability);
      this.runtime = runtime;
      this.id = id;
      this.source = source;
      this.batches = [];
      this.instanceCount = 0;
      this.disposed = false;
      const geometrySpec = fromModel ? null : source.geometrySpec;
      const definition = {
        schema_version: "PrefabSpec/v2",
        name: id,
        prefab_digest: `sha256:${sha256Text(canonicalJson({ id, spec: geometrySpec ?? { model: source.handle } }))}`,
        ...(fromModel
          // A Model prefab names the live node and the native side borrows its leaves; there is no spec
          // to freeze, because a glb's bytes are not in one.  material_ref stays null: every leaf brings
          // its own material, so one shared material for the whole tree would be meaningless.
          ? { model_ref: { model_node_handle: source.handle }, material_ref: null }
          : {
            geometry_ref: {
              geometry_handle: source.handle,
              spec_digest: `sha256:${sha256Text(canonicalJson(geometrySpec))}`,
              geometry_spec: geometrySpec,
            },
            // The instances share the source node's material, so texturing and colouring a prefab is
            // just texturing and colouring its source.  The material belongs to that node's renderer;
            // the prefab only borrows it.
            material_ref: { material_target_handle: source.handle },
          }),
        intrinsic_transform: { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        budget_hints: {},
      };
      const receipt = nativeResult(capability.facade.definePrefab(JSON.stringify(definition)),
        "PrefabFacade.definePrefab");
      invariant(typeof receipt.prefab_id === "string" && receipt.prefab_id.length > 0,
        "PrefabFacade.definePrefab returned no prefab_id");
      this.handle = receipt.prefab_id;
      this.triangleCount = receipt.triangle_count ?? 0;
      runtime.prefabs.set(id, this);
    }

    snapshot() {
      return {
        id: this.id,
        handle: this.handle,
        component_type: "Prefab",
        source: this.source.spec?.id ?? this.source.id,
        instances: this.instanceCount,
        triangles: this.triangleCount,
      };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.disposed = true;
      this.runtime.prefabs.delete(this.id);
      const facade = this.runtime.prefabFacade;
      if (facade && typeof facade.dispose === "function") {
        return nativeResult(facade.dispose(this.handle), "PrefabFacade.dispose");
      }
      return { ok: true, removed: true };
    }
  }

  class Instances {
    constructor(runtime, spec) {
      invariant(spec && typeof spec === "object", "Instances needs a spec");
      const allowed = new Set(["id", "key", "prefab", "placement", "positions", "origin", "spacing",
        "columns", "count", "seed"]);
      const unknown = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unknown, `member_unsupported: Instances.${unknown}`);
      const id = spec.id || spec.key;
      invariant(typeof id === "string" && id.length > 0, "Instances.id or key is required");
      invariant(!runtime.instanceBatches.has(id), `Instances '${id}' is already registered`);
      runtime.assertReferenceIdAvailable(id);
      const prefab = spec.prefab;
      invariant(prefab instanceof Prefab && !prefab.disposed && prefab.runtime === runtime,
        "Instances.prefab must be a live Prefab from the same runtime");
      const capability = requirePrefabFacadeV2(runtime, "Instances");
      const placement = spec.placement ?? (spec.positions !== undefined ? "explicit" : "grid");
      invariant(placement === "explicit" || placement === "grid",
        'Instances.placement must be "explicit" or "grid"');

      let count;
      let placementRequest;
      if (placement === "explicit") {
        invariant(Array.isArray(spec.positions) && spec.positions.length > 0,
          "Instances.positions must be a non-empty list of [x, y, z] for explicit placement");
        for (const name of ["origin", "spacing", "columns"]) {
          invariant(spec[name] === undefined, `Instances.${name} belongs to grid placement`);
        }
        // vector3_list is the one member the compiler hands over undecoded: decode() only reshapes
        // vector3/quaternion into { x, y, z }, so explicit positions arrive as [[x, y, z], ...] --
        // exactly what the invariant above promises.  Reading them as objects made every explicit batch
        // throw on page load while the compile receipt stayed green.
        const transforms = spec.positions.map((position, index) => ({
          position: meshPoint(position, `Instances.positions[${index}]`),
        }));
        count = transforms.length;
        if (spec.count !== undefined) {
          invariant(spec.count === count,
            "Instances.count must match the number of positions in explicit placement");
        }
        placementRequest = { kind: "explicit", transforms };
      } else {
        invariant(spec.positions === undefined, "Instances.positions belongs to explicit placement");
        invariant(Number.isInteger(spec.count) && spec.count > 0, "Instances.count must be a positive integer");
        count = spec.count;
        const columns = spec.columns ?? count;
        invariant(Number.isInteger(columns) && columns >= 1 && columns <= PREFAB_MAX_INSTANCES_PER_BATCH,
          `Instances.columns must be an integer in 1..${PREFAB_MAX_INSTANCES_PER_BATCH}`);
        const origin = vector3(spec.origin, { x: 0, y: 0, z: 0 }, "Instances.origin");
        const spacing = spec.spacing;
        invariant(Array.isArray(spacing) ? spacing.length === 2
          : (spacing && typeof spacing === "object" && Object.hasOwn(spacing, "x") && Object.hasOwn(spacing, "y")),
        "Instances.spacing must be [dx, dy] or { x, y } metres");
        const [dx, dy] = Array.isArray(spacing) ? spacing : [spacing.x, spacing.y];
        finite(dx, "Instances.spacing.x");
        finite(dy, "Instances.spacing.y");
        invariant(dx > 0 && dy > 0, "Instances.spacing components must be > 0 metres");
        placementRequest = { kind: "grid", origin, spacing: { x: dx, y: dy }, columns };
      }
      invariant(count <= PREFAB_MAX_INSTANCES_PER_BATCH,
        `Instances is limited to ${PREFAB_MAX_INSTANCES_PER_BATCH} instances per batch`);
      invariant(prefab.instanceCount + count <= PREFAB_MAX_INSTANCES_PER_PREFAB,
        `Prefab '${prefab.id}' is limited to ${PREFAB_MAX_INSTANCES_PER_PREFAB} instances`);
      const seed = spec.seed === undefined ? 0 : spec.seed;
      invariant(Number.isInteger(seed) && seed >= 0 && seed <= 4294967295,
        "Instances.seed must be an integer in 0..4294967295");

      const request = {
        count,
        seed,
        placement: placementRequest,
        // Without an anchor the batch is attached to the scene root, i.e. a different world from every
        // other SSDL node.  Pinning the runtime anchor puts instance positions in the same local metre
        // frame the author uses everywhere else.
        anchor: { lon: runtime.anchor.lon, lat: runtime.anchor.lat, height: runtime.anchor.height },
        budget: {},
        allow_clamp: false,
        instance_tags: [],
      };
      const receipt = nativeResult(capability.facade.instantiate(prefab.handle, runtime.scene,
        JSON.stringify(request)), "PrefabFacade.instantiate");
      invariant(typeof receipt.batch_handle === "string" && receipt.batch_handle.length > 0,
        "PrefabFacade.instantiate returned no batch_handle");
      this.runtime = runtime;
      this.id = id;
      this.prefab = prefab;
      this.handle = receipt.batch_handle;
      this.count = count;
      this.placement = placement;
      this.disposed = false;
      prefab.batches.push(this);
      prefab.instanceCount += count;
      runtime.instanceBatches.set(id, this);
    }

    snapshot() {
      return {
        id: this.id,
        handle: this.handle,
        component_type: "Instances",
        prefab: this.prefab.id,
        placement: this.placement,
        count: this.count,
      };
    }

    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.disposed = true;
      this.runtime.instanceBatches.delete(this.id);
      this.prefab.instanceCount -= this.count;
      const facade = this.runtime.prefabFacade;
      if (facade && typeof facade.releaseInstances === "function" && !this.prefab.disposed) {
        return nativeResult(facade.releaseInstances(this.prefab.handle, JSON.stringify({
          batch_handle: this.handle,
          instance_ids: [],
        })), "PrefabFacade.releaseInstances");
      }
      return { ok: true, removed: true };
    }
  }

  class CameraView {
    constructor(runtime, spec) {
      const allowed = new Set(["id", "key", "label", "longitude", "latitude", "height", "duration", "heading", "pitch", "roll",
        "position", "lookAt", "fov", "nearPlane", "farPlane"]);
      const unsupported = Object.keys(spec || {}).find((name) => !allowed.has(name));
      invariant(!unsupported, `CameraView.${unsupported} is unsupported by the Q7 contract`);
      const id = spec?.id || spec?.key;
      invariant(typeof id === "string" && id.length > 0, "CameraView.id or key is required");
      invariant(!runtime.views.has(id), `CameraView '${id}' is already registered`);
      invariant(runtime.views.size < 32, "CameraView budget is limited to 32 per runtime");
      this.runtime = runtime;
      this.id = id;
      this.label = spec.label || id;
      const geographic = spec.longitude !== undefined || spec.latitude !== undefined || spec.height !== undefined;
      if (spec.position !== undefined) {
        // Local ENU metres (x east, y north, z up) relative to the scene anchor, same frame as node positions.
        invariant(!geographic, "CameraView.position (local metres) and longitude/latitude/height are mutually exclusive");
        this.position = vector3(spec.position, null, "CameraView.position");
        const geodetic = enuToGeodetic(runtime.anchor, this.position);
        this.longitude = geodetic.longitude;
        this.latitude = geodetic.latitude;
        this.height = geodetic.height;
      } else {
        invariant(geographic, "CameraView needs either position (local metres) or longitude/latitude/height");
        this.longitude = finite(spec.longitude, "CameraView.longitude");
        this.latitude = finite(spec.latitude, "CameraView.latitude");
        this.height = finite(spec.height, "CameraView.height");
        invariant(this.longitude >= -180 && this.longitude <= 180, "CameraView.longitude must be in -180..180");
        invariant(this.latitude >= -90 && this.latitude <= 90, "CameraView.latitude must be in -90..90");
        this.position = geodeticToEnu(runtime.anchor, this.longitude, this.latitude, this.height);
      }
      this.duration = spec.duration ?? 0;
      invariant(Number.isInteger(this.duration) && this.duration >= 0 && this.duration <= 20000,
        "CameraView.duration must be an integer in 0..20000 ms");
      // Optional orientation in degrees. Without it the view keeps the legacy top-down flight.
      this.oriented = spec.heading !== undefined || spec.pitch !== undefined || spec.roll !== undefined || spec.lookAt !== undefined;
      this.heading = spec.heading === undefined ? 0 : finite(spec.heading, "CameraView.heading");
      this.pitch = spec.pitch === undefined ? -90 : finite(spec.pitch, "CameraView.pitch");
      this.roll = spec.roll === undefined ? 0 : finite(spec.roll, "CameraView.roll");
      this.lookAt = null;
      if (spec.lookAt !== undefined) {
        // Aim point in the same local frame; derives heading (0 = north, clockwise) and pitch (negative = down)
        // unless the author pins them explicitly.
        this.lookAt = vector3(spec.lookAt, null, "CameraView.lookAt");
        const dx = this.lookAt.x - this.position.x, dy = this.lookAt.y - this.position.y, dz = this.lookAt.z - this.position.z;
        const flat = Math.hypot(dx, dy);
        invariant(Math.hypot(flat, dz) > 1e-6, "CameraView.lookAt must differ from the camera position");
        if (spec.heading === undefined) this.heading = flat > 1e-9 ? Math.atan2(dx, dy) / DEG : 0;
        if (spec.pitch === undefined) this.pitch = Math.max(-90, Math.min(90, Math.atan2(dz, flat) / DEG));
      }
      invariant(this.heading >= -360 && this.heading <= 360, "CameraView.heading must be in -360..360 degrees");
      invariant(this.pitch >= -90 && this.pitch <= 90, "CameraView.pitch must be in -90..90 degrees");
      invariant(this.roll >= -180 && this.roll <= 180, "CameraView.roll must be in -180..180 degrees");
      this.fov = spec.fov === undefined ? null : finite(spec.fov, "CameraView.fov");
      invariant(this.fov === null || (this.fov >= 1 && this.fov <= 170), "CameraView.fov must be in 1..170 degrees");
      this.nearPlane = spec.nearPlane === undefined ? null : finite(spec.nearPlane, "CameraView.nearPlane");
      this.farPlane = spec.farPlane === undefined ? null : finite(spec.farPlane, "CameraView.farPlane");
      invariant(this.nearPlane === null || this.nearPlane > 0, "CameraView.nearPlane must be positive metres");
      invariant(this.farPlane === null || this.farPlane > (this.nearPlane ?? 0), "CameraView.farPlane must exceed nearPlane");
      // The pose members are writable (bindable) so a chase camera can be expressed in SSDL alone.
      // authorValues is what the author reads back; position and longitude/latitude/height stay the two
      // faces of one pose and are recomputed from each other on every write.
      this.authorValues = {
        longitude: this.longitude, latitude: this.latitude, height: this.height,
        position: { ...this.position }, heading: this.heading, pitch: this.pitch, roll: this.roll,
        fov: this.fov === null ? 0 : this.fov,
      };
      this.coordinatorKey = `cameraview:${this.id}`;
      runtime.views.set(this.id, this);
    }

    // Writable pose. A write only reaches the camera when this view is the active one, and at most once
    // per frame however many members the batch touched: the frame coordinator collapses the requests.
    applyProperty(property, value) {
      switch (property) {
        case "position": {
          this.position = { x: value.x, y: value.y, z: value.z };
          const geodetic = enuToGeodetic(this.runtime.anchor, this.position);
          this.longitude = geodetic.longitude;
          this.latitude = geodetic.latitude;
          this.height = geodetic.height;
          this.authorValues.longitude = this.longitude;
          this.authorValues.latitude = this.latitude;
          this.authorValues.height = this.height;
          break;
        }
        case "longitude": case "latitude": case "height": {
          this[property] = value;
          this.position = geodeticToEnu(this.runtime.anchor, this.longitude, this.latitude, this.height);
          this.authorValues.position = { ...this.position };
          break;
        }
        case "heading": case "pitch": case "roll":
          this[property] = value;
          this.oriented = true;
          break;
        case "fov":
          this.fov = value;
          break;
        default:
          throw codedError("member_unsupported", `member_unsupported: CameraView.${property}`);
      }
      this.authorValues[property] = value && typeof value === "object" ? { ...value } : value;
      this.scheduleCameraWrite();
      return { ok: true, property };
    }

    scheduleCameraWrite() {
      if (this.runtime.activeView !== this.id) return;
      this.runtime.frameCoordinator.request(this.coordinatorKey, () => this.writeCamera());
    }

    // setView takes RADIANS (flyTo/flyToCartographic are the ones that convert degrees internally);
    // the author surface is degrees everywhere, so the conversion belongs here and nowhere else.
    writeCamera() {
      const camera = this.runtime.scene.mainCamera;
      this.applyProjection(camera);
      const destination = this.runtime.Module.Cartesian3.fromDegrees(this.longitude, this.latitude, this.height);
      try {
        camera.cameraController().setView(destination, this.heading * DEG, this.pitch * DEG, this.roll * DEG);
      } finally {
        if (destination && typeof destination.delete === "function") destination.delete();
      }
      return { ok: true, view: this.id };
    }

    applyProjection(camera) {
      if (this.fov !== null) camera.fieldOfView = this.fov;
      if (this.nearPlane !== null) camera.nearPlane = this.nearPlane;
      if (this.farPlane !== null) camera.farPlane = this.farPlane;
    }

    activate(options = {}) {
      const target = this.runtime.Module.Cartographic.fromDegrees(
        this.longitude,
        this.latitude,
        this.height,
      );
      const duration = options.duration ?? this.duration;
      invariant(Number.isInteger(duration) && duration >= 0 && duration <= 20000,
        "CameraView activation duration must be an integer in 0..20000 ms");
      const camera = this.runtime.scene.mainCamera;
      this.applyProjection(camera);
      const flight = duration === 0 && !this.oriented
        ? camera.flyTo(target)
        : camera.cameraController().flyToCartographic(target, duration / 1000, this.heading, this.pitch, this.roll);
      if (target && typeof target.delete === "function") target.delete();
      this.runtime.activeView = this.id;
      this.runtime.frameCoordinator.cancel(this.coordinatorKey);
      this.runtime.emit("viewchange", { id: this.id, label: this.label, duration });
      return flight;
    }
  }

  class Camera {
    constructor(runtime, spec = {}) {
      const allowed = new Set(["id", "key", "initialView"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `Camera.${unsupported} is unsupported by the Q7 contract`);
      invariant(runtime.camera === null, "only one Camera is allowed per runtime");
      this.runtime = runtime;
      this.id = spec.id || spec.key || "camera";
      this.initialView = spec.initialView || null;
      runtime.camera = this;
    }

    flyTo(view, options) {
      const target = typeof view === "string" ? this.runtime.views.get(view) : view;
      invariant(target instanceof CameraView, "Camera.flyTo needs a registered CameraView");
      return target.activate(options);
    }

    activateInitial(options) {
      invariant(this.initialView, "Camera.initialView is not set");
      return this.flyTo(this.initialView, options);
    }
  }

  class Timer {
    constructor(runtime, spec = {}) {
      const allowed = new Set(["id", "key", "interval", "repeat", "running", "triggeredOnStart", "onTriggered"]);
      const unsupported = Object.keys(spec).find((name) => !allowed.has(name));
      invariant(!unsupported, `member_unsupported: Timer.${unsupported}`);
      invariant(typeof runtime.animationFacade.createTimer === "function",
        "Timer requires the native shared-frame scheduler");
      const interval = spec.interval ?? 1000;
      invariant(Number.isInteger(interval) && interval >= 1,
        "Timer.interval must be an integer >= 1 ms");
      for (const property of ["repeat", "running", "triggeredOnStart"]) {
        invariant(spec[property] === undefined || typeof spec[property] === "boolean",
          `Timer.${property} must be boolean`);
      }
      invariant(spec.onTriggered === undefined || typeof spec.onTriggered === "function",
        "Timer.onTriggered must be a function");
      this.runtime = runtime;
      this.id = spec.id || spec.key || null;
      this.component_type = "Timer";
      runtime.assertReferenceIdAvailable(this.id);
      this.interval = interval;
      this.repeat = spec.repeat ?? false;
      this.running = spec.running ?? false;
      this.triggeredOnStart = spec.triggeredOnStart ?? false;
      this.onTriggered = spec.onTriggered || (() => {});
      this.disposed = false;
      const callback = (raw) => {
        if (this.disposed) return;
        try {
          const event = Object.freeze(JSON.parse(raw));
          if (!this.repeat) {
            this.running = false;
            this.runtime.writeLogical(this, "running", false, {
              write: false, explicit: false, binding: this.runtime.slotKey(this, "running")?.binding,
            });
          }
          this.onTriggered(event);
          this.runtime.emit("timer", event);
        } catch (error) {
          this.runtime.emit("timererror", { timer: this.id, error });
        }
      };
      const receipt = nativeResult(runtime.animationFacade.createTimer(JSON.stringify({
        schema_version: "TimerSpec/v1",
        interval_ms: this.interval,
        repeat: this.repeat,
        running: this.running,
        triggered_on_start: this.triggeredOnStart,
      }), runtime.scene, callback), "AnimationFacade.createTimer");
      this.handle = receipt.timer_handle;
      runtime.timers.set(this.handle, this);
      runtime.registerLogicalSlot(this, "running", this.running);
      runtime.registerLogicalSlot(this, "interval", this.interval);
      runtime.registerLogicalSlot(this, "repeat", this.repeat);
      runtime.registerLogicalSlot(this, "triggeredOnStart", this.triggeredOnStart);
    }

    control(action) {
      invariant(!this.disposed, "Timer is disposed");
      return nativeResult(this.runtime.animationFacade.controlTimer(this.handle, JSON.stringify(action)),
        `AnimationFacade.controlTimer(${action.kind})`);
    }
    start() {
      if (this.running) return { ok: true, timer_handle: this.handle, action: "start", changed: false };
      return this.setRunning(true);
    }
    stop() {
      if (!this.running) return { ok: true, timer_handle: this.handle, action: "stop", changed: false };
      return this.setRunning(false);
    }
    restart() {
      this.runtime.assertLogicalWritable(this, "running");
      const result = this.control({ kind: "restart" });
      this.running = true;
      this.runtime.writeLogical(this, "running", true, { write: false });
      return result;
    }
    setRunning(value) {
      invariant(typeof value === "boolean", "Timer.running must be boolean");
      if (this.running === value) {
        return { ok: true, timer_handle: this.handle, action: value ? "start" : "stop", changed: false };
      }
      return this.runtime.writeLogical(this, "running", value);
    }
    applyRunning(value) {
      const result = this.control({ kind: value ? "start" : "stop" });
      this.running = value;
      return result;
    }
    setInterval(value) {
      invariant(Number.isInteger(value) && value >= 1, "Timer.interval must be an integer >= 1 ms");
      return this.runtime.writeLogical(this, "interval", value);
    }
    applyInterval(value) {
      const result = this.control({ kind: "set_interval", interval_ms: value });
      this.interval = value;
      return result;
    }
    setRepeat(value) {
      invariant(typeof value === "boolean", "Timer.repeat must be boolean");
      return this.runtime.writeLogical(this, "repeat", value);
    }
    applyRepeat(value) {
      const result = this.control({ kind: "set_repeat", repeat: value });
      this.repeat = value;
      return result;
    }
    setTriggeredOnStart(value) {
      invariant(typeof value === "boolean", "Timer.triggeredOnStart must be boolean");
      return this.runtime.writeLogical(this, "triggeredOnStart", value);
    }
    applyTriggeredOnStart(value) {
      const result = this.control({ kind: "set_triggered_on_start", triggered_on_start: value });
      this.triggeredOnStart = value;
      return result;
    }
    describe() {
      invariant(!this.disposed, "Timer is disposed");
      return nativeResult(this.runtime.animationFacade.describeTimer(this.handle), "AnimationFacade.describeTimer");
    }
    dispose() {
      if (this.disposed) return { ok: true, removed: false, idempotent: true };
      this.runtime.disposeTargetDependents(this);
      const result = nativeResult(this.runtime.animationFacade.disposeTimer(this.handle), "AnimationFacade.disposeTimer");
      this.runtime.timers.delete(this.handle);
      this.running = false;
      this.disposed = true;
      this.runtime.disposeOwnerSlots(this);
      return result;
    }
  }

  function eventScreenPoint(root, event) {
    const rect = root.getBoundingClientRect?.() || { left: 0, top: 0, width: root.width, height: root.height };
    invariant(Number.isFinite(rect.width) && rect.width > 0 && Number.isFinite(rect.height) && rect.height > 0,
      "interaction root needs non-zero bounds");
    const scaleX = Number.isFinite(root.width) && root.width > 0 ? root.width / rect.width : 1;
    const scaleY = Number.isFinite(root.height) && root.height > 0 ? root.height / rect.height : 1;
    return {
      x: Math.max(0, Math.round((event.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.round((event.clientY - rect.top) * scaleY)),
    };
  }

  function readonlyPoint(value) {
    return value ? Object.freeze({ x: value.x, y: value.y, z: value.z }) : null;
  }

  function isInteractionTarget(target, runtime) {
    return (target instanceof SceneObject || target instanceof Model)
      && target.runtime === runtime && !target.disposed;
  }

  function interactionSnapshot(runtime, root, event) {
    invariant(runtime.interactionFacade, "InteractionFacade/v1 is unavailable");
    const screen = eventScreenPoint(root, event);
    const picked = nativeResult(runtime.interactionFacade.pick(runtime.scene, screen.x, screen.y),
      "InteractionFacade.pick");
    const target = picked.node_handle
      ? [...runtime.objects.values(), ...runtime.models.values()]
        .find((item) => item.handle === picked.node_handle) || null
      : null;
    return Object.freeze({
      hit: Boolean(picked.hit),
      target: runtime.ownerId(target),
      native_handle: picked.node_handle || null,
      sequence: picked.sequence,
      screen: Object.freeze({ ...screen }),
      point: readonlyPoint(picked.point),
      normal: readonlyPoint(picked.normal),
      distance: picked.distance,
      button: Number.isInteger(event.button) ? event.button : 0,
      modifiers: Object.freeze({
        alt: Boolean(event.altKey), control: Boolean(event.ctrlKey),
        meta: Boolean(event.metaKey), shift: Boolean(event.shiftKey),
      }),
    });
  }

  class TapHandler {
    constructor(runtime, spec) {
      invariant(spec && spec.root && typeof spec.root.addEventListener === "function", "TapHandler.root is required");
      const unsupported = Object.keys(spec).find((name) =>
        !["id", "key", "root", "target", "enabled", "onTapped", "onTap"].includes(name));
      invariant(!unsupported, `member_unsupported: TapHandler.${unsupported}`);
      const callback = spec.onTapped || spec.onTap;
      invariant(typeof callback === "function", "TapHandler.onTapped is required");
      invariant(spec.target === undefined || isInteractionTarget(spec.target, runtime),
        "TapHandler.target must be a live SceneObject or Model from the same runtime");
      invariant(runtime.interactionFacade, "InteractionFacade/v1 is unavailable");
      invariant(spec.enabled === undefined || typeof spec.enabled === "boolean",
        "TapHandler.enabled must be boolean");
      this.runtime = runtime;
      this.id = spec.id || spec.key || null;
      this.component_type = "TapHandler";
      runtime.assertReferenceIdAvailable(this.id);
      this.root = spec.root;
      this.target = spec.target || null;
      this.onTapped = callback;
      this.enabled = spec.enabled !== false;
      this.disposed = false;
      this.listener = (event) => {
        if (this.disposed || !this.enabled || this.target?.disposed) return;
        const snapshot = interactionSnapshot(runtime, this.root, event);
        if (!snapshot.hit || (this.target && snapshot.native_handle !== this.target.handle)) return;
        this.onTapped(snapshot, snapshot.button);
      };
      // A tap is a completed click, not every pointer release (which also
      // includes drags). Capture first so Qt canvas handling cannot hide it.
      this.root.addEventListener("click", this.listener, true);
      runtime.tapHandlers.add(this);
      runtime.registerLogicalSlot(this, "enabled", this.enabled);
      if (this.target) runtime.registerTargetDependent(this.target, this);
    }

    setEnabled(value) {
      invariant(!this.disposed, "TapHandler is disposed");
      invariant(typeof value === "boolean", "TapHandler.enabled must be boolean");
      if (this.enabled === value) return { ok: true, changed: false, enabled: value };
      return this.runtime.writeLogical(this, "enabled", value);
    }

    applyEnabled(value) {
      this.enabled = value;
      return { ok: true, changed: true, enabled: value };
    }

    dispose() {
      if (this.disposed) return;
      this.runtime.disposeTargetDependents(this);
      this.disposed = true;
      this.enabled = false;
      this.root.removeEventListener("click", this.listener, true);
      this.runtime.tapHandlers.delete(this);
      this.runtime.unregisterTargetDependent(this);
      this.runtime.disposeOwnerSlots(this);
    }
  }

  class HoverHandler {
    constructor(runtime, spec) {
      invariant(spec && spec.root && typeof spec.root.addEventListener === "function", "HoverHandler.root is required");
      const unsupported = Object.keys(spec).find((name) =>
        !["id", "key", "root", "target", "enabled", "onHoveredChanged"].includes(name));
      invariant(!unsupported, `member_unsupported: HoverHandler.${unsupported}`);
      invariant(typeof spec.onHoveredChanged === "function", "HoverHandler.onHoveredChanged is required");
      invariant(spec.target === undefined || isInteractionTarget(spec.target, runtime),
        "HoverHandler.target must be a live SceneObject or Model from the same runtime");
      invariant(runtime.interactionFacade, "InteractionFacade/v1 is unavailable");
      invariant(spec.enabled === undefined || typeof spec.enabled === "boolean",
        "HoverHandler.enabled must be boolean");
      this.runtime = runtime;
      this.id = spec.id || spec.key || null;
      this.component_type = "HoverHandler";
      runtime.assertReferenceIdAvailable(this.id);
      this.root = spec.root;
      this.target = spec.target || null;
      this.onHoveredChanged = spec.onHoveredChanged;
      this.enabled = spec.enabled !== false;
      this.disposed = false;
      this.hovered = false;
      this.point = null;
      this.moveListener = (event) => {
        if (this.disposed) return;
        if (this.target?.disposed) {
          this.hovered = false;
          this.point = null;
          return;
        }
        if (!this.enabled) return this.update(false, null);
        const snapshot = interactionSnapshot(runtime, this.root, event);
        const hovered = snapshot.hit && (!this.target || snapshot.native_handle === this.target.handle);
        this.update(hovered, hovered ? snapshot : null);
      };
      this.leaveListener = () => this.update(false, null);
      this.root.addEventListener("pointermove", this.moveListener, true);
      this.root.addEventListener("pointerleave", this.leaveListener, true);
      runtime.hoverHandlers.add(this);
      runtime.registerLogicalSlot(this, "enabled", this.enabled);
      runtime.registerLogicalSlot(this, "hovered", this.hovered, { explicit: false });
      if (this.target) runtime.registerTargetDependent(this.target, this);
    }

    update(hovered, snapshot) {
      if (this.disposed || this.target?.disposed) return;
      const changed = this.hovered !== hovered;
      this.hovered = hovered;
      this.point = snapshot?.point || null;
      if (changed) {
        this.runtime.writeLogical(this, "hovered", hovered, {
          write: false, explicit: false,
        });
        this.onHoveredChanged(Object.freeze({ hovered, point: this.point, eventPoint: snapshot }));
      }
    }

    setEnabled(value) {
      invariant(!this.disposed, "HoverHandler is disposed");
      invariant(typeof value === "boolean", "HoverHandler.enabled must be boolean");
      if (this.enabled === value) return { ok: true, changed: false, enabled: value };
      return this.runtime.writeLogical(this, "enabled", value);
    }

    applyEnabled(value) {
      this.enabled = value;
      if (!this.enabled) this.update(false, null);
      return { ok: true, changed: true, enabled: value };
    }

    dispose() {
      if (this.disposed) return;
      this.runtime.disposeTargetDependents(this);
      this.disposed = true;
      this.enabled = false;
      this.hovered = false;
      this.point = null;
      this.root.removeEventListener("pointermove", this.moveListener, true);
      this.root.removeEventListener("pointerleave", this.leaveListener, true);
      this.runtime.hoverHandlers.delete(this);
      this.runtime.unregisterTargetDependent(this);
      this.runtime.disposeOwnerSlots(this);
    }
  }

  // Keyboard is the one input a game cannot fake with picking. It listens on the window rather than
  // the canvas because the WebGPU canvas is not focusable by default, so a canvas-scoped keydown only
  // arrives after the player happens to click it — which reads as "the controls randomly do nothing".
  class KeyHandler {
    constructor(runtime, spec) {
      invariant(spec && spec.root && typeof spec.root.addEventListener === "function", "KeyHandler.root is required");
      const unsupported = Object.keys(spec).find((name) =>
        !["id", "key", "root", "enabled", "autoRepeat", "onPressed", "onReleased"].includes(name));
      invariant(!unsupported, `member_unsupported: KeyHandler.${unsupported}`);
      // Everywhere else in this runtime `key` is an alias for `id`; on KeyHandler it is the keyboard
      // key, so the id comes from `id` alone and `key` is never read as one.
      const keyName = spec.key;
      invariant(typeof keyName === "string" && keyName.length > 0, "KeyHandler.key is required");
      invariant(spec.enabled === undefined || typeof spec.enabled === "boolean", "KeyHandler.enabled must be boolean");
      invariant(spec.autoRepeat === undefined || typeof spec.autoRepeat === "boolean", "KeyHandler.autoRepeat must be boolean");
      for (const signal of ["onPressed", "onReleased"]) {
        invariant(spec[signal] === undefined || typeof spec[signal] === "function", `KeyHandler.${signal} must be a function`);
      }
      this.runtime = runtime;
      this.id = spec.id || null;
      this.component_type = "KeyHandler";
      runtime.assertReferenceIdAvailable(this.id);
      this.root = spec.root;
      this.keyName = keyName;
      // "w" and "W" are the same control; " " is the space bar. Matching is case-insensitive so the
      // author does not have to think about whether shift is down.
      this.match = keyName.length === 1 ? keyName.toLowerCase() : keyName;
      this.enabled = spec.enabled !== false;
      this.autoRepeat = spec.autoRepeat === true;
      this.onPressed = spec.onPressed || (() => {});
      this.onReleased = spec.onReleased || (() => {});
      this.pressed = false;
      this.disposed = false;
      this.view = this.root.ownerDocument?.defaultView || globalThis;
      const matches = (event) => {
        const key = typeof event.key === "string" ? event.key : "";
        return (key.length === 1 ? key.toLowerCase() : key) === this.match;
      };
      this.downListener = (event) => {
        if (this.disposed || !this.enabled || !matches(event)) return;
        // Arrows, space and the like scroll the page; a scene that has claimed the key must not also
        // move the document under the player.
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (event.repeat && !this.autoRepeat) return;
        if (this.pressed && !this.autoRepeat) return;
        this.setPressed(true);
        this.onPressed(Object.freeze({ key: this.keyName, repeat: Boolean(event.repeat) }));
      };
      this.upListener = (event) => {
        if (this.disposed || !matches(event)) return;
        if (!this.pressed) return;
        this.setPressed(false);
        this.onReleased(Object.freeze({ key: this.keyName, repeat: false }));
      };
      // Alt-tabbing away never delivers the keyup, so without this the throttle stays stuck on.
      this.blurListener = () => { if (this.pressed) { this.setPressed(false); this.onReleased(Object.freeze({ key: this.keyName, repeat: false })); } };
      this.view.addEventListener("keydown", this.downListener, true);
      this.view.addEventListener("keyup", this.upListener, true);
      this.view.addEventListener("blur", this.blurListener, true);
      runtime.keyHandlers.add(this);
      runtime.registerLogicalSlot(this, "enabled", this.enabled);
      runtime.registerLogicalSlot(this, "pressed", this.pressed, { explicit: false });
    }

    setPressed(pressed) {
      if (this.pressed === pressed) return;
      this.pressed = pressed;
      this.runtime.writeLogical(this, "pressed", pressed, { write: false, explicit: false });
    }

    setEnabled(value) {
      invariant(!this.disposed, "KeyHandler is disposed");
      invariant(typeof value === "boolean", "KeyHandler.enabled must be boolean");
      if (this.enabled === value) return { ok: true, changed: false, enabled: value };
      return this.runtime.writeLogical(this, "enabled", value);
    }

    applyEnabled(value) {
      this.enabled = value;
      if (!this.enabled && this.pressed) this.setPressed(false);
      return { ok: true, changed: true, enabled: value };
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.enabled = false;
      this.pressed = false;
      this.view.removeEventListener("keydown", this.downListener, true);
      this.view.removeEventListener("keyup", this.upListener, true);
      this.view.removeEventListener("blur", this.blurListener, true);
      this.runtime.keyHandlers.delete(this);
      this.runtime.disposeOwnerSlots(this);
    }
  }

  // Page-shell actions are intentionally separate from SSDL TapHandler. They
  // operate on DOM data attributes and never claim to be a 3D picking event.
  class ActionHandler {
    constructor(runtime, spec) {
      invariant(spec && spec.root && typeof spec.root.addEventListener === "function", "ActionHandler.root is required");
      invariant(typeof spec.onAction === "function", "ActionHandler.onAction is required");
      this.runtime = runtime;
      this.root = spec.root;
      this.attribute = spec.attribute || "action";
      this.onAction = spec.onAction;
      this.listener = (event) => {
        const source = event.target?.closest?.(`[data-${this.attribute}]`);
        if (!source || !this.root.contains(source)) return;
        this.onAction(Object.freeze({
          action: source.dataset[this.attribute],
          pointer: Object.freeze({ x: event.clientX, y: event.clientY }),
        }));
      };
      this.root.addEventListener("click", this.listener);
      runtime.actionHandlers.add(this);
    }

    dispose() {
      this.root.removeEventListener("click", this.listener);
      this.runtime.actionHandlers.delete(this);
    }
  }

  class LogicalPropertyBag {
    constructor(runtime, spec = {}) {
      invariant(typeof spec.id === "string" && spec.id.length > 0,
        "LogicalPropertyBag.id is required");
      invariant(spec.properties && typeof spec.properties === "object" && !Array.isArray(spec.properties),
        "LogicalPropertyBag.properties is required");
      this.runtime = runtime;
      this.id = spec.id;
      this.component_type = "LogicalPropertyBag";
      this.values = Object.create(null);
      this.descriptors = new Map();
      this.disposed = false;
      runtime.assertReferenceIdAvailable(this.id);
      for (const [name, descriptor] of Object.entries(spec.properties)) {
        invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), "LogicalPropertyBag property name is invalid");
        invariant(descriptor && ["boolean", "scalar", "string", "color", "vector3"].includes(descriptor.value_type),
          `LogicalPropertyBag.${name} has an unsupported value_type`);
        const normalized = {
          kind: "member",
          value_type: descriptor.value_type,
          unit: descriptor.unit ?? null,
          length: descriptor.value_type === "vector3" ? 3 : 1,
          divisor: descriptor.divisor || (["scalar", "vector3"].includes(descriptor.value_type) ? 1e6 : 1),
        };
        this.descriptors.set(name, normalized);
        this.values[name] = cloneLogical(descriptor.value);
        runtime.registerLogicalSlot(this, name, descriptor.value);
      }
      runtime.propertyBags.set(this.id, this);
    }

    apply(name, value) {
      this.values[name] = cloneLogical(value);
      return { ok: true, changed: true, property: name, value: cloneLogical(value) };
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.runtime.propertyBags.delete(this.id);
      this.runtime.disposeOwnerSlots(this);
    }
  }

  function memberLogicalDescriptor(owner, property) {
    const boolean = (write) => ({
      kind: "member", value_type: "boolean", unit: null, length: 1, divisor: 1, write,
    });
    const scalar = (unit, divisor, write, validate) => ({
      kind: "member", value_type: "scalar", unit, length: 1, divisor, write, validate,
    });
    const string = (write, validate) => ({
      kind: "member", value_type: "string", unit: null, length: 1, divisor: 1, write, validate,
    });
    if (owner instanceof LogicalPropertyBag) {
      const descriptor = owner.descriptors.get(property);
      if (!descriptor) throw codedError("member_unsupported",
        `member_unsupported: LogicalPropertyBag.${property}`);
      return {
        ...descriptor,
        write: (value) => owner.apply(property, value),
        read: () => owner.values[property],
      };
    }
    if (owner instanceof Group || owner instanceof GeoAnchor) {
      if (property === "visible") {
        return boolean((value) => owner.applyVisible(value));
      }
      if (!["transform.position", "transform.rotation", "transform.scale"].includes(property)) {
        throw codedError("member_unsupported",
          `member_unsupported: ${owner.component_type}.${property}`);
      }
      const member = property.slice(10);
      return {
        ...nativeLogicalDescriptor(property),
        kind: "member",
        write: (value) => owner.applyTransformProperty(property, value),
        read: () => owner.transform[member],
      };
    }
    if (owner instanceof NativeTimelineAnimation) {
      if (property === "running") return boolean(value => owner.setRunning(value));
      if (property === "paused") return boolean(value => owner.setPaused(value));
      if (property === "loops") return scalar("scalar", 1e6, value => owner.setLoops(value));
    }
    if (owner instanceof PrincipledMaterial) {
      const mapping = { baseColor: ["setBaseColor", "color"], opacity: ["setOpacity", "scalar"],
        metalness: ["setMetalness", "scalar"], roughness: ["setRoughness", "scalar"],
        normalScale: ["setNormalScale", "scalar"] };
      const entry = mapping[property];
      invariant(entry, `member_unsupported: PrincipledMaterial.${property}`);
      return { kind:"member", value_type:entry[1], unit:entry[1] === "scalar" ? "scalar" : null,
        divisor:entry[1] === "scalar" ? 1e6 : 1, length:1,
        read: () => owner.values.get(property),
        write: value => { owner[entry[0]](value); return { ok:true, property }; } };
    }
    if (owner instanceof Timer) {
      if (property === "running") return boolean((value) => owner.applyRunning(value));
      if (property === "repeat") return boolean((value) => owner.applyRepeat(value));
      if (property === "triggeredOnStart") {
        return boolean((value) => owner.applyTriggeredOnStart(value));
      }
      // 1e6 like every other scalar slot: the 0.3 compiler emits one fixed-point lane and the frozen
      // interpreter divides by 1e6 unconditionally, so a divisor of 1 here made `interval: 100 * 5` fold
      // to 0 while `interval: 500` stayed right.
      if (property === "interval") return scalar("ms", 1e6, (value) => owner.applyInterval(value),
        (value, field) => invariant(Number.isInteger(value) && value >= 1, `${field} must be an integer >= 1 ms`));
    }
    if (owner instanceof Behavior && property === "enabled") {
      return boolean((value) => owner.applyEnabled(value));
    }
    if (owner instanceof Binding && property === "when") {
      return boolean((value) => owner.applyWhen(value));
    }
    if (owner instanceof State && property === "when") {
      return boolean((value) => owner.applyWhen(value));
    }
    if ((owner instanceof TapHandler || owner instanceof HoverHandler || owner instanceof KeyHandler) && property === "enabled") {
      return boolean((value) => owner.applyEnabled(value));
    }
    if (owner instanceof KeyHandler && property === "pressed") {
      return {
        ...boolean(() => {
          throw codedError("member_readonly", "member_readonly: KeyHandler.pressed");
        }),
        writable: false,
        read: () => owner.pressed,
      };
    }
    if (owner instanceof HoverHandler && property === "hovered") {
      return {
        ...boolean(() => {
          throw codedError("member_readonly", "member_readonly: HoverHandler.hovered");
        }),
        writable: false,
        read: () => owner.hovered,
      };
    }
    if (owner instanceof Label) {
      if (property === "text") return string((value) => owner.applyText(value),
        (value, field) => invariant(value.length <= 4096, `${field} must be at most 4096 characters`));
      if (property === "visible") return boolean((value) => owner.applyVisible(value));
    }
    if (owner instanceof EnvironmentComponent) {
      return {
        ...environmentMemberValueDescriptor(owner.type, property),
        write: (value) => owner.applyProperty(property, value),
        read: () => owner.authorValues[property],
      };
    }
    if (owner instanceof SunSky) {
      return {
        ...sunSkyMemberValueDescriptor(property),
        write: (value) => owner.applyProperty(property, value),
        read: () => owner.authorValues[property],
      };
    }
    if (owner instanceof CameraView) {
      return {
        ...cameraViewMemberValueDescriptor(property),
        write: (value) => owner.applyProperty(property, value),
        read: () => owner.authorValues[property],
      };
    }
    if (owner instanceof PostProcessVolume) {
      return {
        ...postProcessMemberValueDescriptor(property),
        write: (value) => owner.applyProperty(property, value),
        read: () => property.startsWith("settings.")
          ? owner.authorSettings[property.slice(9)] : owner.authorValues[property],
      };
    }
    throw codedError("member_unsupported",
      `member_unsupported: ${owner?.component_type || owner?.constructor?.name || "BindingTarget"}.${property}`);
  }

  function componentLogicalDescriptor(owner, property) {
    if (owner instanceof SceneObject || owner instanceof Model) return nativeLogicalDescriptor(property);
    return memberLogicalDescriptor(owner, property);
  }

  class FrameCoordinator {
    constructor(queueMicrotask = globalThis.queueMicrotask?.bind(globalThis)
      || ((callback) => Promise.resolve().then(callback))) {
      this.queueMicrotask = queueMicrotask;
      this.pending = new Map();
      this.queued = false;
      this.sequence = 0;
    }

    request(key, callback) {
      this.pending.set(key, callback);
      if (this.queued) return;
      this.queued = true;
      this.queueMicrotask(() => this.flush());
    }

    cancel(key) { this.pending.delete(key); }

    flush() {
      this.queued = false;
      const tasks = [...this.pending.entries()];
      this.pending.clear();
      const results = [];
      for (const [key, callback] of tasks) results.push({ key, result: callback() });
      return Object.freeze({
        schema_version: "FrameCoordinatorReceipt/1",
        batch_id: ++this.sequence,
        tasks: results,
      });
    }
  }

  class BuiltinRuntime {
    constructor(options) {
      invariant(options && options.Module && options.viewer, "createRuntime needs Module and viewer");
      const Module = options.Module;
      invariant(typeof Module.GeometryFacade === "function", "GeometryFacade/v2 is unavailable");
      invariant(typeof Module.AnimationFacade === "function", "AnimationFacade/v2 is unavailable");
      invariant(typeof Module.SceneGraphFacade === "function", "SceneGraphFacade/v2 is unavailable");
      this.Module = Module;
      this.builtinCatalog = catalogProjection?.catalog || null;
      this.nativeIdPrefix = `runtime-${++runtimeSequence}`;
      this.viewer = options.viewer;
      this.scene = options.viewer.scene;
      this.anchor = Object.freeze({ ...(options.anchor || { lon: 114.05, lat: 22.55, height: 120 }) });
      this.geometryFacade = new Module.GeometryFacade();
      this.animationFacade = new Module.AnimationFacade();
      const animationCapabilities = nativeResult(this.animationFacade.capabilities(), "AnimationFacade.capabilities");
      this.catalogDigest = catalogProjection?.digest || animationCapabilities.builtin_catalog_digest || null;
      this.runtimeAbiDigest = catalogProjection?.runtime_abi_digest
        || animationCapabilities.scene_module_runtime_abi_digest || null;
      this.runtimeAvailable = catalogProjection?.runtime_available === true
        && animationCapabilities.ssdl_runtime_available === true;
      this.nativePropertyBatchAvailable = animationCapabilities.property_bridge === "PropertyBridge/v1"
        && typeof this.animationFacade.captureBatch === "function"
        && typeof this.animationFacade.writeBatch === "function"
        && typeof this.animationFacade.restoreBatch === "function"
        && typeof this.animationFacade.releaseCapture === "function";
      this.sceneGraphFacade = new Module.SceneGraphFacade();
      this.interactionFacade = typeof Module.InteractionFacade === "function"
        ? new Module.InteractionFacade()
        : null;
      this.labelFacade = typeof Module.LabelFacade === "function" ? new Module.LabelFacade() : null;
      this.materialFacade = typeof Module.MaterialFacade === "function" ? new Module.MaterialFacade() : null;
      this.modelFacade = typeof Module.SSDLSceneFacade === "function" ? new Module.SSDLSceneFacade() : null;
      this.prefabFacade = typeof Module.PrefabFacade === "function" ? new Module.PrefabFacade() : null;
      this.environmentFacade = typeof Module.EnvironmentFacade === "function" ? new Module.EnvironmentFacade() : null;
      this.postProcessLease = acquirePostProcessFacade(this.viewer, Module.PostProcessFacade);
      this.postProcessFacade = this.postProcessLease.facade;
      this.expressionEvaluate = typeof options.expressionRuntime === "function"
        ? options.expressionRuntime
        : typeof options.expressionRuntime?.evaluate === "function"
          ? options.expressionRuntime.evaluate.bind(options.expressionRuntime)
          : null;
      this.resolveManagedAsset = options.resolveManagedAsset || null;
      this.modelScopeId = options.modelScopeId || "ssdl-builtins-models";
      invariant(typeof this.modelScopeId === "string" && this.modelScopeId.length > 0,
        "modelScopeId must be a non-empty string");
      this.modelReadyFrames = Number.isSafeInteger(options.modelReadyFrames) && options.modelReadyFrames > 0
        ? options.modelReadyFrames : 600;
      this.resolvedCalendarYear = options.resolvedCalendarYear ?? null;
      this.nextModelFrame = options.nextModelFrame || (() => new Promise((resolve) => {
        if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(() => resolve());
        else this.setTimeout(resolve, 0);
      }));
      this.objects = new Map();
      this.groups = new Map();
      this.labels = new Map();
      this.models = new Map();
      this.textures = new Map();
      this.modelReservations = new Set();
      this.modelIncarnations = new Map();
      this.environmentComponents = new Map();
      this.sunSkies = new Map();
      this.postProcessVolumes = new Map();
      this.materials = new Map();
      this.prefabs = new Map();
      this.instanceBatches = new Map();
      this.repeaters = new Map();
      this.propertyBags = new Map();
      this.animations = new Map();
      this.drivers = new Map();
      this.behaviors = new Set();
      this.bindings = new Map();
      this.bindingSequence = 0;
      this.slotSequence = 0;
      this.slotMaps = new WeakMap();
      this.slots = new Set();
      this.slotsByReference = new Map();
      this.referenceOwners = new Map();
      this.dirtySlots = new Set();
      this.pendingBindings = new Set();
      this.bindingFlushQueued = false;
      this.bindingFlushActive = false;
      this.queueMicrotask = options.queueMicrotask || globalThis.queueMicrotask?.bind(globalThis)
        || ((callback) => Promise.resolve().then(callback));
      this.frameCoordinator = options.frameCoordinator || new FrameCoordinator(this.queueMicrotask);
      this.bindingCoordinatorKey = `${this.modelScopeId}:binding-runtime`;
      this.stateControllers = new Map();
      this.timers = new Map();
      this.views = new Map();
      this.tapHandlers = new Set();
      this.hoverHandlers = new Set();
      this.keyHandlers = new Set();
      this.actionHandlers = new Set();
      this.listeners = new Map();
      this.targetDependents = new WeakMap();
      this.dependentTargets = new WeakMap();
      this.sceneRoot = null;
      this.activeView = null;
      this.camera = null;
      this.setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
      const locator = nativeResult(this.sceneGraphFacade.createLocator(this.scene, JSON.stringify({
        anchor: this.anchor,
        parent: null,
        transform: {},
      })), "SceneGraphFacade.createLocator");
      this.locatorHandle = locator.locator_handle;
      this.disposed = false;
    }

    capabilities() {
      return {
        schema_version: SCHEMA_VERSION,
        components: COMPONENT_TYPES.slice(),
        coordinate_system: "right_handed_z_up",
        builtin_catalog_digest: this.catalogDigest,
        scene_module_runtime_abi_digest: this.runtimeAbiDigest,
        runtime_available: this.runtimeAvailable,
        native: {
          geometry: nativeResult(this.geometryFacade.capabilities(), "GeometryFacade.capabilities"),
          animation: nativeResult(this.animationFacade.capabilities(), "AnimationFacade.capabilities"),
          scene_graph: nativeResult(this.sceneGraphFacade.capabilities(), "SceneGraphFacade.capabilities"),
          interaction: this.interactionFacade
            ? nativeResult(this.interactionFacade.capabilities(), "InteractionFacade.capabilities")
            : null,
          label: this.labelFacade ? nativeResult(this.labelFacade.capabilities(), "LabelFacade.capabilities") : null,
          material: this.materialFacade
            ? nativeResult(this.materialFacade.capabilities(), "MaterialFacade.capabilities") : null,
          model: this.modelFacade ? nativeResult(this.modelFacade.capabilities(), "SSDLSceneFacade.capabilities") : null,
          environment: this.environmentFacade
            ? nativeResult(this.environmentFacade.capabilities(), "EnvironmentFacade.capabilities") : null,
          post_process: this.postProcessFacade
            ? nativeResult(this.postProcessFacade.capabilities(), "PostProcessFacade.capabilities") : null,
        },
        property_bridge: this.nativePropertyBatchAvailable ? "PropertyBridge/v1" : "legacy_property_writes",
      };
    }

    on(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
      return () => this.listeners.get(type)?.delete(listener);
    }

    emit(type, detail) {
      for (const listener of this.listeners.get(type) || []) listener(detail);
    }

    registerTargetDependent(owner, dependent) {
      invariant(owner && owner.runtime === this && owner.disposed !== true,
        "dependent target must be a live component from the same runtime");
      let dependents = this.targetDependents.get(owner);
      if (!dependents) {
        dependents = new Set();
        this.targetDependents.set(owner, dependents);
      }
      dependents.add(dependent);
      let targets = this.dependentTargets.get(dependent);
      if (!targets) {
        targets = new Set();
        this.dependentTargets.set(dependent, targets);
      }
      targets.add(owner);
    }

    unregisterTargetDependent(dependent) {
      const targets = this.dependentTargets.get(dependent);
      if (!targets) return;
      for (const owner of targets) this.targetDependents.get(owner)?.delete(dependent);
      targets.clear();
      this.dependentTargets.delete(dependent);
    }

    disposeTargetDependents(owner) {
      const dependents = [...(this.targetDependents.get(owner) || [])];
      for (const dependent of dependents) dependent.dispose();
      this.targetDependents.delete(owner);
    }

    ownerId(owner) {
      return owner?.id || owner?.spec?.id || null;
    }

    assertReferenceIdAvailable(id, owner = null) {
      if (typeof id !== "string" || id.length === 0) return;
      const existing = this.referenceOwners.get(id);
      const ownsModelReservation = owner instanceof Model && owner.id === id;
      if ((existing && existing !== owner) || (this.modelReservations.has(id) && !ownsModelReservation)) {
        throw codedError("ambiguous_property_reference",
          `ambiguous_property_reference: component id '${id}' is already in use`);
      }
    }

    slotKey(owner, property) {
      let map = this.slotMaps.get(owner);
      if (!map) {
        map = new Map();
        this.slotMaps.set(owner, map);
      }
      return map.get(property) || null;
    }

    registerLogicalSlot(owner, property, value, options = {}) {
      const descriptor = componentLogicalDescriptor(owner, property);
      if (descriptor.kind === "native") propertyTarget(owner, this);
      let slot = this.slotKey(owner, property);
      const normalized = normalizeLogical(descriptor, value,
        `${owner.component_type || "SceneObject"}.${property}`);
      if (slot) {
        slot.value = cloneLogical(normalized);
        slot.valid = true;
        if (options.explicit !== false) slot.explicitValue = cloneLogical(normalized);
        return slot;
      }
      const id = this.ownerId(owner);
      const referenceKey = typeof id === "string" && id.length > 0 ? `${id}\u0000${property}` : null;
      if (referenceKey) {
        this.assertReferenceIdAvailable(id, owner);
        invariant(!this.slotsByReference.has(referenceKey),
          `ambiguous_property_reference: '${id}.${property}'`);
        this.referenceOwners.set(id, owner);
      }
      slot = {
        key: `slot-${++this.slotSequence}`,
        owner,
        property,
        descriptor,
        value: cloneLogical(normalized),
        explicitValue: options.explicit === false ? undefined : cloneLogical(normalized),
        version: 0,
        valid: true,
        binding: null,
        behavior: null,
        dependents: new Set(),
        removed: false,
      };
      this.slotMaps.get(owner).set(property, slot);
      this.slots.add(slot);
      if (referenceKey) this.slotsByReference.set(referenceKey, slot);
      return slot;
    }

    registerNativeSlot(owner, property, value, options = {}) {
      const descriptor = componentLogicalDescriptor(owner, property);
      invariant(descriptor.kind === "native", `${property} is not a native logical property`);
      return this.registerLogicalSlot(owner, property, value, options);
    }

    ensureLogicalSlot(owner, property) {
      const existing = this.slotKey(owner, property);
      if (existing) return existing;
      const descriptor = componentLogicalDescriptor(owner, property);
      if (descriptor.kind === "native") {
        propertyTarget(owner, this);
        const receipt = readNativeProperty(this, owner, property);
        return this.registerLogicalSlot(owner, property,
          normalizeLogical(descriptor, authorValue(property, receipt.value), `Binding.${property}`));
      }
      const value = descriptor.read ? descriptor.read() : owner[property];
      if (value === undefined) {
        throw codedError("unknown_reference",
          `unknown_reference: '${this.ownerId(owner) || owner.component_type}.${property}' has no logical value`);
      }
      return this.registerLogicalSlot(owner, property, value);
    }

    ensureNativeSlot(owner, property) {
      const slot = this.ensureLogicalSlot(owner, property);
      invariant(slot.descriptor.kind === "native", `${property} is not a native logical property`);
      return slot;
    }

    slotByReference(ownerId, property) {
      return this.slotsByReference.get(`${ownerId}\u0000${property}`) || null;
    }

    assertLogicalWritable(owner, property) {
      const slot = this.ensureLogicalSlot(owner, property);
      if (slot.binding?.when && !slot.binding.disposed) {
        throw codedError("property_bound",
          `property_bound: '${this.ownerId(owner)}.${property}' is controlled by Binding '${slot.binding.id}'`);
      }
      return slot;
    }

    markSlotChanged(slot) {
      this.dirtySlots.add(slot);
      if (!this.bindingFlushActive) this.scheduleBindingFlush();
    }

    writeLogical(owner, property, value, options = {}) {
      const slot = this.ensureLogicalSlot(owner, property);
      if (slot.removed) throw codedError("unknown_reference");
      if (options.write !== false && slot.descriptor.writable === false) {
        throw codedError("member_readonly",
          `member_readonly: '${this.ownerId(owner)}.${property}'`);
      }
      if (slot.binding?.when && slot.binding !== options.binding && !slot.binding.disposed) {
        throw codedError("property_bound",
          `property_bound: '${this.ownerId(owner)}.${property}' is controlled by Binding '${slot.binding.id}'`);
      }
      const normalized = normalizeLogical(slot.descriptor, value,
        `${owner.component_type || "SceneObject"}.${property}`);
      if (options.skipIfSame && slot.valid && logicalEqual(slot.value, normalized)) {
        return { ok: true, changed: false, property, value: cloneLogical(normalized) };
      }
      let receipt = { ok: true, changed: true, property };
      if (options.write !== false) {
        if (!options.direct && slot.behavior && !slot.behavior.disposed) {
          receipt = slot.behavior.presentLogical(normalized, options.previousMotion);
        } else if (slot.descriptor.kind === "member") {
          receipt = slot.descriptor.write(normalized);
        } else if (options.wireValue !== undefined) {
          receipt = writeNativeWireProperty(this, owner, property, options.wireValue);
        } else {
          receipt = writeNativeProperty(this, owner, property, normalized);
        }
      }
      slot.value = cloneLogical(normalized);
      slot.valid = true;
      slot.version += 1;
      if (options.explicit !== false) slot.explicitValue = cloneLogical(normalized);
      if (options.propagate !== false) this.markSlotChanged(slot);
      return receipt;
    }

    restoreSlotExplicitValue(slot) {
      if (slot.removed || slot.explicitValue === undefined) return null;
      return this.writeLogical(slot.owner, slot.property, slot.explicitValue, {
        direct: false, explicit: false,
      });
    }

    restoreBindingValue(binding) {
      const result = this.restoreSlotExplicitValue(binding.slot);
      binding.value = cloneLogical(binding.slot.value);
      return result;
    }

    promoteExplicit(owner, property, value) {
      const slot = this.ensureLogicalSlot(owner, property);
      slot.explicitValue = normalizeLogical(slot.descriptor, value,
        `${owner.component_type || "SceneObject"}.${property}`);
    }

    queueBinding(binding) {
      if (binding.disposed) return;
      this.pendingBindings.add(binding);
      this.scheduleBindingFlush();
    }

    scheduleBindingFlush() {
      if (this.bindingFlushQueued || this.disposed) return;
      this.bindingFlushQueued = true;
      this.frameCoordinator.request(this.bindingCoordinatorKey, () => {
        this.bindingFlushQueued = false;
        try { this.flushBindings(); }
        catch (error) { this.emit("bindingerror", Object.freeze({ binding: null, code: error.code || "flush_failed", error })); }
      });
    }

    bindingOrder() {
      const bindings = [...this.bindings.values()].filter((binding) => !binding.disposed);
      const indegree = new Map(bindings.map((binding) => [binding, 0]));
      const outgoing = new Map(bindings.map((binding) => [binding, []]));
      for (const binding of bindings) {
        for (const dependency of binding.dependencies) {
          const writer = dependency.binding;
          if (!writer || writer.disposed) continue;
          indegree.set(binding, indegree.get(binding) + 1);
          outgoing.get(writer).push(binding);
        }
      }
      const queue = bindings.filter((binding) => indegree.get(binding) === 0);
      const ordered = [];
      while (queue.length) {
        const binding = queue.shift();
        ordered.push(binding);
        for (const dependent of outgoing.get(binding)) {
          const next = indegree.get(dependent) - 1;
          indegree.set(dependent, next);
          if (next === 0) queue.push(dependent);
        }
      }
      if (ordered.length !== bindings.length) {
        const active = new Set();
        const complete = new Set();
        const path = [];
        let cycle = null;
        const visit = (binding) => {
          if (cycle || complete.has(binding)) return;
          if (active.has(binding)) {
            const start = path.indexOf(binding);
            cycle = [...path.slice(start), binding];
            return;
          }
          active.add(binding);
          path.push(binding);
          for (const dependency of binding.dependencies) {
            const writer = dependency.binding;
            if (writer && !writer.disposed) visit(writer);
          }
          path.pop();
          active.delete(binding);
          complete.add(binding);
        };
        for (const binding of bindings) visit(binding);
        const chain = cycle?.map((binding) =>
          `${this.ownerId(binding.target) || "<anonymous>"}.${binding.property}`).join(" -> ");
        throw codedError("dependency_cycle",
          chain ? `dependency_cycle: ${chain}` : "dependency_cycle in Binding graph");
      }
      return ordered;
    }

    flushBindings() {
      if (this.disposed) return { ok: true, disposed: true, evaluated: 0, committed: 0, failed: 0 };
      if (this.bindingFlushActive) return { ok: true, deferred: true };
      this.bindingFlushActive = true;
      this.bindingFlushQueued = false;
      const changed = new Set(this.dirtySlots);
      const pending = new Set(this.pendingBindings);
      // Freeze the logical input domain for this event batch. Native/member
      // commits can synchronously call back into author code; those writes
      // belong to the next batch and must not make later bindings observe a
      // mixture of pre- and post-callback values. Successful upstream binding
      // results are copied into this map so normal topological propagation
      // still reaches downstream bindings in the current batch.
      const batchValues = new Map();
      const batchValidity = new Map();
      for (const slot of this.slots) {
        batchValues.set(slot, cloneLogical(slot.value));
        batchValidity.set(slot, slot.valid);
      }
      this.dirtySlots.clear();
      this.pendingBindings.clear();
      let evaluated = 0, committed = 0, failed = 0;
      const proposals = [];
      const failures = [];
      const facts = [];
      let nativeBatch = null;
      try {
        for (const binding of this.bindingOrder()) {
          if (!binding.when || binding.disposed) continue;
          if (!pending.has(binding) && !binding.dependencies.some((slot) => changed.has(slot))) continue;
          evaluated += 1;
          try {
            const result = this.expressionEvaluate(binding.expression, (reference) => {
              const slot = this.slotByReference(reference.segments[0], reference.segments[1]);
              const value = batchValues.get(slot);
              if (!slot || slot.removed || !batchValidity.get(slot) || value === undefined) {
                throw codedError("unknown_reference",
                  `unknown_reference: '${reference.segments[0]}.${reference.segments[1]}'`);
              }
              return logicalExpressionValue(slot.descriptor, value);
            });
            const next = bindingResultValue(binding.slot.descriptor, result, `Binding '${binding.id}'`);
            const before = cloneLogical(binding.slot.value);
            proposals.push({ binding, next: cloneLogical(next), before,
              changed: !logicalEqual(before, next) });
            batchValues.set(binding.slot, cloneLogical(next));
            batchValidity.set(binding.slot, true);
            if (!logicalEqual(before, next)) changed.add(binding.slot);
          } catch (error) {
            failed += 1;
            failures.push({ binding, error });
            batchValidity.set(binding.slot, false);
            changed.add(binding.slot);
          }
        }
        // Evaluation/type admission is a zero-write phase. A bad expression
        // never lets an earlier binding leak a native write from this batch.
        if (failures.length) {
          for (const { binding, error } of failures) {
            binding.invalidate(error.code || error.result?.error_code || "binding_evaluation_failed", error,
              { propagate: false });
          }
          this.lastPropertyBridgeReceipt = Object.freeze({ schema_version: "PropertyBridgeReceipt/v1",
            ok: false, status: "rejected", evaluated, committed: 0, verified: 0,
            failed, items: [] });
          return { ok: false, evaluated, committed: 0, failed };
        }

        const nativeProposals = this.nativePropertyBatchAvailable
          ? proposals.filter(({ binding }) => binding.slot.descriptor.kind === "native"
            && !(binding.slot.behavior && !binding.slot.behavior.disposed))
          : [];
        const nativeProposalSet = new Set(nativeProposals);
        if (nativeProposals.length) {
          try {
            nativeBatch = nativePropertyBatch(this, nativeProposals);
          } catch (error) {
            failed += nativeProposals.length;
            for (const { binding } of nativeProposals) {
              binding.invalidate(error.result?.error_code || "property_batch_failed", error,
                { propagate: false });
            }
            if (error.result?.status === "restored" && error.result?.capture_handle) {
              try { this.animationFacade.releaseCapture(error.result.capture_handle); } catch (_) {}
            }
            this.lastPropertyBridgeReceipt = Object.freeze({ schema_version: "PropertyBridgeReceipt/v1",
              ok: false, status: error.result?.status || "rejected", evaluated,
              committed: 0, verified: 0, failed, items: error.result?.items || [] });
            return { ok: false, evaluated, committed: 0, failed };
          }
        }
        const nativeBatchFacts = new Map(nativeProposals.map((proposal, index) =>
          [proposal, nativeBatch?.receipt?.items?.[index] || null]));

        const applied = [];
        for (const proposal of proposals) {
          const { binding, next, before } = proposal;
          const snapshot = {
            slotValue: cloneLogical(binding.slot.value), slotValid: binding.slot.valid,
            slotVersion: binding.slot.version, state: binding.state,
            value: cloneLogical(binding.value), version: binding.version,
          };
          try {
            const nativeBatched = nativeProposalSet.has(proposal);
            const receipt = nativeBatched
              ? this.writeLogical(binding.target, binding.property, next, {
                binding, explicit: false, skipIfSame: true, propagate: false, write: false,
              })
              : this.writeLogical(binding.target, binding.property, next, {
                binding, explicit: false, skipIfSame: true, propagate: false,
              });
            binding.state = "valid";
            binding.value = cloneLogical(next);
            binding.version += 1;
            binding.slot.valid = true;
            if (proposal.changed) committed += 1;
            const fact = {
              binding: binding.id, target: this.ownerId(binding.target), property: binding.property,
              old_version: snapshot.slotVersion, new_version: binding.slot.version,
              native_applied: nativeBatched || receipt?.ok !== false,
              readback: nativeBatched
                ? nativeBatchFacts.get(proposal)?.new_value || null
                : receipt?.value || null,
            };
            facts.push(fact);
            applied.push({ proposal, snapshot, fact, nativeBatched });
          } catch (error) {
            failed += 1;
            let restored = true;
            if (nativeBatch) {
              try {
                nativeResult(this.animationFacade.restoreBatch(nativeBatch.capture.capture_handle),
                  "PropertyBridge.restoreBatch");
              } catch (_) { restored = false; }
            }
            for (const item of [...applied].reverse()) {
              try {
                this.writeLogical(item.proposal.binding.target, item.proposal.binding.property,
                  item.snapshot.slotValue, {
                    binding: item.proposal.binding, explicit: false, direct: true, propagate: false,
                    write: !item.nativeBatched,
                  });
                const restoredBinding = item.proposal.binding;
                restoredBinding.slot.value = cloneLogical(item.snapshot.slotValue);
                restoredBinding.slot.valid = item.snapshot.slotValid;
                restoredBinding.slot.version = item.snapshot.slotVersion;
                restoredBinding.state = item.snapshot.state;
                restoredBinding.value = cloneLogical(item.snapshot.value);
                restoredBinding.version = item.snapshot.version;
                item.fact.restored = true;
              } catch (_) {
                restored = false;
                item.fact.restored = false;
              }
            }
            binding.invalidate(error.code || error.result?.error_code || "binding_commit_failed", error,
              { propagate: false });
            this.lastPropertyBridgeReceipt = Object.freeze({ schema_version: "PropertyBridgeReceipt/v1", ok: false,
              status: restored ? "restored" : "recovery_required", evaluated,
              committed: 0, verified: 0, failed, items: facts,
              native_batch: nativeBatch ? {
                facade_version: nativeBatch.receipt.facade_version,
                capture_handle: nativeBatch.capture.capture_handle,
                status: restored ? "restored" : "recovery_required",
                committed: 0,
                verified: 0,
              } : null });
            return { ok: false, evaluated, committed: 0, failed };
          }
        }
        if (nativeBatch) {
          nativeResult(this.animationFacade.releaseCapture(nativeBatch.capture.capture_handle),
            "PropertyBridge.releaseCapture");
        }
      } finally {
        this.bindingFlushActive = false;
        if (this.dirtySlots.size || this.pendingBindings.size) this.scheduleBindingFlush();
      }
      this.lastPropertyBridgeReceipt = Object.freeze({ schema_version: "PropertyBridgeReceipt/v1",
        ok: true, status: "committed", evaluated, committed, verified: committed,
        failed, items: facts,
        native_batch: nativeBatch ? {
          facade_version: nativeBatch.receipt.facade_version,
          capture_handle: nativeBatch.capture.capture_handle,
          status: nativeBatch.receipt.status,
          committed: nativeBatch.receipt.committed,
          verified: nativeBatch.receipt.verified,
        } : null });
      return { ok: true, evaluated, committed, failed };
    }

    commit() {
      this.frameCoordinator.cancel(this.bindingCoordinatorKey);
      return this.flushBindings();
    }

    disposeOwnerSlots(owner) {
      const map = this.slotMaps.get(owner);
      if (!map) return;
      const id = this.ownerId(owner);
      for (const slot of map.values()) {
        slot.removed = true;
        if (slot.binding && !slot.binding.disposed) slot.binding.dispose({ restore: false });
        for (const dependent of [...slot.dependents]) dependent.invalidate("unknown_reference");
        slot.dependents.clear();
        this.slots.delete(slot);
        if (id) this.slotsByReference.delete(`${id}\u0000${slot.property}`);
        this.dirtySlots.delete(slot);
      }
      map.clear();
      if (id && this.referenceOwners.get(id) === owner) this.referenceOwners.delete(id);
    }

    createObject(spec) { return new SceneObject(this, spec); }
    createScene(spec) { return new Scene(this, spec); }
    createGroup(spec) { return new Group(this, spec); }
    createGeoAnchor(spec) { return new GeoAnchor(this, spec); }
    createBox(spec) { return new Box(this, spec); }
    createPlane(spec) { return new Plane(this, spec); }
    createSphere(spec) { return new Sphere(this, spec); }
    createCylinder(spec) { return new Cylinder(this, spec); }
    createCone(spec) { return new Cone(this, spec); }
    createPolyline(spec) { return new Polyline(this, spec); }
    createHeightField(spec) { return new HeightField(this, spec); }
    createLathe(spec) { return new Lathe(this, spec); }
    createTube(spec) { return new Tube(this, spec); }
    createLoft(spec) { return new Loft(this, spec); }
    createPolygon(spec) { return new Polygon(this, spec); }
    createExtrudedPolygon(spec) { return new ExtrudedPolygon(this, spec); }
    createLabel(spec) { return new Label(this, spec); }
    async createModel(spec) {
      const model = new Model(this, spec);
      try { return await model.initialize(); }
      finally { this.modelReservations.delete(model.id); }
    }
    createTexture(spec) { return new Texture(this, spec); }
    createPropertyBag(spec) { return new LogicalPropertyBag(this, spec); }
    createPrincipledMaterial(spec) { return new PrincipledMaterial(this, spec); }
    createRepeater(spec) { return new Repeater(this, spec); }
    createAnimation(spec) { return new Animation(this, spec); }
    createPropertyAnimation(spec) { return new PropertyAnimation(this, spec); }
    createNumberAnimation(spec) { return new NumberAnimation(this, spec); }
    createVector3dAnimation(spec) { return new Vector3dAnimation(this, spec); }
    createQuaternionAnimation(spec) { return new QuaternionAnimation(this, spec); }
    createColorAnimation(spec) { return new ColorAnimation(this, spec); }
    createRotationAnimation(spec) { return new RotationAnimation(this, spec); }
    createPauseAnimation(spec) { return new PauseAnimation(spec); }
    createParallelAnimation(spec) { return new ParallelAnimation(this, spec); }
    createSequentialAnimation(spec) { return new SequentialAnimation(this, spec); }
    createBinding(spec) { return new Binding(this, spec); }
    createBehavior(spec) { return new Behavior(this, spec); }
    createPropertyChanges(spec) { return new PropertyChanges(spec); }
    createState(spec) { return new State(this, spec); }
    createPropertyAction(spec) { return new PropertyAction(spec); }
    createTransition(spec) { return new Transition(spec); }
    createStateController(spec) { return new StateController(this, spec); }
    createKeyframe(spec) { return new Keyframe(spec); }
    createKeyframeGroup(spec) { return new KeyframeGroup(spec); }
    createTimeline(spec) { return new Timeline(this, spec); }
    createTimelineAnimation(spec) { return new TimelineAnimation(this, spec); }
    createOrbitAnimation(spec) { return new OrbitAnimation(this, spec); }
    createPath3DAnimation(spec) { return new Path3DAnimation(this, spec); }
    createCamera(spec) { return new Camera(this, spec); }
    createCameraView(spec) { return new CameraView(this, spec); }
    createLightComponent() { throw new Error("type_abstract: LightComponent cannot be instantiated"); }
    createSunSky(spec) { return new SunSky(this, spec); }
    createDirectionalLight(spec) { return new DirectionalLight(this, spec); }
    createPointLight(spec) { return new PointLight(this, spec); }
    createSpotLight(spec) { return new SpotLight(this, spec); }
    createRectLight(spec) { return new RectLight(this, spec); }
    createSkyLight(spec) { return new SkyLight(this, spec); }
    createSkyAtmosphere(spec) { return new SkyAtmosphere(this, spec); }
    createVolumetricCloud(spec) { return new VolumetricCloud(this, spec); }
    createExponentialHeightFog(spec) { return new ExponentialHeightFog(this, spec); }
    createPostProcessVolume(spec) { return new PostProcessVolume(this, spec); }
    createPrefab(spec) { return new Prefab(this, spec); }
    createInstances(spec) { return new Instances(this, spec); }
    createTapHandler(spec) { return new TapHandler(this, spec); }
    createHoverHandler(spec) { return new HoverHandler(this, spec); }
    createKeyHandler(spec) { return new KeyHandler(this, spec); }
    createTimer(spec) { return new Timer(this, spec); }
    createActionHandler(spec) { return new ActionHandler(this, spec); }
    readProperty(target, property) { return readNativeProperty(this, target, property); }
    readLogical(target, property) {
      const slot = this.slotMaps.get(target)?.get(property);
      invariant(slot && !slot.removed,
        `unknown_reference: '${this.ownerId(target) || "<anonymous>"}.${property}'`);
      return cloneLogical(slot.value);
    }
    writeProperty(target, property, value) { return this.writeLogical(target, property, value); }
    nextModelIncarnation(id) {
      const next = (this.modelIncarnations.get(id) || 0) + 1;
      this.modelIncarnations.set(id, next);
      return next;
    }
    async resolveAsset(asset, field) {
      const bytes = await this.resolveManagedAsset(asset);
      invariant(bytes instanceof Uint8Array, `${field} managed resolver must return Uint8Array`);
      invariant(bytes.byteLength === asset.size_bytes,
        `${field} managed bytes do not match the declared size`);
      return bytes;
    }

    activateView(id, options) {
      const view = this.views.get(id);
      invariant(view, `CameraView '${id}' is not registered`);
      if (!this.camera) this.createCamera();
      return this.camera.flyTo(view, options);
    }

    snapshot() {
      return {
        schema_version: "SSDLBuiltinRuntimeSnapshot/v1",
        active_view: this.activeView,
        scene: this.sceneRoot ? { id: this.sceneRoot.id, key: this.sceneRoot.key, handle: this.sceneRoot.handle } : null,
        locator_handle: this.locatorHandle,
        objects: [...this.objects.values()].map((item) => item.snapshot()),
        groups: [...this.groups.values()].map((item) => ({
          id: item.id,
          handle: item.handle,
          component_type: item.component_type,
        })),
        labels: [...this.labels.values()].map((item) => item.snapshot()),
        models: [...this.models.values()].map((item) => item.snapshot()),
        textures: [...this.textures.values()].map((item) => item.snapshot()),
        prefabs: [...this.prefabs.values()].map((item) => item.snapshot()),
        instances: [...this.instanceBatches.values()].map((item) => item.snapshot()),
        sun_skies: [...this.sunSkies.values()].map((item) => item.snapshot()),
        environment: [...this.environmentComponents.values()].map((item) => item.snapshot()),
        post_process_volumes: [...this.postProcessVolumes.values()].map((item) => item.snapshot()),
        materials: [...this.materials.values()].map((item) => item.snapshot()),
        repeaters: [...this.repeaters.values()].map((item) => item.snapshot()),
        logical_properties: [...this.propertyBags.values()].map((item) => ({
          id: item.id, values: { ...item.values },
        })),
        animation_handles: [...this.animations.keys()],
        driver_handles: [...this.drivers.keys()],
        bindings: [...this.bindings.values()].map((item) => item.describe()),
        last_property_batch: this.lastPropertyBridgeReceipt || null,
        behaviors: this.behaviors.size,
        states: [...this.stateControllers.values()].map((item) => ({ id: item.id, current: item.current })),
        timers: [...this.timers.values()].map((item) => ({
          id: item.id, handle: item.handle, running: item.running, interval: item.interval,
        })),
        views: [...this.views.values()].map((view) => ({ id: view.id, label: view.label })),
      };
    }

    dispose() {
      if (this.disposed) return;
      for (const binding of [...this.bindings.values()]) binding.dispose({ restore: false });
      for (const handler of [...this.tapHandlers]) handler.dispose();
      for (const handler of [...this.hoverHandlers]) handler.dispose();
      for (const handler of [...this.keyHandlers]) handler.dispose();
      for (const handler of [...this.actionHandlers]) handler.dispose();
      for (const controller of [...this.stateControllers.values()]) controller.dispose();
      for (const behavior of [...this.behaviors]) behavior.dispose();
      for (const timer of [...this.timers.values()]) timer.dispose();
      for (const repeater of [...this.repeaters.values()]) repeater.dispose();
      for (const bag of [...this.propertyBags.values()]) bag.dispose();
      for (const label of [...this.labels.values()]) label.dispose();
      for (const model of [...this.models.values()]) model.dispose();
      for (const sunSky of [...this.sunSkies.values()]) sunSky.dispose();
      for (const component of [...this.environmentComponents.values()]) component.dispose();
      for (const volume of [...this.postProcessVolumes.values()]) volume.dispose();
      // Batches before prefabs before source objects: a prefab borrows its source node's material, so
      // the source must outlive it, and a batch names its prefab when releasing.
      for (const batch of [...this.instanceBatches.values()]) batch.dispose();
      for (const prefab of [...this.prefabs.values()]) prefab.dispose();
      for (const object of [...this.objects.values()]) object.dispose();
      for (const animation of [...this.animations.values()]) animation.dispose();
      for (const group of [...this.groups.values()].reverse()) group.dispose();
      // Textures go last among the content: a live PrincipledMaterial only drops its managed-slot
      // references when its host object disposes, and Texture.dispose() refuses to run while any
      // reference remains — disposing textures first aborted the whole teardown (objects, groups,
      // scene and facades were never released) whenever a material had a map bound.
      for (const texture of [...this.textures.values()]) texture.dispose();
      nativeResult(this.sceneGraphFacade.dispose(this.scene, this.locatorHandle), "SceneGraphFacade.dispose");
      this.postProcessLease.release();
      for (const facade of [this.prefabFacade, this.environmentFacade, this.modelFacade, this.materialFacade, this.labelFacade, this.interactionFacade, this.sceneGraphFacade, this.animationFacade, this.geometryFacade]) {
        if (facade && typeof facade.delete === "function") facade.delete();
      }
      this.drivers.clear();
      this.views.clear();
      this.listeners.clear();
      this.disposed = true;
    }
  }

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    component_types: COMPONENT_TYPES,
    createRuntime: (options) => new BuiltinRuntime(options),
    createFrameCoordinator: (queueMicrotask) => new FrameCoordinator(queueMicrotask),
    testing: Object.freeze({
      nativeResult, hexColor, quaternion, quaternionZ, directedRotationDelta, wireValue, authorValue,
      animationDefinition, compositeTimeline, polygonParams, polylineMesh, sunSkySpec, sunDirectionFromAnchor,
    }),
  });
});
