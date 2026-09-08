import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fallbackLauncherCommand } from "../src/terminal-fallback.js";

const roots: string[] = [];
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function withoutOneLeadingBom(output: Buffer): Buffer {
  return output.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
    ? output.subarray(UTF8_BOM.length)
    : output;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Native Node termination also cleans up children that Git Bash cannot kill.
    try {
      const pid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
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

async function execute(command: string, shell: "posix" | "cmd" | "powershell", input: Buffer, timeout?: number) {
  const executable = shell === "posix"
    ? process.platform === "win32" ? "bash" : "/bin/sh"
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
      const child = spawn(executable, args, { windowsHide: true, stdio: [stdin.fd, stdout.fd, stderr.fd], windowsVerbatimArguments: shell === "cmd", timeout, killSignal: "SIGKILL" });
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout: await readFile(path.join(root, "stdout")), stderr: await readFile(path.join(root, "stderr")) };
  } finally { await stdin.close(); await stdout.close(); await stderr.close(); }
}

describe("D18 native launcher fallback", () => {
  const posixAvailable = process.platform !== "win32" || spawnSync("bash", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;
  const shells: readonly ("posix" | "cmd" | "powershell")[] = process.platform === "win32"
    ? ["cmd", "powershell", "posix"]
    : ["posix"];
  for (const shell of shells) {
    const shellTest = shell === "posix" && !posixAvailable ? it.skip : it;
    for (const outcome of ["success", "fallback"] as const) {
      shellTest(`${shell} removes only one leading byte order mark on ${outcome}`, async () => {
        const { runtime, original } = await fixture();
        const normalizedRuntime = shell === "posix"
          ? { ...runtime, node: runtime.node.replaceAll("\\", "/"), entry: runtime.entry.replaceAll("\\", "/") } : runtime;
        const normalizedOriginal = shell === "posix" ? original.replaceAll("\\", "/") : original;
        const command = await fallbackLauncherCommand(normalizedRuntime, shell, normalizedOriginal);
        if (outcome === "success") {
          await writeFile(runtime.entry, 'process.stdin.on("data", b => process.stdout.write(b));');
        }
        // Raw Node streams force both encoding cases regardless of shell defaults.
        const content = Buffer.concat([Buffer.from('  \u001b[32mmy bars\u001b[0m\r\n\u00e9\n\n'), UTF8_BOM, Buffer.from("no trailing newline")]);
        for (const leadingMarks of [0, 1, 2]) {
          const payload = Buffer.concat([...Array<Buffer>(leadingMarks).fill(UTF8_BOM), content]);
          const originalOutput = await execute(normalizedOriginal, shell === "posix" ? "posix" : "cmd", payload);
          const result = await execute(command, shell, payload);
          expect(result).toEqual({ code: 0, stdout: withoutOneLeadingBom(originalOutput.stdout), stderr: Buffer.alloc(0) });
          expect(result.stdout).toEqual(leadingMarks === 2 ? Buffer.concat([UTF8_BOM, content]) : content);
        }
      }, 15_000);
    }
    for (const failure of ["package missing", "binary missing", "runtime throws", "nonzero", "timeout"] as const) {
      shellTest(`${shell} restores exact original output when ${failure}`, async () => {
        const { root, runtime, original } = await fixture();
        // Reuse the installed executable for timing, avoiding scans of a fresh binary copy.
        if (failure === "timeout") runtime.node = process.execPath;
        const normalizedRuntime = shell === "posix"
          ? { ...runtime, node: runtime.node.replaceAll("\\", "/"), entry: runtime.entry.replaceAll("\\", "/") } : runtime;
        const normalizedOriginal = shell === "posix" ? original.replaceAll("\\", "/") : original;
        const command = await fallbackLauncherCommand(normalizedRuntime, shell, normalizedOriginal, { timeoutMilliseconds: 500 });
        if (failure === "binary missing") await rm(runtime.node);
        if (failure === "runtime throws") await writeFile(runtime.entry, 'throw new Error("do not show this");');
        if (failure === "nonzero") await writeFile(runtime.entry, 'process.stdout.write("partial wrong bars"); process.stderr.write("error"); process.exitCode = 2;');
        if (failure === "timeout") {
          await writeFile(runtime.entry, `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "child.pid"))}, String(process.pid)); process.stdout.write("partial wrong bars"); setInterval(() => process.stdout.write("still wrong"), 100);`);
          if (shell === "posix") {
            // Prove the deadline even when every termination attempt is ineffective.
            const file = command.slice("/bin/sh '".length, -1);
            const script = await readFile(file, "utf8");
            await writeFile(file, script.replace("run_number=0", 'kill() { if [ "$1" = "-0" ]; then command kill "$@"; else return 0; fi; }\nrun_number=0'));
          }
        }
        const payload = Buffer.concat([UTF8_BOM, Buffer.from('  \u001b[32mmy bars\u001b[0m\r\n\u00e9\n\nno trailing newline')]);
        const originalOutput = await execute(normalizedOriginal, shell === "posix" ? "posix" : "cmd", payload);
        const started = performance.now();
        const result = await execute(command + " statusline --host claude", shell, payload, failure === "timeout" ? 2_000 : undefined);
        const elapsed = performance.now() - started;
        if (failure === "timeout") {
          console.info(`${shell} timeout fallback wall time: ${Math.round(elapsed)} ms`);
          expect(elapsed).toBeLessThan(1_500);
        }
        expect(result.code).toBe(0);
        expect(result.stderr.length).toBe(0);
        expect(result.stdout).toEqual(withoutOneLeadingBom(originalOutput.stdout));
      }, 15_000);
    }
    shellTest(`${shell} preserves a byte order mark in the middle of original output`, async () => {
      const { runtime, original } = await fixture();
      const normalizedRuntime = shell === "posix"
        ? { ...runtime, node: runtime.node.replaceAll("\\", "/"), entry: runtime.entry.replaceAll("\\", "/") } : runtime;
      const normalizedOriginal = shell === "posix" ? original.replaceAll("\\", "/") : original;
      const command = await fallbackLauncherCommand(normalizedRuntime, shell, normalizedOriginal, { timeoutMilliseconds: 500 });
      await writeFile(runtime.entry, 'throw new Error("do not show this");');
      const payload = Buffer.concat([Buffer.from("before"), UTF8_BOM, Buffer.from("after")]);
      const originalOutput = await execute(normalizedOriginal, shell === "posix" ? "posix" : "cmd", payload);
      const result = await execute(command + " statusline --host claude", shell, payload);
      expect(result.stdout).toEqual(withoutOneLeadingBom(originalOutput.stdout));
      expect(result.stdout).toEqual(payload);
    }, 15_000);
    shellTest(`${shell} stays silent without an original and forwards successful output verbatim`, async () => {
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
