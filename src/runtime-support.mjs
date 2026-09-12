// Runtime capability facts the catalog alone cannot express. The catalog says what the compiler
// accepts; the engine decides what it can actually write. Everything here was verified against the
// native EnvironmentFacade (ssdl_environment_bindings.cpp), lirendersystem.cpp and the SSDL browser runtime.

/** Bumped whenever the notes below change meaning, so catalog_digest moves with them. */
export const NOTES_VERSION = 16;

// DirectionalLight with atmosphereSunLight: true adopts the engine's scene sun (LiSun), which only
// exposes the LiLight base properties. The owned-light-only members fail at runtime with
// "ue_member_unsupported: DirectionalLight.<member> is not writable in this runtime".
const SUN_ONLY_UNSUPPORTED = ["lightSourceAngle", "lightSourceSoftAngle", "cloudScatteredLuminanceScale"];
// The other half of the same question, which the catalog alone never answered: what DOES survive
// atmosphereSunLight: true.  Marking the writable members is what stops the "is this one allowed?"
// guess-and-compile loop.
const SUN_WRITABLE_ON_ADOPTED = ["intensity", "lightColor", "castShadows", "temperature", "useTemperature",
  "indirectLightingIntensity", "volumetricScatteringIntensity", "visible"];

/** What to use instead of a component the runtime does not implement (merged into unavailable_components). */
export const UNAVAILABLE_ALTERNATIVES = Object.freeze({
  SunSky: "use SkyAtmosphere + DirectionalLight { atmosphereSunLight: true; sunAzimuth: <deg, 0 = north clockwise>; sunElevation: <deg above horizon> } for a sun that drives the sky",
});

// LiRenderSystem recomputes both clip planes every frame from the camera's height above the
// ellipsoid: far = horizon distance * 1.01, near = max(0.5 m, far * 2e-5). CameraView.nearPlane /
// farPlane are applied once and then overridden, so the capture receipt reports them as engine-managed.
export const CLIP_PLANE_POLICY = "engine recomputes nearPlane/farPlane every frame from camera height (far = horizon distance x 1.01, near = max(0.5, far x 2e-5)); CameraView.nearPlane/farPlane are not honoured by this runtime";

// LiCamera.fov is the HORIZONTAL field of view: fovy = 2·atan(tan(fov/2) / aspect) (licamera_p.h
// updateFieldOfView). Verified 2026-09-10 against the pick pixel map of the ShootingRange test as well.
export const FOV_POLICY = "CameraView.fov is the horizontal field of view in degrees; the vertical fov follows the viewport aspect (fovy = 2*atan(tan(fov/2)/aspect)), so the same fov shows less sky on a wide canvas";

// Label needs an SDF font the engine loads from assets/font/ next to the page; ssworld-mcp ships no font
// (msyh.ttc is not redistributable), so a Label makes the whole scene module fail to load.
export const LABEL_POLICY = "Label needs a managed SDF font (assets/font/msyh.ttc) that ssworld-mcp does not ship, so any Label makes the scene module fail to load; put text in the page (index.html overlay) or model it with geometry";

// M4: normalMap needs a tangent-space vertex stream. Only the generators below ship analytic
// tangents today, so a normal map anywhere else is refused at compile time rather than rendering
// a silently wrong surface (§7 silent-failure defence).
export const TANGENT_CAPABLE_TYPES = new Set(["HeightField", "Lathe", "Tube", "Loft"]);
export const TANGENT_POLICY = "normalMap requires a tangent-space geometry: only HeightField/Lathe/Tube/Loft carry analytic tangents, so this combination would render without tangent space and is refused at compile time";

