import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileProject } from "../src/compile.mjs";
import { checkRuntimeSupport } from "../src/runtime-support.mjs";

function project(t, body) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ssworld-env-writers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "scene.ssdl"), `Scene {\n  id: main\n${body}}\n`, "utf8");
  writeFileSync(path.join(directory, "scene.mjs"), "export default {};\n", "utf8");
  writeFileSync(path.join(directory, "showcase.manifest.json"), JSON.stringify({ schema_version: "SceneModuleManifest/1", name: "EnvWriters", entry: "scene.mjs" }) + "\n", "utf8");
  return directory;
}

const node = (id, type, properties = {}) => ({ id, parent: "main", type,
  properties: Object.entries(properties).map(([property, value]) => ({ property, value })) });
const codes = (nodes) => checkRuntimeSupport({ nodes }).map((item) => `${item.code}:${item.node}:${item.property ?? ""}`);

test("fog density written beside Environment.cloudCoverage compiles with a warning, and alone it is quiet", async (t) => {
  const covered = node("clock", "Environment", { cloudCoverage: 0 });
  const fog = node("haze", "ExponentialHeightFog", { fogDensity: 0.035, fogHeightFalloff: 0.02, fogMaxOpacity: 0.8 });
  assert.deepEqual(codes([covered, fog]), ["fog_overridden:haze:fogDensity", "fog_overridden:haze:fogHeightFalloff"]);
  assert.ok(checkRuntimeSupport({ nodes: [covered, fog] }).every((item) => item.severity === "warning"));
  assert.deepEqual(codes([node("clock", "Environment"), fog]), []);
  assert.deepEqual(codes([covered, node("haze", "ExponentialHeightFog", { fogMaxOpacity: 0.8 })]), []);

  const directory = project(t, `  Environment { id: clock; dateTime: "2026-09-22T10:00:00+08:00"; cloudCoverage: 0 }\n  ExponentialHeightFog { id: haze; fogDensity: 0.035 }\n`);
  const compiled = await compileProject(directory);
  assert.equal(compiled.ok, true);
  const warning = (compiled.warnings || []).find((item) => item.code === "fog_overridden");
  assert.ok(warning, JSON.stringify(compiled.warnings));
  assert.match(warning.message, /fogDensity is overwritten every frame: Environment 'clock' sets cloudCoverage.*fogDensityClear \/ fogDensityCloudy/);
});

test("a second DirectionalLight warns, naming the sun it would re-tint", async (t) => {
  const sun = node("sun", "DirectionalLight", { atmosphereSunLight: true });
  const moon = node("moon", "DirectionalLight", { atmosphereSunLight: false, intensity: 1 });
  assert.deepEqual(codes([moon, sun]), ["directional_light_limit:moon:"]);
  assert.match(checkRuntimeSupport({ nodes: [moon, sun] })[0].message, /draws one directional light, the sun \('sun'\).*colour would replace the sun's.*moonIntensity/);
  // Without an adopted sun the first one is the sun.
  assert.deepEqual(codes([node("a", "DirectionalLight"), node("b", "DirectionalLight")]), ["directional_light_limit:b:"]);
  assert.deepEqual(codes([sun]), []);
  assert.deepEqual(codes([moon]), []);
  const compiled = await compileProject(project(t, `  DirectionalLight { id: sun; atmosphereSunLight: true }\n  DirectionalLight { id: fill; atmosphereSunLight: false; intensity: 1 }\n`));
  assert.equal(compiled.ok, true);
  assert.deepEqual((compiled.warnings || []).filter((item) => item.code === "directional_light_limit").map((item) => item.node), ["fill"]);
});

test("an exposure member warns that it switches eye adaptation on; a grade without one does not", async (t) => {
  const withExposure = project(t, `  PostProcessVolume { id: grade; unbound: true; settings.autoExposureBias: 1; settings.bloomIntensity: 0.4 }\n`);
  const compiled = await compileProject(withExposure);
  const warning = (compiled.warnings || []).find((item) => item.code === "eye_adaptation_on");
  assert.ok(warning, JSON.stringify(compiled.warnings));
  assert.deepEqual(warning.members, ["autoExposureBias"]);
  assert.match(warning.message, /switches eye adaptation on/);

  const plain = await compileProject(project(t, `  PostProcessVolume { id: grade; unbound: true; settings.bloomIntensity: 0.4 }\n`));
  assert.equal((plain.warnings || []).some((item) => item.code === "eye_adaptation_on"), false);
});

test("a clock that can reach night warns when the moon is left at its default", async (t) => {
  const warns = async (body) => ((await compileProject(project(t, body))).warnings || []).some((item) => item.code === "night_without_moonlight");
  const clock = `  property string sceneDateTime: "2026-09-22T09:30:00+08:00"\n`;
  assert.equal(await warns(`${clock}  Environment { id: sky; dateTime: main.sceneDateTime; timeScale: 0 }\n`), true, "a dateTime the page slider drives");
  assert.equal(await warns(`  Environment { id: sky; dateTime: "2026-09-22T09:30:00+08:00"; timeScale: 3600 }\n`), true, "a running clock");
  assert.equal(await warns(`${clock}  Environment { id: sky; dateTime: main.sceneDateTime; timeScale: 0; moonIntensity: 4 }\n`), false, "moonlight written");
  assert.equal(await warns(`  Environment { id: sky; dateTime: "2026-09-22T09:30:00+08:00"; timeScale: 0 }\n`), false, "a frozen daytime clock");
});
