// Geographic components (Globe / ImageryLayer / Tileset / GeoJsonLayer) live in a different coordinate
// world from every other SSDL node: floating-point longitude/latitude on an Earth-sized ellipsoid, not
// metres in the anchor's ENU frame.  The rules below are what keeps those two worlds from being mistaken
// for one another, plus the value ranges the engine itself refuses at mount rather than at compile time.
//
// Everything here runs on the compiled fields, so every diagnostic carries the node id and file:line.

export const GEO_COMPONENTS = Object.freeze(["Globe", "ImageryLayer", "Tileset", "GeoJsonLayer"]);

/** Per-scene ceilings. Each layer carries its own tile cache, so these are memory walls, not style. */
export const GEO_BUDGETS = Object.freeze({ Globe: 1, ImageryLayer: 8, Tileset: 4, GeoJsonLayer: 8 });

export const IMAGERY_KINDS = Object.freeze(["xyz", "wms", "arcgis", "single"]);
export const GEOJSON_GEOMETRIES = Object.freeze(["polygon", "line", "point"]);
export const ALTITUDE_MODES = Object.freeze(["absolute", "on_terrain", "relative_to_terrain"]);

/** `Globe.terrain: "default"` is the engine's own terrain, not a URL. */
export const TERRAIN_DEFAULT = "default";

const URL_RE = /^https?:\/\/[^\s]+$/i;
const XYZ_TOKENS = ["{x}", "{y}", "{z}"];

/** Members whose value only makes sense for one `ImageryLayer.kind`. */
const XYZ_ONLY = Object.freeze(["webMercator", "minimumLevel", "maximumLevel", "tileWidth", "tileHeight"]);

const integerIn = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

/**
 * @param entries  the compiler's raw node records: { child, fields, id, parent }
 * @param options  { rootId, catalog, fail, literalValue, containsReference }
 */
