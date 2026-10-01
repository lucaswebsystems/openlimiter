import path from "node:path";
import { describe, expect, it } from "vitest";
import { windowsPathTool, windowsSystemTool } from "../src/windows-system-tool.js";

describe("Windows system tools", () => {
  it("builds an absolute System32 path under a non C drive root", () => {
    const resolved = windowsSystemTool("netstat.exe", { SystemRoot: "D:\\Windows" });
    expect(resolved).toBe("D:\\Windows\\System32\\netstat.exe");
    expect(path.win32.isAbsolute(resolved)).toBe(true);
  });

  it("searches absolute PATH entries only and never treats an empty entry as cwd", async () => {
    const visited: string[] = [];
    const resolved = await windowsPathTool(
      "pwsh.exe",
      { PATH: ";relative;C:\\Same Named Fixture;D:\\Trusted Tools" },
      async (candidate) => {
        visited.push(candidate);
        return candidate === "D:\\Trusted Tools\\pwsh.exe";
      },
      "C:\\Same Named Fixture"
    );
    expect(resolved).toBe("D:\\Trusted Tools\\pwsh.exe");
    expect(path.win32.isAbsolute(resolved!)).toBe(true);
    expect(visited).toEqual(["D:\\Trusted Tools\\pwsh.exe"]);
  });
});
