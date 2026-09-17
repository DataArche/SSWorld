import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import parser from "../generated/parser-0.3.cjs";
import expressionRuntime from "./expression-runtime.js";
import propertyRegistry from "../generated/property-registry.js";
import { emitSceneModule } from "./scene-module-emitter.mjs";
import { expandSourceProject, FRAGMENT_PARAMS_ID, FRAGMENT_ROOT_ID } from "./source-project-0.3.mjs";
import { validateGeo } from "./geo-0.3.mjs";

const catalog = JSON.parse(readFileSync(new URL("../generated/builtin-catalog-v1.json", import.meta.url), "utf8"));
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, stable(value[key])]))
    : value;
const digest = (value) => `sha256:${createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(stable(value)), "utf8").digest("hex")}`;
const ID = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const CATALOG_DIGEST = digest(catalog);
const RUNTIME_ABI_DIGEST = digest({
  builtin_catalog_digest: CATALOG_DIGEST,
  builtin_runtime: "SSDLBuiltinRuntime/v1",
  frame_receipt: "FrameCoordinatorReceipt/1",
  property_bridge: "PropertyBridge/v1",
  scene_runtime_bridge: "SceneRuntimeBridge/v1",
});
const IMPLEMENTATION_DIGEST = digest({
  grammar: readFileSync(new URL("../grammar/ssdl-0.3.peggy", import.meta.url), "utf8"),
  compiler: readFileSync(new URL(import.meta.url), "utf8"),
  emitter: readFileSync(new URL("./scene-module-emitter.mjs", import.meta.url), "utf8"),
  source_project: readFileSync(new URL("./source-project-0.3.mjs", import.meta.url), "utf8"),
  geo: readFileSync(new URL("./geo-0.3.mjs", import.meta.url), "utf8"),
  expression_runtime: readFileSync(new URL("./expression-runtime.js", import.meta.url), "utf8"),
  catalog, property_registry: propertyRegistry.registry_digest,
});
const PROFILE = Object.freeze({
  profile: "SSDL/QML-Subset/0.3",
  scene_ir: "SceneIR/5",
  binding_ir: "BindingIR/2",
  scene_module: "SceneModule/1",
  catalog_digest: CATALOG_DIGEST,
  runtime_abi_digest: RUNTIME_ABI_DIGEST,
  implementation_digest: IMPLEMENTATION_DIGEST,
});
const PROFILE_DIGEST = digest(PROFILE);

function fail(code, ast, detail = code) {
  const error = Object.assign(new Error(detail), { code });
  if (ast?.location) error.diagnostic = {
    file: ast.file || "scene.ssdl",
    line: ast.location.start.line,
    column: ast.location.start.column,
  };
  throw error;
}

function assignments(node) {
  const result = new Map();
  for (const member of node.members.filter((item) => item.kind === "property")) {
    if (result.has(member.name)) fail("duplicate_assignment", member);
    result.set(member.name, member);
  }
  return result;
}

function nodeId(node, fields) {
  const value = fields.get("id")?.value;
  const id = value?.kind === "identifier" || value?.kind === "literal" ? value.value : null;
  if (typeof id !== "string" || !ID.test(id)) fail("invalid_id", fields.get("id") || node);
  return id;
}

function literalValue(ast) {
  if (ast.kind === "literal") return ast.value;
  if (ast.kind === "number") return Number(ast.token);
  if (ast.kind === "negative" && ast.arg.kind === "number") return -Number(ast.arg.token);
  if (ast.kind === "array") return ast.values.map(literalValue);
  if (ast.kind === "identifier") return ast.value;
  fail("constant_required", ast);
}

function typeSpec(valueType, unit = null) {
  return { value_type: valueType, unit, divisor: ["scalar", "vector2", "vector3", "quaternion"].includes(valueType) ? 1e6 : 1 };
}

function encodeLiteral(value, expected, ast) {
  if (expected.value_type === "boolean") {
    if (typeof value !== "boolean") fail("type_mismatch", ast);
    return { literal: value };
  }
  if (["string", "color"].includes(expected.value_type)) {
    if (typeof value !== "string") fail("type_mismatch", ast);
    if (expected.value_type === "color" && !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) fail("color_invalid", ast);
    return { literal: value };
  }
  if (["vector2", "vector3", "quaternion"].includes(expected.value_type)) {
    const size = expected.value_type === "vector2" ? 2 : expected.value_type === "quaternion" ? 4 : 3;
    if (!Array.isArray(value) || value.length !== size || value.some((item) => !Number.isFinite(item))) fail("type_mismatch", ast);
    return { op: "array", args: value.map((item) => ({ literal: Math.round(item * expected.divisor), unit: expected.unit })) };
  }
  if (!Number.isFinite(value)) fail("type_mismatch", ast);
  const encoded = Math.round(value * expected.divisor);
  if (!Number.isSafeInteger(encoded)) fail("unsafe_integer", ast);
  return { literal: encoded, unit: expected.unit };
}

function containsReference(ast) {
  if (["reference", "identifier"].includes(ast.kind)) return true;
  return (ast.args || ast.values || (ast.arg ? [ast.arg] : [])).some(containsReference);
}

// Units flow bottom-up through the arithmetic that preserves them, so `hypot(carX - gateX, 0) < 4`
// has to learn "metres" from carX and hand it to both sides of the comparison; without this the
// literals compile as dimensionless and the binding dies at runtime with unit_mismatch.
const UNIT_PRESERVING = new Set(["add", "sub", "min", "max", "clamp", "abs", "floor", "ceil", "round", "mod", "hypot", "lerp", "select", "mul", "div"]);
function inferOperandType(ast, symbols, depth = 0) {
  if (!ast || depth > 16) return null;
  if (ast.kind === "reference") return symbols.types.get(`${ast.segments[0]}.${runtimeProperty(symbols.nodes.get(ast.segments[0])?.type, ast.segments.slice(1).join("."))}`) || null;
  if (ast.kind === "identifier") return symbols.types.get(`${symbols.rootId}.${ast.value}`) || null;
  if (ast.kind === "negative") return inferOperandType(ast.arg, symbols, depth + 1);
  // sqrt keeps its operand's lane now, so a squared distance stays in metres all the way up.
  if (ast.name === "sqrt") return inferOperandType(ast.args?.[0], symbols, depth + 1);
  if (["sin", "cos", "sign", "hash01"].includes(ast.name)) return typeSpec("scalar", "scalar");
  if (ast.name === "atan2") return typeSpec("scalar", "deg");
  const op = ast.kind === "call" ? ast.name : ast.op;
  if ((ast.kind === "op" || ast.kind === "call") && UNIT_PRESERVING.has(op)) {
    const args = op === "select" ? ast.args.slice(1) : ast.args;
    for (const arg of args) { const found = inferOperandType(arg, symbols, depth + 1); if (found) return found; }
    return null;
  }
  if (["literal", "number"].includes(ast.kind)) return typeSpec(typeof ast.value === "boolean" ? "boolean" : typeof ast.value === "string" ? "string" : "scalar", "scalar");
  return null;
}
// The encodeLiteral fast path takes a whole literal subtree, nothing more. "no reference anywhere"
// used to be the test, which let `[0, 0, 2 * 3]` in and then died in literalValue as
// constant_required -- an arithmetic element inside a vector literal was simply not expressible,
// and a component parameter folded to a constant turned a working expression into that error.
function isLiteralTree(ast) {
  if (["literal", "number"].includes(ast.kind)) return true;
  if (ast.kind === "negative") return isLiteralTree(ast.arg);
  if (ast.kind === "array") return ast.values.every(isLiteralTree);
  return false;
}
function compileExpression(ast, expected, symbols, dependencies) {
  if (isLiteralTree(ast)) {
    return encodeLiteral(literalValue(ast), expected, ast);
  }
  if (ast.kind === "reference" && ["Easing", "Animation", "RotationAnimation"].includes(ast.segments[0])) {
    const text = ast.segments.join('.');
    if (text === 'Animation.Infinite') return encodeLiteral(-1, expected, ast);
    const allowed = new Set(['Easing.Linear','Easing.InQuad','Easing.OutQuad','Easing.InOutQuad','Easing.InCubic','Easing.OutCubic','Easing.InOutCubic','Easing.InSine','Easing.OutSine','Easing.InOutSine','RotationAnimation.Numerical','RotationAnimation.Clockwise','RotationAnimation.Counterclockwise','RotationAnimation.Shortest']);
    if (!allowed.has(text)) fail('enum_invalid', ast);
    return encodeLiteral(ast.segments[0] === 'RotationAnimation' ? ast.segments[1] : text, expected, ast);
  }
  if (ast.kind === "reference" || ast.kind === "identifier") {
    const segments = ast.kind === "reference" ? ast.segments : [ast.value];
    let owner, property;
    if (segments.length === 1) {
      const declaration = symbols.declarations.get(segments[0]);
      if (!declaration) fail("unknown_reference", ast, segments[0]);
      owner = symbols.rootId;
      property = declaration.name;
    } else if (segments.length >= 2 && symbols.nodes.has(segments[0])) {
      owner = segments[0]; property = segments.slice(1).join(".");
      property = runtimeProperty(symbols.nodes.get(owner).type, property);
    } else fail("unknown_reference", ast, segments.join("."));
    const key = `${owner}.${property}`;
    const actual = symbols.types.get(key);
    if (!actual) fail("unknown_reference", ast, key);
    if (actual.value_type !== expected.value_type && !([actual.value_type, expected.value_type].every(type => ["string","color"].includes(type)))) fail("type_mismatch", ast, key);
    dependencies.add(key);
    return { ref: { root: "node", segments: [owner, property], channel: "logical" } };
  }
  if (ast.kind === "negative") {
    return { op: "sub", args: [encodeLiteral(0, expected, ast), compileExpression(ast.arg, expected, symbols, dependencies)] };
  }
  const op = ast.kind === "call" ? ast.name : ast.op;
  if (ast.kind === "array") {
    const size = expected.value_type === "vector2" ? 2 : expected.value_type === "quaternion" ? 4 : 3;
    if (!["vector2", "vector3", "quaternion"].includes(expected.value_type) || ast.values.length !== size) fail("type_mismatch", ast);
    return { op: "array", args: ast.values.map((item) => compileExpression(item, typeSpec("scalar", expected.unit), symbols, dependencies)) };
  }
  if (ast.kind !== "op" && ast.kind !== "call") fail("invalid_expression", ast);
  const children = ast.args;
  if (op === "select") {
    return { op, args: [
      compileExpression(children[0], typeSpec("boolean"), symbols, dependencies),
      compileExpression(children[1], expected, symbols, dependencies),
      compileExpression(children[2], expected, symbols, dependencies),
    ] };
  }
  if (["gte", "lte", "nequals"].includes(op)) {
    // Desugared so ExpressionAST/2 (frozen interpreter) stays byte-for-byte: a >= b is !(a < b).
    if (expected.value_type !== "boolean") fail("type_mismatch", ast);
    const base = { gte: "lt", lte: "gt", nequals: "equals" }[op];
    return { op: "not", args: [compileExpression({ ...ast, op: base }, expected, symbols, dependencies)] };
  }
  if (["sqrt", "hash01"].includes(op)) {
    // Units are lanes, so sqrt stays in whichever lane its operand is in -- pinning the operand to
    // "scalar" here would rescale the author's own references behind their back.  hash01 only mixes the
    // raw integer, so its operand keeps its own lane too.
    if (expected.value_type !== "scalar") fail("type_mismatch", ast);
    const operand = inferOperandType(children[0], symbols) || typeSpec("scalar", expected.unit || "scalar");
    return { op, args: [compileExpression(children[0], operand, symbols, dependencies)] };
  }
  if (["sin", "cos"].includes(op)) {
    // Degrees unless the operand is itself radians: a bare number reads as degrees the way it does
    // everywhere else in SSDL, so sin(90) is 1.
    if (expected.value_type !== "scalar") fail("type_mismatch", ast);
    const operand = inferOperandType(children[0], symbols) || typeSpec("scalar", "deg");
    return { op, args: [compileExpression(children[0], operand, symbols, dependencies)] };
  }
  if (op === "atan2") {
    // atan2 is scale invariant, so the two operands only have to agree with each other, not with the
    // degrees the call returns; the operand type comes from the first argument the way equals does.
    const operands = inferOperandType(children[0], symbols) || inferOperandType(children[1], symbols) || typeSpec("scalar", "m");
    return { op, args: children.map((item) => compileExpression(item, operands, symbols, dependencies)) };
  }
  const booleanOps = new Set(["not", "and", "or", "equals", "lt", "gt"]);
  let operandType = ["not", "and", "or"].includes(op) ? typeSpec("boolean") : expected;
  if (["equals", "lt", "gt"].includes(op)) {
    operandType = inferOperandType(children[0], symbols) || inferOperandType(children[1], symbols) || typeSpec('scalar', 'scalar');
  }
  const result = { op, args: children.map((item) => compileExpression(item, operandType, symbols, dependencies)) };
  if (booleanOps.has(op) && expected.value_type !== "boolean") fail("type_mismatch", ast);
  return result;
}

function decode(result, expected, ast) {
  if (["vector2", "vector3", "quaternion"].includes(expected.value_type)) {
    const names = expected.value_type === "vector2" ? ["x", "y"] : expected.value_type === "quaternion" ? ["x", "y", "z", "w"] : ["x", "y", "z"];
    if (result.type !== "array" || result.value.length !== names.length) fail("type_mismatch", ast);
    return Object.fromEntries(names.map((name, index) => [name, result.value[index].value / expected.divisor]));
  }
  if (expected.value_type === "scalar") { if (result.type !== "scalar") fail("type_mismatch", ast); return result.value / expected.divisor; }
  if (expected.value_type === "boolean" && result.type !== "boolean") fail("type_mismatch", ast);
  return result.value;
}

const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

