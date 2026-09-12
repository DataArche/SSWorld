import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// paths.mjs resolves the workspace once at import time, so the home has to move first.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-game-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");

async function compileScene(name, scene) {
  await createProject(name, { template: "empty" });
  writeFileSync(path.join(projectDir(name), "scene.ssdl"), scene, "utf8");
  return compileNamed(name);
}

// Everything a small game needs that used to be inexpressible: keyboard input, a distance test,
// and a deterministic per-instance variation.
const GAME = `Scene {
  id: main
  property length carX: 0
  property length carY: 0
  property length gateX: 40
  property real throttle: 0
  property real hits: 0
  KeyHandler { id: kThrust; key: "ArrowUp"; onPressed: { throttle = 1; } onReleased: { throttle = 0; } }
  KeyHandler { id: kBoost; key: " " }
  State { id: passing; name: "passing"; when: hypot(carX - gateX, carY) < 4 }
  State { id: boosting; name: "boosting"; when: kBoost.pressed }
  Box { id: car; width: 4; depth: 2; height: 1.4; position: [carX, carY, 0.7] }
  Box { id: flame; width: 1; depth: 1; height: 1; visible: kThrust.pressed
    position: [carX - 3, carY, 0.5 + hash01(hits) * 0.4] }
  CameraView { id: v; position: [0, -40, 18]; lookAt: [0, 0, 2] }
  Camera { id: cam; initialView: v }
}
`;

test("keyboard, distance and deterministic variation all compile into one small game", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await compileScene("neonGame", GAME);
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result));
  // Two KeyHandlers cost no native object: they are page listeners, not scene nodes.
  const control = await compileScene("neonGameNoKeys", GAME
    .replace(/  KeyHandler \{[^\n]*\n/g, "")
    .replace("when: kBoost.pressed", "when: false")
    .replace("visible: kThrust.pressed", "visible: true"));
  assert.equal(control.ok, true, JSON.stringify(control.problems ?? control));
  assert.equal(result.usage.native_objects.used, control.usage.native_objects.used);
  // onPressed/onReleased are ordinary handlers and land in the existing handler budget.
  assert.equal(result.usage.handlers.used - control.usage.handlers.used, 2);
});

// Units are fixed-point lanes now, not dimensions. A squared distance was the thing the old rule made
// impossible to write at all -- no scene could express "did I hit it" without hypot -- so this is the
// gate that keeps it writable.
test("a squared distance compiles: length x length is no longer refused", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const squared = await compileScene("neonSquare",
    GAME.replace("hypot(carX - gateX, carY) < 4", "(carX - gateX) * (carX - gateX) + carY * carY < 16"));
  assert.equal(squared.ok, true, JSON.stringify(squared.problems ?? squared));
  const withSqrt = await compileScene("neonRoot",
    GAME.replace("hypot(carX - gateX, carY) < 4", "sqrt((carX - gateX) * (carX - gateX)) < 4"));
  assert.equal(withSqrt.ok, true, JSON.stringify(withSqrt.problems ?? withSqrt));
});

test("KeyHandler.pressed is read-only, so a handler cannot fake input", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await assert.rejects(
    () => compileScene("neonFakeInput", GAME.replace("onPressed: { throttle = 1; }", "onPressed: { kBoost.pressed = true; }")),
    (error) => /readonly|read_only|not_writable|assignment/.test(`${error.message} ${JSON.stringify(error.problems ?? "")}`));
});

test("the page loads the same interpreter bytes the compiler does", async () => {
  // The packaged page loads ssdl/engine-support/expression-runtime.js.  That copy used to come from the
  // engine build directory, so a new operator could pass the compiler's byte-equality gate (which only
  // covers compiler/src and the two gateway mirrors) and still die as invalid_expression in the browser.
  const { readFileSync, existsSync } = await import("node:fs");
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const pkg = path.resolve(here, "../../dist/ssworld-mcp");
  if (!existsSync(pkg)) return; // built package only; the source tree has no engine-support directory
  for (const [shipped, canonical] of [
    ["ssdl/engine-support/expression-runtime.js", "ssdl/compiler/src/expression-runtime.js"],
    ["ssdl/engine-support/integer-codec.js", "ssdl/compiler/generated/integer-codec.js"],
  ]) {
    assert.deepEqual(readFileSync(path.join(pkg, shipped)), readFileSync(path.join(pkg, canonical)),
      `${shipped} must be byte-identical to ${canonical}`);
  }
});
