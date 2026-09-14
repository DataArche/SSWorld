import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRuntimeSupport, componentNotes, memberNotes, SKY_LIGHT_POLICY, ENVIRONMENT_POLICY } from "../src/runtime-support.mjs";

// paths.mjs resolves the workspace once at import time, so the home has to move before anything that
// reaches it is imported -- a static import would be hoisted above this line and pin the real ~/.ssworld.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-skylight-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");

async function compileScene(name, body) {
  await createProject(name, { template: "empty" });
  writeFileSync(path.join(projectDir(name), "scene.ssdl"), `Scene {\n  id: main\n${body}}\n`, "utf8");
  return () => compileNamed(name);
}

test("realTimeCapture beside an Environment is refused by the real compile, not silently ignored", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = await compileScene("skyLightCapture",
    "  Environment { id: clock; dateTime: \"2026-09-13T18:30:00+08:00\" }\n"
    + "  SkyLight { id: ambient; realTimeCapture: false }\n");
  await assert.rejects(run, (error) => {
    const text = `${error.message} ${JSON.stringify(error.problems ?? "")}`;
    assert.match(text, /sky_light_capture_owned/, "the refusal must carry its own code");
    assert.match(text, /ignored/, "it must say the member would be a no-op, which is the whole reason to refuse");
    assert.match(text, /drop the Environment/, "it must name the way out");
    return true;
  });
});

test("a SkyLight without an Environment keeps realTimeCapture as an ordinary member", () => {
  const nodes = [{ id: "ambient", parent: "main", type: "SkyLight",
    properties: [{ property: "realTimeCapture", value: true }] }];
  assert.deepEqual(checkRuntimeSupport({ nodes }), [], "no Environment means nobody owns the capture");
});

test("only the false is refused; true stays writable beside an Environment", () => {
  // realTimeCapture: true is what an engine build predating the Environment-owns-the-capture change
  // still needs to hear, so refusing it would block the one spelling that works there. The false is
  // what asks for something it will not get.
  const scene = (value) => ({ nodes: [
    { id: "clock", parent: "main", type: "Environment", properties: [] },
    { id: "ambient", parent: "main", type: "SkyLight", properties: [{ property: "realTimeCapture", value }] },
  ]});
  assert.deepEqual(checkRuntimeSupport(scene(false)).map((item) => [item.code, item.node, item.property]),
    [["sky_light_capture_owned", "ambient", "realTimeCapture"]], "false must be refused");
  assert.deepEqual(checkRuntimeSupport(scene(true)), [], "true must stay writable");
});

test("a SkyLight that writes anything else is left alone beside an Environment", () => {
  const nodes = [
    { id: "clock", parent: "main", type: "Environment", properties: [] },
    { id: "ambient", parent: "main", type: "SkyLight", properties: [{ property: "intensity", value: 1.2 }] },
  ];
  assert.deepEqual(checkRuntimeSupport({ nodes }), [], "only the capture is owned, not the whole component");
});

test("the guidance says what the capture actually feeds and what it costs", () => {
  // The two facts an author cannot recover from a screenshot: the capture drives BOTH the diffuse
  // ambient and the sky reflection, and it is time-sliced so it trails a sudden change.
  assert.match(SKY_LIGHT_POLICY, /reflection/, "the policy must say the capture is also the sky reflection");
  assert.match(SKY_LIGHT_POLICY, /five frames/, "the policy must state the time-slice lag");
  assert.match(SKY_LIGHT_POLICY, /GGX/, "the policy must say the reflection mips are pre-convolved, not box-filtered");
  assert.match(SKY_LIGHT_POLICY, /sky_light_capture_owned/, "the policy must name the refusal an author will hit");
  assert.match(ENVIRONMENT_POLICY, /sky light/, "Environment's own note must disclose that it drives the sky light");

  const note = memberNotes("SkyLight", "realTimeCapture", { value_type: "boolean" });
  assert.match(note.runtime_writable, /refused while an Environment is declared/);
  assert.match(note.note, /engine default on/, "the member note must state the engine default");
  assert.match(SKY_LIGHT_POLICY, /defaults to ON/, "the policy must state that the capture is on unless someone turns it off");
  assert.match(componentNotes("SkyLight").runtime_note, /SkyLight is the ambient half/);
});
