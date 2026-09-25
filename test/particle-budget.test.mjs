// ParticleEmitter 的编译期账目：预算维度 particles、两条静态校验（clip 警告、cone 缺半径）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// paths.mjs 在 import 时就把工作区解析完了，所以家目录要先搬（记忆 ssdl-test-home-needs-dynamic-import）。
const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-particle-home-"));
process.env.SSWORLD_HOME = home;
const { createProject, projectDir, compileNamed } = await import("../src/project.mjs");
const { DEFAULT_BUDGETS } = await import("../src/budgets.mjs");

let sequence = 0;

async function compileScene(t, source) {
  const name = `particle${++sequence}`;
  await createProject(name, { template: "empty" });
  const directory = projectDir(name);
  writeFileSync(path.join(directory, "scene.ssdl"), source, "utf8");
  return compileNamed(name);
}

test.after(() => rmSync(home, { recursive: true, force: true }));

test("particles is a budget dimension and counts maxParticles, not nodes", async (t) => {
  const result = await compileScene(t, `Scene {
  id: main
  ParticleEmitter { id: rain; shape: "box"; shapeSize: [40, 40, 0]; direction: [0, 0, -1]
    speed: [9, 11]; lifetime: [3, 3.5]; rate: 2500; maxParticles: 9000 }
  ParticleEmitter { id: mist; rate: 10; lifetime: [1, 2]; maxParticles: 100 }
}
`);
  assert.equal(result.usage.particles.used, 9100, "two emitters cost their ceilings, not two nodes");
  assert.equal(result.usage.particles.limit, DEFAULT_BUDGETS.particles);
  assert.equal(result.usage.node_types.ParticleEmitter, 2);
});

test("an emitter whose rate cannot fit its own cap is warned about, not failed", async (t) => {
  const result = await compileScene(t, `Scene {
  id: main
  ParticleEmitter { id: smoke; rate: 400; lifetime: [4, 7]; maxParticles: 500 }
}
`);
  assert.ok(Array.isArray(result.warnings), "the clip must be reported");
  const warning = result.warnings.find((entry) => entry.code === "particle_budget");
  assert.ok(warning, "particle_budget warning is missing");
  assert.equal(warning.node, "smoke");
  assert.equal(warning.used, 2800);
  assert.equal(warning.limit, 500);
  // 这条不能把编译打红：裁掉的粒子仍然会画出来，作者只是看不到他以为的密度。
  assert.equal(result.ok, true);
});

test("a cone with no base radius is a compile error, named on the node", async (t) => {
  const source = `Scene {
  id: main
  ParticleEmitter { id: flames; shape: "cone"; rate: 60; lifetime: [0.6, 1.2] }
}
`;
  // compileNamed 会把 CompileError 重新包一层，code 字段在那一层丢掉，
  // 所以判据钉在报文上：错误码前缀 + 出问题的节点 id + 人话原因。
  await assert.rejects(() => compileScene(t, source), (error) => {
    assert.match(error.message, /^particle_shape_invalid: /);
    assert.match(error.message, /'flames'/);
    assert.match(error.message, /base radius/);
    return true;
  });
});

test("a cone that carries its radius compiles", async (t) => {
  const result = await compileScene(t, `Scene {
  id: main
  ParticleEmitter { id: flames; shape: "cone"; shapeSize: [0.4, 0, 0]; rate: 60; lifetime: [0.6, 1.2]
    maxParticles: 500 }
}
`);
  assert.equal(result.ok, true);
  assert.equal(result.usage.particles.used, 500);
  assert.equal(result.warnings, undefined);
});

test("softness above 0 is refused, because it reaches the engine and does nothing", async (t) => {
  // 2026-09-19 真机：uniform 到位、soft 变体也选中了，但深度淡出在画面上毫无变化。
  // 「收下但不生效」正是这一轮花掉一个下午去追的那种沉默，所以编译期直接拒。
  await assert.rejects(() => compileScene(t, `Scene {
  id: main
  ParticleEmitter { id: fog; rate: 30; lifetime: [3, 3]; maxParticles: 200; softness: 1 }
}
`), (error) => {
    assert.match(error.message, /^particle_softness_unavailable: /);
    assert.match(error.message, /'fog'/);
    return true;
  });
});

test("softness: 0 is still an ordinary value", async (t) => {
  const result = await compileScene(t, `Scene {
  id: main
  ParticleEmitter { id: fog; rate: 30; lifetime: [3, 3]; maxParticles: 200; softness: 0 }
}
`);
  assert.equal(result.ok, true);
});

// 模板是作者进粒子这条车道的第一扇门：它必须自带能用的贴图、compile 干净、不误触自己文档里讲的坑。
test("the campfire template compiles with its sprites and no warnings", async () => {
  const result = await createProject("campfireTemplate", { template: "campfire" });
  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined, "the shipped template must not trip its own particle_budget trap");
  const directory = projectDir("campfireTemplate");
  const assets = readdirSync(path.join(directory, "assets"));
  assert.equal(assets.length, 9, "the nine legacy particle sprites ship with this template");
  // 两张被 scene.ssdl 真正引用的贴图必须在场，否则模板一打开就是 asset_unresolved。
  const referenced = result.usage.assets.files.filter((file) => file.referenced).map((file) => file.path);
  assert.deepEqual(referenced.sort(), ["assets/glowdot.png", "assets/smoke.png"]);
  assert.equal(result.usage.node_types.ParticleEmitter, 2, "the rain emitter is commented out on purpose");
  assert.ok(result.usage.particles.used > 0 && result.usage.particles.used < DEFAULT_BUDGETS.particles);
});

test("only the campfire template pays for the sprites", async () => {
  for (const template of ["starter", "empty", "geo"]) {
    const result = await createProject(`plain${template}`, { template });
    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(projectDir(`plain${template}`), "assets")), false,
      `${template} must not arrive with 180 KB of particle sprites`);
  }
});
