import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn((...argumentsList: unknown[]) => {
    const callback = argumentsList.at(-1) as (error: Error | null, stdout: string) => void;
    callback(null, "ok");
    return {};
  }),
  spawn: vi.fn(() => ({
    once: vi.fn(),
    unref: vi.fn()
  }))
}));

vi.mock("node:child_process", () => childProcess);

import { runtimeDependencies } from "../src/cli.js";

/* Both cases assert Windows behaviour (System32, rundll32); the posix openers differ. */
describe.skipIf(process.platform !== "win32")("trusted helper working directories", () => {
  beforeEach(() => {
    childProcess.execFile.mockClear();
    childProcess.spawn.mockClear();
  });

  it("passes the Windows system directory to the runner injected into Antigravity", async () => {
    const runner = runtimeDependencies().windowsCredentialRunner;
    if (runner === undefined) throw new Error("Missing Windows runner");
    const systemDirectory = path.win32.join(
      process.env["SystemRoot"] ?? "C:\\Windows",
      "System32"
    );

    await runner("C:\\fixture\\helper.exe", ["probe"], 1_000);

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "C:\\fixture\\helper.exe",
      ["probe"],
      expect.objectContaining({ cwd: systemDirectory }),
      expect.any(Function)
    );
    expect(systemDirectory.toLowerCase()).not.toBe(process.cwd().toLowerCase());
  });

  it("passes the Windows system directory to the browser opener", () => {
    const systemDirectory = path.win32.join(
      process.env["SystemRoot"] ?? "C:\\Windows",
      "System32"
    );

    runtimeDependencies().openBrowser("https://openlimiter.com/device");

    expect(childProcess.spawn).toHaveBeenCalledWith(
      path.win32.join(systemDirectory, "rundll32.exe"),
      ["url.dll,FileProtocolHandler", "https://openlimiter.com/device"],
      expect.objectContaining({ cwd: systemDirectory })
    );
    expect(systemDirectory.toLowerCase()).not.toBe(process.cwd().toLowerCase());
  });
});
