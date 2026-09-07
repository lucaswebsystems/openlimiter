import { describe, expect, it } from "vitest";
import {
  MAX_QR_VERSION,
  encodeQr,
  errorCorrectionCodewords,
  qrSize,
  renderQr,
  type QrMatrix
} from "../src/qr.js";

/**
 * The encoder is checked three ways, because a QR symbol that is subtly wrong
 * still looks exactly like a QR symbol.
 *
 *   1. The Reed Solomon step is compared against the worked example published
 *      in annex I of ISO/IEC 18004. That vector is independent of this code.
 *   2. The geometry is checked module by module against the fixed patterns the
 *      standard defines, which no amount of self consistency can fake.
 *   3. The whole symbol is read back by a decoder written here from the
 *      standard's own description, which catches a placement, mask, or
 *      interleaving mistake that an encoder alone would never notice.
 */

/* The published example: the numeric string 01234567 at version 1, level M. */
const ANNEX_I_DATA = Uint8Array.from([
  0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11,
  0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11
]);

const ANNEX_I_ERROR_CORRECTION = [
  0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55
];

function module(matrix: QrMatrix, row: number, column: number): boolean {
  return matrix.modules[row]?.[column] === true;
}

/** The seven by seven finder, as the standard draws it. */
function finderAt(matrix: QrMatrix, top: number, left: number): boolean {
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const ring = y === 0 || y === 6 || x === 0 || x === 6;
      const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
      if (module(matrix, top + y, left + x) !== (ring || core)) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------- decoder */

const VERSION_BLOCKS: Record<number, { blocks: number[]; ec: number }> = {
  1: { blocks: [16], ec: 10 },
  2: { blocks: [28], ec: 16 },
  3: { blocks: [44], ec: 26 },
  4: { blocks: [32, 32], ec: 18 },
  5: { blocks: [43, 43], ec: 24 },
  6: { blocks: [27, 27, 27, 27], ec: 16 }
};

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

/** Read the fifteen format bits back out of the top left copy. */
function readFormat(matrix: QrMatrix): number {
  let bits = 0;
  const read = (row: number, column: number, index: number): void => {
    if (module(matrix, row, column)) bits |= 1 << index;
  };
  for (let index = 0; index <= 5; index += 1) read(index, 8, index);
  read(7, 8, 6);
  read(8, 8, 7);
  read(8, 7, 8);
  for (let index = 9; index <= 14; index += 1) read(8, 14 - index, index);
  return bits;
}

/** Rebuild the reserved map the encoder used, from the standard's rules. */
function reservedMap(version: number): boolean[][] {
  const size = qrSize(version);
  const reserved = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false)
  );
  const mark = (row: number, column: number): void => {
    const line = reserved[row];
    if (line !== undefined && column >= 0 && column < size) line[column] = true;
  };
  const block = (top: number, left: number, span: number): void => {
    for (let y = 0; y < span; y += 1) {
      for (let x = 0; x < span; x += 1) mark(top + y, left + x);
    }
  };
  /* Finders plus their separators. */
  block(0, 0, 8);
  block(0, size - 8, 8);
  block(size - 8, 0, 8);
  /* Timing patterns. */
  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }
  /* Format areas. */
  for (let index = 0; index <= 8; index += 1) {
    mark(8, index);
    mark(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(8, size - 1 - index);
    mark(size - 1 - index, 8);
  }
  /* Alignment patterns, one pair of centres for versions two through six. */
  if (version >= 2) {
    const centre = size - 7;
    for (let y = -2; y <= 2; y += 1) {
      for (let x = -2; x <= 2; x += 1) mark(centre + y, centre + x);
    }
  }
  return reserved;
}

