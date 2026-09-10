// `ssworld-mcp install`: make this package a global npm install (so agent apps get a stable
// command), then register it with the chosen agent apps. Config edits are minimal and idempotent.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE, PACKAGE_ROOT, SERVER_NAME, repositorySlug } from "./paths.mjs";
import { ensureEngine } from "./engine.mjs";

const CLIENTS = ["claude", "codex", "hermes", "cursor"];
const log = (line) => process.stderr.write(`${line}\n`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  if (process.env.SSWORLD_INSTALL_NO_CLI && !/^npm/.test(command) && !options.allowAlways) return { ok: false, stdout: "", stderr: "cli disabled" };
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32", ...options });
  return { ok: result.status === 0, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

function globalRoot() {
  const result = run(npm, ["root", "-g"], { allowAlways: true });
  if (!result.ok) throw new Error(`npm root -g failed: ${result.stderr}`);
  return result.stdout;
}

/** Returns the absolute path of the bin script that agent apps should launch. */
export function ensureGlobalInstall({ spec } = {}) {
  const root = globalRoot();
  const installed = path.join(root, PACKAGE.name, "bin", "ssworld-mcp.mjs");
  const here = path.join(PACKAGE_ROOT, "bin", "ssworld-mcp.mjs");
  const sameVersion = existsSync(installed) && (() => {
    try { return JSON.parse(readFileSync(path.join(root, PACKAGE.name, "package.json"), "utf8")).version === PACKAGE.version; } catch { return false; }
  })();
  if (path.resolve(installed) === path.resolve(here) || sameVersion) return installed;
  const source = spec || (repositorySlug() ? `github:${repositorySlug()}` : PACKAGE_ROOT);
  log(`installing ${PACKAGE.name}@${PACKAGE.version} globally from ${source} …`);
  const result = run(npm, ["install", "-g", source], { stdio: ["ignore", "inherit", "inherit"] });
  if (!result.ok) throw new Error("npm install -g failed");
  if (!existsSync(installed)) throw new Error(`global install did not produce ${installed}`);
  return installed;
}

function serverSpec(binPath) {
  return { command: process.execPath, args: [binPath] };
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const home = os.homedir();

const WRITERS = {
  claude(spec) {
    const cli = run(process.platform === "win32" ? "claude.cmd" : "claude", ["mcp", "remove", "-s", "user", SERVER_NAME]);
    void cli;
    const added = run(process.platform === "win32" ? "claude.cmd" : "claude", ["mcp", "add", "-s", "user", SERVER_NAME, "--", spec.command, ...spec.args]);
    if (added.ok) return { client: "claude", via: "claude mcp add", scope: "user" };
    const file = path.join(home, ".claude.json");
    const config = readJson(file);
    config.mcpServers = { ...(config.mcpServers || {}), [SERVER_NAME]: { type: "stdio", ...spec } };
    writeJson(file, config);
    return { client: "claude", via: file };
  },
  codex(spec) {
    const cli = run(process.platform === "win32" ? "codex.cmd" : "codex", ["mcp", "add", SERVER_NAME, "--", spec.command, ...spec.args]);
    if (cli.ok) return { client: "codex", via: "codex mcp add" };
    const file = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const header = `[mcp_servers.${SERVER_NAME}]`;
    const block = `${header}\ncommand = ${JSON.stringify(spec.command)}\nargs = ${JSON.stringify(spec.args)}\n`;
    let next;
    if (current.includes(header)) {
      next = current.replace(new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\][^\\[]*`), block);
    } else {
      next = `${current.replace(/\s*$/, "")}\n\n${block}`;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next.replace(/^\n+/, ""), "utf8");
    return { client: "codex", via: file };
  },
  hermes(spec) {
    const hermesHome = process.env.HERMES_HOME || path.join(home, ".hermes");
    const file = path.join(hermesHome, "config.yaml");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const entry = `  ${SERVER_NAME}:\n    command: ${JSON.stringify(spec.command)}\n    args: ${JSON.stringify(spec.args)}\n`;
    let next;
    const entryRe = new RegExp(`^  ${SERVER_NAME}:\\n(?:    .*\\n?)*`, "m");
    if (/^mcp_servers:\s*$/m.test(current)) {
      next = entryRe.test(current)
        ? current.replace(entryRe, entry)
        : current.replace(/^mcp_servers:\s*$/m, (line) => `${line}\n${entry.replace(/\n$/, "")}`);
    } else {
      next = `${current.replace(/\s*$/, "")}\n\nmcp_servers:\n${entry}`;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next.replace(/^\n+/, ""), "utf8");
    return { client: "hermes", via: file };
  },
  cursor(spec) {
    const file = path.join(home, ".cursor", "mcp.json");
    const config = readJson(file);
    config.mcpServers = { ...(config.mcpServers || {}), [SERVER_NAME]: spec };
    writeJson(file, config);
    return { client: "cursor", via: file };
  },
};

function detectClients() {
  const found = [];
  if (existsSync(path.join(home, ".claude")) || existsSync(path.join(home, ".claude.json"))) found.push("claude");
  if (existsSync(process.env.CODEX_HOME || path.join(home, ".codex"))) found.push("codex");
  if (existsSync(process.env.HERMES_HOME || path.join(home, ".hermes"))) found.push("hermes");
  if (existsSync(path.join(home, ".cursor"))) found.push("cursor");
  return found;
}

export async function install({ clients = [], engine = true, spec, print = false, local = false } = {}) {
  const binPath = local ? path.join(PACKAGE_ROOT, "bin", "ssworld-mcp.mjs") : ensureGlobalInstall({ spec });
  const serverConfig = serverSpec(binPath);
  const targets = clients.length ? clients : detectClients();
  for (const client of targets) if (!CLIENTS.includes(client)) throw new Error(`unknown client '${client}'; choose from ${CLIENTS.join(", ")}`);
  const results = [];
  for (const client of targets) results.push(WRITERS[client](serverConfig));
  if (engine) {
    try { await ensureEngine({ log }); } catch (error) { log(`engine download skipped: ${error.message} (run 'ssworld-mcp engine' later)`); }
  }
  const snippet = { mcpServers: { [SERVER_NAME]: serverConfig } };
  if (print || !targets.length) log(`Add this to any MCP client:\n${JSON.stringify(snippet, null, 2)}`);
  return { bin: binPath, registered: results, detected: targets, snippet };
}

export { CLIENTS };
