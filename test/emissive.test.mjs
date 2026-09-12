import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-emissive-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");

// A 1x1 PNG is enough: the compiler registers assets by digest and size, it does not decode them.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753"
  + "de0000000c4944415408d763f8cf000001010100189a1ea70000000049454e44ae426082", "hex");

async function compileScene(name, scene) {
  await createProject(name, { template: "empty" });
  const directory = projectDir(name);
  mkdirSync(path.join(directory, "assets"), { recursive: true });
  writeFileSync(path.join(directory, "assets", "neon.png"), PNG);
  writeFileSync(path.join(directory, "scene.ssdl"), scene, "utf8");
  return compileNamed(name);
}

const SCENE = `Scene {
  id: main
  Texture { id: neonTex; source: "assets/neon.png" }
  Box { id: sign; width: 6; depth: 0.3; height: 2; position: [0, 0, 4] }
  PrincipledMaterial { id: signSurface; target: sign; emissiveMap: neonTex; emissiveColor: [3.2, 1.4, 4.0] }
}
`;

// emissiveMap only needs UV, never a tangent stream — unlike normalMap it must compile on a Box.
test("an emissive map compiles on a plain primitive", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await compileScene("neonSign", SCENE);
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result));
  assert.equal(result.usage.textures.used, 1);
});

test("emissiveColor is a factor with HDR headroom, not a 0..1 ratio", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const tooBright = await compileScene("neonOver", SCENE.replace("[3.2, 1.4, 4.0]", "[24, 1, 1]"))
    .then(() => null, (error) => error);
  assert.ok(tooBright, "24 is past the declared 0..16 ceiling and must be refused");
  const bright = await compileScene("neonBright", SCENE.replace("[3.2, 1.4, 4.0]", "[12, 12, 12]"));
  assert.equal(bright.ok, true, "12 is above 1 and must still be accepted");
});
