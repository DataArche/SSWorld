// Runtime capability facts the catalog alone cannot express. The catalog says what the compiler
// accepts; the engine decides what it can actually write. Everything here was verified against the
// native EnvironmentFacade (ssdl_environment_bindings.cpp), lirendersystem.cpp and the SSDL browser runtime.

/** Bumped whenever the notes below change meaning, so catalog_digest moves with them. */
export const NOTES_VERSION = 26;

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
export const UNAVAILABLE_ALTERNATIVES = Object.freeze({});

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
// Plane joined the list when the native generator started authoring a constant (+X) tangent frame
// for its grid: it is the usual host for both a normal map and a water surface, and both fail
// silently without one (the frame collapses to the geometric normal).
export const TANGENT_CAPABLE_TYPES = new Set(["Plane", "HeightField", "Lathe", "Tube", "Loft"]);
// All three kinds carry baseColor/opacity/uvScale; only the lit one carries the PBR members and
// managed texture slots, and only the water one carries the WaterParameters block.
export const MATERIAL_TYPES = new Set(["PrincipledMaterial", "UnlitMaterial", "WaterMaterial"]);
export const TANGENT_POLICY = "a tangent-space geometry is required: only Plane/HeightField/Lathe/Tube/Loft carry analytic tangents, so this combination would render without tangent space and is refused at compile time";

// WaterMaterial's members are the fields of one uniform block, and the runtime and the native facade
// both range-check them.  Catching them here means the author learns at compile time rather than
// watching the material creation throw at page load.
export const WATER_MEMBER_RANGES = Object.freeze({
  depthFadeDistance: Object.freeze({ minimum: 0.001, maximum: 1e9, text: "> 0 metres (default 150)" }),
  opacity: Object.freeze({ minimum: 0, maximum: 1, text: "in 0..1 (default 0.7)" }),
  metalness: Object.freeze({ minimum: 0, maximum: 1, text: "in 0..1 (default 0)" }),
  roughness: Object.freeze({ minimum: 0, maximum: 1, text: "in 0..1 (default 0)" }),
  specular: Object.freeze({ minimum: 0, maximum: 1, text: "in 0..1 (default 1, UE Specular)" }),
  waveIntensity: Object.freeze({ minimum: 0, maximum: 4, text: "in 0..4 (default 0.103333; 0 is a flat mirror)" }),
  flowSpeed: Object.freeze({ minimum: 0, maximum: 1e6, text: ">= 0 (default 1; 0 freezes the surface)" }),
});
export const WATER_POLICY = "WaterMaterial is the third shading lane: it always renders translucent and two-sided, its colour comes only from baseColor/deepColor (the standard material colour is not sampled on this lane), the shallow-to-deep fade reads the scene depth texture so there must be geometry UNDER the water for deepColor to appear at all, and the surface animates with the clock - two screenshots of the same water differ unless flowSpeed is 0";

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

// VolumetricCloud's distances are KILOMETRES, exactly as in UE: the UE docs say "kilometers above the
// ground" / "(kilometers)" for these members, and the engine agrees -- skyatmospherecommondata.cpp
// defines CmToSkyUnit = 0.00001f ("Centimeters to Kilometers") and skyatmosphererendercommon.cpp:1107
// multiplies each of them by KilometersToCentimeters. The catalog can only say "scalar", because the
// frozen compiler profile has no km divisor (compiler.mjs:340 rejects an unknown unit outright), so the
// unit lives in these notes and in a compile-time guard.
//
// Writing metres does not merely misplace the layer, it SHREDS the sky. Sample count does not follow the
// tracing distance (skyatmosphererendercommon.cpp:1110-1116): SampleCountMax = clamp(96 * viewSampleCountScale,
// 2, 768) and the distance ramp is a fixed 4 km CVar. So the metre author walks into a two-step trap --
// layerBottomAltitude: 1500 puts the deck at 1500 km, the default 60 km trace cannot reach it, nothing
// renders, and the fix they reach for is to enlarge tracingMaxDistance (in metres again). The ray then
// runs tens of thousands of kilometres on the same ~288 samples, each step is hundreds of kilometres, and
// the cloud density noise aliases along the ray into the vertical white streaks users keep reporting.
//
// Engine defaults are LiVolumetricCloud's (livolumetriccloud_p.h); UE's are the UE mirror constructor in
// volumetriccloudcomponent.cpp:5-19. They differ on purpose: this engine ships a low thin deck.
// The ceilings below are where the value stops being physically meaningful, not where testing stopped.
// `positive: true` means zero is refused too -- a deck of zero thickness, or a ray that marches zero
// kilometres, is not a scene the author meant to write.
export const CLOUD_KM_MEMBERS = Object.freeze({
  layerBottomAltitude: { max: 20, positive: false, engine: 1.8, ue: 5, what: "altitude of the cloud deck's base above the ground" },
  layerHeight: { max: 30, positive: true, engine: 0.507, ue: 10, what: "thickness of the deck, measured up from layerBottomAltitude" },
  tracingStartMaxDistance: { max: 2000, positive: true, engine: 80, ue: 350, what: "how far away the deck may be and still be traced at all" },
  tracingMaxDistance: { max: 500, positive: true, engine: 60, ue: 50, what: "how far a ray keeps marching once it is inside the deck" },
  shadowTracingDistance: { max: 100, positive: true, engine: 0.5, ue: 0.5, what: "ray-marched cloud shadow distance" },
});
export const CLOUD_UNIT_POLICY = "VolumetricCloud distances are KILOMETRES (the UE unit for this component), not the metres the rest of SSDL uses: a cloud deck is layerBottomAltitude: 1.8; layerHeight: 0.5, never 1800/500. Metre-scale values are refused at compile time (cloud_kilometres_expected) because they do not simply misplace the deck - the sample count is fixed, so a ray stretched a thousandfold aliases the cloud noise into vertical white streaks across the sky";

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