export function validateGeo(entries, { rootId, catalog, fail, literalValue, containsReference }) {
  // A constant member value, or undefined when the author bound it to an expression (a bound member is
  // checked by its own descriptor; the rules below only judge values that are fixed at compile time).
  const constantOf = (fields, name) => {
    const member = fields.get(name);
    if (!member || containsReference(member.value)) return undefined;
    return literalValue(member.value);
  };
  const at = (fields, name, node) => fields.get(name) || node;

  const counts = Object.fromEntries(GEO_COMPONENTS.map((name) => [name, 0]));

  for (const { child, fields, id, parent } of entries) {
    // URL shape is a descriptor property (`format`), so it is checked for every component that declares
    // it rather than only for the four below.
    for (const [name, descriptor] of Object.entries(catalog.components[child.type]?.members || {})) {
      if (!descriptor.format) continue;
      const value = constantOf(fields, name);
      if (value === undefined) continue;
      if (child.type === "Globe" && name === "terrain" && value === TERRAIN_DEFAULT) continue;
      if (typeof value !== "string" || !URL_RE.test(value)) {
        fail("geo_url_invalid", at(fields, name, child),
          `${child.type} '${id}': ${name} must be an http:// or https:// URL${child.type === "Globe" && name === "terrain" ? ` (or "${TERRAIN_DEFAULT}" for the engine's own terrain)` : ""}, got ${JSON.stringify(value)}`);
      }
      if (descriptor.format === "url_template" && XYZ_TOKENS.some((token) => !value.includes(token))) {
        fail("geo_url_template_missing_tokens", at(fields, name, child),
          `${child.type} '${id}': ${name} is a tile template and must contain ${XYZ_TOKENS.join(" ")}, e.g. https://example.com/tiles/{z}/{x}/{y}.png`);
      }
    }

    if (!GEO_COMPONENTS.includes(child.type)) continue;
    counts[child.type] += 1;

    // Two coordinate worlds: a geographic layer has no transform and no parent, so it may only sit
    // directly under Scene -- never inside a Group, a geometry node or a custom component.
    const inComponent = Boolean(child.instance_chain?.length)
      || [...fields.values()].some((member) => member.instance_chain?.length);
    if (parent !== rootId || inComponent) {
      fail("geo_hierarchy_invalid", child,
        `${child.type} '${id}' must be a direct child of Scene${inComponent ? " and cannot be declared inside a custom component" : ""}: geographic layers live on the globe (longitude/latitude), not in the anchor's local metres, so they have no position, parent or rotation to inherit`);
    }
    if (counts[child.type] > GEO_BUDGETS[child.type]) {
      if (child.type === "Globe") fail("globe_duplicate", child, "a scene has at most one Globe; put every terrain and appearance member on the single Globe node");
      fail("geo_budget", child,
        `${child.type} '${id}' is number ${counts[child.type]}; a scene takes at most ${GEO_BUDGETS[child.type]} (each one holds its own tile cache and the page runs out of browser memory beyond that)`);
    }

    if (child.type === "ImageryLayer") validateImagery({ child, fields, id }, { constantOf, at, fail });
    if (child.type === "Tileset") validateTileset({ child, fields, id }, { constantOf, at, fail });
    if (child.type === "GeoJsonLayer") validateGeoJson({ child, fields, id }, { constantOf, at, fail });
    if (child.type === "Globe") validateGlobe({ child, fields, id }, { constantOf, at, fail });
  }
}

const unitInterval = (name, { child, fields, id }, { constantOf, at, fail }) => {
  const value = constantOf(fields, name);
  if (value !== undefined && !(Number.isFinite(value) && value >= 0 && value <= 1)) {
    fail("value_out_of_range", at(fields, name, child), `${child.type} '${id}': ${name} must be in 0..1`);
  }
};

function validateGlobe(node, helpers) {
  unitInterval("opacity", node, helpers);
}

function validateImagery(node, helpers) {
  const { child, fields, id } = node;
  const { constantOf, at, fail } = helpers;
  const kind = constantOf(fields, "kind") ?? "xyz";
  if (!IMAGERY_KINDS.includes(kind)) {
    fail("enum_invalid", at(fields, "kind", child),
      `ImageryLayer '${id}': kind must be one of ${IMAGERY_KINDS.join(" / ")}`);
  }
  const source = constantOf(fields, "source");
  if (kind === "xyz" && typeof source === "string" && XYZ_TOKENS.some((token) => !source.includes(token))) {
    fail("geo_url_template_missing_tokens", at(fields, "source", child),
      `ImageryLayer '${id}': an xyz layer's source is a tile template and must contain ${XYZ_TOKENS.join(" ")}, e.g. https://example.com/tiles/{z}/{x}/{y}.png (use kind: "wms" / "arcgis" / "single" for a service URL)`);
  }
  if (kind !== "xyz") {
    for (const name of XYZ_ONLY) {
      if (fields.has(name)) {
        fail("member_unsupported", at(fields, name, child),
          `ImageryLayer '${id}': ${name} only applies to kind: "xyz"; a ${kind} layer takes its tiling from the service`);
      }
    }
  }
  const rectangle = constantOf(fields, "rectangle");
  if (rectangle !== undefined) validateRectangle(rectangle, node, helpers);
  if (kind === "single" && !fields.has("rectangle")) {
    fail("required_property", child,
      `ImageryLayer '${id}': kind: "single" is one image draped over a rectangle, so rectangle: [west, south, east, north] in degrees is required`);
  }
  const minimum = constantOf(fields, "minimumLevel") ?? 0;
  const maximum = constantOf(fields, "maximumLevel") ?? 18;
  if (!integerIn(minimum, 0, 30) || !integerIn(maximum, 0, 30) || minimum > maximum) {
    fail("geo_level_range_invalid", at(fields, fields.has("maximumLevel") ? "maximumLevel" : "minimumLevel", child),
      `ImageryLayer '${id}': minimumLevel/maximumLevel are whole tile levels in 0..30 with minimumLevel <= maximumLevel, got ${minimum}..${maximum}`);
  }
  for (const name of ["tileWidth", "tileHeight"]) {
    const value = constantOf(fields, name);
    if (value !== undefined && !integerIn(value, 1, 4096)) {
      fail("value_out_of_range", at(fields, name, child), `ImageryLayer '${id}': ${name} must be a whole number of pixels in 1..4096`);
    }
  }
  unitInterval("alpha", node, helpers);
}

function validateRectangle(value, { child, fields, id }, { at, fail }) {
  const invalid = (detail) => fail("geo_rectangle_invalid", at(fields, "rectangle", child),
    `${child.type} '${id}': rectangle is [west, south, east, north] in degrees (west < east, south < north, longitude -180..180, latitude -90..90); ${detail}`);
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => Number.isFinite(item))) invalid("it needs exactly 4 finite numbers");
  const [west, south, east, north] = value;
  if (west < -180 || east > 180 || south < -90 || north > 90) invalid(`[${value.join(", ")}] leaves the ellipsoid`);
  if (west >= east) invalid(`west ${west} is not west of east ${east}`);
  if (south >= north) invalid(`south ${south} is not south of north ${north}`);
}

