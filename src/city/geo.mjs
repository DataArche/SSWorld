// Plane geometry and terrain sampling for the city model.
//
// Every city object is stored in LOCAL METRES, never in degrees: the dataset manifest states the
// conversion once (lon = x / (R * pi / 180)) and the importer applies it, so nothing downstream has
// to remember whether a number is a degree or a metre. Local x is east, y is north, z is up, and the
// frame origin is the site's own origin (the manifest's extent_m corner), so x/y are the same
// numbers the dataset's network nodes carry.

export const EARTH_RADIUS_M = 6378137;
export const DEG_TO_M = (EARTH_RADIUS_M * Math.PI) / 180;

/** Degrees -> metres in the dataset's local equirectangular frame. */
export const lonToX = (lon) => lon * DEG_TO_M;
export const latToY = (lat) => lat * DEG_TO_M;
export const xToLon = (x) => x / DEG_TO_M;
export const yToLat = (y) => y / DEG_TO_M;

/** Round to millimetres so a re-import of the same file produces byte-identical numbers. */
export const mm = (value) => Math.round(value * 1000) / 1000;

export function ringToMetres(ring) {
  return ring.map(([lon, lat]) => [mm(lonToX(lon)), mm(latToY(lat))]);
}

export function geometryToMetres(geometry) {
  if (!geometry) return null;
  const { type, coordinates } = geometry;
  if (type === "Point") return { type, coordinates: [mm(lonToX(coordinates[0])), mm(latToY(coordinates[1]))] };
  if (type === "LineString") return { type, coordinates: ringToMetres(coordinates) };
  if (type === "Polygon") return { type, coordinates: coordinates.map(ringToMetres) };
  if (type === "MultiPolygon") return { type, coordinates: coordinates.map((polygon) => polygon.map(ringToMetres)) };
  throw new Error(`unsupported geometry type '${type}'`);
}

/** Signed area of a ring in m^2; positive for counter-clockwise. */
export function ringArea(ring) {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function polygonArea(polygon) {
  return polygon.reduce((total, ring, index) => total + (index === 0 ? Math.abs(ringArea(ring)) : -Math.abs(ringArea(ring))), 0);
}

export function ringCentroid(ring) {
  const area = ringArea(ring);
  if (Math.abs(area) < 1e-9) {
    const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [mm(sum[0] / ring.length), mm(sum[1] / ring.length)];
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [mm(cx / (6 * area)), mm(cy / (6 * area))];
}

export function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Ray casting; a point exactly on an edge counts as inside so shared borders never lose a cell. */
export function pointInRing(point, ring) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const onSegment = Math.abs((xj - xi) * (py - yi) - (yj - yi) * (px - xi)) < 1e-9
      && px >= Math.min(xi, xj) - 1e-9 && px <= Math.max(xi, xj) + 1e-9
      && py >= Math.min(yi, yj) - 1e-9 && py <= Math.max(yi, yj) + 1e-9;
    if (onSegment) return true;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point, polygon) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

export function pointInAnyPolygon(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  return false;
}

export function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSegment = (p, q, r) => Math.abs(cross(p, q, r)) < 1e-9
    && r[0] >= Math.min(p[0], q[0]) - 1e-9 && r[0] <= Math.max(p[0], q[0]) + 1e-9
    && r[1] >= Math.min(p[1], q[1]) - 1e-9 && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  return onSegment(c, d, a) || onSegment(c, d, b) || onSegment(a, b, c) || onSegment(a, b, d);
}

/** Does a polyline touch a polygon (crossing an edge, or lying inside it)? */
export function lineIntersectsPolygon(line, geometry) {
  if (!geometry) return false;
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const point of line) if (pointInAnyPolygon(point, geometry)) return true;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        for (let j = 0; j < line.length - 1; j += 1) {
          if (segmentsIntersect(line[j], line[j + 1], ring[i], ring[i + 1])) return true;
        }
      }
    }
  }
  return false;
}

export function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * A regular elevation grid of CELL-CENTRE samples (the dataset's terrain_grid.json shape). It keeps
 * the raw row order from the file and exposes (col, row) with row 0 at the SOUTH, because every other
 * consumer here counts y upwards and a silently flipped raster is a whole class of wrong answers.
 */
export class TerrainGrid {
  constructor({ width, height, cell_size_m, origin_sw_m, row_order, values, nodata = -9999, vertical_datum = null, sample_location = "cell_center" }) {
    this.width = width;
    this.height = height;
    this.cellSize = cell_size_m;
    this.origin = origin_sw_m;
    this.nodata = nodata;
    this.verticalDatum = vertical_datum;
    this.sampleLocation = sample_location;
    // Stored south-to-north so row index and y grow together.
    this.rows = row_order === "north_to_south" ? [...values].reverse() : values.map((row) => [...row]);
    this.rowOrder = "south_to_north";
  }

  /** Elevation of the cell covering (x, y) in local metres; null outside the grid or at nodata. */
  valueAt(x, y) {
    const col = Math.floor((x - this.origin[0]) / this.cellSize);
    const row = Math.floor((y - this.origin[1]) / this.cellSize);
    return this.valueAtCell(col, row);
  }

  valueAtCell(col, row) {
    if (col < 0 || row < 0 || col >= this.width || row >= this.height) return null;
    const value = this.rows[row][col];
    return value === this.nodata ? null : value;
  }

  cellCentre(col, row) {
    return [this.origin[0] + (col + 0.5) * this.cellSize, this.origin[1] + (row + 0.5) * this.cellSize];
  }

  get cellArea() { return this.cellSize * this.cellSize; }

  /** Bilinear elevation at an arbitrary point, clamped at the border; null if any contributor is nodata. */
  sample(x, y) {
    const fx = (x - this.origin[0]) / this.cellSize - 0.5;
    const fy = (y - this.origin[1]) / this.cellSize - 0.5;
    const col = Math.floor(fx), row = Math.floor(fy);
    const tx = fx - col, ty = fy - row;
    const clampCol = (value) => Math.min(this.width - 1, Math.max(0, value));
    const clampRow = (value) => Math.min(this.height - 1, Math.max(0, value));
    const corner = (c, r) => this.valueAtCell(clampCol(c), clampRow(r));
    const values = [corner(col, row), corner(col + 1, row), corner(col, row + 1), corner(col + 1, row + 1)];
    if (values.some((value) => value === null)) return null;
    const [v00, v10, v01, v11] = values;
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  }

  /** Corner heights for an SSDL HeightField: (columns + 1) * (rows + 1), row-major from the south-west. */
  cornerHeights(columns = this.width, rows = this.height) {
    const spanX = this.width * this.cellSize;
    const spanY = this.height * this.cellSize;
    const out = [];
    for (let r = 0; r <= rows; r += 1) {
      for (let c = 0; c <= columns; c += 1) {
        const x = this.origin[0] + (c / columns) * spanX;
        const y = this.origin[1] + (r / rows) * spanY;
        const value = this.sample(x, y);
        out.push(value === null ? 0 : mm(value));
      }
    }
    return out;
  }

  get extent() {
    return [this.origin[0], this.origin[1], this.origin[0] + this.width * this.cellSize, this.origin[1] + this.height * this.cellSize];
  }
}
