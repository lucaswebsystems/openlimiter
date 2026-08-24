/**
 * Generate every OpenLimiter logo output from the frozen live lockup.
 *
 * The only editable artwork is openlimiter-lockup.svg. The bare mark, product
 * copies, data URIs and raster tile are derived here and covered by the brand
 * manifest.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ICON, assertGeometry, renderPng } from "../../apps/web/scripts/icons.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CANONICAL_PATH = path.join(HERE, "openlimiter-lockup.svg");
const CANONICAL = readFileSync(CANONICAL_PATH, "utf8");
const CANONICAL_SHA256 = createHash("sha256").update(CANONICAL).digest("hex");

const markMatch = CANONICAL.match(
  /  <g id="openlimiter-mark"[^>]*>([\s\S]*?)\n  <\/g>/,
);
if (markMatch === null) throw new Error("The canonical lockup is missing its mark group.");
const paths = markMatch[1].match(/<path\b[^>]*\/>/g) ?? [];
if (paths.length !== 8) throw new Error("The frozen live mark must contain eight segments.");
if (!CANONICAL.includes("OpenLimiter Wordmark") || !CANONICAL.includes("data:font/woff2;base64,")) {
  throw new Error("The canonical lockup must carry its frozen wordmark font.");
}
if (!CANONICAL.includes('data-source-commit="38c96fddab35cf50dd0bccd413ec9be78575d4ed"')) {
  throw new Error("The canonical lockup must remain tied to the v1.0.2 header source.");
}
if (!CANONICAL.includes('stroke="#0866FF"')) {
  throw new Error("The canonical lockup must retain the live brand blue.");
}

function fixedWordmark(svg, colour) {
  return svg
    .replace("fill: #0D0D0F;", `fill: ${colour};`)
    .replace(/\n    @media \(prefers-color-scheme: dark\) \{ \.wordmark \{ fill: #F2F2F3; \} \}/, "");
}

const light = fixedWordmark(CANONICAL, "#0D0D0F");
const dark = fixedWordmark(CANONICAL, "#F2F2F3");
const mark = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400" role="img" aria-label="OpenLimiter">',
  '  <g id="openlimiter-mark" data-centre="100" data-radius="72" data-stroke="34">',
  ...paths.map((line) => `  ${line.trim()}`),
  "  </g>",
  "</svg>",
  "",
].join("\n");

function write(relative, contents) {
  const target = path.join(ROOT, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function dataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

write("assets/brand/openlimiter-mark.svg", mark);
write("assets/brand/openlimiter-lockup-light.svg", light);
write("assets/brand/openlimiter-lockup-dark.svg", dark);
write("apps/web/public/brand/openlimiter-mark.svg", mark);
write("apps/web/public/brand/openlimiter-lockup-light.svg", light);
write("apps/web/public/brand/openlimiter-lockup-dark.svg", dark);
write("apps/desktop/ui/brand/openlimiter-mark.svg", mark);
write("apps/desktop/ui/brand/openlimiter-lockup-light.svg", light);
write("apps/desktop/ui/brand/openlimiter-lockup-dark.svg", dark);
write(
  "apps/web/lib/brand.generated.ts",
  [
    "/** Generated from assets/brand/openlimiter-lockup.svg. Do not edit. */",
    `export const BRAND_MARK_DATA_URI = ${JSON.stringify(dataUri(mark))};`,
    `export const BRAND_LOCKUP_LIGHT_DATA_URI = ${JSON.stringify(dataUri(light))};`,
    `export const BRAND_LOCKUP_DARK_DATA_URI = ${JSON.stringify(dataUri(dark))};`,
    "export const BRAND_LOCKUP_ASPECT_RATIO = 171.953125 / 36;",
    "",
  ].join("\n"),
);
write("assets/brand/openlimiter-tile-1024.png", renderPng(1024, APP_ICON));
write(
  "assets/brand/generator.provenance.json",
  JSON.stringify({ canonicalSha256: CANONICAL_SHA256 }, null, 2) + "\n",
);
assertGeometry();
process.stdout.write("Generated every logo output from the frozen live lockup.\n");
