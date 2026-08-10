/**
 * Render the icons that ship as files rather than as routes.
 *
 *   node apps/web/scripts/icons.mjs
 *
 * The favicon and the Apple touch icon are generated on request by app/icon.tsx
 * and app/apple-icon.tsx. A web application manifest, by contrast, asks for
 * icons by file name, so those three PNGs are rendered here and committed.
 *
 * Nothing here draws the mark. app/app/engine/icons.mjs owns the only
 * rasteriser in the repository and it is used unchanged, then repainted: see
 * `repaint` for exactly how, and why that is an exact operation rather than an
 * approximation. The result is that the ring in a launcher, the ring in a tab,
 * the ring in the desktop application's taskbar icon and the ring in the header
 * are all one piece of geometry with one definition.
 *
 * The treatments below are also what apps/desktop/scripts/icons.mjs imports, so
 * the desktop application's icon and the website's icons cannot drift apart.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertGeometry, encodePng, renderTile } from "../app/app/engine/icons.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "public", "icons");

/* The brand, in the same two values lib/image-palette.ts names. Change one
   there, change it here in the same pass. */
export const BRAND = [0x08, 0x66, 0xff];
export const CANVAS = [0x0d, 0x0d, 0x0f];

/**
 * The scale that puts the ring's own edge on the edge of its square.
 *
 * The arcs sit on a radius of 72 with a stroke of 34 inside a 200 unit box, so
 * the outer edge of the ink is 89 units from the centre and the artwork carries
 * 11 units of padding on every side. Multiplying the mark by 200/178 spends
 * that padding, and the ring then touches all four edges.
 */
const EDGE_TO_EDGE = 100 / 89;

/** An Android launcher guarantees only the central eighty percent. */
const SAFE_AREA = 0.8;

/**
 * The ring and nothing else: no ground, no padding, corner to corner. Every
 * icon a browser paints beside a name takes this, and app/icon.tsx says why.
 */
export const RING = {
  cornerRatio: 0,
  markRatio: EDGE_TO_EDGE,
  ground: null,
  ink: BRAND,
};

/**
 * The one icon that keeps a ground, and not as a matter of taste.
 *
 * Android crops a maskable icon into whatever shape the launcher prefers, so
 * paint has to reach every corner of the square or the crop bites into the
 * wallpaper. This one therefore fills its square with the site's own canvas
 * colour and pulls the ring inside the eighty percent the platform promises to
 * keep, which is the whole point of the maskable purpose.
 */
export const MASKABLE = {
  cornerRatio: 0,
  markRatio: EDGE_TO_EDGE * SAFE_AREA,
  ground: CANVAS,
  ink: BRAND,
};

/**
 * The desktop application's icon: the transparent ring, exactly like the
 * favicon, by the founder's explicit call. No tile, no ground: the taskbar or
 * dock paints straight through the gaps. The one trade this makes, and it was
 * made knowingly: macOS dock convention is a filled rounded tile, so the ring
 * reads less native there than a tiled icon would.
 * apps/desktop/scripts/icons.mjs renders it at every size Windows, macOS and
 * Linux ask for.
 */
export const APP_TILE = {
  cornerRatio: 0,
  markRatio: EDGE_TO_EDGE,
  ground: null,
  ink: BRAND,
};

/**
 * Repaint a tile the shared rasteriser produced, in place.
 *
 * The rasteriser draws one thing: the ring in white over a solid brand blue,
 * with the alpha channel carrying the rounded corner. Its red channel is a
 * straight interpolation from the blue's 8 to the white's 255, so the ink
 * coverage of every pixel comes back out of it exactly, to within half of one
 * of the 247 steps it was quantised into. Recovering that and painting it again
 * in two other colours is therefore lossless enough to be invisible, and it
 * keeps the arcs, the anti aliasing and the corner in one place.
 *
 * A null ground means no ground at all: the pixel takes the ink colour and the
 * coverage becomes its alpha, which is what a tileless icon is.
 */
function repaint(pixels, { ground, ink }) {
  const floor = 0x08;
  const span = 0xff - floor;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const coverage = (pixels[offset] - floor) / span;
    for (let channel = 0; channel < 3; channel += 1) {
      const base = ground === null ? ink[channel] : ground[channel];
      pixels[offset + channel] = Math.round(base + (ink[channel] - base) * coverage);
    }
    if (ground === null) pixels[offset + 3] = Math.round(pixels[offset + 3] * coverage);
  }
  return pixels;
}

/** One icon, at one size, in one treatment. Returns raw RGBA. */
export function render(size, treatment) {
  return repaint(renderTile(size, treatment), treatment);
}

/** The same, encoded. */
export function renderPng(size, treatment) {
  return encodePng(render(size, treatment), size, size);
}

export { assertGeometry, encodePng };

/* Only writes when this file is the program being run, so the desktop script
   can import the treatments without a folder of icons appearing beside it. */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  assertGeometry();
  mkdirSync(OUT, { recursive: true });
  const files = [
    ["openlimiter-192.png", 192, RING],
    ["openlimiter-512.png", 512, RING],
    ["openlimiter-maskable-512.png", 512, MASKABLE],
  ];
  for (const [name, size, treatment] of files) {
    writeFileSync(path.join(OUT, name), renderPng(size, treatment));
    process.stdout.write("Wrote " + name + " at " + String(size) + " pixels.\n");
  }
}
