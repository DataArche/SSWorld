// Mesoscopic traffic: routed travellers, entry capacity, link storage and portal queues.
//
// Deliberately the smallest model that can answer "I moved the gate; what changed": every traveller
// has a route, every link admits a bounded number per second and holds a bounded number at once, and
// every portal is its own server. No car-following, no signals, no lane changes.
//
// The invariant the whole thing is built around is CONSERVATION: at every step
//     not_departed + queued + traversing + arrived + stranded == total
// A traveller that cannot move is stranded with a reason, never quietly dropped -- "the road cleared
// in 200 s" is easy to produce by losing people.
import { distance } from "./geo.mjs";
import { blockingFrom } from "./network.mjs";

export const TRAFFIC_SCHEMA = "SSWorldCityTraffic/1";
export const DEFAULT_STEP_S = 1;

const STATES = ["not_departed", "queued", "traversing", "arrived", "stranded"];

/** Expand demand rows into individual travellers with deterministic departure times. */
export function expandDemand(demand, { offset = 0 } = {}) {
  const travellers = [];
  for (const row of [...demand].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const count = Math.max(0, Math.round(row.count));
    const start = row.departure_start_s ?? 0;
    const end = Math.max(start, row.departure_end_s ?? start);
    for (let k = 0; k < count; k += 1) {
      travellers.push({
        index: travellers.length,
        id: `${row.id}#${k}`,
        demand_id: row.id,
        origin: row.origin_node,
        destination: row.destination_node,
        mode: row.mode || "walk",
        unit: row.unit || "person",
        depart_s: (count === 1 ? start : start + Math.floor((k * (end - start)) / count)) + offset + (row.departure_delay_s ?? 0),
        state: "not_departed",
        arc: null, arcEntered: 0, arcExit: 0, node: row.origin_node,
        routeIndex: 0, route: null, arrived_s: null, reason: null, reroutes: 0,
      });
    }
  }
  return travellers;
}

class LinkState {
  constructor(arc, network, mode) {
    this.arc = arc;
    this.capacity = network.entryCapacity(arc, mode);
    this.storage = network.storage(arc, mode);
    this.credit = 0;
    this.occupancy = 0;
    this.entered = 0;
    this.maxOccupancy = 0;
  }
}

/**
 * Run one traffic simulation.
 *
 * @param controls  [{ at_s, blocked_edges?, blocked_portals?, portal_state? }] applied at the first
 *                  step at or after at_s. Control changes REROUTE travellers that have not yet
 *                  entered a now-blocked arc; a traveller already on a link finishes it, which is
 *                  what physically happens and is reported rather than silently assumed.
 */
