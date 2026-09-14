import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileProject, CompileError } from "../src/compile.mjs";
import { ASSET_LIMITS, ASSET_MEDIA, GEO_LAYER_BUDGETS } from "../src/runtime-support.mjs";
import { catalogComponent, catalogSummary } from "../src/catalog.mjs";
import { SSDL_ROOT, TEMPLATE_ROOT } from "../src/paths.mjs";

const MANIFEST = {
  schema_version: "SceneModuleManifest/1", scene_module_version: 1, name: "GeoScene", entry: "scene.mjs",
  execution_profiles: ["trusted-local", "agent-mcp"], resource_root: ".", scene_ir_version: 5, binding_ir_version: 2,
  anchor: { lon: 114.0579, lat: 22.5431, height: 150 },
};

function project(t, scene, assets = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ssworld-geo-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "scene.ssdl"), scene, "utf8");
  writeFileSync(path.join(directory, "showcase.manifest.json"), JSON.stringify(MANIFEST, null, 2), "utf8");
  writeFileSync(path.join(directory, "index.html"), readFileSync(path.join(TEMPLATE_ROOT, "index.html"), "utf8"), "utf8");
  writeFileSync(path.join(directory, "scene.mjs"), readFileSync(path.join(TEMPLATE_ROOT, "scene.mjs"), "utf8"), "utf8");
  if (Object.keys(assets).length) {
    mkdirSync(path.join(directory, "assets"));
    for (const [name, content] of Object.entries(assets)) writeFileSync(path.join(directory, "assets", name), content, "utf8");
  }
  return directory;
}

const polygons = JSON.stringify({
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { levels: 4 }, geometry: { type: "Polygon", coordinates: [[[114.05, 22.54], [114.06, 22.54], [114.06, 22.55], [114.05, 22.54]]] } },
    { type: "Feature", properties: { levels: 9 }, geometry: { type: "Polygon", coordinates: [[[114.07, 22.54], [114.08, 22.54], [114.08, 22.55], [114.07, 22.54]]] } },
  ],
});

test("a .geojson under assets/ is a managed asset with its own size limit", () => {
  assert.deepEqual(ASSET_MEDIA[".geojson"], { kind: "geojson", media_type: "application/geo+json" });
  assert.equal(ASSET_LIMITS.geojson, 8 * 1024 * 1024);
  // A bare .json stays undiscovered on purpose: under assets/ it is far more often page data.
  assert.equal(ASSET_MEDIA[".json"], undefined);
});

