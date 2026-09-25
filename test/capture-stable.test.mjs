import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TEMPLATE_ROOT } from "../src/paths.mjs";

// ssworld_capture_frame { stable } waits in the browser for the light to stop converging after a clock
// jump. The wait runs in the page, so it is lifted out of the template here and driven with a scripted
// luma series and a fake clock that advances one second per sample.
const page = readFileSync(path.join(TEMPLATE_ROOT, "index.html"), "utf8");
const source = page.match(/async function awaitStableLuma\(spec, S\) \{[\s\S]*?\n    \}\n/);
assert.ok(source, "the page must still define awaitStableLuma");

function run(series, spec = {}) {
  let now = 0, index = 0;
  const clock = { now: () => now };
  const S = { saveImage2Base64: (width, height) => ({ width, height }) };
  const shots = [];
  const awaitNativeFuture = async (future) => { shots.push(future); return { value: index < series.length ? "iVBORw0" : null }; };
  const pixelStats = async () => ({ mean_luma: series[index++] });
  const sleep = (resolve) => { now += 1000; resolve(); };
  const fn = new Function("awaitNativeFuture", "readByteArrayText", "pixelStats", "setTimeout", "Date",
    `${source[0]} return awaitStableLuma;`)(awaitNativeFuture, () => null, pixelStats, sleep, clock);
  return fn(spec, S).then((result) => ({ ...result, shots }));
}

test("a light still converging after a day -> night jump is waited out", async () => {
  // Measured shape: 26 -> 2 over ~30 s, then flat.
  const series = [26, 21.7, 17, 13, 9.5, 6.8, 4.6, 3.1, 2.4, 2.1, 2.05, 2.02, 2.0, 2.0, 2.0];
  const result = await run(series);
  assert.equal(result.stable, true);
  assert.deepEqual(result.samples.slice(-5), [2.1, 2.05, 2.02, 2.0, 2.0], "four quiet seconds, not the first quiet pair");
  assert.equal(result.waited_ms, 13000);
  assert.deepEqual(result.shots[0], { width: 160, height: 90 }, "samples are small frames, not full captures");
});

test("a scene that keeps changing is reported at the deadline, not refused", async () => {
  const series = Array.from({ length: 40 }, (_, i) => (i % 2 ? 40 : 60));
  const result = await run(series, { timeout_ms: 5000 });
  assert.equal(result.stable, false);
  assert.equal(result.waited_ms, 5000);
  assert.match(result.reason, /still spanned 0\.3 or more over the last 4 s after 5000 ms/);
});

test("a slow drift below tolerance per second is not taken for rest, and tolerance widens the gate", async () => {
  // 0.1 luma a second never moves 0.3 between neighbours, yet it is 3 luma over the 30 s the sky takes.
  const drift = Array.from({ length: 40 }, (_, i) => Number((30 - 0.1 * i).toFixed(2)));
  const slow = await run(drift);
  assert.equal(slow.stable, false);
  assert.equal(slow.waited_ms, 30000);
  const loose = await run(drift, { tolerance: 1 });
  assert.equal(loose.stable, true);
  assert.equal(loose.waited_ms, 4000);
});
