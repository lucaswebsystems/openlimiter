import { mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sweepTemporaryFiles } from "@openlimiter/core";

describe("sweep temporary files", () => {
  it("removes old tmp and keeps fresh", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ol-sweep-"));
    const oldFile = path.join(directory, "doc.json.1.abc.tmp");
    const freshFile = path.join(directory, "doc.json.2.def.tmp");
    const other = path.join(directory, "keep.txt");
    await writeFile(oldFile, "x");
    await writeFile(freshFile, "x");
    await writeFile(other, "x");
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldFile, past, past);
    const removed = await sweepTemporaryFiles(directory, Date.now());
    expect(removed).toBe(1);
    expect(await readdir(directory)).toEqual(["doc.json.2.def.tmp", "keep.txt"].sort());
  });
});
