// The routable network: building exit -> parcel internal path -> parcel portal -> public street.
//
// Routing is ARC-based rather than node-based, because the things this city can change are turns and
// gates, not just links: a portal that only lets people out, and a turn restriction at a junction,
// are both "you may leave by this arc only if you arrived by that one", which a node-based Dijkstra
// cannot express. The extra state costs nothing at this size and means portal.set { direction: "out" }
// is a routing fact rather than a label.
import { distance } from "./geo.mjs";

export const NETWORK_SCHEMA = "SSWorldCityNetwork/1";

/** Pedestrian links carry no storage figure in the dataset, so one is DERIVED and declared here
 *  rather than invented per call site. 1.5 person/m of link is a crowded but walkable footway. */
export const PEDESTRIAN_STORAGE_PERSON_PER_M = 1.5;

const MODE_FIELDS = {
  walk: { speed: "walk_speed_mps", capacity: "walk_capacity_person_s", portalCapacity: "walk_capacity_person_s" },
  car: { speed: "car_speed_mps", capacity: "car_capacity_vehicle_s", portalCapacity: "car_capacity_vehicle_s" },
};

export class CityNetwork {
  /**
   * @param model    the city model (baseline objects + network)
   * @param options.portalState  id -> { open, direction, position, walk_capacity_person_s, ... } overrides
   */
  constructor(model, { portalState = {} } = {}) {
    this.model = model;
    this.nodes = new Map(model.network.nodes.map((node) => [node.id, node]));
    this.portals = new Map(model.objects.portals.map((portal) => {
      const override = portalState[portal.id] || {};
      return [portal.id, { ...portal, ...override }];
    }));
    this.edges = new Map(model.network.edges.map((edge) => [edge.id, edge]));
    this.arcs = new Map();
    this.outgoing = new Map();
    this.portalSides = new Map();   // portal node -> edge id -> "parcel" | "street" (lazy, see #mapPortalSides)
    for (const edge of model.network.edges) {
      this.#addArc(edge, "fwd", edge.from_node, edge.to_node);
      if (edge.bidirectional) this.#addArc(edge, "rev", edge.to_node, edge.from_node);
    }
    this.turnRestrictions = new Set((model.network.turn_restrictions || []).map((item) =>
      `${item.from_edge}\u0000${item.via_node}\u0000${item.to_edge}`));
  }

