import path from "node:path";
import { createHash } from "node:crypto";
import parser from "../generated/parser-0.3.cjs";

const POSIX = path.posix;
const ID = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;

// Reserved ids for a spawnable component's compiled fragment. The grammar's Identifier rule has no
// "-", so no author id can ever collide with these three.
export const FRAGMENT_PARAMS_ID = "fragment-params";
export const FRAGMENT_ROOT_ID = "fragment-root";
// A fragment's `property` types: the create-time parameters. radians and url are left out on
// purpose -- degrees is the authored angle unit everywhere else, and a url parameter would make a
// fragment reach for an asset the project never declared.
export const FRAGMENT_PARAMETER_TYPES = Object.freeze(["real", "bool", "string", "length", "degrees", "duration"]);

// The size walls of a source project, in one place: the compiler and the MCP server's source tools
// both read these rather than repeating the numbers. Measured 2026-09-25 on Windows node 26 with a
// real project scaled 1x-6x: compile time and peak memory grow linearly, ~0.65 s and ~170 MiB per
// MiB of source, and the generated module is ~4x the source. 16 MiB is ~10 s, ~2.7 GiB and a ~64 MiB
// module; the page still has to load that module, which is the next wall rather than this one.
export const SOURCE_LIMITS = Object.freeze({ file_bytes: 4 * 1024 * 1024, project_bytes: 16 * 1024 * 1024, files: 256, asset_refs: 256 });

const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;

function fail(code, ast, detail = code) {
  const error = Object.assign(new Error(detail), { code });
  const start = ast?.location?.start || { line: 1, column: 1 };
  error.diagnostic = {
    file: ast?.file || "scene.ssdl",
    line: start.line,
    column: start.column,
  };
  throw error;
}

function sha(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sourcePath(value) {
  if (typeof value !== "string" || !value || /[\\:\x00-\x1f\x7f]/u.test(value) || value.startsWith("/")
      || !value.endsWith(".ssdl") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("source_path_invalid");
  }
  return value;
}

function annotate(value, file, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (value.location) value.file = file;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => annotate(item, file, seen));
    else annotate(child, file, seen);
  }
  return value;
}

// Every component instantiation copies its template's AST, so this is most of the compile time on a
// large project; a plain key loop builds the same objects several times faster than
// Object.fromEntries(Object.entries(...)).
function clone(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let index = 0; index < value.length; index++) copy[index] = clone(value[index]);
    return copy;
  }
  const copy = {};
  for (const key of Object.keys(value)) {
    // An assignment to "__proto__" would set the prototype instead of creating the key.
    if (key === "__proto__") Object.defineProperty(copy, key, { value: clone(value[key]), enumerable: true, writable: true, configurable: true });
    else copy[key] = clone(value[key]);
  }
  return copy;
}

// clone() minus the keys the caller replaces at once. Those keep their place in the key order (so
// the emitted JSON is unchanged) and hold the ORIGINAL value until the caller overwrites it, but
// their subtrees are not copied only to be thrown away: cloning a node and then emptying its members
// copied every descendant once per level of nesting. A caller must overwrite every skipped key that
// holds an object.
function cloneExcept(value, skip) {
  const copy = {};
  for (const key of Object.keys(value)) {
    const child = skip.includes(key) ? value[key] : clone(value[key]);
    if (key === "__proto__") Object.defineProperty(copy, key, { value: child, enumerable: true, writable: true, configurable: true });
    else copy[key] = child;
  }
  return copy;
}

function fields(node) {
  const result = new Map();
  for (const member of node.members.filter((item) => item.kind === "property")) {
    if (result.has(member.name)) fail("duplicate_assignment", member);
    result.set(member.name, member);
  }
  return result;
}

function declarations(node) {
  const result = new Map();
  for (const member of node.members.filter((item) => item.kind === "declaration")) {
    if (result.has(member.name)) fail("duplicate_property", member);
    result.set(member.name, member);
  }
  return result;
}

function idValue(member) {
  const value = member?.value;
  const id = value?.kind === "identifier" || value?.kind === "literal" ? value.value : null;
  if (typeof id !== "string" || !ID.test(id)) fail("invalid_id", member);
  return id;
}

function nestedId(prefix, local) {
  const direct = `${prefix}__${local}`;
  if (direct.length <= 128) return direct;
  return `${prefix.slice(0, 55)}__${sha(direct).slice(7, 71)}`;
}

function location(ast) {
  return {
    file: ast?.file || "scene.ssdl",
    line: ast?.location?.start?.line || 1,
    column: ast?.location?.start?.column || 1,
  };
}