/** Read the payload back, following the placement walk in reverse. */
function decode(matrix: QrMatrix): string {
  const format = readFormat(matrix);
  const unmasked = format ^ 0x5412;
  const level = (unmasked >>> 13) & 0b11;
  const mask = (unmasked >>> 10) & 0b111;
  if (level !== 0b00) throw new Error("Expected error correction level M");
  const rule = MASKS[mask];
  if (rule === undefined) throw new Error("Unknown mask");

  const size = matrix.size;
  const reserved = reservedMap(matrix.version);
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - step : step;
        if (reserved[row]?.[column] === true) continue;
        const value = module(matrix, row, column);
        bits.push(rule(row, column) ? (value ? 0 : 1) : (value ? 1 : 0));
      }
    }
  }

  const codewords: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | (bits[index + bit] ?? 0);
    codewords.push(byte);
  }

  const spec = VERSION_BLOCKS[matrix.version];
  if (spec === undefined) throw new Error("Unsupported version");
  /* Undo the interleaving: the data codewords come first, round robin. */
  const blocks: number[][] = spec.blocks.map(() => []);
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
  const bytes: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const high = (data[index + 1] ?? 0) & 0x0f;
    const low = (data[index + 2] ?? 0) >>> 4;
    bytes.push((high << 4) | low);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

describe("QR encoder", () => {
  it("matches the error correction codewords published in annex I", () => {
    const actual = Array.from(errorCorrectionCodewords(ANNEX_I_DATA, 10));
    expect(actual).toEqual(ANNEX_I_ERROR_CORRECTION);
  });

  it("picks the smallest version that holds the payload", () => {
    expect(encodeQr("x".repeat(14)).version).toBe(1);
    expect(encodeQr("x".repeat(15)).version).toBe(2);
    expect(encodeQr("x".repeat(26)).version).toBe(2);
    expect(encodeQr("x".repeat(27)).version).toBe(3);
    expect(encodeQr("x".repeat(106)).version).toBe(MAX_QR_VERSION);
  });

  it("refuses a payload larger than it can encode", () => {
    expect(() => encodeQr("x".repeat(107))).toThrow();
  });

  it("draws the fixed patterns exactly where the standard puts them", () => {
    const matrix = encodeQr("http://192.168.1.20:7317/#t=synthetic-token-value");
    expect(matrix.size).toBe(qrSize(matrix.version));
    expect(finderAt(matrix, 0, 0)).toBe(true);
    expect(finderAt(matrix, 0, matrix.size - 7)).toBe(true);
    expect(finderAt(matrix, matrix.size - 7, 0)).toBe(true);
    /* The timing patterns alternate, starting dark next to the finders. */
    for (let index = 8; index < matrix.size - 8; index += 1) {
      expect(module(matrix, 6, index)).toBe(index % 2 === 0);
      expect(module(matrix, index, 6)).toBe(index % 2 === 0);
    }
    /* The dark module is always dark. */
    expect(module(matrix, matrix.size - 8, 8)).toBe(true);
  });

  it("writes format bits that decode back to level M and the chosen mask", () => {
    for (const text of ["a", "openlimiter", "x".repeat(60)]) {
      const matrix = encodeQr(text);
      const unmasked = readFormat(matrix) ^ 0x5412;
      expect((unmasked >>> 13) & 0b11).toBe(0b00);
      expect((unmasked >>> 10) & 0b111).toBe(matrix.mask);
    }
  });

  it("reads back every payload it encodes", () => {
    const payloads = [
      "a",
      "http://192.168.1.20:7317/#t=Zm9vYmFyYmF6cXV4",
      "http://10.0.0.255:65535/#t=" + "A".repeat(22),
      "x".repeat(106)
    ];
    for (const payload of payloads) {
      expect(decode(encodeQr(payload))).toBe(payload);
    }
  });

  it("renders a quiet zone on every side", () => {
    const matrix = encodeQr("openlimiter");
    const plain = renderQr(matrix, { color: false }).split("\n");
    expect(plain[0]?.trim()).toBe("");
    expect(plain[1]?.trim()).toBe("");
    /* Two module rows to a line, plus four modules of quiet zone above and below. */
    expect(plain.length).toBe(Math.ceil((matrix.size + 8) / 2));
    for (const line of plain) {
      expect(line.startsWith("    ")).toBe(true);
    }
  });

  it("states its own colours when asked, so a dark terminal cannot invert it", () => {
    const painted = renderQr(encodeQr("openlimiter"), { color: true });
    expect(painted).toContain("\u001b[30;40m");
    expect(painted).toContain("\u001b[0m");
    expect(renderQr(encodeQr("openlimiter"), { color: false })).not.toContain("\u001b");
  });
});
