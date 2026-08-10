#!/usr/bin/env node
/**
 * Render the phone install QR code, and commit it as a static file.
 *
 *   node scripts/generate-qr.mjs
 *
 * Writes apps/web/public/qr/openlimiter-app.svg, encoding the address of the
 * installable web app. The download page imports the file from public/ as a
 * plain image, the same way every other generated asset on that site is
 * served (see apps/web/scripts/icons.mjs).
 *
 * WHY THE MATRIX GENERATOR IS PORTED RATHER THAN IMPORTED
 * ---------------------------------------------------------
 * packages/cli/src/qr.ts already carries a complete, tested QR encoder, built
 * for the same reason this script exists: the repository ships zero third
 * party runtime dependencies, so a QR symbol has to come from code written
 * here rather than from a package. That encoder's own rendering step,
 * `renderQr`, only ever draws to a terminal: two module rows to a character
 * cell, in half block glyphs. It has no SVG output of any kind, so it cannot
 * be imported and asked for one.
 *
 * apps/web is also not a member of the pnpm workspace: it is deployed on its
 * own, with its own lock file (see apps/web/app/app/engine/sync.mjs for the
 * same constraint on the core engine), so it cannot resolve @openlimiter/cli
 * as a package even for the pieces that would help.
 *
 * The matrix generator, the part with no rendering opinion at all, is
 * therefore ported here verbatim: same tables, same bit and byte layout, same
 * mask penalty rules, same field arithmetic, checked against the same ISO
 * annex worked example packages/cli/test/qr.test.ts checks the original
 * against (see the self check below). Only the rendering step is new, because
 * only the rendering step was missing: a walk over the matrix that emits
 * black SVG rects on a white background, with the published four module quiet
 * zone. Every edit to packages/cli/src/qr.ts that changes the symbol a browser
 * would produce should be mirrored here by hand; nothing here is a build step
 * that could catch that automatically, so this header says so instead.
 *
 * DETERMINISM
 * -----------
 * The address encoded is a literal constant, not read from anywhere else at
 * run time, so this script's output depends on nothing but its own source.
 * Running it twice in a row writes byte identical files. There is no
 * timestamp, no random mask tie break beyond the fixed penalty scoring the
 * standard defines, and no dependency on the machine it runs on.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The one address this file exists to encode. Mirrors lib/site.ts's
 *  SITE_URL plus "/app": update both together if either ever changes. */
const TARGET_URL = "https://openlimiter.com/app";

/** Where the committed file lands, and the CSS pixel size it is meant to be
 *  read at: crisp at roughly this size on the download page. */
const OUTPUT_SIZE = 180;

/* ------------------------------------------------------------- matrix
 * Ported from packages/cli/src/qr.ts. Byte mode, error correction level M,
 * versions 1 through 6 only, which is every fact the comments below repeat
 * from that file so this port can be read on its own.
 */

/** Highest version this encoder writes. Above it, version blocks appear. */
const MAX_QR_VERSION = 6;

/** Modules a version measures on a side. */
function qrSize(version) {
  return 17 + version * 4;
}

/* Level M only. Every row is the published structure for that version. */
const VERSIONS = [
  { blocks: [16], ecPerBlock: 10, alignment: [] },
  { blocks: [28], ecPerBlock: 16, alignment: [6, 18] },
  { blocks: [44], ecPerBlock: 26, alignment: [6, 22] },
  { blocks: [32, 32], ecPerBlock: 18, alignment: [6, 26] },
  { blocks: [43, 43], ecPerBlock: 24, alignment: [6, 30] },
  { blocks: [27, 27, 27, 27], ecPerBlock: 16, alignment: [6, 34] },
];

function specFor(version) {
  const spec = VERSIONS[version - 1];
  if (spec === undefined) throw new Error("Unsupported QR version");
  return spec;
}

function dataCodewords(spec) {
  return spec.blocks.reduce((total, count) => total + count, 0);
}

/* ------------------------------------------------------------- GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    /* The primitive polynomial the QR standard fixes, x^8 + x^4 + x^3 + x^2 + 1. */
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] ?? 0;
}

function multiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return EXP[((LOG[left] ?? 0) + (LOG[right] ?? 0)) % 255] ?? 0;
}