function transformExpression(ast, environment, resolving = new Set()) {
  if (!ast || typeof ast !== "object") return ast;
  if (ast.kind === "identifier") {
    if (environment.params.has(ast.value)) {
      if (resolving.has(ast.value)) fail("parameter_cycle", ast);
      const next = new Set(resolving);
      next.add(ast.value);
      return transformExpression(clone(environment.params.get(ast.value)), environment, next);
    }
    if (environment.ids.has(ast.value)) return { ...clone(ast), value: environment.ids.get(ast.value) };
    return clone(ast);
  }
  if (ast.kind === "reference") {
    // `root.size` inside a component reads the property the component declares, exactly as the bare
    // `size` does. Declared properties are parameters substituted where they are used, so the root node
    // has no member of that name and the QML spelling used to fail as unknown_reference `<instance>.size`.
    if (ast.segments.length === 2 && environment.root && ast.segments[0] === environment.root
        && environment.params.has(ast.segments[1])) {
      return transformExpression({ kind: "identifier", value: ast.segments[1], location: ast.location, file: ast.file }, environment, resolving);
    }
    const copy = clone(ast);
    if (environment.params.has(copy.segments[0])) fail("invalid_reference", ast);
    if (environment.ids.has(copy.segments[0])) copy.segments[0] = environment.ids.get(copy.segments[0]);
    return copy;
  }
  const copy = cloneExcept(ast, ["actions", "arg", "args", "values"]);
  if (ast.actions) copy.actions = ast.actions.map(action => {
    const result = cloneExcept(action, ["value"]);
    if (environment.ids.has(result.target[0])) result.target[0] = environment.ids.get(result.target[0]);
    if (action.value) result.value = transformExpression(action.value, environment, resolving);
    return result;
  });
  if (ast.arg) copy.arg = transformExpression(ast.arg, environment, resolving);
  if (ast.args) copy.args = ast.args.map((item) => transformExpression(item, environment, resolving));
  if (ast.values) copy.values = ast.values.map((item) => transformExpression(item, environment, resolving));
  return copy;
}

function collectIds(node, prefix, result, root = true) {
  const own = fields(node).get("id");
  if (own && !root) {
    const local = idValue(own);
    if (result.has(local)) fail("duplicate_id", own);
    result.set(local, nestedId(prefix, local));
  }
  for (const child of node.members.filter((item) => item.kind === "node")) {
    collectIds(child, prefix, result, false);
  }
}