function validateTileset(node, helpers) {
  const { child, fields, id } = node;
  const { constantOf, at, fail } = helpers;
  const scale = constantOf(fields, "scale");
  if (scale !== undefined && !(Number.isFinite(scale) && scale > 0)) {
    fail("value_out_of_range", at(fields, "scale", child), `Tileset '${id}': scale must be greater than 0`);
  }
  const error = constantOf(fields, "geometricErrorScale");
  if (error !== undefined && !(Number.isFinite(error) && error >= 0.2 && error <= 12)) {
    fail("value_out_of_range", at(fields, "geometricErrorScale", child),
      `Tileset '${id}': geometricErrorScale must be in 0.2..12 (this engine has no maximumScreenSpaceError; lower values load finer tiles, 1 is the engine default)`);
  }
  const memory = constantOf(fields, "maximumMemory");
  if (memory !== undefined && !integerIn(memory, 1, 8192)) {
    fail("value_out_of_range", at(fields, "maximumMemory", child),
      `Tileset '${id}': maximumMemory is a whole number of MiB in 1..8192 (engine default 512)`);
  }
}

function validateGeoJson(node, helpers) {
  const { child, fields, id } = node;
  const { constantOf, at, fail } = helpers;
  if (fields.has("source") && fields.has("url")) {
    fail("geojson_source_ambiguous", at(fields, "url", child),
      `GeoJsonLayer '${id}': give either source (a managed assets/*.geojson file) or url (a remote file), not both`);
  }
  if (!fields.has("source") && !fields.has("url")) {
    fail("required_property", child,
      `GeoJsonLayer '${id}': needs source: "assets/<name>.geojson" (a file in the project) or url: "https://..." (a remote file)`);
  }
  const geometry = constantOf(fields, "geometry");
  if (geometry !== undefined && !GEOJSON_GEOMETRIES.includes(geometry)) {
    fail("enum_invalid", at(fields, "geometry", child),
      `GeoJsonLayer '${id}': geometry must be one of ${GEOJSON_GEOMETRIES.join(" / ")} (one layer draws one kind of feature)`);
  }
  if (fields.has("extrudeHeightField") && geometry !== "polygon") {
    fail("geojson_member_geometry_mismatch", at(fields, "extrudeHeightField", child),
      `GeoJsonLayer '${id}': extrudeHeightField raises polygons by a feature property and needs geometry: "polygon"`);
  }
  const mode = constantOf(fields, "altitudeMode");
  if (mode !== undefined && !ALTITUDE_MODES.includes(mode)) {
    fail("enum_invalid", at(fields, "altitudeMode", child),
      `GeoJsonLayer '${id}': altitudeMode must be one of ${ALTITUDE_MODES.join(" / ")}`);
  }
  const width = constantOf(fields, "lineWidth");
  if (width !== undefined && !(Number.isFinite(width) && width > 0 && width <= 256)) {
    fail("value_out_of_range", at(fields, "lineWidth", child), `GeoJsonLayer '${id}': lineWidth is pixels in 0..256`);
  }
  unitInterval("opacity", node, helpers);
}