// Two coordinate worlds. Every ordinary SSDL node lives in local metres around the project anchor;
// Globe / ImageryLayer / Tileset / GeoJsonLayer live on the ellipsoid in longitude/latitude. Nothing
// bridges them: a geographic layer has no position, no parent and no rotation, and the compiler refuses
// one anywhere but directly under Scene.
export const GEO_WORLD_POLICY = "Globe / ImageryLayer / Tileset / GeoJsonLayer live in the GEOGRAPHIC world (longitude/latitude on the ellipsoid), not in the anchor's local metres, so they are declared directly under Scene with no position, parent or rotation, and no animation can target them (ordinary bindings on their live members do work). Local nodes and geographic layers share one picture because the project anchor puts the local origin on the globe; to look at both, aim a CameraView with longitude/latitude/height rather than position/lookAt.";

// Turning terrain on moves the GROUND, not the anchor: local z = 0 stays at the anchor's ellipsoid
// height, so a scene built flat can end up buried in a hillside or floating over a valley. geo_read
// reports the exact difference, which is the only way to see it without a screenshot.
export const GEO_TERRAIN_POLICY = "Globe { terrain: \"https://...\" } changes where the ground is but NOT where local z = 0 is: the scene stays at the anchor's ellipsoid height. Call ssworld_geo_read and read anchor_above_terrain_m - a positive value means the whole scene floats that many metres over the terrain, a negative one means it is buried - then correct the project anchor height (showcase.manifest.json) rather than moving every node.";

export const GEO_IMAGERY_POLICY = "imagery draws in DECLARATION order (the first ImageryLayer is the base map, later ones stack on top); there is no zIndex, so reordering means reordering the nodes. An xyz layer's source must carry {x} {y} {z}; kind: \"wms\" / \"arcgis\" take the service URL and ignore the tiling members. With a basemap on, Globe { lighting: false } is usually what you want: the sun otherwise tints the imagery. This server ships no third-party tile service - the URL, its terms and its key are the author's.";

export const GEO_TILESET_POLICY = "Tileset offset/rotation/scale is a LOCAL transform of the tileset's own root, not a placement in the scene's metres: offset.z is the height correction most datasets need. This engine has no maximumScreenSpaceError; geometricErrorScale (0.2..12, default 1) is the LOD dial and lower means finer. maximumMemory is MiB of tile cache (engine default 512). A tileset that never loads is reported as tileset_not_ready in ssworld_geo_read and leaves the rest of the scene running.";

export const GEO_GEOJSON_POLICY = "GeoJsonLayer draws ONE kind of feature: geometry: \"polygon\" / \"line\" / \"point\", chosen at compile time. Every style member is create_only (the native layer reads them once, before it builds), so only visible can be bound. The document comes either from a managed assets/*.geojson file (source) or from a remote URL (url) that the PAGE fetches - a cross-origin server without Access-Control-Allow-Origin fails as geojson_fetch_failed instead of leaving a silently empty layer. altitudeMode on_terrain drapes over terrain, absolute uses altitude metres above the ellipsoid.";

