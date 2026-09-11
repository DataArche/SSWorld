// The project's index.html is page-owned (users add overlays to it), so the template is only re-applied
// when the page predates a runtime feature the compiled scene needs. Today: managed assets (Model/Texture)
// need the resolveManagedAsset hook that template 0.7.2 wires into createRuntime.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TEMPLATE_ROOT } from "./paths.mjs";

export function renderTemplate(template, values) {
  return template.replace(/__([A-Z_]+)__/g, (match, key) => (key in values ? values[key] : match));
}

export function pageValues(name, { title, anchor }) {
  return {
    NAME: name, NAME_JSON: JSON.stringify(name), TITLE: title || name,
    ANCHOR_LON: String(anchor.lon), ANCHOR_LAT: String(anchor.lat), ANCHOR_HEIGHT: String(anchor.height),
    WATCH_PATH: `projects/${name}`,
  };
}

const ASSET_HOOK = "resolveManagedAsset";

/** Re-render index.html from the current template when the scene references assets and the page lacks the hook. */
export function ensureAssetCapablePage(directory, { name, anchor, usesAssets }) {
  const pageFile = path.join(directory, "index.html");
  if (!usesAssets || !existsSync(pageFile)) return null;
  const current = readFileSync(pageFile, "utf8");
  if (current.includes(ASSET_HOOK)) return null;
  const title = current.match(/<h1>([^<]*)<\/h1>/)?.[1] || current.match(/<title>([^<·]*)/)?.[1]?.trim() || name;
  const rendered = renderTemplate(readFileSync(path.join(TEMPLATE_ROOT, "index.html"), "utf8"), pageValues(name, { title, anchor }));
  const backup = `index.html.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(pageFile, path.join(directory, backup));
  writeFileSync(pageFile, rendered, "utf8");
  return { upgraded: true, backup, reason: `index.html predates managed assets; re-rendered from the ${ASSET_HOOK} template (overlays you added live in ${backup})` };
}
