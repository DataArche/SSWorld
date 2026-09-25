// M2: moving or closing a gate changes the route, the queues and the flow -- and nobody is lost
// doing it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cityFixture } from "./city-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATASET = cityFixture(here);
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-city-network-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir } = await import("../src/project.mjs");
const { importCity, commandCity, startRun, derive } = await import("../src/city/host.mjs");
const { importDataset } = await import("../src/city/dataset.mjs");
const { CityNetwork } = await import("../src/city/network.mjs");
const { runTraffic } = await import("../src/city/traffic.mjs");

const checks = JSON.parse(readFileSync(path.join(DATASET, "sample_checks.json"), "utf8"));
const model = importDataset(DATASET);

test.after(() => rmSync(home, { recursive: true, force: true }));

async function city(name) {
  await createProject(name, { template: "empty" });
  const directory = projectDir(name);
  importCity(directory, DATASET);
  return directory;
}

test("routes match the ones the dataset recorded for itself", () => {
  const open = new CityNetwork(model);
  const before = open.route("exit-01", "n-100-100", "walk");
  assert.deepEqual(before.edge_ids, checks.gate_close_route_before.edge_ids);
  assert.ok(Math.abs(before.distance_m - checks.gate_close_route_before.distance_m) < 0.05);

  const closed = new CityNetwork(model, { portalState: { "portal-01-a": { open: false } } });
  const after = closed.route("exit-01", "n-100-100", "walk");
  assert.deepEqual(after.edge_ids, checks.gate_close_route_after.edge_ids);
  assert.ok(Math.abs(after.distance_m - checks.gate_close_route_after.distance_m) < 0.05);
  assert.ok(after.distance_m > before.distance_m, "the detour must actually be longer");
});

// Building 01's people are bound for the north shelter node, and the B gate is the shorter way
// there -- so B is the gate this dataset's demand actually uses, and the one worth closing.
const GATE_IN_USE = "portal-01-b";
const GATE_IN_USE_LINK = "access-in-01-b-1";

test("a closed gate is not routed through and admits nobody", () => {
  const network = new CityNetwork(model, { portalState: { [GATE_IN_USE]: { open: false } } });
  const result = runTraffic(model, network, { horizon_s: 6000 });
  const throughGate = result.links.filter((link) => link.edge_id.includes("01-b"));
  assert.deepEqual(throughGate, [], "no traveller may enter a link behind a closed portal");
  assert.ok(result.links.some((link) => link.edge_id === "access-in-01-a"), "they must use the other gate instead");
  assert.equal(result.counts.arrived, result.total);
});

test("a one-way gate refuses the direction it is closed to", () => {
  const outbound = new CityNetwork(model, { portalState: { "portal-01-a": { direction: "out" } } });
  // Leaving through it is still allowed...
  assert.ok(outbound.route("exit-01", "n-100-100", "walk"));
  // ...arriving through it is not, so the return trip has to take the long way round.
  const inbound = outbound.route("n-100-100", "exit-01", "walk");
  assert.ok(inbound, "the building must still be reachable");
  assert.ok(!inbound.edge_ids.includes("access-in-01-a"), "an out-only gate cannot be entered");
});

test("everyone is accounted for at every step", () => {
  const network = new CityNetwork(model);
  const result = runTraffic(model, network, { horizon_s: 6000, collectSamples: 60 });
  assert.equal(result.conserved, true);
  assert.equal(result.total, checks.total_population);
  for (const sample of result.samples) {
    const sum = Object.values(sample.counts).reduce((total, value) => total + value, 0);
    assert.equal(sum, result.total, `people appear or vanish at t=${sample.t_s}`);
  }
  assert.equal(result.counts.arrived + result.counts.stranded, result.total);
});

test("a mid-run closure stops new entries and strands nobody silently", () => {
  const network = new CityNetwork(model);
  const baseline = runTraffic(model, network, { horizon_s: 6000 });
  const gateEntries = (result) => result.links.filter((link) => link.edge_id === GATE_IN_USE_LINK)
    .reduce((sum, link) => sum + link.entered, 0);
  assert.ok(gateEntries(baseline) > 0);

  const controlled = runTraffic(model, new CityNetwork(model), {
    horizon_s: 6000, collectSamples: 30,
    controls: [{ at_s: 120, kind: "portal.close", command_id: "c1", portal_state: { [GATE_IN_USE]: { open: false } } }],
  });
  assert.ok(gateEntries(controlled) < gateEntries(baseline), "the closure must cut entries through that gate");
  for (const sample of controlled.samples) {
    if (sample.t_s <= 120) continue;
    const onGate = sample.occupancy.filter((entry) => entry.edge_id === GATE_IN_USE_LINK);
    assert.ok(onGate.every((entry) => entry.occupancy >= 0));
  }
  // Nobody is deleted by the closure: whoever cannot use it is rerouted, and the totals still close.
  assert.equal(controlled.conserved, true);
  assert.equal(controlled.counts.arrived + controlled.counts.stranded, controlled.total);
  // The people who had not left yet take the other gate, which the baseline never used at all.
  const otherGate = (result) => result.links.filter((link) => link.edge_id === "access-in-01-a")
    .reduce((sum, link) => sum + link.entered, 0);
  assert.equal(otherGate(baseline), 0, "the baseline must not have used the other gate");
  assert.ok(otherGate(controlled) > 0, "after the closure they must arrive through the other gate");
  assert.ok(controlled.reroutes > 0, "somebody already on their way must have been re-routed");
  assert.deepEqual(controlled.controls_applied.map((item) => item.command_id), ["c1"]);
});

