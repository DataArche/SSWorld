// Static, source-connected inundation.
//
// The model is deliberately named and deliberately narrow: a HORIZONTAL POOL per water body. Every
// cell below that body's water surface AND reachable from the body's own footprint over cells that
// are themselves below it is wet; everything else is dry. That is a defensible answer for a reach
// whose water surface is flat, and it is the WRONG answer for a reach with a slope -- so a body that
// declares a gradient is refused here instead of being filled with the same number end to end.
//
// What this does not produce: arrival time, velocity, drainage, or the behaviour of culverts and
// tunnels that the dataset never described. Those are reported as limitations on every result.
import { TerrainGrid, pointInAnyPolygon, segmentsIntersect } from "./geo.mjs";

export const FLOOD_SCHEMA = "SSWorldCityFlood/1";
export const DEFAULT_PASSABLE_DEPTH_M = 0.2;

function terrainOf(model) {
  if (!model.terrain) {
    throw Object.assign(new Error("the city has no elevation grid; a water level cannot be turned into an extent"),
      { code: "terrain_missing" });
  }
  return new TerrainGrid({ ...model.terrain, row_order: model.terrain.row_order, values: model.terrain.values });
}

/** Water surface elevation per body: the override if the scenario set one, else the imported baseline. */
export function waterLevels(model, overrides = {}) {
  const levels = {};
  for (const body of model.objects.water) {
    const override = overrides[body.id];
    const level = override === undefined || override === null ? body.baseline_level_m : override;
    levels[body.id] = { level_m: level === undefined ? null : level, baseline_level_m: body.baseline_level_m,
      source: override === undefined || override === null ? "dataset_baseline" : "scenario_override" };
  }
  return levels;
}

/**
 * Wet cells, depth and surface elevation for one revision's water levels.
 * Returns a grid-shaped field plus point/line sampling helpers; nothing here decides what a depth
 * MEANS for a road or a door -- that is floodImpact(), which reads the objects' own thresholds.
 */
export function computeFlood(model, { levels = {}, waterLevelOverrides = {} } = {}) {
  const terrain = terrainOf(model);
  const resolved = Object.keys(levels).length ? levels : waterLevels(model, waterLevelOverrides);
  const width = terrain.width, height = terrain.height;
  const depth = new Float64Array(width * height);
  const body = new Array(width * height).fill(null);
  const unknown = new Uint8Array(width * height);
  const bodies = [];
  const limitations = [
    "static horizontal pool: no arrival time, velocity or drainage",
    "culverts and tunnels are not in the dataset, so flow under an embankment is not represented",
  ];

  for (const water of model.objects.water) {
    const entry = resolved[water.id] || { level_m: null, source: "unknown" };
    if (entry.level_m === null || entry.level_m === undefined) {
      bodies.push({ id: water.id, status: "unknown", reason: "no baseline water surface and no scenario level", level_m: null });
      continue;
    }
    // A sloped reach needs a stated water-surface interpolation; applying one stage to the whole
    // reach would silently flood the upstream end.
    if (water.slope_per_m || water.level_profile) {
      bodies.push({ id: water.id, status: "model_not_applicable", level_m: entry.level_m,
        reason: "the reach declares a gradient; the horizontal-pool model needs a stated water-surface interpolation" });
      continue;
    }
    const level = entry.level_m;
    const barriers = model.objects.hydraulic_structures.filter((structure) =>
      structure.crest_elevation_m !== null && structure.crest_elevation_m >= level && structure.geometry?.type === "LineString");
    const queue = [];
    const seen = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const centre = terrain.cellCentre(col, row);
        if (!pointInAnyPolygon(centre, water.geometry)) continue;
        const value = terrain.valueAtCell(col, row);
        if (value === null) { unknown[row * width + col] = 1; continue; }
        if (value >= level) continue;
        const index = row * width + col;
        if (seen[index]) continue;
        seen[index] = 1;
        queue.push(index);
      }
    }
    // Flood fill outward from the body's own footprint. A crest at or above the water surface is a
    // barrier: without it a levee that is never overtopped still leaks into the field behind it.
    let wet = 0;
    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      const col = index % width, row = (index - col) / width;
      wet += 1;
      const value = terrain.valueAtCell(col, row);
      const thisDepth = level - value;
      if (thisDepth > depth[index]) { depth[index] = thisDepth; body[index] = water.id; }
      const centre = terrain.cellCentre(col, row);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = col + dc, nr = row + dr;
        if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
        const next = nr * width + nc;
        if (seen[next]) continue;
        const neighbour = terrain.valueAtCell(nc, nr);
        if (neighbour === null) { unknown[next] = 1; continue; }
        if (neighbour >= level) continue;
        const neighbourCentre = terrain.cellCentre(nc, nr);
        if (barriers.some((barrier) => crosses(centre, neighbourCentre, barrier.geometry.coordinates))) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    bodies.push({ id: water.id, status: "computed", level_m: level, baseline_level_m: entry.baseline_level_m,
      level_source: entry.source, wet_cells: wet, area_m2: wet * terrain.cellArea,
      barriers: barriers.map((barrier) => ({ id: barrier.id, crest_elevation_m: barrier.crest_elevation_m })) });
  }

  const unknownCells = unknown.reduce((sum, value) => sum + value, 0);
  const wetCells = depth.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
  return new FloodField({ terrain, depth, body, unknown, bodies, limitations,
    area_m2: wetCells * terrain.cellArea, wet_cells: wetCells, unknown_cells: unknownCells, levels: resolved });
}