// SkyAtmosphere's scattering members are UE's "normalised direction + separate scale" pair, and the
// engine defaults are strongly asymmetric (LiSkyAtmospherePrivate in liskyatmosphere.cpp):
// rayleighScattering is (0.175, 0.410, 1.0) carrying the blue bias of the sky, with the magnitude in
// rayleighScatteringScale = 0.0331. Any evenly weighted vector an author writes there ([1, 1, 1],
// [0.6, 0.7, 1.0]) multiplies red by up to 5.7x against blue, and writing the raw physical
// coefficients instead ([0.0058, 0.0136, 0.0331]) divides the whole term by ~30; either way the blue
// sky is gone and what is left (Mie forward scattering plus the ozone term) renders orange-brown.
// The catalog cannot express a default, several agents lost the sky this way, and nothing needs these
// members, so they are refused at compile time and the author is pointed at the knobs that work.
export const SKY_SCATTERING_DEFAULTS = Object.freeze({
  rayleighScattering: "[0.175, 0.410, 1.000] x rayleighScatteringScale 0.0331 (the blue bias of the sky)",
  mieScattering: "[1, 1, 1] x mieScatteringScale 0.003996 (aerosol haze)",
  mieAbsorption: "[1, 1, 1] x mieAbsorptionScale 0.000444",
  otherAbsorption: "[0.346, 1.000, 0.045] x otherAbsorptionScale 0.001881 (the ozone layer)",
  skyLuminanceFactor: "[1, 1, 1] (a direct multiplier on sky luminance)",
});
export const SKY_TINT_POLICY = "colour the sky through the sun, not the scattering vectors: DirectionalLight { atmosphereSunLight: true; lightColor: \"#ffd9a8\"; intensity } tints the whole atmosphere, sunElevation decides how warm the horizon gets (low sun = long optical path = warm), SkyAtmosphere.groundAlbedo tints the ground bounce, ExponentialHeightFog carries haze, and PostProcessVolume temperature/autoExposureBias grade the final image";

// FLinearColor::MakeFromColorTemperature (UnrealMath/Math/Color.cpp) normalises the Planckian colour to
// luminance Y = 1, NOT to a maximum component of 1, and the light colour is multiplied by it. So a warm
// temperature both tints and brightens red: measured 3000K -> (1.77, 0.85, 0.27), 4000K -> (1.41, 0.92,
// 0.53), 5000K -> (1.22, 0.96, 0.76), 6500K -> (1.04, 0.98, 1.04), 8000K -> (0.95, 0.99, 1.24). On the
// atmosphere sun that multiplier reaches the whole sky, which is why "golden hour 3500K" comes back as
// an orange-brown sky rather than a warm sun.
export const LIGHT_TEMPERATURE_POLICY = "useTemperature: true multiplies lightColor by the Planckian colour normalised to luminance (not to a maximum of 1), so it changes brightness as well as hue: 3000K = (1.77, 0.85, 0.27), 4000K = (1.41, 0.92, 0.53), 5000K = (1.22, 0.96, 0.76), 6500K = (1.04, 0.98, 1.04, the neutral default), 8000K = (0.95, 0.99, 1.24); on the atmosphere sun (atmosphereSunLight: true) this tints the entire sky, so a warm temperature renders an orange-brown sky - prefer lightColor for a deliberate tint and keep temperature near 6500 unless you want the whole atmosphere warmed";

// Author colours are sRGB, the way every colour picker and the PBR base-colour convention mean them;
// the engine shades in linear light and takes the material/light colour straight from the float it is
// given, so the runtime applies the sRGB -> linear transfer when a #rrggbb enters (and its exact inverse
// when a colour is read back).  Before 0.9.8 it did not, and every flat colour rendered about three
// times too bright -- #808080 arrived as linear 0.5, which looks like sRGB 188.
export const COLOR_POLICY = "#rrggbb (or #rrggbbaa) is sRGB, the value a colour picker shows: the runtime applies the sRGB->linear transfer on the way into the engine, so the rendered surface is the colour you picked and a colour read back is the same hex you wrote. Alpha is linear. The native material keeps 8 bits per channel of LINEAR light, so two very dark colours can land on the same value (#16260f comes back as #16260d); use emissiveColor (a multiplier, not a colour) for anything that must stay exact";

