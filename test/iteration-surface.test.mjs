import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// paths.mjs resolves the workspace once at import time, so the home has to move first.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-iteration-home-"));
process.env.SSWORLD_HOME = home;
const { TOOLS, briefCapture, moduleRuntime } = await import("../src/server.mjs");

test.after(() => rmSync(home, { recursive: true, force: true }));

const FULL = {
  ok: true, project: "demo", capture_path: "/tmp/demo.png",
  receipt: { in_sync: true, staleness: [], capture_id: "demo/2026-09-12", captured_at: "2026-09-12T00:00:00.000Z",
    capture_path: "/tmp/demo.png", image_sha256: "a".repeat(64), image_bytes: 123456,
    source_digest: "sha256:b", compiled_source_digest: "sha256:b", scene_ir_digest: "sha256:c",
    page_scene_ir_digest: "sha256:c", page_generation: "4", engine_id: "32e8d76ff2d51b21", server_version: "0.9.8",
    client: { id: "c1", visibility: "visible", canvas: { width: 1280, height: 720 }, user_agent: "Mozilla/5.0 Chrome/140" },
    client_selection: "most_recent_visible", clients_connected: 1 },
  framing: { mode: "offscreen_render_at_requested_size", requested: { width: 800, height: 450 },
    output: { width: 800, height: 450 }, interactive_canvas: { width: 1280, height: 720, device_pixel_ratio: 1 },
    projection: { aspect: 1.7778, horizontal_fov_deg: 65, vertical_fov_deg: 40.6, note: "n".repeat(160) },
    scaling: "none", crop: null, interactive_view_restored: true, note: "n".repeat(280) },
  stats: { width: 800, height: 450, mean_luma: 88.5, luma: { p10: 4, p50: 80, p90: 190 },
    under_exposed_ratio: 0.11, over_exposed_ratio: 0.02, overexposed_ratio: 0.02,
    coverage: Object.fromEntries(["sky", "green", "grey", "warm", "cool", "white", "dark"].map((name, index) => [name, index / 10])),
    colormap_top: Array.from({ length: 8 }, (_, index) => ({ rgb: "#3366cc", share: index / 100 })),
    regions: { layout: "3x3 row-major, top-left first",
      cells: Array.from({ length: 9 }, () => ({ mean_rgb: [12, 34, 56], sky: 0.4, grey: 0.3, dark: 0.3 })) },
    distinct_colors: 4096, non_black_ratio: 0.9 },
  camera: { longitude: 114.0579, latitude: 22.5431, height: 150, heading: 12, pitch: -8, roll: 0, fov: 65,
    near_plane: 0.5, far_plane: 43000, source: "scene",
    requested: { longitude: 114.0579, latitude: 22.5431, height: 150, heading: 12, pitch: -8, fov: 65 },
    deviation: { fov: { requested: 65, effective: 65, ok: true }, heading_error_deg: 0, pitch_error_deg: 0, position_error_m: 0.5 } },
  runtime: { state: "ready", errors: [], hint: "", status_line: "x", user_agent: "chrome", canvas: { width: 1, height: 1 } },
  logic: { properties: { score: 3 } }, render_verified: true,
  reference_match: { status: "not_evaluated" }, verdict: "fine", next: { action: "judge_frame" },
};

test("detail: brief keeps what an iteration loop reads and drops the bulky blocks", () => {
  const brief = briefCapture(FULL);
  assert.equal(brief.verdict, "fine");
  assert.deepEqual(brief.next, FULL.next);
  assert.deepEqual(brief.runtime.errors, []);
  assert.equal(brief.runtime.state, "ready");
  assert.deepEqual(brief.stats.regions, FULL.stats.regions);
  assert.equal(brief.stats.mean_luma, 88.5);
  assert.equal(brief.capture_path, FULL.capture_path);
  assert.equal(brief.in_sync, true);
  assert.deepEqual(brief.logic, FULL.logic);
  for (const dropped of ["framing", "receipt", "camera"]) assert.equal(brief[dropped], undefined, `${dropped} must not survive brief`);
  assert.equal(brief.stats.coverage, undefined);
  assert.equal(brief.stats.colormap_top, undefined);
  // The point of the mode: it has to be much smaller, not just differently shaped.
  const ratio = JSON.stringify(brief).length / JSON.stringify(FULL).length;
  assert.ok(ratio < 0.6, `brief must be a real saving, got ${(ratio * 100).toFixed(0)}% of the full payload`);
});

test("a stale frame keeps its staleness in brief, because it changes what the frame means", () => {
  const brief = briefCapture({ ...FULL, receipt: { ...FULL.receipt, in_sync: false, staleness: ["page runs an older compile"] } });
  assert.equal(brief.in_sync, false);
  assert.deepEqual(brief.staleness, ["page runs an older compile"]);
});

test("moduleRuntime answers 'did the module load' from the page status alone", () => {
  const ready = moduleRuntime(path.join(home, "nowhere"), { state: "ready", errors: [], generation: "3" });
  assert.equal(ready.loaded, true);
  const failed = moduleRuntime(path.join(home, "nowhere"), { state: "failed", errors: [{ kind: "module_error", message: "boom" }] });
  assert.equal(failed.loaded, false);
  assert.equal(failed.errors.length, 1);
  // A binding that was refused and rolled back leaves the page mounted and running. Reporting it as
  // "not loaded" would erase the very distinction this tool exists to draw, so errors stay a separate axis.
  const bound = moduleRuntime(path.join(home, "nowhere"), { state: "ready", errors: [{ kind: "binding_error", message: "car.position: binding_commit_failed" }] });
  assert.equal(bound.loaded, true, "a rolled-back binding does not unmount the module");
  assert.equal(bound.errors.length, 1);
  const loading = moduleRuntime(path.join(home, "nowhere"), { state: "loading", errors: [] });
  assert.equal(loading.loaded, false);
  assert.equal(loading.state, "loading");
});

test("the environment probe is a tool of its own and the capture tool takes detail", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.ok(names.includes("ssworld_environment_read"), "the engine readback needs its own cheap tool");
  const capture = TOOLS.find((tool) => tool.name === "ssworld_capture_frame");
  assert.deepEqual(capture.inputSchema.properties.detail.enum, ["full", "brief"]);
  const environment = TOOLS.find((tool) => tool.name === "ssworld_environment_read");
  assert.equal(environment.annotations.readOnlyHint, true);
  assert.match(environment.description, /azimuth\/elevation/);
});