/** host_interfaces contract: { Name: { methods: { method: { args: [{ name, type }], returns?: "void" } } } }. */
function validateHostInterfaces(raw) {
  if (raw === undefined || raw === null) return null;
  const invalid = (detail) => fail("host_interfaces_invalid", null, detail);
  if (!isPlainObject(raw)) invalid("host_interfaces must be an object keyed by interface name");
  const types = Object.keys(catalog.property_types).join("/");
  const out = {};
  for (const [name, iface] of Object.entries(raw)) {
    if (!ID.test(name) || !isPlainObject(iface) || !isPlainObject(iface.methods)) invalid(`host interface '${name}' needs { methods: { <method>: { args: [{ name, type }] } } }`);
    const methods = {};
    for (const [method, signature] of Object.entries(iface.methods)) {
      if (!ID.test(method) || !isPlainObject(signature) || (signature.args !== undefined && !Array.isArray(signature.args))) invalid(`${name}.${method} needs { args: [...] }`);
      const args = (signature.args || []).map((arg) => {
        if (!isPlainObject(arg) || !ID.test(arg.name || "") || !Object.hasOwn(catalog.property_types, arg.type)) invalid(`${name}.${method}: every arg needs { name, type } with type one of ${types}`);
        return { name: arg.name, type: arg.type };
      });
      if (new Set(args.map((arg) => arg.name)).size !== args.length) invalid(`${name}.${method} repeats an argument name`);
      if (signature.returns !== undefined && signature.returns !== "void") invalid(`${name}.${method}: only returns: "void" is supported (host calls are fire-and-forget)`);
      methods[method] = { args, returns: "void" };
    }
    out[name] = { methods };
  }
  return Object.keys(out).length ? out : null;
}

function compileHostCall(action, symbols, hostInterfaces) {
  const [name, ...rest] = action.target;
  const method = rest.join(".");
  const iface = hostInterfaces?.[name];
  if (!iface) fail("host_interface_unknown", action, `'${name}' is neither a node with commands nor an interface declared in host_interfaces${hostInterfaces ? ` (declared: ${Object.keys(hostInterfaces).join(", ")})` : " (no host_interfaces.json in the project)"}`);
  const signature = iface.methods[method];
  if (!signature) fail("host_method_unknown", action, `${name}.${method} is not declared; declared methods: ${Object.keys(iface.methods).join(", ") || "(none)"}`);
  const supplied = new Map();
  for (const arg of action.args) {
    if (supplied.has(arg.name)) fail("host_arg_duplicate", arg, `${name}.${method}: argument '${arg.name}' given twice`);
    if (!signature.args.some((item) => item.name === arg.name)) fail("host_arg_unknown", arg, `${name}.${method} has no argument '${arg.name}'; expected ${signature.args.map((item) => item.name).join(", ") || "no arguments"}`);
    supplied.set(arg.name, arg);
  }
  const args = signature.args.map((declared) => {
    const given = supplied.get(declared.name);
    if (!given) fail("host_arg_missing", action, `${name}.${method} requires argument '${declared.name}' (${declared.type})`);
    const descriptor = catalog.property_types[declared.type];
    const expected = typeSpec(descriptor.value_type, descriptor.unit);
    return { name: declared.name, expected, expression: compileExpression(given.value, expected, symbols, new Set()) };
  });
  return { kind: "call", interface: name, method, args };
}

