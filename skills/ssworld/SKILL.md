---
name: ssworld
description: "Use when the user wants a 3D scene, digital twin, building, city block, geographic layout, 3D animation or interactive 3D object — anything to be built, edited or previewed as a real-time 3D world. Drives the ssworld MCP server (SSDL language on the SSEngine WebGPU runtime)."
version: 1.12.1
author: SSWorld
license: MIT
metadata:
  hermes:
    tags: [SSWorld, SSDL, 3D, Scene, DigitalTwin, WebGPU, MCP, Preview]
---

# SSWorld: authoring previewable 3D worlds in SSDL

When the user asks for a 3D scene, a model, a building, a city, a digital twin, a 3D animation or a clickable 3D object, **reach straight for the `ssworld` MCP tools**. Do not ask whether to use them first, and do not fall back to three.js, Blender or hand-written HTML.

What you deliver: editable `.ssdl` sources, a preview page they can open, and a screenshot you have actually looked at. Answer in the language the user wrote in. Get a picture on screen first, then iterate against the picture.

## 30 seconds

```
ssworld_project_create {"name":"MyScene"}      // create + compile
ssworld_catalog {"components":["Box","DirectionalLight"],"detail":"compact"}  // look properties up, never guess
ssworld_source_write / _patch / _batch          // write scene.ssdl
ssworld_compile                                 // compile, check ok
ssworld_preview                                 // take viewer_url, open it with open_preview
ssworld_capture_frame                           // screenshot, judge from the image
```

Every tool returns `next: {action, reason}`. Follow it.

## Tools (15; in Hermes the full name is `mcp__ssworld__<name>`)

### Projects
| Tool | What it does |
|------|--------------|
| `ssworld_project_list` | Existing projects and their paths on disk. Call it first when the user says "change that scene from before" |
| `ssworld_project_create` | `{"name":"MyScene","longitude":114.06,"latitude":22.54,"height":150}`. The name must start with a letter and contain only letters, digits, `_` and `-`. Pass the coordinates (WGS84 degrees / metres) when the scene has a real location, otherwise the default anchor is used. Pass `"template":"empty"` to start from nothing |
| `ssworld_engine_status` | Whether the engine is installed; `{"install":true}` downloads it now (~54 MB). Use it when `ssworld_preview` reports `engine_not_installed` |

### Reading the contract
| Tool | What it does |
|------|--------------|
| `ssworld_catalog` | **Read this before writing code.** `{}` lists every component; `{"components":["Box","SpotLight"],"detail":"compact"}` returns property names, types, units, required members and `member_notes` for several components at once. The reply carries a `catalog_digest`; pass it back as `if_digest` next time and you get `unchanged` when nothing moved |

### Editing sources (always pass `expected_digest`; on a conflict re-read rather than overwrite)
| Tool | What it does |
|------|--------------|
| `ssworld_source_read` | Source plus `digest`. For a large scene start with `{"mode":"metadata"}` to get only the digest; `{"node":"sun"}` reads one node; `{"file":"*"}` reads every file. Past 100 000 characters you get `has_more`/`next_offset` |
| `ssworld_source_write` | Whole-file write (a new file takes `expected_digest: "new"`). Writes `.ssdl`, `host_interfaces.json` and `logic.mjs` |
| `ssworld_source_patch` | One replacement; `old_string` must be unique including whitespace. Add `replace_all` for several |
| `ssworld_source_batch` | **Preferred for multi-site edits.** One atomic batch — if any edit fails nothing is written: `{"expected_digest":"…","validate":"compile","edits":[{"node_id":"sun","set":{"intensity":1.7}},{"node_id":"view","set":{"fov":48},"unset":["farPlane"]},{"old_string":"…","new_string":"…"}]}`. With `validate: compile` a failing compile rolls the batch back. Values are JSON numbers, strings, booleans or `[x,y,z]`; ids, enums and binding expressions go through `{"raw":"photoView"}` |

You may also edit the project's `.ssdl` files directly with the host's file tools — `ssworld_compile` always rebuilds from disk — you just lose the digest lock.

