import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepDisplacedRuntimes } from "../src/terminal-launcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("displaced runtime sweep", () => {
  it("removes only runtimes left behind by earlier swaps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ol-sweep-"));
    roots.push(root);
    const displaced = "terminal-runtime.35608.376e6202-46e4-462c-99aa-d7bb9d0912c8.old";
    for (const name of [displaced, "terminal-runtime", "terminal-runtime.pre-2-0-20260928", "notes.old", "terminal-launchers"]) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, "node.exe"), "");
    }

    await sweepDisplacedRuntimes(root);

    expect((await readdir(root)).sort()).toEqual(
      ["notes.old", "terminal-launchers", "terminal-runtime", "terminal-runtime.pre-2-0-20260928"]
    );
  });

  it("never throws when the folder is missing", async () => {
    await expect(sweepDisplacedRuntimes(path.join(os.tmpdir(), "ol-sweep-missing-" + process.pid))).resolves.toBeUndefined();
  });
});
