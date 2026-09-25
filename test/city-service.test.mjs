// The city service: the append-only log that survives a crash, the loopback/token gate on writes,
// and the playback the preview page reads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cityFixture } from "./city-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATASET = cityFixture(here);
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-city-service-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir } = await import("../src/project.mjs");
const { importCity, commandCity, startRun, runFrame, forget, derive } = await import("../src/city/host.mjs");
const { CityStore } = await import("../src/city/store.mjs");
const { cityEndpoint, citySessionToken } = await import("../src/city/service.mjs");
const { applyCommand } = await import("../src/city/commands.mjs");

let counter = 0;
async function city() {
  const name = `citySvc${counter += 1}`;
  await createProject(name, { template: "empty" });
  const directory = projectDir(name);
  importCity(directory, DATASET);
  return { name, directory };
}

const PORT = 8880;
const local = (extra = {}) => ({ origin: `http://127.0.0.1:${PORT}`, remote: "127.0.0.1", port: PORT, ...extra });
const get = (route, params) => cityEndpoint(route, { method: "GET", query: new URLSearchParams(params), body: null, ...local() });
const post = (route, body, overrides = {}) => cityEndpoint(route, { method: "POST", query: new URLSearchParams(), body, ...local(overrides) });

test.after(() => rmSync(home, { recursive: true, force: true }));

test("the command log survives a lost revision file", async () => {
  const { directory } = await city();
  commandCity(directory, { command_id: "a", kind: "portal.close", params: { portal_id: "portal-01-a" } });
  const second = commandCity(directory, { command_id: "b", kind: "water.set_level", params: { water_id: "river-1", level_m: 11 } });
  const store = new CityStore(directory);
  const lost = path.join(store.revisionsDir, `${second.revision}.json`);
  assert.ok(existsSync(lost));
  unlinkSync(lost);
  forget(directory);

  const baseline = store.baseline().model;
  const recovered = store.recover((overrides, record) => applyCommand(overrides, { kind: record.kind, params: record.params, baseline }));
  assert.deepEqual(recovered.restored, [second.revision]);
  assert.equal(recovered.head.revision, second.revision);
  // The rebuilt revision means the same thing as the one that was lost.
  const state = derive(directory, second.revision);
  assert.equal(state.model.objects.portals.find((item) => item.id === "portal-01-a").open, false);
  assert.equal(state.flood.bodies[0].level_m, 11);
});

test("reads are open on loopback and writes need the session token", async () => {
  const { name, directory } = await city();
  const status = await get("status", { project: name });
  assert.equal(status.value.ok, true);
  assert.equal(status.value.imported, true);
  assert.equal(status.value.token, citySessionToken());

  const noToken = await post("command", { project: name, kind: "portal.close", params: { portal_id: "portal-01-a" } });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.value.error, "session_token_invalid");

  const crossOrigin = await post("command", { project: name, token: citySessionToken(), kind: "portal.close",
    params: { portal_id: "portal-01-a" } }, { origin: "https://elsewhere.example" });
  assert.equal(crossOrigin.value.error, "origin_not_allowed");

  const remote = await post("command", { project: name, token: citySessionToken(), kind: "portal.close",
    params: { portal_id: "portal-01-a" } }, { remote: "192.168.1.20" });
  assert.equal(remote.value.error, "remote_not_loopback");

  const allowed = await post("command", { project: name, token: citySessionToken(), kind: "portal.close", params: { portal_id: "portal-01-a" } });
  assert.equal(allowed.value.ok, true);
  assert.equal(allowed.value.revision, "rev-0001");
  assert.equal(new CityStore(directory).log().length, 1, "a refused write must not reach the log");
});

