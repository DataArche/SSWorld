// Dataset import: local GeoJSON + an explicit elevation grid -> one CityModel in local metres.
//
// The import is the only place degrees, CSV rows and file names exist. Everything after it addresses
// objects by business id (building-01, portal-01-a, road-v-400-100) and reads metres. Whatever the
// dataset does NOT provide is recorded as a data gap on the object that lacks it, rather than being
// filled with a plausible zero -- a fabricated datum is indistinguishable from a measured one once
// it is three modules downstream.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { TerrainGrid, geometryToMetres, ringCentroid, polygonArea, bboxOf, mm } from "./geo.mjs";

export const CITY_MODEL_SCHEMA = "SSWorldCityModel/1";

const digestOf = (data) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

function readJson(directory, file) {
  const target = path.join(directory, file);
  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, "utf8"));
}

/** Minimal RFC 4180 reader: the dataset's CSVs have no quoted commas, but an unquoted split would
 *  silently mangle a real extract, so quotes are honoured here rather than in six call sites. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (ch === "\r") continue;
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((name) => name.trim());
  return rows.slice(1).filter((cells) => cells.length && cells.some((cell) => cell !== "")).map((cells) =>
    Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
}

const asNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const asBoolean = (value) => value === true || value === "True" || value === "true" || value === "1";

function features(collection) {
  if (!collection) return [];
  if (collection.type !== "FeatureCollection") throw new Error("expected a GeoJSON FeatureCollection");
  return collection.features || [];
}

/** Provenance every imported object carries, so "where did this number come from" is never a guess. */
function provenance(file, feature) {
  const properties = feature.properties || {};
  return {
    source_file: file,
    source_id: feature.id ?? properties.id ?? null,
    quality_status: properties.quality_status ?? "unknown",
    synthetic: properties.synthetic === true,
    source_ref: properties.source_ref ?? null,
  };
}

function polygonObject(file, feature, extra = {}) {
  const properties = feature.properties || {};
  const geometry = geometryToMetres(feature.geometry);
  const rings = geometry.type === "MultiPolygon" ? geometry.coordinates.flat() : geometry.coordinates;
  return {
    id: properties.id ?? feature.id,
    geometry,
    centroid: ringCentroid(rings[0]),
    area_m2: mm(geometry.type === "MultiPolygon"
      ? geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0)
      : polygonArea(geometry.coordinates)),
    bbox: bboxOf(rings.flat()),
    provenance: provenance(file, feature),
    ...extra,
  };
}

/** A gap is attached to the object that lacks the datum, with the decision it blocks spelled out. */
function gap(scope, object_id, field, reason, blocks) {
  return { scope, object_id, field, reason, blocks };
}