export function runTraffic(model, network, {
  demand = model.demand, horizon_s = 3600, step_s = DEFAULT_STEP_S, impact = null,
  blockedEdges = [], blockedPortals = [], blockedNodes = [], controls = [], collectSamples = 0,
  destinationServers = {}, capturePositions = 0,
} = {}) {
  const travellers = expandDemand(demand);
  const total = travellers.length;
  let blocked = blockingFrom(impact, { edges: blockedEdges, portals: blockedPortals, nodes: blockedNodes });
  const pendingControls = [...controls].sort((a, b) => a.at_s - b.at_s);
  const links = new Map();           // arc key -> LinkState
  const linkFor = (arc, travellerMode) => {
    const key = `${arc.key}\u0000${travellerMode}`;
    if (!links.has(key)) links.set(key, new LinkState(arc, network, travellerMode));
    return links.get(key);
  };
  const portalCredit = new Map();    // portal node -> accumulated service credit
  const portalQueueMax = new Map();
  const queues = new Map();          // node id -> traveller indices waiting (FIFO)
  // A destination that meters its own intake (a shelter door) holds a queue of its own: people who
  // reached it and have not been let in yet are AT the destination, not IN it.
  const destinationQueues = new Map();
  const destinationState = new Map(Object.entries(destinationServers).map(([node, server]) => [node,
    { rate_per_s: server.rate_per_s ?? Infinity, capacity: server.capacity ?? Infinity, admitted: 0, credit: 0, maxQueue: 0 }]));
  const samples = [];
  const appliedControls = [];

  const routeFor = (traveller, fromNode) => network.route(fromNode, traveller.destination, traveller.mode, { blocked });

  const strand = (traveller, reason) => {
    traveller.state = "stranded";
    traveller.reason = reason;
    traveller.arc = null;
  };

  const enqueue = (traveller) => {
    traveller.state = "queued";
    if (!queues.has(traveller.node)) queues.set(traveller.node, []);
    queues.get(traveller.node).push(traveller.index);
  };

  const reachDestination = (traveller, time) => {
    const server = destinationState.get(traveller.destination);
    if (!server) { traveller.state = "arrived"; traveller.arrived_s = time; return; }
    traveller.state = "queued";
    traveller.atDestination = true;
    if (!destinationQueues.has(traveller.destination)) destinationQueues.set(traveller.destination, []);
    destinationQueues.get(traveller.destination).push(traveller.index);
  };

  const startRoute = (traveller, time) => {
    const route = routeFor(traveller, traveller.node);
    if (!route) { strand(traveller, { code: "no_route", at_s: time, from_node: traveller.node, destination: traveller.destination }); return false; }
    if (!route.arcs.length) { reachDestination(traveller, time); return false; }
    traveller.route = route;
    traveller.routeIndex = 0;
    enqueue(traveller);
    return true;
  };

  const portalCapacityAt = (nodeId, travellerMode) => {
    const portal = network.portals.get(nodeId);
    if (!portal) return Infinity;
    const value = travellerMode === "car" ? portal.car_capacity_vehicle_s : portal.walk_capacity_person_s;
    return value === null || value === undefined ? Infinity : value;
  };

  let time = 0;
  let controlCursor = 0;
  for (; time <= horizon_s; time += step_s) {
    // --- controls at this sync point --------------------------------------------------------
    let rerouteNeeded = false;
    while (controlCursor < pendingControls.length && pendingControls[controlCursor].at_s <= time) {
      const control = pendingControls[controlCursor];
      controlCursor += 1;
      if (control.portal_state) for (const [id, state] of Object.entries(control.portal_state)) {
        network.portals.set(id, { ...network.portals.get(id), ...state });
      }
      blocked = blockingFrom(control.impact ?? impact, {
        edges: control.blocked_edges ?? blockedEdges, portals: control.blocked_portals ?? blockedPortals,
        nodes: control.blocked_nodes ?? blockedNodes,
      });
      appliedControls.push({ at_s: time, command_id: control.command_id ?? null, kind: control.kind ?? "control" });
      rerouteNeeded = true;
    }
    if (rerouteNeeded) {
      for (const traveller of travellers) {
        if (traveller.state !== "queued" && traveller.state !== "stranded") continue;
        if (traveller.atDestination) continue;
        const route = routeFor(traveller, traveller.node);
        if (!route) { if (traveller.state !== "stranded") strand(traveller, { code: "no_route_after_control", at_s: time, from_node: traveller.node, destination: traveller.destination }); continue; }
        if (traveller.state === "stranded") { traveller.state = "queued"; traveller.reason = null; enqueue(traveller); }
        if (!route.arcs.length) { reachDestination(traveller, time); continue; }
        if (!traveller.route || traveller.route.edge_ids.join(",") !== route.edge_ids.join(",")) traveller.reroutes += 1;
        traveller.route = route;
        traveller.routeIndex = 0;
      }
    }

    // --- departures --------------------------------------------------------------------------
    for (const traveller of travellers) {
      if (traveller.state === "not_departed" && traveller.depart_s <= time) startRoute(traveller, time);
    }

    // --- arrivals off links -------------------------------------------------------------------
    for (const traveller of travellers) {
      if (traveller.state !== "traversing" || traveller.arcExit > time) continue;
      const link = linkFor(traveller.arc, traveller.mode);
      link.occupancy -= 1;
      traveller.node = traveller.arc.to;
      traveller.arc = null;
      if (traveller.node === traveller.destination) { reachDestination(traveller, time); continue; }
      traveller.routeIndex += 1;
      if (!traveller.route || traveller.routeIndex >= traveller.route.arcs.length) {
        if (!startRoute(traveller, time)) continue;
      } else enqueue(traveller);
    }

    // --- service: admit queued travellers onto their next arc ---------------------------------
    for (const [node, server] of destinationState) {
      server.credit = Math.min(server.credit + server.rate_per_s * step_s, Math.max(1, server.rate_per_s * step_s));
      const queue = destinationQueues.get(node) ?? [];
      while (queue.length && server.credit >= 1) {
        if (server.admitted >= server.capacity) {
          // The door is full. Everyone still outside it is stranded with that reason rather than
          // being counted as sheltered.
          for (const index of queue.splice(0)) strand(travellers[index], { code: "destination_capacity_full", at_s: time, node, capacity: server.capacity });
          break;
        }
        const traveller = travellers[queue.shift()];
        if (traveller.state !== "queued") continue;
        server.credit -= 1;
        server.admitted += 1;
        traveller.state = "arrived";
        traveller.arrived_s = time;
      }
      server.maxQueue = Math.max(server.maxQueue, queue.length);
    }
    for (const [, link] of links) link.credit = Math.min(link.credit + link.capacity * step_s, Math.max(1, link.capacity * step_s));
    for (const node of [...queues.keys()].sort()) {
      const capacity = portalCapacityAt(node, "walk");
      if (capacity !== Infinity) portalCredit.set(node, Math.min((portalCredit.get(node) ?? 0) + capacity * step_s, Math.max(1, capacity * step_s)));
    }
    for (const node of [...queues.keys()].sort()) {
      const queue = queues.get(node);
      while (queue.length) {
        const traveller = travellers[queue[0]];
        if (traveller.state !== "queued") { queue.shift(); continue; }
        const arc = traveller.route?.arcs[traveller.routeIndex];
        // startRoute() puts the traveller back on its (possibly new) node queue itself, so nothing
        // has to be re-queued here; a route it returns never starts on a blocked arc.
        if (!arc) { queue.shift(); startRoute(traveller, time); continue; }
        if (network.arcBlocked(arc, blocked)) {
          // The next link closed while this traveller was waiting for it: re-route from where they
          // actually are. Counted, because "nothing changed" and "everybody found another way" must
          // not look the same in the result.
          queue.shift();
          traveller.reroutes += 1;
          startRoute(traveller, time);
          continue;
        }
        const link = linkFor(arc, traveller.mode);
        if (link.credit < 1 || link.occupancy >= link.storage) break;
        const isPortal = network.portals.has(node);
        if (isPortal) {
          const credit = portalCredit.get(node) ?? Infinity;
          if (credit < 1) break;
          if (credit !== Infinity) portalCredit.set(node, credit - 1);
        }
        queue.shift();
        link.credit -= 1;
        link.occupancy += 1;
        link.entered += 1;
        link.maxOccupancy = Math.max(link.maxOccupancy, link.occupancy);
        traveller.state = "traversing";
        traveller.arc = arc;
        traveller.arcEntered = time;
        traveller.arcExit = time + network.travelTime(arc, traveller.mode);
      }
      portalQueueMax.set(node, Math.max(portalQueueMax.get(node) ?? 0, queue.length));
    }

    if (collectSamples && (time % collectSamples === 0 || time + step_s > horizon_s)) {
      samples.push(sampleState(time, travellers, queues, links, capturePositions));
    }
    if (travellers.every((traveller) => traveller.state === "arrived" || traveller.state === "stranded")) { time += step_s; break; }
  }

  const counts = Object.fromEntries(STATES.map((state) => [state, travellers.filter((traveller) => traveller.state === state).length]));
  const conserved = STATES.reduce((sum, state) => sum + counts[state], 0) === total;
  const arrivals = travellers.filter((traveller) => traveller.state === "arrived").map((traveller) => traveller.arrived_s);
  return {
    schema_version: TRAFFIC_SCHEMA,
    total, counts, conserved, sim_time_s: Math.min(time, horizon_s + step_s), horizon_s, step_s,
    completed: counts.arrived, not_completed: total - counts.arrived,
    arrival_time_s: arrivals.length ? { min: Math.min(...arrivals), max: Math.max(...arrivals),
      mean: round(arrivals.reduce((sum, value) => sum + value, 0) / arrivals.length) } : null,
    stranded: groupStranded(travellers),
    reroutes: travellers.reduce((sum, traveller) => sum + traveller.reroutes, 0),
    links: [...links.values()].filter((link) => link.entered > 0).map((link) => ({
      edge_id: link.arc.edge_id, direction: link.arc.dir, entered: link.entered,
      max_occupancy: link.maxOccupancy, storage: link.storage === Infinity ? null : link.storage,
      entry_capacity_per_s: link.capacity === Infinity ? null : link.capacity,
    })).sort((a, b) => a.edge_id.localeCompare(b.edge_id) || a.direction.localeCompare(b.direction)),
    portal_queues: [...portalQueueMax.entries()].filter(([node]) => network.portals.has(node))
      .map(([node, max]) => ({ portal_id: node, max_queue: max })).sort((a, b) => a.portal_id.localeCompare(b.portal_id)),
    destinations: [...destinationState.entries()].map(([node, server]) => ({ node, admitted: server.admitted,
      capacity: server.capacity === Infinity ? null : server.capacity,
      rate_per_s: server.rate_per_s === Infinity ? null : server.rate_per_s,
      max_queue: server.maxQueue, waiting: (destinationQueues.get(node) ?? []).length })).sort((a, b) => a.node.localeCompare(b.node)),
    controls_applied: appliedControls,
    samples,
    travellers,
    limitations: [
      "mesoscopic: entry capacity, link storage and portal service only; no signals, lanes or car-following",
      "a traveller already on a link finishes it after a control closes that link",
    ],
  };
}

