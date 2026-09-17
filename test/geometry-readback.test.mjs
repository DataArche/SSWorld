import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TOOLS } from "../src/server.mjs";
import { TEMPLATE_ROOT } from "../src/paths.mjs";

// The measurement itself is exercised against the runtime in src/ssdl/tests (geometryRead with a
// tracked scene graph); this file pins the tool surface and the project-owned page handler.
test("the geometry readback is a cheap read-only tool with the measurement vocabulary in its contract", () => {
  const tool = TOOLS.find((item) => item.name === "ssworld_geometry_read");
  assert.ok(tool, "ssworld_geometry_read is missing");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["client", "detail", "ids", "overlaps", "project", "timeout_ms", "tolerance_m"]);
  assert.deepEqual(tool.inputSchema.properties.detail.enum, ["full", "brief"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const word of ["dimensions", "world box", "overlaps", "volume_m3", "centred on its position", "page_probe_unavailable"]) {
    assert.match(tool.description, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `description names ${word}`);
  }
});

test("the page template answers geometry_read from the mounted runtime", () => {
  const page = readFileSync(path.join(TEMPLATE_ROOT, "index.html"), "utf8");
  assert.match(page, /command\.kind === "geometry_read"/);
  assert.match(page, /runtime\.geometryRead\(params \|\| \{\}\)/, "the page forwards ids/overlaps/detail to the runtime unchanged");
  assert.match(page, /code: "geometry_unavailable"/, "an unmounted module is a named failure, not a crash");
});

test("the server instructions send a size or collision question to the measurement, not to a screenshot", async () => {
  const { INSTRUCTIONS } = await import("../src/server.mjs");
  assert.match(INSTRUCTIONS, /ssworld_geometry_read/);
  assert.match(INSTRUCTIONS, /centred on its position/);
});
