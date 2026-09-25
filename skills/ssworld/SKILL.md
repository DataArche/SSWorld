---
name: ssworld
description: "Use when the user wants a 3D scene, digital twin, building, city block, geographic layout, map basemap, terrain, 3D Tiles city or GeoJSON overlay, 3D animation or interactive 3D object — anything to be built, edited or previewed as a real-time 3D world on a real globe. Drives the ssworld MCP server (SSDL language on the SSEngine WebGPU runtime)."
version: 1.25.0
author: SSWorld
license: Apache-2.0
metadata:
  hermes:
    tags: [SSWorld, SSDL, 3D, Scene, DigitalTwin, WebGPU, MCP, Preview]
---

# SSWorld: authoring previewable 3D worlds in SSDL

When the user asks for a 3D scene, model, building, city, digital twin, 3D animation or clickable 3D object, **reach straight for the `ssworld` MCP tools** — do not ask first, and do not fall back to three.js, Blender or hand-written HTML.

Deliver editable `.ssdl` sources, a preview page, and a screenshot you have actually looked at. Answer in the user's language. The design is yours to invent: there is no reference to match and no match score to report. Get a picture on screen early, then iterate against the picture.

## 30 seconds

```
ssworld_project_create {"name":"MyScene"}      // create + compile
ssworld_catalog {"components":["Box","DirectionalLight"],"detail":"compact"}  // look properties up, never guess
(state a short build plan in your reply)        // see "Structure"
ssworld_source_write Tower.ssdl, scene.ssdl     // component files, then the skeleton
ssworld_compile                                 // check ok
ssworld_scene_inspect                           // structure and budget, no render needed
ssworld_preview                                 // take viewer_url, open it with open_preview
ssworld_capture_frame                           // screenshot, judge from the image
```

Every tool returns `next: {action, reason}`. Follow it. In Hermes the full tool name is `mcp__ssworld__<name>`.

## Tools

| Tool | Use |
|------|-----|
| `ssworld_project_list` / `ssworld_project_create` | Find or create a project. Create takes `name` (letter first; letters, digits, `_`, `-`), optional `longitude`/`latitude`/`height` for a real location, and `template: "empty"` or `"geo"` (basemap/terrain/3D Tiles). Never overwrite a user's project |
| `ssworld_engine_status` | `{"install":true}` downloads the engine (~54 MB) when preview says `engine_not_installed` |
| `ssworld_catalog` | **The contract. Read it before writing code.** `{"components":[...],"detail":"compact"}` gives names, types, units, required members and `member_notes`. Pass the returned `catalog_digest` as `if_digest` to skip unchanged replies |
| `ssworld_source_read` | Source + `digest`; `{"mode":"metadata"}`, `{"node":"sun"}`, `{"file":"*"}` |
| `ssworld_source_write` | Whole-file write (`expected_digest: "new"` for a new file). Also writes `host_interfaces.json` and `logic.mjs` |
| `ssworld_source_patch` | One unique `old_string` replacement (`replace_all` for several) |
| `ssworld_source_batch` | **Preferred for multi-site edits**: atomic, `validate: "compile"` rolls back on a failed compile. `{"edits":[{"node_id":"sun","set":{"intensity":1.7}},{"old_string":"…","new_string":"…"}]}`; ids/enums/expressions go through `{"raw":"…"}` |
| `ssworld_compile` | Errors as `file:line:column: code: message`; on success `node_count`, budget `usage`, `logic` |
| `ssworld_scene_inspect` | Anything knowable without rendering: budget, largest subtrees, `by_file`, `leaf_children.by_type`, geometry bounds, the requested camera |
| `ssworld_preview` | `viewer_url`; `page.connected` / `page.clients` |
| `ssworld_capture_frame` | Screenshot + pixel stats, `receipt`, `runtime.errors`, camera deviation. Options: `width`/`height`, `settle_ms`, `client`, `await` (`{"state":"x"}` / `{"property":"p","min":…}`), `stable: {}` (wait until brightness settles). Use `"detail":"brief"` inside iteration loops |
| `ssworld_logic_read` | Page logic **and whether the scene module loaded at all** (`runtime.state`, mapped `runtime.errors`, properties, States, invalid bindings). Use it instead of a screenshot when something may have failed to load |
| `ssworld_logic_write` | Set declared properties in one transaction to stage a state for a screenshot — do not edit initial values in source for that |
| `ssworld_environment_read` | What the engine actually received for sun, sky, fog, clouds, sky light, post-process and your lights |
| `ssworld_geo_read` | Terrain loaded?, `anchor_above_terrain_m`, imagery draw order, Tileset/GeoJSON readiness |
| `ssworld_geometry_read` | Measured sizes, world bounds, `ground` (`on`/`buried`/`above`), mesh facts, `overlaps: true` |