  #addArc(edge, dir, from, to) {
    const key = `${edge.id}:${dir}`;
    const profile = edge.elevation_profile_m || [];
    const arc = {
      key, edge_id: edge.id, dir, from, to, length_m: edge.length_m ?? distance(this.nodes.get(from).position, this.nodes.get(to).position),
      modes: edge.modes, bridge: edge.bridge, portal_id: edge.portal_id ?? null, kind: edge.kind,
      elevation_profile_m: dir === "fwd" ? profile : [...profile].reverse(),
      polyline: edge.polyline ? (dir === "fwd" ? edge.polyline : [...edge.polyline].reverse()) : null,
      storage_vehicles: edge.storage_vehicles,
      walk_speed_mps: edge.walk_speed_mps, car_speed_mps: edge.car_speed_mps,
      walk_capacity_person_s: edge.walk_capacity_person_s, car_capacity_vehicle_s: edge.car_capacity_vehicle_s,
    };
    this.arcs.set(key, arc);
    if (!this.outgoing.has(from)) this.outgoing.set(from, []);
    this.outgoing.get(from).push(arc);
  }

  supports(arc, mode) { return arc.modes.includes(mode); }

  speed(arc, mode) {
    const value = arc[MODE_FIELDS[mode].speed];
    if (!value || value <= 0) throw Object.assign(new Error(`edge '${arc.edge_id}' has no ${mode} speed`), { code: "network_speed_missing" });
    return value;
  }

  entryCapacity(arc, mode) {
    const value = arc[MODE_FIELDS[mode].capacity];
    return value === null || value === undefined ? Infinity : value;
  }

  storage(arc, mode) {
    if (mode === "car") return arc.storage_vehicles === null || arc.storage_vehicles === undefined ? Infinity : arc.storage_vehicles;
    return Math.max(1, Math.round(arc.length_m * PEDESTRIAN_STORAGE_PERSON_PER_M));
  }

  travelTime(arc, mode) { return arc.length_m / this.speed(arc, mode); }

  /** A portal node only lets certain movements through; other nodes are unrestricted junctions. */
  turnAllowed(fromArc, node, toArc) {
    if (fromArc && this.turnRestrictions.has(`${fromArc.edge_id}\u0000${node}\u0000${toArc.edge_id}`)) return false;
    const portal = this.portals.get(node);
    if (!portal) return true;
    if (portal.direction === "both" || !portal.direction) return true;
    // "in" = into the parcel only (street -> portal -> building side); "out" = the reverse.
    const inbound = fromArc ? this.#portalSide(fromArc, node) : null;
    const outbound = this.#portalSide(toArc, node);
    if (portal.direction === "in") return outbound === "parcel";
    if (portal.direction === "out") return outbound === "street" && (inbound === null || inbound === "parcel");
    return true;
  }

  /**
   * Which side of the portal an arc leads to: the parcel interior or the public street.
   *
   * Worked out from the graph, not from edge names. An internal path can run through several links
   * and bends before it reaches the door, so the parcel side is whichever incident arc reaches a
   * building_exit while staying on links that belong to THIS portal. A name test ("access-in") gets
   * this right for one dataset and silently wrong for the next one.
   */
  #portalSide(arc, portalNode) {
    if (!this.portalSides.has(portalNode)) this.portalSides.set(portalNode, this.#mapPortalSides(portalNode));
    return this.portalSides.get(portalNode).get(arc.edge_id) ?? "street";
  }

  #mapPortalSides(portalNode) {
    const portal = this.portals.get(portalNode);
    const sides = new Map();
    if (!portal) return sides;
    const internal = (arc) => arc.portal_id === portal.id;
    for (const start of this.outgoing.get(portalNode) ?? []) {
      if (!internal(start)) { sides.set(start.edge_id, "street"); continue; }
      // Walk the portal's own links away from the gate; if a building exit is on that side, it is
      // the parcel side.
      const seen = new Set([portalNode]);
      const stack = [start.to];
      let parcel = false;
      while (stack.length) {
        const node = stack.pop();
        if (seen.has(node)) continue;
        seen.add(node);
        if (this.nodes.get(node)?.kind === "building_exit") { parcel = true; break; }
        for (const next of this.outgoing.get(node) ?? []) if (internal(next)) stack.push(next.to);
      }
      sides.set(start.edge_id, parcel ? "parcel" : "street");
    }
    return sides;
  }

  nodeBlocked(nodeId, blocked) {
    if (blocked?.nodes?.has(nodeId)) return true;
    const portal = this.portals.get(nodeId);
    if (portal && portal.open === false) return true;
    return Boolean(blocked?.portals?.has(nodeId));
  }

  arcBlocked(arc, blocked) {
    if (blocked?.edges?.has(arc.edge_id)) return true;
    if (arc.portal_id && blocked?.portals?.has(arc.portal_id)) return true;
    if (arc.portal_id) {
      const portal = this.portals.get(arc.portal_id);
      if (portal && portal.open === false) return true;
    }
    return this.nodeBlocked(arc.from, blocked) || this.nodeBlocked(arc.to, blocked);
  }

  /**
   * Least travel-time path from origin to destination for one mode.
   * `blocked` carries Sets of edge / portal / node ids that must not be used.
   * Returns null when no route exists; the caller decides whether that is a stranded traveller or a
   * refused command -- this never falls back to a straight line.
   */
  route(origin, destination, mode = "walk", { blocked = null } = {}) {
    if (!this.nodes.has(origin)) throw Object.assign(new Error(`unknown origin node '${origin}'`), { code: "node_not_found" });
    if (!this.nodes.has(destination)) throw Object.assign(new Error(`unknown destination node '${destination}'`), { code: "node_not_found" });
    if (origin === destination) return { distance_m: 0, time_s: 0, edge_ids: [], arcs: [], nodes: [origin] };
    if (this.nodeBlocked(origin, blocked) || this.nodeBlocked(destination, blocked)) return null;

    const best = new Map();   // arc key -> cost
    const previous = new Map();
    const queue = [];
    const push = (arcKey, cost, from) => {
      if (best.has(arcKey) && best.get(arcKey) <= cost + 1e-12) return;
      best.set(arcKey, cost);
      previous.set(arcKey, from);
      queue.push({ arcKey, cost });
    };
    for (const arc of this.outgoing.get(origin) || []) {
      if (!this.supports(arc, mode) || this.arcBlocked(arc, blocked)) continue;
      if (!this.turnAllowed(null, origin, arc)) continue;
      push(arc.key, this.travelTime(arc, mode), null);
    }
    let goal = null, goalCost = Infinity;
    while (queue.length) {
      // Small graph: a linear scan beats a heap's bookkeeping and keeps the order deterministic.
      let index = 0;
      for (let i = 1; i < queue.length; i += 1) {
        if (queue[i].cost < queue[index].cost - 1e-12
          || (Math.abs(queue[i].cost - queue[index].cost) <= 1e-12 && queue[i].arcKey < queue[index].arcKey)) index = i;
      }
      const { arcKey, cost } = queue.splice(index, 1)[0];
      if (cost > best.get(arcKey) + 1e-12) continue;
      if (cost >= goalCost) break;
      const arc = this.arcs.get(arcKey);
      if (arc.to === destination) { goal = arcKey; goalCost = cost; continue; }
      if (this.nodeBlocked(arc.to, blocked)) continue;
      for (const next of this.outgoing.get(arc.to) || []) {
        if (next.edge_id === arc.edge_id) continue; // no U-turn on the same link
        if (!this.supports(next, mode) || this.arcBlocked(next, blocked)) continue;
        if (!this.turnAllowed(arc, arc.to, next)) continue;
        push(next.key, cost + this.travelTime(next, mode), arcKey);
      }
    }
    if (!goal) return null;
    const arcs = [];
    for (let key = goal; key; key = previous.get(key)) arcs.push(this.arcs.get(key));
    arcs.reverse();
    const nodes = [origin, ...arcs.map((arc) => arc.to)];
    return {
      distance_m: round(arcs.reduce((sum, arc) => sum + arc.length_m, 0)),
      time_s: round(goalCost),
      edge_ids: arcs.map((arc) => arc.edge_id),
      arcs, nodes,
    };
  }

  /** Nodes reachable from a set of origins under the current blocking, for "cut off but not flooded". */
  reachableFrom(origins, mode = "walk", { blocked = null } = {}) {
    const seen = new Set();
    const stack = [];
    for (const origin of origins) {
      if (!this.nodes.has(origin) || this.nodeBlocked(origin, blocked)) continue;
      seen.add(origin);
      stack.push({ node: origin, arc: null });
    }
    while (stack.length) {
      const { node, arc } = stack.pop();
      for (const next of this.outgoing.get(node) || []) {
        if (!this.supports(next, mode) || this.arcBlocked(next, blocked)) continue;
        if (!this.turnAllowed(arc, node, next)) continue;
        if (seen.has(next.to)) continue;
        seen.add(next.to);
        stack.push({ node: next.to, arc: next });
      }
    }
    return seen;
  }

  summary() {
    return { schema_version: NETWORK_SCHEMA, nodes: this.nodes.size, edges: this.edges.size, arcs: this.arcs.size,
      portals: this.portals.size, turn_restrictions: this.turnRestrictions.size,
      assumptions: { pedestrian_storage_person_per_m: PEDESTRIAN_STORAGE_PERSON_PER_M } };
  }
}

/** Blocking sets from an ImpactState plus any explicit ids. */
export function blockingFrom(impact, { edges = [], portals = [], nodes = [] } = {}) {
  return {
    edges: new Set([...(impact?.blockedEdgeIds() ?? []), ...edges]),
    portals: new Set([...(impact?.blockedPortalIds() ?? []), ...portals]),
    nodes: new Set(nodes),
  };
}

const round = (value) => Math.round(value * 1000) / 1000;