function sampleState(time, travellers, queues, links, capturePositions = 0) {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  for (const traveller of travellers) counts[traveller.state] += 1;
  // Display positions are a SAMPLE of the simulation, taken after the step has been computed. They
  // are never read back into it, so thinning them out cannot change a single flow number.
  const positions = [];
  if (capturePositions) {
    for (const traveller of travellers) {
      if (positions.length >= capturePositions) break;
      if (traveller.state !== "traversing" || !traveller.arc?.polyline) continue;
      const span = Math.max(1e-6, traveller.arcExit - traveller.arcEntered);
      const progress = Math.min(1, Math.max(0, (time - traveller.arcEntered) / span));
      const point = pointAlong(traveller.arc.polyline, progress);
      const profile = traveller.arc.elevation_profile_m;
      const z = profile?.length ? profile[Math.min(Math.round(progress * (profile.length - 1)), profile.length - 1)] : 0;
      positions.push([point[0], point[1], round(z)]);
    }
  }
  return {
    t_s: time, counts, ...(capturePositions ? { positions } : {}),
    occupancy: [...links.values()].filter((link) => link.occupancy > 0)
      .map((link) => ({ edge_id: link.arc.edge_id, direction: link.arc.dir, occupancy: link.occupancy })),
    queues: [...queues.entries()].filter(([, queue]) => queue.length > 0).map(([node, queue]) => ({ node, waiting: queue.length })),
  };
}

