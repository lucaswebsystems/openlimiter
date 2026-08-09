/**
 * A QR encoder, written here so the package keeps its promise of zero third
 * party runtime dependencies.
 *
 * It covers exactly what `openlimiter serve` needs and nothing more: byte mode,
 * error correction level M, and versions 1 through 6. That ceiling is a real
 * simplification rather than an arbitrary one, because version information
 * blocks only appear from version 7 upward, so this encoder never has to write
 * them. Version 6 carries 106 bytes, and the longest address this tool prints
 * is around 55 characters, so the ceiling is roughly twice what it needs.
 *
 * The output is a square matrix of booleans. Rendering it is a separate step,
 * so the encoder itself is pure and can be checked against the published test
 * vectors without a terminal anywhere near it.
 *
 * References used: ISO/IEC 18004 tables 7, 9 and 13 for capacities, block
 * structure and alignment centres, annex I for the worked example the tests
 * check the Reed Solomon step against.
 */

/** Highest version this encoder writes. Above it, version blocks appear. */
export const MAX_QR_VERSION = 6;

/** Modules a version measures on a side. */
export function qrSize(version: number): number {
  return 17 + version * 4;
}

interface VersionSpec {
  /** Data codewords per block, one entry per block. */
  readonly blocks: readonly number[];
  /** Error correction codewords per block. */
  readonly ecPerBlock: number;
  /** Bits left over after the interleaved codewords are placed. */
  readonly remainderBits: number;
  /** Centres of the alignment patterns on both axes. */
  readonly alignment: readonly number[];
}

/* Level M only. Every row is the published structure for that version. */
const VERSIONS: readonly VersionSpec[] = [
  { blocks: [16], ecPerBlock: 10, remainderBits: 0, alignment: [] },
  { blocks: [28], ecPerBlock: 16, remainderBits: 7, alignment: [6, 18] },
  { blocks: [44], ecPerBlock: 26, remainderBits: 7, alignment: [6, 22] },
  { blocks: [32, 32], ecPerBlock: 18, remainderBits: 7, alignment: [6, 26] },
  { blocks: [43, 43], ecPerBlock: 24, remainderBits: 7, alignment: [6, 30] },
  { blocks: [27, 27, 27, 27], ecPerBlock: 16, remainderBits: 7, alignment: [6, 34] }
];

function specFor(version: number): VersionSpec {
  const spec = VERSIONS[version - 1];
  if (spec === undefined) throw new Error("Unsupported QR version");
  return spec;
}

function dataCodewords(spec: VersionSpec): number {
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

function multiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[((LOG[left] ?? 0) + (LOG[right] ?? 0)) % 255] ?? 0;
}

/** The generator polynomial for a run of error correction codewords. */
function generatorPolynomial(degree: number): Uint8Array {
  let polynomial = new Uint8Array([1]);
  for (let index = 0; index < degree; index += 1) {
    const next = new Uint8Array(polynomial.length + 1);
    for (let position = 0; position < polynomial.length; position += 1) {
      const coefficient = polynomial[position] ?? 0;
      next[position] = (next[position] ?? 0) ^ coefficient;
      next[position + 1] =
        (next[position + 1] ?? 0) ^ multiply(coefficient, EXP[index] ?? 0);
    }
    polynomial = next;
  }
  return polynomial;
}

/**
 * Reed Solomon error correction codewords for one block.
 *
 * Exported because it is the one step with a published test vector, which is
 * how the tests prove the field arithmetic is right rather than merely
 * self consistent.
 */
export function errorCorrectionCodewords(
  data: Uint8Array,
  count: number
): Uint8Array {
  const generator = generatorPolynomial(count);
  const remainder = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[count - 1] = 0;
    for (let index = 0; index < count; index += 1) {
      remainder[index] =
        (remainder[index] ?? 0) ^ multiply(generator[index + 1] ?? 0, factor);
    }
  }
  return remainder;
}

/* --------------------------------------------------------------- bits */

class BitWriter {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.bits.push((value >>> index) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): Uint8Array {
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

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_QR_VERSION; version += 1) {
    /* Four bits of mode plus eight bits of length is exactly two codewords. */
    if (byteLength + 2 <= dataCodewords(specFor(version))) return version;
  }
  throw new Error("Text is too long for this QR encoder");
}

function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
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
function interleave(codewords: Uint8Array, version: number): Uint8Array {
  const spec = specFor(version);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const size of spec.blocks) {
    const block = codewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrectionCodewords(block, spec.ecPerBlock));
  }
  const result: number[] = [];
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

type Grid = Int8Array[];