You may also edit project files with the host's file tools; `ssworld_compile` always rebuilds from disk (you just lose the digest lock).

## Components at a glance

Pick from here, then read exact properties with `ssworld_catalog`. **Never guess property names from QML or three.js.**

| Group | Components | Must-know |
|-------|-----------|-----------|
| Skeleton | `Scene` `Group` `Camera` `CameraView` | Only `Scene` or `Group` can be a parent — **never geometry** (compiles, then fails to load) |
| Primitives | `Box` `Sphere` `Cylinder` `Cone` `Capsule` `Plane` | UVs, take textures. **Centred on `position`**: a Box of height h sits on the ground at `z: h/2` |
| Procedural | `HeightField` `Lathe` `Tube` `Sweep` `Loft` `Torus` `Roof` `Stairs` `Mesh` | Constant parameters, ≤ 65535 vertices per node. `smooth: "catmullrom"` rounds, `flat: true` keeps hard corners (not both). `Mesh` is the escape hatch — try Loft/Sweep first |
| Flat shapes | `Polygon` `ExtrudedPolygon` `Polyline` | Own `color`/`opacity`. `Polygon` has planar UVs and tangents (textures, normal maps and water work). `ExtrudedPolygon` gets UVs only with `bevel`/`taper`/`axis`. Neither can be a Prefab source |
| Assets | `Model` `Texture` | glb ≤ 32 MiB, images ≤ 8 MiB, under `assets/`. A Model keeps its own materials (no recolouring) and is one pick target |
| Materials | `PrincipledMaterial` `UnlitMaterial` `WaterMaterial` | One material per `target`. See Materials |
| Instancing | `Prefab` `Instances` | One native object per batch. See Instancing |
| Lights | `DirectionalLight` `PointLight` `SpotLight` `RectLight` `SkyLight` | See Lights |
| Environment | `SkyAtmosphere` `ExponentialHeightFog` `VolumetricCloud` `PostProcessVolume` | Euler-degree `rotation`. **Cloud distances are kilometres.** Cloud members follow UE / Ultra Dynamic Sky names |
| Time and sky | `Environment` `SunSky` | `Environment` is the clock and astronomy solver: `dateTime` (ISO-8601 **with offset**), `timeScale`, owns the sun direction and sky-light capture |
| Animation | `NumberAnimation` `Vector3dAnimation` `RotationAnimation` `QuaternionAnimation` `ColorAnimation` `ParallelAnimation` `SequentialAnimation` `PauseAnimation` `Behavior` | `duration` in ms, `loops: Animation.Infinite` |
| Geography | `Globe` `ImageryLayer` `Tileset` `GeoJsonLayer` | Geographic world only. See Geography |
| Logic and input | `State` `Timer` `TapHandler` `HoverHandler` `KeyHandler` `PointerHandler` | See Logic |
| Text | `Label` | Page-rasterised billboard at a WGS84 anchor; any browser font incl. CJK; `fontSize` is screen pixels |
| Particles | `ParticleEmitter` | CPU sprites, metres/seconds/degrees; unlit, no collision, no shadow; `softness` > 0 refused |

## Structure

