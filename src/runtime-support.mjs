// Runtime capability facts the catalog alone cannot express. The catalog says what the compiler
// accepts; the engine decides what it can actually write. Everything here was verified against the
// native EnvironmentFacade (ssdl_environment_bindings.cpp), lirendersystem.cpp and the SSDL browser runtime.

/** Bumped whenever the notes below change meaning, so catalog_digest moves with them. */
export const NOTES_VERSION = 4;

// DirectionalLight with atmosphereSunLight: true adopts the engine's scene sun (LiSun), which only
// exposes the LiLight base properties. The owned-light-only members fail at runtime with
// "ue_member_unsupported: DirectionalLight.<member> is not writable in this runtime".
const SUN_ONLY_UNSUPPORTED = ["lightSourceAngle", "lightSourceSoftAngle", "cloudScatteredLuminanceScale"];

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

export const CONVENTIONS = Object.freeze({
  coordinate_system: "right-handed, Z-up; x east, y north, z up, metres; local origin is the project anchor",
  quaternion_order: "[x, y, z, w] (w last); identity is [0, 0, 0, 1]; only geometry/Model/Group rotation is a quaternion",
  environment_rotation: "DirectionalLight/SkyAtmosphere/fog/cloud `rotation` is Euler degrees [x, y, z] (UE convention), not a quaternion; prefer sunAzimuth/sunElevation for the sun",
  euler_free_rotation: "prefer RotationAnimation / Vector3dAnimation for animated turns; static geometry rotation is a quaternion",
  camera: "CameraView.position/lookAt are local metres in the same frame as node positions; heading 0 = north, clockwise; pitch negative = looking down; fov is the HORIZONTAL field of view in degrees",
  clip_planes: CLIP_PLANE_POLICY,
  field_of_view: FOV_POLICY,
  labels: LABEL_POLICY,
  procedural_geometry: "parametric generators (HeightField width/depth/columns/rows/heights row-major from -depth/2; Lathe profile [radius, 0, height] revolved around Z with segments and optional closed caps; Tube path + radius + segments with a parallel-transport frame; Loft same-count ccw rings stacked bottom to top with optional cap) are compile-time constants: the IR stores parameters, the runtime builds a MeshData/v1 mesh (ccw outward, at most 65535 vertices per node, compile error mesh_budget beyond that); per-vertex functions and author JavaScript are not accepted; arbitrary meshes go through managed assets (Model)",
  logic: "declare scene state on the Scene root with `property real score: 0` (types real/bool/string/length/degrees/duration/radians); handlers assign with expressions (`score = score + 1`), bindings compare (`>= <= === !== < > && || ! ?:`); host JavaScript is reached only through `Iface.method(arg: expr)` actions declared in host_interfaces.json and implemented by logic.mjs; the page reads/writes declared properties through window.SSWorld.logical",
  ids: "every node in a component file needs a unique explicit id; anonymous siblings collide inside custom components",
  editing: "ssworld_source_patch edits one span by exact match; ssworld_source_batch applies several patches / node property sets atomically (optionally compiling and rolling back); ssworld_source_write replaces a file; writing the .ssdl files in the project directory with any other tool also works because ssworld_compile always rebuilds from disk, but such writes are not protected by the digest lock",
  units_tag: "a descriptor's `unit` is the compiler's wire tag ('scalar' means untagged), not always the physical unit; the member note names the physical unit where they differ",
});

/** Member-level notes merged into ssworld_catalog output. */
export function memberNotes(component, member, descriptor = {}) {
  if (component === "DirectionalLight" && SUN_ONLY_UNSUPPORTED.includes(member)) {
    return { runtime_writable: "only when atmosphereSunLight is not true (owned light); the adopted scene sun rejects it" };
  }
  if (component === "DirectionalLight" && ["sunAzimuth", "sunElevation"].includes(member)) {
    return { runtime_writable: "only when atmosphereSunLight: true", note: member === "sunAzimuth" ? "degrees, 0 = north, clockwise (local ENU at the anchor)" : "degrees above the horizon" };
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
  if (name === "Label") return { runtime_note: LABEL_POLICY, runtime_supported: false };
  if (name === "Group") return { runtime_note: "Group is a locator (transform parent), not a live SceneObject: animations and Behaviors cannot target it; animate its child geometry instead" };
  return {};
}

/** Post-compile check of the scene IR for combinations the compiler accepts but the engine rejects. */
export function checkRuntimeSupport(sceneIR) {
  const problems = [];
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
