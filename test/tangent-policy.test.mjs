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
  for (const [name, host] of [
    ["tangentBox", "Box { id: host; width: 1; depth: 1; height: 1 }"],
    ["tangentPlane", "Plane { id: host; width: 1; depth: 1 }"],
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
  assert.match(problems[0].message, /HeightField\/Lathe\/Tube\/Loft/);
  assert.deepEqual([...TANGENT_CAPABLE_TYPES].sort(), ["HeightField", "Lathe", "Loft", "Tube"]);
});
