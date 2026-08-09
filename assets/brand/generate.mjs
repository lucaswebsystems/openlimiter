/**
 * Regenerates every file in this folder.
 *
 *   node assets/brand/generate.mjs
 *
 * It takes no dependencies at all. The vector files are written as text and
 * the tile is rasterised and PNG encoded here, using nothing outside Node's
 * own zlib.
 *
 * The mark is not copied from anywhere. It is recomputed from the parameters
 * that define it, and then checked character for character against the
 * approved artwork below, so a change to the maths that moves a single
 * coordinate fails loudly instead of shipping a slightly different logo.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* The brand, in full. One blue, and alpha is the only variation. */
const BLUE = "#0866FF";
const WHITE = "#FFFFFF";
const HEADING_LIGHT = "#0D0D0F";
const HEADING_DARK = "#F2F2F3";

/* The mark. Eight arcs on one radius inside a 200 unit box: the first sweeps a
   quarter of the circle, each next one sweeps a fixed fraction of the one
   before, the gaps are equal, and the fractions are chosen so the whole set
   closes the circle exactly. */
const SEGMENTS = 8;
const FIRST_SWEEP = 90;
const GAP = 8;
const CENTRE = 100;
const RADIUS = 72;
const STROKE = 34;
const ALPHA_FLOOR = 0.25;

function point(angleDegrees, radius) {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  return [CENTRE + radius * Math.cos(radians), CENTRE + radius * Math.sin(radians)];
}

/** The fraction that makes the segments and the gaps close the circle. */
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

/** Every segment, largest first, with its start angle, sweep and alpha. */
function segments() {
  const list = [];
  let angle = 0;
  for (let index = 0; index < SEGMENTS; index += 1) {
    const sweep = FIRST_SWEEP * Math.pow(RATIO, index);
    const alpha = 1 - (1 - ALPHA_FLOOR) * (index / (SEGMENTS - 1));
    list.push({ start: angle, sweep, alpha: Number(alpha.toFixed(3)) });
    angle += sweep + GAP;
  }
  return list;
}

const SEGMENT_LIST = segments();

function arc({ start, sweep }) {
  const [x0, y0] = point(start, RADIUS);
  const [x1, y1] = point(start + sweep, RADIUS);
  const large = sweep > 180 ? 1 : 0;
  return (
    `M ${x0.toFixed(3)} ${y0.toFixed(3)} ` +
    `A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`
  );
}

function markPaths(colour, indent) {
  return SEGMENT_LIST.map(
    (segment) =>
      `${indent}<path d="${arc(segment)}" fill="none" stroke="${colour}"` +
      ` stroke-opacity="${segment.alpha.toFixed(3)}" stroke-width="${STROKE}"` +
      ' stroke-linecap="butt"/>',
  ).join("\n");
}

/* The approved artwork, verbatim. If the maths above stops reproducing this,
   the generator refuses to write anything. */
const APPROVED =
  'M 100.000 28.000 A 72 72 0 0 1 172.000 100.000|1.000;' +
  'M 171.299 110.020 A 72 72 0 0 1 121.589 168.687|0.893;' +
  'M 111.819 171.023 A 72 72 0 0 1 56.819 157.614|0.786;' +
  'M 49.221 151.044 A 72 72 0 0 1 29.558 114.898|0.679;' +
  'M 28.170 104.949 A 72 72 0 0 1 32.289 75.521|0.571;' +
  'M 36.355 66.336 A 72 72 0 0 1 49.052 49.125|0.464;' +
  'M 56.628 42.529 A 72 72 0 0 1 69.813 34.634|0.357;' +
  'M 79.204 31.069 A 72 72 0 0 1 89.980 28.701|0.250';

function assertApproved() {
  const actual = SEGMENT_LIST.map(
    (segment) => `${arc(segment)}|${segment.alpha.toFixed(3)}`,
  ).join(";");
  if (actual !== APPROVED) {
    throw new Error(
      "The generated mark no longer matches the approved artwork.\n" +
        `expected: ${APPROVED}\nactual:   ${actual}`,
    );
  }
}

/* ------------------------------------------------------------------ vectors */

function markSvg() {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"' +
    ' role="img" aria-label="OpenLimiter">\n' +
    `${markPaths(BLUE, "  ")}\n` +
    "</svg>\n"
  );
}

/**
 * The lockup. The wordmark is Baloo 2 SemiBold, referenced from Google Fonts,
 * with a plain sans fallback for any renderer that will not fetch it. The
 * wordmark colour follows the reader's colour scheme, near black on light and
 * near white on dark, which is what the site does with the same two values.
 */
