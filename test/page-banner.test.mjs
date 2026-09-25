import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TEMPLATE_ROOT } from "../src/paths.mjs";

// A load failure must reach the author even when the project's own styles hide #hint. What makes the banner
// style-proof is structural, so that is what is pinned here: a real browser run with a hostile stylesheet
// (display/visibility/opacity !important on the banner and on every child of <html>) showed it only with
// all three in place, and dropping the inline !important let the stylesheet hide it.
const page = readFileSync(path.join(TEMPLATE_ROOT, "index.html"), "utf8");

test("the error banner sits outside the page's reach", () => {
  const style = page.match(/hostElement\.setAttribute\("style", "([^"]+)"\)/);
  assert.ok(style, "the banner host carries its own inline style");
  const declarations = style[1].split(";").map((item) => item.trim()).filter(Boolean);
  assert.ok(declarations.length >= 5);
  for (const declaration of declarations) assert.match(declaration, /!important$/, `inline declaration without !important: ${declaration}`);
  assert.match(page, /hostElement\.style\.setProperty\("display", display, "important"\)/);
  assert.match(page, /hostElement\.attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(page, /document\.documentElement\.appendChild\(hostElement\)/, "attached to <html>, re-attached when removed");
});

test("load failures and texture failures raise the banner; a good load clears it", () => {
  const failure = page.match(/function showFailure\(error\) \{[\s\S]*?\n    \}/)[0];
  assert.match(failure, /banner\.show\(/);
  assert.match(page, /on\("asseterror"[\s\S]*?banner\.show\(`Texture failed/);
  assert.match(page, /hot reload ready";\s*banner\.clear\(\);/);
  assert.match(page, /banner: banner\.state\(\)/, "the page reports what the author is shown");
});