test("a geographic scene compiles, reports its layer budget and resolves the geojson asset", async (t) => {
  const directory = project(t, `Scene {
  id: main
  Globe { id: earth; terrain: "default"; lighting: false }
  ImageryLayer { id: base; source: "https://tiles.example.com/{z}/{x}/{y}.jpg"; webMercator: true }
  Tileset { id: city; source: "https://tiles.example.com/futian/tileset.json"; offset: [0, 0, -12] }
  GeoJsonLayer { id: parks; source: "assets/parks.geojson"; geometry: "polygon"; fillColor: "#2e7d32"; extrudeHeightField: "levels" }
  CameraView { id: overview; longitude: 114.0579; latitude: 22.5431; height: 900 }
  Camera { id: cam; initialView: overview }
}
`, { "parks.geojson": polygons });
  const result = await compileProject(directory, { name: "GeoScene" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.usage.geo, {
    globe: { used: 1, limit: 1, ratio: 1 },
    imagery_layers: { used: 1, limit: 8, ratio: 0.125 },
    tilesets: { used: 1, limit: 4, ratio: 0.25 },
    geojson_layers: { used: 1, limit: 8, ratio: 0.125 },
  });
  assert.deepEqual(result.usage.geojson, [
    { node: "parks", geometry: "polygon", source: "assets/parks.geojson", kind: "asset", feature_count: 2, geometry_types: ["Polygon"] },
  ]);
  assert.equal(result.usage.assets.files.find((file) => file.path === "assets/parks.geojson").kind, "geojson");
  assert.equal(result.usage.assets.files.find((file) => file.path === "assets/parks.geojson").referenced, true);
  // A geographic layer is not a native object, so it must not be charged to that budget.
  assert.equal(result.usage.native_objects.used, 0);
});

test("a geojson document that holds none of the layer's own geometry is refused at compile time", async (t) => {
  const directory = project(t, `Scene {
  id: main
  GeoJsonLayer { id: metro; source: "assets/parks.geojson"; geometry: "line" }
}
`, { "parks.geojson": polygons });
  await assert.rejects(async () => compileProject(directory, { name: "GeoScene" }), (error) => {
    assert.ok(error instanceof CompileError);
    assert.equal(error.diagnostic.code, "geojson_geometry_mismatch");
    assert.match(error.message, /draws LineString \/ MultiLineString, but assets\/parks\.geojson holds Polygon/);
    return true;
  });
});

test("a geojson document that is not JSON is refused with the file named", async (t) => {
  const directory = project(t, `Scene {
  id: main
  GeoJsonLayer { id: parks; source: "assets/parks.geojson"; geometry: "polygon" }
}
`, { "parks.geojson": "{ this is not json" });
  await assert.rejects(async () => compileProject(directory, { name: "GeoScene" }), (error) => {
    assert.equal(error.diagnostic.code, "geojson_invalid");
    assert.match(error.message, /assets\/parks\.geojson is not valid JSON/);
    return true;
  });
});

test("the catalog publishes the four components with their runtime notes and budgets", () => {
  const summary = catalogSummary();
  for (const [name, budget] of Object.entries(GEO_LAYER_BUDGETS)) {
    assert.equal(summary.components[name].supported, true, `${name} has a runtime factory`);
    assert.equal(summary.components[name].adapter, "direct");
    const contract = catalogComponent(name);
    assert.match(contract.runtime_note, /GEOGRAPHIC world/);
    if (name !== "Globe") assert.match(contract.runtime_note, new RegExp(`at most ${budget} per scene`, "i"));
  }
  assert.match(summary.conventions.geography, /directly under Scene/);
  assert.match(summary.conventions.terrain, /anchor_above_terrain_m/);
  assert.match(catalogComponent("ImageryLayer").contract.members.source.note, /\{x\} \{y\} \{z\}/);
  assert.match(catalogComponent("Tileset").contract.members.geometricErrorScale.note, /no maximumScreenSpaceError/);
});

test("the compiler's geographic budgets and the ones the catalog advertises are the same numbers", async () => {
  // SSDL_ROOT is the repository closure in the source tree and the frozen one under ssdl/ in the
  // published package; a path relative to this file only resolves in the first of those two layouts.
  const { GEO_BUDGETS } = await import(pathToFileURL(path.join(SSDL_ROOT, "compiler", "src", "geo-0.3.mjs")));
  assert.deepEqual({ ...GEO_BUDGETS }, { ...GEO_LAYER_BUDGETS });
});

test("the page template answers geo_read and declares that it reaches the network", () => {
  const page = readFileSync(path.join(TEMPLATE_ROOT, "index.html"), "utf8");
  assert.match(page, /command\.kind === "geo_read"/);
  assert.match(page, /runtime\.geoRead\(\)/);
  assert.match(page, /"network\.read"/);
  assert.match(page, /builtinRuntime\.on\("geoerror"/);
});

test("the geo project template compiles and carries no third-party tile service", async (t) => {
  // createProject writes under PROJECTS_ROOT, which is fixed at import time; drive the template text
  // directly instead of re-importing the module with a different SSWORLD_HOME. The server sources sit
  // beside this test in both layouts, unlike SSDL_ROOT, which moves when the package is published.
  const scene = readFileSync(fileURLToPath(new URL("../src/project.mjs", import.meta.url)), "utf8");
  const template = scene.match(/const GEO_SCENE = `([\s\S]*?)`;\n/)?.[1];
  assert.ok(template, "project.mjs must still carry the geo template");
  assert.doesNotMatch(template, /https:\/\/(?!your-|replace-)[a-z0-9.-]*\.(com|org|net|cn)\/[^\s"]*\{z\}/,
    "the template must not ship a real tile service: its terms and key are the author's");
  const directory = project(t, template.replaceAll("__ANCHOR_LON__", "114.0579").replaceAll("__ANCHOR_LAT__", "22.5431"));
  const result = await compileProject(directory, { name: "GeoTemplate" });
  assert.equal(result.ok, true);
  assert.equal(result.usage.geo.globe.used, 1);
  assert.equal(result.usage.geo.imagery_layers.used, 0, "the basemap ships commented out");
});
