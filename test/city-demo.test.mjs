// The demo chain, played headlessly: the same calls the browser demo makes, checked on the numbers
// that have to move. If this is green the page demo can still look wrong, but every step ran.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cityFixture } from "./city-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATASET = cityFixture(here);
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-city-demo-"));
process.env.SSWORLD_HOME = home;
const { prepareDemo, playDemo, demoDataset, DEMO_PROJECT } = await import("../src/city/demo.mjs");

test.after(() => rmSync(home, { recursive: true, force: true }));

test("the demo dataset ships with this copy", () => {
  const dataset = demoDataset();
  assert.ok(existsSync(path.join(dataset, "dataset.json")), `${dataset} carries no dataset.json`);
  assert.equal(path.resolve(dataset), path.resolve(DATASET), "the demo must use the fixture the tests use");
});

test("preparing the demo imports, compiles, and reuses an existing city instead of re-importing", async () => {
  const first = await prepareDemo({ project: "demoPrepare", dataset: DATASET });
  assert.equal(first.created, true);
  assert.ok(first.imported, "the first prepare must import");
  assert.equal(first.compile.ok, true);
  assert.ok(first.compile.native_objects > 0, "the city scene must compile to real objects");
  assert.equal(first.revision_index, 0, "a freshly imported city sits at its baseline");
  assert.ok(first.population_total > 0);

  const second = await prepareDemo({ project: "demoPrepare", dataset: DATASET });
  assert.equal(second.created, false);
  assert.equal(second.imported, null, "a second prepare must not re-import over an immutable baseline");
  assert.equal(second.revision, first.revision);
});

test("playing the chain moves every number it promises to move", async () => {
  const prepared = await prepareDemo({ project: "demoChain", dataset: DATASET });
  const { steps } = await playDemo({ directory: prepared.directory });
  assert.deepEqual(steps.map((step) => step.id),
    ["site", "traffic_baseline", "gate_closed", "rebuild_building", "river_rise", "evacuation"]);

  const [site, baseline, gate, rebuild, river, evacuation] = steps;

  // 1. M1: the site is here and it says what it does not know.
  assert.ok(site.counts.buildings > 0 && site.counts.roads > 0 && site.counts.portals > 0);
  assert.ok(site.data_gaps > 0, "this dataset has known gaps; the demo must report them rather than hide them");
  assert.ok(site.blocked_conclusions.length > 0, "a gap must name what it blocks");

  // 2. M2: the demand routes, and everyone is accounted for.
  assert.equal(baseline.conserved, true);
  assert.ok(baseline.counts.arrived > 0);
  assert.ok(baseline.route.distance_m > 0);
  assert.ok(baseline.samples > 1, "the run must carry samples, or the page has nothing to play back");

  // 3. M2: closing that door lengthens the trip; it does not delete it.
  assert.equal(gate.portal_id, baseline.gate.portal_id);
  assert.deepEqual(gate.invalidates, ["routing", "traffic"]);
  assert.ok(gate.route_after_m !== null, "closing one gate must not orphan the trip in this dataset");
  assert.ok(gate.route_after_m > gate.route_before_m,
    `the detour must be longer: ${gate.route_before_m} -> ${gate.route_after_m}`);
  assert.ok(gate.detour_m > 0);
  assert.equal(gate.conserved, true);
  assert.equal(gate.scene_changed, true, "the closed gate has to reach the display");

  // 4. M4: an appearance swap is an appearance swap.
  assert.deepEqual(rebuild.invalidates, ["display"]);
  assert.equal(rebuild.travellers_moved, false, "rebuilding a model must not move a single traveller");
  assert.equal(rebuild.scene_changed, true);
  for (const check of ["footprint_area", "position", "height", "survey_dimensions", "portals_clear", "no_neighbour_overlap"]) {
    assert.ok(rebuild.checks.includes(check), `the demo candidate is not checked for ${check}`);
  }

  // 5. M3: one metre of river, and the two kinds of victim kept apart.
  assert.equal(river.level_after_m - river.level_before_m, 1);
  assert.ok(river.area_after_m2 > river.area_before_m2,
    `the inundation must grow: ${river.area_before_m2} -> ${river.area_after_m2}`);
  assert.ok(river.closed_edges > 0, "a metre of water has to close streets");
  assert.equal(river.scene_changed, true, "a metre of water has to reach the display");
  assert.ok(river.isolated > 0 && river.cut_off_not_inundated >= 0);
  assert.ok(river.limitations.some((line) => /propagation time/.test(line)),
    "the static model's limits must travel with the result");

  // 6. M6: the hazard is imported, and the evacuation conserves people.
  assert.equal(evacuation.hazard_id, "slide-1");
  assert.equal(evacuation.population_closed, true, "an evacuation that loses people is not an evacuation");
  assert.ok(evacuation.population_total > 0);
  // The flood is still in force, so the closures the evacuation faces come from two causes; the demo
  // has to keep them apart rather than credit the landslide with the river's streets.
  assert.ok(evacuation.closures_by_cause.landslide > 0, "the activated extent must close something");
  assert.ok(evacuation.closures_by_cause.flood > 0, "the river from the previous step is still up");
  assert.ok(evacuation.exposed_buildings.length > 0, "buildings inside the extent must be named");
  const counted = evacuation.counts.arrived + evacuation.counts.stranded + (evacuation.counts.unassigned ?? 0)
    + evacuation.counts.not_departed + evacuation.counts.queued + evacuation.counts.traversing;
  assert.equal(counted, evacuation.population_total, "everyone must be somewhere at the end of the run");
  // Nobody is rounded into "incomplete": every person who did not reach a shelter carries a reason,
  // whether they were stranded en route or never had a reachable shelter to be assigned to.
  const accounted = evacuation.not_finished.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(accounted, evacuation.incomplete,
    `${evacuation.incomplete} did not finish but only ${accounted} carry a reason`);
  if (evacuation.incomplete > 0) {
    assert.ok(evacuation.not_finished.every((entry) => entry.reason && entry.reason !== "unknown"),
      JSON.stringify(evacuation.not_finished));
  }
  assert.ok(evacuation.limitations.some((line) => /failure timing/.test(line)),
    "an authored hazard extent has no failure timing and the result must say so");

  // The chain leaves the city past its baseline; that is what the CLI refuses to replay blindly.
  const after = await prepareDemo({ project: "demoChain", dataset: DATASET });
  assert.ok(after.revision_index > 0);
  assert.equal(after.project, "demoChain");
  assert.notEqual(DEMO_PROJECT, undefined);
});