// LiEnvironment (src/components/lienvironment.h) solves the real sun/moon geometry from its clock
// with CelestialGeometry: Simon1994 ephemerides, an IAU2006 ICRF->fixed matrix, station azimuth and
// elevation. Every scene already carries one in Baked mode; declaring Environment adopts it and
// switches it to Dynamic, and that is what makes the clock, the moon and the stars live.
export const ENVIRONMENT_POLICY = "Environment is the scene clock and the astronomy solver: give it dateTime (ISO-8601 WITH an offset) and a site (latitude/longitude, or omit both to follow the camera's ground point) and it puts the sun, the moon and the star field where they really were at that instant. timeScale is simulated seconds per real second, so timeScale: 3600 runs an hour a second and timeScale: 0 freezes the sky. It is scene-global: no parent, one per scene. It OWNS the sun direction while it is declared, so it cannot coexist with DirectionalLight { sunAzimuth } or SunSky (multiple_writer); to pin the sun without giving up the clock use sunAzimuthOverride / sunElevationOverride on Environment itself. Stars fade out on their own as the sun rises (fully out above 0 deg elevation, fully in below -12 deg), so starsIntensity is a ceiling, not a switch. fogGetsColorFromAtmosphere (default true) makes the height fog take its inscattering colour from the atmosphere, so the fog reddens at sunset and goes dark after it instead of staying the daytime blue authored on ExponentialHeightFog; set it false to keep the authored colour at every hour. cloudCoverage follows the Ultra Dynamic Sky scale (0..3, 1.14 is the factory setting): it thickens the volumetric cloud layer and, with it, the height fog density (fogDensityClear -> fogDensityCloudy, the same curve UDS uses). windDirection (0 = north, clockwise) and windSpeed drift the clouds. All three are opt-in: leave them out and the clouds and the fog stay exactly as authored on VolumetricCloud / ExponentialHeightFog, which is what you want when those values came out of Unreal. sunIntensity defaults to 4.65, the Ultra Dynamic Sky Sun.SunLightIntensity, and it is an ABSOLUTE level: nothing downstream renormalises it, so halving it halves the frame. Leave it alone unless you are matching an Unreal project value by value -- at 1.0 the sky falls into the tonemapper's toe and reads as near black while the clouds still look lit. It also drives the sky light: the ambient capture is forced on and kept running for as long as the Environment is declared, so the ambient light and the sky reflected in water and metal follow the clock instead of holding one instant (SkyLight.realTimeCapture: false is refused while it is declared, sky_light_capture_owned). It also carries the two UDS curves: the sun fades out between 0 and -8.6 deg of elevation, and while fogGetsColorFromAtmosphere is true a closing sky dims the direct sun as well (coverage 1.2 -> 2.3 scales it 1.0 -> 0.1), which is what makes an overcast scene flat rather than merely cloudy.";

export const CLOUD_MATERIAL_POLICY = "VolumetricCloud carries two kinds of members. The sampling ones (layerBottomAltitude, layerHeight, tracing*, *SampleCountScale) shape the ray march. The rest are the cloud MATERIAL, and each one is named after its UE / Ultra Dynamic Sky input -- MinimumErosion, HightFrequencyNoiseAmount (the UE spelling), ZDisturbance, ExtinctionScaleTop/Bottom, CloudsPosition as noisePosition, and PhaseG / PhaseG2 / PhaseBlend / MultiScattering* from the UE VolumetricAdvancedMaterialOutput node -- so a cloud look tuned in Unreal can be transferred value by value. The defaults are the Ultra Dynamic Sky factory look. For a coverage knob rather than raw values use Environment.cloudCoverage, which writes swirlAmount and swirlBias; write those two directly when you are matching Unreal exactly.";

// LiSkyLight feeds two different things: the diffuse ambient (a 3-band SH set recomputed on the GPU
// from a captured sky cubemap) and, since the capture cubemap is now published as the sky reflection
// map, the sky seen in water and metal. Both are only as fresh as the capture, and the capture only
// runs while realTimeCapture is on - which is why a scene with a moving sun but a frozen sky light
// reads as "the sun moved and nothing else did". The engine default is now on, so that reading is
// something an author has to ask for with realTimeCapture: false rather than something they inherit.
export const SKY_LIGHT_POLICY = "SkyLight is the ambient half of the sky: the engine captures the sky into a cubemap, convolves it into a 3-band SH set for the diffuse ambient, and uses the same cubemap as the sky reflection seen in water and metal. That capture only runs while realTimeCapture is on; with it off the ambient and the reflections hold whatever they were captured with while the sun keeps moving. Declaring Environment turns the capture on and keeps it on - the sky light is part of what the clock drives - so realTimeCapture: false is refused there (sky_light_capture_owned), while realTimeCapture: true stays writable and is simply redundant; drop the Environment if you really want a frozen ambient. It defaults to ON in the engine, so a plain SkyLight already tracks a moving sun without anyone writing the member; realTimeCapture: false is how an author deliberately freezes the ambient, which is exactly the write an Environment refuses. The capture is time-sliced over five frames (sky faces, clouds, two passes of GGX pre-convolution for the reflection mips, then the diffuse SH), so ambient and sky reflections trail a sudden sky change by about five frames; any change the scene makes through Environment restarts the slice so the cubemap is never half old and half new.";

