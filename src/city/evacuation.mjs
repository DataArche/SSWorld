// Evacuation: population groups -> capacity-constrained shelter assignment -> the same routed,
// queued traffic engine the everyday demand uses.
//
// Two things this refuses to do:
//   * make people disappear. Everyone is in exactly one of not_departed / queued / traversing /
//     arrived / stranded at every step, and a stranded person carries the reason (no route, shelter
//     full, hazard on the only path).
//   * report a completion time while anyone is unfinished. "Everyone evacuated by T" is only printed
//     when arrived == total.
import { runTraffic } from "./traffic.mjs";
import { blockingFrom } from "./network.mjs";

export const EVACUATION_SCHEMA = "SSWorldCityEvacuation/1";

/** Building -> the network node people leave it by, derived from the access links, not guessed. */
export function buildingExitNodes(model) {
  const exits = new Map();
  const exitKinds = new Set(model.network.nodes.filter((node) => node.kind === "building_exit").map((node) => node.id));
  for (const portal of model.objects.portals) {
    if (!portal.building_id) continue;
    for (const edge of model.network.edges) {
      if (edge.portal_id !== portal.id) continue;
      for (const end of [edge.from_node, edge.to_node]) {
        if (exitKinds.has(end)) {
          const current = exits.get(portal.building_id);
          if (!current || end < current) exits.set(portal.building_id, end);
        }
      }
    }
  }
  return exits;
}

/**
 * Assign people to shelters under capacity, nearest first by travel time on the CURRENT network.
 * Deterministic: buildings in id order, people one at a time, ties broken by shelter id.
 */
export function assignShelters(model, network, population, { blocked = null, mode = "walk", shelters = model.objects.shelters } = {}) {
  const exits = buildingExitNodes(model);
  const remaining = new Map(shelters.map((shelter) => [shelter.id, shelter.capacity_person ?? Infinity]));
  const assignments = [];
  const unassigned = [];
  const routeCache = new Map();

  const routeTo = (origin, shelter) => {
    const key = `${origin}\u0000${shelter.id}`;
    if (!routeCache.has(key)) {
      routeCache.set(key, shelter.node_id && origin ? network.route(origin, shelter.node_id, mode, { blocked }) : null);
    }
    return routeCache.get(key);
  };

  for (const group of [...population].sort((a, b) => String(a.building_id).localeCompare(String(b.building_id)))) {
    const origin = exits.get(group.building_id) ?? null;
    if (!origin) {
      unassigned.push({ building_id: group.building_id, group_id: group.group_id, count: group.count, reason: "no_exit_node" });
      continue;
    }
    const options = shelters.map((shelter) => ({ shelter, route: routeTo(origin, shelter) }))
      .filter((option) => option.route)
      .sort((a, b) => a.route.time_s - b.route.time_s || a.shelter.id.localeCompare(b.shelter.id));
    if (!options.length) {
      unassigned.push({ building_id: group.building_id, group_id: group.group_id, count: group.count, reason: "no_reachable_shelter", origin_node: origin });
      continue;
    }
    let left = Math.max(0, Math.round(group.count));
    for (const option of options) {
      if (left <= 0) break;
      const capacity = remaining.get(option.shelter.id);
      if (!(capacity > 0)) continue;
      const take = Math.min(left, capacity === Infinity ? left : capacity);
      remaining.set(option.shelter.id, capacity === Infinity ? Infinity : capacity - take);
      left -= take;
      assignments.push({ building_id: group.building_id, group_id: group.group_id, origin_node: origin,
        shelter_id: option.shelter.id, shelter_node: option.shelter.node_id, count: take,
        route_time_s: option.route.time_s, route_distance_m: option.route.distance_m,
        departure_delay_s: group.departure_delay_s ?? 0, mode: group.mode ?? mode });
    }
    if (left > 0) unassigned.push({ building_id: group.building_id, group_id: group.group_id, count: left, reason: "all_reachable_shelters_full", origin_node: origin });
  }
  return { assignments, unassigned,
    shelter_capacity: shelters.map((shelter) => ({ shelter_id: shelter.id, capacity_person: shelter.capacity_person,
      assigned: assignments.filter((item) => item.shelter_id === shelter.id).reduce((sum, item) => sum + item.count, 0) })) };
}