export function expandSourceProject(project, catalog) {
  if (!project || project.schema_version !== "SSDLSourceProject/1"
      || project.language !== "SSDL/QML-Subset/0.3" || !Array.isArray(project.files)
      || project.files.length < 1 || !Array.isArray(project.asset_refs)
      || !/^sha256:[0-9a-f]{64}$/.test(project.source_digest || "")
      || Object.keys(project).sort().join(",") !== "asset_refs,entry,files,language,schema_version,source_digest") {
    fail("source_schema_invalid");
  }
  if (project.files.length > SOURCE_LIMITS.files) {
    fail("source_budget", null, `${project.files.length} .ssdl files; a project takes at most ${SOURCE_LIMITS.files}`);
  }
  if (project.asset_refs.length > SOURCE_LIMITS.asset_refs) {
    fail("source_budget", null, `${project.asset_refs.length} asset files; a project takes at most ${SOURCE_LIMITS.asset_refs}`);
  }
  const ASSET_KEYS = "asset_id,content_digest,dependencies,kind,media_type,size_bytes";
  const MEDIA = { model: ["model/gltf-binary"], texture: ["image/png", "image/jpeg"],
    geojson: ["application/geo+json", "application/json"] };
  const seenAssets = new Set();
  for (const raw of project.asset_refs) {
    const asset = raw?.asset;
    if (!raw || Object.keys(raw).sort().join(",") !== "asset,path" || typeof raw.path !== "string" || !raw.path.length
        || !asset || Object.keys(asset).sort().join(",") !== ASSET_KEYS
        || typeof asset.asset_id !== "string" || !asset.asset_id.length
        || !MEDIA[asset.kind]?.includes(asset.media_type)
        || !/^sha256:[0-9a-f]{64}$/.test(asset.content_digest)
        || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes < 0
        || !Array.isArray(asset.dependencies) || asset.dependencies.length) fail("source_schema_invalid", { file: raw?.path });
    if (seenAssets.has(raw.path)) fail("source_duplicate_path", { file: raw.path });
    seenAssets.add(raw.path);
  }
  const assetRefs = [...project.asset_refs].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((item) => ({ path: item.path, asset: { ...item.asset, dependencies: [] } }));
  const entry = sourcePath(project.entry);
  const docs = new Map();
  let totalBytes = 0;
  for (const raw of project.files) {
    if (!raw || Object.keys(raw).sort().join(",") !== "content,path") fail("source_schema_invalid");
    const file = sourcePath(raw?.path);
    if (docs.has(file) || [...docs.keys()].some((item) => item.toLowerCase() === file.toLowerCase())) {
      fail("source_duplicate_path", { file });
    }
    if (typeof raw.content !== "string") fail("source_schema_invalid", { file });
    totalBytes += Buffer.byteLength(raw.content);
    const fileBytes = Buffer.byteLength(raw.content);
    if (fileBytes > SOURCE_LIMITS.file_bytes) {
      fail("source_budget", { file }, `${file} is ${mib(fileBytes)}; one source file takes at most ${mib(SOURCE_LIMITS.file_bytes)}`);
    }
    if (totalBytes > SOURCE_LIMITS.project_bytes) {
      fail("source_budget", { file }, `the sources add up to ${mib(totalBytes)} by ${file}; a project takes at most ${mib(SOURCE_LIMITS.project_bytes)}`);
    }
    let document;
    try { document = parser.parse(raw.content, { grammarSource: file }); }
    catch (error) { fail(error.code || "syntax_error", { file, location: error.location }, error.message); }
    let anonymous = 0;
    // Anonymous ids must stay unique across the whole project, not just within one file: the
    // counter restarts per file, so an entry file and a component file would both inject
    // `anonymous_<Type>_0` and collide as `duplicate_id` (with the diagnostic pointing at the
    // wrong file). Seed the name with a short digest of the file path instead.
    const anonymousScope = createHash("sha256").update(file).digest("hex").slice(0, 8);
    const identify = node => {
      if (!node.members.some(member => member.kind === 'property' && member.name === 'id')) node.members.unshift({kind:'property',name:'id',value:{kind:'identifier',value:`anonymous_${node.type}_${anonymousScope}_${anonymous++}`,location:node.location},location:node.location});
      for (const child of node.members.filter(member => member.kind === 'node')) identify(child);
    };
    identify(document.root);
    annotate(document, file);
    docs.set(file, { file, content: raw.content, document, aliases: new Map(), directories: new Set() });
  }
  if (!docs.has(entry)) fail("source_entry_missing");
  const directories = new Set(["", ...[...docs.keys()].map((file) => POSIX.dirname(file)).filter((dir) => dir !== ".")]);
  for (const doc of docs.values()) {
    doc.directories.add(POSIX.dirname(doc.file) === "." ? "" : POSIX.dirname(doc.file));
    for (const imported of doc.document.imports) {
      const base = POSIX.dirname(doc.file) === "." ? "" : POSIX.dirname(doc.file);
      const resolved = POSIX.normalize(POSIX.join(base, imported.directory));
      if (resolved === ".." || resolved.startsWith("../")) {
        fail("source_directory_escape", imported);
      }
      if (!directories.has(resolved)) {
        fail("source_directory_missing", imported);
      }
      if (imported.alias) {
        if (doc.aliases.has(imported.alias) && doc.aliases.get(imported.alias) !== resolved) {
          fail("import_alias_conflict", imported);
        }
        doc.aliases.set(imported.alias, resolved);
      } else doc.directories.add(resolved);
    }
  }
  if (docs.get(entry).document.root.type !== "Scene") fail("unsupported_component_root", docs.get(entry).document.root);
  for (const doc of docs.values()) {
    if (doc.file !== entry && (!Object.hasOwn(catalog.components, doc.document.root.type)
        || doc.document.root.type === "Scene")) {
      fail("unsupported_component_root", doc.document.root);
    }
  }

  function resolveComponent(doc, type, ast) {
    const parts = type.split(".");
    const simple = parts.at(-1);
    let candidates = [];
    if (parts.length === 2) {
      const directory = doc.aliases.get(parts[0]);
      if (!directory) fail("unknown_type", ast);
      candidates = [`${directory ? `${directory}/` : ""}${simple}.ssdl`].filter((file) => docs.has(file));
    } else if (parts.length === 1) {
      candidates = [...doc.directories].map((directory) =>
        `${directory ? `${directory}/` : ""}${simple}.ssdl`).filter((file) => docs.has(file));
    } else fail("unknown_type", ast);
    const builtin = parts.length === 1 && (Object.hasOwn(catalog.components, type) || type === "Binding");
    if (candidates.length + (builtin ? 1 : 0) > 1) fail("ambiguous_type", ast);
    if (candidates.length) return docs.get(candidates[0]);
    if (builtin) return null;
    fail("unknown_type", ast);
  }

  const expansionEntries = [];
  function emitEntry(node, member = null, definition = node, origin = member || node, chain = []) {
    expansionEntries.push({
      node: idValue(fields(node).get("id")),
      property: member?.name || null,
      definition: location(definition),
      value_origin: location(origin),
      instance_chain: chain,
    });
  }

  function expandNode(raw, doc, environment, chain = []) {
    const component = resolveComponent(doc, raw.type, raw);
    if (!component) {
      const copy = cloneExcept(raw, ["members"]);
      copy.type = raw.type;
      copy.members = [];
      for (const member of raw.members) {
        if (member.kind === "node") {
          copy.members.push(expandNode(member, doc, environment, chain));
        } else if (member.kind === "property") {
          const transformed = { ...cloneExcept(member, ["value"]), value: transformExpression(member.value, environment) };
          transformed.file = transformed.value.file || member.file;
          transformed.definition = location(member);
          transformed.instance_chain = clone(chain);
          copy.members.push(transformed);
        } else if (member.kind === "handler") copy.members.push(transformExpression(member, environment));
        else copy.members.push(clone(member));
      }
      emitEntry(copy, null, raw, raw, chain);
      for (const member of copy.members.filter((item) => item.kind === "property" && item.name !== "id")) {
        emitEntry(copy, member, raw, member, chain);
      }
      return copy;
    }

    if (chain.some((item) => item.file === component.file)) fail("recursive_component", raw);
    const invocationFields = fields(raw);
    const invocationId = idValue(invocationFields.get("id"));
    const template = component.document.root;
    const templateDeclarations = declarations(template);
    const templateFields = fields(template);
    const ids = new Map(environment.ids);
    const templateRootId = templateFields.get("id");
    if (templateRootId) ids.set(idValue(templateRootId), invocationId);
    collectIds(template, invocationId, ids);
    const params = new Map(environment.params);
    for (const [name, declaration] of templateDeclarations) {
      const supplied = invocationFields.get(name)?.value;
      // A fragment invocation binds every declared property to a read of the reserved parameter node
      // instead of to its default, so the compiled fragment keeps the slot and spawn fills it in.
      if (raw.fragment_parameters) { params.set(name, clone(raw.fragment_parameters.get(name))); continue; }
      if (!supplied && !declaration.value) fail("parameter_unassigned", declaration);
      params.set(name, supplied
        ? transformExpression(supplied, environment)
        : clone(declaration.value));
    }
    const localEnvironment = { ids, params, root: templateRootId ? idValue(templateRootId) : null };
    const nextChain = [...chain, { file: component.file, instance_id: invocationId, call_site: location(raw) }];
    const root = {
      ...cloneExcept(template, ["members"]),
      type: template.type,
      file: template.file,
      definition: location(template),
      instance_chain: clone(nextChain),
      members: [],
    };
    const idMember = clone(invocationFields.get("id"));
    root.members.push(idMember);
    const overrides = new Map([...invocationFields].filter(([name]) =>
      name !== "id" && !templateDeclarations.has(name)));
    for (const member of template.members) {
      if (member.kind === "declaration" || (member.kind === "property" && member.name === "id")) continue;
      if (member.kind === "node") {
        root.members.push(expandNode(member, component, localEnvironment, nextChain));
        continue;
      }
      const override = overrides.get(member.name);
      const origin = override || member;
      root.members.push({
        ...cloneExcept(origin, ["value"]),
        value: transformExpression(origin.value, override ? environment : localEnvironment),
        definition: location(member),
        instance_chain: clone(nextChain),
      });
      overrides.delete(member.name);
    }
    for (const override of overrides.values()) {
      root.members.push({
        ...cloneExcept(override, ["value"]), value: transformExpression(override.value, environment),
        definition: location(template), instance_chain: clone(nextChain),
      });
    }
    for (const child of raw.members.filter((item) => item.kind === "node")) {
      root.members.push(expandNode(child, doc, environment, chain));
    }
    emitEntry(root, null, template, raw, nextChain);
    for (const member of root.members.filter((item) => item.kind === "property" && item.name !== "id")) {
      emitEntry(root, member, templateFields.get(member.name) || template, member, nextChain);
    }
    return root;
  }

  const entryDoc = docs.get(entry);
  const entryRootId = idValue(fields(entryDoc.document.root).get("id"));
  const entryIds = new Map();
  collectIds(entryDoc.document.root, "", entryIds);
  for (const [local] of entryIds) entryIds.set(local, local);
  const root = expandNode(entryDoc.document.root, entryDoc, { ids: entryIds, params: new Map() });

  // Spawnable components: each one is expanded a second time, on its own, with every declared
  // property bound to a read of the reserved parameter node. The result is a self-contained Scene
  // the compiler turns into a fragment IR -- the same expansion path a static instance takes, so a
  // fragment and a static instance of one component cannot disagree about what the component is.
  const fragments = [];
  for (const doc of [...docs.values()].sort((a, b) => Buffer.compare(Buffer.from(a.file), Buffer.from(b.file)))) {
    const pragmas = doc.document.pragmas || [];
    if (!pragmas.some((item) => item.name === "spawnable")) continue;
    const template = doc.document.root;
    if (doc.file === entry) {
      fail("spawnable_invalid", pragmas[0], "the entry scene cannot be spawnable; put the part in its own PascalCase component file");
    }
    const name = POSIX.basename(doc.file, ".ssdl");
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) {
      fail("spawnable_invalid", pragmas[0], `a spawnable component's file must be PascalCase ('${name}.ssdl' is not), because api.scene.spawn names it by that file name`);
    }
    if (template.type !== "Group") {
      fail("spawnable_invalid", template, `a spawnable component's root must be Group (this one is ${template.type}); the root Group is the single locator spawn positions, hides and releases`);
    }
    const parameters = [];
    const fragmentParameters = new Map();
    for (const [property, declaration] of declarations(template)) {
      if (!FRAGMENT_PARAMETER_TYPES.includes(declaration.type)) {
        fail("spawnable_invalid", declaration, `a spawnable component's property must be one of ${FRAGMENT_PARAMETER_TYPES.join(" / ")} ('${property}' is ${declaration.type})`);
      }
      if (declaration.required || !declaration.value) {
        fail("spawnable_invalid", declaration, `spawnable property '${property}' needs a default value: the default is what the fragment's budget and mesh limits are checked against at compile time`);
      }
      parameters.push({ name: property, type: declaration.type, default_ast: clone(declaration.value) });
      fragmentParameters.set(property, { kind: "reference", segments: [FRAGMENT_PARAMS_ID, property],
        file: doc.file, location: declaration.location });
    }
    const invocation = {
      kind: "node", type: name, file: doc.file, location: template.location,
      fragment_parameters: fragmentParameters,
      members: [{ kind: "property", name: "id", file: doc.file, location: template.location,
        value: { kind: "identifier", value: FRAGMENT_ROOT_ID, file: doc.file, location: template.location } }],
    };
    const mark = expansionEntries.length;
    const expanded = expandNode(invocation, doc, { ids: new Map(), params: new Map() });
    const entries = expansionEntries.splice(mark);
    // The wrapper Scene carries the ENTRY scene's id and its declarations, so a fragment's bindings
    // can read the scene's logical properties by the same node id the installed graph uses; the
    // fragment IR drops the declarations again (the scene, not the fragment, owns those values).
    fragments.push({
      name, file: doc.file, parameters,
      expansion_entries: entries,
      document: { imports: [], root: {
        kind: "node", type: "Scene", file: doc.file, location: template.location,
        members: [
          { kind: "property", name: "id", file: doc.file, location: template.location,
            value: { kind: "identifier", value: entryRootId, file: entryDoc.file, location: entryDoc.document.root.location } },
          ...entryDoc.document.root.members.filter((item) => item.kind === "declaration").map(clone),
          expanded,
        ],
      } },
    });
  }
  const inventory = [...docs.values()].sort((a, b) => Buffer.compare(Buffer.from(a.file), Buffer.from(b.file))).map((doc) => ({
    path: doc.file,
    content: doc.content,
    content_digest: sha(doc.content),
  }));
  const sourceDigest = sha(JSON.stringify(stable({
    version: 1,
    language: project.language,
    entry,
    files: inventory.map(({ path: file, content, content_digest }) => ({
      path: file,
      content_digest,
      size_bytes: Buffer.byteLength(content),
    })),
    asset_refs: assetRefs,
  })));
  if (project.source_digest !== sourceDigest) fail("source_digest_mismatch");
  return {
    document: { imports: [], root },
    fragments,
    asset_refs: assetRefs,
    source_files: inventory.map(({ path: file, content }) => ({ file, content })),
    source_digest: sourceDigest,
    expansion_map: {
      schema_version: "SourceExpansionMap/1",
      source_project_digest: sourceDigest,
      entries: expansionEntries.sort((a, b) => `${a.node}:${a.property || ""}`.localeCompare(`${b.node}:${b.property || ""}`)),
    },
  };
}