export const TIMELINE_LIMIT = 256;
export const TIMELINE_TYPES = new Set(["NumberAnimation", "Vector3dAnimation", "ColorAnimation", "RotationAnimation", "QuaternionAnimation", "ParallelAnimation", "SequentialAnimation"]);
const TIMELINE_CONTAINERS = new Set(["ParallelAnimation", "SequentialAnimation", "Behavior"]);
export const ANIMATION_POLICY = `the engine runs at most ${TIMELINE_LIMIT} native timelines per page: every top-level NumberAnimation/Vector3dAnimation/RotationAnimation/QuaternionAnimation/ColorAnimation counts one whether or not it is running (finished ones keep their slot until the scene reloads), a ParallelAnimation/SequentialAnimation with all its children counts one, animations inside a Behavior count nothing until the Behavior transitions (each in-flight transition takes a slot); a small game (one animation per target plus Behavior transitions per hit) fits; beyond that group related animations under one ParallelAnimation/SequentialAnimation or drive repeated objects with Behaviors + bindings`;


export const ASSETS_DIR = "assets";
export const ASSET_MEDIA = Object.freeze({
  ".glb": { kind: "model", media_type: "model/gltf-binary" },
  ".png": { kind: "texture", media_type: "image/png" },
  ".jpg": { kind: "texture", media_type: "image/jpeg" },
  ".jpeg": { kind: "texture", media_type: "image/jpeg" },
});
// Runtime caps (ssdl-builtins managedAssetRef): a Model glb up to 32 MiB, a Texture image up to 8 MiB;
// the source project schema takes at most 64 asset references.
// Matches MAX_EMISSIVE_COMPONENT in the runtime and kMaterialMaxEmissiveComponent in the native facade.
export const EMISSIVE_COMPONENT_MAX = 16;
export const ASSET_LIMITS = Object.freeze({ model: 32 * 1024 * 1024, texture: 8 * 1024 * 1024, count: 64 });
export const BINDING_POLICY = "bindings and handler assignments apply as one transaction per event/frame: if ANY bound value is refused by its target (out of range such as a negative width, wrong type, a native refusal) the whole batch rolls back, that binding turns invalid and the affected values stop changing with no exception; ssworld_capture_frame / ssworld_logic_read report it as runtime.errors kind binding_error (mapped to scene.ssdl:line) and logic.bindings.invalid; write piecewise motion with clamp/lerp/min/max over a progress property instead of branchy ?: chains, and keep every branch inside the target's valid range";
export const ASSET_POLICY = `put glb models and png/jpg textures under the project's ${ASSETS_DIR}/ directory and reference them by project-relative path (Model { source: "${ASSETS_DIR}/name.glb" }); each glb is at most ${ASSET_LIMITS.model / 1048576} MiB, each texture ${ASSET_LIMITS.texture / 1048576} MiB, at most ${ASSET_LIMITS.count} assets per project (asset_budget beyond); a Model needs no material of its own, and only its position/rotation/scale/visible can animate`;

