import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ssworld-mcp.mjs");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const HOME = mkdtempSync(path.join(os.tmpdir(), "ssworld-test-"));

class Client {
  constructor() {
    this.child = spawn(process.execPath, [BIN], { env: { ...process.env, SSWORLD_HOME: HOME, SSWORLD_PREVIEW_PORT: String(PORT) }, stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.pending = new Map();
    this.nextId = 1;
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      const resolve = this.pending.get(message.id);
      this.pending.delete(message.id);
      resolve?.(message);
    });
  }
  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async call(name, args = {}) {
    const response = await this.request("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    const body = JSON.parse(response.result.content[0].text);
    return { isError: response.result.isError === true, body };
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}

test("ssworld-mcp end to end over stdio", async (t) => {
  const client = new Client();
  t.after(() => client.close());

  const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.serverInfo.name, "ssworld");
  assert.match(init.result.instructions, /SSDL/);

  const list = await client.request("tools/list", {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["ssworld_catalog", "ssworld_project_list", "ssworld_project_create", "ssworld_source_read",
    "ssworld_source_write", "ssworld_source_patch", "ssworld_source_batch", "ssworld_compile", "ssworld_scene_inspect", "ssworld_preview", "ssworld_capture_frame", "ssworld_engine_status"]);
  for (const tool of list.result.tools) assert.equal(tool.rich, undefined, `${tool.name} leaks internal flags`);
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, "object", tool.name);

  const catalog = await client.call("ssworld_catalog");
  assert.equal(catalog.isError, false);
  assert.ok(catalog.body.components.Box?.supported, "Box must be a supported component");
  assert.match(catalog.body.conventions.quaternion_order, /\[x, y, z, w\]/);
  assert.match(catalog.body.unavailable_components.SunSky.alternative, /atmosphereSunLight/);
  const sky = await client.call("ssworld_catalog", { component: "SkyAtmosphere" });
  assert.equal(sky.body.contract.members.skyLuminanceFactor.value_type, "vector3", "catalog must agree with the runtime (vector3)");
  const sun = await client.call("ssworld_catalog", { component: "DirectionalLight" });
  assert.match(sun.body.contract.members.lightSourceAngle.runtime_writable, /atmosphereSunLight/);
  const view = await client.call("ssworld_catalog", { component: "CameraView" });
  for (const member of ["position", "lookAt", "fov", "nearPlane", "farPlane"]) assert.ok(view.body.contract.members[member], `CameraView.${member}`);
  assert.match(view.body.contract.members.fov.note, /horizontal field of view/);
  assert.match(catalog.body.conventions.field_of_view, /horizontal/);
  assert.deepEqual(catalog.body.logic.declarations.types, ["bool", "degrees", "duration", "length", "radians", "real", "string"]);
  assert.ok(catalog.body.logic.expressions.operators.includes(">="));
  assert.match(catalog.body.logic.host_interfaces.implementation, /createHostInterfaces/);
  const label = await client.call("ssworld_catalog", { component: "Label" });
  assert.equal(label.body.runtime_supported, false);
  assert.match(label.body.runtime_note, /SDF font/);
  const box = await client.call("ssworld_catalog", { component: "Box" });
  assert.ok(box.body.contract.properties || box.body.contract, "component contract");
  const unknown = await client.call("ssworld_catalog", { component: "Nope" });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.body.error, "unknown_component");
  // Batch + compact + digest: one call for several contracts, shared members hoisted, unknown names reported per item.
  assert.match(catalog.body.catalog_digest, /^sha256:/);
  const cached = await client.call("ssworld_catalog", { if_digest: catalog.body.catalog_digest });
  assert.deepEqual(cached.body, { catalog_digest: catalog.body.catalog_digest, unchanged: true });
  const batch = await client.call("ssworld_catalog", { components: ["Box", "Sphere", "DirectionalLight", "CameraView", "SunSky"], detail: "compact" });
  assert.equal(batch.isError, false, JSON.stringify(batch.body));
  assert.equal(batch.body.catalog_digest, catalog.body.catalog_digest);
  assert.deepEqual(Object.keys(batch.body.components), ["Box", "Sphere", "DirectionalLight", "CameraView"]);
  assert.equal(batch.body.unknown[0].component, "SunSky");
  assert.match(batch.body.unknown[0].alternative, /atmosphereSunLight/);
  assert.equal(batch.body.shared_members, undefined, "CameraView.position is create_only, so nothing is shared by all four");
  assert.equal(batch.body.components.Box.members.position, "vector3 m");
  const geometry = await client.call("ssworld_catalog", { components: ["Box", "Sphere", "Cylinder"], detail: "compact" });
  assert.equal(geometry.body.shared_members.position, "vector3 m", "position is declared identically by all three and hoisted");
  assert.equal(geometry.body.shared_members.rotation, "quaternion");
  assert.equal(geometry.body.components.Box.members.position, undefined);
  assert.equal(geometry.body.components.Box.members.width, "scalar m create_only");
  assert.match(geometry.body.components.Sphere.members.radius, /^scalar m/);
  assert.match(batch.body.components.DirectionalLight.member_notes.rotation, /Euler degrees/);
  assert.match(batch.body.components.DirectionalLight.member_notes.intensity, /multiplier/);
  assert.match(batch.body.components.CameraView.member_notes.longitude, /WGS84 degrees/);
  assert.match(batch.body.components.CameraView.member_notes.farPlane, /not honoured/);
  const fullBatch = await client.call("ssworld_catalog", { components: ["Box", "DirectionalLight"] });
  assert.match(fullBatch.body.components.Box.contract.members.rotation.note, /quaternion \[x, y, z, w\]/);
  assert.match(fullBatch.body.components.DirectionalLight.contract.members.rotation.note, /Euler/);
  assert.equal(fullBatch.body.components.Box.contract.members.position.value_type, "vector3");

  const created = await client.call("ssworld_project_create", { name: "demo", longitude: 116.39, latitude: 39.9, height: 50 });
  assert.equal(created.isError, false, JSON.stringify(created.body));
  assert.match(created.body.scene_ir_digest, /^sha256:/);
  assert.deepEqual(created.body.anchor, { lon: 116.39, lat: 39.9, height: 50 });
  const expected = process.env.SSWORLD_EXPECTED_PROFILE_DIGEST;
  if (expected) {
    const manifest = JSON.parse(readFileSync(path.join(HOME, "projects", "demo", "showcase.manifest.json"), "utf8"));
    assert.equal(manifest.compiler_profile_digest, expected, "compiler closure must reproduce the repository profile digest");
  }
  const html = readFileSync(path.join(HOME, "projects", "demo", "index.html"), "utf8");
  assert.match(html, /path: "projects\/demo"/);
  assert.match(html, /lon: 116\.39, lat: 39\.9, height: 50/);
  assert.doesNotMatch(html, /__[A-Z_]+__/);

  const duplicate = await client.call("ssworld_project_create", { name: "demo" });
  assert.equal(duplicate.isError, true);
  assert.match(created.body.usage.native_objects.limit + "", /^\d+$/);
  assert.ok(created.body.usage.node_types.Box >= 1);
  const empty = await client.call("ssworld_project_create", { name: "blank", template: "empty" });
  assert.equal(empty.isError, false, JSON.stringify(empty.body));
  assert.equal(empty.body.usage.node_types.Box, undefined);
  assert.ok(empty.body.usage.node_types.CameraView, "empty template keeps a local-frame camera");
  const badTemplate = await client.call("ssworld_project_create", { name: "blank2", template: "nope" });
  assert.equal(badTemplate.isError, true);

  const listed = await client.call("ssworld_project_list");
  assert.equal(listed.body.projects.length, 2);
  assert.equal(listed.body.projects[0].compiled, true);

  const read = await client.call("ssworld_source_read", { project: "demo" });
  assert.match(read.body.content, /Scene \{/);
  assert.deepEqual(read.body.files, ["scene.ssdl"]);
  assert.equal(read.body.has_more, false);
  assert.equal(read.body.range.offset, 1);
  assert.equal(read.body.lines, read.body.content.split("\n").length - 1);
  // Bounded reads: metadata without text, line ranges with cursors, max_chars truncation, node lookup.
  const meta = await client.call("ssworld_source_read", { project: "demo", mode: "metadata" });
  assert.equal(meta.body.content, undefined);
  assert.equal(meta.body.files[0].digest, read.body.digest);
  assert.equal(meta.body.files[0].lines, read.body.lines);
  assert.equal(meta.body.stale, false, JSON.stringify(meta.body));
  assert.equal(meta.body.compiled_source_digest, created.body.source_digest);
  const range = await client.call("ssworld_source_read", { project: "demo", offset: 2, limit: 3 });
  assert.deepEqual(range.body.content.split("\n").slice(0, -1), read.body.content.split("\n").slice(1, 4));
  assert.equal(range.body.has_more, true);
  assert.equal(range.body.next_offset, 5);
  const capped = await client.call("ssworld_source_read", { project: "demo", max_chars: 1000 });
  assert.equal(capped.body.truncated, undefined, "1000 chars is enough for the starter scene");
  const tiny = await client.call("ssworld_source_read", { project: "demo", max_chars: 1000, limit: 1000 });
  assert.equal(tiny.isError, false);
  const nodeRead = await client.call("ssworld_source_read", { project: "demo", node: "cube" });
  assert.equal(nodeRead.body.type, "Box");
  assert.match(nodeRead.body.content, /^Box \{/);
  assert.ok(nodeRead.body.line_end > nodeRead.body.line_start);
  assert.ok(nodeRead.body.compiled_properties.some((item) => item.property === "width"));
  const noNode = await client.call("ssworld_source_read", { project: "demo", node: "nope" });
  assert.equal(noNode.body.error, "node_not_found");
  const all = await client.call("ssworld_source_read", { project: "demo", file: "*" });
  assert.deepEqual(all.body.sources.map((item) => item.file), ["scene.ssdl"]);
  assert.equal(all.body.sources[0].digest, read.body.digest);

  // Patch: exact-span edit with the digest guard, uniqueness check and replace_all.
  const ambiguous = await client.call("ssworld_source_patch", { project: "demo", file: "scene.ssdl", old_string: "24", new_string: "25", expected_digest: read.body.digest });
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.body.error, "patch_ambiguous");
  const missingSpan = await client.call("ssworld_source_patch", { project: "demo", file: "scene.ssdl", old_string: "no such text", new_string: "x" });
  assert.equal(missingSpan.body.error, "patch_not_found");
  const patched = await client.call("ssworld_source_patch", { project: "demo", file: "scene.ssdl", old_string: "fov: 50", new_string: "fov: 45", expected_digest: read.body.digest });
  assert.equal(patched.isError, false, JSON.stringify(patched.body));
  assert.equal(patched.body.replaced, 1);
  assert.match(readFileSync(path.join(HOME, "projects", "demo", "scene.ssdl"), "utf8"), /fov: 45/);
  const stalePatch = await client.call("ssworld_source_patch", { project: "demo", file: "scene.ssdl", old_string: "fov: 45", new_string: "fov: 50", expected_digest: read.body.digest });
  assert.equal(stalePatch.body.error, "digest_mismatch");
  const undo = await client.call("ssworld_source_patch", { project: "demo", file: "scene.ssdl", old_string: "fov: 45", new_string: "fov: 50", expected_digest: patched.body.digest });
  assert.equal(undo.body.digest, read.body.digest, "patching back restores the original digest");

  // Batch: node-level sets, text patches, all-or-nothing, compile validation with rollback.
  const badBatch = await client.call("ssworld_source_batch", { project: "demo", expected_digest: read.body.digest, edits: [
    { node_id: "startView", set: { fov: 60 } }, { old_string: "no such text", new_string: "y" }] });
  assert.equal(badBatch.isError, true);
  assert.equal(badBatch.body.error, "patch_not_found");
  assert.equal(badBatch.body.edit_index, 1);
  assert.equal((await client.call("ssworld_source_read", { project: "demo" })).body.digest, read.body.digest, "a failing batch writes nothing");
  const staleBatch = await client.call("ssworld_source_batch", { project: "demo", expected_digest: "bad", edits: [{ node_id: "startView", set: { fov: 60 } }] });
  assert.equal(staleBatch.body.error, "digest_mismatch");
  const goodBatch = await client.call("ssworld_source_batch", { project: "demo", expected_digests: { "scene.ssdl": read.body.digest }, validate: "compile", edits: [
    { node_id: "startView", set: { fov: 60, lookAt: [0, 0, 10] } },
    { node_id: "cube", set: { height: 30, visible: true } },
    { old_string: "roughness: 0.3", new_string: "roughness: 0.6" }] });
  assert.equal(goodBatch.isError, false, JSON.stringify(goodBatch.body));
  assert.equal(goodBatch.body.compiled, true);
  assert.equal(goodBatch.body.files[0].digest_before, read.body.digest);
  assert.deepEqual(goodBatch.body.edits_applied[1].inserted, ["visible"]);
  const written = readFileSync(path.join(HOME, "projects", "demo", "scene.ssdl"), "utf8");
  assert.match(written, /fov: 60/);
  assert.match(written, /lookAt: \[0, 0, 10\]/);
  assert.match(written, /height: 30/);
  assert.match(written, /visible: true/);
  assert.match(written, /roughness: 0.6/);
  assert.equal(goodBatch.body.compile.usage.node_types.Box, 1);
  const unsetBatch = await client.call("ssworld_source_batch", { project: "demo", expected_digest: goodBatch.body.files[0].digest, validate: "compile", edits: [{ node_id: "cube", unset: ["visible", "nope"] }] });
  assert.equal(unsetBatch.isError, false, JSON.stringify(unsetBatch.body));
  assert.deepEqual(unsetBatch.body.edits_applied[0].unset, ["visible"]);
  const afterBatch = readFileSync(path.join(HOME, "projects", "demo", "scene.ssdl"), "utf8");
  assert.doesNotMatch(afterBatch, /visible: true/);
  assert.match(afterBatch, /height: 30/);
  const rolled = await client.call("ssworld_source_batch", { project: "demo", validate: "compile", edits: [{ node_id: "cube", set: { width: { raw: "" } } }] });
  assert.equal(rolled.isError, true);
  assert.equal(rolled.body.error, "validation_failed");
  assert.equal(rolled.body.rolled_back, true);
  assert.equal(readFileSync(path.join(HOME, "projects", "demo", "scene.ssdl"), "utf8"), afterBatch, "rollback restores the previous sources");
  assert.equal(rolled.body.previous_recompiled, true);
  const inspected = await client.call("ssworld_scene_inspect", { project: "demo" });
  assert.equal(inspected.isError, false, JSON.stringify(inspected.body));
  assert.equal(inspected.body.root.type, "Scene");
  assert.equal(inspected.body.budget.native_objects.limit, 2048);
  assert.equal(inspected.body.child_subtrees[0].id, "cube");
  assert.deepEqual(inspected.body.bounds.max, [12, 12, 27]);
  assert.equal(inspected.body.bounds.highest_top.id, "cube");
  assert.equal(inspected.body.requested_camera.fov, 60);
  assert.deepEqual(inspected.body.requested_camera.position, [60, -80, 40]);
  assert.ok(Math.abs(inspected.body.requested_camera.heading - 323.13) < 0.1, String(inspected.body.requested_camera.heading));
  assert.ok(inspected.body.requested_camera.pitch < -15 && inspected.body.requested_camera.pitch > -18);
  assert.ok(Math.abs(inspected.body.requested_camera.latitude - 39.9) < 0.01);
  assert.equal(inspected.body.source.stale, false);
  assert.equal(inspected.body.render_stats.draw_calls, "unavailable");
  assert.deepEqual(inspected.body.by_file, { "scene.ssdl": inspected.body.node_count });
  const restoreBatch = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: read.body.content, expected_digest: unsetBatch.body.files[0].digest });
  assert.equal(restoreBatch.isError, false);
  assert.equal(restoreBatch.body.next.action, "compile");
  const staleMeta = await client.call("ssworld_source_read", { project: "demo", mode: "metadata" });
  assert.equal(staleMeta.body.stale, true, "sources changed after the batch compile");