export function runEvacuation(model, network, {
  population, shelters = model.objects.shelters, impact = null, blockedEdges = [], blockedPortals = [],
  horizon_s = 7200, step_s = 1, departure_window_s = 0, mode = "walk", collectSamples = 0, capturePositions = 0,
} = {}) {
  const blocked = blockingFrom(impact, { edges: blockedEdges, portals: blockedPortals });
  const shelterExposure = [];
  // A shelter inside the hazard or behind a closed door is not a shelter. It is checked here with
  // the same availability the routing uses, so an unusable facility cannot absorb anybody.
  const usable = shelters.filter((shelter) => {
    const blockedNode = !shelter.node_id || blocked.nodes.has(shelter.node_id);
    const reasons = impact?.reasons("nodes", shelter.node_id) ?? [];
    if (blockedNode || reasons.length) {
      shelterExposure.push({ shelter_id: shelter.id, status: "unavailable", reasons: reasons.length ? reasons : [{ cause: "unreachable", detail: "no usable node" }] });
      return false;
    }
    return true;
  });

  const plan = assignShelters(model, network, population, { blocked, mode, shelters: usable });
  const demand = plan.assignments.map((assignment, index) => ({
    id: `evac-${String(index).padStart(3, "0")}-${assignment.building_id}-${assignment.shelter_id}`,
    origin_node: assignment.origin_node, destination_node: assignment.shelter_node,
    departure_start_s: assignment.departure_delay_s,
    departure_end_s: assignment.departure_delay_s + departure_window_s,
    count: assignment.count, unit: "person", mode: assignment.mode,
  }));

  const destinationServers = Object.fromEntries(usable.filter((shelter) => shelter.node_id).map((shelter) => [shelter.node_id, {
    rate_per_s: shelter.entry_capacity_person_s ?? Infinity, capacity: shelter.capacity_person ?? Infinity }]));

  const result = runTraffic(model, network, { demand, horizon_s, step_s, impact, blockedEdges, blockedPortals, collectSamples, capturePositions, destinationServers });

  const totalPopulation = population.reduce((sum, group) => sum + Math.round(group.count), 0);
  const unassignedCount = plan.unassigned.reduce((sum, item) => sum + item.count, 0);
  const closed = result.counts.arrived + result.counts.stranded + unassignedCount
    + result.counts.not_departed + result.counts.queued + result.counts.traversing === totalPopulation;

  return {
    schema_version: EVACUATION_SCHEMA,
    population_total: totalPopulation,
    assigned: demand.reduce((sum, row) => sum + row.count, 0),
    unassigned: plan.unassigned,
    unassigned_count: unassignedCount,
    shelters: plan.shelter_capacity,
    shelter_exposure: shelterExposure,
    counts: { ...result.counts, unassigned: unassignedCount },
    population_closed: closed,
    // Only a fully finished evacuation gets a completion time; a partial one gets the count instead.
    completion_time_s: result.counts.arrived === totalPopulation ? result.arrival_time_s?.max ?? null : null,
    incomplete: totalPopulation - result.counts.arrived,
    arrival_time_s: result.arrival_time_s,
    stranded: result.stranded,
    destinations: result.destinations,
    links: result.links,
    portal_queues: result.portal_queues,
    samples: result.samples,
    traffic: { total: result.total, conserved: result.conserved, sim_time_s: result.sim_time_s, horizon_s: result.horizon_s },
    limitations: [
      ...result.limitations,
      "people leave a building at one exit node; floor-by-floor egress is not modelled",
      "an authored hazard extent has no failure timing, so blocking is static for the whole run",
    ],
  };
}