### Compiling and inspecting
| Tool | What it does |
|------|--------------|
| `ssworld_compile` | On failure: `scene.ssdl:line:column: code: message`. On success: `node_count`, budget `usage` and `logic` (declared properties, States, host calls) |
| `ssworld_scene_inspect` | **Anything you can learn without rendering, learn here instead of spending a screenshot.** Budget ratios, the largest subtrees, leaves counted by type, how many nodes each file contributes, geometry bounds (lowest floor / highest roof) and the camera the scene asks for (including the heading/pitch implied by `lookAt`) |

### Preview and capture
| Tool | What it does |
|------|--------------|
| `ssworld_preview` | Returns `viewer_url`. `page.connected` says whether a page is open; `page.clients` lists every browser currently syncing |
| `ssworld_capture_frame` | Screenshots an open page. Returns the image, pixel statistics, `receipt`, `framing`, `runtime.errors`, camera `effective/requested/deviation` and `logic`. Optional `width`/`height`/`settle_ms`/`client`/`await` (`{"state":"corner"}` or `{"property":"p","min":0.3,"max":0.5}` — the shot waits for the condition). **Use `"detail":"brief"` inside an iteration loop**: it keeps the verdict, errors, luma, the 3×3 regions and the image path, and drops the several thousand tokens of framing, receipt, camera and colour coverage |

### Runtime logic
| Tool | What it does |
|------|--------------|
| `ssworld_logic_read` | Reads page logic **and whether the module loaded at all** without a screenshot: `runtime.state`, `runtime.errors` (already mapped to `scene.ssdl:line`), property values, States, `bindings.invalid`, `binding_errors`. When the scene module dies, a screenshot only shows you the default globe view — use this instead and save the image |
| `ssworld_environment_read` | **Asks the engine what it actually received**, so you do not have to bisect with screenshots: the true direction of the adopted sun (read back from the native sun and converted to azimuth/elevation at the anchor, with the deviation from what the scene asked for), which light drives the atmosphere, and the current native values of every environment component (`SkyAtmosphere`, fog, cloud, `SkyLight`, post-process, your own lights). "Why is the sky orange" and "where is the sun really" are one call away |
| `ssworld_logic_write` | Writes several declared properties in one transaction: `{"set":{"p":0.4,"pace":0.0025}}`. Use it to put a game into a particular state before a screenshot — **do not edit the initial values in the source for that**. If any value is rejected the whole batch rolls back (`logical_write_rejected`); States are derived and cannot be written, so write the properties they read |

## The 45 built-in components at a glance

Pick a shape from this table, then read the exact properties with `ssworld_catalog`. **Never guess property names from QML or three.js experience.**

| Group | Components | Notes |
|-------|-----------|-------|
| **Skeleton** | `Scene` `Group` `Camera` `CameraView` | A parent can only be `Scene` or `Group`. Geometry cannot be a parent |
| **Primitives** | `Box` `Sphere` `Cylinder` `Cone` `Plane` | All carry UVs and take textures. Box width/depth/height map to X/Y/Z |
| **Procedural geometry** | `HeightField` `Lathe` `Tube` `Loft` | Parameters must be constants; at most 65535 vertices per node. **These four are the only ones with tangents**, so `normalMap` only works on them |
| | `Polygon` `ExtrudedPolygon` `Polyline` | Flat polygon / extrusion / polyline. They carry their own `color` and `opacity`. **No UVs, so no textures**, and they cannot be a Prefab source |
| **Assets** | `Model` `Texture` | glb ≤ 32 MiB, images ≤ 8 MiB, both under the project's `assets/`, at most 64 per project |
| **Materials** | `PrincipledMaterial` | `target` points at geometry. `baseColorMap` / `metallicRoughnessMap` / `normalMap` / `emissiveMap` |
| **Instancing** | `Prefab` `Instances` | A whole batch is one native object. The source may be geometry or a Model |
| **Lights** | `DirectionalLight` `PointLight` `SpotLight` `RectLight` `SkyLight` | The sun is `DirectionalLight { atmosphereSunLight: true }` |
| **Environment** | `SkyAtmosphere` `ExponentialHeightFog` `VolumetricCloud` `PostProcessVolume` | On environment components `rotation` is Euler degrees `[x,y,z]`, not a quaternion |
| **Animation** | `NumberAnimation` `Vector3dAnimation` `RotationAnimation` `QuaternionAnimation` `ColorAnimation` | `duration` in milliseconds, `loops: Animation.Infinite`, `running` is bindable |
| | `ParallelAnimation` `SequentialAnimation` `PauseAnimation` `Behavior` | A group animation costs one timeline for the whole group |
| **Logic and input** | `State` `Timer` `TapHandler` `HoverHandler` `KeyHandler` | |
| **Unavailable** | `Label` `SunSky` | `Label` has no font, and using it fails the whole scene load (the compiler already reports `runtime_unsupported`); use `SkyAtmosphere` instead of `SunSky` |

