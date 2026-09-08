import { describe, expect, it } from "vitest";
import {
  commandInvocation,
  quoteWindowsCommandArgument
} from "../src/command-runner.js";

describe("Windows command shim runner", () => {
  it("quotes a spaced path and an embedded quote as one command argument", () => {
    expect(quoteWindowsCommandArgument('value with a "quote"')).toBe('"value with a ^"quote^""');
    const invocation = commandInvocation(
      "C:\\Program Files\\Codex\\codex.cmd",
      ['value with a "quote"', "one & two"],
      "win32",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
    );
    expect(invocation.executable).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.arguments.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.arguments[3]).toContain('"C:\\Program Files\\Codex\\codex.cmd"');
    expect(invocation.arguments[3]).toContain('value with a ^"quote^"');
    expect(invocation.arguments[3]).toContain("one ^& two");
  });

  it("keeps direct executable invocation unchanged off Windows", () => {
    expect(commandInvocation("codex", ["--version"], "linux")).toEqual({
      executable: "codex",
      arguments: ["--version"]
    });
  });
});
