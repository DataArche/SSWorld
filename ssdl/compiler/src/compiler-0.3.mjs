import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import parser from "../generated/parser-0.3.cjs";
import expressionRuntime from "./expression-runtime.js";
import propertyRegistry from "../generated/property-registry.js";
import { emitSceneModule } from "./scene-module-emitter.mjs";
import { expandSourceProject } from "./source-project-0.3.mjs";

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
  return { value_type: valueType, unit, divisor: ["scalar", "vector3", "quaternion"].includes(valueType) ? 1e6 : 1 };
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
  if (["vector3", "quaternion"].includes(expected.value_type)) {
    const size = expected.value_type === "quaternion" ? 4 : 3;
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

function compileExpression(ast, expected, symbols, dependencies) {
  if (["literal", "number", "negative", "array"].includes(ast.kind) && !containsReference(ast)) {
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
    if (!["vector3","quaternion"].includes(expected.value_type) || ast.values.length !== (expected.value_type === "quaternion" ? 4 : 3)) fail("type_mismatch", ast);
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
  const booleanOps = new Set(["not", "and", "or", "equals", "lt", "gt"]);
  let operandType = ["not", "and", "or"].includes(op) ? typeSpec("boolean") : expected;
  if (["equals", "lt", "gt"].includes(op)) {
    const first = children[0];
    if (first.kind === 'reference') operandType = symbols.types.get(`${first.segments[0]}.${runtimeProperty(symbols.nodes.get(first.segments[0])?.type, first.segments.slice(1).join('.'))}`) || typeSpec('scalar','scalar');
    else if (first.kind === 'identifier') operandType = symbols.types.get(`${symbols.rootId}.${first.value}`) || typeSpec('scalar','scalar');
    else operandType = typeSpec(typeof first.value === 'boolean' ? 'boolean' : typeof first.value === 'string' ? 'string' : 'scalar', 'scalar');
  }
  const result = { op, args: children.map((item) => compileExpression(item, operandType, symbols, dependencies)) };
  if (booleanOps.has(op) && expected.value_type !== "boolean") fail("type_mismatch", ast);
  return result;
}

function decode(result, expected, ast) {
  if (["vector3","quaternion"].includes(expected.value_type)) {
    if (result.type !== "array" || result.value.length !== (expected.value_type === "quaternion" ? 4 : 3)) fail("type_mismatch", ast);
    return Object.fromEntries((expected.value_type === "quaternion" ? ["x","y","z","w"] : ["x", "y", "z"]).map((name, index) => [name, result.value[index].value / expected.divisor]));
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
/**
 * Parametric mesh generators: vertex/triangle counts from the compiled (constant) parameters. The
 * browser runtime builds the same meshes from the same parameters, so the IR carries parameters only.
 */
export const MESH_GENERATORS = Object.freeze({
  HeightField(props) {
    const columns = integer(props.columns, "columns", 1, 4096), rows = integer(props.rows, "rows", 1, 4096);
    if (!(props.width > 0) || !(props.depth > 0)) meshFail("mesh_invalid", "width and depth must be > 0");
    const expected = (columns + 1) * (rows + 1);
    if (!Array.isArray(props.heights) || props.heights.length !== expected) meshFail("mesh_invalid", `heights needs (columns+1)*(rows+1) = ${expected} values (row-major, first row at -depth/2), got ${props.heights?.length ?? 0}`);
    return { vertices: expected, triangles: 2 * columns * rows };
  },
  Lathe(props) {
    const segments = integer(props.segments, "segments", 3, 256);
    const profile = props.profile || [];
    if (profile.length < 2) meshFail("mesh_invalid", "profile needs at least 2 points ([radius, 0, height] each)");
    if (profile.some((point) => point[0] < 0)) meshFail("mesh_invalid", "profile radius (x) must be >= 0");
    const caps = props.closed ? 2 : 0;
    return { vertices: profile.length * segments + caps, triangles: 2 * (profile.length - 1) * segments + caps * segments };
  },
  Tube(props) {
    const segments = integer(props.segments, "segments", 3, 64);
    const path = props.path || [];
    if (path.length < 2) meshFail("mesh_invalid", "path needs at least 2 points");
    if (!(props.radius > 0)) meshFail("mesh_invalid", "radius must be > 0");
    const caps = props.closed ? 2 : 0;
    return { vertices: path.length * segments + caps, triangles: 2 * (path.length - 1) * segments + caps * segments };
  },
  Loft(props) {
    const sections = props.sections || [];
    if (sections.length < 2) meshFail("mesh_invalid", "sections needs at least 2 rings");
    const count = sections[0].length;
    if (count < 3 || sections.some((ring) => ring.length !== count)) meshFail("mesh_invalid", "every section needs the same number of points (>= 3)");
    const caps = props.cap ? 2 : 0;
    return { vertices: sections.length * count + caps, triangles: 2 * (sections.length - 1) * count + caps * count };
  },
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
  for (const { child, id } of rawNodes) {
    if (child.type === "Binding") continue;
    for (const [name, descriptor] of Object.entries(catalog.components[child.type].members)) {
      symbols.types.set(`${id}.${runtimeProperty(child.type, name)}`, { ...typeSpec(descriptor.value_type, descriptor.unit || null), ...(descriptor.divisor ? { divisor:descriptor.divisor } : {}) });
    }
  }
  const sceneNodes = [{ id: rootId, type: "Scene", parent: null, properties: [] }];
  const bindings = [];
  const sourceMap = [];
  const pendingValues = new Map();
  const resolvingValues = new Set();
  const values = new Map(logicalProperties.map((item) => [`${item.owner}.${item.property}`, item]));
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
    const author = ["vector3","quaternion"].includes(item.value_type) && !Array.isArray(item.value) ? Object.values(item.value) : item.value;
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
          const ringOk = (points) => Array.isArray(points) && points.length >= 2 && points.length <= 256
            && points.every((point) => Array.isArray(point) && point.length >= 2 && point.length <= 3 && point.every((item) => Number.isFinite(item)));
          if (!Array.isArray(rings) || rings.length > 128 || !rings.every(ringOk)) fail("type_mismatch", member.value);
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
      const expected = { ...typeSpec(descriptor.value_type, descriptor.unit || null), ...(descriptor.divisor ? { divisor:descriptor.divisor } : {}) };
      const dependencies = new Set();
      const expression = compileExpression(member.value, expected, symbols, dependencies);
      const targetProperty = runtimeProperty(child.type, name);
      if (dependencies.has(`${id}.${targetProperty}`)) fail("dependency_cycle", member);
      const output = { property:targetProperty, value:null };
      properties.push(output);
      pendingValues.set(`${id}.${targetProperty}`, { expression,expected,output,ast:member.value });
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
        // The runtime animates SceneObjects only (Group is a locator handle and Model is not registered as animatable).
        if (catalog.components[targetType]?.adapter === "group")
          fail("property_not_animatable", propertyField, `${child.type} cannot animate ${targetType} '${targetId}': Group is not a live SceneObject in this runtime; animate the child geometry instead`);
        if (!native || (kind && native.value_type !== kind)
            || catalog.components[targetType]?.adapter !== "geometry")
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
    if (bindings.some((item) => item.target.node === target && item.target.property === property)) fail("multiple_logical_writer", child);
    const dependencies = new Set();
    const expression = compileExpression(fields.get("value").value, expected, symbols, dependencies);
    const whenDependencies = new Set();
    const when = fields.has("when")
      ? compileExpression(fields.get("when").value, typeSpec("boolean"), symbols, whenDependencies)
      : { literal: true };
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
  for (const node of sceneNodes) {
    if (!Object.hasOwn(MESH_GENERATORS, node.type)) continue;
    const raw = rawNodes.find((item) => item.id === node.id);
    const props = Object.fromEntries(node.properties.map((item) => [item.property, item.value]));
    let estimate;
    try { estimate = MESH_GENERATORS[node.type](props); }
    catch (error) { fail(error.code || "mesh_invalid", raw?.child, `${node.type} '${node.id}': ${error.message}`); }
    if (estimate.vertices > MESH_MAX_VERTICES) fail("mesh_budget", raw?.child, `${node.type} '${node.id}' would need ${estimate.vertices} vertices (limit ${MESH_MAX_VERTICES}); lower columns/rows/segments`);
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
  const result = Object.freeze({
    source,
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
  return compileDocument(expanded.document, entry.content, {
    ...options,
    sourceName: project.entry,
    sourceFiles: expanded.source_files,
    sourceDigest: expanded.source_digest,
    expansionMap: expanded.expansion_map,
    assetRefs: expanded.asset_refs,
  });
}

export { PROFILE, PROFILE_DIGEST };