/** Native explicit meshes are capped at 65535 vertices (GeometryFacade MeshData/v1). */
export const MESH_MAX_VERTICES = 65535;
const meshFail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const integer = (value, name, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) meshFail("mesh_invalid", `${name} must be an integer in ${min}..${max}`);
  return value;
};
  // ---- Shared procedural-geometry algorithms -------------------------------------------------
  // SINGLE SOURCE: src/ssdl/shared/geometry-algorithms.js.  Do not edit this block in place -- edit
  // that file and rerun `node src/ssdl/tools/generate_geometry_algorithms.mjs`, which splices it into
  // compiler-0.3.mjs (budget + degeneracy checks) and ssdl-builtins.js (the real generators) between
  // these two marker comments.  Both copies are pinned to the same reference vectors in
  // src/ssdl/fixtures/geometry-vectors/*.json, so a hand edit to one copy turns a test red instead of
  // letting the compiler accept what the runtime refuses (or the other way round).
  // Everything here is deterministic: no Math.random, no Date, no locale.
  const GEOMETRY_ALGORITHMS_VERSION = "SSDLGeometryAlgorithms/2";
  function geometryFailure(code, message) {
    return Object.assign(new Error(message), { code });
  }
  /**
   * Centripetal Catmull-Rom (alpha = 0.5) through `points` ([x, y, z] arrays).  Open curves clamp
   * their end points; closed curves wrap.  `samples` output points per control segment; an open curve
   * ends with the last control point, so it yields (n - 1) * samples + 1 points, a closed one n * samples.
   */
  function catmullRomResample(points, samples, closed = false) {
    const n = points.length;
    if (n < 2) return points.map((point) => point.slice());
    const get = (index) => closed ? points[((index % n) + n) % n] : points[Math.min(n - 1, Math.max(0, index))];
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const lerp = (a, b, weightA, weightB) => [a[0] * weightA + b[0] * weightB, a[1] * weightA + b[1] * weightB, a[2] * weightA + b[2] * weightB];
    const out = [];
    const segments = closed ? n : n - 1;
    for (let index = 0; index < segments; index += 1) {
      const p0 = get(index - 1), p1 = get(index), p2 = get(index + 1), p3 = get(index + 2);
      let t0 = 0, t1 = Math.sqrt(distance(p0, p1)), t2 = t1 + Math.sqrt(distance(p1, p2)), t3 = t2 + Math.sqrt(distance(p2, p3));
      // A coincident control point (clamped ends, or an authored repeat) collapses a knot interval;
      // fall back to the uniform parameterisation for that segment instead of dividing by zero.
      if (t1 - t0 < 1e-12 || t2 - t1 < 1e-12 || t3 - t2 < 1e-12) { t0 = 0; t1 = 1; t2 = 2; t3 = 3; }
      for (let sample = 0; sample < samples; sample += 1) {
        const t = t1 + (t2 - t1) * (sample / samples);
        const a1 = lerp(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
        const a2 = lerp(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
        const a3 = lerp(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
        const b1 = lerp(a1, a2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
        const b2 = lerp(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
        out.push(lerp(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1)));
      }
    }
    if (!closed) out.push(points[n - 1].slice());
    return out;
  }
  /** Signed area of a planar ring ([x, y] or longer arrays; only the first two coordinates count). */
  function ringSignedArea(ring) {
    let area = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index], b = ring[(index + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return area / 2;
  }
  function segmentsIntersect(a, b, c, d) {
    const orient = (p, q, r) => {
      const value = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      return value > 1e-12 ? 1 : value < -1e-12 ? -1 : 0;
    };
    const onSegment = (p, q, r) => Math.min(p[0], r[0]) - 1e-12 <= q[0] && q[0] <= Math.max(p[0], r[0]) + 1e-12
      && Math.min(p[1], r[1]) - 1e-12 <= q[1] && q[1] <= Math.max(p[1], r[1]) + 1e-12;
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(a, c, b)) return true;
    if (o2 === 0 && onSegment(a, d, b)) return true;
    if (o3 === 0 && onSegment(c, a, d)) return true;
    if (o4 === 0 && onSegment(c, b, d)) return true;
    return false;
  }
  /** Index of the first edge pair of a ring that crosses (non-adjacent edges only), or -1. */
  function ringSelfIntersection(ring, closed = true) {
    const count = closed ? ring.length : ring.length - 1;
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 2; j < count; j += 1) {
        if (closed && i === 0 && j === count - 1) continue;
        if (segmentsIntersect(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length])) return [i, j];
      }
    }
    return null;
  }
  /**
   * Ear-clipping triangulation of one outer ring (counter-clockwise, [x, y]) with optional holes
   * (clockwise).  Holes are bridged into the outer ring (rightmost hole first, David Eberly's visible
   * vertex construction), then ears are clipped.  Returns flat triangle indices into the concatenation
   * outer ++ holes[0] ++ holes[1] ...  Throws `mesh_invalid` when no ear exists (a self-intersecting or
   * collapsed ring).  O(n^2) per hole and per ear; callers cap the total point count.
   */
  function earcutRings(outer, holes = []) {
    const vertices = [];
    let ring = outer.map((point, index) => { vertices.push(point); return index; });
    const holeRings = holes.map((hole) => {
      const start = vertices.length;
      hole.forEach((point) => vertices.push(point));
      return hole.map((_, index) => start + index);
    });
    const point = (index) => vertices[index];
    const crossesAny = (a, b) => {
      const rings = [ring, ...holeRings];
      for (const candidate of rings) {
        for (let index = 0; index < candidate.length; index += 1) {
          const c = candidate[index], d = candidate[(index + 1) % candidate.length];
          if (c === a || c === b || d === a || d === b) continue;
          if (segmentsIntersect(point(a), point(b), point(c), point(d))) return true;
        }
      }
      return false;
    };
    // Bridge holes from the rightmost inward so an earlier bridge never blocks a later one.
    holeRings.sort((left, right) => Math.max(...right.map((index) => point(index)[0])) - Math.max(...left.map((index) => point(index)[0])));
    for (const hole of holeRings) {
      let holeVertex = 0;
      for (let index = 1; index < hole.length; index += 1) if (point(hole[index])[0] > point(hole[holeVertex])[0]) holeVertex = index;
      const m = point(hole[holeVertex]);
      const order = ring.map((index, position) => ({ position, distance: Math.hypot(point(index)[0] - m[0], point(index)[1] - m[1]) }))
        .sort((left, right) => left.distance - right.distance || left.position - right.position);
      let bridge = -1;
      for (const candidate of order) {
        if (!crossesAny(hole[holeVertex], ring[candidate.position])) { bridge = candidate.position; break; }
      }
      if (bridge === -1) throw geometryFailure("mesh_invalid", "a hole cannot be connected to the outer ring without crossing an edge");
      const rotated = [...hole.slice(holeVertex), ...hole.slice(0, holeVertex)];
      ring = [...ring.slice(0, bridge + 1), ...rotated, rotated[0], ...ring.slice(bridge)];
    }
    const indices = [];
    let remaining = ring.slice();
    const sameXY = (a, b) => a[0] === b[0] && a[1] === b[1];
    const isEar = (position) => {
      const size = remaining.length;
      const ia = remaining[(position + size - 1) % size], ib = remaining[position], ic = remaining[(position + 1) % size];
      const a = point(ia), b = point(ib), c = point(ic);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 1e-12) return false;
      for (const index of remaining) {
        if (index === ia || index === ib || index === ic) continue;
        const p = point(index);
        if (sameXY(p, a) || sameXY(p, b) || sameXY(p, c)) continue;
        const w0 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        const w1 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
        const w2 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
        if (w0 >= -1e-12 && w1 >= -1e-12 && w2 >= -1e-12) return false;
      }
      return true;
    };
    let guard = 0;
    while (remaining.length > 3) {
      let clipped = false;
      for (let position = 0; position < remaining.length; position += 1) {
        if (!isEar(position)) continue;
        const size = remaining.length;
        indices.push(remaining[(position + size - 1) % size], remaining[position], remaining[(position + 1) % size]);
        remaining.splice(position, 1);
        clipped = true;
        break;
      }
      if (!clipped) {
        // Collinear runs leave no strict ear; drop a zero-area corner and carry on.
        const size = remaining.length;
        let dropped = false;
        for (let position = 0; position < size; position += 1) {
          const a = point(remaining[(position + size - 1) % size]), b = point(remaining[position]), c = point(remaining[(position + 1) % size]);
          const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          if (Math.abs(cross) <= 1e-12) { remaining.splice(position, 1); dropped = true; break; }
        }
        if (!dropped) throw geometryFailure("mesh_invalid", "the ring could not be triangulated (it crosses itself or is not counter-clockwise)");
      }
      if ((guard += 1) > 200000) throw geometryFailure("mesh_invalid", "the ring could not be triangulated");
    }
    if (remaining.length === 3) {
      const a = point(remaining[0]), b = point(remaining[1]), c = point(remaining[2]);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross > 1e-12) indices.push(remaining[0], remaining[1], remaining[2]);
    }
    return indices;
  }
  /**
   * Move every vertex of a ring along the mitre of its two edge normals by `distance` (metres).  For a
   * counter-clockwise ring a positive distance moves inward.  Returns { ring, flipped } where `flipped`
   * is the index of the first edge whose direction reversed (the inset ate the edge), or -1.
   */
  function offsetRing(ring, distance) {
    const count = ring.length;
    const out = [];
    for (let index = 0; index < count; index += 1) {
      const previous = ring[(index + count - 1) % count], current = ring[index], next = ring[(index + 1) % count];
      const e0 = [current[0] - previous[0], current[1] - previous[1]], e1 = [next[0] - current[0], next[1] - current[1]];
      const l0 = Math.hypot(e0[0], e0[1]), l1 = Math.hypot(e1[0], e1[1]);
      if (l0 < 1e-12 || l1 < 1e-12) throw geometryFailure("mesh_degenerate", `ring point ${index} repeats its neighbour`);
      const n0 = [-e0[1] / l0, e0[0] / l0], n1 = [-e1[1] / l1, e1[0] / l1];
      const dot = n0[0] * n1[0] + n0[1] * n1[1];
      if (1 + dot < 1e-9) throw geometryFailure("mesh_degenerate", `ring point ${index} folds back on itself`);
      const scale = distance / (1 + dot);
      out.push([current[0] + (n0[0] + n1[0]) * scale, current[1] + (n0[1] + n1[1]) * scale, ...(current.length > 2 ? [current[2]] : [])]);
    }
    let flipped = -1;
    for (let index = 0; index < count && flipped === -1; index += 1) {
      const a = ring[index], b = ring[(index + 1) % count], c = out[index], d = out[(index + 1) % count];
      if ((b[0] - a[0]) * (d[0] - c[0]) + (b[1] - a[1]) * (d[1] - c[1]) <= 0) flipped = index;
    }
    return { ring: out, flipped };
  }
  /** Deterministic 32-bit lattice hash to [0, 1). */
  function latticeHash(x, y, seed) {
    let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  /** Value noise in [0, 1): bilinear lattice hash with a smoothstep fade. */
  function valueNoise2(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = latticeHash(ix, iy, seed), b = latticeHash(ix + 1, iy, seed);
    const c = latticeHash(ix, iy + 1, seed), d = latticeHash(ix + 1, iy + 1, seed);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  }
  /** Fractal value noise in [-1, 1]: `octaves` layers, lacunarity 2, gain 0.5, normalised. */
  function fbm2(x, y, seed, octaves, frequency) {
    let sum = 0, amplitude = 1, norm = 0, scale = frequency;
    for (let octave = 0; octave < octaves; octave += 1) {
      sum += amplitude * (valueNoise2(x * scale, y * scale, seed + octave) * 2 - 1);
      norm += amplitude;
      scale *= 2;
      amplitude *= 0.5;
    }
    return sum / norm;
  }
  /** Resample a closed ring ([x, y, z]) to `count` points evenly spaced by arc length, starting at point 0. */
  function resampleClosedRing(ring, count) {
    const n = ring.length;
    const lengths = [];
    let total = 0;
    for (let index = 0; index < n; index += 1) {
      const a = ring[index], b = ring[(index + 1) % n];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      lengths.push(length);
      total += length;
    }
    if (!(total > 0)) throw geometryFailure("mesh_degenerate", "ring has zero length");
    const out = [];
    let segment = 0, walked = 0;
    for (let index = 0; index < count; index += 1) {
      const target = total * index / count;
      while (segment < n - 1 && walked + lengths[segment] < target - 1e-12) { walked += lengths[segment]; segment += 1; }
      const a = ring[segment], b = ring[(segment + 1) % n];
      const t = lengths[segment] > 0 ? Math.min(1, Math.max(0, (target - walked) / lengths[segment])) : 0;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    return out;
  }
  /** Cumulative arc length of an open polyline ([x, y, z]); returns { lengths (per segment), total }. */
  function polylineLengths(points) {
    const lengths = [];
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1], b = points[index];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      lengths.push(length);
      total += length;
    }
    return { lengths, total };
  }
  /** Point and unit tangent at arc-length `distance` along an open polyline. */
  function polylineSample(points, lengths, distance) {
    let segment = 0, walked = 0;
    while (segment < lengths.length - 1 && walked + lengths[segment] < distance - 1e-12) { walked += lengths[segment]; segment += 1; }
    const a = points[segment], b = points[segment + 1];
    const length = lengths[segment];
    const t = length > 0 ? Math.min(1, Math.max(0, (distance - walked) / length)) : 0;
    const tangent = length > 0 ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length, (b[2] - a[2]) / length] : [1, 0, 0];
    return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], tangent };
  }
  /**
   * Straight skeleton of a simple polygon (Felkel-Obdrzalek wavefront), the shape a hip roof takes.
   * `ring` is [[x, y], ...], counter-clockwise, 3..64 points, no holes and no self-intersections.
   * Every edge is pushed inward at unit speed; two kinds of event stop a stretch of wavefront: an EDGE
   * event, where two neighbouring bisectors meet and the edge between them vanishes, and a SPLIT event,
   * where a reflex corner runs into an edge across the polygon and cuts it in two.
   * Returns { vertices: [[x, y, t], ...], faces: [[vertexIndex, ...], ...] }: `t` is the distance the
   * wavefront travelled to reach that vertex (so a roof of pitch p lifts it by t * tan(p)), the first
   * `ring.length` vertices are the footprint corners at t = 0, and face i is the roof plane over edge
   * i (ring[i] -> ring[i + 1]), wound counter-clockwise seen from above.
   * Numerically this refuses rather than guesses: a wavefront that cannot be advanced, or a face that
   * does not close, throws `mesh_invalid` naming the edge to simplify.
   */
  function straightSkeleton(ring) {
    const n = ring.length;
    if (n < 3 || n > 64) throw geometryFailure("mesh_invalid", `footprint must hold 3..64 points, got ${n}`);
    let scale = 0;
    for (const point of ring) scale = Math.max(scale, Math.abs(point[0]), Math.abs(point[1]));
    scale = scale || 1;
    const EPS = 1e-9 * scale;
    const TOUCH = 1e-7 * scale;
    const crossing = ringSelfIntersection(ring, true);
    if (crossing) throw geometryFailure("mesh_invalid", `footprint edge ${crossing[0]} crosses edge ${crossing[1]}; a roof needs a simple outline`);
    const direction = [], normal = [], offset = [];
    for (let index = 0; index < n; index += 1) {
      const a = ring[index], b = ring[(index + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (!(length > EPS)) throw geometryFailure("mesh_degenerate", `footprint point ${(index + 1) % n} repeats point ${index}`);
      direction.push([dx / length, dy / length]);
      normal.push([-dy / length, dx / length]);   // inward for a counter-clockwise ring
      offset.push(0);
    }
    for (let index = 0; index < n; index += 1) offset[index] = ring[index][0] * normal[index][0] + ring[index][1] * normal[index][1];
    // Vertices are deduplicated on a 1e-9 * scale lattice so that events that land on the same point
    // (a symmetric footprint fires several at once) become one skeleton vertex instead of a cluster.
    const vertices = [], seen = new Map();
    const addVertex = (x, y, t) => {
      const key = `${Math.round(x / EPS)},${Math.round(y / EPS)},${Math.round(t / EPS)}`;
      if (seen.has(key)) return seen.get(key);
      seen.set(key, vertices.length);
      vertices.push([x, y, t]);
      return vertices.length - 1;
    };
    for (let index = 0; index < n; index += 1) addVertex(ring[index][0], ring[index][1], 0);
    const arcs = [];
    // The bisector of two wavefront edges moves so that it stays at distance t from both.  Two edges
    // that face each other head-on (a rectangle's long sides once the short ones are gone) have no such
    // direction: their lines have already met, and everything left of the loop ends at this instant.
    // That node is kept, standing still and flagged degenerate, so the ridge between the two ends of a
    // vanished two-gon is still emitted; a degenerate node that survives into a LATER event means the
    // wavefront is inconsistent and the whole footprint is refused.
    const bisector = (previousEdge, nextEdge, where) => {
      const a = normal[previousEdge], b = normal[nextEdge];
      const dot = a[0] * b[0] + a[1] * b[1];
      if (1 + dot < 1e-9) {
        if (where !== null) throw geometryFailure("mesh_invalid", `the footprint doubles back on itself at ${where}; simplify it or split it into two roofs`);
        return null;
      }
      return [(a[0] + b[0]) / (1 + dot), (a[1] + b[1]) / (1 + dot)];
    };
    let counter = 0;
    const makeNode = (previousEdge, nextEdge, position, time, birth) => {
      const moving = bisector(previousEdge, nextEdge, birth < n ? `point ${birth}` : null);
      const velocity = moving || [0, 0];
      return {
        id: counter += 1, alive: true, degenerate: !moving, previousEdge, nextEdge, birth, time,
        velocity, origin: [position[0] - velocity[0] * time, position[1] - velocity[1] * time],
        previous: null, next: null,
      };
    };
    const at = (node, time) => [node.origin[0] + node.velocity[0] * time, node.origin[1] + node.velocity[1] * time];
    const nodes = [];
    for (let index = 0; index < n; index += 1) {
      const node = makeNode((index + n - 1) % n, index, ring[index], 0, index);
      nodes.push(node);
    }
    for (let index = 0; index < n; index += 1) {
      nodes[index].previous = nodes[(index + n - 1) % n];
      nodes[index].next = nodes[(index + 1) % n];
    }
    const isReflex = (node) => {
      const a = direction[node.previousEdge], b = direction[node.nextEdge];
      return a[0] * b[1] - a[1] * b[0] < -1e-12;
    };
    // Two bisectors meet where their difference cancels the gap between their t = 0 origins; a residual
    // means they never meet (parallel edges walking side by side), not that they meet at infinity.
    const edgeEventTime = (a, b) => {
      const dv = [a.velocity[0] - b.velocity[0], a.velocity[1] - b.velocity[1]];
      const dq = [b.origin[0] - a.origin[0], b.origin[1] - a.origin[1]];
      const denominator = dv[0] * dv[0] + dv[1] * dv[1];
      if (denominator < 1e-18) return null;
      const time = (dq[0] * dv[0] + dq[1] * dv[1]) / denominator;
      const residual = Math.hypot(dq[0] - dv[0] * time, dq[1] - dv[1] * time);
      if (residual > 1e-6 * scale) return null;
      return time;
    };
    const alive = () => nodes.filter((node) => node.alive);
    // `clock` is the time of the last event processed.  Events are accepted from a node's own birth time
    // onward, not strictly after it: a symmetric footprint fires several events at the same instant, and
    // a node born by the first of them still has to take part in the rest.  The clock keeps that from
    // reopening an event that already passed.
    let clock = 0;
    const nextEvent = () => {
      let best = null;
      const consider = (candidate) => { if (candidate && (!best || candidate.time < best.time - EPS)) best = candidate; };
      for (const node of alive()) {
        const time = edgeEventTime(node, node.next);
        if (time !== null && time > clock - EPS && time > node.time - EPS && time > node.next.time - EPS) {
          consider({ kind: "edge", time, node, other: node.next });
        }
        if (node.degenerate || !isReflex(node)) continue;
        for (const owner of alive()) {
          const edge = owner.nextEdge;
          if (edge === node.previousEdge || edge === node.nextEdge) continue;
          const speed = node.velocity[0] * normal[edge][0] + node.velocity[1] * normal[edge][1];
          if (Math.abs(speed - 1) < 1e-12) continue;
          const hitTime = (offset[edge] - (node.origin[0] * normal[edge][0] + node.origin[1] * normal[edge][1])) / (speed - 1);
          if (!(hitTime > clock - EPS) || !(hitTime > node.time - EPS) || !Number.isFinite(hitTime)) continue;
          if (hitTime <= owner.time - EPS || hitTime <= owner.next.time - EPS) continue;
          const hit = at(node, hitTime), from = at(owner, hitTime), to = at(owner.next, hitTime);
          const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
          if (!(span > EPS)) continue;
          const along = ((hit[0] - from[0]) * (to[0] - from[0]) + (hit[1] - from[1]) * (to[1] - from[1])) / span;
          if (along < -EPS || along > span + EPS) continue;
          consider({ kind: "split", time: hitTime, node, owner });
        }
      }
      return best;
    };
    const kill = (node, vertex) => {
      node.alive = false;
      if (node.birth !== vertex) arcs.push({ a: node.birth, b: vertex, faces: [node.previousEdge, node.nextEdge] });
    };
    const loopOf = (node) => {
      const list = [node];
      for (let walk = node.next; walk !== node; walk = walk.next) {
        list.push(walk);
        if (list.length > 4 * n + 8) throw geometryFailure("mesh_invalid", "the footprint's wavefront did not close; simplify it or split it into two roofs");
      }
      return list;
    };
    // Everything left of a loop dies at once when the loop has shrunk to nothing: either it closed on a
    // single point (the last two bisectors meeting), or two of its edges now lie on top of each other
    // (the degenerate node above).  Each node dies where it stands, and the segment between two
    // neighbours that died apart is a ridge -- an arc of the edge they shared, which no single node's
    // death would emit.
    const collapseLoop = (node, time) => {
      const loop = loopOf(node);
      const deaths = loop.map((member) => {
        const point = at(member, time);
        return addVertex(point[0], point[1], time);
      });
      loop.forEach((member, index) => kill(member, deaths[index]));
      for (let index = 0; index < loop.length; index += 1) {
        const a = deaths[index], b = deaths[(index + 1) % loop.length];
        if (a !== b) arcs.push({ a, b, faces: [loop[index].nextEdge] });
      }
    };
    const mergeNodes = (first, second, time, point) => {
      const vertex = addVertex(point[0], point[1], time);
      kill(first, vertex);
      kill(second, vertex);
      const merged = makeNode(first.previousEdge, second.nextEdge, point, time, vertex);
      merged.previous = first.previous;
      merged.next = second.next;
      first.previous.next = merged;
      second.next.previous = merged;
      nodes.push(merged);
      return merged;
    };
    // A degenerate node stands where its two edges have already met, so the wavefront on ONE side of it
    // is a segment with no width left: it annihilates with the nearer neighbour along that segment right
    // away, at the same time, and the segment between them becomes a ridge arc.  (Taking the whole loop
    // down instead would be wrong: an I-shaped footprint finishes its bar this way while its web is
    // still shrinking.)
    const settle = (node, time) => {
      let current = node;
      let steps = 0;
      while (current && current.alive) {
        if ((steps += 1) > 4 * n + 16) throw geometryFailure("mesh_invalid", "the footprint's wavefront never settled; simplify it or split it into two roofs");
        const loop = loopOf(current);
        if (loop.length <= 2) {
          const meeting = loop.length === 2 && !current.degenerate && !loop[1].degenerate ? edgeEventTime(loop[0], loop[1]) : null;
          collapseLoop(current, meeting !== null && meeting > time ? meeting : time);
          return;
        }
        if (!current.degenerate) return;
        const here = at(current, time), before = at(current.previous, time), after = at(current.next, time);
        const backwards = Math.hypot(here[0] - before[0], here[1] - before[1]);
        const forwards = Math.hypot(here[0] - after[0], here[1] - after[1]);
        if (Math.abs(forwards - backwards) < TOUCH && loop.length >= 5) {
          // Both neighbours sit at the far end of the strip (a waist consumed from both sides at once):
          // annihilate the three of them together, or the two that were left behind walk on in parallel
          // and the roof plane over the waist wraps around the wrong side of it.
          const previous = current.previous, next = current.next;
          const vertex = addVertex(after[0], after[1], time);
          kill(current, vertex);
          kill(previous, vertex);
          kill(next, vertex);
          const merged = makeNode(previous.previousEdge, next.nextEdge, after, time, vertex);
          merged.previous = previous.previous;
          merged.next = next.next;
          previous.previous.next = merged;
          next.next.previous = merged;
          nodes.push(merged);
          current = merged;
          continue;
        }
        current = forwards <= backwards
          ? mergeNodes(current, current.next, time, after)
          : mergeNodes(current.previous, current, time, before);
      }
    };
    let guard = 0;
    for (;;) {
      if ((guard += 1) > 8 * n + 64) throw geometryFailure("mesh_invalid", "the footprint's wavefront never settled; simplify it or split it into two roofs");
      const event = nextEvent();
      if (!event) break;
      clock = event.time;
      const stalled = alive().find((node) => node.degenerate && node.time < event.time - EPS);
      if (stalled) throw geometryFailure("mesh_invalid", `the wavefront of the footprint stalled at edge ${stalled.nextEdge}; simplify the footprint near that edge or split it into two roofs`);
      if (event.kind === "edge") {
        const { node, other } = event;
        settle(mergeNodes(node, other, event.time, at(node, event.time)), event.time);
      } else {
        const { node, owner } = event;
        const point = at(node, event.time);
        // A reflex corner that lands exactly on an END of the edge it splits has met the wavefront node
        // there, not the edge's interior: both die (a "vertex event"), and the loop still parts in two.
        // Treating it as an ordinary split leaves that node walking on alone through a region that is
        // already consumed, which shows up as a roof plane wrapped around the wrong side of a waist.
        const front = at(owner, event.time), back = at(owner.next, event.time);
        const touching = Math.hypot(point[0] - back[0], point[1] - back[1]) < TOUCH ? owner.next
          : Math.hypot(point[0] - front[0], point[1] - front[1]) < TOUCH ? owner : null;
        // Meeting its own neighbour is not a split at all: the edge between them is simply gone.
        if (touching === node.next) { settle(mergeNodes(node, node.next, event.time, point), event.time); continue; }
        if (touching === node.previous) { settle(mergeNodes(node.previous, node, event.time, point), event.time); continue; }
        const vertex = addVertex(point[0], point[1], event.time);
        kill(node, vertex);
        if (touching) kill(touching, vertex);
        const after = touching ? touching.next : owner.next;
        const before = touching ? touching.previous : owner;
        const leftEdge = touching ? touching.nextEdge : owner.nextEdge;
        const rightEdge = touching ? touching.previousEdge : owner.nextEdge;
        const left = makeNode(node.previousEdge, leftEdge, point, event.time, vertex);
        const right = makeNode(rightEdge, node.nextEdge, point, event.time, vertex);
        left.previous = node.previous;
        left.next = after;
        node.previous.next = left;
        after.previous = left;
        right.previous = before;
        right.next = node.next;
        before.next = right;
        node.next.previous = right;
        nodes.push(left, right);
        settle(left, event.time);
        settle(right, event.time);
      }
    }
    const stranded = alive();
    if (stranded.length) {
      throw geometryFailure("mesh_invalid", `the wavefront of the footprint stalled at edge ${stranded[0].nextEdge}; simplify the footprint near that edge or split it into two roofs`);
    }
    const faceArcs = Array.from({ length: n }, () => []);
    for (const arc of arcs) {
      if (arc.a === arc.b) continue;
      for (const face of arc.faces) faceArcs[face].push(arc);
    }
    const faces = [];
    for (let index = 0; index < n; index += 1) {
      const start = (index + 1) % n;
      const polygon = [index, start];
      const used = new Set();
      let current = start;
      while (current !== index) {
        const step = faceArcs[index].findIndex((arc, position) => !used.has(position) && (arc.a === current || arc.b === current));
        if (step === -1) throw geometryFailure("mesh_invalid", `the roof plane over edge ${index} does not close; simplify the footprint near that edge or split it into two roofs`);
        used.add(step);
        const arc = faceArcs[index][step];
        current = arc.a === current ? arc.b : arc.a;
        if (current !== index) polygon.push(current);
        if (polygon.length > 4 * n + 8) throw geometryFailure("mesh_invalid", `the roof plane over edge ${index} does not close; simplify the footprint near that edge or split it into two roofs`);
      }
      if (polygon.length < 3) throw geometryFailure("mesh_invalid", `the roof plane over edge ${index} collapsed; simplify the footprint near that edge or split it into two roofs`);
      faces.push(polygon);
    }
    return { vertices, faces };
  }
  /**
   * Directed edges of a face set that are used once (their reverse never appears): the eaves and rakes
   * a roof slab skirts.  The runtime builds the skirt from exactly this rule; the compiler counts it.
   */
  function roofBoundaryEdges(faces) {
    const key = (a, b) => `${a[0]},${a[1]},${a[2]}|${b[0]},${b[1]},${b[2]}`;
    const directed = new Set();
    for (const face of faces) for (let index = 0; index < face.length; index += 1) directed.add(key(face[index], face[(index + 1) % face.length]));
    let count = 0;
    for (const face of faces) {
      for (let index = 0; index < face.length; index += 1) {
        if (!directed.has(key(face[(index + 1) % face.length], face[index]))) count += 1;
      }
    }
    return count;
  }
  /**
   * Roof planning shared by the compiler (face counts) and the runtime (mesh).  `footprint` is a simple
   * polygon of 3..64 [x, y, z] points (any winding; normalised to counter-clockwise, z of the first
   * point is the eave height).  A convex quadrilateral keeps the closed-form planning it has always had
   * (`ridge` picks the ridge direction); every other outline is planned from its straight skeleton, and
   * there `gables` (edge indices, edge i = point i -> point i + 1) and `lowEdge` take over from `ridge`.
   * Returns the faces as polygons of [x, y, z] wound counter-clockwise seen from outside, the eave ring
   * the runtime skirts when the roof has a thickness, and `lane` ("quad" or "polygon") so the runtime
   * keeps the quadrilateral's triangulation and UVs byte for byte while polygons get their own.
   */
  function roofFaces(footprint, style, pitchDegrees, ridge, overhang, gables, lowEdge) {
    if (!Array.isArray(footprint) || footprint.length < 3 || footprint.length > 64) {
      throw geometryFailure("mesh_invalid", `footprint must hold 3..64 points forming a simple polygon, got ${Array.isArray(footprint) ? footprint.length : "none"}`);
    }
    if (style !== "gable" && style !== "hip" && style !== "shed") throw geometryFailure("mesh_invalid", 'style must be "gable", "hip" or "shed"');
    const z0 = footprint[0][2];
    const given = footprint.map((point) => [point[0], point[1]]);
    const reversed = ringSignedArea(given) < 0;
    let ring = reversed ? given.slice().reverse() : given;
    const count = ring.length;
    // Edge indices are authored against the footprint AS WRITTEN, so a clockwise outline that we turn
    // around has to carry its gables / lowEdge with it: edge i becomes edge n - 2 - i.
    const authoredEdge = (index) => reversed ? (count - 2 - index + count) % count : index;
    const convexQuad = count === 4 && ring.every((_unused, index) => {
      const a = ring[index], b = ring[(index + 1) % 4], c = ring[(index + 2) % 4];
      return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 1e-9;
    });
    const slope = Math.tan(pitchDegrees * Math.PI / 180);
    if (convexQuad) {
      if (gables !== undefined && gables !== null) throw geometryFailure("mesh_invalid", "gables is for polygon roofs; a convex quadrilateral picks its gable ends from ridge");
      if (lowEdge !== undefined && lowEdge !== null) throw geometryFailure("mesh_invalid", "lowEdge is for polygon roofs; a convex quadrilateral picks its low edge from ridge");
      if (overhang > 0) ring = offsetRing(ring, -overhang).ring;
      const length = (index) => Math.hypot(ring[(index + 1) % 4][0] - ring[index][0], ring[(index + 1) % 4][1] - ring[index][1]);
      const alignment = (index, axis) => { const dx = ring[(index + 1) % 4][0] - ring[index][0], dy = ring[(index + 1) % 4][1] - ring[index][1]; return Math.abs(axis === "x" ? dx : dy) / Math.hypot(dx, dy); };
      let longPairIsEven;
      if (ridge === "x" || ridge === "y") longPairIsEven = alignment(0, ridge) + alignment(2, ridge) >= alignment(1, ridge) + alignment(3, ridge);
      else longPairIsEven = length(0) + length(2) >= length(1) + length(3);
      const p = (longPairIsEven ? [0, 1, 2, 3] : [1, 2, 3, 0]).map((index) => [ring[index][0], ring[index][1], z0]);
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z0];
      const m1 = mid(p[1], p[2]), m3 = mid(p[3], p[0]);
      const span = (Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]) + Math.hypot(p[0][0] - p[3][0], p[0][1] - p[3][1])) / 2;
      const lift = (point, rise) => [point[0], point[1], point[2] + rise];
      let faces;
      if (style === "gable") {
        const rise = slope * span / 2;
        const r1 = lift(m1, rise), r3 = lift(m3, rise);
        faces = [[p[0], p[1], r1, r3], [p[2], p[3], r3, r1], [p[1], p[2], r1], [p[3], p[0], r3]];
      } else if (style === "hip") {
        const rise = slope * span / 2;
        const ridgeLength = Math.hypot(m1[0] - m3[0], m1[1] - m3[1]);
        if (ridgeLength <= span + 1e-9) {
          const apex = lift(mid(m1, m3), rise);
          faces = [[p[0], p[1], apex], [p[1], p[2], apex], [p[2], p[3], apex], [p[3], p[0], apex]];
        } else {
          const d = [(m1[0] - m3[0]) / ridgeLength, (m1[1] - m3[1]) / ridgeLength];
          const r1 = lift([m1[0] - d[0] * span / 2, m1[1] - d[1] * span / 2, z0], rise);
          const r3 = lift([m3[0] + d[0] * span / 2, m3[1] + d[1] * span / 2, z0], rise);
          faces = [[p[0], p[1], r1, r3], [p[2], p[3], r3, r1], [p[1], p[2], r1], [p[3], p[0], r3]];
        }
      } else {
        const rise = slope * span;
        const h2 = lift(p[2], rise), h3 = lift(p[3], rise);
        faces = [[p[0], p[1], h2, h3], [p[2], p[3], h3, h2], [p[1], p[2], h2], [p[3], p[0], h3]];
      }
      return { faces, eave: p, lane: "quad" };
    }
    if (ridge !== undefined && ridge !== null && ridge !== "auto") {
      throw geometryFailure("mesh_invalid", "polygon roofs derive the ridge from the skeleton; use gables (for gable) or lowEdge (for shed) instead of ridge");
    }
    if (overhang > 0) {
      const inset = offsetRing(ring, -overhang);
      if (inset.flipped !== -1) throw geometryFailure("mesh_invalid", `an overhang of ${overhang} turns edge ${authoredEdge(inset.flipped)} inside out; use a smaller overhang`);
      ring = inset.ring;
    }
    const eave = ring.map((point) => [point[0], point[1], z0]);
    if (style === "shed") {
      const low = lowEdge === undefined || lowEdge === null ? 0 : lowEdge;
      if (!Number.isInteger(low) || low < 0 || low >= count) throw geometryFailure("mesh_invalid", `lowEdge must be an edge index in 0..${count - 1}`);
      const index = reversed ? (count - 2 - low + count) % count : low;
      const a = ring[index], b = ring[(index + 1) % count];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!(length > 0)) throw geometryFailure("mesh_degenerate", `footprint edge ${low} has zero length`);
      const inward = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
      const face = ring.map((point) => {
        const distance = (point[0] - a[0]) * inward[0] + (point[1] - a[1]) * inward[1];
        return [point[0], point[1], z0 + Math.max(0, distance) * slope];
      });
      return { faces: [face], eave, lane: "polygon" };
    }
    const skeleton = straightSkeleton(ring);
    const points = skeleton.vertices.map(([x, y, t]) => [x, y, z0 + t * slope]);
    let polygons = skeleton.faces.map((face) => face.slice());
    if (style === "gable") {
      const triangleApex = (face) => (face.length === 3 && face[2] >= count ? face[2] : -1);
      let wanted;
      if (gables === undefined || gables === null) {
        wanted = polygons.map((face, index) => (triangleApex(face) !== -1 ? index : -1)).filter((index) => index !== -1);
        if (!wanted.length) throw geometryFailure("mesh_invalid", "no edge of this footprint ends in a triangle, so none of them can be a gable; use style \"hip\", or name the gable edges explicitly");
      } else {
        if (!Array.isArray(gables) || !gables.length) throw geometryFailure("mesh_invalid", "gables must list at least one edge index");
        wanted = gables.map((value) => {
          if (!Number.isInteger(value) || value < 0 || value >= count) throw geometryFailure("mesh_invalid", `gables entry ${value} is not an edge index in 0..${count - 1}`);
          const index = reversed ? (count - 2 - value + count) % count : value;
          if (triangleApex(polygons[index]) === -1) {
            const usable = polygons.map((face, position) => (triangleApex(face) !== -1 ? authoredEdge(position) : -1)).filter((position) => position !== -1).sort((a, b) => a - b);
            throw geometryFailure("mesh_invalid", `edge ${value} does not end in a triangle, so it cannot be a gable; the gable edges of this footprint are ${usable.length ? usable.join(", ") : "none"}`);
          }
          return index;
        });
      }
      const claimed = new Map();
      for (const index of wanted) {
        const apex = triangleApex(polygons[index]);
        if (claimed.has(apex)) throw geometryFailure("mesh_invalid", `edges ${authoredEdge(claimed.get(apex))} and ${authoredEdge(index)} would both pull the same skeleton point onto their wall; gable only one of them`);
        claimed.set(apex, index);
      }
      // Laycock & Day: slide the ridge end onto the middle of its edge, keeping its height.  The two
      // neighbouring planes follow it (they share the moved vertex), and the gabled edge's own plane
      // becomes the vertical wall it is in a real gable -- the same four-face shape the quad lane emits.
      for (const [apex, index] of claimed) {
        const a = ring[index], b = ring[(index + 1) % count];
        points[apex] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, points[apex][2]];
      }
    }
    const faces = polygons.map((face) => face.map((index) => points[index].slice()));
    return { faces, eave, lane: "polygon" };
  }
  /** Stair flight outline in the (x, z) plane, counter-clockwise with x right and z up. */
  function stairsOutline(steps, rise, run, landing) {
    const end = steps * run + landing, top = steps * rise;
    const outline = [[0, 0], [end, 0], [end, top]];
    if (landing > 0) outline.push([steps * run, top]);
    for (let index = steps - 1; index >= 0; index -= 1) {
      outline.push([index * run, (index + 1) * rise]);
      if (index > 0) outline.push([index * run, index * rise]);
    }
    return outline;
  }
  const GEOMETRY_ALGORITHMS = Object.freeze({
    version: GEOMETRY_ALGORITHMS_VERSION, catmullRomResample, ringSignedArea, segmentsIntersect, ringSelfIntersection,
    earcutRings, offsetRing, latticeHash, valueNoise2, fbm2, resampleClosedRing, polylineLengths, polylineSample,
    roofFaces, straightSkeleton, roofBoundaryEdges, stairsOutline,
  });
  // ---- end shared procedural-geometry algorithms --------------------------------------------