  const stale = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: "x", expected_digest: "bad" });
  assert.equal(stale.isError, true);
  const broken = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: "Scene { id: main\n Box { width: }\n}", expected_digest: read.body.digest });
  assert.equal(broken.isError, false);
  const failed = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(failed.isError, true);
  assert.equal(failed.body.error, "compile_failed");
  assert.match(failed.body.message, /scene\.ssdl:\d+:\d+/);

  // Accepted by the compiler, rejected by the engine: the adopted atmosphere sun has no lightSourceAngle.
  const sunScene = "Scene { id: main\n DirectionalLight { id: sun; atmosphereSunLight: true; lightSourceAngle: 2 }\n}";
  const sunWrite = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: sunScene, expected_digest: broken.body.digest });
  assert.equal(sunWrite.isError, false);
  const sunCompile = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(sunCompile.isError, true);
  assert.equal(sunCompile.body.diagnostic.code, "runtime_unsupported");
  assert.match(sunCompile.body.message, /lightSourceAngle cannot be written when atmosphereSunLight is true/);
  assert.equal(sunCompile.body.diagnostic.node, "sun");
  // Catalog now says vector3, so a scalar skyLuminanceFactor is a compile-time type_mismatch instead of a runtime crash.
  const skyScene = "Scene { id: main\n SkyAtmosphere { id: sky; skyLuminanceFactor: 1.2 }\n}";
  const skyWrite = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: skyScene, expected_digest: sunWrite.body.digest });
  const skyCompile = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(skyCompile.isError, true);
  assert.match(skyCompile.body.message, /scene\.ssdl:2:.*type_mismatch/);
  assert.equal(skyCompile.body.next.action, "fix_source");
  assert.equal(skyCompile.body.next.line, 2);
  // Runtime facts promoted to compile-time diagnostics: Label needs a font the package does not ship,
  // and animations cannot target a Group (locator, not a SceneObject).
  const labelScene = "Scene { id: main\n Label { id: sign; text: \"hi\"; anchor.longitude: 114; anchor.latitude: 22 }\n}";
  const labelWrite = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: labelScene, expected_digest: skyWrite.body.digest });
  assert.equal(labelWrite.isError, false, JSON.stringify(labelWrite.body));
  const labelCompile = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(labelCompile.isError, true);
  assert.equal(labelCompile.body.diagnostic.code, "runtime_unsupported");
  assert.equal(labelCompile.body.diagnostic.node, "sign");
  assert.match(labelCompile.body.message, /SDF font/);
  const groupScene = "Scene { id: main\n Group { id: g; position: [0, 0, 0]; Box { id: b; width: 1; depth: 1; height: 1 } }\n Vector3dAnimation { target: g; property: \"position\"; from: [0, 0, 0]; to: [1, 0, 0]; duration: 100 }\n}";
  const groupWrite = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: groupScene, expected_digest: labelWrite.body.digest });
  const groupCompile = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(groupCompile.isError, true);
  assert.match(groupCompile.body.message, /scene\.ssdl:3:.*property_not_animatable.*Group is not a live SceneObject/);

  // Scene logic: declared properties, comparison sugar, host calls checked against host_interfaces.json.
  const contract = JSON.stringify({ Game: { methods: { hit: { args: [{ name: "targetId", type: "string" }, { name: "score", type: "real" }] }, reset: { args: [] } } } }, null, 2);
  const contractWrite = await client.call("ssworld_source_write", { project: "demo", file: "host_interfaces.json", content: contract, expected_digest: "new" });
  assert.equal(contractWrite.isError, false, JSON.stringify(contractWrite.body));
  const logicWrite = await client.call("ssworld_source_write", { project: "demo", file: "logic.mjs", content: "export function createHostInterfaces(api) { return { Game: { hit() {}, reset() {} } }; }\n", expected_digest: "new" });
  assert.equal(logicWrite.isError, false, JSON.stringify(logicWrite.body));
  const logicScene = `Scene { id: main; property real score: 0
 State { id: won; name: "won"; when: score >= 2 }
 Box { id: b; width: 1; depth: 1; height: 1
  TapHandler { id: tap; onTapped: { score = score + 1; Game.hit(targetId: "b", score: score); } }
 }
}`;
  const logicSceneWrite = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: logicScene, expected_digest: groupWrite.body.digest });
  const logicCompile = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(logicCompile.isError, false, JSON.stringify(logicCompile.body));
  assert.deepEqual(logicCompile.body.logic, { properties: [{ name: "score", value_type: "scalar", unit: "scalar", initial: 0 }], states: ["won"],
    host_interfaces: { Game: ["hit", "reset"] }, host_calls: [{ node: "tap", signal: "onTapped", call: "Game.hit" }] });
  const logicMeta = await client.call("ssworld_source_read", { project: "demo", mode: "metadata" });
  assert.deepEqual(logicMeta.body.files.map((item) => item.file), ["host_interfaces.json", "logic.mjs", "scene.ssdl"]);
  assert.equal(logicMeta.body.stale, false);
  const badCall = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: logicScene.replace("Game.hit(targetId: \"b\", score: score)", "Game.nope()"), expected_digest: logicSceneWrite.body.digest });
  const badCallCompile = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(badCallCompile.isError, true);
  assert.equal(badCallCompile.body.diagnostic.code, "host_method_unknown");
  assert.equal(badCallCompile.body.next.action, "fix_source");
  assert.equal(badCallCompile.body.next.line, 4);
  const badContract = await client.call("ssworld_source_write", { project: "demo", file: "host_interfaces.json", content: "{ not json", expected_digest: contractWrite.body.digest });
  const badContractMeta = await client.call("ssworld_source_read", { project: "demo", mode: "metadata" });
  assert.equal(badContractMeta.body.stale, true, "a changed contract makes the compile stale");
  const badContractCompile = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(badContractCompile.isError, true);
  assert.equal(badContractCompile.body.diagnostic.code, "host_interfaces_invalid");
  assert.equal(badContractCompile.body.next.file, "host_interfaces.json");
  const contractRestore = await client.call("ssworld_source_write", { project: "demo", file: "host_interfaces.json", content: contract, expected_digest: badContract.body.digest });
  assert.equal(contractRestore.isError, false);
  const restore = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: read.body.content, expected_digest: badCall.body.digest });
  assert.equal(restore.isError, false);

  const good = read.body.content.replace("width: 24", "width: 40");
  const rewritten = await client.call("ssworld_source_write", { project: "demo", file: "scene.ssdl", content: good, expected_digest: restore.body.digest });
  assert.equal(rewritten.isError, false);
  const compiled = await client.call("ssworld_compile", { project: "demo" });
  assert.equal(compiled.isError, false, JSON.stringify(compiled.body));
  assert.notEqual(compiled.body.scene_ir_digest, created.body.scene_ir_digest);
  const ir = JSON.parse(readFileSync(path.join(HOME, "projects", "demo", "scene.ir.json"), "utf8"));
  const startView = ir.nodes.find((node) => node.type === "CameraView");
  assert.ok(startView, "template declares a local-frame CameraView");
  assert.deepEqual(startView.properties.find((item) => item.property === "lookAt").value, { x: 0, y: 0, z: 12 });

  const engine = await client.call("ssworld_engine_status");
  if (!engine.body.ready) { t.diagnostic("engine pair not available; preview checks skipped (set SSWORLD_ENGINE_DIR)"); return; }

  const preview = await client.call("ssworld_preview", { project: "demo" });
  assert.equal(preview.isError, false, JSON.stringify(preview.body) + client.stderr);
  assert.equal(preview.body.viewer_url, `http://127.0.0.1:${PORT}/projects/demo/index.html`);
  assert.equal(preview.body.render_verified, false);
  assert.equal(preview.body.page.connected, false);
  assert.equal(preview.body.next.action, "open_webgpu_viewer");
  assert.equal(preview.body.next.url, preview.body.viewer_url);
  assert.equal(preview.body.next.blocking, true);

  // No page open yet: the capture tool must say so instead of hanging.
  const notOpen = await client.call("ssworld_capture_frame", { project: "demo" });
  assert.equal(notOpen.isError, true);
  assert.equal(notOpen.body.error, "page_not_open");
  assert.equal(notOpen.body.viewer_url, preview.body.viewer_url);
  assert.equal(notOpen.body.next.action, "open_webgpu_viewer");

  // A fake page: heartbeat through /__ssworld/sync, answer the capture command with a 2x2 PNG.
  const syncUrl = `http://127.0.0.1:${PORT}/__ssworld/sync`;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P4z8DwHwyBFJDxHwzhTAAB1Qv/N+qaVAAAAABJRU5ErkJggg==";
  const manifest = JSON.parse(readFileSync(path.join(HOME, "projects", "demo", "showcase.manifest.json"), "utf8"));
  const status = { state: "ready", generation: "1", errors: [], hint: "ok", visibility: "visible", canvas: { width: 1474, height: 1857 }, device_pixel_ratio: 1.25,
    loaded: { generation: 1, scene_ir_digest: manifest.scene_ir_digest },
    logic: { scope_id: "ssworld-project", generation: 1, properties: { score: 3 }, states: { selected: false }, host_call_errors: [] } };
  const sync = (results = []) => fetch(syncUrl, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "demo", client: "fake", status, results }) }).then((r) => r.json());
  assert.deepEqual((await sync()).commands, []);
  const pageSeen = await client.call("ssworld_preview", { project: "demo" });
  assert.equal(pageSeen.body.page.connected, true);
  const pump = setInterval(async () => {
    const { commands } = await sync();
    for (const command of commands) {
      assert.equal(command.kind, "capture");
      assert.equal(command.params.width, 640);
      await sync([{ id: command.id, ok: true, png_base64: png,
        stats: { width: 2, height: 2, distinct_colors: 4, non_black_ratio: 1, overexposed_ratio: 0, mean_luma: 90 },
        camera: { heading: 323.1, pitch: -15.6, fov: 50, longitude: 116.3907, latitude: 39.89928, height: 90, near_plane: 0.5, far_plane: 68453 }, status }]);
    }
  }, 100);
  t.after(() => clearInterval(pump));
  const captureResponse = await client.request("tools/call", { name: "ssworld_capture_frame", arguments: { project: "demo", width: 640 } });
  clearInterval(pump);
  assert.equal(captureResponse.result.isError, undefined, JSON.stringify(captureResponse.result));
  const captureBody = JSON.parse(captureResponse.result.content[0].text);
  assert.equal(captureBody.ok, true);
  assert.equal(captureBody.render_verified, false, "a 4-colour frame counts as blank");
  assert.match(captureBody.verdict, /blank/);
  assert.equal(captureBody.stats.distinct_colors, 4);
  assert.ok(captureBody.capture_path.endsWith(".png"));
  assert.equal(readFileSync(captureBody.capture_path).subarray(1, 4).toString(), "PNG");
  const image = captureResponse.result.content.find((item) => item.type === "image");
  assert.equal(image?.mimeType, "image/png");
  assert.equal(image?.data, png);
  assert.equal(captureBody.camera.source, "scene");
  // Receipt binds the frame to the compile on disk and the page generation; framing states what the engine did.
  assert.equal(captureBody.receipt.in_sync, true, JSON.stringify(captureBody.receipt));
  assert.equal(captureBody.receipt.scene_ir_digest, manifest.scene_ir_digest);
  assert.equal(captureBody.receipt.page_scene_ir_digest, manifest.scene_ir_digest);
  assert.equal(captureBody.receipt.compiled_source_digest, captureBody.receipt.source_digest);
  assert.match(captureBody.receipt.image_sha256, /^[0-9a-f]{64}$/);
  assert.equal(captureBody.receipt.capture_path, captureBody.capture_path);
  assert.deepEqual(captureBody.framing.requested, { width: 640, height: 360 });
  assert.equal(captureBody.framing.mode, "offscreen_render_at_requested_size");
  assert.deepEqual(captureBody.framing.interactive_canvas, { width: 1474, height: 1857, device_pixel_ratio: 1.25 });
  // LiCamera.fov is horizontal; the vertical fov follows the requested aspect (16:9 here).
  assert.equal(captureBody.framing.projection.horizontal_fov_deg, 50);
  assert.ok(Math.abs(captureBody.framing.projection.vertical_fov_deg - 29.4) < 0.2, JSON.stringify(captureBody.framing.projection));
  assert.match(captureBody.framing.note, /horizontal fov/);
  assert.equal(captureBody.logic.properties.score, 3, "live logical state rides along with the frame");
  assert.deepEqual(captureBody.logic.states, { selected: false });
  assert.equal(captureBody.reference_match.status, "not_evaluated");
  assert.equal(captureBody.camera.requested.view, "startView");
  assert.equal(captureBody.camera.deviation.fov.ok, true);
  assert.ok(captureBody.camera.deviation.heading_error_deg < 0.1, JSON.stringify(captureBody.camera.deviation));
  assert.ok(captureBody.camera.deviation.position_error_m < 5, JSON.stringify(captureBody.camera.deviation));
  assert.equal(captureBody.next.action, "judge_frame", JSON.stringify(captureBody.next));
  // Same page, but the sources moved on disk: the receipt must say the frame is behind.
  writeFileSync(path.join(HOME, "projects", "demo", "scene.ssdl"), good.replace("width: 40", "width: 41"));
  const pump1b = setInterval(async () => {
    const { commands } = await sync();
    for (const command of commands) await sync([{ id: command.id, ok: true, png_base64: png,
      stats: { width: 2, height: 2, distinct_colors: 4, non_black_ratio: 1, overexposed_ratio: 0, mean_luma: 90 }, camera: { heading: 0, fov: 50 }, status }]);
  }, 100);
  t.after(() => clearInterval(pump1b));
  const behind = await client.call("ssworld_capture_frame", { project: "demo", timeout_ms: 5000 });
  clearInterval(pump1b);
  assert.equal(behind.isError, false, JSON.stringify(behind.body));
  assert.equal(behind.body.receipt.in_sync, false);
  assert.match(behind.body.receipt.staleness[0], /changed since the last compile/);
  assert.equal(behind.body.next.action, "recompile_and_recapture");
  writeFileSync(path.join(HOME, "projects", "demo", "scene.ssdl"), good);

  // A failed load: duplicated errors collapse to one, get mapped to the scene.ssdl line, and the camera is flagged as the engine default.
  const failedStatus = { ...status, state: "failed", hint: "SkyAtmosphere.skyLuminanceFactor must be a vector", errors: [
    { kind: "scene_module", message: "SkyAtmosphere.skyLuminanceFactor must be a vector", at: 1 },
    { kind: "console.error", message: "SkyAtmosphere.skyLuminanceFactor must be a vector [object Object]", at: 2 }] };
  writeFileSync(path.join(HOME, "projects", "demo", "scene.ssdl"), "Scene {\n  id: main\n  SkyAtmosphere {\n    id: sky\n    skyLuminanceFactor: 1\n  }\n}\n");
  const pump2 = setInterval(async () => {
    const { commands } = await sync();
    for (const command of commands) await sync([{ id: command.id, ok: true, png_base64: png,
      stats: { width: 2, height: 2, distinct_colors: 4, non_black_ratio: 1, overexposed_ratio: 0, mean_luma: 90 },
      camera: { heading: 0, height: 27393433 }, status: failedStatus }]);
  }, 100);
  t.after(() => clearInterval(pump2));
  const failedCapture = await client.call("ssworld_capture_frame", { project: "demo", timeout_ms: 5000 });
  clearInterval(pump2);
  assert.equal(failedCapture.isError, false, JSON.stringify(failedCapture.body));
  assert.equal(failedCapture.body.runtime.errors.length, 1, "console.error echo is deduplicated");
  assert.equal(failedCapture.body.runtime.errors[0].repeats, 2);
  assert.deepEqual(failedCapture.body.runtime.errors[0].source, { file: "scene.ssdl", line: 5, column: 5, node: "sky" });
  assert.equal(failedCapture.body.camera.source, "engine_default");
  assert.match(failedCapture.body.verdict, /scene\.ssdl:5:5/);
  assert.equal(failedCapture.body.next.action, "fix_source");
  assert.equal(failedCapture.body.next.line, 5);
  assert.equal(failedCapture.body.receipt.in_sync, false);
  writeFileSync(path.join(HOME, "projects", "demo", "scene.ssdl"), good);

  // A page that stopped syncing (tab closed) is reported as not open again after the heartbeat goes stale.
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const closed = await client.call("ssworld_capture_frame", { project: "demo" });
  assert.equal(closed.isError, true);
  assert.equal(closed.body.error, "page_not_open");

  const page = await fetch(preview.body.viewer_url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.match(await page.text(), /\/engine\/SSmap\.js/);
  for (const route of ["/engine/SSmap.js", "/runtime/ssdl-builtins.js", "/runtime/scene-runtime-bridge.mjs", "/runtime/qtloader.js",
    "/runtime/ssdl-builtin-catalog-v1.js", "/projects/demo/scene.generated.mjs", "/projects/demo/showcase.manifest.json"]) {
    const response = await fetch(`http://127.0.0.1:${PORT}${route}`);
    assert.equal(response.status, 200, route);
    await response.arrayBuffer();
  }
  const wasm = await fetch(`http://127.0.0.1:${PORT}/engine/SSmap.wasm`, { method: "GET", headers: { Range: "bytes=0-3" } });
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  wasm.body?.cancel();

  const version = await fetch(`http://127.0.0.1:${PORT}/__ssdl_dev/version?path=projects/demo`).then((r) => r.json());
  assert.equal(version.ok, true);
  assert.match(version.token, /^[0-9a-f]{64}$/);
  const escape = await fetch(`http://127.0.0.1:${PORT}/projects/../package.json`);
  assert.notEqual(escape.status, 200);
  const missing = await fetch(`http://127.0.0.1:${PORT}/__ssdl_dev/version?path=projects/nope`);
  assert.equal(missing.status, 404);
});
