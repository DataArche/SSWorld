import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// paths.mjs resolves the workspace once at import time, so the home has to move first.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-chase-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");

// A chase camera is the case that used to be inexpressible: CameraView's whole pose was create_only, so
// "a camera that follows the car" had to be written in page-side JS against cameraController().setView —
// which takes radians while every other camera entry point takes degrees.
const SCENE = `Scene {
  id: main
  property length carX: 0
  property length carY: 0
  property real carHeading: 0
  Box { id: car; width: 4; depth: 2; height: 1.4; position: [carX, carY, 0.7] }
  CameraView {
    id: chase
    position: [carX, carY - 12, 5]
    heading: carHeading
    pitch: -8
  }
  Camera { id: mainCamera; initialView: chase }
}
`;

async function compileScene(name, scene) {
  await createProject(name, { template: "empty" });
  writeFileSync(path.join(projectDir(name), "scene.ssdl"), scene, "utf8");
  return compileNamed(name);
}

test("a bound CameraView pose compiles into real bindings", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await compileScene("chaseCamera", SCENE);
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result));
  // Three bindings: the car body plus the camera's position and heading.  The control below pins the
  // camera pose to constants and must land two lower — that difference is the whole feature.
  assert.equal(result.usage.bindings.used, 3);
  const control = await compileScene("chaseCameraFixed",
    SCENE.replace("position: [carX, carY - 12, 5]", "position: [0, -12, 5]").replace("heading: carHeading", "heading: 0"));
  assert.equal(control.ok, true, JSON.stringify(control.problems ?? control));
  assert.equal(control.usage.bindings.used, 1);
});

test("create_only CameraView members still refuse a binding", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await assert.rejects(
    () => compileScene("chaseCameraLookAt", SCENE.replace("pitch: -8", "lookAt: [carX, carY, 1]")),
    (error) => {
      const text = `${error.message} ${JSON.stringify(error.problems ?? "")}`;
      assert.match(text, /binding_update_class_unsupported/, "lookAt stays a build-time member");
      return true;
    });
});