export { GEOMETRY_ALGORITHMS };
/**
 * Parametric mesh generators: vertex/triangle counts from the compiled (constant) parameters. The
 * browser runtime builds the same meshes from the same parameters, so the IR carries parameters only.
 */
/**
 * heights counts grid corners, not cells, and `columns * rows` is by far the most common miss: the
 * author counts the quads they drew. Name that mistake and hand over both repairs (resize the list,
 * or shrink columns/rows) instead of restating the formula the message already carries.
 */
function heightsHint(columns, rows, got) {
  if (got < 0) return "; heights is a list of numbers on one line, e.g. heights: [0, 0, 0, 0]";
  if (got === columns * rows) {
    const fix = columns > 1 && rows > 1 ? `, or keep the list and write columns: ${columns - 1}; rows: ${rows - 1}` : "";
    return `, which is columns * rows: that counts the cells, and heights are the corners around them`
      + ` (a ${columns}x${rows} field has ${columns + 1}x${rows + 1} corners), so add ${expectedCorners(columns, rows) - got} more values${fix}`;
  }
  const fit = cornerFactors(got);
  if (fit) return `; ${got} values fit columns: ${fit[0]}; rows: ${fit[1]}`;
  return "";
}
const expectedCorners = (columns, rows) => (columns + 1) * (rows + 1);
/** The squarest columns/rows whose corner count is exactly `total`, so the author can keep the list they have. */
function cornerFactors(total) {
  if (total < 4) return null;
  let best = null;
  for (let a = 2; a * a <= total; a += 1) {
    if (total % a) continue;
    const b = total / a;
    if (a - 1 < 1 || b - 1 > 4096) continue;
    if (!best || b / a < best[1] / best[0]) best = [a, b];
  }
  return best ? [best[0] - 1, best[1] - 1] : null;
}