## Planning a scene: settle the shape before writing code

Walk these five in order before the first line of SSDL. Getting them wrong means rewriting later.

**1. Is there a model for it? Then use `Model`.** Cars, people, trees, furniture, sculpture — organic shapes should not be assembled from primitives; a dozen boxes neither look right nor fit the budget. The cost: a Model brings its own materials and **does not accept `baseColor` or `emissiveColor`**, so recolouring means building your own geometry.

**2. Dozens of copies or more? Use `Prefab` + `Instances`.** 240 street lamps are one native object and one draw call; 240 hand-written nodes are 240 of each. Build the source from `Cylinder`/`Lathe`/`Tube`/`Loft` if you want to recolour it, or hand it a glb if you want the real shape. Something appearing three to five times is not worth a Prefab.

**3. Do several parts move or rotate together? Make a `Group` the root.** Headlights on a car body, rotors on a fuselage — wrap them in a Group, write the attachments as fixed metric constants in local coordinates, and bind only the Group's own `position`/`rotation`. That saves unrolling quaternions into world coordinates every frame.

**4. Will it recur, or is it over roughly 30 lines? Split it into its own `.ssdl`.** PascalCase filename (`Tower.ssdl`), instantiated from the entry as `Tower { id: eastTower; position: [...] }`. Expose the differences as `property`. Keep the entry `scene.ssdl` a skeleton: camera, lights, environment, ground, and a screenful of component instances.

**5. Picture first, detail second.** Block the composition, camera and lighting out with a dozen masses and confirm with a screenshot. Past ~500 instances generate the source from a script in the project (`gen_*.py`) rather than typing it.

In one line: **use a glb rather than assembling primitives; instance rather than repeating a glb; group what moves together; split what gets reused.**

## SSDL semantics

### Coordinates and units
- **Right-handed Z-up, metres**: X east, Y north, Z up. `position` is the centre, so a box sitting on the ground needs `z = height/2`. The origin is the project anchor (its longitude/latitude).
- **Units are about the decimal point, not dimensional analysis**: `length`, `degrees`, `radians` and `real` all share one fixed-point lane, and only `duration` (milliseconds) uses another. Mixing them is not an error; values are taken at face value. That is why `position: [x + 2*qx*qw*11, …]` compiles. The cost: nobody warns you about a wrong unit.
- **List values may span lines**: a newline after `sections: [`, one ring per line, comments inside the brackets — all compile (since 0.9.8). A property still ends at a newline or `;`, so spanning lines only works inside `[ ]`.
- **`#rrggbb` is read as sRGB** (the value your colour picker gives you): the runtime converts sRGB to linear before handing it to the engine, so the screen shows the colour you picked and reading it back gives the same hex. Before 0.9.8 that step was missing and every flat colour came out roughly three times too bright. Native materials keep only 8 bits of **linear** light per channel, so very dark colours drift by a level or two (`#16260f` reads back as `#16260d`).
- **Geometry `rotation` is a quaternion `[x,y,z,w]`** (w last; identity is `[0,0,0,1]`). θ degrees about Z is `[0, 0, sin(θ/2), cos(θ/2)]`. To make something turn, use `RotationAnimation`. Environment components use Euler degrees instead.