function crosses(a, b, line) {
  for (let i = 0; i < line.length - 1; i += 1) if (segmentsIntersect(a, b, line[i], line[i + 1])) return true;
  return false;
}

export class FloodField {
  constructor({ terrain, depth, body, unknown, bodies, limitations, area_m2, wet_cells, unknown_cells, levels }) {
    this.terrain = terrain;
    this.depth = depth;
    this.body = body;
    this.unknownMask = unknown;
    this.bodies = bodies;
    this.limitations = limitations;
    this.area_m2 = area_m2;
    this.wet_cells = wet_cells;
    this.unknown_cells = unknown_cells;
    this.levels = levels;
  }

  index(x, y) {
    const col = Math.floor((x - this.terrain.origin[0]) / this.terrain.cellSize);
    const row = Math.floor((y - this.terrain.origin[1]) / this.terrain.cellSize);
    if (col < 0 || row < 0 || col >= this.terrain.width || row >= this.terrain.height) return -1;
    return row * this.terrain.width + col;
  }

  /** Water surface elevation at a point, or null where the cell is dry / outside / unknown. */
  surfaceAt(x, y) {
    const index = this.index(x, y);
    if (index < 0) return { status: "outside_grid", surface_m: null, depth_m: null, body_id: null };
    if (this.unknownMask[index] && this.depth[index] === 0) return { status: "unknown", surface_m: null, depth_m: null, body_id: null };
    if (this.depth[index] <= 0) return { status: "dry", surface_m: null, depth_m: 0, body_id: null };
    const ground = this.terrain.valueAtCell(index % this.terrain.width, Math.floor(index / this.terrain.width));
    return { status: "wet", surface_m: ground + this.depth[index], depth_m: this.depth[index], body_id: this.body[index] };
  }

  /** Depth ON a structure whose own elevation is known (a road deck, a threshold), not on the ground
   *  below it: a bridge deck at 13 m over a 9 m channel is dry no matter how deep the channel is. */
  depthOnStructure(x, y, elevation_m) {
    const water = this.surfaceAt(x, y);
    if (water.status !== "wet") return { ...water, structure_depth_m: water.status === "dry" ? 0 : null };
    if (elevation_m === null || elevation_m === undefined) return { ...water, structure_depth_m: null, status: "unknown_threshold" };
    return { ...water, structure_depth_m: Math.max(0, water.surface_m - elevation_m) };
  }

