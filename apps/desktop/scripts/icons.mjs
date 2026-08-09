/**
 * Render every icon the desktop bundle needs.
 *
 *   node apps/desktop/scripts/icons.mjs
 *
 * The artwork and the rasteriser both come from the web application's icon
 * script, so the tray icon, the taskbar icon, the favicon and the home screen
 * icon are all the same mark rendered from one definition. Nothing here draws
 * anything of its own.
 *
 * Windows also wants a single .ico carrying several sizes. An .ico is a very
 * small container format, so it is written here rather than pulling in an
 * image library: a directory of entries, each pointing at a PNG that this
 * script already produced.
 *
 * Not written here: icon.icns, which macOS bundling wants. Producing one needs
 * macOS tooling, and the Tauri command line tool generates it in one step:
 *
 *   pnpm tauri icon src-tauri/icons/icon.png
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MASKABLE,
  TILE,
  assertGeometry,
  encodePng,
  renderTile,
} from "../../web/app/app/engine/icons.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "src-tauri", "icons");

/**
 * Pack PNGs into an .ico.
 *
 * Every entry is a whole PNG file, which Windows has accepted since Vista and
 * which keeps the alpha channel intact. A width or height of 256 is written as
 * zero, because the field is one byte wide.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

function tile(size, treatment = TILE) {
  return encodePng(renderTile(size, treatment), size, size);
}

assertGeometry();
mkdirSync(OUT, { recursive: true });

/* The four sizes Tauri lists in its bundle configuration by default. */
const pngs = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
];

for (const [name, size] of pngs) {
  writeFileSync(path.join(OUT, name), tile(size));
  process.stdout.write("Wrote " + name + " at " + String(size) + " pixels.\n");
}

/* The tray icon. Small, so it uses the maskable treatment: edge to edge, with
   the ring pulled in, which stays legible next to a clock at sixteen pixels. */
for (const size of [16, 24, 32]) {
  const name = "tray-" + String(size) + ".png";
  writeFileSync(path.join(OUT, name), tile(size, MASKABLE));
  process.stdout.write("Wrote " + name + " at " + String(size) + " pixels.\n");
}

writeFileSync(
  path.join(OUT, "icon.ico"),
  encodeIco([16, 32, 48, 256].map((size) => ({ size, png: tile(size) }))),
);
process.stdout.write("Wrote icon.ico carrying 16, 32, 48 and 256 pixels.\n");
