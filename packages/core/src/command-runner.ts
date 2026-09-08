import { execFile, spawn, type ExecFileOptions, type SpawnOptions } from "node:child_process";
import path from "node:path";

export interface CommandInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export type CommandRunResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false };

/** Windows command shims are scripts, not native executables. */
export function isWindowsCommandShim(
  executable: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "win32") return false;
  const extension = path.win32.extname(executable).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

/**
 * Quote one value for the command string consumed by cmd.exe.
 * Every value is quoted, and cmd metacharacters and embedded quotes are
 * escaped before the command is handed to the shell.
 */
export function quoteWindowsCommandArgument(value: string): string {
  if (/[\0\r\n]/u.test(value)) throw new Error("Invalid command argument");
  let escaped = "";
  for (const character of value) {
    if ("^&|<>()\"!".includes(character)) escaped += "^";
    if (character === "%") escaped += "%";
    escaped += character;
  }
  return `"${escaped}"`;
}

/** Build the direct or cmd.exe invocation for one executable and its args. */
export function commandInvocation(
  executable: string,
  argumentsList: readonly string[],
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env
): CommandInvocation {
  if (!isWindowsCommandShim(executable, platform)) {
    return { executable, arguments: [...argumentsList] };
  }
  const command = [executable, ...argumentsList]
    .map(quoteWindowsCommandArgument)
    .join(" ");
  return {
    executable: environment["ComSpec"] ?? environment["COMSPEC"] ??
      process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "cmd.exe",
    arguments: ["/d", "/s", "/c", `"${command}"`]
  };
}

/** Run a command while handling Windows .cmd and .bat shims. */
export function runCommandWithWindowsShim(
  executable: string,
  argumentsList: readonly string[],
  options: ExecFileOptions = {},
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = options.env ?? process.env
): Promise<CommandRunResult> {
  const invocation = commandInvocation(
    executable,
    argumentsList,
    platform,
    environment
  );
  if (!isWindowsCommandShim(executable, platform)) {
    return new Promise((resolve) => {
      try {
        execFile(invocation.executable, [...invocation.arguments], options, (error, stdout, stderr) => {
          resolve(error === null
            ? { ok: true, stdout: stdout.toString(), stderr: stderr.toString() }
            : { ok: false });
        });
      } catch {
        resolve({ ok: false });
      }
    });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    let settled = false;
    const maxBuffer = typeof options.maxBuffer === "number" ? options.maxBuffer : 200 * 1024;
    const finish = (result: CommandRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(invocation.executable, [...invocation.arguments], {
        cwd: options.cwd,
        env: options.env,
        windowsHide: options.windowsHide,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      finish({ ok: false });
      return;
    }
    const timeout = typeof options.timeout === "number"
      ? setTimeout(() => child.kill(options.killSignal), options.timeout)
      : undefined;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > maxBuffer) {
        exceeded = true;
        child.kill(options.killSignal);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > maxBuffer) {
        exceeded = true;
        child.kill(options.killSignal);
      }
    });
    child.once("error", () => {
      if (timeout !== undefined) clearTimeout(timeout);
      finish({ ok: false });
    });
    child.once("close", (code) => {
      if (timeout !== undefined) clearTimeout(timeout);
      finish(code === 0 && !exceeded ? { ok: true, stdout, stderr } : { ok: false });
    });
  });
}

/** Spawn a command while handling Windows .cmd and .bat shims. */
export function spawnWithWindowsCommandShim(
  executable: string,
  argumentsList: readonly string[],
  options: SpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = options.env ?? process.env
): ReturnType<typeof spawn> {
  const invocation = commandInvocation(
    executable,
    argumentsList,
    platform,
    environment
  );
  return spawn(invocation.executable, [...invocation.arguments], options);
}