### Camera
```ssdl
CameraView { id: v; position: [60, -80, 40]; lookAt: [0, 0, 12]; fov: 50 }
Camera { id: cam; initialView: v }
```
- `fov` is the **horizontal** field of view. The vertical fov follows the aspect ratio, so a wide frame shows less sky.
- `lookAt` derives heading and pitch; you can also set `heading` (0 = north, clockwise), `pitch` (negative looks down) and `roll` explicitly.
- `nearPlane`/`farPlane` are recomputed by the engine every frame from the camera height; writing them has no effect.
- `longitude`/`latitude`/`height` and `position` are alternatives, not a pair. For a street-level camera use z 1.5–3 m and fov 45–60.
- **For a chase camera, bind the pose directly**: `position`, `heading`, `pitch`, `roll`, `fov` and the geographic triple are all bindable and animatable. Angles are always degrees. `label`, `duration`, `lookAt` and the clip planes stay one-shot scene-setup values.

### Lights
- **`DirectionalLight` has two modes.** With `atmosphereSunLight: true` it adopts the sky's sun and only `intensity`, `lightColor`, `castShadows`, `temperature`, `indirectLightingIntensity`, `volumetricScatteringIntensity`, `sunAzimuth` and `sunElevation` may be written; members such as `lightSourceAngle` belong to a standalone light, and the wrong combination is a compile-time `runtime_unsupported`.
- **`intensity` is a dimensionless multiplier** (default 1), not lux.
- **Watch the conversion on point/spot/rect lights**: with `intensityUnits: "Lumens"` the engine divides a point light by about 795.8, so `intensity: 5.5, intensityUnits: "Lumens"` is roughly 0.007 and the frame is nearly black. When in doubt leave `intensityUnits` out and use 1–4 for neon and street lamps. Indoors 600–3000 lm per lamp is plenty; tens of thousands trigger lens glare (a string of blobs symmetric about the screen centre is not a second lamp).
- **Tint the sky through the sun; never touch the scattering terms.** On `SkyAtmosphere`, `rayleighScattering`, `mieScattering`, `mieAbsorption`, `otherAbsorption` and `skyLuminanceFactor` are UE's **normalised direction vectors** (the magnitude lives in the neighbouring `*Scale`). The engine's default `rayleighScattering` is `[0.175, 0.410, 1.000]` — blue weighted 5.7× red, which is the entire reason the sky is blue. Writing any "neutral-looking" vector raises red and turns the sky orange-brown; copying the physical coefficients `[0.0058, 0.0136, 0.0331]` divides the whole term by 30 and turns it orange-brown too. **All five members are refused at compile time** (`sky_scattering_refused`). For warmth write the sun's `lightColor`; for a warm low horizon lower `sunElevation`; for ground bounce use `groundAlbedo`; for haze use `ExponentialHeightFog`; for overall grade use `PostProcessVolume`.
- **`temperature` is an unnormalised multiplier**, normalised by luminance rather than by the largest component, so it changes brightness as well as hue: 3000K = `(1.77, 0.85, 0.27)`, 4000K = `(1.41, 0.92, 0.53)`, 5000K = `(1.22, 0.96, 0.76)`, 6500K = `(1.04, 0.98, 1.04)` (the neutral default), 8000K = `(0.95, 0.99, 1.24)`. On a sun with `atmosphereSunLight: true` that multiplier covers the whole sky — "golden dusk, 3500K" gives you an orange-brown sky from edge to edge. Write `lightColor` for warmth and leave `temperature` near 6500.
- **`SpotLight` and `RectLight` emit along their own -X**: `[0,0,0]` faces west, `[0,0,90]` south, `[0,0,180]` east, `[0,0,270]` north, `[0,-90,0]` straight down, `[0,90,0]` up. `attenuationRadius` is metres, cone angles are degrees.

