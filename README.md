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
| `ssworld_preview` | starts the local preview server, returns `http://127.0.0.1:8880/projects/<name>/index.html`, whether the page is open, `page.clients` (every browser syncing the page: id, visibility, canvas, user agent) and a structured `next` (`open_webgpu_viewer` / `capture_frame` / `bring_page_to_front`) |
| `ssworld_capture_frame` | screenshot of the open preview through the engine (`saveImage2Base64`); stats with luma percentiles, exposure tails, colour-class coverage overall and per 3×3 region, top colours; runtime errors deduplicated and mapped to `scene.ssdl:line:column`; camera pose with `source: scene | engine_default`, the scene's `requested` camera and a `deviation` with reasons (clip planes are engine-managed); `receipt` binding the frame to source/IR digests, the page generation (`in_sync`, `staleness`) and the answering page (`client`, `clients_connected`); `framing` describing the offscreen render at the requested size (horizontal fov kept, vertical follows the aspect); `logic` with the page's live declared properties / `State.when` / host call errors / `bindings.invalid`; `await: {state | property, …}` to shoot only once a game state holds; `client` to pick one of several open pages; `reference_match` always `not_evaluated`; `detail: "brief"` for iteration loops (verdict, runtime errors, luma, 3×3 regions, path, `in_sync`, `logic` only); PNG returned as image content and saved to `captures/` |
| `ssworld_environment_read` | ask the engine what it actually received for the environment: the adopted sun's direction read back from the native sun and converted to azimuth/elevation at the anchor (with the deviation from the scene's request), which `DirectionalLight` drives the atmosphere, and every environment component's live native values. The probe lives in the project's `index.html`, which is project-owned, so a page created before 0.9.8 answers `page_probe_unavailable` and the error names the handler to paste in |
| `ssworld_logic_read` / `ssworld_logic_write` | read the open page's scene logic (and whether the scene module actually mounted: `runtime.state` plus errors mapped to `scene.ssdl:line`) without a screenshot, or set declared properties in one transaction (`{set: {p: 0.4, pace: 0.0025}}`) to put a game into a situation before capturing; a refused value rolls the whole set back and names the failing binding |
| `ssworld_engine_status` | engine pair installed? (`install: true` to download) |

### How big a scene, measured

Budgets are per-project values in `showcase.manifest.json`; the defaults and the ceilings come from
`src/ssdl/tools/probe_engine_limits.py` (which asks every facade for its own `capabilities()`) and
`src/ssdl/tools/probe_scale_limits.py` (which raises the budgets and builds a scene past them on real
hardware). Defaults: 4096 native objects / 4096 material shells / 32 distinct images / 4096 bindings
/ 2048 handlers / 256 timers / 256 timelines / 1024 Group locators / 1024 Prefabs / 524288 instance
rows. Four of those are the engine's own and a manifest cannot raise them (`resolveBudgets` clamps
distinct images, timers, timelines and Group locators), because a scene past them compiles and then
fails to mount.

What actually runs out, in order:

- **Not rendering.** 6401 native objects with 409 600 instance rows across 200 prefabs compiled in
  1.2 s, mounted in 4.0 s and ran at 61 fps with no runtime errors.
- **`ssworld_capture_frame` first.** The offscreen readback dies of a wasm "memory access out of
  bounds" somewhere between 4001 native objects (captures, `render_verified`, ~21k distinct colours)
  and 5001 (does not). Past roughly 4000 nodes a scene runs and cannot be screenshotted, which is why
  `native_objects` sits just under that and why instancing — 409 600 rows for 200 native objects —
  is the way to build something large. The capture timeout is now the caller's to set: the page used
  to give the readback a fixed 8 s whatever `timeout_ms` said, so a scene big enough to be worth a
  screenshot always timed out.
- **Bindings used to be the hard wall, and are not any more.** `AnimationFacade.captureBatch` refuses
  a batch of more than 64 items and refuses it whole, so a scene whose first frame carried 65
  bindings failed to mount with a receipt that said "evaluated 65, committed 0, failed 65" and named
  nothing — while the shipped budget said 256. The runtime now flushes bindings in chunks of 64 and
  restores the chunks that already landed if a later one fails, so the flush stays all-or-nothing to
  the author. Measured after the fix: 1500 bindings + 600 handlers + 914 locators mount in 2.2 s at
  44 fps.