export const CONVENTIONS = Object.freeze({
  coordinate_system: "right-handed, Z-up; x east, y north, z up, metres; local origin is the project anchor",
  quaternion_order: "[x, y, z, w] (w last); identity is [0, 0, 0, 1]; only geometry/Model/Group rotation is a quaternion",
  environment_rotation: "DirectionalLight/SkyAtmosphere/fog/cloud `rotation` is Euler degrees [x, y, z] (UE convention), not a quaternion; prefer sunAzimuth/sunElevation for the sun",
  euler_free_rotation: "prefer RotationAnimation / Vector3dAnimation for animated turns; static geometry rotation is a quaternion",
  camera: "CameraView.position/lookAt are local metres in the same frame as node positions; heading 0 = north, clockwise; pitch negative = looking down; fov is the HORIZONTAL field of view in degrees",
  clip_planes: CLIP_PLANE_POLICY,
  field_of_view: FOV_POLICY,
  labels: LABEL_POLICY,
  procedural_geometry: "parametric generators (HeightField width/depth/columns/rows/heights row-major from -depth/2; Lathe profile [radius, 0, height] revolved around Z with segments and optional closed caps; Tube path + radius + segments with a parallel-transport frame; Loft same-count ccw rings stacked bottom to top with optional cap) are compile-time constants: the IR stores parameters, the runtime builds a MeshData/v1 mesh (ccw outward, at most 65535 vertices per node, compile error mesh_budget beyond that); generated vertices carry normalized UVs: u spans the HeightField width or each Lathe/Tube/Loft ring, v spans the HeightField depth or the profile/path/section order, and both axes run from 0 to 1; per-vertex functions and author JavaScript are not accepted; arbitrary meshes go through managed assets (Model)",
  textures: "PrincipledMaterial supports baseColorMap, metallicRoughnessMap, normalMap and emissiveMap, each referring to a Texture; texture mapping requires UVs on the target geometry. Prepare a metallicRoughnessMap in linear space: G is roughness and B is metalness, and both channels multiply the material's roughness/metalness scalar values. normalMap is tangent-space and only the HeightField/Lathe/Tube/Loft generators carry analytic tangents, so a normal map on any other geometry is refused at compile time with material_requires_tangent; normalScale (0..2, default 1) scales its strength. Put Texture image resources at assets/*.png or assets/*.jpg, each no larger than 8 MiB. The runtime shares identical image content by content digest, so one image used by many objects or texture slots occupies one texture; reuse a path where it makes the scene easier to read. The compiler reports resolved image file bytes only and never estimates decoded memory; the runtime facade is authoritative for decoded texture accounting. uvScale is [u, v] and applies UV × uvScale; smaller values increase repeat density, while the exact rendered tiling direction still needs hardware verification. emissiveMap is sRGB colour data and, like baseColorMap, needs only UVs — never tangents — so it works on any primitive; the base pass multiplies it by emissiveColor ([r, g, b], 0..16, default 1 meaning the map as authored), and values above 1 are how a neon surface crosses the bloom threshold. emissiveColor without an emissiveMap is a flat self-lit colour",
  animations: ANIMATION_POLICY,
  assets: ASSET_POLICY,
  logic: "declare scene state on the Scene root with `property real score: 0` (types real/bool/string/length/degrees/duration/radians); handlers assign with expressions (`score = score + 1`), bindings compare (`>= <= === !== < > && || ! ?:`); host JavaScript is reached only through `Iface.method(arg: expr)` actions declared in host_interfaces.json and implemented by logic.mjs; the page reads/writes declared properties through window.SSWorld.logical and tools through ssworld_logic_read / ssworld_logic_write (one transaction per call); a State is derived from its `when` expression and cannot be written, set a declared property it reads; every compile hot-reloads the page and restarts declared properties at their initial values",
  expressions: "expression functions: min/max/clamp/lerp, abs/sign, floor/ceil/round (to one whole unit), mod (remainder keeps the dividend's sign), sqrt (stays in its operand's unit), hypot, sin/cos (an untagged number reads as degrees; dimensionless out), atan2(y, x) (degrees out) and hash01(seed) (deterministic pseudo-random in [0, 1)). There is no random(): bindings re-evaluate every frame, so a real random would never read back stable — seed hash01 with a counter (hit number, instance index) instead. Units are fixed-point lanes, not dimensions: length/degrees/radians/real share one lane and duration (ms) is the other, mixing them rescales to the finer lane and takes the numbers at face value, and nothing is refused for being dimensionally odd — so (carX-gateX)*(carX-gateX) + dy*dy < 16 compiles exactly like hypot(carX-gateX, dy) < 4",
  input: "TapHandler is a 3D pick; KeyHandler { key: \"ArrowUp\"; pressed; onPressed; onReleased } is the keyboard. It listens on the window (the WebGPU canvas is not focusable, so a canvas-scoped listener would only fire after the player happens to click it), calls preventDefault on the key it claims so arrows and space stop scrolling the page, resets pressed on blur so alt-tab cannot leave the throttle stuck on, and ignores OS key repeat unless autoRepeat: true. pressed is read-only and drives ordinary bindings and State.when. Mouse/pointer motion, wheel and gamepad still have no component: reach them from index.html and write declared properties through window.SSWorld.logical.write(name, value) / writeBatch({ ... })",
  bindings: BINDING_POLICY,
  page: "index.html is project-owned; the template places the WebGPU canvas and the info panel side by side so no overlay covers the canvas (an overlay over the canvas also swallows the taps TapHandlers need; give decorative overlays pointer-events: none)",
  ids: "every node in a component file needs a unique explicit id; anonymous siblings collide inside custom components",
  editing: "ssworld_source_patch edits one span by exact match; ssworld_source_batch applies several patches / node property sets atomically (optionally compiling and rolling back); ssworld_source_write replaces a file; writing the .ssdl files in the project directory with any other tool also works because ssworld_compile always rebuilds from disk, but such writes are not protected by the digest lock",
  colors: COLOR_POLICY,
  units_tag: "a descriptor's `unit` is the compiler's wire tag ('scalar' means untagged), not always the physical unit; the member note names the physical unit where they differ",
});

