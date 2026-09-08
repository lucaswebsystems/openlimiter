import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fallbackLauncherCommand } from "../src/terminal-fallback.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "openlimiter fallback "));
  roots.push(root);
  const directory = path.join(root, "terminal-runtime");
  await mkdir(directory);
  const runtime = { node: path.join(directory, path.basename(process.execPath)), entry: path.join(directory, "openlimiter.cjs"), version: "test" };
  await cp(process.execPath, runtime.node);
  const originalFile = path.join(root, "original.cjs");
  await writeFile(originalFile, 'process.stdin.on("data", b => process.stdout.write(b)); process.stderr.write("never show this");');
  const original = `"${process.execPath}" "${originalFile}"`;
  return { root, runtime, original };
}

async function execute(command: string, shell: "posix" | "cmd" | "powershell", input: Buffer) {
  const executable = shell === "posix"
    ? process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh"
    : shell === "powershell" ? "powershell.exe" : "cmd.exe";
  const args = shell === "posix" ? ["-c", command.replaceAll("\\", "/")]
    : shell === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["/d", "/s", "/c", `"${command}"`];
  const root = await mkdtemp(path.join(tmpdir(), "openlimiter output "));
  roots.push(root);
  await writeFile(path.join(root, "input"), input);
  const stdin = await open(path.join(root, "input"), "r");
  const stdout = await open(path.join(root, "stdout"), "w");
  const stderr = await open(path.join(root, "stderr"), "w");
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, stdio: [stdin.fd, stdout.fd, stderr.fd], windowsVerbatimArguments: shell === "cmd" });
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout: await readFile(path.join(root, "stdout")), stderr: await readFile(path.join(root, "stderr")) };
  } finally { await stdin.close(); await stdout.close(); await stderr.close(); }
}

describe("D18 native launcher fallback", () => {
  const shells = process.platform === "win32" ? ["cmd", "powershell"] as const : ["posix"] as const;
  for (const shell of shells) {
    for (const failure of ["package missing", "binary missing", "runtime throws", "nonzero", "timeout"] as const) {
      it(`${shell} restores exact original output when ${failure}`, async () => {
        const { runtime, original } = await fixture();
        const normalizedRuntime = shell === "posix"
          ? { ...runtime, node: runtime.node.replaceAll("\\", "/"), entry: runtime.entry.replaceAll("\\", "/") } : runtime;
        const command = await fallbackLauncherCommand(normalizedRuntime, shell, shell === "posix" ? original.replaceAll("\\", "/") : original, 500);
        if (failure === "binary missing") await rm(runtime.node);
        if (failure === "runtime throws") await writeFile(runtime.entry, 'throw new Error("do not show this");');
        if (failure === "nonzero") await writeFile(runtime.entry, 'process.stdout.write("partial wrong bars"); process.stderr.write("error"); process.exitCode = 2;');
        if (failure === "timeout") await writeFile(runtime.entry, 'process.stdout.write("partial wrong bars"); setInterval(() => {}, 100);');
        const payload = Buffer.from('  \u001b[32mmy bars\u001b[0m\r\n\u00e9\n\nno trailing newline');
        const result = await execute(command + " statusline --host claude", shell, payload);
        expect(result.code).toBe(0);
        expect(result.stderr.length).toBe(0);
        expect(result.stdout).toEqual(payload);
      }, 15_000);
    }
    it(`${shell} stays silent without an original and forwards successful output verbatim`, async () => {
      const { runtime } = await fixture();
      const normalizedRuntime = shell === "posix"
        ? { ...runtime, node: runtime.node.replaceAll("\\", "/"), entry: runtime.entry.replaceAll("\\", "/") } : runtime;
      const command = await fallbackLauncherCommand(normalizedRuntime, shell, null);
      expect(await execute(command, shell, Buffer.alloc(0))).toEqual({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      await writeFile(runtime.entry, 'process.stdout.write("new bars\\n\\n"); process.stderr.write("hidden");');
      const result = await execute(command, shell, Buffer.alloc(0));
      expect(result.stdout.toString()).toBe("new bars\n\n");
      expect(result.stderr.length).toBe(0);
    }, 15_000);
  }
  it("refuses a changed existing supervisor without replacing it", async () => {
    const { root, runtime, original } = await fixture();
    const command = await fallbackLauncherCommand(runtime, "posix", original);
    const file = command.slice("/bin/sh '".length, -1);
    await writeFile(file, "foreign content");
    await expect(fallbackLauncherCommand(runtime, "posix", original)).rejects.toThrow("Invalid launcher");
    expect(await readFile(file, "utf8")).toBe("foreign content");
    expect(file.startsWith(root)).toBe(true);
  });
});
