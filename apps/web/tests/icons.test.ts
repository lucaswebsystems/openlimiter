import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

function pixels(path: string): { size: number; rgba: Buffer } {
  const png = readFileSync(path);
  const size = png.readUInt32BE(16);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = size * 4;
  const rgba = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    expect(raw[y * (stride + 1)]).toBe(0);
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { size, rgba };
}

function pixel(image: { size: number; rgba: Buffer }, x: number, y: number): number[] {
  const offset = (y * image.size + x) * 4;
  return [...image.rgba.subarray(offset, offset + 4)];
}

describe("mobile launcher icons", () => {
  it("uses the approved blue tile and white mark treatments", () => {
    expect(pixel(pixels("public/icons/openlimiter-192.png"), 0, 0)[3]).toBe(0);
    expect(pixel(pixels("app/apple-icon.png"), 0, 0)).toEqual([8, 102, 255, 255]);
    expect(pixel(pixels("public/icons/openlimiter-maskable-512.png"), 0, 0)).toEqual([8, 102, 255, 255]);
    const monochrome = pixels("public/icons/openlimiter-monochrome-512.png").rgba;
    expect(monochrome[3]).toBe(0);
    const painted = monochrome.findIndex((value: number, index: number) => index % 4 === 3 && value > 0);
    expect([...monochrome.subarray(painted - 3, painted)]).toEqual([255, 255, 255]);
  });

  it.each([
    ["public/icons/openlimiter-192.png", 192],
    ["public/icons/openlimiter-512.png", 512],
    ["public/icons/openlimiter-maskable-512.png", 512],
    ["public/icons/openlimiter-monochrome-512.png", 512],
    ["app/apple-icon.png", 180],
  ])("declares the real dimensions of %s", (path, size) => {
    const png = readFileSync(path);
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  });
});