/** The generator polynomial for a run of error correction codewords. */
function generatorPolynomial(degree) {
  let polynomial = new Uint8Array([1]);
  for (let index = 0; index < degree; index += 1) {
    const next = new Uint8Array(polynomial.length + 1);
    for (let position = 0; position < polynomial.length; position += 1) {
      const coefficient = polynomial[position] ?? 0;
      next[position] = (next[position] ?? 0) ^ coefficient;
      next[position + 1] = (next[position + 1] ?? 0) ^ multiply(coefficient, EXP[index] ?? 0);
    }
    polynomial = next;
  }
  return polynomial;
}

/** Reed Solomon error correction codewords for one block. */
function errorCorrectionCodewords(data, count) {
  const generator = generatorPolynomial(count);
  const remainder = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[count - 1] = 0;
    for (let index = 0; index < count; index += 1) {
      remainder[index] = (remainder[index] ?? 0) ^ multiply(generator[index + 1] ?? 0, factor);
    }
  }
  return remainder;
}

/* --------------------------------------------------------------- bits */

class BitWriter {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.bits.push((value >>> index) & 1);
    }
  }
  get length() {
    return this.bits.length;
  }
  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit === 1) {
        const position = index >>> 3;
        bytes[position] = (bytes[position] ?? 0) | (0x80 >>> (index & 7));
      }
    });
    return bytes;
  }
}

function chooseVersion(byteLength) {
  for (let version = 1; version <= MAX_QR_VERSION; version += 1) {
    /* Four bits of mode plus eight bits of length is exactly two codewords. */
    if (byteLength + 2 <= dataCodewords(specFor(version))) return version;
  }
  throw new Error("Text is too long for this QR encoder");
}

function buildCodewords(bytes, version) {
  const spec = specFor(version);
  const capacity = dataCodewords(spec);
  const writer = new BitWriter();
  writer.push(0b0100, 4);
  /* Byte mode on versions 1 to 9 carries its length in eight bits. */
  writer.push(bytes.length, 8);
  for (const byte of bytes) writer.push(byte, 8);
  const terminator = Math.min(4, capacity * 8 - writer.length);
  writer.push(0, terminator);
  while (writer.length % 8 !== 0) writer.push(0, 1);
  const padded = Array.from(writer.toBytes());
  /* The two pad codewords the standard fixes, alternating to the capacity. */
  const pad = [0xec, 0x11];
  const filled = padded.length;
  while (padded.length < capacity) {
    padded.push(pad[(padded.length - filled) % 2] ?? 0xec);
  }
  return Uint8Array.from(padded);
}

/** Split into blocks, add error correction, and interleave as the standard says. */
function interleave(codewords, version) {
  const spec = specFor(version);
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const size of spec.blocks) {
    const block = codewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrectionCodewords(block, spec.ecPerBlock));
  }
  const result = [];
  const longest = Math.max(...spec.blocks);
  for (let index = 0; index < longest; index += 1) {
    for (const block of dataBlocks) {
      const byte = block[index];
      if (byte !== undefined) result.push(byte);
    }
  }
  for (let index = 0; index < spec.ecPerBlock; index += 1) {
    for (const block of ecBlocks) {
      const byte = block[index];
      if (byte !== undefined) result.push(byte);
    }
  }
  return Uint8Array.from(result);
}

/* ------------------------------------------------------------- matrix */

function emptyGrid(size) {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function place(grid, row, column, dark) {
  const line = grid[row];
  if (line === undefined) return;
  line[column] = dark ? 1 : 0;
}

function at(grid, row, column) {
  return grid[row]?.[column] ?? -1;
}

function drawFinder(grid, row, column) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const targetRow = row + y;
      const targetColumn = column + x;
      if (
        targetRow < 0 ||
        targetColumn < 0 ||
        targetRow >= grid.length ||
        targetColumn >= grid.length
      ) continue;
      const onRing = (y >= 0 && y <= 6 && (x === 0 || x === 6)) ||
        (x >= 0 && x <= 6 && (y === 0 || y === 6));
      const inCore = y >= 2 && y <= 4 && x >= 2 && x <= 4;
      place(grid, targetRow, targetColumn, onRing || inCore);
    }
  }
}

function drawAlignment(grid, row, column) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const ring = Math.max(Math.abs(x), Math.abs(y));
      place(grid, row + y, column + x, ring !== 1);
    }
  }
}

