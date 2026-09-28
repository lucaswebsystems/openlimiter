import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fallbackLauncherCommand, LAUNCHER_TIMEOUT_MILLISECONDS } from "../src/terminal-fallback.js";

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
  const originalRan = path.join(root, "original.ran");
  await writeFile(originalFile, `require("node:fs").appendFileSync(${JSON.stringify(originalRan)}, "original\\n"); process.stdin.on("data", b => process.stdout.write(b)); process.stderr.write("never show this");`);
  const original = `"${process.execPath}" "${originalFile}"`;
  return { root, runtime, original, originalRan };
}

async function execute(command: string, shell: "posix" | "cmd" | "powershell" | "powershell-direct", input: Buffer, timeout?: number) {
  const executable = shell === "posix"
    ? process.platform === "win32" ? "bash" : "/bin/sh"
    : shell.startsWith("powershell") ? "powershell.exe" : "cmd.exe";
  const args = shell === "posix" ? ["-c", command.replaceAll("\\", "/")]
    : shell === "powershell-direct" ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", command]
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

describe("output normalisation contract", () => {
  // Synthetic bytes are independent of the shell capture encoding. Include all
  // formatting that must survive: spaces, ANSI, CRLF, Unicode and blank lines.
  const content = Buffer.from('  \u001b[32mmy bars\u001b[0m\r\n\u00e9\n\nno trailing newline');
  it.each([
    { name: "preserves output without a mark", input: content, expected: content },
    { name: "removes one leading mark", input: Buffer.concat([UTF8_BOM, content]), expected: content },
    { name: "removes only the first of two leading marks", input: Buffer.concat([UTF8_BOM, UTF8_BOM, content]), expected: Buffer.concat([UTF8_BOM, content]) },
    { name: "preserves a mark in the middle", input: Buffer.concat([content, UTF8_BOM, content]), expected: Buffer.concat([content, UTF8_BOM, content]) },
    { name: "preserves an empty buffer", input: Buffer.alloc(0), expected: Buffer.alloc(0) },
    { name: "removes a buffer containing only a mark", input: UTF8_BOM, expected: Buffer.alloc(0) },
    { name: "preserves trailing blank lines", input: Buffer.from("new bars\n\n"), expected: Buffer.from("new bars\n\n") },
  ])("$name", ({ input, expected }) => {
    expect(withoutOneLeadingBom(input)).toEqual(expected);
  });
});

describe("D18 native launcher fallback", () => {
  it.skipIf(process.platform !== "win32")("gives the stored original its full budget after a missing renderer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openlimiter missing renderer "));
    roots.push(root);
    const runtime = { node: path.join(root, "missing.exe"), entry: path.join(root, "terminal-runtime", "openlimiter.cjs"), version: "test" };
    const command = await fallbackLauncherCommand(runtime, "powershell", "echo x", { timeoutMilliseconds: LAUNCHER_TIMEOUT_MILLISECONDS });
    const script = command.match(/-File '(.*)'$/)![1]!.replaceAll("''", "'");
    const results: { code: number | null; stdout: Buffer; stderr: Buffer }[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next++ < 50) {
        results.push(await execute(script, "powershell-direct", Buffer.alloc(0)));
      }
    }));
    const failures = results.filter(result => result.code !== 0 || !result.stdout.equals(Buffer.from("x\r\n")) || result.stderr.length !== 0);
    expect(results).toHaveLength(50);
    expect(failures, `${failures.length}/50 runs lost the stored original`).toHaveLength(0);
  }, 120_000);
  /* The POSIX launcher is only ever installed where the product installs it,
     and terminal.ts picks cmd on Windows for every host, so the POSIX script
     never runs there in production. Exercising it through Git Bash instead
     tests MSYS process reaping and path translation rather than this product,
     which is why it is scoped out here. The synthetic cases below still prove
     every byte rule on all three platforms, and CI runs this file for real on
     Linux and macOS. */
  const posixAvailable = process.platform !== "win32";
  const timeoutAvailable = posixAvailable && spawnSync(process.platform === "win32" ? "bash" : "/bin/sh", [
    "-c", "test -x /usr/bin/timeout || command -v timeout"
  ], { stdio: "ignore" }).status === 0;
  it("records both supervisors in distinct immutable launchers", async () => {
    const { runtime, original } = await fixture();
    const timeout = await fallbackLauncherCommand(runtime, "posix", original, {
      timeoutMilliseconds: 500, posixTimeoutCommand: "/usr/bin/timeout"
    });
    const polling = await fallbackLauncherCommand(runtime, "posix", original, {
      timeoutMilliseconds: 500, posixTimeoutCommand: null
    });
    expect(timeout).not.toBe(polling);
    const timeoutScript = await readFile(timeout.slice("/bin/sh '".length, -1), "utf8");
    const pollingScript = await readFile(polling.slice("/bin/sh '".length, -1), "utf8");
    expect(timeoutScript).toContain('# Supervisor: timeout');
    expect(timeoutScript).toContain("'/usr/bin/timeout' 0.5 \"$@\"");
    expect(timeoutScript).not.toMatch(/\$!|\$run_work\/(?:status|timeout)|\bwhile\b|\bkill\b|\bsleep\b/);
    expect(pollingScript).toContain('# Supervisor: polling');
    expect(pollingScript).toContain('read -r result < "$run_work/status"');
    expect(pollingScript).not.toContain('/usr/bin/timeout');
  });
  const cases: { shell: "posix" | "cmd" | "powershell"; supervisor?: "timeout" | "polling" }[] = [
    ...(process.platform === "win32" ? [{ shell: "cmd" as const }, { shell: "powershell" as const }] : []),
    { shell: "posix", supervisor: "timeout" },
    { shell: "posix", supervisor: "polling" }
  ];
  for (const { shell, supervisor } of cases) {
    const label = supervisor ? `${shell} ${supervisor}` : shell;
    const options = supervisor === "polling" ? { posixTimeoutCommand: null } : {};
    const shellTest = shell === "posix" && (!posixAvailable || supervisor === "timeout" && !timeoutAvailable) ? it.skip : it;
    shellTest(`${label} preserves ordinary output and runs the stored original on every failure`, async () => {
      const launcherTimeout = 1_500;
      // Keep native execution coverage, but compare both captures under the same
      // contract. Leading mark counts belong to the synthetic cases above.
      for (const failure of ["success", "package missing", "binary missing", "runtime throws", "nonzero", "timeout"] as const) {
        const { root, runtime, original, originalRan } = await fixture();
        // Reuse the installed executable for timing, avoiding scans of a fresh binary copy.
        if (failure === "timeout") runtime.node = process.execPath;
        const normalizedRuntime = shell === "posix"
          ? { ...runtime, node: runtime.node.replaceAll("\\", "/"), entry: runtime.entry.replaceAll("\\", "/") } : runtime;
        const normalizedOriginal = shell === "posix" ? original.replaceAll("\\", "/") : original;
        const command = await fallbackLauncherCommand(normalizedRuntime, shell, normalizedOriginal, { ...options, timeoutMilliseconds: launcherTimeout });
        const killDiagnostics = path.join(root, "killed.jsonl");
        if (failure === "timeout" && shell !== "posix") {
          const file = shell === "cmd" ? command.match(/-File "(.*)"$/)![1]!
            : command.match(/-File '(.*)'$/)![1]!.replaceAll("''", "'");
          const script = await readFile(file, "utf8");
          // Assert the supervisor's actual deadline, independently of shell
          // startup and runner scheduling. Doubling the renderer budget must fail.
          const commandDeadline = script.match(/\$clock = \[Diagnostics\.Stopwatch\]::StartNew\(\)\s+while \(!\$p\.HasExited -and \$clock\.ElapsedMilliseconds -lt (\d+)\)/);
          expect(commandDeadline, "each command starts a fresh deadline clock").not.toBeNull();
          expect(Number(commandDeadline![1]), "renderer gets one configured budget before fallback").toBe(launcherTimeout);
          // Observe each internal result without changing stdout or stderr.
          const resultLine = /^( +\$result = Invoke-Bar .+)$/gm;
          expect([...script.matchAll(resultLine)], "renderer and original diagnostic hooks").toHaveLength(2);
          await writeFile(file, script.replace(resultLine, line => `${line}\n    [IO.File]::AppendAllText('${killDiagnostics.replaceAll("'", "''")}', (($result.killed | ConvertTo-Json -Compress) + [Environment]::NewLine))`));
        }
        if (supervisor) {
          const script = await readFile(command.slice("/bin/sh '".length, -1), "utf8");
          expect(script).toContain(`# Supervisor: ${supervisor}`);
          if (supervisor === "timeout") {
            expect(script).toContain(`' ${launcherTimeout / 1000} "$@"`);
            expect(script).not.toMatch(/\$!|\$run_work\/(?:status|timeout)|\bwhile\b|\bkill\b|\bsleep\b/);
          } else {
            expect(script).toContain(`(/bin/sleep ${launcherTimeout / 1000};`);
            expect(script).toContain('read -r result < "$run_work/status"');
          }
        }
        if (failure === "success") await writeFile(runtime.entry, 'process.stdin.on("data", b => process.stdout.write(b)); process.stderr.write("hidden");');
        if (failure === "binary missing") await rm(runtime.node);
        if (failure === "runtime throws") await writeFile(runtime.entry, 'throw new Error("do not show this");');
        if (failure === "nonzero") await writeFile(runtime.entry, 'process.stdout.write("partial wrong bars"); process.stderr.write("error"); process.exitCode = 2;');
        if (failure === "timeout") {
          await writeFile(runtime.entry, `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "child.pid"))}, String(process.pid)); process.stdout.write("partial wrong bars"); setInterval(() => process.stdout.write("still wrong"), 100);`);
          if (supervisor === "polling") {
            // Prove the deadline even when every termination attempt is ineffective.
            const file = command.slice("/bin/sh '".length, -1);
            const script = await readFile(file, "utf8");
            await writeFile(file, script.replace("run_number=0", 'kill() { if [ "$1" = "-0" ]; then command kill "$@"; else return 0; fi; }\nrun_number=0'));
          }
        }
        const payload = Buffer.concat([Buffer.from('  \u001b[32mmy bars\u001b[0m\r\n\u00e9\n\n'), UTF8_BOM, Buffer.from("no trailing newline")]);
        const originalOutput = await execute(normalizedOriginal, shell === "posix" ? "posix" : "cmd", payload);
        expect(originalOutput.code, failure).toBe(0);
        expect(await readFile(originalRan, "utf8"), failure).toBe("original\n");
        await rm(originalRan);
        const deadline = launcherTimeout + 1_000;
        const started = performance.now();
        // Native Windows timing is proved by the supervisor deadline above;
        // this outer watchdog only prevents a hung test on a loaded runner.
        const result = await execute(command + " statusline --host claude", shell, payload, failure === "timeout" ? shell === "posix" ? deadline + 500 : 30_000 : undefined);
        const elapsed = performance.now() - started;
        if (failure === "timeout") {
          console.info(`${label} timeout fallback wall time: ${Math.round(elapsed)} ms`);
          if (shell !== "posix") {
            const killed = (await readFile(killDiagnostics, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line) as boolean);
            expect(killed, "renderer and stored original both returned diagnostics").toHaveLength(2);
            expect(killed[0], "timed out renderer was killed").toBe(true);
            expect(killed[1], "stored original was not killed by its own timeout").toBe(false);
          }
          if (shell === "posix") expect(elapsed).toBeLessThan(deadline);
        }
        expect(result.code, failure).toBe(0);
        expect(result.stderr.length, failure).toBe(0);
        expect(withoutOneLeadingBom(result.stdout), failure).toEqual(withoutOneLeadingBom(originalOutput.stdout));
        if (failure === "success") {
          await expect(readFile(originalRan), failure).rejects.toMatchObject({ code: "ENOENT" });
          console.info(`${label} success iteration passed`);
        } else {
          expect(await readFile(originalRan, "utf8"), failure).toBe("original\n");
        }
      }

      const { runtime } = await fixture();
      const normalizedRuntime = shell === "posix"
        ? { ...runtime, node: runtime.node.replaceAll("\\", "/"), entry: runtime.entry.replaceAll("\\", "/") } : runtime;
      const command = await fallbackLauncherCommand(normalizedRuntime, shell, null, options);
      const silent = await execute(command, shell, Buffer.alloc(0));
      expect(silent.code).toBe(0);
      expect(withoutOneLeadingBom(silent.stdout)).toEqual(Buffer.alloc(0));
      expect(silent.stderr.length).toBe(0);
      await writeFile(runtime.entry, 'process.stdout.write("new bars\\n\\n"); process.stderr.write("hidden");');
      const result = await execute(command, shell, Buffer.alloc(0));
      expect(result.code).toBe(0);
      expect(withoutOneLeadingBom(result.stdout)).toEqual(Buffer.from("new bars\n\n"));
      expect(result.stderr.length).toBe(0);
    // This case starts many processes across six failures and two silent paths.
    // Its runner budget is separate from the supervisor deadline above.
    }, 120_000);
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
