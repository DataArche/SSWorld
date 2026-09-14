import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRuntimeSupport, componentNotes, memberNotes, CLOUD_KM_MEMBERS } from "../src/runtime-support.mjs";

// paths.mjs resolves the workspace once at import time, so the home has to move first -- and a STATIC
// import of anything that reaches paths.mjs (catalog.mjs does) is hoisted above this line and pins the
// real ~/.ssworld before the test ever runs. Everything downstream of paths.mjs is imported dynamically.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-cloud-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");
const { catalogComponent } = await import("../src/catalog.mjs");

async function compileScene(name, body) {
  await createProject(name, { template: "empty" });
  writeFileSync(path.join(projectDir(name), "scene.ssdl"), `Scene {\n  id: main\n${body}}\n`, "utf8");
  return () => compileNamed(name);
}

test("a cloud deck written in metres is refused by the real compile", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // The exact two-step an agent walks: metres for the deck, then metres again for the trace that was
  // supposed to reach it. Either half on its own must already be red.
  const run = await compileScene("cloudMetres",
    "  SkyAtmosphere { id: sky }\n"
    + "  VolumetricCloud { id: clouds; layerBottomAltitude: 1800; layerHeight: 500; tracingMaxDistance: 50000 }\n");
  await assert.rejects(run, (error) => {
    const text = `${error.message} ${JSON.stringify(error.problems ?? "")}`;
    assert.match(text, /cloud_kilometres_expected/, "the refusal must carry its own code");
    assert.match(text, /KILOMETRES/, "the refusal must name the unit");
    assert.match(text, /1\.8/, "the refusal must state the engine default it should have been near");
    assert.match(text, /streak/, "the refusal must say what the metre value does to the image");
    return true;
  });
});

test("every kilometre member is guarded, and the engine defaults themselves pass", () => {
  for (const [member, km] of Object.entries(CLOUD_KM_MEMBERS)) {
    const tooBig = [{ id: "clouds", parent: "main", type: "VolumetricCloud",
      properties: [{ property: member, value: km.max + 1 }] }];
    assert.deepEqual(checkRuntimeSupport({ nodes: tooBig }).map((item) => [item.code, item.property]),
      [["cloud_kilometres_expected", member]], `${member} must be refused above ${km.max} km`);

    const asShipped = [{ id: "clouds", parent: "main", type: "VolumetricCloud",
      properties: [{ property: member, value: km.engine }] }];
    assert.deepEqual(checkRuntimeSupport({ nodes: asShipped }), [], `${member} at the engine default must pass`);

    const ueDefault = [{ id: "clouds", parent: "main", type: "VolumetricCloud",
      properties: [{ property: member, value: km.ue }] }];
    assert.deepEqual(checkRuntimeSupport({ nodes: ueDefault }), [], `${member} at the UE default must pass`);
  }
});

test("a deck of zero thickness is refused, but a deck sitting on the ground is not", () => {
  const zeroHeight = [{ id: "clouds", parent: "main", type: "VolumetricCloud",
    properties: [{ property: "layerHeight", value: 0 }] }];
  assert.deepEqual(checkRuntimeSupport({ nodes: zeroHeight }).map((item) => item.code), ["value_out_of_range"]);

  const groundDeck = [{ id: "clouds", parent: "main", type: "VolumetricCloud",
    properties: [{ property: "layerBottomAltitude", value: 0 }] }];
  assert.deepEqual(checkRuntimeSupport({ nodes: groundDeck }), []);
});

test("skyLightCloudBottomOcclusion is a 0..1 scalar in the catalog, the way UE and the engine have it", () => {
  const contract = catalogComponent("VolumetricCloud").contract;
  assert.equal(contract.members.skyLightCloudBottomOcclusion.value_type, "scalar",
    "the engine reads it as a float and renders visibility = 1 - it; a boolean would collapse it to two stops");
  assert.equal(contract.members.usePerSampleAtmosphericLightTransmittance.value_type, "boolean",
    "the one member that really is a switch stays a switch");
  assert.match(memberNotes("VolumetricCloud", "skyLightCloudBottomOcclusion", {}).note, /not a switch/);

  const outOfRange = [{ id: "clouds", parent: "main", type: "VolumetricCloud",
    properties: [{ property: "skyLightCloudBottomOcclusion", value: 1.5 }] }];
  assert.deepEqual(checkRuntimeSupport({ nodes: outOfRange }).map((item) => item.code), ["value_out_of_range"]);
  const half = [{ id: "clouds", parent: "main", type: "VolumetricCloud",
    properties: [{ property: "skyLightCloudBottomOcclusion", value: 0.5 }] }];
  assert.deepEqual(checkRuntimeSupport({ nodes: half }), []);
});

test("the catalog tells the author the unit that the unit field cannot say", () => {
  const contract = catalogComponent("VolumetricCloud");
  assert.match(contract.runtime_note, /KILOMETRES/);
  assert.match(contract.runtime_note, /SkyAtmosphere/, "the planet-centre fallback belongs on the component");
  for (const member of Object.keys(CLOUD_KM_MEMBERS)) {
    const note = contract.contract.members[member].note ?? memberNotes("VolumetricCloud", member, {}).note;
    assert.match(note, /KILOMETRES/, `${member} must carry its unit`);
    assert.match(note, /UE default/, `${member} must state the UE default it is aligned with`);
  }
  assert.match(memberNotes("VolumetricCloud", "viewSampleCountScale", {}).note, /does NOT grow with tracingMaxDistance/);
  assert.equal(componentNotes("ExponentialHeightFog").runtime_note, undefined, "the note is the cloud's, not every environment component's");
});