export const SUN_SKY_POLICY = "SunSky is the UE 4.27 spelling of one fixed instant: month/day/solarTime in the project's calendar year (UE SunSky carries no Year) plus timeZone, northOffset and the optional daylight-saving window. It lowers onto the same solver Environment uses and pins the clock (timeScale 0), so use Environment instead when you want time to run. Its directionalLight / skyLight / skyAtmosphere groups configure those scene slots directly; directionalLight.rotation is refused because SunSky owns the sun direction.";

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
  // Only .geojson is discovered as vector data. A bare .json under assets/ is far more often a data
  // file the page reads than a feature collection, and misclassifying it would make every project with
  // one fail its geojson content check.
  ".geojson": { kind: "geojson", media_type: "application/geo+json" },
});
// Runtime caps (ssdl-builtins managedAssetRef): a Model glb up to 32 MiB, a Texture image up to 8 MiB;
// the source project schema takes at most 64 asset references.
// Matches MAX_EMISSIVE_COMPONENT in the runtime and kMaterialMaxEmissiveComponent in the native facade.
export const EMISSIVE_COMPONENT_MAX = 16;
export const ASSET_LIMITS = Object.freeze({ model: 32 * 1024 * 1024, texture: 8 * 1024 * 1024, geojson: 8 * 1024 * 1024, count: 64 });
export const BINDING_POLICY = "bindings and handler assignments apply as one transaction per event/frame: if ANY bound value is refused by its target (out of range such as a negative width, wrong type, a native refusal) the whole batch rolls back, that binding turns invalid and the affected values stop changing with no exception; ssworld_capture_frame / ssworld_logic_read report it as runtime.errors kind binding_error (mapped to scene.ssdl:line) and logic.bindings.invalid; write piecewise motion with clamp/lerp/min/max over a progress property instead of branchy ?: chains, and keep every branch inside the target's valid range";
export const ASSET_POLICY = `put glb models, png/jpg textures and .geojson feature collections under the project's ${ASSETS_DIR}/ directory and reference them by project-relative path (Model { source: "${ASSETS_DIR}/name.glb" }, GeoJsonLayer { source: "${ASSETS_DIR}/parks.geojson" }); each glb is at most ${ASSET_LIMITS.model / 1048576} MiB, each texture and each geojson ${ASSET_LIMITS.texture / 1048576} MiB, at most ${ASSET_LIMITS.count} assets per project (asset_budget beyond); a Model needs no material of its own, and only its position/rotation/scale/visible can animate`;

