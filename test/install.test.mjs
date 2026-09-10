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
  const env = { ...process.env, HOME: home, USERPROFILE: home, SSWORLD_INSTALL_NO_CLI: "1", SSWORLD_HOME: path.join(home, ".ssworld") };
  // The writers honour HERMES_HOME / CODEX_HOME; the host's values must never leak into the test.
  delete env.HERMES_HOME;
  delete env.CODEX_HOME;
  const result = spawnSync(process.execPath, [BIN, "install", "--local", "--no-engine", "--client=claude,codex,hermes,cursor"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.bin, BIN);
  assert.deepEqual(report.registered.map((entry) => entry.client), ["claude", "codex", "hermes", "cursor"]);

  const claude = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.deepEqual(claude.mcpServers.ssworld, { type: "stdio", command: process.execPath, args: [BIN] });
  const codex = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^model = "gpt-5"/);
  assert.match(codex, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.match(codex, /\[mcp_servers\.ssworld\]\ncommand = ".*"\nargs = \[".*ssworld-mcp\.mjs"\]/);
  const hermes = readFileSync(path.join(home, ".hermes", "config.yaml"), "utf8");
  assert.match(hermes, /mcp_servers:\n  ssworld:\n    command: ".*"\n    args: \[.*\]\n  other:\n    command: x/);
  const cursor = JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.ssworld.args[0], BIN);

  // Second run must be idempotent (no duplicated blocks).
  const again = spawnSync(process.execPath, [BIN, "install", "--local", "--no-engine", "--client=codex,hermes"], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal((readFileSync(path.join(home, ".codex", "config.toml"), "utf8").match(/\[mcp_servers\.ssworld\]/g) || []).length, 1);
  assert.equal((readFileSync(path.join(home, ".hermes", "config.yaml"), "utf8").match(/^  ssworld:/gm) || []).length, 1);
  assert.equal(existsSync(path.join(home, ".ssworld", "engine")), false, "--no-engine must not download");
});
