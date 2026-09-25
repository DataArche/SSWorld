// baseline + overrides -> the city as it stands in one revision.
//
// Overrides are patches, never copies of the baseline, so a revision file stays a few hundred bytes
// and the imported survey remains the only place a measured number lives. Materialising is pure:
// the same (baseline, overrides) always yields the same model, which is what makes a run replayable
// from its revision id alone.
import { TerrainGrid, distance, mm, ringCentroid, polygonArea, bboxOf } from "./geo.mjs";

export const REVISION_SCHEMA = "SSWorldCityRevision/1";

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Length of a polyline in metres. */
const polylineLength = (points) => {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) total += distance(points[i], points[i + 1]);
  return mm(total);
};

export function materialize(baseline, overrides = {}) {
  const model = clone(baseline);
  const terrain = model.terrain ? new TerrainGrid({ ...model.terrain, row_order: model.terrain.row_order, values: model.terrain.values }) : null;
  const changes = [];

  // --- portals ------------------------------------------------------------------------------
  const movedPortals = new Map();
  for (const [id, patch] of Object.entries(overrides.portals ?? {})) {
    const portal = model.objects.portals.find((item) => item.id === id);
    if (!portal) continue;
    const before = clone(portal);
    Object.assign(portal, patch);
    if (patch.position) {
      portal.position = [mm(patch.position[0]), mm(patch.position[1])];
      if (patch.elevation_m === undefined && terrain) {
        const sampled = terrain.sample(portal.position[0], portal.position[1]);
        portal.elevation_m = sampled === null ? portal.elevation_m : mm(sampled);
        portal.elevation_source = sampled === null ? "unchanged_no_terrain" : "resampled_from_terrain";
      }
      movedPortals.set(portal.node_id ?? id, portal);
    }
    changes.push({ object_id: id, kind: "portal", before, after: clone(portal) });
  }

  // A portal that moved drags its node and every incident access link with it: the geometry, the
  // length and (where terrain exists) the profile. Leaving the link geometry behind would keep the
  // old walking distance and make the move look free.
  for (const [nodeId, portal] of movedPortals) {
    const node = model.network.nodes.find((item) => item.id === nodeId);
    if (node) {
      node.position = portal.position;
      if (portal.elevation_m !== null && portal.elevation_m !== undefined) node.elevation_m = portal.elevation_m;
    }
    for (const edge of model.network.edges) {
      if (edge.from_node !== nodeId && edge.to_node !== nodeId) continue;
      if (!edge.polyline) continue;
      const at = edge.from_node === nodeId ? 0 : edge.polyline.length - 1;
      edge.polyline = clone(edge.polyline);
      edge.polyline[at] = portal.position;
      edge.length_m = polylineLength(edge.polyline);
      if (edge.elevation_profile_m?.length && portal.elevation_m !== null && portal.elevation_m !== undefined) {
        edge.elevation_profile_m = clone(edge.elevation_profile_m);
        edge.elevation_profile_m[at === 0 ? 0 : edge.elevation_profile_m.length - 1] = portal.elevation_m;
      }
      edge.geometry_source = "portal_move";
    }
    for (const collection of [model.objects.access_links, model.objects.roads]) {
      for (const link of collection) {
        const edge = model.network.edges.find((item) => item.id === link.id);
        if (edge && edge.geometry_source === "portal_move") link.polyline = edge.polyline;
      }
    }
  }

  // --- buildings ----------------------------------------------------------------------------
  const removedBuildings = new Set();
  for (const [id, patch] of Object.entries(overrides.buildings ?? {})) {
    const index = model.objects.buildings.findIndex((item) => item.id === id);
    if (index < 0) {
      if (patch.added) model.objects.buildings.push(normaliseBuilding(patch.added, terrain));
      continue;
    }
    const building = model.objects.buildings[index];
    const before = clone(building);
    if (patch.removed) { removedBuildings.add(id); model.objects.buildings.splice(index, 1); changes.push({ object_id: id, kind: "building", before, after: null }); continue; }
    Object.assign(building, patch);
    if (patch.geometry) {
      const rings = patch.geometry.coordinates;
      building.centroid = ringCentroid(rings[0]);
      building.area_m2 = mm(polygonArea(rings));
      building.bbox = bboxOf(rings.flat());
    }
    changes.push({ object_id: id, kind: "building", before, after: clone(building) });
  }
  if (removedBuildings.size) {
    for (const parcel of model.objects.parcels) {
      parcel.building_ids = (parcel.building_ids ?? []).filter((id) => !removedBuildings.has(id));
    }
  }

  // --- parcels ------------------------------------------------------------------------------
  for (const [id, patch] of Object.entries(overrides.parcels ?? {})) {
    const parcel = model.objects.parcels.find((item) => item.id === id);
    if (!parcel) continue;
    const before = clone(parcel);
    Object.assign(parcel, patch);
    changes.push({ object_id: id, kind: "parcel", before, after: clone(parcel) });
  }

  // --- water and hazards ----------------------------------------------------------------------
  const waterOverrides = {};
  for (const [id, patch] of Object.entries(overrides.water ?? {})) {
    if (patch.level_m !== undefined) waterOverrides[id] = patch.level_m;
  }
  const activeHazards = [];
  for (const hazard of model.objects.hazards) {
    const patch = overrides.hazards?.[hazard.id];
    if (patch?.active) activeHazards.push({ ...hazard, effective_at_s: patch.effective_at_s ?? null, activated_by: patch.command_id ?? null });
  }
  for (const [id, patch] of Object.entries(overrides.hazards ?? {})) {
    if (!patch.added) continue;
    if (patch.active) activeHazards.push({ ...patch.added, id, effective_at_s: patch.effective_at_s ?? null });
    if (!model.objects.hazards.some((item) => item.id === id)) model.objects.hazards.push({ ...patch.added, id });
  }

  // --- surface cover from land-use plans -------------------------------------------------------
  for (const [id, patch] of Object.entries(overrides.parcels ?? {})) {
    if (patch.impervious_fraction === undefined) continue;
    const parcel = model.objects.parcels.find((item) => item.id === id);
    if (!parcel) continue;
    const coverId = `cover-${id}`;
    const existing = model.objects.surface_cover.find((item) => item.id === coverId);
    const cover = { id: coverId, geometry: parcel.geometry, centroid: parcel.centroid, area_m2: parcel.area_m2,
      bbox: parcel.bbox, cover: patch.land_use ?? parcel.land_use, impervious_fraction: patch.impervious_fraction,
      provenance: { source_file: "command:parcel.set_use", source_id: id, quality_status: "authored", synthetic: false, source_ref: null } };
    if (existing) Object.assign(existing, cover); else model.objects.surface_cover.push(cover);
  }

  return {
    model,
    water_level_overrides: waterOverrides,
    active_hazards: activeHazards,
    manual_edge_closures: Object.entries(overrides.closures?.edges ?? {}).map(([edge_id, detail]) => ({ edge_id, status: "closed", ...detail })),
    changes,
  };
}