function drawFunctionPatterns(grid, version) {
  const size = grid.length;
  drawFinder(grid, 0, 0);
  drawFinder(grid, 0, size - 7);
  drawFinder(grid, size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;
    place(grid, 6, index, dark);
    place(grid, index, 6, dark);
  }

  /* One list of centres covers both axes, so every pair is a candidate. The
     three pairs that would land on a finder are the only ones skipped. */
  const centres = specFor(version).alignment;
  for (const row of centres) {
    for (const column of centres) {
      const onFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === size - 7) ||
        (row === size - 7 && column === 6);
      if (!onFinder) drawAlignment(grid, row, column);
    }
  }

  /* The dark module, fixed by the standard, and always dark. */
  place(grid, size - 8, 8, true);

  /* Reserve the format areas so data placement steps over them. */
  for (let index = 0; index <= 8; index += 1) {
    if (at(grid, 8, index) === -1) place(grid, 8, index, false);
    if (at(grid, index, 8) === -1) place(grid, index, 8, false);
  }
  for (let index = 0; index < 8; index += 1) {
    if (at(grid, 8, size - 1 - index) === -1) place(grid, 8, size - 1 - index, false);
    if (at(grid, size - 1 - index, 8) === -1) place(grid, size - 1 - index, 8, false);
  }
}

function functionMask(version) {
  const size = qrSize(version);
  const grid = emptyGrid(size);
  drawFunctionPatterns(grid, version);
  return Array.from({ length: size }, (_unused, row) =>
    Array.from({ length: size }, (_ignored, column) => at(grid, row, column) !== -1));
}

/**
 * Walk the symbol in the published order and drop the codeword bits in. Two
 * modules wide, starts bottom right, alternates direction every pair of
 * columns, and steps around column six because it carries the timing pattern.
 */
function placeData(grid, reserved, bits) {
  const size = grid.length;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - step : step;
        if (reserved[row]?.[column] === true) continue;
        let dark = false;
        if (bitIndex < bits.length * 8) {
          const byte = bits[bitIndex >>> 3] ?? 0;
          dark = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        }
        bitIndex += 1;
        place(grid, row, column, dark);
      }
    }
  }
}

const MASKS = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

function applyMask(grid, reserved, mask) {
  const rule = MASKS[mask];
  if (rule === undefined) throw new Error("Unknown mask");
  const size = grid.length;
  return Array.from({ length: size }, (_unused, row) =>
    Array.from({ length: size }, (_ignored, column) => {
      const value = at(grid, row, column) === 1;
      if (reserved[row]?.[column] === true) return value;
      return rule(row, column) ? !value : value;
    }));
}

function runPenalty(line) {
  let penalty = 0;
  let run = 1;
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === line[index - 1]) {
      run += 1;
      continue;
    }
    if (run >= 5) penalty += 3 + (run - 5);
    run = 1;
  }
  if (run >= 5) penalty += 3 + (run - 5);
  return penalty;
}

const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false];

function finderPenalty(line) {
  let penalty = 0;
  for (let index = 0; index + 11 <= line.length; index += 1) {
    const forward = FINDER_LIKE.every((value, offset) => line[index + offset] === value);
    const backward = FINDER_LIKE.every((value, offset) => line[index + 10 - offset] === value);
    if (forward || backward) penalty += 40;
  }
  return penalty;
}

function penalty(modules) {
  const size = modules.length;
  let total = 0;
  let dark = 0;
  const columns = Array.from({ length: size }, () => []);
  for (let row = 0; row < size; row += 1) {
    const line = modules[row] ?? [];
    total += runPenalty(line);
    total += finderPenalty(line);
    for (let column = 0; column < size; column += 1) {
      const value = line[column] === true;
      columns[column]?.push(value);
      if (value) dark += 1;
      if (row > 0 && column > 0) {
        const up = modules[row - 1]?.[column] === true;
        const left = line[column - 1] === true;
        const upLeft = modules[row - 1]?.[column - 1] === true;
        if (value === up && value === left && value === upLeft) total += 3;
      }
    }
  }
  for (const column of columns) {
    total += runPenalty(column);
    total += finderPenalty(column);
  }
  const ratio = (dark * 100) / (size * size);
  total += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return total;
}

