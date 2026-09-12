import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRuntimeSupport, memberNotes, SKY_SCATTERING_DEFAULTS } from "../src/runtime-support.mjs";

// paths.mjs resolves the workspace once at import time, so the home has to move first.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-sky-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");

async function compileScene(name, body) {
  await createProject(name, { template: "empty" });
  writeFileSync(path.join(projectDir(name), "scene.ssdl"), `Scene {\n  id: main\n${body}}\n`, "utf8");
  return () => compileNamed(name);
}

test("the scattering vectors that turn the sky orange-brown are refused by the real compile", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // The two ways an agent gets here: an evenly weighted "colour", and the raw physical coefficients.
  for (const [name, value] of [["skyNeutral", "[1, 1, 1]"], ["skyPhysical", "[0.0058, 0.0136, 0.0331]"]]) {
    const run = await compileScene(name, `  SkyAtmosphere { id: sky; rayleighScattering: ${value} }\n`);
    await assert.rejects(run, (error) => {
      const text = `${error.message} ${JSON.stringify(error.problems ?? "")}`;
      assert.match(text, /sky_scattering_refused/, "the refusal must name the sky policy");
      assert.match(text, /0\.175/, "the refusal must state the engine default it would overwrite");
      assert.match(text, /lightColor/, "the refusal must hand over the recipe that works");
      return true;
    });
  }
});

test("a bare SkyAtmosphere and its scalar knobs still compile", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = await compileScene("skyBare",
    "  SkyAtmosphere { id: sky; multiScatteringFactor: 1.0; rayleighScatteringScale: 0.04; mieAnisotropy: 0.8 }\n"
    + "  DirectionalLight { id: sun; atmosphereSunLight: true; sunAzimuth: 120; sunElevation: 18; lightColor: \"#ffd9a8\" }\n");
  const result = await run();
  assert.equal(result.ok, true);
});

test("every refused member is named, and the catalog explains each one", () => {
  const nodes = [{ id: "sky", parent: "main", type: "SkyAtmosphere",
    properties: Object.keys(SKY_SCATTERING_DEFAULTS).map((property) => ({ property, value: [1, 1, 1] })) }];
  const problems = checkRuntimeSupport({ nodes }).filter((item) => item.code === "sky_scattering_refused");
  assert.deepEqual(problems.map((item) => item.property).sort(), Object.keys(SKY_SCATTERING_DEFAULTS).sort());
  for (const member of Object.keys(SKY_SCATTERING_DEFAULTS)) {
    assert.match(memberNotes("SkyAtmosphere", member, {}).note, /orange-brown/);
  }
});

test("the colour-temperature note carries the measured multipliers, and only for lights", () => {
  assert.match(memberNotes("DirectionalLight", "temperature", {}).note, /3000K = \(1\.77, 0\.85, 0\.27\)/);
  assert.match(memberNotes("PointLight", "useTemperature", {}).note, /normalised to luminance/);
  assert.equal(memberNotes("PostProcessVolume", "temperature", {}), null);
});