/** Member-level notes merged into ssworld_catalog output. */
export function memberNotes(component, member, descriptor = {}) {
  const notes = memberNote(component, member, descriptor);
  // Writability under atmosphereSunLight is a second axis: keep whatever the member's own note says.
  if (component === "DirectionalLight" && SUN_WRITABLE_ON_ADOPTED.includes(member)) {
    return { runtime_writable: "yes, on both the adopted atmosphere sun and an owned light", ...(notes || {}) };
  }
  return notes;
}

function memberNote(component, member, descriptor = {}) {
  if (component === "DirectionalLight" && SUN_ONLY_UNSUPPORTED.includes(member)) {
    return { runtime_writable: "only when atmosphereSunLight is not true (owned light); the adopted scene sun rejects it" };
  }
  if (component === "DirectionalLight" && ["sunAzimuth", "sunElevation"].includes(member)) {
    return { runtime_writable: "only when atmosphereSunLight: true", note: member === "sunAzimuth" ? "degrees, 0 = north, clockwise (local ENU at the anchor)" : "degrees above the horizon" };
  }
  if (descriptor.value_type === "color") {
    return { note: COLOR_POLICY };
  }
  if (component === "SkyAtmosphere" && Object.hasOwn(SKY_SCATTERING_DEFAULTS, member)) {
    return { runtime_writable: "refused at compile time (sky_scattering_refused)",
      note: `engine default ${SKY_SCATTERING_DEFAULTS[member]}; this is a normalised direction whose magnitude lives in the matching *Scale member, so an evenly weighted vector here destroys the blue sky and renders it orange-brown. ${SKY_TINT_POLICY}` };
  }
  if (/Light$/.test(component) && (member === "useTemperature" || member === "temperature")) {
    return { note: LIGHT_TEMPERATURE_POLICY };
  }
  if (member === "intensity" && /Light$/.test(component)) {
    return { note: "dimensionless multiplier on the light's radiance; engine default 1.0; not lux/candela (see intensityUnits where present)" };
  }
  if (component === "CameraView") {
    const notes = {
      position: "camera position in local metres relative to the anchor (x east, y north, z up); mutually exclusive with longitude/latitude/height",
      lookAt: "aim point in local metres; derives heading/pitch unless they are set explicitly",
      fov: `horizontal field of view in degrees, 1..170 (engine default 65); ${FOV_POLICY}`,
      nearPlane: `near clip distance in metres (> 0); ${CLIP_PLANE_POLICY}`,
      farPlane: `far clip distance in metres (> nearPlane); ${CLIP_PLANE_POLICY}`,
      longitude: "WGS84 degrees (unit tag 'scalar' is the wire encoding); use position instead when composing a local scene",
      latitude: "WGS84 degrees (unit tag 'scalar' is the wire encoding)",
      height: "metres above the WGS84 ellipsoid",
      heading: "degrees, 0 = north, clockwise",
      pitch: "degrees, -90 = straight down, 0 = horizon",
    };
    return notes[member] ? { note: notes[member] } : null;
  }
  if (member === "rotation") {
    return descriptor.value_type === "quaternion"
      ? { note: `quaternion ${CONVENTIONS.quaternion_order.split(";")[0]}` }
      : { note: "Euler degrees [x, y, z] (UE component convention); not a quaternion" };
  }
  return null;
}

