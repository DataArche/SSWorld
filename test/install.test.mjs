import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ssworld-mcp.mjs");

test("install --local registers the server with every client config", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-install-"));
  mkdirSync(path.join(home, ".codex"));
  writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n', "utf8");
  mkdirSync(path.join(home, ".hermes"));
  writeFileSync(path.join(home, ".hermes", "config.yaml"), "model: deepseek\nmcp_servers:\n  other:\n    command: x\n", "utf8");
  // A hand-written DSH user patch row must survive the install untouched.
  mkdirSync(path.join(home, ".dsh"));
  writeFileSync(path.join(home, ".dsh", "cordis.patch.yml"), "- id: session-telemetry-otel\n  disabled: true\n", "utf8");
  const env = { ...process.env, HOME: home, USERPROFILE: home, SSWORLD_INSTALL_NO_CLI: "1", SSWORLD_HOME: path.join(home, ".ssworld") };
  // The writers honour HERMES_HOME / CODEX_HOME; the host's values must never leak into the test.
  delete env.HERMES_HOME;
  delete env.CODEX_HOME;
  const result = spawnSync(process.execPath, [BIN, "install", "--local", "--no-engine", "--client=claude,codex,hermes,cursor,dsh"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.bin, BIN);
  assert.deepEqual(report.registered.map((entry) => entry.client), ["claude", "codex", "hermes", "cursor", "dsh"]);

  const claude = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.deepEqual(claude.mcpServers.ssworld, { type: "stdio", command: process.execPath, args: [BIN] });
  const codex = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^model = "gpt-5"/);
  assert.match(codex, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.match(codex, /\[mcp_servers\.ssworld\]\ncommand = ".*"\nargs = \[".*ssworld-mcp\.mjs"\]/);
  const hermes = readFileSync(path.join(home, ".hermes", "config.yaml"), "utf8");
  assert.match(hermes, /mcp_servers:\n  ssworld:\n    command: ".*"\n    args: \[.*\]\n  other:\n    command: x/);
  // Both skill-capable clients get the skill copied in: the file *is* the registration, because
  // Hermes and Codex each discover <home>/skills/<name>/SKILL.md on their own.
  for (const clientHome of [".hermes", ".codex", ".dsh"]) {
    const skill = readFileSync(path.join(home, clientHome, "skills", "ssworld", "SKILL.md"), "utf8");
    assert.match(skill, /^name: ssworld$/m, `${clientHome} skill`);
    assert.doesNotMatch(skill, /[\u4e00-\u9fff]/, `${clientHome} skill must ship in English`);
  }
  assert.deepEqual(report.registered.filter((entry) => entry.skill).map((entry) => entry.client), ["codex", "hermes", "dsh"]);
  const cursor = JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.ssworld.args[0], BIN);

  // Second run must be idempotent (no duplicated blocks).
  const again = spawnSync(process.execPath, [BIN, "install", "--local", "--no-engine", "--client=codex,hermes"], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal((readFileSync(path.join(home, ".codex", "config.toml"), "utf8").match(/\[mcp_servers\.ssworld\]/g) || []).length, 1);
  assert.equal((readFileSync(path.join(home, ".hermes", "config.yaml"), "utf8").match(/^  ssworld:/gm) || []).length, 1);
  assert.equal(existsSync(path.join(home, ".ssworld", "engine")), false, "--no-engine must not download");
});