Three engine ceilings have no budget dimension and are compile errors of their own:
`scene_depth_exceeded` (SceneGraphFacade.max_depth, 16 levels of nesting), `model_budget`
(ModelFacade.max_model_instances, 64 `Model` mounts — use one as a `Prefab` source instead of a copy
per placement) and `texture_budget` (MaterialFacade.max_texture_bytes_total, 64 MiB of distinct
images however small each file is).

### Colours are authored as sRGB

`#rrggbb` is read as sRGB — the value a colour picker gives you. The runtime converts it to linear before handing it to
the engine, so the frame shows the colour that was picked and reading the value back returns the same hex. Before 0.9.8
that conversion was missing and every flat colour rendered roughly three times too bright (`#16260f` came out as a light
green). Native materials keep 8 bits of *linear* light per channel, so very dark colours quantise: `#16260f` reads back
as `#16260d`, and anything below about `#0a0a0a` collapses towards black. Verified on real hardware with
`src/ssdl/tools/probe_color_space.py` (headless Chromium + WebGPU, frames captured through the engine).

### What the compiler refuses

Several failures that used to surface only as a dead page are now compile errors naming the node and the member:

- `sky_scattering_refused` — `SkyAtmosphere`'s `rayleighScattering`, `mieScattering`, `mieAbsorption`, `otherAbsorption`
  and `skyLuminanceFactor` are normalised direction vectors, not colours (their magnitude lives in the neighbouring
  `*Scale`). Writing a "neutral-looking" vector raises red and turns the whole sky orange-brown. Tint through the sun's
  `lightColor` instead; the error text carries each member's real engine default.
- `mesh_degenerate` — a radius of 0 in a `Lathe` profile, exactly repeated adjacent points, a `Tube` path that doubles
  back or repeats a point, two identical adjacent `Loft` rings. These produced
  `GeometryFacade.createMesh: triangle is degenerate` and took the *entire* scene module down without naming a node.
  (A vertical first `Tube` segment is fine: the parallel-transport frame switches reference axis at `|tangent.z| >= 0.9`.)
- `runtime_unsupported` — `Label` (no font), `sunAzimuth`/`sunElevation` without `atmosphereSunLight: true`, and the
  members a light may not write in the mode it is in.
- `material_requires_tangent` — a `normalMap` on geometry without tangents (only `HeightField`/`Lathe`/`Tube`/`Loft` have them).
- `value_out_of_range` — `emissiveColor` outside its `[r, g, b]` 0..16 range.

List values may span lines since 0.9.8: a newline after `sections: [`, one ring per line and comments inside the
brackets all compile. A property still ends at a newline or `;`, so this only applies inside `[ ]`.

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
`logic.mjs` is re-imported on every hot reload and declared properties restart at their initial values (`ssworld_compile` says so
as `hot_reload.logic_reset` while a page is open; `ssworld_logic_write` restores a situation).

### Runtime evidence: rolled-back bindings and several open pages

Bindings and handler assignments commit as one transaction per event/frame. If any bound value is refused by its target
(a negative `width`, a wrong type, a native refusal) the whole batch rolls back, the binding turns invalid and the affected
values simply stop changing. The page reports this as a runtime error of kind `binding_error`
(`<node>.<property>: <code>: <message>`, counted with `repeats` instead of flooding) and `ssworld_capture_frame` /
`ssworld_logic_read` map it to the member line inside that node's block; `logic.bindings.invalid` lists the bindings
concerned. Prefer `clamp/lerp/min/max` over a progress property to branchy `?:` chains, and keep every branch inside the
target's valid range. A `Behavior` eases every change of its target over `duration`, so on a per-frame property the
presented value lags by about speed × duration; use it for discrete jumps.

A desktop preview pane and an automation browser can both have the page open. The preview server keeps one record per
page (`client` id from the page's heartbeat): `ssworld_preview` lists `page.clients`, a capture is answered by the most
recently synced **visible** page unless `client` names another, and every receipt carries `receipt.client`
(`id`, `visibility`, `canvas`, `user_agent`) plus `clients_connected`, so a frame can be attributed to the page it came from.

The project template places the WebGPU canvas and the info panel side by side (nothing floats over the canvas, so taps
reach the scene's `TapHandler`s). Pages are project-owned; older projects keep their layout.

Clients that support skills also receive `skills/ssworld`, so they pick the server on their own for 3D-scene requests:
`ssworld-mcp install` copies it to `$HERMES_HOME/skills/ssworld` for Hermes and `~/.codex/skills/ssworld` for Codex
(Codex discovers skill directories on its own; `[[skills.config]]` only records the ones that were explicitly disabled).

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
