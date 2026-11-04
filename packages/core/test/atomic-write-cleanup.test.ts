import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeFileAtomically } from "@openlimiter/core";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn(async () => {
      throw new Error("rename failed");
    })
  };
});

describe("atomic write cleanup repro", () => {
  it("removes temp on failed rename", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ol-atomic-"));
    const target = path.join(directory, "doc.json");
    await expect(writeFileAtomically(target, "x")).rejects.toThrow();
    const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
    console.log("leftovers", leftovers);
    expect(leftovers).toEqual([]);
  });
});