test("install writes the DSH user patch layer without breaking a hand-written or disabled one", () => {
  const base = { ...process.env, SSWORLD_INSTALL_NO_CLI: "1" };
  delete base.HERMES_HOME;
  delete base.CODEX_HOME;
  delete base.DSH_HOME;

  const run = (home) => {
    const env = { ...base, HOME: home, USERPROFILE: home, SSWORLD_HOME: path.join(home, ".ssworld") };
    const result = spawnSync(process.execPath, [BIN, "install", "--local", "--no-engine", "--client=dsh"], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(path.join(home, ".dsh", "cordis.patch.yml"), "utf8");
  };

  // 1. No file at all: the layer is created, and it is a valid top-level YAML list.
  const fresh = run(mkdtempSync(path.join(os.tmpdir(), "ssworld-dsh-fresh-")));
  assert.match(fresh, /^# >>> ssworld \(managed by ssworld-mcp install\)$/m);
  assert.match(fresh, /^- insert:\n {4}- id: mcp-ssworld\n {6}name: "@deepseek-ai\/dsh-mcp-client"$/m);
  assert.match(fresh, /^ {8}serverName: ssworld$/m);
  assert.match(fresh, /^ {8}transport: stdio$/m);
  assert.match(fresh, /^ {8}args: \[".*ssworld-mcp\.mjs"\]$/m);
  assert.match(fresh, /^ {8}toolCallTimeoutMs: 120000$/m, "capture_frame can outlast DSH's 60 s default");

  // 2. `[]` is DSH's documented way to disable the layer, and DSH throws on a file that parses to
  //    nothing.  Appending list items after `[]` yields YAML that cannot parse at all, so the file
  //    must be replaced wholesale -- no `[]` may survive.
  const disabledHome = mkdtempSync(path.join(os.tmpdir(), "ssworld-dsh-empty-"));
  mkdirSync(path.join(disabledHome, ".dsh"));
  writeFileSync(path.join(disabledHome, ".dsh", "cordis.patch.yml"), "# layer off\n[]\n", "utf8");
  const revived = run(disabledHome);
  assert.doesNotMatch(revived, /\[\]/, "an appended-to `[]` would make the layer unparsable");
  assert.match(revived, /^- insert:$/m);

  // 3. A hand-written row is preserved, and a second run replaces our block instead of stacking.
  const sharedHome = mkdtempSync(path.join(os.tmpdir(), "ssworld-dsh-shared-"));
  mkdirSync(path.join(sharedHome, ".dsh"));
  writeFileSync(path.join(sharedHome, ".dsh", "cordis.patch.yml"), "- id: session-telemetry-otel\n  disabled: true\n", "utf8");
  run(sharedHome);
  const twice = run(sharedHome);
  assert.match(twice, /^- id: session-telemetry-otel\n {2}disabled: true$/m, "hand-written row must survive");
  assert.equal((twice.match(/- id: mcp-ssworld/g) || []).length, 1, "our row must not stack up");
  assert.equal((twice.match(/# >>> ssworld/g) || []).length, 1);
});

test("install leaves a hand-written DSH mcp-ssworld row alone instead of colliding with it", () => {
  // DSH requires serverName to be unique across live instances, so a second row for the same
  // server is a collision, not an override -- and a hand-written one may be deliberately tuned.
  const home = mkdtempSync(path.join(os.tmpdir(), "ssworld-dsh-handwritten-"));
  mkdirSync(path.join(home, ".dsh"));
  const handwritten = [
    "- insert:",
    "    - id: mcp-ssworld",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: ssworld",
    "        transport: stdio",
    "        command: /usr/bin/node",
    "        args:",
    "          - /somewhere/else/bin/ssworld-mcp.mjs",
    "        toolCallTimeoutMs: 300000",
    "",
  ].join("\n");
  writeFileSync(path.join(home, ".dsh", "cordis.patch.yml"), handwritten, "utf8");
  const env = { ...process.env, HOME: home, USERPROFILE: home, SSWORLD_INSTALL_NO_CLI: "1", SSWORLD_HOME: path.join(home, ".ssworld") };
  delete env.DSH_HOME;
  const result = spawnSync(process.execPath, [BIN, "install", "--local", "--no-engine", "--client=dsh"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(home, ".dsh", "cordis.patch.yml"), "utf8"), handwritten, "the layer must be byte-identical");
  const report = JSON.parse(result.stdout);
  assert.match(report.registered[0].skipped, /existing mcp-ssworld row/);
});
