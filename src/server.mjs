// MCP stdio server (newline-delimited JSON-RPC 2.0). No third-party dependencies.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { PACKAGE, SERVER_NAME, PREVIEW_PORT, PROJECTS_ROOT } from "./paths.mjs";
import { engineStatus, ensureEngine } from "./engine.mjs";
import { compileNamed, createProject, listProjects, readSource, writeSource, patchSource, batchEdit, sourceState, projectDir, DEFAULT_ANCHOR } from "./project.mjs";
import { dedupeErrors, locateRuntimeErrors } from "./diagnose.mjs";
import { inspectScene, readIR, readAnchor, requestedCamera } from "./inspect.mjs";
import { startPreview, projectUrl, fetchPageStatus, pageCommand } from "./preview.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogSummary, catalogComponent, catalogComponents, catalogDigest } from "./catalog.mjs";
import { CLIP_PLANE_POLICY, FOV_POLICY } from "./runtime-support.mjs";
import { CompileError } from "./compile.mjs";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = `SSWorld: author 3D geographic scenes with the SSDL scene description language (a QML-like subset, right-handed Z-up, metres) and run them on the SSEngine WebGPU runtime.
Workflow: ssworld_catalog (index, or components: [...] with detail 'compact' for several contracts at once) -> ssworld_project_create -> ssworld_source_read (mode 'metadata' for digests/sizes, 'node' for one node, offset/limit for ranges) -> ssworld_source_patch / ssworld_source_batch (atomic multi-edit, optional compile+rollback) / ssworld_source_write -> ssworld_compile (real diagnostics + budget usage) -> ssworld_scene_inspect (hierarchy, extent, requested camera) -> ssworld_preview (URL to open in a WebGPU browser) -> ssworld_capture_frame (screenshot + stats + receipt binding the frame to source/IR digests + requested vs effective camera + runtime errors mapped to scene.ssdl:line).
Assets: copy glb models (and png/jpg textures) into <project>/assets/ and reference them by project-relative path (Model { source: "assets/name.glb" }); ssworld_compile discovers them (usage.assets) and rejects oversize files (asset_budget). Compile success means the scene is well-formed, not that it looks right; open the preview, then call ssworld_capture_frame and look at the image before reporting. Every result carries next: {action, reason, ...} naming the next step; 'open_webgpu_viewer' means the client must open next.url in a visible WebGPU browser tab (a client capability, not an SSWorld tool). reference_match stays not_evaluated unless a comparison was actually run.
Conventions: local metres, x east / y north / z up around the project anchor; geometry rotation quaternions are [x, y, z, w], environment component rotation is Euler degrees; CameraView takes position/lookAt in local metres (or longitude/latitude/height), fov in HORIZONTAL degrees (the vertical fov follows the aspect); ${CLIP_PLANE_POLICY}. Scene logic: 'property real score: 0' on the Scene root, handler assignments with arithmetic, comparisons (>=, <=, ===, !==) in bindings, and 'Iface.method(arg: expr)' host calls declared in host_interfaces.json + implemented in logic.mjs; ssworld_catalog.logic documents the surface, ssworld_capture_frame returns the live values as 'logic'; ssworld_logic_read / ssworld_logic_write read and set declared properties on the open page in one transaction (States are derived and cannot be written), and ssworld_capture_frame { await: {state|property, ...} } waits for a game state before shooting instead of editing initial values.
Runtime evidence: a binding whose value the target refuses rolls its whole batch back and freezes the affected values; the page reports it as runtime.errors kind 'binding_error' (mapped to scene.ssdl:line) and logic.bindings.invalid, so check runtime.errors before judging a frame. Several browsers may have the same page open (desktop preview pane + automation browser): ssworld_preview lists them as page.clients, every capture receipt names the answering receipt.client, and capture/logic tools accept client: "<id>" to pick one.`;

const log = (line) => process.stderr.write(`[ssworld-mcp] ${line}\n`);

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], structuredContent: typeof value === "object" ? value : undefined };
}

/** Structured continuation shared by every tool: what the client should do next and why. */
function next(action, reason, extra = {}) { return { action, reason, blocking: Boolean(extra.blocking), ...extra }; }
const NEXT = {
  compile: () => next("compile", "sources changed; ssworld_compile rebuilds from disk"),
  open: (url) => next("open_webgpu_viewer", "no preview page is syncing for this project; open url in a visible WebGPU browser tab (Chrome/Edge), then call ssworld_capture_frame", { url, blocking: true }),
  capture: () => next("capture_frame", "the page is open and hot reloads; ssworld_capture_frame returns the frame, stats and runtime errors"),
  front: (visibility) => next("bring_page_to_front", `the page is ${visibility}; a minimised or background tab does not paint, so it cannot capture`, { blocking: true }),
  fix: (diagnostic) => next("fix_source", "compile failed; edit the file at the diagnostic location and compile again", { file: diagnostic?.file, line: diagnostic?.line }),
  fixRuntime: (error) => next("fix_source", `runtime error: ${error.message}`, error.source ? { file: error.source.file, line: error.source.line } : {}),
  judge: () => next("judge_frame", "no runtime errors; judge composition from the image and stats.regions, then iterate with ssworld_source_batch"),
  engine: () => next("install_engine", "the SSEngine WebGPU runtime pair is not installed; call ssworld_engine_status { install: true }", { blocking: true }),
};