### Materials and textures
Put PNG/JPG under `assets/`, declare a `Texture`, then hand it to a material:
```ssdl
Texture { id: brick; source: "assets/brick.png" }
Box { id: wall; width: 12; depth: 0.4; height: 6; position: [0, 0, 3] }
PrincipledMaterial { id: m; target: wall; baseColorMap: brick; uvScale: [0.25, 0.25] }
```
- `uvScale` multiplies the UV, so smaller values repeat the texture more densely.
- **Roughness maps go through `metallicRoughnessMap`** (linear space, G = roughness, B = metalness, multiplied by the scalars on the material). That is what separates wet patches from dry ones on a road after rain.
- **Normal maps go through `normalMap` + `normalScale`** (0..2). **Only `HeightField`, `Lathe`, `Tube` and `Loft` carry tangents**; a normal map on a Box, Plane or Sphere is a compile-time `material_requires_tangent`. To give a wall relief, lay a flat HeightField grid instead of a Box.
- **Emission goes through `emissiveMap` / `emissiveColor`**, which need UVs but not tangents, so every primitive can use them. `emissiveColor` is a **multiplier**, not a 0..1 colour: each component goes up to 16, and you need roughly 2–6 to cross `settings.bloomThreshold` and actually glow. Emission does not light its surroundings — add a light for that.
- Identical image content counts once against the texture budget even under different paths and on several objects. The same image used as both a colour map and a metallic-roughness map counts twice, because the colour spaces differ.

### Instancing
```ssdl
Cylinder { id: lampPost; radius: 0.12; height: 6; position: [0, 0, 3]; visible: false }
PrincipledMaterial { target: lampPost; baseColor: "#2a2a30"; metalness: 0.8 }
Prefab { id: pfLamp; source: lampPost }
Instances { id: lamps; prefab: pfLamp; placement: "grid"; origin: [0,0,3]; spacing: [18,40]; columns: 20; count: 240 }
```
Placing them one by one: `Instances { prefab: pfLamp; positions: [[0,0,3],[12,0,3],[24,0,3]] }` (giving `positions` implies explicit placement, and it needs **at least two**).

**A Model works as a source too**: `Model { id: car; source: "assets/car.glb" }` plus `Prefab { id: pfCar; source: car }` gives a fleet sharing the glb's own geometry and materials. Two rules apply only to Model sources: the source Model **must finish loading first** (the compiler guarantees Models are built before every other node, so just write it normally), and **you must not delete that Model while the Prefab is alive** (instances *borrow* its geometry, so deleting it is a dangling pointer and the runtime refuses outright). A multi-material glb costs one draw call per primitive and `draw_calls` reports that honestly; a geometry source is always 1.

Limits: the source must be geometry or a Model, never a `Polygon`; **the source node still renders itself**, so give it `visible: false` if you do not want to see it; instances **only translate** — no per-instance rotation or scale, and **the source node's own `rotation` is not baked in either**, so different orientations need several sources each turned differently; `seed` does not currently jitter positions; at most 512 per batch and 2048 per Prefab. Every member of `Instances` is a one-shot scene-setup value and cannot be bound or animated.

### Scene logic
Declare properties on the `Scene` root instead of using "eight lamps" as state:
```ssdl
property real score: 0        // types: real / bool / string / length / degrees / duration / radians
State { id: stWin; name: "win"; when: score >= 8 && misses < 3 }
```
- Handlers write `score = score + 1`; expressions support `+ - * / === !== < <= > >= && || ! ?:`. **Arithmetic only — there is no string concatenation.**
- **The assignments inside one handler are a single transaction**; if any fails the batch rolls back.
- **Bindings are also one transaction per frame**: if any bound value is rejected by its target (a negative `width`, a wrong type, a native refusal) the batch rolls back, that binding is invalidated, the values it drove stop changing, and the page throws nothing — you only get a `binding_error` in `runtime.errors` and an entry in `logic.bindings.invalid`. Write piecewise paths with `clamp`/`lerp`/`min`/`max` against a progress property rather than chains of `?:`, and keep every branch inside the target's legal range.
- **A `State` is referenced in expressions by `id`, not by `name`**: write `stWin.when`; `win.when` is an `unknown_reference`. Giving both the same spelling is the least trouble.
- A `State` is derived from `when` and cannot be written; write the properties it reads.
- **Every compile hot-reloads and resets logic properties to their initial values** (`ssworld_compile` returns `hot_reload.logic_reset`). Do not compile in the middle of a test, or restore the situation afterwards with `ssworld_logic_write`.

