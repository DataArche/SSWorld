// Engine pair (SSmap.js + SSmap.wasm) resolution. The pair is pinned by engine.lock.json and
// fetched from a GitHub Release on first use; a package-local engine/ directory or
// SSWORLD_ENGINE_DIR wins when present so offline installs keep working.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENGINE_CACHE, PACKAGE_ROOT } from "./paths.mjs";

export const ENGINE_FILES = ["SSmap.js", "SSmap.wasm"];
export const SUPPORT_FILES = ["qtloader.js", "integer-codec.js", "expression-runtime.js"];

export function readLock() {
  const lockPath = path.join(PACKAGE_ROOT, "engine.lock.json");
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, "utf8"));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function pairComplete(directory) {
  return ENGINE_FILES.every((name) => existsSync(path.join(directory, name)));
}

function verifyAgainstLock(directory, lock) {
  if (!lock) return { ok: true, verified: false };
  for (const asset of lock.assets) {
    const file = path.join(directory, asset.name);
    if (!existsSync(file)) return { ok: false, reason: `${asset.name} missing` };
    if (statSync(file).size !== asset.size) return { ok: false, reason: `${asset.name} size mismatch` };
  }
  return { ok: true, verified: true };
}

export function engineStatus() {
  const lock = readLock();
  const candidates = [];
  if (process.env.SSWORLD_ENGINE_DIR) candidates.push({ source: "env", dir: path.resolve(process.env.SSWORLD_ENGINE_DIR) });
  candidates.push({ source: "package", dir: path.join(PACKAGE_ROOT, "engine") });
  if (lock) candidates.push({ source: "cache", dir: path.join(ENGINE_CACHE, lock.engine_id) });
  for (const candidate of candidates) {
    if (!pairComplete(candidate.dir)) continue;
    const check = candidate.source === "env" ? { ok: true, verified: false } : verifyAgainstLock(candidate.dir, lock);
    if (check.ok) return { ready: true, source: candidate.source, dir: candidate.dir, engine_id: lock?.engine_id || null, verified: check.verified };
  }
  return { ready: false, engine_id: lock?.engine_id || null, release: lock?.release || null, download_base: lock?.download_base || null,
    dir: lock ? path.join(ENGINE_CACHE, lock.engine_id) : null };
}

async function download(url, destination, expectedSha256, onProgress) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  const chunks = [];
  let received = 0;
  const total = Number(response.headers.get("content-length") || 0);
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    onProgress?.(received, total);
  }
  const data = Buffer.concat(chunks);
  const digest = createHash("sha256").update(data).digest("hex");
  if (expectedSha256 && digest !== expectedSha256) {
    throw new Error(`sha256 mismatch for ${path.basename(destination)}: expected ${expectedSha256}, got ${digest}`);
  }
  const partial = `${destination}.part`;
  writeFileSync(partial, data);
  renameSync(partial, destination);
  return digest;
}

export async function ensureEngine({ log = () => {} } = {}) {
  const status = engineStatus();
  if (status.ready) return status;
  const lock = readLock();
  if (!lock) throw new Error("engine.lock.json missing; this package was built without an engine pin");
  const directory = path.join(ENGINE_CACHE, lock.engine_id);
  mkdirSync(directory, { recursive: true });
  for (const asset of lock.assets) {
    const destination = path.join(directory, asset.name);
    if (existsSync(destination) && statSync(destination).size === asset.size && sha256(destination) === asset.sha256) continue;
    const base = process.env.SSWORLD_ENGINE_BASE || lock.download_base;
    const url = `${base.replace(/\/?$/, "/")}${asset.name}`;
    log(`downloading ${asset.name} (${(asset.size / 1048576).toFixed(1)} MiB) from ${url}`);
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await download(url, destination, asset.sha256, (received, total) => {
          if (total && received === total) log(`${asset.name}: complete`);
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (/sha256 mismatch/.test(error.message)) break;
        log(`${asset.name}: attempt ${attempt} failed (${error.cause?.code || error.message}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
    if (lastError) throw lastError;
  }
  const after = engineStatus();
  if (!after.ready) throw new Error("engine download finished but the pair is still incomplete");
  return after;
}
