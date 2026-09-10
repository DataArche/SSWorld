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
import { CLIP_PLANE_POLICY } from "./runtime-support.mjs";
import { CompileError } from "./compile.mjs";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = `SSWorld: author 3D geographic scenes with the SSDL scene description language (a QML-like subset, right-handed Z-up, metres) and run them on the SSEngine WebGPU runtime.
Workflow: ssworld_catalog (index, or components: [...] with detail 'compact' for several contracts at once) -> ssworld_project_create -> ssworld_source_read (mode 'metadata' for digests/sizes, 'node' for one node, offset/limit for ranges) -> ssworld_source_patch / ssworld_source_batch (atomic multi-edit, optional compile+rollback) / ssworld_source_write -> ssworld_compile (real diagnostics + budget usage) -> ssworld_scene_inspect (hierarchy, extent, requested camera) -> ssworld_preview (URL to open in a WebGPU browser) -> ssworld_capture_frame (screenshot + stats + receipt binding the frame to source/IR digests + requested vs effective camera + runtime errors mapped to scene.ssdl:line).
Compile success means the scene is well-formed, not that it looks right; open the preview, then call ssworld_capture_frame and look at the image before reporting. Every result carries next: {action, reason, ...} naming the next step; 'open_webgpu_viewer' means the client must open next.url in a visible WebGPU browser tab (a client capability, not an SSWorld tool). reference_match stays not_evaluated unless a comparison was actually run.
Conventions: local metres, x east / y north / z up around the project anchor; geometry rotation quaternions are [x, y, z, w], environment component rotation is Euler degrees; CameraView takes position/lookAt in local metres (or longitude/latitude/height), fov in vertical degrees; ${CLIP_PLANE_POLICY}.`;

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
      project: { type: "string" }, file: { type: "string", description: "Relative .ssdl path; default scene.ssdl; '*' for all files." },
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
    description: "Replace a whole .ssdl file. Pass expected_digest from ssworld_source_read (or 'new' for a new component file). For edits prefer ssworld_source_patch / ssworld_source_batch. Does not compile; call ssworld_compile next. Editing the .ssdl files in the project directory with any other file tool also works (ssworld_compile always rebuilds from disk) but bypasses the digest lock.",
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
    description: "Compile the project with the SSDL 0.3 compiler (always from the files on disk). Returns digests, node_count and budget usage on success, or the compiler diagnostic (file:line:column, code, message) on failure. Members the catalog marks as not runtime-writable are rejected here too (runtime_unsupported).",
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" } }, additionalProperties: false },
    annotations: { title: "Compile SSDL", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async ({ project }) => ({ ...(await compileNamed(project)), next: next("preview_or_capture", "compiled; call ssworld_preview (first time) or ssworld_capture_frame (page already open, it hot reloads)") }),
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
    description: "Compile the project, make sure the engine is installed and the local preview server is running, and return the URL to open in a WebGPU-capable browser. The page hot-reloads on later writes+compiles. next.action tells whether the page must still be opened (open_webgpu_viewer) or can be captured.",
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
    description: "Screenshot the project's open preview page through the engine: an offscreen WebGPU render at the requested width x height (vertical fov kept, aspect follows the request, no scaling/cropping, the interactive view is untouched). Returns the PNG as image content (also saved under captures/), pixel statistics (luma percentiles, exposure tails, colour-class coverage overall and per 3x3 region, top colours), a receipt binding the frame to the source/IR digests and page generation (in_sync false + staleness when the page runs an older compile), framing details, runtime errors since the last hot reload mapped to scene.ssdl:line, and camera {effective pose, source, requested (from the scene's CameraView), deviation with reasons}. reference_match is always not_evaluated (no reference comparison is run). Requires the viewer_url from ssworld_preview to be open and visible; returns page_not_open otherwise.",
    inputSchema: { type: "object", required: ["project"], properties: {
      project: { type: "string" },
      width: { type: "integer", minimum: 64, maximum: 4096, description: "Capture width in pixels; default 800." },
      height: { type: "integer", minimum: 64, maximum: 4096, description: "Capture height; default keeps 16:9." },
      settle_ms: { type: "integer", minimum: 0, maximum: 10000, description: "Wait before capturing (camera flights, animations); default 500." },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "How long to wait for the page to answer; default 20000." },
    }, additionalProperties: false },
    annotations: { title: "Capture preview frame", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rich: true,
    run: async ({ project, width, height, settle_ms, timeout_ms }) => {
      const directory = projectDir(project);
      const page = await fetchPageStatus(project);
      if (!page.connected) {
        const started = await startPreview({ log });
        const url = projectUrl(project, started.port);
        throw Object.assign(new Error("preview page is not open; open viewer_url in a WebGPU browser (keep it visible), then call ssworld_capture_frame again"),
          { code: "page_not_open", extra: { viewer_url: url, page, next: NEXT.open(url) } });
      }
      const requestedWidth = width || 800;
      const requestedHeight = height || Math.round(requestedWidth * 9 / 16);
      const reply = await pageCommand(project, "capture", { width: requestedWidth, height: requestedHeight, settle_ms: settle_ms ?? 500 }, { timeoutMs: timeout_ms || 20000 });
      if (!reply.ok) {
        const visibility = reply.page?.status?.visibility;
        const hidden = visibility && visibility !== "visible";
        const message = reply.error === "page_timeout"
          ? (hidden ? `the page is ${visibility} (minimised or background tab); bring it to the front and retry` : "the page did not answer in time (is the tab visible and painting?)")
          : String(reply.error);
        throw Object.assign(new Error(message), { code: reply.error, extra: { page: reply.page, next: hidden ? NEXT.front(visibility) : next("retry_capture", message, { blocking: true }) } });
      }
      const result = reply.result;
      if (!result.ok) throw Object.assign(new Error(result.error), { code: "capture_failed", extra: { status: result.status, next: next("retry_capture", result.error, { blocking: true }) } });
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
        in_sync: staleness.length === 0, staleness };

      // Framing: what the engine did with the requested size (verified against LiRenderSystem offscreen path).
      const effective = result.camera && !result.camera.error ? result.camera : null;
      const aspect = requestedWidth / requestedHeight;
      const vfov = effective?.fov ?? null;
      const framing = { mode: "offscreen_render_at_requested_size", requested: { width: requestedWidth, height: requestedHeight },
        output: { width: stats.width, height: stats.height }, interactive_canvas: status.canvas ? { ...status.canvas, device_pixel_ratio: status.device_pixel_ratio ?? null } : null,
        projection: { aspect: Number(aspect.toFixed(4)), vertical_fov_deg: vfov, horizontal_fov_deg: vfov ? Number((2 * Math.atan(Math.tan(vfov * Math.PI / 360) * aspect) * 180 / Math.PI).toFixed(2)) : null },
        scaling: "none", crop: null, interactive_view_restored: true,
        note: "the engine renders one extra frame into an offscreen target of the requested size; the camera keeps its vertical fov and pose, the aspect follows the request, the on-screen canvas and controller are not modified" };

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
      return {
        payload: {
          ok: true, project, capture_path: file, receipt, framing, stats, camera, runtime: status,
          render_verified: verified,
          reference_match: { status: "not_evaluated", method: null, metrics: null, note: "no reference image comparison is performed by this tool" },
          verdict: verified ? (receipt.in_sync ? "frame captured from the running scene with no runtime errors; judge composition from the image and stats.regions"
              : `frame captured with no runtime errors, but it may not show the latest sources: ${staleness.join("; ")}`)
            : status.errors.length ? `runtime reported ${status.errors.length} error(s): ${firstError.message}${where}; fix the source and compile again`
            : status.state !== "ready" ? `runtime state is '${status.state}': ${status.hint}`
            : "frame is blank or nearly black; the camera may be pointing at nothing",
          next: status.errors.length ? NEXT.fixRuntime(firstError) : !loaded ? next("wait_or_reload", `runtime state '${status.state}'; wait for the load to finish or fix the compile error shown on the page`)
            : !receipt.in_sync ? next("recompile_and_recapture", staleness[0]) : NEXT.judge(),
        },
        images: [{ data: result.png_base64, mimeType: "image/png" }],
      };
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

export { TOOLS, PREVIEW_PORT };