State a brief plan before the first write: the parts, what each is built from, how many copies, which file. Then:

- **Organic things (cars, people, trees, furniture) → a glb `Model`**, not a stack of primitives.
- **Six or more static copies → `Prefab` + `Instances`.** Each instance has its own position, yaw/rotation and scale, so "they differ" is no excuse for hand-written copies.
- **Parts that move together → a `Group` root**; bind only the Group's transform.
- **Anything reused, or any unit over ~30 lines → its own `.ssdl` file** (`Tower.ssdl`, used as `Tower { id: east; height: 120 }`, differences exposed as `property`). Keep `scene.ssdl` a skeleton: camera, lights, environment, ground, instantiations.
- Past ~500 instances, generate the source from a script in the project.

Check after the first compile with `ssworld_scene_inspect`: if `scene.ssdl` holds most nodes (`by_file`) or one geometry type appears 6+ times directly under `Scene` (`leaf_children.by_type`), restructure now — it is cheap before the user starts editing.

Inside a component, read a property by bare name or `root.x`. Values flow into a component, not out: from outside you cannot read an instance's properties or inner nodes.

## SSDL semantics

### Coordinates and values
- **Right-handed Z-up metres**: X east, Y north, Z up; origin at the project anchor.
- **Geometry `rotation` is a quaternion `[x,y,z,w]`**; θ° about Z is `[0,0,sin(θ/2),cos(θ/2)]`. Environment components use Euler degrees.
- Units are not type-checked (`length`, `degrees`, `real` share one lane; `duration` is ms) — nobody warns about a wrong unit.
- `#rrggbb` is sRGB. List values may span lines inside `[ ]`; otherwise a property ends at newline or `;`.

### Geography
Two coordinate worlds that do not mix. `Globe` (≤ 1; `terrain`, usually `lighting: false`), `ImageryLayer` (≤ 8; `xyz` needs `{x}{y}{z}`; draw order = declaration order), `Tileset` (≤ 4; `offset.z` is the usual height fix; `geometricErrorScale` is the LOD dial) and `GeoJsonLayer` (≤ 8; one `geometry` kind per layer) are **direct children of `Scene`, with no position/parent/rotation, and cannot be animated**. Everything else is local metres around the anchor.