function normaliseBuilding(building, terrain) {
  const rings = building.geometry.coordinates;
  const ground = terrain ? terrain.sample(...ringCentroid(rings[0])) : null;
  return {
    ...building,
    centroid: ringCentroid(rings[0]),
    area_m2: mm(polygonArea(rings)),
    bbox: bboxOf(rings.flat()),
    ground_elevation_m: building.ground_elevation_m ?? (ground === null ? null : mm(ground)),
    floor_elevation_m: building.floor_elevation_m ?? (ground === null ? null : mm(ground + 0.2)),
  };
}

/** Demand for a revision: the dataset rows minus removals plus command-added rows. */
export function effectiveDemand(model, overrides = {}) {
  const removed = new Set(overrides.demand?.removed ?? []);
  return [...model.demand.filter((row) => !removed.has(row.id)), ...(overrides.demand?.added ?? [])];
}

/** Population groups for a revision, with per-building overrides from land-use commands applied. */
export function effectivePopulation(model, overrides = {}) {
  const patches = overrides.population ?? {};
  const rows = model.population
    .filter((row) => model.objects.buildings.some((building) => building.id === row.building_id))
    .map((row) => ({ ...row, ...(patches[row.building_id] ?? {}) }))
    .filter((row) => row.count > 0);
  for (const [buildingId, patch] of Object.entries(patches)) {
    if (rows.some((row) => row.building_id === buildingId)) continue;
    if (!patch.count) continue;
    rows.push({ building_id: buildingId, group_id: patch.group_id ?? `group-${buildingId}`, count: patch.count,
      time_period: patch.time_period ?? "authored", departure_delay_s: patch.departure_delay_s ?? 0,
      mode: patch.mode ?? "walk", synthetic: false });
  }
  return rows.sort((a, b) => String(a.group_id).localeCompare(String(b.group_id)));
}