export function importDataset(directory, { datasetFile = "dataset.json" } = {}) {
  const manifest = readJson(directory, datasetFile);
  if (!manifest) throw Object.assign(new Error(`no ${datasetFile} in ${directory}`), { code: "dataset_manifest_missing" });
  const frame = manifest.horizontal_frame || {};
  if (frame.units && frame.units !== "m") throw Object.assign(new Error(`horizontal_frame.units '${frame.units}' is not metres`), { code: "dataset_frame_unsupported" });

  const gaps = [];
  const idMap = new Map();
  const register = (kind, object) => {
    if (!object.id) throw Object.assign(new Error(`${kind} without an id in ${object.provenance?.source_file}`), { code: "dataset_id_missing" });
    if (idMap.has(object.id)) throw Object.assign(new Error(`duplicate object id '${object.id}'`), { code: "dataset_id_duplicate" });
    idMap.set(object.id, { kind, source_file: object.provenance.source_file, source_id: object.provenance.source_id, quality_status: object.provenance.quality_status });
    return object;
  };

  // --- terrain -----------------------------------------------------------------------------
  const grid = readJson(directory, "terrain_grid.json");
  let terrain = null;
  if (grid) {
    terrain = new TerrainGrid(grid);
    if (grid.sample_location && grid.sample_location !== "cell_center") {
      gaps.push(gap("terrain", "terrain_grid", "sample_location", `sample_location '${grid.sample_location}' is not cell_center`, ["flood_depth", "road_profile"]));
    }
    if (!grid.vertical_datum) gaps.push(gap("terrain", "terrain_grid", "vertical_datum", "no vertical datum named", ["flood_depth"]));
  } else {
    gaps.push(gap("terrain", "terrain_grid", "values", "no elevation grid in the dataset", ["flood_depth", "flood_extent", "building_ground_elevation"]));
  }

  // --- areas and lines ---------------------------------------------------------------------
  const site = features(readJson(directory, "site.geojson")).map((feature) =>
    register("site", polygonObject("site.geojson", feature, { name: feature.properties?.name ?? null })));

  const parcels = features(readJson(directory, "parcels.geojson")).map((feature) =>
    register("parcel", polygonObject("parcels.geojson", feature, {
      land_use: feature.properties?.land_use ?? null,
      building_ids: feature.properties?.building_ids ?? [],
      cadastral: feature.properties?.cadastral === true,
    })));

  const buildings = features(readJson(directory, "buildings.geojson")).map((feature) => {
    const properties = feature.properties || {};
    const object = polygonObject("buildings.geojson", feature, {
      parcel_id: properties.parcel_id ?? null,
      name: properties.name ?? null,
      use: properties.use ?? null,
      height_m: asNumber(properties.height_m),
      floors: asNumber(properties.floors),
      ground_elevation_m: asNumber(properties.ground_elevation_m),
      floor_elevation_m: asNumber(properties.floor_elevation_m),
      recipe_id: properties.recipe_id ?? null,
      footprint_area_m2: asNumber(properties.footprint_area_m2),
    });
    if (object.height_m === null) gaps.push(gap("building", object.id, "height_m", "no height in the source", ["mass_model", "skyline"]));
    if (object.floor_elevation_m === null) gaps.push(gap("building", object.id, "floor_elevation_m", "no threshold elevation", ["flood_exposure"]));
    return register("building", object);
  });

  const water = features(readJson(directory, "water.geojson")).map((feature) => {
    const object = polygonObject("water.geojson", feature, {
      name: feature.properties?.name ?? null,
      baseline_level_m: asNumber(feature.properties?.baseline_level_m),
    });
    if (object.baseline_level_m === null) {
      gaps.push(gap("water", object.id, "baseline_level_m", "no baseline water surface", ["flood_extent", "flood_depth"]));
    }
    return register("water", object);
  });

  const hazards = features(readJson(directory, "landslide.geojson")).map((feature) => {
    const properties = feature.properties || {};
    const object = polygonObject("landslide.geojson", feature, {
      name: properties.name ?? null,
      hazard_type: properties.hazard_type ?? "landslide",
      input_type: properties.input_type ?? "authored_extent",
      arrival_time_s: asNumber(properties.arrival_time_s),
      description: properties.description ?? null,
    });
    if (object.arrival_time_s === null) {
      gaps.push(gap("hazard", object.id, "arrival_time_s", "extent only, no timing", ["dynamic_failure_time", "staged_evacuation"]));
    }
    return register("hazard", object);
  });

  const surfaceCover = features(readJson(directory, "surface_cover.geojson")).map((feature) =>
    register("surface_cover", polygonObject("surface_cover.geojson", feature, {
      cover: feature.properties?.cover ?? null,
      impervious_fraction: asNumber(feature.properties?.impervious_fraction),
    })));

  const hydraulicStructures = features(readJson(directory, "hydraulic_structures.geojson")).map((feature) => {
    const properties = feature.properties || {};
    const geometry = geometryToMetres(feature.geometry);
    return register("hydraulic_structure", {
      id: properties.id ?? feature.id,
      geometry,
      kind: properties.kind ?? null,
      crest_elevation_m: asNumber(properties.crest_elevation_m),
      provenance: provenance("hydraulic_structures.geojson", feature),
    });
  });

  const shelters = features(readJson(directory, "shelters.geojson")).map((feature) => {
    const properties = feature.properties || {};
    const geometry = geometryToMetres(feature.geometry);
    return register("shelter", {
      id: properties.id ?? feature.id,
      position: geometry.coordinates,
      name: properties.name ?? null,
      node_id: properties.node_id ?? null,
      capacity_person: asNumber(properties.capacity_person),
      entry_capacity_person_s: asNumber(properties.entry_capacity_person_s),
      synthetic_facility: properties.synthetic_facility === true,
      provenance: provenance("shelters.geojson", feature),
    });
  });

  const surveys = features(readJson(directory, "modeling_survey.geojson")).map((feature) => {
    const properties = feature.properties || {};
    const object = {
      id: properties.id ?? feature.id,
      position: geometryToMetres(feature.geometry).coordinates,
      building_id: properties.building_id ?? null,
      width_m: asNumber(properties.width_m),
      depth_m: asNumber(properties.depth_m),
      height_m: asNumber(properties.height_m),
      description: properties.description ?? null,
      photos: Array.isArray(properties.photos) ? properties.photos : [],
      provenance: provenance("modeling_survey.geojson", feature),
    };
    if (!object.photos.length) gaps.push(gap("survey", object.id, "photos", "dimension constraints only, no imagery", ["facade_detail", "photo_inferred_mass"]));
    return register("survey", object);
  });

  // --- portals, access links and the routable network ---------------------------------------
  const portals = features(readJson(directory, "portals.geojson")).map((feature) => {
    const properties = feature.properties || {};
    return register("portal", {
      id: properties.id ?? feature.id,
      position: geometryToMetres(feature.geometry).coordinates,
      parcel_id: properties.parcel_id ?? null,
      building_id: properties.building_id ?? null,
      node_id: properties.node_id ?? properties.id ?? feature.id,
      elevation_m: asNumber(properties.elevation_m),
      modes: properties.modes ?? [],
      direction: properties.direction ?? "both",
      walk_capacity_person_s: asNumber(properties.walk_capacity_person_s),
      car_capacity_vehicle_s: asNumber(properties.car_capacity_vehicle_s),
      open: properties.open !== false,
      provenance: provenance("portals.geojson", feature),
    });
  });

  const roadFeatures = features(readJson(directory, "roads.geojson"));
  const linkFeatures = features(readJson(directory, "access_links.geojson"));
  const lineGeometry = new Map();
  for (const feature of [...roadFeatures, ...linkFeatures]) {
    lineGeometry.set(feature.properties?.id ?? feature.id, geometryToMetres(feature.geometry).coordinates);
  }
  for (const feature of roadFeatures) {
    register("road", { id: feature.properties?.id ?? feature.id, provenance: provenance("roads.geojson", feature) });
  }
  for (const feature of linkFeatures) {
    register("access_link", { id: feature.properties?.id ?? feature.id, provenance: provenance("access_links.geojson", feature) });
  }

  const networkFile = readJson(directory, "network.json");
  if (!networkFile) throw Object.assign(new Error("no network.json in the dataset"), { code: "dataset_network_missing" });
  const nodes = networkFile.nodes.map((node) => ({
    id: node.id, position: [node.x_m, node.y_m], elevation_m: asNumber(node.z_m), kind: node.kind,
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = networkFile.edges.map((edge) => {
    for (const end of [edge.from_node, edge.to_node]) {
      if (!nodeIds.has(end)) throw Object.assign(new Error(`edge '${edge.id}' references unknown node '${end}'`), { code: "dataset_node_missing" });
    }
    return {
      id: edge.id,
      from_node: edge.from_node,
      to_node: edge.to_node,
      bidirectional: edge.bidirectional !== false,
      modes: edge.modes || [],
      length_m: asNumber(edge.length_m),
      walk_speed_mps: asNumber(edge.walk_speed_mps),
      car_speed_mps: asNumber(edge.car_speed_mps),
      walk_capacity_person_s: asNumber(edge.walk_capacity_person_s),
      car_capacity_vehicle_s: asNumber(edge.car_capacity_vehicle_s),
      storage_vehicles: asNumber(edge.storage_vehicles),
      bridge: edge.bridge === true,
      elevation_profile_m: edge.elevation_profile_m || [],
      portal_id: edge.portal_id ?? null,
      polyline: lineGeometry.get(edge.id) || null,
      kind: edge.id.startsWith("road") ? "road" : "access_link",
    };
  });
  const turnRestrictions = networkFile.turn_restrictions || [];
  if (!turnRestrictions.length) {
    gaps.push(gap("network", "network", "turn_restrictions", "no turn restrictions or signals in the source", ["intersection_delay", "junction_calibration"]));
  }

  // --- demand, population, levels, recipes, scenarios ----------------------------------------
  const readCsv = (file) => {
    const target = path.join(directory, file);
    return existsSync(target) ? parseCsv(readFileSync(target, "utf8")) : [];
  };
  const demand = readCsv("demand.csv").map((row) => ({
    id: row.demand_id, origin_node: row.origin_node, destination_node: row.destination_node,
    departure_start_s: asNumber(row.departure_start_s) ?? 0, departure_end_s: asNumber(row.departure_end_s) ?? 0,
    count: asNumber(row.count) ?? 0, unit: row.unit || "person", mode: row.mode || "walk", synthetic: asBoolean(row.synthetic),
  }));
  const population = readCsv("population.csv").map((row) => ({
    building_id: row.building_id, group_id: row.group_id, count: asNumber(row.count) ?? 0,
    time_period: row.time_period, departure_delay_s: asNumber(row.departure_delay_s) ?? 0,
    mode: row.mode || "walk", synthetic: asBoolean(row.synthetic),
  }));
  const waterLevels = readCsv("water_levels.csv").map((row) => ({
    river_id: row.river_id, scenario: row.scenario, level_m: asNumber(row.level_m),
    vertical_datum: row.vertical_datum, synthetic: asBoolean(row.synthetic),
  }));
  if (!demand.some((row) => row.unit === "vehicle")) {
    gaps.push(gap("demand", "demand.csv", "unit", "only pedestrian demand rows are present", ["vehicle_flow", "car_queueing"]));
  }

  const recipes = readJson(directory, "build_recipes.json") || [];
  const scenarios = readJson(directory, "scenarios.json") || [];

  const fileDigests = {};
  for (const file of readdirSync(directory)) {
    const target = path.join(directory, file);
    if (!existsSync(target) || file.endsWith(".html")) continue;
    try { fileDigests[file] = digestOf(readFileSync(target)); } catch { /* directories */ }
  }

  for (const missing of manifest.missing_real_inputs || []) {
    gaps.push(gap("dataset", manifest.id, "missing_real_inputs", missing, ["real_world_conclusions"]));
  }

  const extent = manifest.area_m2 && frame.extent_m ? frame.extent_m : (terrain ? terrain.extent : null);
  return {
    schema_version: CITY_MODEL_SCHEMA,
    dataset: {
      id: manifest.id, name: manifest.name, synthetic: manifest.synthetic === true, source: manifest.source ?? null,
      license: manifest.license ?? null, generator: manifest.generator ?? null, generator_version: manifest.generator_version ?? null,
      vertical_datum: manifest.vertical_datum ?? null, directory, file_digests: fileDigests,
    },
    frame: {
      kind: frame.type || "local_metres", units: "m", extent_m: extent,
      display_origin_lon_lat: frame.display_origin_lon_lat || [0, 0],
      geojson_crs: frame.geojson_crs || null,
      conversion: frame.conversion || null,
      note: frame.note || null,
    },
    terrain: terrain
      ? { width: terrain.width, height: terrain.height, cell_size_m: terrain.cellSize, origin_sw_m: terrain.origin,
          row_order: terrain.rowOrder, nodata: terrain.nodata, vertical_datum: terrain.verticalDatum,
          sample_location: terrain.sampleLocation, values: terrain.rows }
      : null,
    objects: { site, parcels, buildings, roads: roadFeatures.map((feature) => ({
      id: feature.properties?.id ?? feature.id,
      polyline: lineGeometry.get(feature.properties?.id ?? feature.id),
      from_node: feature.properties?.from_node, to_node: feature.properties?.to_node,
      length_m: asNumber(feature.properties?.length_m), bridge: feature.properties?.bridge === true,
      modes: feature.properties?.modes ?? [], elevation_profile_m: feature.properties?.elevation_profile_m ?? [],
      provenance: provenance("roads.geojson", feature),
    })), access_links: linkFeatures.map((feature) => ({
      id: feature.properties?.id ?? feature.id,
      polyline: lineGeometry.get(feature.properties?.id ?? feature.id),
      from_node: feature.properties?.from_node, to_node: feature.properties?.to_node,
      portal_id: feature.properties?.portal_id ?? null,
      provenance: provenance("access_links.geojson", feature),
    })), portals, water, hazards, shelters, surface_cover: surfaceCover,
      hydraulic_structures: hydraulicStructures, surveys },
    network: { nodes, edges, turn_restrictions: turnRestrictions, notes: networkFile.notes ?? null },
    demand, population, water_levels: waterLevels, recipes, scenarios,
    id_map: Object.fromEntries([...idMap].map(([id, entry]) => [id, entry])),
    data_gaps: gaps,
  };
}

/** A stable digest of the imported model: the baseline snapshot's identity. */
export function modelDigest(model) {
  return digestOf(JSON.stringify(model));
}