/** Component-level notes merged into ssworld_catalog output. */
export function componentNotes(name) {
  if (name === "DirectionalLight") return { runtime_note: "atmosphereSunLight: true adopts the engine sun (drives the sky); only intensity/lightColor/castShadows/temperature/indirect/volumetric and sunAzimuth/sunElevation are writable on it. Leave it false for an owned light with full members." };
  if (name === "CameraView") return { runtime_note: `${CONVENTIONS.camera}. ${FOV_POLICY}. ${CLIP_PLANE_POLICY}` };
  if (name === "SkyAtmosphere") return { runtime_note: `the engine ships Earth defaults; the four scattering vectors and skyLuminanceFactor are refused at compile time because an evenly weighted value there turns the sky orange-brown (${SKY_TINT_POLICY}). The scalar members (multiScatteringFactor, the *Scale magnitudes, mieAnisotropy, the exponential distributions, heightFogContribution, aerial perspective) stay writable` };
  if (name === "Label") return { runtime_note: LABEL_POLICY, runtime_supported: false };
  if (name === "Model") return { runtime_note: `${ASSET_POLICY}; Model animates position/rotation/scale/visible only (animations, Behaviors and Bindings)` };
  if (name === "Texture") return { runtime_note: `Texture.source is a png/jpg under ${ASSETS_DIR}/ (at most ${ASSET_LIMITS.texture / 1048576} MiB), referenced by project-relative path; pair it with Model.baseColorTexture + materialSlot` };
  if (name === "Behavior") return { runtime_note: `Behavior eases every change of its target property over duration, so on a property that changes every frame the presented value lags the logical one by about speed x duration (57 m/s x 0.12 s = 7 m); use it for discrete jumps (hits, state changes) and bind continuous motion directly. ${BINDING_POLICY}` };
  if (name === "Group" || name === "GeoAnchor" || name === "Model") return { runtime_note: `${name} animates position/rotation/scale/visible only (animations, Behaviors and Bindings); material properties belong to the child geometry` };
  return {};
}

/** Post-compile check of the scene IR for combinations the compiler accepts but the engine rejects. */
/** Native timelines the compiled scene will allocate at mount: top-level animation nodes and animation groups (children fold into their group). */
export function timelineNodes(sceneIR) {
  const types = new Map((sceneIR?.nodes || []).map((node) => [node.id, node.type]));
  return (sceneIR?.nodes || []).filter((node) => TIMELINE_TYPES.has(node.type) && !TIMELINE_CONTAINERS.has(types.get(node.parent)));
}

