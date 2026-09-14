import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRuntimeSupport, componentNotes } from "../src/runtime-support.mjs";

// paths.mjs pins the workspace at import time, so SSWORLD_HOME has to move before anything that
// reaches it is imported -- static imports are hoisted and would pin the real ~/.ssworld.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-env-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");

async function compileScene(name, body) {
  await createProject(name, { template: "empty" });
  writeFileSync(path.join(projectDir(name), "scene.ssdl"), `Scene {\n  id: main\n${body}}\n`, "utf8");
  return () => compileNamed(name);
}

test("an Environment clock compiles, and a second writer of the sun direction does not", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // Positive: the clock alone owns the sun, and a DirectionalLight that only carries colour and
  // intensity is not a second writer.
  const clean = await compileScene("envClock",
    "  SkyAtmosphere { id: sky }\n"
    + "  Environment { id: clock; dateTime: \"2026-09-12T18:30:00+08:00\"; timeScale: 60; latitude: 22.6433; longitude: 113.938;"
    + " fogGetsColorFromAtmosphere: false }\n"
    + "  DirectionalLight { id: sun; atmosphereSunLight: true; intensity: 100000 }\n");
  await clean();

  // Negative: the same scene with the sun pinned by hand.
  const conflict = await compileScene("envClockConflict",
    "  SkyAtmosphere { id: sky }\n"
    + "  Environment { id: clock; dateTime: \"2026-09-12T18:30:00+08:00\" }\n"
    + "  DirectionalLight { id: sun; atmosphereSunLight: true; sunAzimuth: 120; sunElevation: 30 }\n");
  await assert.rejects(conflict, (error) => {
    const text = `${error.message} ${JSON.stringify(error.problems ?? "")}`;
    assert.match(text, /multiple_writer/, "the refusal must carry its own code");
    assert.match(text, /sunAzimuthOverride/, "the refusal must name the way to pin the sun without losing the clock");
    return true;
  });
});

test("the sun-direction conflict is reported from the IR whichever component declares it", () => {
  const environment = { id: "clock", parent: "main", type: "Environment", properties: [] };
  const pinned = { id: "sun", parent: "main", type: "DirectionalLight",
    properties: [{ property: "atmosphereSunLight", value: true }, { property: "sunAzimuth", value: 120 }] };
  const sunSky = { id: "sun-sky", parent: "main", type: "SunSky",
    properties: [{ property: "solarTime", value: 17.5 }] };

  assert.deepEqual(checkRuntimeSupport({ nodes: [environment, pinned] }).map((item) => item.code),
    ["multiple_writer"]);
  assert.deepEqual(checkRuntimeSupport({ nodes: [environment, sunSky] }).map((item) => item.code),
    ["multiple_writer"]);
  // Each alone is fine, and so is an Environment beside a light that does not pin the sun.
  assert.deepEqual(checkRuntimeSupport({ nodes: [environment] }), []);
  assert.deepEqual(checkRuntimeSupport({ nodes: [pinned] }), []);
  assert.deepEqual(checkRuntimeSupport({ nodes: [environment, { id: "sun", parent: "main",
    type: "DirectionalLight", properties: [{ property: "intensity", value: 100000 }] }] }), []);
  // The scene-global slot takes exactly one claimant.
  assert.deepEqual(checkRuntimeSupport({ nodes: [environment, { ...environment, id: "clock2" }] })
    .map((item) => item.code), ["environment_duplicate"]);
});

test("Environment and SunSky carry the notes that keep an author out of the clock traps", () => {
  const environment = componentNotes("Environment").runtime_note;
  assert.match(environment, /ISO-8601 WITH an offset/);
  assert.match(environment, /timeScale: 3600 runs an hour a second/);
  assert.match(environment, /multiple_writer/);
  const sunSky = componentNotes("SunSky").runtime_note;
  assert.match(sunSky, /no Year/);
  assert.match(sunSky, /timeScale 0/);
});

// The cloud note is assembled from two policies.  They were briefly two separate `if (name ===
// "VolumetricCloud")` branches, so the second one was unreachable and the material half never
// reached the catalog -- with every other test still green.
test("the VolumetricCloud note carries both the unit trap and the UE material naming", () => {
  const cloud = componentNotes("VolumetricCloud").runtime_note;
  assert.match(cloud, /KILOMETRES|kilometres/);
  assert.match(cloud, /HightFrequencyNoiseAmount/, "the UE spelling is the whole point of the material half");
  assert.match(cloud, /Environment\.cloudCoverage/);
});