const choice = (value, name, allowed, fallback) => {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) meshFail("mesh_invalid", `${name} must be one of ${allowed.map((item) => `"${item}"`).join(", ")}`);
  return value;
};
const number = (value, name, min, max, exclusiveMin = false) => {
  if (!Number.isFinite(value) || !(exclusiveMin ? value > min : value >= min) || !(value <= max)) {
    meshFail("mesh_invalid", `${name} must be ${exclusiveMin ? ">" : ">="} ${min}${Number.isFinite(max) ? ` and <= ${max}` : ""}`);
  }
  return value;
};
const flag = (value, name, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") meshFail("mesh_invalid", `${name} must be true or false`);
  return value;
};
/** smooth/samples: resample the control points BEFORE the budget and degeneracy checks (same as the runtime). */
const smoothed = (props, points, closed) => {
  const smooth = choice(props.smooth, "smooth", ["none", "catmullrom"], "none");
  if (smooth === "none") {
    if (props.samples !== undefined) meshFail("mesh_invalid", 'samples needs smooth: "catmullrom"');
    return points;
  }
  const samples = props.samples === undefined ? 4 : integer(props.samples, "samples", 1, 16);
  return points.length < 2 ? points : GEOMETRY_ALGORITHMS.catmullRomResample(points, samples, closed);
};
/** A planar ring from [x, y(, z)] points: repeats and zero area are mesh_degenerate, crossings mesh_invalid. */
const planarRing = (ring, name, counterClockwise, pick = (point) => [point[0], point[1]]) => {
  if (!Array.isArray(ring) || ring.length < 3) meshFail("mesh_invalid", `${name} needs at least 3 points`);
  const points = ring.map(pick);
  for (let index = 1; index < points.length; index += 1) {
    if (Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]) <= 1e-9) {
      meshFail("mesh_degenerate", `${name}[${index}] repeats ${name}[${index - 1}]`);
    }
  }
  const crossing = GEOMETRY_ALGORITHMS.ringSelfIntersection(points, true);
  if (crossing) meshFail("mesh_invalid", `${name} crosses itself (edge ${crossing[0]} against edge ${crossing[1]})`);
  const area = GEOMETRY_ALGORITHMS.ringSignedArea(points);
  if (Math.abs(area) <= 1e-12) meshFail("mesh_degenerate", `${name} has no area`);
  if ((area < 0) === counterClockwise) points.reverse();
  return points;
};
/** The open-path checks Tube and Sweep share: a repeated point has no tangent, a reversal has no frame. */
const checkOpenPath = (path, name) => {
  const length = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  for (let index = 1; index < path.length; index += 1) {
    if (length(path[index - 1], path[index]) < 1e-9) {
      meshFail("mesh_degenerate", `${name}[${index}] repeats ${name}[${index - 1}], so that segment has no direction and the frame is undefined`);
    }
  }
  for (let index = 1; index < path.length - 1; index += 1) {
    const before = path[index], previous = path[index - 1], next = path[index + 1];
    const a = [before[0] - previous[0], before[1] - previous[1], before[2] - previous[2]];
    const b = [next[0] - before[0], next[1] - before[1], next[2] - before[2]];
    const la = Math.hypot(...a), lb = Math.hypot(...b);
    const cosine = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
    if (cosine <= -1 + 1e-9) {
      meshFail("mesh_degenerate", `${name} folds back on itself at ${name}[${index}] (the incoming and outgoing directions are opposite), so there is no frame there; round the corner with an intermediate point`);
    }
  }
};
const offsetChecked = (outer, holes, distance, name) => {
  const result = GEOMETRY_ALGORITHMS.offsetRing(outer, distance);
  if (result.flipped !== -1) meshFail("mesh_invalid", `${name} ${distance} m eats outer edge ${result.flipped} (the inset outline flips there); use a smaller value`);
  const holeRings = holes.map((hole, index) => {
    const offset = GEOMETRY_ALGORITHMS.offsetRing(hole, -distance);
    if (offset.flipped !== -1) meshFail("mesh_invalid", `${name} ${distance} m eats holes[${index}] edge ${offset.flipped}; use a smaller value`);
    return offset.ring;
  });
  return { outer: result.ring, holes: holeRings };
};

export const MESH_GENERATORS = Object.freeze({
  HeightField(props) {
    const columns = integer(props.columns, "columns", 1, 4096), rows = integer(props.rows, "rows", 1, 4096);
    if (!(props.width > 0) || !(props.depth > 0)) meshFail("mesh_invalid", "width and depth must be > 0");
    const noise = choice(props.noise, "noise", ["fbm"], null);
    if (noise) {
      if (!Number.isInteger(props.seed) || props.seed < 0 || props.seed > 4294967295) meshFail("mesh_invalid", "seed must be an integer in 0..4294967295 (required with noise)");
      if (props.frequency !== undefined) number(props.frequency, "frequency", 0, Infinity, true);
      if (props.amplitude !== undefined) number(props.amplitude, "amplitude", 0, Infinity, true);
      if (props.octaves !== undefined) integer(props.octaves, "octaves", 1, 8);
    } else {
      for (const name of ["seed", "frequency", "amplitude", "octaves"]) if (props[name] !== undefined) meshFail("mesh_invalid", `${name} needs noise: "fbm"`);
      if (props.heights === undefined) meshFail("mesh_invalid", 'heights is required unless noise: "fbm" generates the terrain');
    }
    const expected = (columns + 1) * (rows + 1);
    if (props.heights !== undefined || !noise) {
      const got = Array.isArray(props.heights) ? props.heights.length : -1;
      if (got !== expected) meshFail("mesh_invalid", `heights needs (columns+1)*(rows+1) = ${expected} values (row-major, first row at -depth/2), got ${got < 0 ? "no list" : got}${heightsHint(columns, rows, got)}`);
    }
    return { vertices: expected, triangles: 2 * columns * rows };
  },
  Lathe(props) {
    const segments = integer(props.segments, "segments", 3, 256);
    const flat = flag(props.flat, "flat", false);
    const profile = smoothed(props, props.profile || [], false);
    const where = props.smooth === "catmullrom" ? " (after smoothing)" : "";
    if (profile.length < 2) meshFail("mesh_invalid", "profile needs at least 2 points ([radius, 0, height] each)");
    if (profile.some((point) => point[0] < 0)) meshFail("mesh_invalid", `profile radius (x) must be >= 0${where}`);
    // A zero radius collapses a whole ring onto the axis, so every quad in the band beside it has a
    // degenerate triangle and the native mesh builder refuses the SCENE MODULE, not just this node.
    // Catch it here, where the node and the offending index can still be named.
    const zero = profile.findIndex((point) => point[0] === 0);
    if (zero !== -1) meshFail("mesh_degenerate", `profile[${zero}]${where} has radius 0, which collapses that ring onto the axis and makes every triangle in the band beside it degenerate (the engine rejects the whole scene module with "triangle is degenerate"); give a tip a small positive radius such as 0.02 instead of 0`);
    for (let index = 1; index < profile.length; index += 1) {
      if (profile[index][0] === profile[index - 1][0] && profile[index][2] === profile[index - 1][2]) {
        meshFail("mesh_degenerate", `profile[${index}] repeats profile[${index - 1}]${where} (same radius and height), so the band between them has zero area and its triangles are degenerate`);
      }
    }
    const caps = props.closed ? 2 : 0;
    // flat duplicates every interior ring so each profile edge owns its band of normals.
    const rings = flat ? 2 * (profile.length - 1) : profile.length;
    return { vertices: rings * segments + caps, triangles: 2 * (profile.length - 1) * segments + caps * segments };
  },
  Tube(props) {
    const segments = integer(props.segments, "segments", 3, 64);
    const path = smoothed(props, props.path || [], false);
    if (path.length < 2) meshFail("mesh_invalid", "path needs at least 2 points");
    if (!(props.radius > 0)) meshFail("mesh_invalid", "radius must be > 0");
    // The runtime builds a parallel-transport frame along the path: a repeated point has no tangent and
    // a 180-degree reversal has no frame, and both come back as a dead scene module at mount.  (A purely
    // vertical segment is fine: the frame switches its reference axis when |tangent.z| >= 0.9.)
    checkOpenPath(path, "path");
    const caps = props.closed ? 2 : 0;
    return { vertices: path.length * segments + caps, triangles: 2 * (path.length - 1) * segments + caps * segments };
  },
  Loft(props) {
    let sections = props.sections || [];
    if (sections.length < 2) meshFail("mesh_invalid", "sections needs at least 2 rings");
    const resample = flag(props.resample, "resample", false), closed = flag(props.closed, "closed", false), cap = flag(props.cap, "cap", false);
    if (closed && cap) meshFail("mesh_invalid", "cap is not allowed with closed: a closed loft has no ends");
    if (sections.some((ring) => ring.length < 3)) meshFail("mesh_invalid", "every section needs at least 3 points");
    if (resample) {
      const target = Math.max(...sections.map((ring) => ring.length));
      sections = sections.map((ring, index) => {
        try { return GEOMETRY_ALGORITHMS.resampleClosedRing(ring, target); } catch (error) { return meshFail(error.code || "mesh_invalid", `sections[${index}] ${error.message}`); }
      });
    }
    const count = sections[0].length;
    if (sections.some((ring) => ring.length !== count)) meshFail("mesh_invalid", "every section needs the same number of points (>= 3), or set resample: true to let the compiler even them out");
    const smooth = choice(props.smooth, "smooth", ["none", "catmullrom"], "none");
    if (smooth === "catmullrom") {
      const samples = props.samples === undefined ? 4 : integer(props.samples, "samples", 1, 16);
      const columns = Array.from({ length: count }, (_, j) => GEOMETRY_ALGORITHMS.catmullRomResample(sections.map((ring) => ring[j]), samples, closed));
      sections = Array.from({ length: columns[0].length }, (_, k) => columns.map((column) => column[k]));
    } else if (props.samples !== undefined) meshFail("mesh_invalid", 'samples needs smooth: "catmullrom"');
    // Rings are stitched into quads in order, so a repeated point inside a ring or a repeated ring
    // produces zero-area quads and the native builder refuses the whole scene module.
    const same = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < 1e-9;
    for (let ring = 0; ring < sections.length; ring += 1) {
      for (let index = 1; index < count; index += 1) {
        if (same(sections[ring][index - 1], sections[ring][index])) {
          meshFail("mesh_degenerate", `sections[${ring}][${index}] repeats the point before it, so that quad column has zero area`);
        }
      }
    }
    for (let ring = 1; ring < sections.length; ring += 1) {
      if (sections[ring].every((point, index) => same(point, sections[ring - 1][index]))) {
        meshFail("mesh_degenerate", `sections[${ring}] repeats sections[${ring - 1}] point for point, so the band between them has zero area`);
      }
    }
    const rings = closed ? sections.length + 1 : sections.length;
    const caps = cap ? 2 : 0;
    return { vertices: rings * count + caps, triangles: 2 * (rings - 1) * count + caps * count };
  },
  Sweep(props) {
    const closedProfile = flag(props.closedProfile, "closedProfile", true), cap = flag(props.cap, "cap", false);
    const flat = flag(props.flat, "flat", false);
    if (cap && !closedProfile) meshFail("mesh_invalid", "cap needs a closed profile");
    if (props.twist !== undefined) number(props.twist, "twist", -Infinity, Infinity);
    if (props.scaleEnd !== undefined) number(props.scaleEnd, "scaleEnd", 0, 10, true);
    let profile = props.profile || [];
    if (closedProfile) profile = planarRing(profile, "profile", true, (point) => [point[0], point[2]]);
    else {
      if (profile.length < 2) meshFail("mesh_invalid", "profile needs at least 2 points");
      for (let index = 1; index < profile.length; index += 1) {
        if (Math.hypot(profile[index][0] - profile[index - 1][0], profile[index][2] - profile[index - 1][2]) <= 1e-9) meshFail("mesh_degenerate", `profile[${index}] repeats profile[${index - 1}]`);
      }
    }
    const path = smoothed(props, props.path || [], false);
    if (path.length < 2) meshFail("mesh_invalid", "path needs at least 2 points");
    checkOpenPath(path, "path");
    const P = profile.length, L = path.length;
    // flat gives every profile edge its own two-vertex band per ring: same triangles, twice the vertices
    // on a closed profile (the caps stay one vertex per profile point).
    const bands = closedProfile ? P : P - 1, ringSize = flat ? 2 * bands : P;
    return { vertices: ringSize * L + (cap ? 2 * P : 0), triangles: 2 * (L - 1) * bands + (cap ? 2 * (P - 2) : 0) };
  },
  Torus(props) {
    const radius = number(props.radius, "radius", 0, Infinity, true), tube = number(props.tube, "tube", 0, Infinity, true);
    if (!(tube < radius)) meshFail("mesh_invalid", "tube must be less than radius");
    const segments = integer(props.segments, "segments", 3, 256), tubeSegments = integer(props.tubeSegments, "tubeSegments", 3, 64);
    return { vertices: segments * (tubeSegments + 1), triangles: 2 * segments * tubeSegments };
  },
  Mesh(props) {
    const vertices = props.vertices, faces = props.faces;
    if (!Array.isArray(vertices) || vertices.length < 9 || vertices.length % 3 !== 0) meshFail("mesh_invalid", "vertices must be a flat [x, y, z, ...] list with at least 3 corners (length a multiple of 3)");
    const vertexCount = vertices.length / 3;
    if (!Array.isArray(faces) || faces.length < 3 || faces.length % 3 !== 0) meshFail("mesh_invalid", "faces must be a flat [a, b, c, ...] triangle index list (length a multiple of 3)");
    const bad = faces.findIndex((value) => !Number.isInteger(value) || value < 0 || value >= vertexCount);
    if (bad !== -1) meshFail("mesh_invalid", `faces[${bad}] is ${faces[bad]}, not an integer in 0..${vertexCount - 1}`);
    if (props.uvs !== undefined && (!Array.isArray(props.uvs) || props.uvs.length !== 2 * vertexCount)) meshFail("mesh_invalid", `uvs must hold 2 * ${vertexCount} numbers`);
    const shading = choice(props.shading, "shading", ["flat", "smooth"], "flat");
    const faceCount = faces.length / 3;
    for (let face = 0; face < faceCount; face += 1) {
      const [a, b, c] = [0, 1, 2].map((corner) => vertices.slice(3 * faces[3 * face + corner], 3 * faces[3 * face + corner] + 3));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      if (!(area > 1e-12)) meshFail("mesh_degenerate", `faces[${face}] (corners ${faces[3 * face]}, ${faces[3 * face + 1]}, ${faces[3 * face + 2]}) has zero area`);
    }
    return { vertices: shading === "flat" ? 3 * faceCount : vertexCount, triangles: faceCount };
  },
  Roof(props) {
    const footprint = props.footprint || [];
    const style = choice(props.style, "style", ["gable", "hip", "shed"], undefined);
    if (style === undefined) meshFail("mesh_invalid", "style is required");
    const pitch = number(props.pitch, "pitch", 0, 85, true);
    const ridge = choice(props.ridge, "ridge", ["auto", "x", "y"], "auto");
    const overhang = props.overhang === undefined ? 0 : number(props.overhang, "overhang", 0, Infinity);
    const thickness = props.thickness === undefined ? 0 : number(props.thickness, "thickness", 0, Infinity);
    let gables;
    if (props.gables !== undefined) {
      if (!Array.isArray(props.gables) || !props.gables.length) meshFail("mesh_invalid", "gables must list at least one edge index");
      gables = props.gables.map((value, index) => integer(value, `gables[${index}]`, 0, 63));
    }
    const lowEdge = props.lowEdge === undefined ? undefined : integer(props.lowEdge, "lowEdge", 0, 63);
    let faces;
    try { faces = GEOMETRY_ALGORITHMS.roofFaces(footprint, style, pitch, ridge, overhang, gables, lowEdge).faces; } catch (error) { meshFail(error.code || "mesh_invalid", error.message); }
    let vertices = faces.reduce((sum, face) => sum + face.length, 0), triangles = faces.reduce((sum, face) => sum + face.length - 2, 0);
    // The skirt follows the boundary of the face set, which is four edges on a quadrilateral and one per
    // footprint edge on a polygon -- counting it, rather than assuming four, is what keeps the budget
    // honest once the outline is no longer a quad.
    if (thickness > 0) {
      const boundary = GEOMETRY_ALGORITHMS.roofBoundaryEdges(faces);
      vertices = 2 * vertices + 4 * boundary;
      triangles = 2 * triangles + 2 * boundary;
    }
    return { vertices, triangles };
  },
  Stairs(props) {
    const steps = integer(props.steps, "steps", 1, 1024);
    number(props.rise, "rise", 0, Infinity, true); number(props.run, "run", 0, Infinity, true); number(props.width, "width", 0, Infinity, true);
    const solid = flag(props.solid, "solid", true);
    if (props.tread !== undefined) number(props.tread, "tread", 0, Infinity, true);
    const landing = props.landing === undefined ? 0 : number(props.landing, "landing", 0, Infinity);
    if (solid) {
      const n = GEOMETRY_ALGORITHMS.stairsOutline(steps, props.rise, props.run, landing).length;
      return { vertices: 6 * n, triangles: 2 * n + 2 * (n - 2) };
    }
    const slabs = steps + (landing > 0 ? 1 : 0);
    return { vertices: 24 * slabs, triangles: 12 * slabs };
  },
  /** Only the generated-mesh lane (bevel / taper / a non-z axis) is estimated; the native lane returns null. */
  ExtrudedPolygon(props) {
    const axis = choice(props.axis, "axis", ["z", "x", "y"], "z");
    if (!props.bevel && !props.taper && axis === "z") return null;
    const height = number(props.height, "height", 0, Infinity, true);
    const outer = planarRing(props.outer || [], "outer", true);
    const holes = (props.holes || []).map((ring, index) => planarRing(ring, `holes[${index}]`, false));
    const points = outer.length + holes.reduce((sum, ring) => sum + ring.length, 0);
    if (points > 512) meshFail("mesh_invalid", `bevel/taper/axis extrusions are limited to 512 ring points in total (got ${points})`);
    const cap = flag(props.cap, "cap", true);
    const bevel = props.bevel ? number(props.bevel, "bevel", 0, height, true) : 0;
    if (bevel >= height) meshFail("mesh_invalid", "bevel must be less than height");
    const taper = props.taper ? number(props.taper, "taper", 0, Infinity, true) : 0;
    const top = taper > 0 ? offsetChecked(outer, holes, taper, "taper") : { outer, holes };
    if (bevel > 0) offsetChecked(top.outer, top.holes, bevel, "bevel");
    const bands = bevel > 0 ? 2 : 1;
    const capTriangles = points + 2 * holes.length - 2;
    return { vertices: bands * points * 4 + (cap ? 2 * points : 0), triangles: bands * points * 2 + (cap ? 2 * capTriangles : 0) };
  },
});

