// `ssworld-mcp install`: make this package a global npm install (so agent apps get a stable
// command), then register it with the chosen agent apps. Config edits are minimal and idempotent.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE, PACKAGE_ROOT, SERVER_NAME, repositorySlug } from "./paths.mjs";
import { ensureEngine } from "./engine.mjs";

const CLIENTS = ["claude", "codex", "hermes", "cursor", "dsh"];

/** Copy skills/ssworld into a client's skill directory. Hermes and Codex both discover
 *  <home>/skills/<name>/SKILL.md on their own, so the file is the whole registration --
 *  Codex's [[skills.config]] only records skills that were explicitly disabled. */
function installSkill(skillsRoot) {
  const source = path.join(PACKAGE_ROOT, "skills", "ssworld");
  if (!existsSync(source)) return null;
  const target = path.join(skillsRoot, "ssworld");
  cpSync(source, target, { recursive: true });
  return target;
}
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

/** The registry spec for this exact version, or null when it is not published there.  A registry
 *  fetch beats a `github:` clone -- it is faster, cached, and needs no git on the machine -- but a
 *  local build or an unreleased version only exists in the repository, so the caller falls back. */
function registrySource() {
  const probe = run(npm, ["view", `${PACKAGE.name}@${PACKAGE.version}`, "version"], { allowAlways: true });
  return probe.ok && probe.stdout === PACKAGE.version ? `${PACKAGE.name}@${PACKAGE.version}` : null;
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
  const source = spec || registrySource() || (repositorySlug() ? `github:${repositorySlug()}` : PACKAGE_ROOT);
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
    const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
    const skill = installSkill(path.join(codexHome, "skills"));
    const cli = run(process.platform === "win32" ? "codex.cmd" : "codex", ["mcp", "add", SERVER_NAME, "--", spec.command, ...spec.args]);
    if (cli.ok) return { client: "codex", via: "codex mcp add", skill };
    const file = path.join(codexHome, "config.toml");
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
    return { client: "codex", via: file, skill };
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
    // Ship the SSWorld skill so Hermes reaches for the server on its own.
    return { client: "hermes", via: file, skill: installSkill(path.join(hermesHome, "skills")) };
  },
  // DSH has no mcpServers map: every MCP server is one row of its Cordis plugin tree, added through
  // the home user patch layer ~/.dsh/cordis.patch.yml.  That file must parse to a top-level YAML
  // array -- DSH throws on a present-but-empty one rather than treating it as "no layer", and `[]`
  // is its documented way to disable the layer -- so an empty or `[]` file is replaced wholesale
  // instead of appended to, which would produce YAML that cannot parse at all.  Our rows live
  // between sentinels so a re-run replaces them and leaves every hand-written row alone.
  dsh(spec) {
    const dshHome = process.env.DSH_HOME || path.join(home, ".dsh");
    const file = path.join(dshHome, "cordis.patch.yml");
    const open = `# >>> ${SERVER_NAME} (managed by ssworld-mcp install)`;
    const close = `# <<< ${SERVER_NAME}`;
    const block = [
      open,
      "- insert:",
      `    - id: mcp-${SERVER_NAME}`,
      '      name: "@deepseek-ai/dsh-mcp-client"',
      "      config:",
      `        serverName: ${SERVER_NAME}`,
      "        transport: stdio",
      `        command: ${JSON.stringify(spec.command)}`,
      `        args: ${JSON.stringify(spec.args)}`,
      // ssworld_capture_frame renders a frame offscreen and reads it back; a large scene can
      // outlast the 60 s default and the timeout aborts the call, not just the wait.
      "        toolCallTimeoutMs: 120000",
      close,
    ].join("\n");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const rows = current.replace(/^\s*(#[^\n]*\n?|\s)*/, "").trim();
    let next;
    if (!current.includes(open) && /^\s*-?\s*id:\s*mcp-ssworld\s*$/m.test(current)) {
      // A hand-written row for this server is already there -- and DSH requires serverName to be
      // unique across live instances, so appending ours would collide rather than override.  Theirs
      // may also be deliberately tuned; leave it exactly as it is and say so.
      return { client: "dsh", via: file, skipped: "an existing mcp-ssworld row was left untouched" };
    }
    if (current.includes(open) && current.includes(close)) {
      const start = current.indexOf(open);
      const end = current.indexOf(close) + close.length;
      next = current.slice(0, start) + block + current.slice(end);
    } else if (rows === "" || rows === "[]") {
      next = `${block}\n`;
    } else {
      next = `${current.replace(/\s*$/, "")}\n${block}\n`;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next, "utf8");
    return { client: "dsh", via: file, skill: installSkill(path.join(dshHome, "skills")) };
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
  if (existsSync(process.env.DSH_HOME || path.join(home, ".dsh"))) found.push("dsh");
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
