// Runtime capability facts the catalog alone cannot express. The catalog says what the compiler
// accepts; the engine decides what it can actually write. Everything here was verified against the
// native EnvironmentFacade (ssdl_environment_bindings.cpp) and the SSDL browser runtime.

// DirectionalLight with atmosphereSunLight: true adopts the engine's scene sun (LiSun), which only
// exposes the LiLight base properties. The owned-light-only members fail at runtime with
// "ue_member_unsupported: DirectionalLight.<member> is not writable in this runtime".
const SUN_ONLY_UNSUPPORTED = ["lightSourceAngle", "lightSourceSoftAngle", "cloudScatteredLuminanceScale"];

export const CONVENTIONS = Object.freeze({
  coordinate_system: "right-handed, Z-up; x east, y north, z up, metres; local origin is the project anchor",
  quaternion_order: "[x, y, z, w] (w last); identity is [0, 0, 0, 1]",
  euler_free_rotation: "prefer RotationAnimation / Vector3dAnimation for animated turns; static rotation is a quaternion",
  camera: "CameraView.position/lookAt are local metres in the same frame as node positions; heading 0 = north, clockwise; pitch negative = looking down; fov is vertical degrees",
  ids: "every node in a component file needs a unique explicit id; anonymous siblings collide inside custom components",
});

/** Member-level notes merged into ssworld_catalog output. */
export function memberNotes(component, member) {
  if (component === "DirectionalLight" && SUN_ONLY_UNSUPPORTED.includes(member)) {
    return { runtime_writable: "only when atmosphereSunLight is not true (owned light); the adopted scene sun rejects it" };
  }
  if (component === "DirectionalLight" && ["sunAzimuth", "sunElevation"].includes(member)) {
    return { runtime_writable: "only when atmosphereSunLight: true" };
  }
  if (component === "CameraView") {
    const notes = {
      position: "camera position in local metres relative to the anchor (x east, y north, z up); mutually exclusive with longitude/latitude/height",
      lookAt: "aim point in local metres; derives heading/pitch unless they are set explicitly",
      fov: "vertical field of view in degrees, 1..170 (engine default 65)",
      nearPlane: "near clip distance in metres (> 0)",
      farPlane: "far clip distance in metres (> nearPlane)",
      longitude: "WGS84 degrees; use position instead when composing a local scene",
      heading: "degrees, 0 = north, clockwise",
      pitch: "degrees, -90 = straight down, 0 = horizon",
    };
    return notes[member] ? { note: notes[member] } : null;
  }
  if (member === "rotation") return { note: `quaternion ${CONVENTIONS.quaternion_order}` };
  return null;
}

/** Post-compile check of the scene IR for combinations the compiler accepts but the engine rejects. */
export function checkRuntimeSupport(sceneIR) {
  const problems = [];
  for (const node of sceneIR?.nodes || []) {
    const props = new Map((node.properties || []).map((item) => [item.property, item.value]));
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
