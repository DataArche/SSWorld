import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const template = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "template", "index.html"), "utf8");

// The page cached managed asset bytes by asset_id alone.  asset_id is a stable file name, so after an
// author replaced assets/foo.png and hot-reloaded, the page handed the engine the OLD bytes and the
// runtime's own size check fired ("managed bytes do not match the declared size") — clearable only by a
// full page reload.  Keying on the content digest as well makes a changed file always miss the cache
// while an unchanged one still survives the reload.
test("the page's managed asset cache is keyed by content digest, not by asset_id alone", () => {
  const key = /const cacheKey = `\$\{ref\.asset_id\}@\$\{ref\.content_digest\}`;/.exec(template);
  assert.ok(key, "resolveManagedAsset must derive a cache key that includes content_digest");
  for (const call of template.matchAll(/assetCache\.(has|get|set|delete)\(([^,)]+)/g)) {
    assert.equal(call[2].trim(), "cacheKey",
      `assetCache.${call[1]} must use the digest-bearing key, got ${call[2].trim()}`);
  }
});
