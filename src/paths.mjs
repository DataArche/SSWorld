import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { PACKAGE_ROOT, SSDL_ROOT } from "./ssdl-root.mjs";

export { PACKAGE_ROOT, SSDL_ROOT };
export const PACKAGE = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
export const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, "template");
export const HOME = path.resolve(process.env.SSWORLD_HOME || path.join(os.homedir(), ".ssworld"));
export const PROJECTS_ROOT = path.join(HOME, "projects");
export const ENGINE_CACHE = path.join(HOME, "engine");
export const PREVIEW_PORT = Number(process.env.SSWORLD_PREVIEW_PORT || 8880);
export const SERVER_NAME = "ssworld";

export function repositorySlug() {
  const url = PACKAGE.repository?.url || "";
  const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}