/** Native primitives whose parameters the engine would refuse at mount, checked here so the node gets named. */
export const PRIMITIVE_CHECKS = Object.freeze({
  Capsule(props) {
    const radius = number(props.radius, "radius", 0, Infinity, true), height = number(props.height, "height", 0, Infinity, true);
    if (!(height > 2 * radius)) meshFail("mesh_invalid", "height must exceed 2 * radius (the two hemispheres alone are 2 * radius tall)");
    const segments = integer(props.segments, "segments", 8, 256);
    if (segments % 4 !== 0) meshFail("mesh_invalid", "segments must be divisible by four");
  },
});

const PLACEMENT_MEMBERS = Object.freeze({
  explicit: ["positions"], grid: ["origin", "spacing", "columns"],
  ring: ["center", "radius", "startAngle", "faceCenter"], along_path: ["path", "step", "alignToPath", "smooth", "samples"],
});
const INSTANCES_MAX_PER_BATCH = 512;
const INSTANCES_MAX_PER_PREFAB = 2048;
// Indexed by instance, not by polyline vertex.  INSTANCES_PER_INSTANCE_POINTS are the vector3_lists the
// generic 2..256 point rule must not reach (Instances.path is deliberately absent -- it IS a polyline);
// INSTANCES_POSE_LISTS are the lists that must hold exactly one entry per instance.
const INSTANCES_PER_INSTANCE_POINTS = Object.freeze(["positions", "rotations", "scales"]);
const INSTANCES_POSE_LISTS = Object.freeze(["rotations", "scales", "rotations_z", "scales_uniform"]);
/** Instances placement: every mode's members, its instance count and the auto-yaw exclusivity, mirrored from the runtime. */
export function checkInstances(props) {
  const placementFail = (message) => { throw Object.assign(new Error(message), { code: "placement_invalid" }); };
  const placement = props.placement ?? (props.positions !== undefined ? "explicit" : "grid");
  if (!Object.hasOwn(PLACEMENT_MEMBERS, placement)) placementFail('placement must be "explicit", "grid", "ring" or "along_path"');
  for (const [mode, names] of Object.entries(PLACEMENT_MEMBERS)) {
    if (mode === placement) continue;
    for (const name of names) if (props[name] !== undefined) placementFail(`${name} belongs to ${mode} placement, not ${placement}`);
  }
  let count, autoYaw = null;
  if (placement === "explicit") {
    if (!Array.isArray(props.positions)) placementFail("positions must be a list of [x, y, z]");
    // positions: [] is a DYNAMIC batch -- it renders nothing until host JS calls api.instances.set().
    count = props.positions.length;
    if (props.count !== undefined && props.count !== count) placementFail(`count (${props.count}) must match the number of positions (${count})`);
  } else if (placement === "grid") {
    if (!Number.isInteger(props.count) || props.count < 1) placementFail("count must be a positive integer");
    count = props.count;
  } else if (placement === "ring") {
    if (!Number.isInteger(props.count) || props.count < 1) placementFail("count must be a positive integer");
    count = props.count;
    if (!(props.radius > 0)) placementFail("radius must be > 0 metres");
    if (props.faceCenter === true) autoYaw = "faceCenter";
  } else {
    let path = props.path || [];
    if (path.length < 2) placementFail("path needs at least 2 points");
    try { path = smoothed(props, path, false); } catch (error) { placementFail(error.message); }
    const { total } = GEOMETRY_ALGORITHMS.polylineLengths(path);
    if (!(total > 0)) placementFail("path has no length");
    if ((props.step === undefined) === (props.count === undefined)) placementFail("along_path needs exactly one of step or count");
    if (props.step !== undefined) {
      if (!(props.step > 0)) placementFail("step must be > 0 metres");
      count = Math.floor(total / props.step + 1e-9) + 1;
    } else {
      if (!Number.isInteger(props.count) || props.count < 1) placementFail("count must be a positive integer");
      count = props.count;
    }
    if (props.alignToPath === true) autoYaw = "alignToPath";
  }
  if (count > INSTANCES_MAX_PER_BATCH) placementFail(`${placement} placement would create ${count} instances (limit ${INSTANCES_MAX_PER_BATCH} per batch)`);
  const rotationSources = ["rotations", "rotations_z", "rotation_z"].filter((name) => props[name] !== undefined);
  if (autoYaw && rotationSources.length) placementFail(`${autoYaw} already sets every instance's yaw; drop ${rotationSources.join(" / ")}`);
  // The runtime refuses both of these with an invariant, which surfaces as a page that fails to mount
  // long after a green compile receipt.  Same rules, checked where the author can still read them.
  if (rotationSources.length > 1) placementFail(`only one of rotations / rotations_z / rotation_z may be given, not ${rotationSources.join(" + ")}`);
  const scaleSources = ["scales", "scales_uniform", "scale"].filter((name) => props[name] !== undefined);
  if (scaleSources.length > 1) placementFail(`only one of scales / scales_uniform / scale may be given, not ${scaleSources.join(" + ")}`);
  for (const name of INSTANCES_POSE_LISTS) {
    const list = props[name];
    if (list !== undefined && Array.isArray(list) && list.length !== count) {
      placementFail(`${name} must hold exactly one entry per instance (${count} under ${placement} placement), not ${list.length}`);
    }
  }
  return { placement, count, dynamic: placement === "explicit" && count === 0 };
}

// Fragment accounting. These are the same rules the MCP receipt's budgetUsage() applies to a whole
// scene; a fragment has to charge them the same way, because spawn checks "static used + dynamic
// used + this fragment" against ONE ledger. The equality is pinned by a test that compiles a
// component both ways and compares the two numbers item by item.
const FRAGMENT_NATIVE_ADAPTERS = new Set(["geometry", "group", "model"]);
const FRAGMENT_NATIVE_TYPES = new Set(["Label", "PostProcessVolume", "Prefab"]);
const FRAGMENT_OWNED_LIGHTS = new Set(["PointLight", "SpotLight", "RectLight"]);
const FRAGMENT_TIMELINE_TYPES = new Set(["NumberAnimation", "Vector3dAnimation", "ColorAnimation", "RotationAnimation", "QuaternionAnimation", "ParallelAnimation", "SequentialAnimation"]);
const FRAGMENT_TIMELINE_CONTAINERS = new Set(["ParallelAnimation", "SequentialAnimation", "Behavior"]);

const nodeValue = (node, property) => node.properties?.find((item) => item.property === property)?.value;

function isNativeObjectType(node) {
  const type = node.type;
  if (FRAGMENT_NATIVE_TYPES.has(type) || FRAGMENT_OWNED_LIGHTS.has(type)) return true;
  if (type === "DirectionalLight") return nodeValue(node, "atmosphereSunLight") !== true;
  return FRAGMENT_NATIVE_ADAPTERS.has(catalog.components[type]?.adapter) || type.includes("Mesh");
}

function fragmentBudget(nodes, bindings) {
  const types = new Map(nodes.map((node) => [node.id, node.type]));
  const textures = new Set();
  for (const node of nodes) {
    if (node.type !== "Texture") continue;
    const source = nodeValue(node, "source");
    textures.add(source && typeof source === "object"
      ? `digest:${source.content_digest || source.asset_id || node.id}`
      : `path:${String(source)}`);
  }
  let instances = 0;
  for (const node of nodes.filter((item) => item.type === "Instances")) {
    const props = Object.fromEntries((node.properties || []).map((item) => [item.property, item.value]));
    try { instances += checkInstances(props).count; } catch { instances += Array.isArray(props.positions) ? props.positions.length : 0; }
  }
  return {
    native_objects: nodes.filter(isNativeObjectType).length,
    materials: nodes.filter((node) => catalog.components[node.type]?.adapter === "material" || node.type.endsWith("Material")).length,
    textures: textures.size,
    bindings: bindings.length,
    handlers: nodes.reduce((sum, node) => sum + (node.handlers?.length || 0), 0),
    timers: nodes.filter((node) => node.type === "Timer").length,
    locators: nodes.filter((node) => node.type === "Group").length,
    prefabs: nodes.filter((node) => node.type === "Prefab").length,
    instances,
    timelines: nodes.filter((node) => FRAGMENT_TIMELINE_TYPES.has(node.type)
      && !FRAGMENT_TIMELINE_CONTAINERS.has(types.get(node.parent))).length,
  };
}

// Components a fragment may not carry. Each one is a scene singleton (one clock, one sun, one globe,
// one camera) or claims a window-wide input; 300 copies of it is never what the author meant, and the
// failure it causes at mount (multiple_writer, or 300 competing key handlers) reads as nothing at all.
const FRAGMENT_FORBIDDEN_TYPES = Object.freeze({
  Camera: "one scene has one camera", CameraView: "declare views in scene.ssdl and aim the scene camera",
  Environment: "the clock is scene-global", SunSky: "the sun is scene-global",
  SkyAtmosphere: "the atmosphere is scene-global", SkyLight: "the sky light is scene-global",
  ExponentialHeightFog: "fog is scene-global", VolumetricCloud: "clouds are scene-global",
  PostProcessVolume: "grading is scene-global", DirectionalLight: "the sun is scene-global; use PointLight / SpotLight / RectLight inside a part",
  Globe: "the globe is scene-global", ImageryLayer: "imagery is scene-global",
  Tileset: "a tileset is scene-global", GeoJsonLayer: "a feature layer is scene-global",
  KeyHandler: "a key handler claims a key for the whole window, so one per spawned copy would fire all of them at once; put it in scene.ssdl",
  PointerHandler: "a pointer handler listens on the whole window; put it in scene.ssdl and dispatch from host JS",
});