function groupStranded(travellers) {
  const groups = new Map();
  for (const traveller of travellers) {
    if (traveller.state !== "stranded") continue;
    const key = `${traveller.reason?.code}\u0000${traveller.origin}\u0000${traveller.destination}`;
    if (!groups.has(key)) groups.set(key, { code: traveller.reason?.code ?? "unknown", origin: traveller.origin, destination: traveller.destination, count: 0, demand_ids: new Set() });
    const group = groups.get(key);
    group.count += 1;
    group.demand_ids.add(traveller.demand_id);
  }
  return [...groups.values()].map((group) => ({ ...group, demand_ids: [...group.demand_ids].sort() }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** Traveller positions in local metres for the display layer. Sampling for display only -- it reads
 *  the simulation, it never feeds back into it. */
export function travellerPositions(result, { limit = 500 } = {}) {
  const out = [];
  for (const traveller of result.travellers) {
    if (out.length >= limit) break;
    if (traveller.state === "traversing" && traveller.arc?.polyline) {
      const span = Math.max(1e-6, traveller.arcExit - traveller.arcEntered);
      const progress = Math.min(1, Math.max(0, (result.sim_time_s - traveller.arcEntered) / span));
      out.push({ id: traveller.id, state: traveller.state, position: pointAlong(traveller.arc.polyline, progress) });
    }
  }
  return out;
}

function pointAlong(polyline, fraction) {
  let totalLength = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) totalLength += distance(polyline[i], polyline[i + 1]);
  let target = totalLength * fraction;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const segment = distance(polyline[i], polyline[i + 1]);
    if (target <= segment || i === polyline.length - 2) {
      const t = segment === 0 ? 0 : target / segment;
      return [round(polyline[i][0] + (polyline[i + 1][0] - polyline[i][0]) * t),
        round(polyline[i][1] + (polyline[i + 1][1] - polyline[i][1]) * t)];
    }
    target -= segment;
  }
  return polyline[polyline.length - 1];
}

const round = (value) => Math.round(value * 1000) / 1000;
