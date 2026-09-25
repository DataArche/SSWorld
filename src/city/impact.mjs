// One place where "this edge / portal / building is unusable" is recorded, whatever caused it.
//
// Causes are kept APART on purpose. When the river goes back down, the flood cause is cleared and
// whatever the landslide or an operator closed stays closed: a single boolean per edge cannot do
// that, and the version that tried always reopened a road that a human had shut.
export const IMPACT_SCHEMA = "SSWorldCityImpact/1";

export const CAUSES = Object.freeze({ FLOOD: "flood", LANDSLIDE: "landslide", MANUAL: "manual", PORTAL_CLOSED: "portal_closed" });

const KINDS = ["edges", "portals", "buildings", "nodes"];

export class ImpactState {
  constructor() {
    for (const kind of KINDS) this[kind] = new Map(); // id -> Map(cause -> detail)
  }

  /** Replace every entry this cause owns. Partial updates are not offered: a cause that recomputes
   *  must hand over its whole picture, or a stale closure outlives the condition that created it. */
  setCause(cause, { edges = [], portals = [], buildings = [], nodes = [] } = {}) {
    this.clearCause(cause);
    const add = (kind, entries, idField) => {
      for (const entry of entries) {
        const id = entry[idField];
        if (!id) continue;
        if (!this[kind].has(id)) this[kind].set(id, new Map());
        this[kind].get(id).set(cause, { cause, ...entry });
      }
    };
    add("edges", edges, "edge_id");
    add("portals", portals, "portal_id");
    add("buildings", buildings, "building_id");
    add("nodes", nodes, "node_id");
    return this;
  }

  clearCause(cause) {
    for (const kind of KINDS) {
      for (const [id, reasons] of this[kind]) {
        reasons.delete(cause);
        if (!reasons.size) this[kind].delete(id);
      }
    }
    return this;
  }

  reasons(kind, id) {
    return [...(this[kind].get(id)?.values() ?? [])];
  }

  /** Blocked = at least one reason whose status is not merely 'degraded' or 'unknown'. */
  blocked(kind, id) {
    return this.reasons(kind, id).some((reason) => reason.status === undefined || reason.status === "closed" || reason.status === "inundated");
  }

  blockedEdgeIds() {
    return [...this.edges.keys()].filter((id) => this.blocked("edges", id)).sort();
  }

  blockedPortalIds() {
    return [...this.portals.keys()].filter((id) => this.blocked("portals", id)).sort();
  }

  toJSON() {
    const out = { schema_version: IMPACT_SCHEMA };
    for (const kind of KINDS) {
      out[kind] = Object.fromEntries([...this[kind]].map(([id, reasons]) => [id, [...reasons.values()]]).sort((a, b) => a[0].localeCompare(b[0])));
    }
    return out;
  }
}

/** Landslide / any authored hazard extent -> the same reason sets a flood produces. */
export function hazardImpact(model, hazards) {
  const edges = [], buildings = [], portals = [];
  for (const hazard of hazards) {
    for (const edge of model.network.edges) {
      if (!edge.polyline) continue;
      if (lineTouches(edge.polyline, hazard.geometry)) {
        edges.push({ edge_id: edge.id, status: "closed", hazard_id: hazard.id, hazard_type: hazard.hazard_type,
          input_type: hazard.input_type, effective_at_s: hazard.effective_at_s ?? null });
      }
    }
    for (const building of model.objects.buildings) {
      if (pointIn(building.centroid, hazard.geometry) || building.geometry.coordinates[0].some((point) => pointIn(point, hazard.geometry))) {
        buildings.push({ building_id: building.id, status: "exposed", hazard_id: hazard.id, hazard_type: hazard.hazard_type });
      }
    }
    for (const portal of model.objects.portals) {
      if (pointIn(portal.position, hazard.geometry)) {
        portals.push({ portal_id: portal.id, status: "closed", hazard_id: hazard.id, hazard_type: hazard.hazard_type });
      }
    }
  }
  return { edges, buildings, portals };
}

import { lineIntersectsPolygon, pointInAnyPolygon } from "./geo.mjs";
const lineTouches = (line, geometry) => lineIntersectsPolygon(line, geometry);
const pointIn = (point, geometry) => pointInAnyPolygon(point, geometry);