/** Fifteen bits of format information, error correction level M. */
function formatBits(mask) {
  /* Level M is 00, and the three mask bits follow it. */
  const data = mask;
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function writeFormat(modules, mask) {
  const size = modules.length;
  const bits = formatBits(mask);
  const dark = (index) => ((bits >>> index) & 1) === 1;
  const set = (row, column, value) => {
    const line = modules[row];
    if (line !== undefined) line[column] = value;
  };
  for (let index = 0; index <= 5; index += 1) set(index, 8, dark(index));
  set(7, 8, dark(6));
  set(8, 8, dark(7));
  set(8, 7, dark(8));
  for (let index = 9; index <= 14; index += 1) set(8, 14 - index, dark(index));
  for (let index = 0; index <= 7; index += 1) set(8, size - 1 - index, dark(index));
  for (let index = 8; index <= 14; index += 1) set(size - 15 + index, 8, dark(index));
  set(size - 8, 8, true);
}

/**
 * Encode text as a QR matrix: byte mode, error correction level M, and the
 * mask chosen by running the four published penalty rules over all eight
 * candidates. Identical in behaviour to packages/cli/src/qr.ts's encodeQr.
 */
export function encodeQr(text) {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = interleave(buildCodewords(bytes, version), version);
  const reserved = functionMask(version);
  const grid = emptyGrid(qrSize(version));
  drawFunctionPatterns(grid, version);
  placeData(grid, reserved, codewords);

  let best = null;
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    const candidate = applyMask(grid, reserved, mask);
    writeFormat(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      bestMask = mask;
    }
  }
  if (best === null) throw new Error("No mask could be chosen");
  return { version, size: qrSize(version), mask: bestMask, modules: best };
}

export { qrSize };

/* ------------------------------------------------------------ rendering
 * New code: qr.ts has nothing here to port from, because it only ever draws
 * to a terminal. A scanner needs dark modules on a light field regardless of
 * which theme the page around the image is in, exactly the reasoning
 * qr.ts's own renderQr documents for its terminal output, so the background
 * and the modules below are literal black and white rather than a site
 * design token: this image is a generated artifact, like the PNG icons
 * apps/web/scripts/icons.mjs writes, not a themed UI surface.
 */

/** Modules of light margin around the symbol. Four is the published minimum. */
const QUIET_ZONE = 4;