export const CONVENTIONS = Object.freeze({
  coordinate_system: "right-handed, Z-up; x east, y north, z up, metres; local origin is the project anchor",
  quaternion_order: "[x, y, z, w] (w last); identity is [0, 0, 0, 1]; only geometry/Model/Group rotation is a quaternion",
  environment_rotation: "DirectionalLight/SkyAtmosphere/fog/cloud `rotation` is Euler degrees [x, y, z] (UE convention), not a quaternion; prefer sunAzimuth/sunElevation for the sun",
  euler_free_rotation: "prefer RotationAnimation / Vector3dAnimation for animated turns; static geometry rotation is a quaternion",
  camera: "CameraView.position/lookAt are local metres in the same frame as node positions; heading 0 = north, clockwise; pitch negative = looking down; fov is the HORIZONTAL field of view in degrees",
  clip_planes: CLIP_PLANE_POLICY,
  field_of_view: FOV_POLICY,
  labels: LABEL_POLICY,
  procedural_geometry: "parametric generators (HeightField width/depth/columns/rows plus heights at the (columns+1)*(rows+1) grid corners - not columns*rows - row-major from -depth/2; Lathe profile [radius, 0, height] revolved around Z with segments and optional closed caps; Tube path + radius + segments with a parallel-transport frame; Loft same-count ccw rings stacked bottom to top with optional cap) are compile-time constants: the IR stores parameters, the runtime builds a MeshData/v1 mesh (ccw outward, at most 65535 vertices per node, compile error mesh_budget beyond that); generated vertices carry normalized UVs: u spans the HeightField width or each Lathe/Tube/Loft ring, v spans the HeightField depth or the profile/path/section order, and both axes run from 0 to 1; per-vertex functions and author JavaScript are not accepted; arbitrary meshes go through managed assets (Model)",
  textures: "PrincipledMaterial supports baseColorMap, metallicRoughnessMap, normalMap and emissiveMap, each referring to a Texture; texture mapping requires UVs on the target geometry. Prepare a metallicRoughnessMap in linear space: G is roughness and B is metalness, and both channels multiply the material's roughness/metalness scalar values. normalMap is tangent-space and only the Plane/HeightField/Lathe/Tube/Loft generators carry analytic tangents, so a normal map on any other geometry is refused at compile time with material_requires_tangent; normalScale (0..2, default 1) scales its strength. Put Texture image resources at assets/*.png or assets/*.jpg, each no larger than 8 MiB. The runtime shares identical image content by content digest, so one image used by many objects or texture slots occupies one texture; reuse a path where it makes the scene easier to read. The compiler reports resolved image file bytes only and never estimates decoded memory; the runtime facade is authoritative for decoded texture accounting. uvScale is [u, v] and applies UV × uvScale; smaller values increase repeat density, while the exact rendered tiling direction still needs hardware verification. emissiveMap is sRGB colour data and, like baseColorMap, needs only UVs — never tangents — so it works on any primitive; the base pass multiplies it by emissiveColor ([r, g, b], 0..16, default 1 meaning the map as authored), and values above 1 are how a neon surface crosses the bloom threshold. emissiveColor without an emissiveMap is a flat self-lit colour",
  shading_lanes: "three material kinds, and the choice is about lighting, not about looks. PrincipledMaterial is the lit PBR lane: baseColor is relit by sun, sky and shadows, so an author-picked hex never renders as that hex. UnlitMaterial (baseColor, opacity, baseColorMap, uvScale, emissiveColor) writes its colour straight to the frame with no lighting, shadow or reflection term - the right lane for markers, legends, holograms, signage, flat-shaded blocking and anything whose colour is data rather than material. It is still tone mapped and post processed, so it is not a pixel-exact UI colour, and it carries no metalness/roughness/normalMap/normalScale/metallicRoughnessMap/emissiveMap (they are refused at compile time rather than accepted and ignored). baseColor alone cannot exceed 1, so cross the bloom threshold with emissiveColor ([r, g, b], 0..16) added on top; opacity below 1 keeps the unlit path through the translucent pass. WaterMaterial is the third lane, a prebuilt water surface rather than a general material: baseColor is the shallow colour, deepColor the colour reached after depthFadeDistance metres of water (default 150), and because that fade reads the scene depth texture there must be geometry UNDER the water surface or deepColor never appears. waveIntensity (0..4, default 0.103333, 0 = flat mirror) and flowDirection/flowSpeed drive a built-in scrolling normal map - there is no texture slot to fill and no normalMap member. It needs analytic tangents, so the host must be Plane/HeightField/Lathe/Tube/Loft; it is always translucent and two-sided whatever opacity says; and it animates with the clock, so freeze flowSpeed at 0 before comparing screenshots. A target carries one material of any one kind",
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
  geography: GEO_WORLD_POLICY,
  terrain: GEO_TERRAIN_POLICY,
  units_tag: "a descriptor's `unit` is the compiler's wire tag ('scalar' means untagged), not always the physical unit; the member note names the physical unit where they differ",
});

/**
 * columns/rows count cells but heights counts corners, and every author who writes columns * rows
 * values loses a whole compile to it. Say the arithmetic in the member note, not only in the error.
 */
const HEIGHTFIELD_GRID_POLICY = Object.freeze({
  columns: "number of cells along width (X), not the number of height samples; a columns: 2 field has 3 columns of corners",
  rows: "number of cells along depth (Y), not the number of height samples; a rows: 2 field has 3 rows of corners",
  heights: "metres at the grid CORNERS, so exactly (columns+1)*(rows+1) values, not columns*rows: columns: 2; rows: 2 needs 9. Row-major, first row at -depth/2 (south) and first value at -width/2 (west), all on one line",
});

/**
 * The engine raycasts tracked nodes and a glb is one tracked node, so a pick anywhere inside a Model
 * reports the Model's own handle -- never a leaf. Measured: 329 picks over a 563-node scene all
 * resolved to a declared node, and a real click on a car glb fired its nested TapHandler.
 */
