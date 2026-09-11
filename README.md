# ssworld-mcp

SSWorld MCP server: lets any MCP-capable agent app (Claude Code, Codex, Hermes, Cursor …) author, compile and preview
3D geographic scenes written in **SSDL** (a QML-like scene description language) on the **SSEngine WebGPU** runtime.

## Install (one command)

```bash
npx -y github:DataArche/SSWorld install
```

This installs the package globally, registers the `ssworld` MCP server with every agent app it finds
(`--client=claude,codex,hermes,cursor` to choose), and downloads the pinned engine (≈54 MB) into `~/.ssworld/engine/`.

Requirements: Node.js ≥ 22, npm, a WebGPU browser (Chrome/Edge) to look at previews.

Manual registration for any other client:

```json
{ "mcpServers": { "ssworld": { "command": "node", "args": ["<npm root -g>/ssworld-mcp/bin/ssworld-mcp.mjs"] } } }
```

## Tools

| tool | purpose |
|------|---------|
| `ssworld_catalog` | component index / one contract / `components: [...]` in one call (`detail: compact` hoists shared members); `catalog_digest` + `if_digest` for cache hits; units and rotation conventions annotated per member |
| `ssworld_project_list` | projects in `~/.ssworld/projects` |
| `ssworld_project_create` | new runnable project (anchored at lon/lat/height), compiled |
| `ssworld_source_read` / `ssworld_source_write` | bounded reads (`max_chars`, `offset`/`limit` with `has_more`/`next_offset`; `mode: metadata` for digests, sizes and compile staleness without text; `node: "<id>"` for one block; `file: "*"` for all files) and whole-file writes of `.ssdl` sources; editing the files on disk with any tool also works (`ssworld_compile` rebuilds from disk) but bypasses the digest lock |
| `ssworld_source_patch` | exact-span edit (`old_string` → `new_string`, uniqueness checked, `replace_all` opt-in) with the same digest guard |
| `ssworld_source_batch` | atomic multi-edit: text patches and node-level `{node_id, set, unset}` across files; all validated in memory before anything is written; `validate: compile` + rollback restores the previous sources on a failed compile |
| `ssworld_scene_inspect` | compiled-scene facts without rendering: budget ratio, subtrees by size, leaf children by type, nodes per source file, primitive extent, the requested camera (lookAt-derived heading/pitch); render stats honestly `unavailable` |
| `ssworld_compile` | SSDL 0.3 compiler with real diagnostics, `node_count`, budget `usage` and `logic` (declared properties, states, host calls); catalog/runtime mismatches are compile errors (Label without a font, material animations on a Group/Model, undeclared host calls) |
| `ssworld_preview` | starts the local preview server, returns `http://127.0.0.1:8880/projects/<name>/index.html`, whether the page is open and a structured `next` (`open_webgpu_viewer` / `capture_frame` / `bring_page_to_front`) |
| `ssworld_capture_frame` | screenshot of the open preview through the engine (`saveImage2Base64`); stats with luma percentiles, exposure tails, colour-class coverage overall and per 3×3 region, top colours; runtime errors deduplicated and mapped to `scene.ssdl:line:column`; camera pose with `source: scene | engine_default`, the scene's `requested` camera and a `deviation` with reasons (clip planes are engine-managed); `receipt` binding the frame to source/IR digests and the page generation (`in_sync`, `staleness`); `framing` describing the offscreen render at the requested size (horizontal fov kept, vertical follows the aspect); `logic` with the page's live declared properties / `State.when` / host call errors; `reference_match` always `not_evaluated`; PNG returned as image content and saved to `captures/` |
| `ssworld_engine_status` | engine pair installed? (`install: true` to download) |

### Procedural geometry

Four parametric generators compile to constant parameters and are tessellated by the runtime (`MeshData/v1`, ccw outward,
≤ 65535 vertices per node, `mesh_budget` beyond): `HeightField { width; depth; columns; rows; heights }`,
`Lathe { profile: [[radius, 0, height] …]; segments; closed }`, `Tube { path; radius; segments; closed }`,
`Loft { sections: [[ring] …]; cap }`. `ssworld_compile` reports their cost as `usage.mesh`. There are no per-vertex
functions: arbitrary meshes are managed assets (`Model`).

### Model assets

Copy glb files (and png/jpg textures) into `<project>/assets/` and reference them by project-relative path:
`Model { id: tree; source: "assets/tree.glb"; position: [10, 0, 0] }`. `ssworld_compile` discovers everything under
`assets/` (`usage.assets`), embeds each file's digest into SceneIR and the preview page fetches and verifies the bytes
by that path. Limits: 32 MiB per glb, 8 MiB per texture, 64 assets per project (`asset_budget`); a path outside
`assets/` is `asset_unresolved`. A Model carries its own materials; only its position/rotation/scale/visible animate.

### Scene logic and host interfaces

Scene state is declared on the `Scene` root (`property real score: 0`, types `real/bool/string/length/degrees/duration/radians`),
changed by handler assignments (`score = score + 1`, one transaction per handler) and read by bindings
(`when: score >= 8 && misses < 3`; operators `+ - * / === !== < <= > >= && || ! ?:`, functions `min/max/clamp/lerp`).
Host JavaScript is reached only through declared calls: `host_interfaces.json` holds the contract
(`{"Game":{"methods":{"hit":{"args":[{"name":"targetId","type":"string"}]}}}}`), `logic.mjs` implements it
(`export function createHostInterfaces(api) { return { Game: { hit({ targetId }) { api.logical.write("score", …) } } }; }`),
and SSDL calls it with `TapHandler { onTapped: { Game.hit(targetId: "balloonA"); } }`. Mismatches are compile errors
(`host_interface_unknown`, `host_method_unknown`, `host_arg_missing`, `host_arg_unknown`); a missing implementation refuses to
mount (`host_interface_missing`); callbacks are synchronous, return nothing and change the scene only through
`api.logical.write`. `window.SSWorld.logical.read()/write()` expose the same state on the page; `ssworld_capture_frame` returns it as `logic`.
`logic.mjs` is re-imported on every hot reload and declared properties restart at their initial values.

Hermes also receives the `skills/ssworld` skill (copied to `$HERMES_HOME/skills/ssworld`) so it picks the server on its own for 3D-scene requests.

## CLI

```
ssworld-mcp                 # MCP stdio server (what agent apps launch)
ssworld-mcp install [--client=claude,codex] [--no-engine]
ssworld-mcp engine          # download / verify the pinned engine
ssworld-mcp preview [--port=8880]
ssworld-mcp doctor
```

Environment: `SSWORLD_HOME` (default `~/.ssworld`), `SSWORLD_PREVIEW_PORT` (8880), `SSWORLD_ENGINE_DIR` (use a local engine pair instead of the release download).

## Layout

`ssdl/compiler` is the byte-identical SSDL 0.3 compiler closure, `ssdl/runtime` the browser runtime, `ssdl/catalog` the
component catalog, `engine.lock.json` pins the SSmap.js/SSmap.wasm pair published as a GitHub Release asset.
Built by `src/ssdl/tools/pack_ssworld_mcp.py` in the SSEngine3 repository; do not edit here.