export function checkRuntimeSupport(sceneIR) {
  const problems = [];
  const types = new Map((sceneIR?.nodes || []).map((node) => [node.id, node.type]));
  const timelines = timelineNodes(sceneIR);
  if (timelines.length > TIMELINE_LIMIT) {
    const extra = timelines[TIMELINE_LIMIT];
    problems.push({ code: "animation_budget", node: extra.id, type: extra.type, property: null,
      message: `${extra.type} '${extra.id}' is native timeline ${timelines.length > TIMELINE_LIMIT + 1 ? `${TIMELINE_LIMIT + 1}..${timelines.length}` : TIMELINE_LIMIT + 1} of at most ${TIMELINE_LIMIT} (the page would fail at mount with AnimationFacade.createTimeline: max_active_timelines reached); ${ANIMATION_POLICY}` });
  }
  for (const node of sceneIR?.nodes || []) {
    const props = new Map((node.properties || []).map((item) => [item.property, item.value]));
    if (node.type === "Label") {
      problems.push({ code: "runtime_unsupported", node: node.id, type: node.type, property: "text",
        message: `Label '${node.id}': ${LABEL_POLICY}` });
    }
    if (node.type === "DirectionalLight" && props.get("atmosphereSunLight") === true) {
      for (const member of SUN_ONLY_UNSUPPORTED) {
        if (props.has(member)) {
          problems.push({ code: "runtime_unsupported", node: node.id, type: node.type, property: member,
            message: `${node.type} '${node.id}': ${member} cannot be written when atmosphereSunLight is true (the adopted scene sun has no such property); remove ${member} or set atmosphereSunLight: false` });
        }
      }
    }
    if (node.type === "SkyAtmosphere") {
      for (const member of Object.keys(SKY_SCATTERING_DEFAULTS)) {
        if (!props.has(member)) continue;
        problems.push({ code: "sky_scattering_refused", node: node.id, type: node.type, property: member,
          message: `SkyAtmosphere '${node.id}': ${member} is the normalised scattering direction, not a colour - its engine default is ${SKY_SCATTERING_DEFAULTS[member]}, so an evenly weighted vector written here multiplies red against blue (or, with raw physical coefficients, divides the whole term by ~30) and the sky renders orange-brown. It is refused at compile time; ${SKY_TINT_POLICY}` });
      }
    }
    if (node.type === "PrincipledMaterial" && props.has("normalMap")) {
      // The host geometry is the material's `target` reference when it has one: a material declared
      // beside the geometry lands under Scene in the IR, while an inline material is a real child.
      const host = types.get(props.has("target") ? props.get("target") : node.parent);
      if (!TANGENT_CAPABLE_TYPES.has(host)) {
        problems.push({ code: "material_requires_tangent", node: node.id, type: node.type, property: "normalMap",
          message: `PrincipledMaterial '${node.id}': ${TANGENT_POLICY} (host geometry '${host ?? "unknown"}')` });
      }
    }
    if (node.type === "PrincipledMaterial" && props.has("emissiveColor")) {
      // The runtime and the native facade both cap emissive components at 0..16.  Catching it here means
      // the author learns at compile time instead of watching the material creation throw at page load.
      const value = props.get("emissiveColor");
      const components = Array.isArray(value) ? value
        : (value && typeof value === "object" ? [value.x, value.y, value.z] : null);
      const bad = components === null || components.length !== 3
        || components.some((component) => !Number.isFinite(component)
          || component < 0 || component > EMISSIVE_COMPONENT_MAX);
      if (bad) {
        problems.push({ code: "value_out_of_range", node: node.id, type: node.type, property: "emissiveColor",
          message: `PrincipledMaterial '${node.id}': emissiveColor is [r, g, b] with each component in 0..${EMISSIVE_COMPONENT_MAX} (it multiplies emissiveMap; 1 is the map as authored and higher values push a surface past the bloom threshold)` });
      }
    }
    if (node.type === "DirectionalLight" && props.get("atmosphereSunLight") !== true) {
      for (const member of ["sunAzimuth", "sunElevation"]) {
        if (props.has(member)) {
          problems.push({ code: "runtime_unsupported", node: node.id, type: node.type, property: member,
            message: `${node.type} '${node.id}': ${member} requires atmosphereSunLight: true` });
        }
      }
    }
  }
  return problems;
}