/** The page that will answer a command, or a structured page_not_open / client_not_connected error. */
async function requirePage(project, client) {
  const page = await fetchPageStatus(project, { client: client || null });
  if (page.connected) return page;
  const started = await startPreview({ log });
  const url = projectUrl(project, started.port);
  if (client && page.clients?.length) {
    throw Object.assign(new Error(`page client '${client}' is not syncing; connected clients: ${page.clients.map((item) => item.id).join(", ")}`),
      { code: "client_not_connected", extra: { page, next: next("pick_client", "pass one of page.clients[].id or omit client for the most recent visible page", { blocking: true }) } });
  }
  throw Object.assign(new Error("preview page is not open; open viewer_url in a WebGPU browser (keep it visible), then call the tool again"),
    { code: "page_not_open", extra: { viewer_url: url, page, next: NEXT.open(url) } });
}

/** Turn a failed preview command reply (timeout, page gone) into a tool error with a next step. */
function commandFailure(reply, retryAction) {
  const visibility = reply.page?.status?.visibility;
  const hidden = visibility && visibility !== "visible";
  const message = reply.error === "page_timeout"
    ? (hidden ? `the page is ${visibility} (minimised or background tab); bring it to the front and retry` : "the page did not answer in time (is the tab visible and painting?)")
    : String(reply.error);
  return Object.assign(new Error(message), { code: reply.error, extra: { page: reply.page, next: hidden ? NEXT.front(visibility) : next(retryAction, message, { blocking: true }) } });
}