function lockupSvg() {
  const scale = 64 / 200;
  const paths = SEGMENT_LIST.map(
    (segment) =>
      `    <path d="${arc(segment)}" fill="none" stroke="${BLUE}"` +
      ` stroke-opacity="${segment.alpha.toFixed(3)}" stroke-width="${STROKE}"` +
      ' stroke-linecap="butt"/>',
  ).join("\n");

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 104" width="460" height="104"',
    '     role="img" aria-label="OpenLimiter">',
    "  <style>",
    "    @import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@600&amp;display=swap');",
    "    .wordmark {",
    "      font-family: 'Baloo 2', ui-rounded, 'Segoe UI', system-ui, sans-serif;",
    "      font-weight: 600;",
    "      font-size: 58px;",
    `      fill: ${HEADING_LIGHT};`,
    "    }",
    "    @media (prefers-color-scheme: dark) {",
    `      .wordmark { fill: ${HEADING_DARK}; }`,
    "    }",
    "  </style>",
    `  <g transform="translate(20 20) scale(${scale.toFixed(4)})">`,
    paths,
    "  </g>",
    '  <text class="wordmark" x="104" y="52" dominant-baseline="central">OpenLimiter</text>',
    "</svg>",
    "",
  ].join("\n");
}

/* ---------------------------------------------------------------- the tile */

/**
 * The app tile: the mark in white on a solid brand blue rounded square. The
 * ring is drawn by testing every sample against the same angles and the same
 * radius the vector uses, so the raster and the vector are the same artwork.
 */
const TILE = 1024;
const TILE_RADIUS_RATIO = 0.22;
const TILE_MARK_RATIO = 0.68;
const SAMPLES = 4;

function hexToRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function renderTile() {
  const [br, bg, bb] = hexToRgb(BLUE);
  const [wr, wg, wb] = hexToRgb(WHITE);

  const corner = TILE * TILE_RADIUS_RATIO;
  const markBox = TILE * TILE_MARK_RATIO;
  const scale = markBox / 200;
  const centre = TILE / 2;
  const ring = RADIUS * scale;
  const half = (STROKE / 2) * scale;
  const inner = ring - half;
  const outer = ring + half;

  const pixels = Buffer.allocUnsafe(TILE * TILE * 4);
  const step = 1 / SAMPLES;
  const total = SAMPLES * SAMPLES;

  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      let inside = 0;
      let ink = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        const py = y + (sy + 0.5) * step;
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) * step;

          /* The rounded square, measured from the nearest corner centre. */
          const dxCorner = Math.max(corner - px, px - (TILE - corner), 0);
          const dyCorner = Math.max(corner - py, py - (TILE - corner), 0);
          if (dxCorner * dxCorner + dyCorner * dyCorner > corner * corner) continue;
          inside += 1;

          const dx = px - centre;
          const dy = py - centre;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < inner || distance > outer) continue;

          /* Degrees clockwise from twelve o'clock, which is how the arcs are
             laid out. Butt caps mean a segment is bounded by two radii, so
             this angle test is the whole test. */
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
      const offset = (y * TILE + x) * 4;
      pixels[offset] = Math.round(br + (wr - br) * coverage);
      pixels[offset + 1] = Math.round(bg + (wg - bg) * coverage);
      pixels[offset + 2] = Math.round(bb + (wb - bb) * coverage);
      pixels[offset + 3] = Math.round((inside / total) * 255);
    }
  }

  return pixels;
}

/* ------------------------------------------------------------ png encoding */

/* The reversed polynomial the PNG specification uses for its chunk checksums. */
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
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
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

function encodePng(pixels, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; /* bit depth */
  header[9] = 6; /* colour type: truecolour with alpha */
  header[10] = 0; /* deflate */
  header[11] = 0; /* adaptive filtering */
  header[12] = 0; /* no interlace */

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

assertApproved();

writeFileSync(path.join(HERE, "openlimiter-mark.svg"), markSvg(), "utf8");
writeFileSync(path.join(HERE, "openlimiter-lockup.svg"), lockupSvg(), "utf8");
writeFileSync(
  path.join(HERE, "openlimiter-tile-1024.png"),
  encodePng(renderTile(), TILE, TILE),
);

process.stdout.write(
  `Wrote the mark, the lockup and a ${TILE} pixel tile. Segment ratio ${RATIO.toFixed(4)}.\n`,
);