test("a run with a mid-run control replays to the same numbers", () => {
  const options = { horizon_s: 6000, collectSamples: 60,
    controls: [{ at_s: 300, kind: "portal.close", command_id: "c1", portal_state: { [GATE_IN_USE]: { open: false } } }] };
  const first = runTraffic(model, new CityNetwork(model), options);
  const second = runTraffic(model, new CityNetwork(model), options);
  assert.deepEqual(second.counts, first.counts);
  assert.deepEqual(second.links, first.links);
  assert.deepEqual(second.samples, first.samples);
  assert.equal(second.sim_time_s, first.sim_time_s);
});

test("a repeated command is recorded once and applied once", async () => {
  const directory = await city("cityNet1");
  const first = commandCity(directory, { command_id: "close-a", kind: "portal.close", params: { portal_id: "portal-01-a" } });
  assert.equal(first.replayed, false);
  assert.equal(first.revision, "rev-0001");
  const again = commandCity(directory, { command_id: "close-a", kind: "portal.close", params: { portal_id: "portal-01-a" } });
  assert.equal(again.replayed, true);
  assert.equal(again.applied_revision, "rev-0001");
  const { CityStore } = await import("../src/city/store.mjs");
  const store = new CityStore(directory);
  assert.equal(store.log().filter((entry) => entry.command_id === "close-a").length, 1);
  assert.equal(store.head().revision, "rev-0001");
});

test("a write against a stale revision is refused", async () => {
  const directory = await city("cityNet2");
  commandCity(directory, { command_id: "c-1", kind: "portal.close", params: { portal_id: "portal-01-a" } });
  assert.throws(() => commandCity(directory, { command_id: "c-2", kind: "portal.open",
    params: { portal_id: "portal-01-a" }, expected_revision: "rev-0000" }), (error) => error.code === "revision_stale");
});

test("moving a gate moves its access links, its length and the route", async () => {
  const directory = await city("cityNet3");
  const before = derive(directory).network.route("exit-01", "n-100-100", "walk");
  const moved = commandCity(directory, { command_id: "move-b", kind: "portal.move",
    params: { portal_id: "portal-01-b", position: [150, 170] } });
  assert.equal(moved.effect.moved_m, 50);
  assert.deepEqual(moved.effect.affected_edges.sort(), ["access-in-01-b-3", "access-out-01-b"]);
  const after = derive(directory, moved.revision);
  const edge = after.model.network.edges.find((item) => item.id === "access-out-01-b");
  assert.notEqual(edge.length_m, model.network.edges.find((item) => item.id === "access-out-01-b").length_m,
    "the link geometry must follow the gate, or the walk stays as long as it was");
  assert.deepEqual(edge.polyline[0], [150, 170]);
  // The A gate is untouched, so the shortest route through it is unchanged.
  assert.deepEqual(after.network.route("exit-01", "n-100-100", "walk").edge_ids, before.edge_ids);

  // A gate cannot be dropped in the middle of a block or across the river.
  assert.throws(() => commandCity(directory, { command_id: "move-bad", kind: "portal.move",
    params: { portal_id: "portal-01-a", position: [500, 500] } }), (error) => error.code === "portal_off_parcel");
});

test("a geometry command cannot be smuggled in as a mid-run control", async () => {
  const directory = await city("cityNet4");
  assert.throws(() => startRun(directory, { kind: "traffic", horizon_s: 600,
    controls: [{ at_s: 60, command: { kind: "portal.move", params: { portal_id: "portal-01-a", position: [150, 170] } } }] }),
  (error) => error.code === "control_not_applicable");
  // A closure is a control and is accepted.
  const run = startRun(directory, { kind: "traffic", horizon_s: 6000, sample_interval_s: 120,
    controls: [{ at_s: 60, command: { kind: "portal.close", params: { portal_id: "portal-01-a" } }, command_id: "ctl-1" }] });
  assert.equal(run.result.conserved, true);
  assert.deepEqual(run.inputs.controls.map((item) => item.kind), ["portal.close"]);
});

test("the parcel side of a gate is read off the graph, not off edge names", () => {
  const network = new CityNetwork(model, { portalState: { "portal-01-b": { direction: "out" } } });
  // portal-01-b's internal path runs exit-01 -> bend -> bend -> portal: three links and two junction
  // nodes before the door. A name test ("access-in") or a "the other end is a junction" test both
  // call that the street side and make an out-only gate behave like an open one.
  const leaving = network.route("exit-01", "n-100-100", "walk");
  assert.ok(leaving, "people must still be able to leave through an out-only gate");
  const entering = network.route("n-100-100", "exit-01", "walk");
  assert.ok(entering, "the building must still be reachable the long way round");
  assert.ok(!entering.edge_ids.some((id) => id.startsWith("access-in-01-b")),
    "an out-only gate must not be entered, however many links its internal path has");
  assert.ok(entering.edge_ids.includes("access-in-01-a"), "they come in through the other gate instead");
});
