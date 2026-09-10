// MCP stdio server (newline-delimited JSON-RPC 2.0). No third-party dependencies.
import { createInterface } from "node:readline";
import { PACKAGE, SERVER_NAME, PREVIEW_PORT, PROJECTS_ROOT } from "./paths.mjs";
import { engineStatus, ensureEngine } from "./engine.mjs";
import { compileNamed, createProject, listProjects, readSource, writeSource, DEFAULT_ANCHOR } from "./project.mjs";
import { startPreview, projectUrl } from "./preview.mjs";
import { catalogSummary, catalogComponent } from "./catalog.mjs";
import { CompileError } from "./compile.mjs";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = `SSWorld: author 3D geographic scenes with the SSDL scene description language (a QML-like subset, right-handed Z-up, metres) and run them on the SSEngine WebGPU runtime.
Workflow: ssworld_catalog (learn available components) -> ssworld_project_create -> ssworld_source_read -> ssworld_source_write (pass the digest you read) -> ssworld_compile (real diagnostics) -> ssworld_preview (returns a URL to open in a browser with WebGPU).
Compile success means the scene is well-formed, not that it looks right; always open the preview and inspect it. Sources are plain .ssdl text; everything else in the project is generated.`;

const log = (line) => process.stderr.write(`[ssworld-mcp] ${line}\n`);

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], structuredContent: typeof value === "object" ? value : undefined };
}

const TOOLS = [
  {
    name: "ssworld_catalog",
    description: "List SSDL components (Scene, Box, Model, Light, Camera, animations, handlers…) or read one component's full property/child contract. Read this before writing SSDL.",
    inputSchema: { type: "object", properties: { component: { type: "string", description: "Component type name for full members; omit for the index." } }, additionalProperties: false },
    annotations: { title: "SSDL catalog", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: ({ component }) => (component ? catalogComponent(component) : catalogSummary()),
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
    description: "Create a new runnable SSDL project from the starter template (a tappable rotating box anchored at a geographic position) and compile it. Never overwrites an existing project.",
    inputSchema: { type: "object", required: ["name"], properties: {
      name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$", description: "Project name; letters, digits, '_' and '-'." },
      title: { type: "string", description: "Page title shown in the preview; defaults to the name." },
      longitude: { type: "number", description: "Anchor longitude in degrees (WGS84). Default: Shenzhen civic centre." },
      latitude: { type: "number", description: "Anchor latitude in degrees." },
      height: { type: "number", description: "Anchor height in metres above the ellipsoid. Default 150." },
    }, additionalProperties: false },
    annotations: { title: "Create project", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: ({ name, title, longitude, latitude, height }) => createProject(name, { title, anchor: {
      lon: longitude ?? DEFAULT_ANCHOR.lon, lat: latitude ?? DEFAULT_ANCHOR.lat, height: height ?? DEFAULT_ANCHOR.height } }),
  },
  {
    name: "ssworld_source_read",
    description: "Read a project's .ssdl source with its digest (needed by ssworld_source_write) and the list of .ssdl files in the project.",
    inputSchema: { type: "object", required: ["project"], properties: {
      project: { type: "string" }, file: { type: "string", description: "Relative .ssdl path; default scene.ssdl." } }, additionalProperties: false },
    annotations: { title: "Read SSDL source", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: ({ project, file }) => readSource(project, file || "scene.ssdl"),
  },
  {
    name: "ssworld_source_write",
    description: "Replace a project's .ssdl file. Pass expected_digest from ssworld_source_read (or 'new' for a new component file). Does not compile; call ssworld_compile next.",
    inputSchema: { type: "object", required: ["project", "file", "content", "expected_digest"], properties: {
      project: { type: "string" }, file: { type: "string" }, content: { type: "string", description: "Full new file content (UTF-8, ≤1 MiB)." },
      expected_digest: { type: "string", description: "sha256 hex from the last read, or 'new'." } }, additionalProperties: false },
    annotations: { title: "Write SSDL source", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: ({ project, file, content, expected_digest }) => writeSource(project, file, content, expected_digest),
  },
  {
    name: "ssworld_compile",
    description: "Compile the project with the SSDL 0.3 compiler. Returns digests on success or the compiler diagnostic (file:line:column, code, message) on failure.",
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" } }, additionalProperties: false },
    annotations: { title: "Compile SSDL", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: ({ project }) => compileNamed(project),
  },
  {
    name: "ssworld_preview",
    description: "Compile the project, make sure the engine is installed and the local preview server is running, and return the URL to open in a WebGPU-capable browser. The page hot-reloads on later writes+compiles.",
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" } }, additionalProperties: false },
    annotations: { title: "Preview scene", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async ({ project }) => {
      const compiled = await compileNamed(project);
      const started = await startPreview({ log });
      return { ...compiled, viewer_url: projectUrl(project, started.port), preview: started, render_verified: false,
        next_action: "Open viewer_url in a browser with WebGPU (Chrome/Edge) and inspect the scene; a 200 from the server does not prove it rendered." };
    },
  },
  {
    name: "ssworld_engine_status",
    description: "Report whether the SSEngine WebGPU runtime pair (SSmap.js/SSmap.wasm) is installed locally; optionally download it now.",
    inputSchema: { type: "object", properties: { install: { type: "boolean", description: "Download the pinned engine if missing." } }, additionalProperties: false },
    annotations: { title: "Engine status", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async ({ install }) => (install ? ensureEngine({ log }) : engineStatus()),
  },
];

function toolError(error) {
  const payload = error instanceof CompileError
    ? { ok: false, error: "compile_failed", message: error.message, diagnostic: error.diagnostic }
    : { ok: false, error: "tool_failed", message: String(error?.message || error) };
  return { ...text(payload), isError: true };
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
    case "tools/list": return { tools: TOOLS.map(({ run, ...tool }) => tool) };
    case "tools/call": {
      const tool = TOOLS.find((candidate) => candidate.name === params.name);
      if (!tool) throw Object.assign(new Error(`unknown tool ${params.name}`), { code: -32602 });
      try { return text(await tool.run(params.arguments || {})); } catch (error) { return toolError(error); }
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
