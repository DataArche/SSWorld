import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRuntimeSupport, TANGENT_CAPABLE_TYPES } from "../src/runtime-support.mjs";

// paths.mjs resolves the workspace once at import time, so the home has to move first.
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-tangent-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");

const MATERIAL = `  Texture { id: normalTex; source: "assets/normal.png" }
  PrincipledMaterial { id: surface; target: host; normalMap: normalTex; normalScale: 1.0 }
`;

/** Creates a real project, writes a real scene and runs the product's compile entry point. */
async function compileScene(name, hostDeclaration) {
  await createProject(name, { template: "empty" });
  const directory = projectDir(name);
  mkdirSync(path.join(directory, "assets"), { recursive: true });
  writeFileSync(path.join(directory, "assets", "normal.png"), Buffer.alloc(64, 7));
  writeFileSync(path.join(directory, "scene.ssdl"), `Scene {\n  id: main\n  ${hostDeclaration}\n${MATERIAL}}\n`, "utf8");
  return { directory, run: () => compileNamed(name) };
}

test("a normal map without tangent space fails the real compile", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Plane moved to the capable list when the native generator started authoring its (+X) tangent
  // frame, so the refused hosts are the primitives that still carry no TANGENT stream.
  for (const [name, host] of [
    ["tangentBox", "Box { id: host; width: 1; depth: 1; height: 1 }"],
    ["tangentSphere", "Sphere { id: host; radius: 1 }"],
  ]) {
    const { run } = await compileScene(name, host);
    await assert.rejects(run, (error) => {
      const text = `${error.message} ${JSON.stringify(error.problems ?? "")}`;
      assert.match(text, /material_requires_tangent/, "the refusal must name the tangent policy");
      return true;
    });
  }
});

test("a normal map on a generator that ships tangents compiles", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const heights = new Array(25).fill(0).join(", ");
  const { run } = await compileScene("tangentField", `HeightField { id: host; width: 4; depth: 4; columns: 4; rows: 4; heights: [${heights}] }`);
  const result = await run();
  assert.equal(result.ok, true);
  // Plane earned the same standing by authoring a real tangent stream, not by being exempted.
  const plane = await compileScene("tangentPlane", "Plane { id: host; width: 4; depth: 4 }");
  assert.equal((await plane.run()).ok, true);
});

// WaterMaterial needs the tangent basis for the same reason and fails the same way without it: the
// frame collapses to the geometric normal, so waveIntensity renders as a flat mirror.
test("WaterMaterial is gated on the same tangent frame as normalMap", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const water = "  WaterMaterial { id: surface; target: host; baseColor: \"#2f6f8f\" }\n";
  await createProject("waterOnBox", { template: "empty" });
  writeFileSync(path.join(projectDir("waterOnBox"), "scene.ssdl"),
    `Scene {\n  id: main\n  Box { id: host; width: 4; depth: 4; height: 4 }\n${water}}\n`, "utf8");
  await assert.rejects(() => compileNamed("waterOnBox"), (error) => {
    assert.match(`${error.message} ${JSON.stringify(error.problems ?? "")}`, /material_requires_tangent/);
    return true;
  });

  await createProject("waterOnPlane", { template: "empty" });
  writeFileSync(path.join(projectDir("waterOnPlane"), "scene.ssdl"),
    `Scene {\n  id: main\n  Plane { id: host; width: 40; depth: 40 }\n${water}}\n`, "utf8");
  assert.equal((await compileNamed("waterOnPlane")).ok, true);

  // A lake or river outline is a Polygon: the native polygon ships planar UVs and the (+X) frame.
  await createProject("waterOnPolygon", { template: "empty" });
  writeFileSync(path.join(projectDir("waterOnPolygon"), "scene.ssdl"),
    `Scene {\n  id: main\n  Polygon { id: host; outer: [[-20,-5],[20,-5],[25,5],[-20,5]] }\n${water}}\n`, "utf8");
  assert.equal((await compileNamed("waterOnPolygon")).ok, true);
});

test("the gate keys off the host geometry, not the material", () => {
  const nodes = [
    { id: "wall", parent: "main", type: "Box", properties: [] },
    { id: "surface", parent: "main", type: "PrincipledMaterial", properties: [{ property: "normalMap", value: "tex" }, { property: "target", value: "wall" }] },
    { id: "field", parent: "main", type: "HeightField", properties: [] },
    { id: "fieldSurface", parent: "main", type: "PrincipledMaterial", properties: [{ property: "normalMap", value: "tex" }, { property: "target", value: "field" }] },
  ];
  const problems = checkRuntimeSupport({ nodes }).filter((item) => item.code === "material_requires_tangent");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].node, "surface");
  assert.match(problems[0].message, /Plane\/Polygon\/HeightField\/Lathe\/Tube\/Loft\/Sweep\/Torus\/Roof\/Stairs/);
  assert.deepEqual([...TANGENT_CAPABLE_TYPES].sort(),
    ["HeightField", "Lathe", "Loft", "Plane", "Polygon", "Roof", "Stairs", "Sweep", "Torus", "Tube"]);
});