const TOOLS = [
  {
    name: "ssworld_catalog",
    description: "List SSDL components (index) or read component contracts. component: one full contract; components: several at once (detail 'compact' collapses members to 'type unit' strings and hoists shared members). Every answer carries catalog_digest; pass if_digest to get {unchanged: true} when nothing moved. Read this before writing SSDL.",
    inputSchema: { type: "object", properties: {
      component: { type: "string", description: "Component type name for one full contract; omit for the index." },
      components: { type: "array", items: { type: "string" }, maxItems: 40, description: "Several component names in one call; unknown names are listed under unknown instead of failing." },
      detail: { type: "string", enum: ["full", "compact"], description: "For components: 'full' (default) or 'compact'." },
      if_digest: { type: "string", description: "catalog_digest from an earlier call; returns {unchanged: true} if it still matches." },
    }, additionalProperties: false },
    annotations: { title: "SSDL catalog", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: ({ component, components, detail, if_digest }) => {
      if (if_digest && if_digest === catalogDigest()) return { catalog_digest: if_digest, unchanged: true };
      if (Array.isArray(components) && components.length) return catalogComponents(components, { detail: detail || "full" });
      return component ? catalogComponent(component) : catalogSummary();
    },
  },
  {
    name: "ssworld_project_list",
    description: "List existing SSWorld projects in the local workspace with their compile state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List projects", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: () => ({ workspace: PROJECTS_ROOT, projects: listProjects() }),
  },
  {
    name: "ssworld_project_create",
    description: "Create a new runnable SSDL project and compile it. template 'starter' (default) is a tappable rotating box; 'empty' is just Scene + local-frame CameraView/Camera for scenes you write from scratch. Never overwrites an existing project.",
    inputSchema: { type: "object", required: ["name"], properties: {
      name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$", description: "Project name; letters, digits, '_' and '-'." },
      title: { type: "string", description: "Page title shown in the preview; defaults to the name." },
      longitude: { type: "number", description: "Anchor longitude in degrees (WGS84). Default: Shenzhen civic centre." },
      latitude: { type: "number", description: "Anchor latitude in degrees." },
      height: { type: "number", description: "Anchor height in metres above the ellipsoid. Default 150." },
      template: { type: "string", enum: ["starter", "empty"], description: "Starting scene.ssdl; default starter." },
    }, additionalProperties: false },
    annotations: { title: "Create project", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async ({ name, title, longitude, latitude, height, template }) => ({ ...(await createProject(name, { title, template, anchor: {
      lon: longitude ?? DEFAULT_ANCHOR.lon, lat: latitude ?? DEFAULT_ANCHOR.lat, height: height ?? DEFAULT_ANCHOR.height } })),
      next: next("read_source", "read scene.ssdl (or its metadata) and edit it; then compile and preview") }),
  },
  {
    name: "ssworld_source_read",
    description: "Read project source. Default mode 'content' returns the file text bounded by max_chars (default 100000) with has_more/next_offset; offset (1-based line) + limit read a range. mode 'metadata' returns every file's digest/bytes/lines plus compile state (source_digest vs compiled_source_digest, stale) without any text. node: '<id>' returns just the block declaring that node (file, line range, text, compiled properties). file '*' reads every .ssdl file.",
    inputSchema: { type: "object", required: ["project"], properties: {
      project: { type: "string" }, file: { type: "string", description: "Relative .ssdl path, logic.mjs or host_interfaces.json; default scene.ssdl; '*' for all files." },
      mode: { type: "string", enum: ["content", "metadata", "node"], description: "Default content." },
      offset: { type: "integer", minimum: 1, description: "First line to return (1-based)." },
      limit: { type: "integer", minimum: 1, description: "Number of lines to return." },
      max_chars: { type: "integer", minimum: 1000, maximum: 1000000, description: "Upper bound on returned text per file; default 100000." },
      node: { type: "string", description: "Node id; implies mode 'node'." },
    }, additionalProperties: false },
    annotations: { title: "Read SSDL source", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: ({ project, file, mode, offset, limit, max_chars, node }) => readSource(project, file || "scene.ssdl", { mode: mode || "content", offset: offset || 1, limit, maxChars: max_chars || 100000, node }),
  },
  {
    name: "ssworld_source_write",
    description: "Replace a whole .ssdl file (or logic.mjs / host_interfaces.json for host logic and its contract). Pass expected_digest from ssworld_source_read (or 'new' for a new component file). For edits prefer ssworld_source_patch / ssworld_source_batch. Does not compile; call ssworld_compile next. Editing the .ssdl files in the project directory with any other file tool also works (ssworld_compile always rebuilds from disk) but bypasses the digest lock.",
    inputSchema: { type: "object", required: ["project", "file", "content", "expected_digest"], properties: {
      project: { type: "string" }, file: { type: "string" }, content: { type: "string", description: "Full new file content (UTF-8, ≤1 MiB)." },
      expected_digest: { type: "string", description: "sha256 hex from the last read, or 'new'." } }, additionalProperties: false },
    annotations: { title: "Write SSDL source", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: ({ project, file, content, expected_digest }) => ({ ...writeSource(project, file, content, expected_digest), next: NEXT.compile() }),
  },
  {
    name: "ssworld_source_patch",
    description: "Edit one span of a .ssdl file without resending it: old_string must match exactly once (whitespace included) unless replace_all is true. Pass expected_digest from the last read; returns the new digest. Does not compile; call ssworld_compile next.",
    inputSchema: { type: "object", required: ["project", "file", "old_string", "new_string"], properties: {
      project: { type: "string" }, file: { type: "string", description: "Relative .ssdl path, e.g. scene.ssdl." },
      old_string: { type: "string", description: "Exact text to replace; include enough context to be unique." },
      new_string: { type: "string", description: "Replacement text (may be empty to delete)." },
      expected_digest: { type: "string", description: "sha256 hex from the last read or write; omit to skip the stale check." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." } }, additionalProperties: false },
    annotations: { title: "Patch SSDL source", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: ({ project, file, old_string, new_string, expected_digest, replace_all }) => ({ ...patchSource(project, file, old_string, new_string ?? "", expected_digest, { replaceAll: Boolean(replace_all) }), next: NEXT.compile() }),
  },
  {
    name: "ssworld_source_batch",
    description: "Apply several edits atomically across one or more .ssdl files: text patches ({file, old_string, new_string, replace_all?}) and node property edits ({node_id, set: {member: value}, unset: [member]} — values are JSON numbers/strings/booleans/[x,y,z] arrays, or {raw: '<ssdl expression>'} for ids/enums/bindings; file is found from the id). Every edit is validated in memory first; any failure (stale digest, missing/ambiguous span or node) writes nothing. validate 'compile' compiles afterwards and, with rollback_on_validation_error (default true), restores the previous sources when the compile fails. Returns per-file digest_before/digest.",
    inputSchema: { type: "object", required: ["project", "edits"], properties: {
      project: { type: "string" },
      edits: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", properties: {
        file: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" },
        node_id: { type: "string" }, set: { type: "object", additionalProperties: true }, unset: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
      expected_digests: { type: "object", additionalProperties: { type: "string" }, description: "{file: sha256} guards for the files you read; omit to skip the stale check." },
      expected_digest: { type: "string", description: "Shortcut for a single-file batch (scene.ssdl unless the edits name another file)." },
      validate: { type: "string", enum: ["none", "compile"], description: "Default none." },
      rollback_on_validation_error: { type: "boolean", description: "Default true; restore the previous sources (and recompile them) if validate: compile fails." },
    }, additionalProperties: false },
    annotations: { title: "Batch edit SSDL source", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async ({ project, edits, expected_digests, expected_digest, validate, rollback_on_validation_error }) => {
      const result = await batchEdit(project, { edits, expectedDigests: expected_digests || {}, expectedDigest: expected_digest, validate: validate || "none", rollbackOnValidationError: rollback_on_validation_error !== false });
      return { ...result, next: result.compiled ? next("preview_or_capture", "compiled; the open preview hot reloads, call ssworld_capture_frame (or ssworld_preview first)") : result.ok ? NEXT.compile() : NEXT.fix(result.compile_failed) };
    },
  },
  {
    name: "ssworld_compile",
    description: "Compile the project with the SSDL 0.3 compiler (always from the files on disk). Returns digests, node_count and budget usage (usage.assets lists the glb/png/jpg files found under assets/) on success, or the compiler diagnostic (file:line:column, code, message) on failure. Members the catalog marks as not runtime-writable are rejected here too (runtime_unsupported).",
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" } }, additionalProperties: false },
    annotations: { title: "Compile SSDL", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async ({ project }) => {
      const compiled = await compileNamed(project);
      const page = await fetchPageStatus(project);
      return { ...compiled,
        ...(page.connected ? { hot_reload: { clients: page.clients.map((item) => item.id), logic_reset: true,
          note: "the open page reloads this generation now; declared properties and States restart at their initial values (use ssworld_logic_write to restore a game situation)" } } : {}),
        next: next("preview_or_capture", "compiled; call ssworld_preview (first time) or ssworld_capture_frame (page already open, it hot reloads)") };
    },
  },
  {
    name: "ssworld_scene_inspect",
    description: "Inspect the compiled scene without rendering: node count vs budget, child subtrees ranked by size, leaf children by type, node attribution per source file, an axis-aligned extent of the primitive geometry (lowest bottom / highest top), and the camera pose the scene requests (position, lookAt-derived heading/pitch, fov). subtree limits the tree and extent to one node id. Render statistics (draw calls, triangles) are reported as unavailable, never estimated.",
    inputSchema: { type: "object", required: ["project"], properties: {
      project: { type: "string" }, subtree: { type: "string", description: "Node id to inspect instead of the Scene root." },
      top: { type: "integer", minimum: 1, maximum: 100, description: "How many subtrees to list; default 12." } }, additionalProperties: false },
    annotations: { title: "Inspect scene", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: async ({ project, subtree, top }) => {
      const directory = projectDir(project);
      const state = await sourceState(directory);
      return { project, ...inspectScene(directory, { subtree: subtree || null, top: top || 12 }), source: state,
        ...(state.stale ? { warning: "sources changed since the last compile; this reflects the compiled scene, call ssworld_compile" } : {}) };
    },
  },
  {
    name: "ssworld_preview",
    description: "Compile the project, make sure the engine is installed and the local preview server is running, and return the URL to open in a WebGPU-capable browser. The page hot-reloads on later writes+compiles. page.clients lists every browser that has the page open (id, visibility, canvas size, user agent) and page.client the one that would answer a capture; next.action tells whether the page must still be opened (open_webgpu_viewer) or can be captured.",
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" } }, additionalProperties: false },
    annotations: { title: "Preview scene", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async ({ project }) => {
      const compiled = await compileNamed(project);
      const started = await startPreview({ log });
      const page = await fetchPageStatus(project);
      const url = projectUrl(project, started.port);
      const visible = page.connected && (!page.status?.visibility || page.status.visibility === "visible");
      return { ...compiled, viewer_url: url, preview: started, page, render_verified: false,
        next: !page.connected ? NEXT.open(url) : visible ? NEXT.capture() : NEXT.front(page.status.visibility),
        next_action: page.connected
          ? "The page is open and will hot reload; call ssworld_capture_frame to see the frame and runtime errors."
          : "Open viewer_url in a browser with WebGPU (Chrome/Edge), keep it visible, then call ssworld_capture_frame; a 200 from the server does not prove it rendered." };
    },
  },
  {
    name: "ssworld_capture_frame",
    description: "Screenshot the project's open preview page through the engine: an offscreen WebGPU render at the requested width x height (horizontal fov kept, the vertical fov follows the requested aspect, no scaling/cropping, the interactive view is untouched). Returns the PNG as image content (also saved under captures/), pixel statistics (luma percentiles, exposure tails, colour-class coverage overall and per 3x3 region, top colours), a receipt binding the frame to the source/IR digests, page generation and the answering page (receipt.client: id, visibility, canvas, user agent; clients_connected when several browsers have the page open), framing details, runtime errors since the last hot reload mapped to scene.ssdl:line (kind binding_error = a binding's value was refused and its batch rolled back), camera {effective pose, source, requested (from the scene's CameraView), deviation with reasons}, and `logic` (declared scene properties, State.when values, host call errors and bindings.invalid as the page holds them right now, so `score === 8` can be asserted without reading pixels). await waits for a State/property condition before shooting (await_timeout with the live logic otherwise). reference_match is always not_evaluated (no reference comparison is run). Requires the viewer_url from ssworld_preview to be open and visible; returns page_not_open otherwise.",
    inputSchema: { type: "object", required: ["project"], properties: {
      project: { type: "string" },
      width: { type: "integer", minimum: 64, maximum: 4096, description: "Capture width in pixels; default 800." },
      height: { type: "integer", minimum: 64, maximum: 4096, description: "Capture height; default keeps 16:9." },
      settle_ms: { type: "integer", minimum: 0, maximum: 10000, description: "Wait before capturing (camera flights, animations); default 500." },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "How long to wait for the page to answer; default 20000 (raised automatically to cover await.timeout_ms)." },
      client: { type: "string", description: "Page client id (from ssworld_preview page.clients / a capture receipt.client.id) that must answer; default: the most recently synced visible page." },
      detail: { type: "string", enum: ["full", "brief"], description: "'brief' returns only what an iteration loop reads (verdict, next, runtime errors, luma, 3x3 regions, capture path, in_sync, logic) and drops the framing/receipt/camera/coverage blocks; default 'full'." },
      await: { type: "object", description: "Capture only once the scene logic satisfies this: {state: 'corner'} (State.when true; equals: false for the opposite) or {property: 'p', equals: 0.4} / {property: 'p', min: 0.3, max: 0.5}; timeout_ms default 5000 (max 60000).",
        properties: { state: { type: "string" }, property: { type: "string" }, equals: {}, min: { type: "number" }, max: { type: "number" }, timeout_ms: { type: "integer", minimum: 0, maximum: 60000 } }, additionalProperties: false },
    }, additionalProperties: false },
    annotations: { title: "Capture preview frame", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rich: true,
    run: async ({ project, width, height, settle_ms, timeout_ms, client, await: awaitSpec, detail }) => {
      const directory = projectDir(project);
      const page = await requirePage(project, client);
      const requestedWidth = width || 800;
      const requestedHeight = height || Math.round(requestedWidth * 9 / 16);
      const awaitBudget = awaitSpec ? Math.min(awaitSpec.timeout_ms ?? 5000, 60000) : 0;
      const timeoutMs = Math.max(timeout_ms || 20000, awaitBudget + 8000);
      const reply = await pageCommand(project, "capture", { width: requestedWidth, height: requestedHeight, settle_ms: settle_ms ?? 500, ...(awaitSpec ? { await: { ...awaitSpec, timeout_ms: awaitBudget } } : {}) },
        { timeoutMs, client: page.client?.id });
      if (!reply.ok) throw commandFailure(reply, "retry_capture");
      const result = reply.result;
      if (!result.ok) {
        const code = result.code || "capture_failed";
        const reason = code === "await_timeout" ? "the condition did not become true; check logic (live values) and whether the game actually reaches that state" : result.error;
        throw Object.assign(new Error(result.error), { code, extra: { status: result.status, ...(result.logic ? { logic: result.logic } : {}), client: reply.page?.client ?? null,
          next: next(code === "await_timeout" ? "inspect_logic" : "retry_capture", reason, { blocking: code !== "await_timeout" }) } });
      }
      const capturedAt = new Date();
      const stamp = capturedAt.toISOString().replace(/[:.]/g, "-");
      const capturesDir = path.join(directory, "captures");
      mkdirSync(capturesDir, { recursive: true });
      const file = path.join(capturesDir, `${stamp}.png`);
      const png = Buffer.from(result.png_base64, "base64");
      writeFileSync(file, png);
      const { stats, status } = result;
      status.errors = locateRuntimeErrors(directory, dedupeErrors(status.errors || []));
      const loaded = status.state === "ready" && status.errors.length === 0;

      // Receipt: which sources / compiled scene / page generation this frame belongs to.
      const state = await sourceState(directory);
      const engine = engineStatus();
      const pageDigest = status.loaded?.scene_ir_digest ?? null;
      const staleness = [];
      if (state.stale) staleness.push("sources on disk changed since the last compile (call ssworld_compile)");
      if (pageDigest && state.scene_ir_digest && pageDigest !== state.scene_ir_digest) staleness.push("the page runs an older compile than the one on disk (hot reload pending or failed)");
      if (!pageDigest) staleness.push("page did not report its loaded scene_ir_digest (older page or scene not loaded)");
      if (!loaded) staleness.push("scene module is not in ready state, the frame shows the engine default view");
      const receipt = { capture_id: `${project}/${stamp}`, captured_at: capturedAt.toISOString(), capture_path: file,
        image_sha256: createHash("sha256").update(png).digest("hex"), image_bytes: png.length,
        source_digest: state.source_digest, compiled_source_digest: state.compiled_source_digest, scene_ir_digest: state.scene_ir_digest,
        page_scene_ir_digest: pageDigest, page_generation: status.generation ?? null,
        engine_id: engine.engine_id || null, server_version: PACKAGE.version,
        in_sync: staleness.length === 0, staleness,
        // Which browser answered: several may have the page open (desktop preview pane + automation browser).
        client: reply.page?.client ?? null, client_selection: reply.page?.selection ?? null, clients_connected: reply.page?.clients?.length ?? null,
        ...(reply.page?.clients?.length > 1 && !client ? { client_note: `${reply.page.clients.length} pages sync this project; this frame comes from client ${reply.page.client?.id}; pass client to pick another (see ssworld_preview page.clients)` } : {}) };

      // Framing: what the engine did with the requested size (verified against LiRenderSystem offscreen path).
      const effective = result.camera && !result.camera.error ? result.camera : null;
      const aspect = requestedWidth / requestedHeight;
      const hfov = effective?.fov ?? null;
      const framing = { mode: "offscreen_render_at_requested_size", requested: { width: requestedWidth, height: requestedHeight },
        output: { width: stats.width, height: stats.height }, interactive_canvas: status.canvas ? { ...status.canvas, device_pixel_ratio: status.device_pixel_ratio ?? null } : null,
        projection: { aspect: Number(aspect.toFixed(4)), horizontal_fov_deg: hfov, vertical_fov_deg: hfov ? Number((2 * Math.atan(Math.tan(hfov * Math.PI / 360) / aspect) * 180 / Math.PI).toFixed(2)) : null, note: FOV_POLICY },
        scaling: "none", crop: null, interactive_view_restored: true,
        note: "the engine renders one extra frame into an offscreen target of the requested size; the camera keeps its horizontal fov and pose, the vertical fov follows the requested aspect, the on-screen canvas and controller are not modified" };

      // Camera: effective pose from the page vs what the scene asked for.
      const ir = readIR(directory);
      const requested = requestedCamera(ir, readAnchor(directory));
      let camera = result.camera;
      if (effective) {
        camera = { ...effective, source: loaded ? "scene" : "engine_default",
          ...(loaded ? {} : { note: "the scene module did not load, so this pose is the engine's default view, not your CameraView" }) };
        if (requested) {
          const deviation = {};
          const near = (a, b, tolerance) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
          if (Number.isFinite(requested.fov)) deviation.fov = { requested: requested.fov, effective: effective.fov, ok: near(requested.fov, effective.fov, 0.5) };
          for (const plane of ["nearPlane", "farPlane"]) if (Number.isFinite(requested[plane])) {
            const key = plane === "nearPlane" ? "near_plane" : "far_plane";
            deviation[plane] = { requested: requested[plane], effective: effective[key], ok: near(requested[plane], effective[key], Math.max(1, requested[plane] * 0.01)), reason: CLIP_PLANE_POLICY };
          }
          const angle = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return Number(d.toFixed(2)); };
          if (Number.isFinite(requested.heading) && Number.isFinite(effective.heading)) deviation.heading_error_deg = angle(requested.heading, effective.heading);
          if (Number.isFinite(requested.pitch) && Number.isFinite(effective.pitch)) deviation.pitch_error_deg = Number(Math.abs(requested.pitch - effective.pitch).toFixed(2));
          if (Number.isFinite(requested.latitude) && Number.isFinite(effective.latitude) && Number.isFinite(effective.longitude)) {
            const dy = (effective.latitude - requested.latitude) * 111320;
            const dx = (effective.longitude - requested.longitude) * 111320 * Math.cos(requested.latitude * Math.PI / 180);
            const dz = Number.isFinite(effective.height) && Number.isFinite(requested.height) ? effective.height - requested.height : 0;
            deviation.position_error_m = Number(Math.hypot(dx, dy, dz).toFixed(1));
            if (requested.geo_note) deviation.position_note = requested.geo_note;
          }
          if (!loaded) deviation.reason = "scene not loaded; the effective pose is the engine default";
          camera.requested = requested;
          camera.deviation = deviation;
        }
      }

      const blank = stats.distinct_colors < 64 || stats.non_black_ratio < 0.1;
      const verified = loaded && !blank;
      const firstError = status.errors[0];
      const where = firstError?.source ? ` at ${firstError.source.file}:${firstError.source.line}:${firstError.source.column}` : "";
      const full = {
        ok: true, project, capture_path: file, receipt, framing, stats, camera, runtime: status,
          logic: status.logic ?? null,
          ...(result.awaited ? { awaited: result.awaited } : {}),
          render_verified: verified,
          reference_match: { status: "not_evaluated", method: null, metrics: null, note: "no reference image comparison is performed by this tool" },
          verdict: verified ? (receipt.in_sync ? "frame captured from the running scene with no runtime errors; judge composition from the image and stats.regions"
              : `frame captured with no runtime errors, but it may not show the latest sources: ${staleness.join("; ")}`)
            : status.errors.length ? `runtime reported ${status.errors.length} error(s): ${firstError.message}${where}; fix the source and compile again`
            : status.state !== "ready" ? `runtime state is '${status.state}': ${status.hint}`
            : "frame is blank or nearly black; the camera may be pointing at nothing",
          next: status.errors.length ? NEXT.fixRuntime(firstError) : !loaded ? next("wait_or_reload", `runtime state '${status.state}'; wait for the load to finish or fix the compile error shown on the page`)
            : !receipt.in_sync ? next("recompile_and_recapture", staleness[0]) : NEXT.judge(),
      };
      return { payload: detail === "brief" ? briefCapture(full) : full, images: [{ data: result.png_base64, mimeType: "image/png" }] };
    },
  },
  {
    name: "ssworld_logic_read",
    description: "Read the page's scene logic AND whether the scene module is actually loaded, without a screenshot: runtime.state / runtime.errors (mapped to scene.ssdl:line) plus declared properties, State.when values, host call errors, bindings.invalid (bindings whose last value was refused) and binding_errors. This is the cheap 'did it load' probe: when a scene module fails to mount, a capture only shows the engine's default earth view, while this returns the state and the errors for a fraction of the tokens. Read it twice a few seconds apart to prove a game loop is actually advancing (a frozen value with no runtime error is what a rolled-back binding batch looks like). client picks one of several open pages.",
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" }, client: { type: "string", description: "Page client id; default: most recent visible page." },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000, description: "Default 10000." } }, additionalProperties: false },
    annotations: { title: "Read scene logic", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async ({ project, client, timeout_ms }) => {
      const page = await requirePage(project, client);
      const reply = await pageCommand(project, "logic_read", {}, { timeoutMs: timeout_ms || 10000, client: page.client?.id });
      if (!reply.ok) throw commandFailure(reply, "retry_logic_read");
      // The page answers with its runtime status either way: a module that failed to mount is a normal
      // answer here (state + located errors), not a tool failure that costs a screenshot to diagnose.
      const runtime = moduleRuntime(projectDir(project), reply.result.status);
      if (!reply.result.ok) throw Object.assign(new Error(reply.result.error), { code: reply.result.code || "logic_read_failed", extra: { status: reply.result.status, runtime, next: next("wait_or_reload", reply.result.error, { blocking: true }) } });
      const logic = reply.result.logic;
      const invalid = logic?.bindings?.invalid || [];
      const firstError = runtime.errors[0];
      return { ok: true, project, client: reply.page?.client ?? null, clients_connected: reply.page?.clients?.length ?? null,
        loaded: runtime.loaded, runtime, logic,
        next: firstError ? NEXT.fixRuntime(firstError)
          : !runtime.loaded ? next("wait_or_reload", `runtime state '${runtime.state}': ${runtime.hint || "the scene module is not mounted"}`, { blocking: true })
          : invalid.length ? next("fix_source", `${invalid.length} binding(s) are invalid (their value was refused and the batch rolled back): ${invalid.map((item) => `${item.target}.${item.property} ${item.code || ""}`).join("; ")}`)
          : next("judge_logic", "compare properties/states with what the game should be doing; call again to see whether they advance") };
    },
  },
  {
    name: "ssworld_logic_write",
    description: "Set declared scene properties on the open preview page in ONE event transaction (the same path as window.SSWorld.logical.write): {set: {p: 0.4, pace: 0.0025}}. Use it to put the game into a situation (a corner, the last lap) before ssworld_capture_frame instead of editing initial values in the sources. Returns before/after logic and the transaction receipt; a refused value rolls every property in the set back and the error names the failing binding (logical_write_rejected). States are derived from their `when` expression and cannot be written (logic_property_unknown tells you so): set a declared property they read.",
    inputSchema: { type: "object", required: ["project", "set"], properties: { project: { type: "string" },
      set: { type: "object", minProperties: 1, additionalProperties: true, description: "{declaredProperty: value}; numbers for real/length/degrees/duration/radians, booleans for bool, strings for string." },
      client: { type: "string", description: "Page client id; default: most recent visible page." },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000, description: "Default 10000." } }, additionalProperties: false },
    annotations: { title: "Write scene logic", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async ({ project, set, client, timeout_ms }) => {
      const page = await requirePage(project, client);
      const reply = await pageCommand(project, "logic_write", { set }, { timeoutMs: timeout_ms || 10000, client: page.client?.id });
      if (!reply.ok) throw commandFailure(reply, "retry_logic_write");
      const result = reply.result;
      if (!result.ok) {
        const code = result.code || "logic_write_failed";
        throw Object.assign(new Error(result.error), { code, extra: { ...(result.failure ? { failure: result.failure } : {}), ...(result.logic ? { logic: result.logic } : {}), client: reply.page?.client ?? null,
          next: code === "logical_write_rejected" ? next("fix_source", `a binding refused the new value and the whole write rolled back: ${result.failure ? `${result.failure.target}.${result.failure.property} (${result.failure.code})` : result.error}`)
            : next("fix_call", result.error) } });
      }
      return { ok: true, project, client: reply.page?.client ?? null, before: result.before, after: result.after, receipt: result.receipt,
        next: next("capture_frame", "the page holds the new values; ssworld_capture_frame (optionally with await) shows the resulting frame") };
    },
  },
  {
    name: "ssworld_environment_read",
    description: "Ask the ENGINE what it actually received for the environment, instead of bisecting it with screenshots: the adopted sun's real direction read back from the native sun and converted to azimuth/elevation at the project anchor (with the deviation from what the scene asked for), which DirectionalLight drives the atmosphere, and the live values of every environment component (SkyAtmosphere, ExponentialHeightFog, VolumetricCloud, SkyLight, PostProcessVolume, owned lights) as the native side holds them right now. Answers \"why is the sky orange\" / \"where is the sun\" in one call. Requires the preview page to be open; a page whose index.html predates this probe answers page_probe_unavailable and names the handler to paste in.",
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" },
      client: { type: "string", description: "Page client id; default: most recent visible page." },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000, description: "Default 10000." } }, additionalProperties: false },
    annotations: { title: "Read engine environment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async ({ project, client, timeout_ms }) => {
      const directory = projectDir(project);
      const page = await requirePage(project, client);
      const reply = await pageCommand(project, "environment_read", {}, { timeoutMs: timeout_ms || 10000, client: page.client?.id });
      if (!reply.ok) throw commandFailure(reply, "retry_environment_read");
      const result = reply.result;
      if (!result.ok) {
        // index.html is project-owned, so an older page simply does not know the command; say exactly how to fix it.
        if (/unknown command environment_read/.test(result.error || "")) {
          throw Object.assign(new Error("this project's index.html predates the environment probe"), { code: "page_probe_unavailable",
            extra: { fix: "add one line to the runCommand switch in index.html (ssworld_source_patch works on it): `if (command.kind === \"environment_read\") return { id: command.id, ok: true, environment: readEnvironment(), status: pageStatus() };` and copy readEnvironment() from a project created with this server version",
              next: next("patch_page", "the page is project-owned and is not rewritten automatically") } });
        }
        throw Object.assign(new Error(result.error), { code: result.code || "environment_read_failed",
          extra: { runtime: moduleRuntime(directory, result.status), next: next("wait_or_reload", result.error, { blocking: true }) } });
      }
      const environment = result.environment;
      const runtime = moduleRuntime(directory, result.status);
      // The one comparison the author cannot make by eye: what the scene asked the sun to do vs where it is.
      const sunLight = (environment.components || []).find((item) => item.atmosphere_sun_light);
      const requested = sunLight?.requested_sun ?? null;
      const deviation = requested && environment.engine_sun?.readable ? {
        azimuth_error_deg: Number(Math.abs(((environment.engine_sun.azimuth_deg - ((requested.azimuth % 360) + 360) % 360) % 360 + 540) % 360 - 180).toFixed(2)),
        elevation_error_deg: Number(Math.abs(environment.engine_sun.elevation_deg - requested.elevation).toFixed(2)),
      } : null;
      return { ok: true, project, client: reply.page?.client ?? null, loaded: runtime.loaded, runtime,
        anchor: environment.anchor, engine_sun: environment.engine_sun,
        atmosphere_sun_light: sunLight ? { id: sunLight.id, requested, deviation, locked: sunLight.sun_direction_locked ?? null } : null,
        components: environment.components,
        verdict: !runtime.loaded ? `the scene module is not mounted (state '${runtime.state}'), so these are the engine defaults, not your scene`
          : deviation && (deviation.azimuth_error_deg > 1 || deviation.elevation_error_deg > 1)
            ? `the engine sun is ${deviation.azimuth_error_deg} deg of azimuth and ${deviation.elevation_error_deg} deg of elevation away from what the scene asked for; something else is writing the sun (another DirectionalLight, or an engine without the direction lock)`
          : "values are read back from the native components; compare them with the scene source before changing anything",
        next: next("judge_environment", "compare engine_values with what the source wrote; sky colour comes from the sun (lightColor/sunElevation), not from the scattering vectors") };
    },
  },
  {
    name: "ssworld_engine_status",
    description: "Report whether the SSEngine WebGPU runtime pair (SSmap.js/SSmap.wasm) is installed locally; optionally download it now.",
    inputSchema: { type: "object", properties: { install: { type: "boolean", description: "Download the pinned engine if missing." } }, additionalProperties: false },
    annotations: { title: "Engine status", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async ({ install }) => { const status = install ? await ensureEngine({ log }) : engineStatus(); return { ...status, next: status.ready ? next("preview", "engine installed; ssworld_preview serves it") : NEXT.engine() }; },
  },
];

/** Module load state as the page holds it, with runtime errors mapped back to the sources. */
function moduleRuntime(directory, status) {
  const errors = locateRuntimeErrors(directory, dedupeErrors(status?.errors || []));
  // `loaded` answers one question only: did the scene module mount?  The page sets "ready" when a
  // generation is retained and "failed" when it is not, so that is the whole answer.  Errors are a
  // separate axis: a binding that was refused and rolled back leaves a mounted, running page, and
  // folding it in here would report "not loaded" for exactly the case this tool exists to tell apart.
  return { state: status?.state ?? null, generation: status?.generation ?? null, hint: status?.hint ?? null,
    loaded: status?.state === "ready", errors };
}

/**
 * What an iteration loop actually reads: the verdict, what failed, how bright the frame is and how the
 * nine regions look.  The framing/receipt/camera/coverage blocks are several thousand tokens per call
 * and are only needed when a specific question is about them, so `detail: "brief"` drops them.
 */
function briefCapture(full) {
  const { stats, runtime, receipt } = full;
  return {
    ok: true, project: full.project, capture_path: full.capture_path, detail: "brief",
    in_sync: receipt.in_sync, ...(receipt.in_sync ? {} : { staleness: receipt.staleness }),
    render_verified: full.render_verified,
    runtime: { state: runtime.state, errors: runtime.errors, ...(runtime.hint ? { hint: runtime.hint } : {}) },
    stats: { width: stats.width, height: stats.height, mean_luma: stats.mean_luma, luma: stats.luma,
      under_exposed_ratio: stats.under_exposed_ratio, over_exposed_ratio: stats.over_exposed_ratio,
      regions: stats.regions },
    ...(full.logic ? { logic: full.logic } : {}),
    ...(full.awaited ? { awaited: full.awaited } : {}),
    verdict: full.verdict, next: full.next,
    omitted: "framing, receipt details, camera pose/deviation, colour coverage and colormap_top; call again with detail: 'full' for them",
  };
}

function toolError(error) {
  const payload = error instanceof CompileError
    ? { ok: false, error: "compile_failed", message: error.message, diagnostic: error.diagnostic, next: NEXT.fix(error.diagnostic) }
    : { ok: false, error: error?.code || "tool_failed", message: String(error?.message || error), ...(error?.extra || {}) };
  return { ...text(payload), isError: true };
}

function richResult(value) {
  const base = text(value.payload);
  for (const image of value.images || []) base.content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return base;
}

async function dispatch(request) {
  const { method, params = {} } = request;
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "SSWorld", version: PACKAGE.version },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping": return {};
    case "tools/list": return { tools: TOOLS.map(({ run, rich, ...tool }) => tool) };
    case "tools/call": {
      const tool = TOOLS.find((candidate) => candidate.name === params.name);
      if (!tool) throw Object.assign(new Error(`unknown tool ${params.name}`), { code: -32602 });
      try {
        const value = await tool.run(params.arguments || {});
        return tool.rich ? richResult(value) : text(value);
      } catch (error) { return toolError(error); }
    }
    case "resources/list": return { resources: [] };
    case "prompts/list": return { prompts: [] };
    default: throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

export async function serveStdio() {
  const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
    if (request.id === undefined) continue; // notification
    try {
      const result = await dispatch(request);
      write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      write({ jsonrpc: "2.0", id: request.id, error: { code: error.code || -32603, message: String(error.message || error) } });
    }
  }
}

export { TOOLS, PREVIEW_PORT, briefCapture, moduleRuntime };
