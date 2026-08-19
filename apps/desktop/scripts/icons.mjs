/**
 * Render every icon the desktop bundle needs.
 *
 *   node apps/desktop/scripts/icons.mjs
 *
 * The artwork, the rasteriser and the treatments all come from the web
 * application, so the ring in the taskbar, the ring in the browser tab and the
 * ring in the header are one definition. Nothing here draws anything of its own.
 *
 * The desktop application is the one surface that keeps a tile behind the mark.
 * An operating system paints this icon into a dock, a taskbar, an installer and
 * a control panel it did not choose, beside applications that all have a solid
 * silhouette, so it carries its own ground: the site's canvas colour in a
 * rounded square, with the ring in the brand blue. Everywhere a browser paints
 * the mark it goes out tileless instead, and apps/web/lib/image-palette.ts says
 * why.
 *
 * Windows also wants a single .ico carrying several sizes. An .ico is a very
 * small container format, so it is written here rather than pulling in an image
 * library, and `encodeIco` explains the one detail that has to be right.
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
  APP_TILE,
  RING,
  assertGeometry,
  encodePng,
  render,
  renderPng,
} from "../../web/scripts/icons.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "src-tauri", "icons");

/**
 * A single image inside an .ico, in the uncompressed form.
 *
 * This is the detail that decides whether Windows shows the icon or a blank
 * page, and getting it wrong is quiet: a directory of PNGs is a well formed
 * .ico that plenty of tools will open, and Explorer will still refuse to draw
 * the small sizes from it, because the shell only accepts PNG payloads for the
 * 256 pixel entry. Every entry below 256 therefore goes in as a bottom up
 * 32 bit device independent bitmap, which is what the format was built for and
 * what every icon tool emits.
 *
 * The bitmap header claims twice the real height because an .ico entry is two
 * images stacked: the colour rows, then a one bit AND mask. Alpha does the real
 * work on anything since Windows XP, but the mask still has to be there, and it
 * is filled from the alpha channel so a display falling back to it gets the
 * right silhouette rather than a rectangle.
 */
function encodeDib(pixels, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); /* header size */
  header.writeInt32LE(size, 4); /* width */
  header.writeInt32LE(size * 2, 8); /* height: colour rows plus mask rows */
  header.writeUInt16LE(1, 12); /* planes */
  header.writeUInt16LE(32, 14); /* bits per pixel */
  header.writeUInt32LE(0, 16); /* BI_RGB, no compression */

  const colour = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(size * maskStride);

  for (let y = 0; y < size; y += 1) {
    const row = size - 1 - y; /* a DIB is stored bottom up */
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = (row * size + x) * 4;
      colour[to] = pixels[from + 2];
      colour[to + 1] = pixels[from + 1];
      colour[to + 2] = pixels[from];
      colour[to + 3] = pixels[from + 3];
      /* A set bit means "leave the screen alone", so it marks transparency. */
      if (pixels[from + 3] < 128) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  header.writeUInt32LE(colour.length + mask.length, 20);
  return Buffer.concat([header, colour, mask]);
}

/**
 * Pack the images into an .ico.
 *
 * A width or height of 256 is written as zero, because the field is one byte
 * wide and 256 does not fit in it.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); /* reserved */
  header.writeUInt16LE(1, 2); /* type: icon */
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; /* palette entries: none, this is true colour */
    directory[entry + 3] = 0; /* reserved */
    directory.writeUInt16LE(1, entry + 4); /* planes */
    directory.writeUInt16LE(32, entry + 6); /* bits per pixel */
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

assertGeometry();
mkdirSync(OUT, { recursive: true });

/* The four sizes Tauri lists in its bundle configuration by default. These are
   the application icon: window, dock, taskbar, Add or remove programs. */
const pngs = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
];

for (const [name, size] of pngs) {
  writeFileSync(path.join(OUT, name), renderPng(size, APP_TILE));
  process.stdout.write("Wrote " + name + " at " + String(size) + " pixels.\n");
}

/* The tray. Tileless, because a tray icon sits directly on the taskbar rather
   than among application icons, and a filled square there is a filled square on
   somebody's clock. The geometry never changes. Only the ink does, using the
   same five pressure colours the window uses. Rust selects one from the worst
   provider reading and embeds the thirty two pixel render directly in the
   binary, while the smaller renders remain available to platform packaging. */
const trayTreatments = {
  unknown: { ...RING, ink: [0xaa, 0xaa, 0xb2] },
  ok: { ...RING, ink: [0x4a, 0xde, 0x80] },
  watch: { ...RING, ink: [0xfb, 0xbf, 0x24] },
  high: { ...RING, ink: [0xfb, 0x92, 0x3c] },
  critical: { ...RING, ink: [0xff, 0x8a, 0x80] },
};

for (const [state, treatment] of Object.entries(trayTreatments)) {
  for (const size of [16, 24, 32]) {
    const name = "tray-" + state + "-" + String(size) + ".png";
    writeFileSync(path.join(OUT, name), renderPng(size, treatment));
    process.stdout.write("Wrote " + name + " at " + String(size) + " pixels.\n");
  }
}

/* Every size Windows asks for, from the 16 pixel one beside a window title to
   the 256 pixel one in a large icon view, so nothing is ever resampled from a
   size that was not drawn for it. */
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const ico = encodeIco(
  icoSizes.map((size) => ({
    size,
    data:
      size >= 256
        ? encodePng(render(size, APP_TILE), size, size)
        : encodeDib(render(size, APP_TILE), size),
  })),
);
writeFileSync(path.join(OUT, "icon.ico"), ico);
process.stdout.write("Wrote icon.ico carrying " + icoSizes.join(", ") + " pixels.\n");