  /** Cell rectangles of the wet area, merged into horizontal runs so a display layer is a few dozen
   *  quads rather than thousands. Returned in local metres as [x0, y0, x1, y1, surface_m]. */
  wetRuns() {
    const runs = [];
    const { width, height, cellSize, origin } = this.terrain;
    for (let row = 0; row < height; row += 1) {
      let start = -1, surface = null;
      for (let col = 0; col <= width; col += 1) {
        const index = row * width + col;
        const wet = col < width && this.depth[index] > 0;
        const cellSurface = wet ? this.terrain.valueAtCell(col, row) + this.depth[index] : null;
        if (wet && start < 0) { start = col; surface = cellSurface; }
        else if (start >= 0 && (!wet || Math.abs(cellSurface - surface) > 1e-6)) {
          runs.push([origin[0] + start * cellSize, origin[1] + row * cellSize,
            origin[0] + col * cellSize, origin[1] + (row + 1) * cellSize, surface]);
          start = wet ? col : -1;
          surface = cellSurface;
        }
      }
    }
    return runs;
  }

  summary() {
    return { schema_version: FLOOD_SCHEMA, area_m2: this.area_m2, wet_cells: this.wet_cells,
      unknown_cells: this.unknown_cells, cell_size_m: this.terrain.cellSize,
      bodies: this.bodies, levels: this.levels, limitations: this.limitations };
  }
}

/**
 * What a flood field MEANS for the city's objects: which network edges and portals are impassable,
 * which building thresholds are over-topped, and which of those answers is unknown rather than dry.
 */
export function floodImpact(model, field, { passableDepth = DEFAULT_PASSABLE_DEPTH_M } = {}) {
  const edges = [];
  for (const edge of model.network.edges) {
    const profile = edge.elevation_profile_m || [];
    const line = edge.polyline || [];
    const samples = [];
    const count = Math.max(line.length, profile.length);
    for (let i = 0; i < count; i += 1) {
      const point = line.length ? line[Math.min(i, line.length - 1)] : null;
      const elevation = profile.length ? profile[Math.min(i, profile.length - 1)] : null;
      if (!point) continue;
      samples.push({ point, elevation, ...field.depthOnStructure(point[0], point[1], elevation) });
    }
    const depths = samples.map((sample) => sample.structure_depth_m).filter((value) => value !== null);
    const maxDepth = depths.length ? Math.max(...depths) : null;
    const unknownSample = samples.some((sample) => sample.structure_depth_m === null);
    if (maxDepth !== null && maxDepth > passableDepth) {
      edges.push({ edge_id: edge.id, status: "closed", max_depth_m: round(maxDepth), bridge: edge.bridge,
        elevation_source: "edge_elevation_profile_m" });
    } else if (unknownSample && (maxDepth === null || maxDepth <= passableDepth)) {
      edges.push({ edge_id: edge.id, status: "unknown", max_depth_m: maxDepth === null ? null : round(maxDepth), bridge: edge.bridge,
        elevation_source: profile.length ? "edge_elevation_profile_m" : "missing" });
    }
  }

  const portals = [];
  for (const portal of model.objects.portals) {
    const reading = field.depthOnStructure(portal.position[0], portal.position[1], portal.elevation_m);
    if (reading.structure_depth_m === null) portals.push({ portal_id: portal.id, status: "unknown", depth_m: null });
    else if (reading.structure_depth_m > passableDepth) portals.push({ portal_id: portal.id, status: "closed", depth_m: round(reading.structure_depth_m) });
  }

  const buildings = [];
  for (const building of model.objects.buildings) {
    const threshold = building.floor_elevation_m;
    const reading = field.depthOnStructure(building.centroid[0], building.centroid[1], threshold);
    if (threshold === null || threshold === undefined) {
      if (reading.status === "wet") buildings.push({ building_id: building.id, status: "unknown", depth_m: null, reason: "no floor_elevation_m" });
      continue;
    }
    if (reading.structure_depth_m > 0) {
      buildings.push({ building_id: building.id, status: "inundated", depth_m: round(reading.structure_depth_m),
        floor_elevation_m: threshold });
    }
  }

  return {
    schema_version: FLOOD_SCHEMA,
    passable_depth_m: passableDepth,
    edges, portals, buildings,
    bridges_evaluated_on_deck: model.network.edges.filter((edge) => edge.bridge).map((edge) => edge.id),
    limitations: field.limitations,
  };
}

const round = (value) => Math.round(value * 1000) / 1000;