function escapeXmlAttribute(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One rect per horizontal run of dark modules, rather than one per module.
 * QR symbols are full of runs, so this keeps the committed file small and
 * keeps a diff readable if the encoded address ever changes.
 */
function moduleRects(matrix, quietZone) {
  const rects = [];
  for (let row = 0; row < matrix.size; row += 1) {
    const line = matrix.modules[row];
    let runStart = null;
    for (let column = 0; column <= matrix.size; column += 1) {
      const dark = column < matrix.size && line[column] === true;
      if (dark && runStart === null) {
        runStart = column;
      } else if (!dark && runStart !== null) {
        const width = column - runStart;
        rects.push(
          `<rect x="${runStart + quietZone}" y="${row + quietZone}" width="${width}" height="1"/>`,
        );
        runStart = null;
      }
    }
  }
  return rects;
}

/** Render a matrix as a self contained SVG: a white field, black modules. */
export function renderSvg(matrix, options = {}) {
  const quietZone = options.quietZone ?? QUIET_ZONE;
  const size = options.size ?? OUTPUT_SIZE;
  const label = escapeXmlAttribute(options.ariaLabel ?? "QR code");
  const span = matrix.size + quietZone * 2;
  const rects = moduleRects(matrix, quietZone);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="${label}">`,
    `  <rect x="0" y="0" width="${span}" height="${span}" fill="#ffffff"/>`,
    `  <g fill="#000000">`,
    ...rects.map((rect) => "    " + rect),
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/* ------------------------------------------------------------ self check
 * A subtly wrong QR encoder still looks exactly like a QR encoder, so this
 * reads the symbol back before it is ever written to disk, the same
 * assurance packages/cli/test/qr.test.ts keeps for the original: a decoder
 * written from the standard's own description, independent of the encoder
 * above, walking the same published placement order in reverse.
 */

const VERSION_BLOCKS = {
  1: { blocks: [16], ec: 10 },
  2: { blocks: [28], ec: 16 },
  3: { blocks: [44], ec: 26 },
  4: { blocks: [32, 32], ec: 18 },
  5: { blocks: [43, 43], ec: 24 },
  6: { blocks: [27, 27, 27, 27], ec: 16 },
};

function readFormat(matrix) {
  let bits = 0;
  const read = (row, column, index) => {
    if (matrix.modules[row]?.[column] === true) bits |= 1 << index;
  };
  for (let index = 0; index <= 5; index += 1) read(index, 8, index);
  read(7, 8, 6);
  read(8, 8, 7);
  read(8, 7, 8);
  for (let index = 9; index <= 14; index += 1) read(8, 14 - index, index);
  return bits;
}

function reservedMap(version) {
  const size = qrSize(version);
  const reserved = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const mark = (row, column) => {
    const line = reserved[row];
    if (line !== undefined && column >= 0 && column < size) line[column] = true;
  };
  const block = (top, left, span) => {
    for (let y = 0; y < span; y += 1) {
      for (let x = 0; x < span; x += 1) mark(top + y, left + x);
    }
  };
  block(0, 0, 8);
  block(0, size - 8, 8);
  block(size - 8, 0, 8);
  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }
  for (let index = 0; index <= 8; index += 1) {
    mark(8, index);
    mark(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(8, size - 1 - index);
    mark(size - 1 - index, 8);
  }
  if (version >= 2) {
    const centre = size - 7;
    for (let y = -2; y <= 2; y += 1) {
      for (let x = -2; x <= 2; x += 1) mark(centre + y, centre + x);
    }
  }
  return reserved;
}

/** Read a matrix back to the text it encodes, independent of encodeQr. */
export function decodeQr(matrix) {
  const format = readFormat(matrix);
  const unmasked = format ^ 0x5412;
  const level = (unmasked >>> 13) & 0b11;
  const mask = (unmasked >>> 10) & 0b111;
  if (level !== 0b00) throw new Error("Expected error correction level M");
  const rule = MASKS[mask];
  if (rule === undefined) throw new Error("Unknown mask");

  const size = matrix.size;
  const reserved = reservedMap(matrix.version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - step : step;
        if (reserved[row]?.[column] === true) continue;
        const value = matrix.modules[row]?.[column] === true;
        bits.push(rule(row, column) ? (value ? 0 : 1) : value ? 1 : 0);
      }
    }
  }

  const codewords = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | (bits[index + bit] ?? 0);
    codewords.push(byte);
  }

  const spec = VERSION_BLOCKS[matrix.version];
  if (spec === undefined) throw new Error("Unsupported version");
  const blocks = spec.blocks.map(() => []);
  let cursor = 0;
  const longest = Math.max(...spec.blocks);
  for (let index = 0; index < longest; index += 1) {
    spec.blocks.forEach((length, blockIndex) => {
      if (index >= length) return;
      const byte = codewords[cursor];
      cursor += 1;
      if (byte !== undefined) blocks[blockIndex]?.push(byte);
    });
  }
  const data = blocks.flat();

  const mode = (data[0] ?? 0) >>> 4;
  if (mode !== 0b0100) throw new Error("Expected byte mode");
  const length = (((data[0] ?? 0) & 0x0f) << 4) | ((data[1] ?? 0) >>> 4);
  const bytes = [];
  for (let index = 0; index < length; index += 1) {
    const high = (data[index + 1] ?? 0) & 0x0f;
    const low = (data[index + 2] ?? 0) >>> 4;
    bytes.push((high << 4) | low);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/* ------------------------------------------------------------------ main */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..");
const OUTPUT_FILE = path.join(REPOSITORY, "apps", "web", "public", "qr", "openlimiter-app.svg");

function main() {
  const matrix = encodeQr(TARGET_URL);

  /* The self check runs every time, not only in a test file, because this
     script has no test file of its own: it is the whole guarantee. */
  const roundTrip = decodeQr(matrix);
  if (roundTrip !== TARGET_URL) {
    throw new Error(
      "QR self check failed: decoded " + JSON.stringify(roundTrip) +
      " but expected " + JSON.stringify(TARGET_URL),
    );
  }

  const svg = renderSvg(matrix, {
    size: OUTPUT_SIZE,
    ariaLabel: "QR code linking to " + TARGET_URL,
  });

  mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, svg, "utf8");
  process.stdout.write(
    "Wrote " + path.relative(REPOSITORY, OUTPUT_FILE) +
    " (version " + matrix.version + ", " + matrix.size + "x" + matrix.size +
    " modules, self check passed) encoding " + TARGET_URL + "\n",
  );
}

/* Only writes when this file is the program being run, so a verification
   script can import encodeQr, renderSvg and decodeQr with no side effect. */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
