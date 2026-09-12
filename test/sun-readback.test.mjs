import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SSDL_ROOT, TEMPLATE_ROOT } from "../src/paths.mjs";

// The page probe turns the engine's sun vector back into the azimuth/elevation an author writes. It runs
// in the browser, so the arithmetic is verified here against the forward transform the runtime applies.
const page = readFileSync(path.join(TEMPLATE_ROOT, "index.html"), "utf8");
const globalScope = globalThis;
new Function(readFileSync(path.join(SSDL_ROOT, "runtime", "ssdl-builtins.js"), "utf8")).call(globalScope);
const { sunDirectionFromAnchor } = globalScope.SSEngineSSDLBuiltins.testing;

/** The inverse exactly as the page implements it, lifted out of the template so the two cannot drift. */
function readBack(anchor, direction) {
  const body = page.match(/const lon = anchor\.lon \* rad[\s\S]*?const azimuth = \(Math\.atan2\(east, north\) \* deg \+ 360\) % 360;/);
  assert.ok(body, "the page must still compute azimuth/elevation from the engine sun vector");
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const d = direction;
  return new Function("anchor", "d", "rad", "deg", "Math",
    `${body[0]} return { azimuth, elevation };`)(anchor, d, rad, deg, Math);
}

test("the engine sun vector reads back as the azimuth/elevation the scene asked for", () => {
  const anchors = [{ lon: 114.0579, lat: 22.5431, height: 150 }, { lon: -73.98, lat: 40.75, height: 10 }, { lon: 0, lat: 0, height: 0 }];
  for (const anchor of anchors) {
    for (const azimuth of [0, 45, 120, 217, 359]) {
      for (const elevation of [-20, 0, 18, 60, 89]) {
        const direction = sunDirectionFromAnchor(anchor, azimuth, elevation);
        const back = readBack(anchor, direction);
        assert.ok(Math.abs(back.elevation - elevation) < 1e-6,
          `elevation ${elevation} at ${anchor.lon},${anchor.lat} az ${azimuth} came back as ${back.elevation}`);
        const error = Math.abs(((back.azimuth - azimuth) % 360 + 540) % 360 - 180);
        assert.ok(error < 1e-6, `azimuth ${azimuth} came back as ${back.azimuth}`);
      }
    }
  }
});

test("a sun the engine moved comes back as a different angle, not as the requested one", () => {
  const anchor = { lon: 114.0579, lat: 22.5431, height: 150 };
  const moved = readBack(anchor, sunDirectionFromAnchor(anchor, 120, 70));
  assert.ok(Math.abs(moved.elevation - 18) > 1, "the readback must not echo the request");
});