const MODEL_PICK_POLICY = "a whole glb is ONE pick target: a TapHandler/HoverHandler nested in the Model fires for a tap anywhere on it, but the objects inside the glb have no handles and cannot be addressed individually. For part-level interaction put an opacity: 0 proxy (still picked; visible: false leaves picking) over the part, or split the glb into one Model per part. Per-part appearance is limited to baseColorTexture + materialSlot (material_0..material_99, create-only). There is also a page-JS escape hatch outside SSDL: the loader names every glTF node on its entity, LiEntity.travalHierarchy reaches them from index.html, and SceneGraphFacade.adoptEntity('external:<your name>', entity) publishes one as a real node that pick/setTransform/setVisible/reparent accept - but an adopted part TAKES OVER pick attribution, so a TapHandler nested on that Model stops firing over it, and a glTF node folded into GPU instancing has no entity to adopt (see the skill for the recipe and limits)";

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
  if (component === "SkyLight" && member === "realTimeCapture") {
    return { runtime_writable: "yes; false is refused while an Environment is declared (sky_light_capture_owned)",
      note: `engine default on; while on, the sky is re-captured every five frames and drives both the diffuse ambient and the sky reflected in water and metal, so writing true is redundant on a current engine and only false changes anything. ${SKY_LIGHT_POLICY}` };
  }
  if (/Light$/.test(component) && (member === "useTemperature" || member === "temperature")) {
    return { note: LIGHT_TEMPERATURE_POLICY };
  }
  if (member === "intensity" && /Light$/.test(component)) {
    return { note: "dimensionless multiplier on the light's radiance; engine default 1.0; not lux/candela (see intensityUnits where present)" };
  }
  if (component === "VolumetricCloud") {
    const km = CLOUD_KM_MEMBERS[member];
    if (km) {
      return { note: `KILOMETRES - ${km.what}; engine default ${km.engine} km (UE default ${km.ue} km), accepted ${km.positive ? "> 0" : ">= 0"} up to ${km.max}. ${CLOUD_UNIT_POLICY}` };
    }
    if (member === "skyLightCloudBottomOcclusion") {
      return { note: "0..1, how much the deck occludes sky light at its base (the engine computes visibility = 1 - this); engine default 0, UE default 0.5. A scalar, not a switch: 1 is full occlusion" };
    }
    if (member.endsWith("SampleCountScale")) {
      return { note: `multiplier on the ray-march sample count; engine default ${{ viewSampleCountScale: 3, reflectionSampleCountScale: 7.5, shadowViewSampleCountScale: 0.5, shadowReflectionSampleCountScale: 0.75 }[member]}. The count is clamped to 768 and does NOT grow with tracingMaxDistance, so lowering this is the fastest way to make the clouds streaky` };
    }
    if (member === "stopTracingTransmittanceThreshold") {
      return { note: "0..1; the march stops once mean transmittance falls below it. Engine default 0.005; raising it trades cloud depth for speed" };
    }
    if (member === "usePerSampleAtmosphericLightTransmittance") {
      return { note: "per-sample atmospheric transmittance instead of one value per ray; engine default false. Costs fill rate, matters most for a low sun" };
    }
    return null;
  }
  if (component === "HeightField" && ["columns", "rows", "heights"].includes(member)) {
    return { note: HEIGHTFIELD_GRID_POLICY[member] };
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
  if (GEO_MEMBER_NOTES[component]?.[member]) return { note: GEO_MEMBER_NOTES[component][member] };
  if (member === "rotation") {
    return descriptor.value_type === "quaternion"
      ? { note: `quaternion ${CONVENTIONS.quaternion_order.split(";")[0]}` }
      : { note: "Euler degrees [x, y, z] (UE component convention); not a quaternion" };
  }
  return null;
}

/** Per-scene ceilings mirrored from compiler/src/geo-0.3.mjs; a contract test keeps the two in step. */
export const GEO_LAYER_BUDGETS = Object.freeze({ Globe: 1, ImageryLayer: 8, Tileset: 4, GeoJsonLayer: 8 });

const GEO_MEMBER_NOTES = Object.freeze({
  Globe: {
    terrain: "\"default\" (the engine's own terrain) or an http(s) terrain-tile directory URL; create_only. Turning it on does not move local z = 0 - read anchor_above_terrain_m from ssworld_geo_read",
    lighting: "the sun shades the globe surface; turn it off when an ImageryLayer supplies the basemap, or the imagery is tinted by the time of day",
    opacity: "0..1 over the whole globe surface, imagery included",
  },
  ImageryLayer: {
    kind: "xyz (a {z}/{x}/{y} tile template, the default) / wms / arcgis / single (one image over a rectangle); create_only",
    source: "for kind xyz a tile template containing {x} {y} {z}; for wms/arcgis the service URL; for single the image URL. This server ships no tile service: the URL, its terms of use and any key are the author's",
    rectangle: "[west, south, east, north] in DEGREES (not the anchor's metres); defaults to the whole globe and is required for kind: \"single\"",
    minimumLevel: "whole tile level 0..30; only for kind: \"xyz\"",
    maximumLevel: "whole tile level 0..30, default 18; only for kind: \"xyz\"",
    alpha: "0..1; bindable, so a declared property can cross-fade two basemaps",
    hue: "additive hue shift, engine default 0 (the other four adjustments are multipliers with default 1)",
  },
  Tileset: {
    source: "URL of the tileset.json root; create_only",
    offset: "metres in the TILESET's own root frame (z is the usual height correction), not a position in the scene",
    rotation: "Euler degrees [x, y, z] of the tileset's own root frame; not a quaternion",
    scale: "uniform scale of the tileset root, > 0",
    geometricErrorScale: "0.2..12, default 1; this engine has no maximumScreenSpaceError, so this is the LOD dial and lower loads finer tiles",
    maximumMemory: "tile cache in MiB, engine default 512",
    splat: "true loads a 3D Gaussian splat tileset instead of 3D Tiles; create_only",
  },
  GeoJsonLayer: {
    source: "a managed assets/*.geojson file; mutually exclusive with url",
    url: "a remote GeoJSON document the PAGE fetches (the engine never fetches it), so a cross-origin server must send Access-Control-Allow-Origin; mutually exclusive with source",
    geometry: "polygon / line / point - one layer draws one kind of feature; create_only",
    extrudeHeightField: "name of a feature property to raise polygons by; polygon only - with it the polygons become solid blocks (native entityType SINGLEBUILDING), without it a flat filled plane (PLANE); the native default LINE, which draws outlines and no fill, is never used",
    opacity: "0..1; fill alpha for polygons, line alpha for lines",
    altitude: "metres, combined with altitudeMode",
    altitudeMode: "absolute (metres above the ellipsoid) / on_terrain (draped, the default) / relative_to_terrain",
    depthTest: "false lets a draped layer show through geometry in front of it",
  },
});

