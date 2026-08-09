/**
 * Render the home screen icons this application needs.
 *
 *   node apps/web/app/app/engine/icons.mjs
 *
 * The favicon and the Apple touch icon already come from the image routes in
 * app/, so the only icons missing were the ones a web application manifest
 * asks for by file. They are rendered here rather than drawn, from the same
 * approved arc geometry the site renders in app/app/../lib/brand.ts and
 * assets/brand/generate.mjs, so every OpenLimiter mark anywhere is the same
 * shape. Nothing outside Node's own zlib is used.
 *
 * Three files come out:
 *   192 and 512, the rounded tile, which is what a browser shows as is.
 *   maskable 512, edge to edge with the ring pulled into the safe area, which
 *   is what Android crops into whatever shape the launcher prefers.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "..", "..", "public", "icons");

/* The brand: one blue, and the mark inverted to white on top of it. */
const BLUE = [0x08, 0x66, 0xff];
const WHITE = [0xff, 0xff, 0xff];

/* The approved mark, in its own two hundred unit box. Eight arcs on one
   radius, the first sweeping a quarter turn and each next one a fixed
   fraction of the one before, with equal gaps that close the circle. */
const SEGMENTS = 8;
const FIRST_SWEEP = 90;
const GAP = 8;
const RADIUS = 72;
const STROKE = 34;
const ALPHA_FLOOR = 0.25;

function solveRatio() {
  const target = 360 - SEGMENTS * GAP;
  let low = 0.05;
  let high = 0.999;
  for (let step = 0; step < 200; step += 1) {
    const ratio = (low + high) / 2;
    const sum = (FIRST_SWEEP * (1 - Math.pow(ratio, SEGMENTS))) / (1 - ratio);
    if (sum > target) high = ratio;
    else low = ratio;
  }
  return (low + high) / 2;
}

const RATIO = solveRatio();

const SEGMENT_LIST = (() => {
  const list = [];
  let angle = 0;
  for (let index = 0; index < SEGMENTS; index += 1) {
    const sweep = FIRST_SWEEP * Math.pow(RATIO, index);
    const alpha = 1 - (1 - ALPHA_FLOOR) * (index / (SEGMENTS - 1));
    list.push({ start: angle, sweep, alpha: Number(alpha.toFixed(3)) });
    angle += sweep + GAP;
  }
  return list;
})();

/* The first arc has to start at twelve o'clock and sweep exactly a quarter
   turn, and the last has to close the circle. If the maths ever stops doing
   that, nothing is written. */
function assertGeometry() {
  const first = SEGMENT_LIST[0];
  const last = SEGMENT_LIST[SEGMENT_LIST.length - 1];
  const closes = last.start + last.sweep + GAP;
  if (first.start !== 0 || first.sweep !== FIRST_SWEEP) {
    throw new Error("The first arc is no longer a quarter turn from the top.");
  }
  if (Math.abs(closes - 360) > 0.001) {
    throw new Error("The arcs no longer close the circle: " + String(closes));
  }
}

const SAMPLES = 4;

/**
 * Rasterise the mark on a tile, at any size.
 *
 * Exported so the desktop application can render its own icons from this one
 * definition rather than keeping a second copy of the artwork.
 */
export function renderTile(size, { cornerRatio, markRatio }) {
  const corner = size * cornerRatio;
  const scale = (size * markRatio) / 200;
  const centre = size / 2;
  const ring = RADIUS * scale;
  const half = (STROKE / 2) * scale;
  const inner = ring - half;
  const outer = ring + half;

  const pixels = Buffer.allocUnsafe(size * size * 4);
  const step = 1 / SAMPLES;
  const total = SAMPLES * SAMPLES;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      let ink = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        const py = y + (sy + 0.5) * step;
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) * step;
          const dxCorner = Math.max(corner - px, px - (size - corner), 0);
          const dyCorner = Math.max(corner - py, py - (size - corner), 0);
          if (dxCorner * dxCorner + dyCorner * dyCorner > corner * corner) continue;
          inside += 1;

          const dx = px - centre;
          const dy = py - centre;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < inner || distance > outer) continue;

          let angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
          if (angle < 0) angle += 360;
          for (const segment of SEGMENT_LIST) {
            if (angle >= segment.start && angle <= segment.start + segment.sweep) {
              ink += segment.alpha;
              break;
            }
          }
        }
      }
      const coverage = inside === 0 ? 0 : ink / inside;
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          BLUE[channel] + (WHITE[channel] - BLUE[channel]) * coverage,
        );
      }
      pixels[offset + 3] = Math.round((inside / total) * 255);
    }
  }
  return pixels;
}

/* ------------------------------------------------------------ png encoding */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodePng(pixels, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; /* bit depth */
  header[9] = 6; /* truecolour with alpha */
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; /* filter: none */
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- write */

/** The tile treatment the favicon and the Apple icon already use. */
export const TILE = { cornerRatio: 0.22, markRatio: 0.68 };
/** Edge to edge, ring inside the central eighty percent a launcher may keep. */
export const MASKABLE = { cornerRatio: 0, markRatio: 0.55 };

export { assertGeometry };

/* Only writes when this file is the program being run, so another script can
   import the renderer without a folder of icons appearing beside it. */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  assertGeometry();
  mkdirSync(OUT, { recursive: true });
  const files = [
    ["openlimiter-192.png", 192, TILE],
    ["openlimiter-512.png", 512, TILE],
    ["openlimiter-maskable-512.png", 512, MASKABLE],
  ];
  for (const [name, size, treatment] of files) {
    writeFileSync(path.join(OUT, name), encodePng(renderTile(size, treatment), size, size));
    process.stdout.write("Wrote " + name + " at " + String(size) + " pixels.\n");
  }
}