**Gameplay maths**: `min`/`max`/`clamp`/`lerp`, `abs` `sign` `floor` `ceil` `round`, `mod` (the remainder takes the dividend's sign), `sqrt`, `hypot`, `sin` and `cos` (**degrees** when no unit is given), `atan2(y,x)` (returns degrees), `hash01(seed)`.
- Distance tests can be written either way: `hypot(dx, dy) < 4` and `dx*dx + dy*dy < 16` both work.
- **There is no `random()`**: bindings re-evaluate every frame, so true randomness would read back differently each time. For variation use `hash01(integer seed)` — same seed, same result, range `[0,1)`: `height: 2 + hash01(i) * 3`.
- Heading to a forward vector: `position: [x + sin(heading)*6, y + cos(heading)*6, z]`.

### Input
```ssdl
KeyHandler { id: kThrust; key: "ArrowUp"; onPressed: { throttle = 1; } onReleased: { throttle = 0; } }
KeyHandler { id: kBoost; key: " " }
State { id: boosting; name: "boosting"; when: kBoost.pressed }
```
`key` is the `KeyboardEvent.key` value (`"ArrowUp"`, letters case-insensitive, `" "` for space, `"Enter"`), one key per handler. **Read `pressed` for continuous actions (throttle, steering); use `onPressed` for discrete ones (fire, switch view).** The listener sits on the window, calls `preventDefault` for the keys it claims, force-releases on blur, and ignores the operating system's key repeat by default (set `autoRepeat: true` if you want it).

Mouse movement, the wheel and gamepads have no components yet: listen in `index.html` and call `window.SSWorld.logical.write("name", value)` or `.writeBatch({a:1,b:2})`.

### Animation
- Easing is `easing.type: "Easing.InOutSine"` — the enum must be fully qualified; `easing: "InOutSine"` is an `unknown_property`. (The equivalent member on `Behavior` is spelled `easing`.)
- `Behavior` eases every change of its target property over `duration`; put it on a property that changes each frame and it lags by roughly speed × duration. **Use it for discrete jumps only; bind continuous motion directly.**
- `Group` and `Model` can only animate `position`, `rotation`, `scale` and `visible`; a material animation pointing at them is a compile-time `property_not_animatable`.
- **There is a hard ceiling of 256 native timelines**: every top-level animation takes one and never gives it back, a `ParallelAnimation`/`SequentialAnimation` takes one for itself and all its children, and a `Behavior` takes one only while a transition is running. Going over is `animation_budget`; watch `usage.timelines`.

### Host JS
When a rule needs JS, go through a host interface — **do not move geometry into JS**:
1. `host_interfaces.json`: `{"Game":{"methods":{"hit":{"args":[{"name":"targetId","type":"string"}]}}}}`
2. `logic.mjs`: `export function createHostInterfaces(api) { return { Game: { hit({targetId}) { api.logical.write("score", n); } } }; }`
3. SSDL: `TapHandler { onTapped: { Game.hit(targetId: "balloonA"); } }`

An undeclared interface, method or argument is a compile-time `host_interface_unknown` / `host_method_unknown` / `host_arg_missing`; a missing implementation makes the page refuse to load (`host_interface_missing`). Callbacks are synchronous and return nothing, so state changes go through `api.logical.write`; anything thrown lands in `logic.host_call_errors`.

### Post-processing
All 33 knobs are open: `settings.bloomThreshold`, `autoExposureMinBrightness`/`MaxBrightness`, `lowPercent`/`highPercent`, `histogramLogMin`/`Max`, `toneCurveAmount`, `temperature`, `ambientOcclusion*` and the rest. **To stop a night scene's exposure drifting with the number of neon signs**, set `autoExposureMinBrightness` and `MaxBrightness` to the same value (that locks exposure) and grade with `autoExposureBias` (the multiplier is 2^bias).

### Odds and ends
- **Anonymous nodes are fine**: without an `id` the compiler injects a file-scoped name. Still, name sibling nodes of the same type inside a custom component file explicitly, so `ssworld_scene_inspect` and `ssworld_logic_write` can point at them precisely.
- Use meaningful ids (`civicRoof`, `eastTower`), not `b123`.
- **Default budgets**: 4096 native objects / 4096 material shells / 32 distinct images / 4096 bindings / 2048 handlers / 256 timers / 256 timelines / 1024 Group locators / 1024 Prefabs / 524288 instance rows. A project can raise the guardrails in `showcase.manifest.json`, but not the four the engine owns — distinct images, timers, timelines and Group locators are clamped to the engine's own ceilings, because a scene past them compiles and then fails to mount.
- **Where scale actually runs out** (measured, not guessed): 6401 native objects + 409 600 instance rows still render at 61 fps. What breaks first is `ssworld_capture_frame`: the offscreen readback dies of a wasm out-of-bounds somewhere between 4001 objects (captures fine) and 5001 (does not), so a scene past ~4000 objects **runs but cannot be screenshotted**. Build big scenes out of `Prefab` + `Instances` rather than individual nodes: 409 600 instance rows cost 200 native objects and capture fine. Also give a large scene a real `timeout_ms` (default 30000) — the readback is the slow part.

The smallest interactive example, which is also the starter scene `ssworld_project_create` writes:
```ssdl
Scene {
  id: main
  CameraView { id: startView; position: [60, -80, 40]; lookAt: [0, 0, 12]; fov: 50 }
  Camera { id: mainCamera; initialView: startView }
  State { id: selected; name: "selected"; when: false }
  Box {
    id: cube; width: 24; depth: 24; height: 24; position: [0, 0, 12]
    PrincipledMaterial { baseColor: selected.when ? "#ffb454" : "#4288db"; roughness: 0.3; metalness: 0.5 }
    TapHandler { onTapped: { selected.when = !selected.when; } }
  }
  RotationAnimation { target: cube; property: "rotation"; from: 0; to: 360;
    duration: 8000; running: !selected.when; loops: Animation.Infinite }
}
```

## Reading a capture

**Check `receipt.in_sync` first.** False means the frame belongs to an older compile or the source on disk has changed since; `staleness` says which. Recompile and recapture as `next` tells you — **never report from a stale frame**.

**Then check `runtime.errors`.** A non-empty list is a runtime failure: compiling is not running. Each entry carries `source.file:line:column`, so go fix that line. In this state `camera.source` becomes `engine_default`, so the pose in that frame is not your CameraView — do not judge the composition from it.

**Then look at the image.** With vision, judge the composition, whether the camera is aimed correctly and whether things are in frame. Without it, read `stats`:
- `luma.p10/p50/p90` plus `under_exposed_ratio`/`over_exposed_ratio` for exposure
- `coverage` and `regions.cells` (3×3, starting top-left) — green/blue/white/neutral shares answer "is there greenery along the bottom, is the top actually sky"
- `colormap_top` for the dominant colours

**Easy misreadings:**
- The `nearPlane`/`farPlane` entries in `camera.deviation` come from the engine recomputing the clip planes each frame; they do not mean your parameters were ignored. A large `heading_error_deg` or `position_error_m` does.
- `render_verified: true` only means "ready, no errors, the frame is not black". Whether it is *right* is a question for the image.
- `reference_match` is always `not_evaluated`: the tool does no reference-image comparison. **Do not invent a match score.**
- On `page_not_open`, open `viewer_url` with `open_preview` first (the window must be visible — a minimised one produces no frames) and then capture.
- On `saveImage2Base64 timed out`, check `status.visibility`: `"hidden"` means the page was switched away and the browser throttled rAF, which is not a scene problem — close and reopen the preview panel. Capturing a large scene repeatedly can drag the MCP service to `unreachable`; it recovers on its own in about a minute, so do not hammer it. Sizes above 1200×900 also time out easily on a large scene.
- With both the desktop panel and your own browser open, read `receipt.client` to see which page the frame came from (the default is the most recently synced visible one; `client` selects explicitly).

For an animated scene capture two moments (different `settle_ms`), and recapture after moving the camera.

## Traps

- **Geometry cannot be a parent.** Hanging a Cone under a Box **compiles** and then fails to load: `SceneObject.parent must be a live Scene, Group or GeoAnchor from the same runtime`. Use a `Group` root for a multi-part unit, or have the generator flatten the parts into siblings under Scene with absolute coordinates.
- **Degenerate meshes take the whole scene module down, and are now refused at compile time.** A radius of 0 in a `Lathe` `profile` (trying to make a point), exactly repeated adjacent points, a `Tube` path that doubles back on itself or repeats a point, two identical adjacent `Loft` rings — these used to fail the entire module with `GeometryFacade.createMesh: triangle is degenerate` without naming a node. Now the compiler reports `mesh_degenerate` with the node and the index. Use a small positive radius (say 0.02) instead of 0 for a point. And to be clear: **a vertical first segment of a `Tube` is fine** — the frame switches reference axis automatically once `|tangent.z| >= 0.9`.
- **`HeightField.heights` counts grid corners, not cells.** `columns: 2; rows: 2` is four quads with **nine** corners, so it needs nine values, not four: `(columns+1)*(rows+1)`. Writing `columns*rows` values is the single most common `mesh_invalid`. Row-major, first row at `-depth/2` (south), first value at `-width/2` (west), and the whole list on one line. To cover a `width`-by-`depth` patch at a spacing of `s`, use `columns: width/s; rows: depth/s`.
- **Writing a `Label` fails the whole scene load.** Put text in an `index.html` overlay (give the overlay `pointer-events: none` or it swallows clicks) or build it from geometry.
- **An orange-brown sky means a scattering term or the sun's colour temperature was touched.** The five scattering vectors are now a compile-time `sky_scattering_refused` (see Lights); `temperature` is still writable but drags brightness along with hue. A bare `SkyAtmosphere` plus the sun's `lightColor` is the only tinting path confirmed on real hardware.
- **Accepting an interactive scene requires a real browser.** The desktop preview panel's `drive_preview` reports `clicked`/`pressed`, but the page's own `click`/`keydown` listeners never fire once (synthetic input is not delivered), so using it to accept mouse/keyboard gameplay gives false negatives. The panel is for looking at the picture. To assert the interaction path, drive a real Chrome over CDP with `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` and read the state back from `logic.properties`.
- **Editing a file under `assets/` hot-reloads as is** — the page keys its asset cache on content digests.
- **Nesting is limited to 16 levels** (`scene_depth_exceeded`) and a scene mounts at most **64 `Model` nodes** (`model_budget`) and 64 MiB of distinct images in total (`texture_budget`) — all three are the engine's own ceilings and all three are compile errors now. For many copies of one glb, use it as a `Prefab` source instead of mounting a Model per placement.
- **Do not compare budget numbers across categories**: native objects, material shells and distinct images are counted separately, the compiler only reports usage, and the real texture gate is at runtime. A generator script's own node estimate runs 2–10% off; trust the compile receipt.

## What is genuinely missing — do not work around it

There is no particle system, no audio, no creating or destroying nodes at runtime (use an object pool: build them up front and reuse with `visible` and position), no colliders or physics (write the distance tests yourself), and logic properties have neither arrays nor string concatenation (eight targets means eight boolean properties, and HUD text is assembled on the page side).

`GeoAnchor` **does not exist** in SSDL 0.3 and writing it is an `unknown_type`; geographic placement comes from the anchor coordinates given to `ssworld_project_create`.

Never delete or overwrite an existing project of the user's; `ssworld_project_create` errors on a duplicate name.

## Always finish with

The project name and source path, the `viewer_url`, the screenshot path (`capture_path`) and **what you saw in it**, any runtime errors, and which parts you did not verify.