/** Component-level notes merged into ssworld_catalog output. */
export function componentNotes(name) {
  if (name === "DirectionalLight") return { runtime_note: "atmosphereSunLight: true adopts the engine sun (drives the sky); only intensity/lightColor/castShadows/temperature/indirect/volumetric and sunAzimuth/sunElevation are writable on it. Leave it false for an owned light with full members." };
  if (name === "CameraView") return { runtime_note: `${CONVENTIONS.camera}. ${FOV_POLICY}. ${CLIP_PLANE_POLICY}` };
  if (name === "SkyAtmosphere") return { runtime_note: `the engine ships Earth defaults; the four scattering vectors and skyLuminanceFactor are refused at compile time because an evenly weighted value there turns the sky orange-brown (${SKY_TINT_POLICY}). The scalar members (multiScatteringFactor, the *Scale magnitudes, mieAnisotropy, the exponential distributions, heightFogContribution, aerial perspective) stay writable` };
  if (name === "VolumetricCloud") return { runtime_note: `${CLOUD_UNIT_POLICY}. Declare a SkyAtmosphere alongside it: with one, the cloud layer takes the atmosphere's planet centre and radius; without one it falls back to a hardcoded centre at (0, 0, -6378.137 km), which assumes a Z-up world with the ground at z = 0 (skyatmosphererendercommon.cpp:1090-1098). ${CLOUD_MATERIAL_POLICY}` };
  if (name === "SkyLight") return { runtime_note: SKY_LIGHT_POLICY };
  if (name === "Environment") return { runtime_note: ENVIRONMENT_POLICY };
  if (name === "SunSky") return { runtime_note: SUN_SKY_POLICY };
  if (name === "Label") return { runtime_note: LABEL_POLICY, runtime_supported: false };
  if (name === "Globe") return { runtime_note: `${GEO_WORLD_POLICY} ${GEO_TERRAIN_POLICY} At most one Globe per scene (globe_duplicate); without one the engine's own defaults are in force and the sphere carries no imagery.` };
  if (name === "ImageryLayer") return { runtime_note: `${GEO_WORLD_POLICY} ${GEO_IMAGERY_POLICY} At most ${GEO_LAYER_BUDGETS.ImageryLayer} per scene (geo_budget).` };
  if (name === "Tileset") return { runtime_note: `${GEO_WORLD_POLICY} ${GEO_TILESET_POLICY} At most ${GEO_LAYER_BUDGETS.Tileset} per scene (geo_budget).` };
  if (name === "GeoJsonLayer") return { runtime_note: `${GEO_WORLD_POLICY} ${GEO_GEOJSON_POLICY} At most ${GEO_LAYER_BUDGETS.GeoJsonLayer} per scene (geo_budget), each document at most ${ASSET_LIMITS.geojson / 1048576} MiB.` };
  if (name === "Model") return { runtime_note: `${ASSET_POLICY}; Model animates position/rotation/scale/visible only (animations, Behaviors and Bindings). ${MODEL_PICK_POLICY}` };
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
  // Environment solves the sun every frame; DirectionalLight.sunAzimuth and SunSky pin it. With both
  // in one scene the last writer of the frame wins and the author sees a sun that ignores half the
  // source, so the pair is refused here rather than at page load.
  const environments = (sceneIR?.nodes || []).filter((node) => node.type === "Environment");
  if (environments.length > 1) {
    const extra = environments[1];
    problems.push({ code: "environment_duplicate", node: extra.id, type: extra.type, property: null,
      message: `Environment '${extra.id}': Environment is a scene-global slot and '${environments[0].id}' already claims it (the native facade reports environment_slot_conflict); keep one` });
  }
  if (environments.length) {
    // Environment drives the sky light the same way it drives the sun: it forces the capture on and
    // keeps it running, so realTimeCapture: false there asks for something it will not get. Only the
    // false is refused - realTimeCapture: true stays writable because it is what an engine build that
    // predates the Environment-owns-the-capture change still needs to hear.
    for (const node of (sceneIR?.nodes || []).filter((item) => item.type === "SkyLight")) {
      if (!(node.properties || []).some((item) => item.property === "realTimeCapture" && item.value === false)) continue;
      problems.push({ code: "sky_light_capture_owned", node: node.id, type: node.type, property: "realTimeCapture",
        message: `SkyLight '${node.id}': Environment '${environments[0].id}' owns the sky light capture and keeps it running, so realTimeCapture: false is ignored there - the ambient and the sky reflected in water and metal follow the clock either way, and a scene that reads as "the sun moved and nothing else did" is this member, not the clock. Remove it, or drop the Environment if you really want a frozen ambient` });
    }
    for (const node of sceneIR?.nodes || []) {
      const props = new Map((node.properties || []).map((item) => [item.property, item.value]));
      const member = node.type === "DirectionalLight"
        ? ["sunAzimuth", "sunElevation"].find((name) => props.has(name))
        : (node.type === "SunSky" ? "solarTime" : undefined);
      if (!member) continue;
      problems.push({ code: "multiple_writer", node: node.id, type: node.type,
        property: node.type === "SunSky" ? null : member,
        message: `${node.type} '${node.id}': Environment '${environments[0].id}' owns the sun direction, so ${node.type === "SunSky" ? "SunSky cannot also solve it" : `${node.type}.${member} cannot also set it`}; use Environment.sunAzimuthOverride / sunElevationOverride to pin the sun, or drop the Environment` });
    }
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
    // Two members need a tangent basis, for the same reason and with the same silent failure:
    // normalMap becomes a no-op and water becomes a flat mirror, both of which render.
    const tangentMember = node.type === "PrincipledMaterial" && props.has("normalMap") ? "normalMap"
      : node.type === "WaterMaterial" ? "waveIntensity" : null;
    if (tangentMember) {
      // The host geometry is the material's `target` reference when it has one: a material declared
      // beside the geometry lands under Scene in the IR, while an inline material is a real child.
      const host = types.get(props.has("target") ? props.get("target") : node.parent);
      if (!TANGENT_CAPABLE_TYPES.has(host)) {
        problems.push({ code: "material_requires_tangent", node: node.id, type: node.type, property: tangentMember,
          message: `${node.type} '${node.id}': ${TANGENT_POLICY} (host geometry '${host ?? "unknown"}')` });
      }
    }
    if (node.type === "WaterMaterial") {
      for (const [member, range] of Object.entries(WATER_MEMBER_RANGES)) {
        if (!props.has(member)) continue;
        const value = props.get(member);
        if (Number.isFinite(value) && value >= range.minimum && value <= range.maximum) continue;
        problems.push({ code: "value_out_of_range", node: node.id, type: node.type, property: member,
          message: `WaterMaterial '${node.id}': ${member} must be ${range.text}` });
      }
    }
    if (MATERIAL_TYPES.has(node.type) && props.has("emissiveColor")) {
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
          message: `${node.type} '${node.id}': emissiveColor is [r, g, b] with each component in 0..${EMISSIVE_COMPONENT_MAX} (it multiplies emissiveMap; 1 is the map as authored and higher values push a surface past the bloom threshold)` });
      }
    }
    if (node.type === "VolumetricCloud") {
      for (const [member, km] of Object.entries(CLOUD_KM_MEMBERS)) {
        if (!props.has(member)) continue;
        const value = props.get(member);
        if (!Number.isFinite(value)) continue;
        if (value > km.max) {
          // The metre mistake is the whole reason this check exists, so say it in the first clause.
          problems.push({ code: "cloud_kilometres_expected", node: node.id, type: node.type, property: member,
            message: `VolumetricCloud '${node.id}': ${member} is in KILOMETRES and ${value} is ${(value / km.engine).toFixed(0)}x the engine default of ${km.engine} km - you have almost certainly written metres. ${km.what}; write ${(value / 1000)} for ${value} metres, or take the engine default ${km.engine} km (UE default ${km.ue} km). ${CLOUD_UNIT_POLICY}` });
        } else if (value < 0 || (km.positive && value === 0)) {
          problems.push({ code: "value_out_of_range", node: node.id, type: node.type, property: member,
            message: `VolumetricCloud '${node.id}': ${member} is ${km.what} in kilometres and must be ${km.positive ? "> 0" : ">= 0"} (engine default ${km.engine} km)` });
        }
      }
      if (props.has("skyLightCloudBottomOcclusion")) {
        const value = props.get("skyLightCloudBottomOcclusion");
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          problems.push({ code: "value_out_of_range", node: node.id, type: node.type, property: "skyLightCloudBottomOcclusion",
            message: `VolumetricCloud '${node.id}': skyLightCloudBottomOcclusion is a 0..1 scalar, not a switch - the engine renders sky-light visibility as 1 - this value (engine default 0, UE default 0.5)` });
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