function emptyGrid(size: number): Grid {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function place(grid: Grid, row: number, column: number, dark: boolean): void {
  const line = grid[row];
  if (line === undefined) return;
  line[column] = dark ? 1 : 0;
}

function at(grid: Grid, row: number, column: number): number {
  return grid[row]?.[column] ?? -1;
}

function drawFinder(grid: Grid, row: number, column: number): void {
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

function drawAlignment(grid: Grid, row: number, column: number): void {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const ring = Math.max(Math.abs(x), Math.abs(y));
      place(grid, row + y, column + x, ring !== 1);
    }
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const size = grid.length;
  drawFinder(grid, 0, 0);
  drawFinder(grid, 0, size - 7);
  drawFinder(grid, size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;
    place(grid, 6, index, dark);
    place(grid, index, 6, dark);
  }

  /*
   * One list of centres covers both axes, so every pair is a candidate. The
   * three pairs that would land on a finder are the only ones skipped.
   */
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

function functionMask(version: number): boolean[][] {
  const size = qrSize(version);
  const grid = emptyGrid(size);
  drawFunctionPatterns(grid, version);
  return Array.from({ length: size }, (_unused, row) =>
    Array.from({ length: size }, (_ignored, column) => at(grid, row, column) !== -1)
  );
}

/**
 * Walk the symbol in the published order and drop the codeword bits in.
 *
 * The walk is two modules wide, starts at the bottom right, and alternates
 * direction on every pair of columns. Column six carries the vertical timing
 * pattern, so the pair that would straddle it shifts one column left and every
 * later pair follows from there. Modules left over once the bits run out stay
 * light, which is exactly what the remainder bits are.
 */
function placeData(grid: Grid, reserved: boolean[][], bits: Uint8Array): void {
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

const MASKS: readonly ((row: number, column: number) => boolean)[] = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0
];

function applyMask(
  grid: Grid,
  reserved: boolean[][],
  mask: number
): boolean[][] {
  const rule = MASKS[mask];
  if (rule === undefined) throw new Error("Unknown mask");
  const size = grid.length;
  return Array.from({ length: size }, (_unused, row) =>
    Array.from({ length: size }, (_ignored, column) => {
      const value = at(grid, row, column) === 1;
      if (reserved[row]?.[column] === true) return value;
      return rule(row, column) ? !value : value;
    })
  );
}

function runPenalty(line: readonly boolean[]): number {
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

function finderPenalty(line: readonly boolean[]): number {
  let penalty = 0;
  for (let index = 0; index + 11 <= line.length; index += 1) {
    const forward = FINDER_LIKE.every((value, offset) => line[index + offset] === value);
    const backward = FINDER_LIKE.every(
      (value, offset) => line[index + 10 - offset] === value
    );
    if (forward || backward) penalty += 40;
  }
  return penalty;
}

function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let total = 0;
  let dark = 0;
  const columns: boolean[][] = Array.from({ length: size }, () => []);
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
function formatBits(mask: number): number {
  /* Level M is 00, and the three mask bits follow it. */
  const data = mask;
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

/**
 * Write the fifteen format bits into both of the places they live.
 *
 * The first copy wraps the top left finder, the second is split between the
 * strip under the top right finder and the strip beside the bottom left one.
 * The dark module is rewritten last, because it sits inside the second copy's
 * run and is fixed by the standard whatever the bits say.
 */
function writeFormat(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  const dark = (index: number): boolean => ((bits >>> index) & 1) === 1;
  const set = (row: number, column: number, value: boolean): void => {
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

export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

/**
 * Encode text as a QR matrix.
 *
 * Byte mode, error correction level M, and the mask chosen by running the four
 * published penalty rules over all eight candidates.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = interleave(buildCodewords(bytes, version), version);
  const reserved = functionMask(version);
  const grid = emptyGrid(qrSize(version));
  drawFunctionPatterns(grid, version);
  placeData(grid, reserved, codewords);

  let best: boolean[][] | null = null;
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

/* ------------------------------------------------------------ rendering */

/** Modules of light margin around the symbol. Four is the published minimum. */
const QUIET_ZONE = 4;

export interface QrRenderOptions {
  /**
   * Paint each module with an explicit background colour.
   *
   * A scanner needs dark modules on a light field, and a terminal with a dark
   * theme would otherwise invert the whole symbol and make it unreadable. When
   * colour is off the symbol still renders, but only a light themed terminal
   * will scan it.
   */
  color?: boolean;
}

/**
 * Render a matrix as text, two module rows to every line.
 *
 * The upper half block character paints its top half in the foreground colour
 * and its bottom half in the background colour, so one character carries two
 * module rows and the symbol comes out roughly square in a terminal cell grid.
 */
export function renderQr(matrix: QrMatrix, options: QrRenderOptions = {}): string {
  const color = options.color ?? false;
  const span = matrix.size + QUIET_ZONE * 2;
  const dark = (row: number, column: number): boolean => {
    const y = row - QUIET_ZONE;
    const x = column - QUIET_ZONE;
    if (y < 0 || x < 0 || y >= matrix.size || x >= matrix.size) return false;
    return matrix.modules[y]?.[x] === true;
  };
  const lines: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = "";
    let previous = "";
    for (let column = 0; column < span; column += 1) {
      const top = dark(row, column);
      const bottom = row + 1 < span ? dark(row + 1, column) : false;
      if (!color) {
        line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
        continue;
      }
      /* Black on bright white, stated explicitly so the theme cannot invert it. */
      const codes = (top ? "30" : "97") + ";" + (bottom ? "40" : "107");
      if (codes !== previous) {
        line += "\u001b[" + codes + "m";
        previous = codes;
      }
      line += "▀";
    }
    lines.push(color ? line + "\u001b[0m" : line);
  }
  return lines.join("\n");
}