test("an unknown project and an unknown object answer without guessing", async () => {
  const missing = await get("status", { project: "noSuchProject" });
  assert.equal(missing.status, 404);
  assert.equal(missing.value.error, "project_not_found");
  const { name } = await city();
  const unknown = await get("query", { project: name, id: "building-99" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.value.code, "object_not_found");
});

test("the page plays a run back one sample at a time, in scene coordinates", async () => {
  const { name, directory } = await city();
  const run = startRun(directory, { kind: "traffic", horizon_s: 6000, sample_interval_s: 120, display_rows: 120 });
  assert.ok(run.result.samples.length > 3);

  const first = runFrame(directory, { cursor: 0 });
  assert.equal(first.run_id, run.run_id);
  assert.equal(first.t_s, 0);
  assert.equal(first.closed, false);
  assert.deepEqual(first.batch, { id: "travellerBatch", rows: 480 });

  const middle = runFrame(directory, { cursor: 3 });
  assert.ok(middle.positions.length > 0, "the middle of the run must have people on the network");
  assert.ok(middle.positions.length <= 120, "display sampling is capped by display_rows");
  // Positions arrive in the SCENE frame (origin at the site centre), so the page does no geometry.
  const origin = run.scene_origin_m;
  assert.deepEqual(origin, [500, 500]);
  for (const [x, y] of middle.positions) {
    assert.ok(Math.abs(x) <= 520 && Math.abs(y) <= 520, `${x},${y} is outside the site`);
  }
  // The last cursor stops instead of wrapping, so a page that keeps polling sits on the final frame.
  const end = runFrame(directory, { cursor: 10_000 });
  assert.equal(end.closed, true);
  assert.equal(end.next_cursor, end.sample_index);

  const served = await get("run_frame", { project: name, cursor: "3" });
  assert.equal(served.value.ok, true);
  assert.equal(served.value.t_s, middle.t_s);
});

test("the generated page logic reads the service and writes the batch it was given", async () => {
  const { directory } = await city();
  const logic = readFileSync(path.join(directory, "logic.mjs"), "utf8");
  assert.match(logic, /export function createHostInterfaces/);
  assert.match(logic, /City: \{ select/);
  assert.match(logic, /__ssworld\/city/);
  assert.match(logic, /api\.instances\.set/);
  // The city panel is appended to the template's control panel, never swapped for it: the runtime
  // writes #logical-state and #hint into that panel and a replacement kills the mount.
  assert.match(logic, /host\.appendChild\(node\)/);
  assert.doesNotMatch(logic, /control-panel"\)\.innerHTML/);
  // A second run on the same revision must play from its own first sample: run_frame CLAMPS a
  // cursor past the end, so an inherited cursor makes a shorter run open already finished.
  assert.match(logic, /run\.run_id !== status\.run_id/);
  assert.match(logic, /cursor = 0;/);
  const contract = JSON.parse(readFileSync(path.join(directory, "host_interfaces.json"), "utf8"));
  assert.deepEqual(Object.keys(contract.City.methods), ["select"]);
});

test("the traveller batch is declared writable, not pre-filled", async () => {
  const { directory } = await (async () => {
    const found = await city();
    return found;
  })();
  const source = readFileSync(path.join(directory, "scene.ssdl"), "utf8");
  const declaration = source.match(/Instances \{ id: travellerBatch;[^}]*\}/)?.[0];
  assert.ok(declaration, "the scene must declare the traveller batch");
  // An explicit batch that SHIPS rows is a fixed placement, and the runtime refuses setRows on it
  // with "has a fixed placement". A batch pre-filled with parked rows therefore compiles, mounts,
  // renders and never moves -- which is exactly what happened before this check existed.
  assert.match(declaration, /placement: "explicit"/);
  assert.match(declaration, /positions: \[\]/);
  assert.doesNotMatch(declaration, /positions: \[\[/, "pre-filled rows make the batch unwritable");
  // The page is told a ceiling, not a row count, and writes only the rows a frame actually has.
  const manifest = JSON.parse(readFileSync(path.join(directory, "city", "scene-manifest.json"), "utf8"));
  assert.ok(manifest.traveller_batch.rows > 0 && manifest.traveller_batch.rows <= 512);
  const logic = readFileSync(path.join(directory, "logic.mjs"), "utf8");
  assert.doesNotMatch(logic, /catch \(_\) \{\}\s*\n\s*\}\s*\n\s*const element/, "a refused batch write must be reported, not swallowed");
  assert.match(logic, /display layer refused/);
});