function runtimeProperty(component, property) {
  return catalog.components[component]?.members[property]?.runtime_property || property;
}

function compileDocument(document, source, options = {}) {
  if (document.root.type !== "Scene") fail("unsupported_component_root", document.root);
  const rootFields = assignments(document.root);
  const rootId = nodeId(document.root, rootFields);
  const hostInterfaces = validateHostInterfaces(options.hostInterfaces);
  const declarations = new Map();
  const symbols = { rootId, declarations, nodes: new Map([[rootId, document.root]]), types: new Map() };
  const logicalProperties = [];
  // Fragment mode: the reserved parameter node is the only thing a fragment's expressions read that
  // is not a node of its own. Its "values" are the declared defaults, so every constant the compiler
  // folds (and every mesh and budget estimate it makes) is the default instantiation of the part.
  const fragment = options.fragment || null;
  const fragmentParameters = new Map();
  const parameterSlots = [];
  if (fragment) {
    symbols.nodes.set(FRAGMENT_PARAMS_ID, { type: "$FragmentParameters", members: [] });
    for (const parameter of fragment.parameters) {
      const descriptor = catalog.property_types[parameter.type];
      if (!descriptor) fail("spawnable_invalid", parameter.default_ast, `unsupported spawnable property type '${parameter.type}'`);
      const expected = typeSpec(descriptor.value_type, descriptor.unit);
      const value = literalValue(parameter.default_ast);
      encodeLiteral(value, expected, parameter.default_ast);
      symbols.types.set(`${FRAGMENT_PARAMS_ID}.${parameter.name}`, expected);
      fragmentParameters.set(parameter.name, { name: parameter.name, type: parameter.type, ...expected, value });
    }
  }
  for (const declaration of document.root.members.filter((item) => item.kind === "declaration")) {
    if (declarations.has(declaration.name)) fail("duplicate_property", declaration);
    const descriptor = catalog.property_types[declaration.type];
    if (!descriptor || !declaration.value) fail("property_declaration_invalid", declaration);
    const expected = typeSpec(descriptor.value_type, descriptor.unit);
    const value = literalValue(declaration.value);
    encodeLiteral(value, expected, declaration.value);
    declarations.set(declaration.name, { name: declaration.name, expected, value });
    symbols.types.set(`${rootId}.${declaration.name}`, expected);
    logicalProperties.push({ owner: rootId, property: declaration.name, ...expected, value });
  }
  const assetRefs = new Map((options.assetRefs || []).map((item) => [item.path, Object.freeze({ ...item.asset, dependencies: [] })]));
  const rawNodes = [];
  const walk = (node, parent = rootId) => {
    for (const child of node.members.filter((item) => item.kind === "node")) {
      if (catalog.unavailable_components?.[child.type]) fail("component_unavailable", child, catalog.unavailable_components[child.type]);
      if (!Object.hasOwn(catalog.components, child.type) && child.type !== "Binding") fail("unknown_type", child);
      const fields = assignments(child);
      if (!fields.has('id')) fields.set('id', { value:{kind:'identifier',value:`${parent}__${child.type}__${rawNodes.length}`}, location:child.location });
      const id = nodeId(child, fields);
      if (symbols.nodes.has(id)) fail("duplicate_id", fields.get("id"));
      symbols.nodes.set(id, child);
      rawNodes.push({ child, fields, id, parent });
      walk(child, id);
    }
  };
  walk(document.root);
  validateGeo(rawNodes, { rootId, catalog, fail, literalValue, containsReference });
  for (const { child, id } of rawNodes) {
    if (child.type === "Binding") continue;
    for (const [name, descriptor] of Object.entries(catalog.components[child.type].members)) {
      // typeSpec() is the single source of the fixed-point divisor.  A per-member override used to be
      // honoured here, and the two members that used it (Timer.interval, Label.fontSize) were the only
      // thing keeping 0.3 from being one lane -- the interpreter is hard-wired to 1e6, so `interval: 100 * 5`
      // folded to 0.  The catalog generator now rejects an explicit divisor outright.
      symbols.types.set(`${id}.${runtimeProperty(child.type, name)}`, typeSpec(descriptor.value_type, descriptor.unit || null));
    }
  }
  const sceneNodes = [{ id: rootId, type: "Scene", parent: null, properties: [] }];
  const bindings = [];
  const sourceMap = [];
  const pendingValues = new Map();
  const resolvingValues = new Set();
  const values = new Map([
    ...logicalProperties.map((item) => [`${item.owner}.${item.property}`, item]),
    ...[...fragmentParameters.values()].map((item) => [`${FRAGMENT_PARAMS_ID}.${item.name}`, item]),
  ]);
  const read = (reference) => {
    const key = reference.segments.join('.');
    let item = values.get(key);
    if (!item && pendingValues.has(key)) {
      if (resolvingValues.has(key)) fail('dependency_cycle', pendingValues.get(key).ast);
      resolvingValues.add(key);
      const pending = pendingValues.get(key);
      const result = expressionRuntime.evaluate(pending.expression, read);
      pending.output.value = decode(result, pending.expected, pending.ast);
      item = { ...pending.expected, value:pending.output.value };
      values.set(key,item); resolvingValues.delete(key);
    }
    if (!item) throw Object.assign(new Error("unknown_reference"), { code: "unknown_reference" });
    const author = ["vector2", "vector3", "quaternion"].includes(item.value_type) && !Array.isArray(item.value) ? Object.values(item.value) : item.value;
    const encoded = encodeLiteral(author, item, document.root);
    if (Object.hasOwn(encoded, "literal")) return {
      type: item.value_type === "color" ? "string" : item.value_type,
      unit: item.unit,
      value: encoded.literal,
    };
    return { type: "array", unit: item.unit, element_type: "scalar", value: encoded.args.map((arg) => ({ type: "scalar", unit: item.unit, value: arg.literal })) };
  };
  for (const { child, fields, id, parent } of rawNodes) {
    if (child.type === "Binding") continue;
    const component = catalog.components[child.type];
    const properties = [];
    for (const [name, member] of fields) {
      if (name === "id") continue;
      const descriptor = component.members[name];
      if (!descriptor) fail("unknown_property", member);
      if (descriptor.read_only) fail("readonly_property", member);
      if (descriptor.value_type === "object_ref") {
        const target = literalValue(member.value);
        if (!symbols.nodes.has(target)) fail("unknown_reference", member.value);
        properties.push({ property: name, value: target });
        continue;
      }
      if (["vector3_list", "ring_list", "asset_ref", "scalar_list"].includes(descriptor.value_type)) {
        // Create-only constants: no bindings, no expressions. Point lists are metres in author order;
        // asset references are project-relative paths resolved against the source project's asset_refs.
        if (containsReference(member.value)) fail("constant_required", member.value);
        const raw = literalValue(member.value);
        let value;
        if (descriptor.value_type === "scalar_list") {
          if (!Array.isArray(raw) || raw.length < 1 || raw.length > 65536 || !raw.every((item) => Number.isFinite(item))) fail("type_mismatch", member.value, `${child.type}.${name} must be a list of 1..65536 finite numbers`);
          value = raw.slice();
        } else if (descriptor.value_type === "asset_ref") {
          if (typeof raw !== "string") fail("type_mismatch", member.value);
          const asset = assetRefs.get(raw);
          if (!asset) fail("asset_unresolved", member.value, `${child.type}.${name}: '${raw}' is not in the source project's asset_refs`);
          if (asset.kind !== descriptor.asset_kind) fail("asset_kind_mismatch", member.value, `${child.type}.${name} needs a '${descriptor.asset_kind}' asset`);
          value = asset;
        } else {
          const rings = descriptor.value_type === "ring_list" ? raw : [raw];
          // 2..256 is a POLYLINE rule (path / profile / outer / holes).  Instances.positions,
          // .rotations and .scales are indexed by instance instead, so the batch limit is theirs:
          // one instance is a legal batch, and the catalog promises 512.  Sharing the polyline rule
          // capped explicit placement at 256 and made a one-instance batch a type_mismatch.
          const perInstance = child.type === "Instances" && INSTANCES_PER_INSTANCE_POINTS.includes(name);
          // An EMPTY per-instance list is how a batch declares itself dynamic: the Prefab, the
          // material and the budget are still static, and api.instances.set() fills the rows in.
          const minPoints = perInstance ? 0 : 2;
          const maxPoints = perInstance ? INSTANCES_MAX_PER_BATCH : 256;
          const ringOk = (points) => Array.isArray(points) && points.length >= minPoints && points.length <= maxPoints
            && points.every((point) => Array.isArray(point) && point.length >= 2 && point.length <= 3 && point.every((item) => Number.isFinite(item)));
          // A bare type_mismatch on a point list leaves the author guessing which of the four rules
          // ("at least two points", "at most 256", "2 or 3 finite coordinates") they broke.
          if (!Array.isArray(rings) || rings.length > 128 || !rings.every(ringOk)) fail("type_mismatch", member.value, descriptor.value_type === "ring_list"
            ? `${child.type}.${name} must be 1..128 rings of 2..256 points, each [x, y] or [x, y, z] finite numbers`
            : `${child.type}.${name} must be a list of ${minPoints}..${maxPoints} points, each [x, y] or [x, y, z] finite numbers`);
          const lower = rings.map((points) => points.map((point) => [point[0], point[1], point[2] ?? 0]));
          value = descriptor.value_type === "ring_list" ? lower : lower[0];
        }
        properties.push({ property: name, value });
        sourceMap.push({
          path: `/nodes/${id}/properties/${name}`,
          file: member.file || options.sourceName || "scene.ssdl",
          line: member.location.start.line,
          column: member.location.start.column,
          definition: member.definition || null,
          instance_chain: member.instance_chain || [],
        });
        continue;
      }
      const expected = typeSpec(descriptor.value_type, descriptor.unit || null);
      const dependencies = new Set();
      const expression = compileExpression(member.value, expected, symbols, dependencies);
      const targetProperty = runtimeProperty(child.type, name);
      if (dependencies.has(`${id}.${targetProperty}`)) fail("dependency_cycle", member);
      const output = { property:targetProperty, value:null };
      properties.push(output);
      pendingValues.set(`${id}.${targetProperty}`, { expression,expected,output,ast:member.value });
      // A read of a fragment parameter is not a dependency: it is a hole the spawn call fills, so it
      // never becomes a binding and never makes a create_only member unassignable. The compiled
      // expression is kept in the fragment IR and evaluated once, when the fragment is installed.
      const parameterDependencies = [...dependencies].filter((key) => key.startsWith(`${FRAGMENT_PARAMS_ID}.`));
      for (const key of parameterDependencies) dependencies.delete(key);
      if (parameterDependencies.length) parameterSlots.push({ node: id, property: targetProperty, expression, expected,
        create_only: descriptor.update_class === "create_only" });
      if (dependencies.size && descriptor.update_class === "create_only") {
        fail("binding_update_class_unsupported", member);
      }
      if (dependencies.size) bindings.push({
        schema_version: "BindingIR/2",
        expression_ast_version: 2,
        id: `${id}:${targetProperty}`,
        target: { node: id, property: targetProperty, channel: "logical" },
        expression,
        dependencies: [...dependencies].sort(compare).map((key) => {
          const split = key.indexOf(".");
          return { node: key.slice(0, split), property: key.slice(split + 1) };
        }),
        when: { literal: true },
        restore_mode: "RestoreBindingOrValue",
      });
      sourceMap.push({
        path: `/nodes/${id}/properties/${targetProperty}`,
        file: member.file || options.sourceName || "scene.ssdl",
        line: member.location.start.line,
        column: member.location.start.column,
        definition: member.definition || null,
        instance_chain: member.instance_chain || [],
      });
    }
    for (const [name, descriptor] of Object.entries(component.members)) {
      if (descriptor.required && !fields.has(name) && !(name === "target" && component.implicit_target && parent && symbols.nodes.get(parent)?.type !== "Scene") && !(catalog.components[symbols.nodes.get(parent)?.type]?.adapter === "behavior" && ["target","property","from"].includes(name))) fail("required_property", child, `${child.type}.${name} is required`);
    }
    if (component.adapter === "animation" || component.adapter === "behavior") {
      const enclosing = rawNodes.find(item => item.id === parent);
      const inBehavior = enclosing?.child.type === "Behavior";
      const targetId = fields.has("target") ? literalValue(fields.get("target").value)
        : inBehavior ? (enclosing.fields.has("target") ? literalValue(enclosing.fields.get("target").value) : enclosing.parent)
        : component.implicit_target ? parent : null;
      const propertyField = fields.get("property") || (inBehavior ? enclosing.fields.get("property") : null);
      if (targetId && propertyField) {
        const targetType = symbols.nodes.get(targetId)?.type;
        const property = runtimeProperty(targetType, literalValue(propertyField.value));
        const native = propertyRegistry.properties.find(item => item.property === property && item.animatable && item.targets.includes("object"));
        const kind = {NumberAnimation:"scalar",Vector3dAnimation:"vec3",QuaternionAnimation:"quat",RotationAnimation:"quat",ColorAnimation:"color"}[child.type];
        // Geometry animates every registered object property; Group/GeoAnchor (locator rigs) and Model
        // (external nodes) expose only their transform and visibility to the native animation table.
        const adapter = catalog.components[targetType]?.adapter;
        const rigOnly = adapter === "group" || adapter === "model";
        if (rigOnly && !(property.startsWith("transform.") || property === "visible"))
          fail("property_not_animatable", propertyField, `${child.type} cannot animate ${targetType}.${property}: ${targetType} exposes only position/rotation/scale/visible to animations`);
        if (!native || (kind && native.value_type !== kind) || !(adapter === "geometry" || rigOnly))
          fail("property_not_animatable", propertyField, `${child.type} cannot animate ${targetType}.${property}`);
      }
    }
    const handlers = [];
    const usedSignals = new Set();
    for (const handler of child.members.filter(item => item.kind === 'handler')) {
      if (!component.signals?.includes(handler.name)) fail('unknown_signal', handler);
      if (usedSignals.has(handler.name)) fail('duplicate_signal', handler);
      usedSignals.add(handler.name);
      if (handler.actions.length > 32) fail('handler_budget', handler);
      const actions = handler.actions.map(action => {
        // `Iface.method(name: expr)` and the zero-argument `Iface.method()` both call host logic when Iface is not a node.
        if (action.kind === 'call' || (action.kind === 'invoke' && action.target.length === 2 && !symbols.nodes.has(action.target[0])))
          return compileHostCall({ ...action, args: action.args || [] }, symbols, hostInterfaces);
        const targetId = action.target.length === 1 ? rootId : action.target[0];
        const targetType = symbols.nodes.get(targetId)?.type;
        const author = action.target.length === 1 ? action.target[0] : action.target.slice(1).join('.');
        if (action.kind === 'invoke') {
          if (!catalog.components[targetType]?.commands?.includes(author)) fail('method_unsupported',action);
          return {kind:'invoke',target:{node:targetId},method:author};
        }
        const property = runtimeProperty(targetType,author), expected = symbols.types.get(`${targetId}.${property}`);
        const member = catalog.components[targetType]?.members[author];
        if (!expected) fail('unknown_reference',action);
        if (member?.read_only || member?.update_class === 'create_only' || member?.value_type === 'object_ref') fail('readonly_property',action);
        const dependencies = new Set();
        return {kind:'assignment', target:{node:targetId,property}, expected, expression:compileExpression(action.value,expected,symbols,dependencies)};
      });
      handlers.push({signal:handler.name,actions});
    }
    sceneNodes.push({ id, type: child.type, parent, source_order: sceneNodes.length, properties: properties.sort((a, b) => compare(a.property, b.property)), ...(handlers.length ? {handlers} : {}) });
  }
  for (const { child, fields, id } of rawNodes.filter((item) => item.child.type === "Binding")) {
    const allowed = new Set(["id", "target", "property", "value", "when", "restoreMode"]);
    for (const name of fields.keys()) if (!allowed.has(name)) fail("unknown_property", fields.get(name));
    for (const name of ["target", "property", "value"]) if (!fields.has(name)) fail("required_property", child, `Binding.${name} is required`);
    const target = literalValue(fields.get("target").value);
    const property = literalValue(fields.get("property").value);
    if (!symbols.nodes.has(target) || typeof property !== "string") fail("unknown_reference", fields.get("target"));
    const expected = symbols.types.get(`${target}.${property}`);
    if (!expected) fail("unknown_reference", fields.get("property"));
    // An inline `alpha: expression` is refused on a create_only member; an explicit Binding at the same
    // member used to slip past and only fail at mount, where the author has no line number to go on.
    const targetType = symbols.nodes.get(target)?.type;
    const targetMember = Object.entries(catalog.components[targetType]?.members || {})
      .find(([name, descriptor]) => (descriptor.runtime_property || name) === property)?.[1];
    if (targetMember?.read_only) fail("readonly_property", fields.get("property"), `${targetType}.${property} is read-only`);
    if (targetMember?.update_class === "create_only") {
      fail("binding_update_class_unsupported", fields.get("property"),
        `${targetType}.${property} is create_only: it is read once when the node is built, so a Binding on it would never take effect`);
    }
    if (bindings.some((item) => item.target.node === target && item.target.property === property)) fail("multiple_logical_writer", child);
    const dependencies = new Set();
    const expression = compileExpression(fields.get("value").value, expected, symbols, dependencies);
    const whenDependencies = new Set();
    const when = fields.has("when")
      ? compileExpression(fields.get("when").value, typeSpec("boolean"), symbols, whenDependencies)
      : { literal: true };
    // See the property loop: a fragment parameter is a hole, not a dependency.
    for (const set of [dependencies, whenDependencies]) for (const key of [...set]) if (key.startsWith(`${FRAGMENT_PARAMS_ID}.`)) set.delete(key);
    const restoreMode = fields.has("restoreMode") ? literalValue(fields.get("restoreMode").value) : "RestoreBindingOrValue";
    if (!["RestoreBindingOrValue", "RestoreValue", "RestoreNone"].includes(restoreMode)) fail("restore_mode_invalid", fields.get("restoreMode"));
    bindings.push({
      schema_version: "BindingIR/2", expression_ast_version: 2, id,
      target: { node: target, property, channel: "logical" }, expression,
      dependencies: [...dependencies].sort(compare).map((key) => {
        const split = key.indexOf(".");
        return { node: key.slice(0, split), property: key.slice(split + 1) };
      }),
      when,
      when_dependencies: [...whenDependencies].sort(compare).map((key) => {
        const split = key.indexOf(".");
        return { node: key.slice(0, split), property: key.slice(split + 1) };
      }),
      restore_mode: restoreMode,
    });
  }
  for (const {child,id} of rawNodes) {
    for (const [name,member] of Object.entries(catalog.components[child.type]?.members || {})) {
      const key = `${id}.${runtimeProperty(child.type,name)}`;
      if (!pendingValues.has(key) && !values.has(key) && ['boolean','scalar'].includes(member.value_type)) values.set(key,{...typeSpec(member.value_type,member.unit || null),value: member.value_type === 'boolean' ? false : 0});
    }
  }
  for (const [key, pending] of pendingValues) {
    try { read({segments:[key]}); } catch (error) { fail(error.code || 'expression_invalid',pending.ast,error.message); }
  }
  // Per-Prefab instance budget.  Only the runtime and the native side enforced it, so N batches that
  // each fit in 512 but together overrun 2048 compiled green and failed as a native invariant at mount,
  // with no placement_invalid in the compile receipt for the author to see.
  const prefabInstances = new Map();
  for (const node of sceneNodes) {
    const generated = Object.hasOwn(MESH_GENERATORS, node.type), primitive = Object.hasOwn(PRIMITIVE_CHECKS, node.type);
    if (!generated && !primitive && node.type !== "Instances") continue;
    const raw = rawNodes.find((item) => item.id === node.id);
    const props = Object.fromEntries(node.properties.map((item) => [item.property, item.value]));
    if (node.type === "Instances") {
      try {
        const { count } = checkInstances(props);
        const total = (prefabInstances.get(props.prefab) ?? 0) + count;
        if (total > INSTANCES_MAX_PER_PREFAB) {
          throw Object.assign(new Error(`Prefab '${props.prefab}' would carry ${total} instances (limit ${INSTANCES_MAX_PER_PREFAB} per Prefab); split the batches across more Prefabs`), { code: "placement_invalid" });
        }
        prefabInstances.set(props.prefab, total);
      }
      catch (error) { fail(error.code || "placement_invalid", raw?.child, `Instances '${node.id}': ${error.message}`); }
      continue;
    }
    let estimate = null;
    try { estimate = generated ? MESH_GENERATORS[node.type](props) : PRIMITIVE_CHECKS[node.type](props); }
    catch (error) { fail(error.code || "mesh_invalid", raw?.child, `${node.type} '${node.id}': ${error.message}`); }
    if (estimate && estimate.vertices > MESH_MAX_VERTICES) {
      // flat doubles the vertex count without changing a single triangle, so name it first when it is on:
      // an author who lowered samples instead would keep paying for it.
      const hint = (node.type === "Sweep" || node.type === "Lathe") && props.flat === true
        ? "drop flat (it doubles the vertices), or lower segments/samples"
        : "lower columns/rows/segments/samples";
      fail("mesh_budget", raw?.child, `${node.type} '${node.id}' would need ${estimate.vertices} vertices (limit ${MESH_MAX_VERTICES}); ${hint}`);
    }
  }
  const writers = new Map(bindings.map((binding) => [
    `${binding.target.node}.${binding.target.property}`, binding,
  ]));
  const visiting = new Set(), complete = new Set();
  const visit = (binding, chain = []) => {
    if (complete.has(binding)) return;
    if (visiting.has(binding)) fail("dependency_cycle", null,
      [...chain, binding.id].join(" -> "));
    visiting.add(binding);
    for (const dependency of [...(binding.dependencies || []), ...(binding.when_dependencies || [])]) {
      const writer = writers.get(`${dependency.node}.${dependency.property}`);
      if (writer) visit(writer, [...chain, binding.id]);
    }
    visiting.delete(binding);
    complete.add(binding);
  };
  for (const binding of bindings) visit(binding);
  const sceneIR = {
    ir_version: "SceneIR/5",
    coordinate_system: "right_handed_z_up",
    scope_id: rootId,
    compiler: PROFILE,
    logical_properties: logicalProperties.sort((a, b) => compare(a.property, b.property)),
    nodes: sceneNodes.sort((a, b) => compare(a.id, b.id)),
    ...(hostInterfaces ? { host_interfaces: hostInterfaces } : {}),
  };
  const bindingIR = {
    schema_version: "BindingIR/2",
    scope_id: rootId,
    bindings: bindings.sort((a, b) => compare(a.id, b.id)),
  };
  if (fragment) {
    for (const node of sceneNodes) {
      const reason = FRAGMENT_FORBIDDEN_TYPES[node.type];
      if (reason) fail("spawnable_invalid", rawNodes.find((item) => item.id === node.id)?.child ?? document.root,
        `a spawnable component cannot declare ${node.type} '${node.id}': ${reason}`);
    }
    // api.scene.set() re-evaluates a parameter's slots and writes the results. A parameter is only
    // offered that way when every slot it feeds is writable at runtime AND it is read nowhere else:
    // a parameter inside a binding or a handler action is baked into that expression when the
    // fragment is installed, so re-evaluating the slots would leave the two disagreeing.
    const bakedParameters = new Set();
    const collectParameterReads = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value) collectParameterReads(item); return; }
      if (value.ref?.segments?.[0] === FRAGMENT_PARAMS_ID) bakedParameters.add(value.ref.segments[1]);
      for (const item of Object.values(value)) collectParameterReads(item);
    };
    for (const binding of bindings) collectParameterReads([binding.expression, binding.when]);
    for (const node of sceneNodes) for (const handler of node.handlers || []) collectParameterReads(handler.actions);
    const slotParameters = new Map();
    for (const slot of parameterSlots) {
      const names = new Set();
      const scan = (value) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const item of value) scan(item); return; }
        if (value.ref?.segments?.[0] === FRAGMENT_PARAMS_ID) names.add(value.ref.segments[1]);
        for (const item of Object.values(value)) scan(item);
      };
      scan(slot.expression);
      for (const name of names) {
        if (!slotParameters.has(name)) slotParameters.set(name, []);
        slotParameters.get(name).push(slot);
      }
    }
    const rootNode = sceneNodes.find((node) => node.id === FRAGMENT_ROOT_ID);
    // The root Group's parent is whatever spawn() is told to hang it on, so the fragment IR states
    // none; every other node keeps the parent it was authored with.
    const fragmentNodes = sceneNodes.filter((node) => node.type !== "Scene")
      .map((node) => node.id === FRAGMENT_ROOT_ID ? { ...node, parent: null } : node);
    const fragmentIR = {
      ir_version: "SceneIR/5-fragment",
      name: fragment.name,
      source_file: fragment.file,
      coordinate_system: "right_handed_z_up",
      scene_scope_id: rootId,
      params_node: FRAGMENT_PARAMS_ID,
      root: rootNode.id,
      parameters: [...fragmentParameters.values()].map((item) => ({
        name: item.name, type: item.type, value_type: item.value_type,
        unit: item.unit, divisor: item.divisor, default: item.value,
        mutable: !bakedParameters.has(item.name) && (slotParameters.get(item.name) || []).length > 0
          && (slotParameters.get(item.name) || []).every((slot) => !slot.create_only),
      })),
      nodes: fragmentNodes,
      bindings: bindingIR.bindings,
      parameter_slots: parameterSlots.map((slot) => ({ node: slot.node, property: slot.property,
        expression: slot.expression, expected: slot.expected, create_only: slot.create_only }))
        .sort((a, b) => compare(`${a.node}.${a.property}`, `${b.node}.${b.property}`)),
      budget: fragmentBudget(fragmentNodes, bindingIR.bindings),
    };
    return Object.freeze({ name: fragment.name, source_file: fragment.file,
      fragment_ir: fragmentIR, fragment_ir_digest: digest(fragmentIR) });
  }
  const result = Object.freeze({
    source,
    // The scene's own share of the budget ledger, counted by the same function that prices a
    // fragment. spawn() adds "static + dynamic + this fragment" against one set of limits, so the
    // two halves have to be counted once, in one place.
    static_usage: fragmentBudget(sceneNodes.filter((node) => node.type !== "Scene"), bindingIR.bindings),
    compiler_profile: PROFILE,
    compiler_profile_digest: PROFILE_DIGEST,
    scene_ir: sceneIR,
    scene_ir_digest: digest(sceneIR),
    binding_ir: bindingIR,
    binding_ir_digest: digest(bindingIR),
    source_map: sourceMap.sort((a, b) => compare(a.path, b.path)),
    source_files: options.sourceFiles || [{ file: options.sourceName || "scene.ssdl", content: source }],
    source_digest: options.sourceDigest || digest(source),
    expansion_map: options.expansionMap || null,
    fragments: options.fragments || [],
  });
  return options.emit === false ? result : Object.freeze({ ...result, emitted: emitSceneModule(result, options) });
}

