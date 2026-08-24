/**
 * Render the tray icons after the Tauri icon pipeline has generated the app,
 * window, installer, and package icons from the canonical source SVG.
 *
 * Run through `pnpm icons`. The first command is `tauri icon` with
 * assets/brand/openlimiter-mark.svg, which the root generator first derives
 * from the frozen lockup. This command writes tray files from that geometry.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRAND,
  GAUGE,
  assertGeometry,
  renderPng,
} from "../../web/scripts/icons.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "src-tauri", "icons");

assertGeometry();
mkdirSync(OUT, { recursive: true });

const treatment = { ...GAUGE, ink: BRAND };
const states = ["unknown", "ok", "watch", "high", "critical"];

for (const size of [16, 24, 32]) {
  writeFileSync(path.join(OUT, `tray-${size}.png`), renderPng(size, treatment));
  process.stdout.write(`Wrote tray-${size}.png at ${size} pixels.\n`);
  for (const state of states) {
    const name = `tray-${state}-${size}.png`;
    writeFileSync(path.join(OUT, name), renderPng(size, treatment));
    process.stdout.write(`Wrote ${name} at ${size} pixels.\n`);
  }
}

const canonical = readFileSync(
  path.resolve(HERE, "..", "..", "..", "assets", "brand", "openlimiter-lockup.svg"),
);
writeFileSync(
  path.resolve(HERE, "..", "..", "..", "assets", "brand", "desktop-icons.provenance.json"),
  JSON.stringify({ canonicalSha256: createHash("sha256").update(canonical).digest("hex") }, null, 2) + "\n",
);