- **No basemap ships with the server** (terms and keys are the user's). Ask for a URL or start from `template: "geo"`.
- **Terrain moves the ground, not your scene**: check `ssworld_geo_read.anchor_above_terrain_m`; fix the anchor height in `showcase.manifest.json`, not every node.
- A `CameraView` with `longitude`/`latitude`/`height` frames geographic content; `position`/`lookAt` frame local content.
- A blank basemap is usually the URL — check `ssworld_geo_read` and `geo_error` entries in `runtime.errors`.

### Camera
`CameraView { id: v; position: [60,-80,40]; lookAt: [0,0,12]; fov: 50 }` + `Camera { initialView: v }`. `fov` is **horizontal**. `heading` 0 = north, clockwise; `pitch` negative looks down. `nearPlane`/`farPlane` are recomputed by the engine (writing them does nothing). Pose members are bindable for chase cameras.

### Lights
- The sun is `DirectionalLight { atmosphereSunLight: true }` and is the **only directional light drawn**; a second one lights nothing and re-tints the sun. Moonlight is `Environment.moonIntensity`.
- `intensity` is a multiplier. On point/spot/rect lights **leave `intensityUnits` out** and use 1–4; `"Lumens"` divides by ~800 and the frame goes black.
- **Warm the scene with the sun's `lightColor` or a lower `sunElevation`**, not `temperature` (it also changes brightness and tints the whole sky orange-brown). Scattering vectors on `SkyAtmosphere` are refused.
- `SpotLight`/`RectLight` emit along their own **-X**: `[0,-90,0]` points straight down.
- `Environment.sunIntensity` (default 6) is absolute — nothing auto-exposes.

### Materials
- **`PrincipledMaterial`**: lit PBR (`baseColorMap`, `metallicRoughnessMap` G=roughness B=metal, `normalMap`, `emissiveMap`). The hex you write is relit, so it is not the hex on screen.
- **`UnlitMaterial`**: colour straight to the frame — markers, legends, signage, data colours. Only `baseColor`/`opacity`/`baseColorMap`/`uvScale`/`emissiveColor`.
- **`WaterMaterial`**: a prebuilt water surface. `deepColor` appears after `depthFadeDistance` metres (default 150 — use 3–10 for a pond) and **needs geometry under the surface**. `waveIntensity`/`flowDirection`/`flowSpeed` drive built-in waves; it animates with the clock.
- **Tangents** (for `normalMap` and `WaterMaterial`) exist only on `Plane`, `Polygon`, `HeightField`, `Lathe`, `Tube`, `Sweep`, `Loft`, `Torus`, `Roof`, `Stairs`.
- `emissiveColor` is a multiplier up to 16; ~2–6 crosses the bloom threshold. Emission lights nothing around it.
- `uvScale` multiplies UVs (smaller = denser repeat).

### Instancing
```ssdl
Cylinder { id: post; radius: 0.12; height: 6; position: [0,0,3]; visible: false }
Prefab { id: pfPost; source: post }
Instances { id: lamps; prefab: pfPost; placement: "grid"; origin: [0,0,3]; spacing: [18,40]; columns: 20; count: 240 }
Instances { id: trees; prefab: pfPine; positions: [[0,0,0],[12,4,0]]; rotations_z: [0,137]; scales_uniform: [1,1.3] }
```
- Placements: `grid`, explicit `positions` (≥ 2), `ring` (`center`/`radius`/`count`/`faceCenter`), `along_path` (`path` + `step` or `count`, `alignToPath`).
- Per-instance `rotations_z` (degrees) / `rotations` / `scales_uniform` / `scales` (each in (0, 10]); one list entry per instance; pick one rotation and one scale form.
- **The source still renders** (give it `visible: false`) and **its own rotation is not baked in**.
- A glb `Model` can be a source (do not delete it while the Prefab lives). Never a `Polygon` family node.
- ≤ 512 per batch, 2048 per Prefab. A Group holding a batch is **frozen** (moving it is refused).

### Logic
```ssdl
property real score: 0          // real / bool / string / length / degrees / duration / radians
State { id: stWin; name: "win"; when: score >= 8 }
TapHandler { onTapped: { score = score + 1; } }
```
- Arithmetic only (no string concatenation, no arrays). Maths: `min max clamp lerp abs sign floor ceil round mod sqrt hypot sin cos atan2 hash01` (angles in degrees). **No `random()`** — use `hash01(seed)`.
- Reference a State by **id** (`stWin.when`), not by name. States are derived; write the properties they read.
- A handler's assignments and each frame's bindings are single transactions. A rejected binding value invalidates that binding silently — check `logic.bindings.invalid` / `runtime.errors`.
- **Every compile hot-reloads and resets logic properties** — restage with `ssworld_logic_write`.
- Input: `KeyHandler { key: "ArrowUp" }` (read `pressed` for continuous, `onPressed` for discrete); `PointerHandler` gives `pressed`, `screenX/Y`, `hit` + `hitX/Y/Z` (local metres; read only while `hit` is true), `wheelDelta`.
- A `Model` is one pick target; its inner glb nodes cannot be addressed from SSDL.

### Animation
- Easing: `easing.type: "Easing.InOutSine"` (fully qualified). `Behavior` is for discrete jumps; bind continuous motion directly.
- `Group` and `Model` animate only `position`/`rotation`/`scale`/`visible`.
- ≤ 256 native timelines (each top-level animation or animation group takes one). Watch `usage.timelines`.

### Host JS and a changing world
When a rule needs JS, declare it in `host_interfaces.json`, implement it in `logic.mjs` (`export function createHostInterfaces(api) { … }`), and call it from SSDL (`Game.hit(targetId: "a")`). Write state back with `api.logical.write`. Do not move geometry into JS.

To create and remove things at runtime, **SSDL says what a part is; host JS says how many**:
- A part: a `.ssdl` file with `pragma spawnable`, a single `Group` root, defaulted properties, no scene singletons, no key/pointer handlers, no `Model`. Spawn it with `api.scene.spawn("House", {floors}, {at, heading, tag})` → `{handle}`; also `dispose`, `move`, `moveBatch`, `set`, `list`, `onTap`, `budget`.
- Many identical copies whose count changes: an `Instances` batch declared with `positions: []`, rewritten with `api.instances.set("cars", {positions, rotations_z})`.
- Spawns share the static budget, run ≤ 64 per frame, and are replayed after a hot reload (check `spawn_failures` in `ssworld_logic_read`). Handles die with their generation; rebuild maps inside `createHostInterfaces`.

### Environment, exposure and night
- **Do not touch exposure members** on `PostProcessVolume`: any of them turns eye adaptation on and the frame re-exposes (+~6 stops; night lamps blow out).
- Night: `Environment { moonIntensity: 4 }` (default reads as black), lamps at intensity 1–4, windows/signs via `emissiveColor` 2–6.
- `Environment.cloudCoverage` also drives the height fog and overrides `ExponentialHeightFog` density; leave it out unless you want weather.
- After moving the clock, capture with `stable: {}` — the frame takes up to ~30 s to settle.
- For reproducible screenshots freeze motion: `VolumetricCloud.cloudSpeed: 0`, `WaterMaterial.flowSpeed: 0`, particle `playbackSpeed: 0` (+ `warmup` and `seed`). Restore them before delivery.
- The starter scene's `timeOfDay` / `sceneDateTime` properties feed the preview's time slider; keep them if you want it.

## Budgets and scale
- Defaults: 4096 native objects, 4096 material shells, 32 distinct images, 256 timers/timelines, 1024 Group locators, 64 `Model` nodes, 64 MiB of images, 16 nesting levels.
- Source: 4 MiB per file, 16 MiB per project. `Mesh` data (~42 B/vertex) dominates; big shapes belong in a glb.
- Past ~4000 native objects a scene still runs but **`ssworld_capture_frame` fails**; build big scenes from `Instances` (400 000 rows cost ~200 objects).

## Reading a capture
1. **`receipt.in_sync`** — false means a stale frame; recompile/recapture as `next` says. Never report from a stale frame.
2. **`runtime.errors`** — non-empty means a runtime failure at the given `file:line`; the camera in that frame is the engine default.
3. **The image** — judge composition and framing; without vision use `stats` (luma percentiles, 3×3 `regions`, `colormap_top`).

`render_verified: true` only means "not black, no errors". `reference_match` is always `not_evaluated` — never invent a score. On `page_not_open`, open `viewer_url` (a minimised window produces no frames). On a capture timeout check `status.visibility` and do not hammer the service.

## Traps that do not announce themselves
- `HeightField.heights` counts **corners**: `(columns+1)*(rows+1)` values.
- A `Lathe` radius of 0 or repeated path points are refused (`mesh_degenerate`); use a small positive radius for a point.
- `rate × lifetime` above `maxParticles` (default 500) silently clips the emitter — size `maxParticles` first. Rain uses `gravity: 0` and a constant `speed`.
- A `drive_preview` click does not reach page listeners; test interaction in a real browser over CDP.
- Do not compare budget numbers across categories; trust the compile receipt.

## Not available
No audio, physics or colliders; no arrays or string concatenation in logic; no GPU/mesh/ribbon particles; no `GeoAnchor` (one anchor per scene); no 3D Tiles feature styling/picking/clipping; no keyed or shifted tile services (Tianditu, AMap, Baidu, SuperMap, Mapbox). Do not work around these.

## Always finish with
Project name and path, the `.ssdl` files and what each holds, the `viewer_url`, the screenshot path and **what you saw in it**, any runtime errors, and what you did not verify.