export function compileSceneModule(source, options = {}) {
  if (typeof source !== "string" || !source.length) fail("invalid_source");
  if (Buffer.byteLength(source) > 1024 * 1024) fail("source_budget");
  let document;
  try { document = parser.parse(source, { grammarSource: options.sourceName || "scene.ssdl" }); }
  catch (error) { fail(error.code || "syntax_error", error, error.message); }
  if (document.imports.length) fail("import_unsupported", document.imports[0]);
  return compileDocument(document, source, options);
}

export function compileSceneModuleProject(project, options = {}) {
  const expanded = expandSourceProject(project, catalog);
  const entry = expanded.source_files.find((item) => item.file === project.entry);
  const shared = {
    ...options,
    sourceName: project.entry,
    sourceFiles: expanded.source_files,
    sourceDigest: expanded.source_digest,
    expansionMap: expanded.expansion_map,
    assetRefs: expanded.asset_refs,
  };
  const fragments = expanded.fragments.map((item) => compileDocument(item.document, entry.content, {
    ...shared, emit: false, sourceName: item.file,
    fragment: { name: item.name, file: item.file, parameters: item.parameters },
  }));
  return compileDocument(expanded.document, entry.content, { ...shared, fragments });
}

export { PROFILE, PROFILE_DIGEST };
