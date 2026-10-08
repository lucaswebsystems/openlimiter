import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CACHE_FILE_NAME, resolveStateDirectory, windowsSystemTool } from "@openlimiter/core";
import { tomlValue } from "../src/terminal-toml.js";
import { fallbackLauncherCommand } from "../src/terminal-fallback.js";
import { installLauncher } from "../src/terminal-launcher.js";
import { encodeWrappedStatuslineCommand } from "../src/statusline-wrapper.js";

vi.mock("../src/terminal-launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/terminal-launcher.js")>();
  return { ...actual, installLauncher: (directory: string, source?: string) => actual.installLauncher(directory, source ?? path.resolve(".test-dist/launcher-source")) };
});

const compiledLauncherSource = path.resolve(".test-dist/launcher-source");
async function prepareCompiledLauncherSource(): Promise<void> {
  const packages = [
    ["openlimiter", "cli"],
    ["@openlimiter/adapters", "adapters"],
    ["@openlimiter/connectors", "connectors"],
    ["@openlimiter/core", "core"]
  ] as const;
  for (const [name, directory] of packages) {
    const packageRoot = name === "openlimiter"
      ? compiledLauncherSource
      : path.join(compiledLauncherSource, "node_modules", ...name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    await cp(path.resolve(".test-dist/packages", directory, "src"), path.join(packageRoot, "dist"), { recursive: true });
    await cp(path.resolve("packages", directory, "package.json"), path.join(packageRoot, "package.json"));
  }
}
beforeAll(prepareCompiledLauncherSource);
import {
  STATUS_NOT_WIRED,
  STATUS_OWN_LINE_FOUND,
  STATUS_WIRED,
  TERMINAL_HOST_NAMES,
  UNSUPPORTED_HOST_ALTERNATIVE,
  hostStatus,
  installHost,
  repairAntigravityCommand,
  terminalHide,
  terminalShow,
  terminalStatusTable,
  uninstallHost,
  validateToml,
  windowsShortPath,
  type TerminalHostContext
} from "../src/terminal.js";
import { CONFIG_FILE_NAME, runCli } from "../src/index.js";

// Install journeys now copy and execute a real shipped runtime. Allow slow
// Windows filesystem and antivirus scans to finish before fixture cleanup.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/* The temp root in canonical form, matching the pattern every other suite in
   this package uses so a symlinked or short-named OS temp directory never
   makes a path comparison lie. */
let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), prefix));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function context(homeDirectory: string): Promise<TerminalHostContext> {
  return {
    homeDirectory,
    platform: "win32",
    environment: { SHELL: "powershell.exe" },
    shellRunner: async () => ({ ok: true, stdout: path.join(homeDirectory, "profile.ps1") })
  };
}

/* Antigravity's Go runner hands the saved command to cmd /c as one argument,
   escaped the way Node escapes it: the whole string quoted, inner quotes as \". */
async function invokeThroughCmd(
  command: string,
  input: string,
  environment: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(windowsSystemTool("cmd.exe"), ["/c", command], {
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("terminal host installers", () => {
  it("supports exactly the five documented hosts", () => {
    expect(TERMINAL_HOST_NAMES).toEqual(["claude", "antigravity", "grok", "codex", "shell"]);
  });

  it("reports unsupported hosts with the shell alternative", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    for (const host of ["gemini", "opencode", "kimi"]) {
      expect(await hostStatus(host, ctx)).toBe(UNSUPPORTED_HOST_ALTERNATIVE);
    }
  });

  it("round trips Claude: install, install again, uninstall with no prior line", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    expect(await hostStatus("claude", ctx)).toBe(STATUS_NOT_WIRED);

    const installed = await installHost("claude", ctx);
    expect(installed.ok).toBe(true);
    expect(await hostStatus("claude", ctx)).toBe(STATUS_WIRED);
    const settingsFile = path.join(home, ".claude", "settings.json");
    const afterInstall = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { command: string };
    };
    expect(afterInstall.statusLine.command).toContain('openlimiter.ps1" statusline --host claude');

    /* Installing a second time must not wrap its own command around itself. */
    const installedAgain = await installHost("claude", ctx);
    expect(installedAgain.ok).toBe(true);
    const afterSecondInstall = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { command: string };
    };
    expect(afterSecondInstall.statusLine.command).toBe(afterInstall.statusLine.command);

    const uninstalled = await uninstallHost("claude", ctx);
    expect(uninstalled.ok).toBe(true);
    expect(await hostStatus("claude", ctx)).toBe(STATUS_NOT_WIRED);
    await expect(readFile(settingsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps and restores an existing Claude status line through --wrap", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    ctx.wrap = true;
    const settingsFile = path.join(home, ".claude", "settings.json");
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(
      settingsFile,
      JSON.stringify({ statusLine: { type: "command", command: "my-own-statusline --flag" } }),
      "utf8"
    );
    expect(await hostStatus("claude", ctx)).toBe(STATUS_OWN_LINE_FOUND);

    await installHost("claude", ctx);
    const wrapped = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { command: string };
    };
    expect(wrapped.statusLine.command).toContain('openlimiter.ps1" statusline --host claude --wrap ');
    expect(wrapped.statusLine.command).not.toContain("my-own-statusline");

    /* Installing again must not wrap the already wrapped command a second
       time: the user's original command has to survive exactly one uninstall
       away, not two. */
    await installHost("claude", ctx);
    const wrappedAgain = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { command: string };
    };
    expect(wrappedAgain.statusLine.command).toBe(wrapped.statusLine.command);

    const uninstalled = await uninstallHost("claude", ctx);
    expect(uninstalled.ok).toBe(true);
    const restored = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { command: string };
    };
    expect(restored.statusLine.command).toBe("my-own-statusline --flag");
  });

  it("round trips Antigravity, including wrap and restore", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    ctx.wrap = true;
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ statusLine: "their-own-line" }), "utf8");
    expect(await hostStatus("antigravity", ctx)).toBe(STATUS_OWN_LINE_FOUND);

    await installHost("antigravity", ctx);
    const wrapped = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { type: string; command: string };
    };
    expect(wrapped.statusLine.type).toBe("command");
    expect(wrapped.statusLine.command).toContain("openlimiter.ps1 statusline --host antigravity --wrap ");

    await installHost("antigravity", ctx);
    const wrappedAgain = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { type: string; command: string };
    };
    expect(wrappedAgain.statusLine).toEqual(wrapped.statusLine);

    await uninstallHost("antigravity", ctx);
    const restored = JSON.parse(await readFile(settingsFile, "utf8")) as { statusLine: string };
    expect(restored.statusLine).toBe("their-own-line");
  });

  it.runIf(process.platform === "win32")("executes the complete installed Antigravity command through cmd and persists status line rows", async (testContext) => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const stateDirectory = path.join(home, "state");
    const ctx = { ...await context(home), stateDirectory };
    expect((await installHost("antigravity", ctx)).ok).toBe(true);
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { command: string };
    };
    const runtime = {
      node: path.join(stateDirectory, "terminal-runtime", "node.exe"),
      entry: path.join(stateDirectory, "terminal-runtime", "openlimiter.cjs"),
      version: "test"
    };
    // What 2.1.2 saved. This temporary home needs no short name, so the fix only drops its quotes.
    const quoted = `${await fallbackLauncherCommand(runtime, "cmd", null)} statusline --host antigravity`;
    expect(settings.statusLine.command).toBe(quoted.replaceAll('"', ""));
    const local = path.join(home, "local");
    const roaming = path.join(home, "roaming");
    const temp = path.join(home, "temp");
    const xdgState = path.join(home, "xdg-state");
    const xdgConfig = path.join(home, "xdg-config");
    const xdgCache = path.join(home, "xdg-cache");
    const xdgData = path.join(home, "xdg-data");
    const xdgRuntime = path.join(home, "xdg-runtime");
    await Promise.all([local, roaming, temp, xdgState, xdgConfig, xdgCache, xdgData, xdgRuntime]
      .map((directory) => mkdir(directory, { recursive: true })));
    const environment = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: local,
      APPDATA: roaming,
      TMP: temp,
      TEMP: temp,
      TMPDIR: temp,
      XDG_STATE_HOME: xdgState,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      XDG_RUNTIME_DIR: xdgRuntime
    };
    const input = await readFile(path.resolve("packages/connectors/fixtures/antigravity.quota.json"), "utf8");
    let invoked: Awaited<ReturnType<typeof invokeThroughCmd>>;
    try {
      invoked = await invokeThroughCmd(settings.statusLine.command, input, environment);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return testContext.skip("The sandbox refused the installed command subprocess");
      }
      throw error;
    }
    expect(invoked.code, invoked.stderr).toBe(0);
    expect(invoked.stdout).toContain("5h");
    const cacheDirectory = resolveStateDirectory({ platform: process.platform, environment, homeDirectory: home });
    const cache = JSON.parse(await readFile(path.join(cacheDirectory, CACHE_FILE_NAME), "utf8")) as {
      snapshots: { provider: string; provenance?: { observedVia?: string } }[];
    };
    expect(cache.snapshots.map((row) => row.provider)).toEqual(["ANTIGRAVITY", "ANTIGRAVITY"]);
    expect(cache.snapshots.every((row) => row.provenance?.observedVia === "antigravity_cli_statusline")).toBe(true);
    // cmd reads 2.1.2's escaped quotes as part of the program name.
    expect((await invokeThroughCmd(quoted, input, environment)).code).toBe(1);
  });

  it("migrates Antigravity's legacy string to the documented command object", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({
      statusLine: "openlimiter statusline --host antigravity"
    }), "utf8");

    expect((await installHost("antigravity", ctx)).ok).toBe(true);
    const installed = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: Record<string, unknown>;
    };
    expect(installed.statusLine["type"]).toBe("command");
    expect(typeof installed.statusLine["command"]).toBe("string");
  });

  it("preserves Antigravity's documented status line options", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({
      statusLine: {
        type: "command",
        command: "openlimiter statusline --host antigravity",
        padding: 3,
        enabled: false,
        stack_with_default: true
      }
    }), "utf8");

    expect((await installHost("antigravity", ctx)).ok).toBe(true);
    const installed = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: Record<string, unknown>;
    };
    expect(installed.statusLine).toMatchObject({
      type: "command",
      padding: 3,
      enabled: false,
      stack_with_default: true
    });
    expect(typeof installed.statusLine["command"]).toBe("string");
  });

  /* Antigravity runs its status line through cmd /c with Go's escaping, which
     turns every quote into \" and cmd then cannot find the program. */
  async function antigravityCommand(home: string): Promise<string> {
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    return (JSON.parse(await readFile(settingsFile, "utf8")) as { statusLine: { command: string } }).statusLine.command;
  }

  it("writes Antigravity's Windows command with no quote characters", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const asked: string[] = [];
    const ctx = { ...await context(home), windowsShortPath: async (longPath: string) => { asked.push(longPath); return null; } };
    expect(await installHost("antigravity", ctx)).toEqual({ ok: true, message: "Wired Antigravity CLI status line." });
    const launchers = path.join(home, ".openlimiter", "terminal-launchers");
    const launcher = path.join(launchers, (await readdir(launchers))[0]!, "openlimiter.ps1");
    expect((await stat(launcher)).isFile()).toBe(true);
    expect(await antigravityCommand(home)).toBe(
      `${windowsSystemTool("WindowsPowerShell", "v1.0", "powershell.exe")} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${launcher} statusline --host antigravity`
    );
    expect(asked).toEqual([]);
    expect(await hostStatus("antigravity", ctx)).toBe(STATUS_WIRED);
  });

  it("gives a Windows home with a space its 8.3 short name in Antigravity's command", async () => {
    const home = path.join(await temporaryDirectory("openlimiter-terminal-"), "John Smith");
    await mkdir(home);
    const asked: string[] = [];
    const ctx = {
      ...await context(home),
      windowsShortPath: async (longPath: string) => { asked.push(longPath); return longPath.replace("John Smith", "JOHNSM~1"); }
    };
    expect(await installHost("antigravity", ctx)).toEqual({ ok: true, message: "Wired Antigravity CLI status line." });
    expect(asked).toEqual([home]);
    const command = await antigravityCommand(home);
    expect(command).not.toContain('"');
    expect(command).toContain(` -File ${path.join(path.dirname(home), "JOHNSM~1", ".openlimiter", "terminal-launchers")}`);
    expect(command).toMatch(/openlimiter\.ps1 statusline --host antigravity$/);
    expect(await hostStatus("antigravity", ctx)).toBe(STATUS_WIRED);
  });

  it("keeps the quoted Antigravity command and warns when the short name cmd gives back is still unsafe", async () => {
    // No 8.3 names on the volume, or a short name that keeps a cmd special character.
    for (const [name, shortName] of [["John Smith", "John Smith"], ["Tom & Jerry", "TOM&JE~1"]] as const) {
      const home = path.join(await temporaryDirectory("openlimiter-terminal-"), name);
      await mkdir(home);
      const ctx = { ...await context(home), windowsShortPath: async (longPath: string) => longPath.replace(name, shortName) };
      expect(await installHost("antigravity", ctx)).toEqual({
        ok: true,
        message: "Wired Antigravity CLI status line.\nAntigravity cannot run a status line from a path with spaces on this volume."
      });
      const command = await antigravityCommand(home);
      expect(command).toContain(` -File "${path.join(home, ".openlimiter", "terminal-launchers")}`);
      expect(command).toMatch(/openlimiter\.ps1" statusline --host antigravity$/);
    }
  });

  it("restores Antigravity's settings after its quoted and its quote free command, both read as ours", async () => {
    const home = path.join(await temporaryDirectory("openlimiter-terminal-"), "John Smith");
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    await mkdir(path.dirname(settingsFile), { recursive: true });
    const original = JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "their-own-line" } }, null, 4);
    await writeFile(settingsFile, original, "utf8");
    const base = await context(home);

    await installHost("antigravity", { ...base, windowsShortPath: async (longPath) => longPath });
    expect(await antigravityCommand(home)).toContain('"');
    expect(await hostStatus("antigravity", base)).toBe(STATUS_WIRED);

    const ctx = { ...base, windowsShortPath: async (longPath: string) => longPath.replace("John Smith", "JOHNSM~1") };
    expect(await installHost("antigravity", ctx)).toEqual({ ok: true, message: "Wired Antigravity CLI status line." });
    const quoteFree = await antigravityCommand(home);
    expect(quoteFree).not.toContain('"');
    expect(await hostStatus("antigravity", ctx)).toBe(STATUS_WIRED);
    expect((await installHost("antigravity", ctx)).ok).toBe(true);
    expect(await antigravityCommand(home)).toBe(quoteFree);

    expect(await uninstallHost("antigravity", ctx)).toEqual({ ok: true, message: "Uninstalled Antigravity status line." });
    expect(await readFile(settingsFile, "utf8")).toBe(original);
  });

  it("reads cmd's answer as utf16le, so an accented folder above the spaced one reaches Antigravity's command intact", async () => {
    const home = path.join(await temporaryDirectory("openlimiter-terminal-"), "José", "John Smith");
    await mkdir(home, { recursive: true });
    // A volume where José has no 8.3 name and John Smith does: cmd /u writes the accent as utf16le.
    const short = path.join(path.dirname(home), "JOHNSM~1");
    const asked: string[][] = [];
    const run = async (_file: string, args: string[]) => { asked.push(args); return { stdout: Buffer.from(`${short}\r\n`, "utf16le") }; };
    const ctx = { ...await context(home), windowsShortPath: (longPath: string) => windowsShortPath(longPath, run) };
    expect(await installHost("antigravity", ctx)).toEqual({ ok: true, message: "Wired Antigravity CLI status line." });
    expect(asked.map(args => args[0])).toEqual(["/u"]);
    const command = await antigravityCommand(home);
    expect(command).toContain(` -File ${path.join(short, ".openlimiter", "terminal-launchers")}`);
    expect(command).not.toContain('"');
  });

  it.runIf(process.platform === "win32")("asks cmd itself for a Windows path's 8.3 name", async () => {
    // A volume without 8.3 names answers with the long path, accent included, which resolves the same.
    const directory = path.join(await temporaryDirectory("openlimiter-terminal-"), "José", "Tom & Jerry (x)");
    await mkdir(directory, { recursive: true });
    const short = await windowsShortPath(directory);
    expect(short).not.toBeNull();
    expect(await realpath(short!)).toBe(await realpath(directory));
  });

  it.each([false, true])("setup rewrites the quoted Antigravity command 2.1.2 left on Windows, wrap %s kept", async (wrap) => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const stateDirectory = path.join(home, "state");
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    const original = JSON.stringify({ statusLine: { type: "command", command: "their-own-line" } });
    // What 2.1.2's install left behind: both paths quoted, and the backup that restores the original.
    const base = await fallbackLauncherCommand(await installLauncher(stateDirectory), "cmd", "their-own-line");
    const quoted = `${base} statusline --host antigravity` + (wrap ? ` --wrap ${encodeWrappedStatuslineCommand("their-own-line")}` : "");
    const installed = JSON.stringify({ statusLine: { type: "command", command: quoted }, "openlimiter managed": true }, null, 2) + "\n";
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, installed);
    await writeFile(`${settingsFile}.openlimiter-backup.json`, JSON.stringify({ version: 1, original, installed }));
    const dependencies = { homeDirectory: home, stateDirectory, platform: "win32" as const, environment: { PATH: "", Path: "" } };

    const setup = await runCli(["setup"], dependencies);
    expect(setup.stdout).toContain("antigravity: Wired Antigravity CLI status line.");
    // The same launcher and wrap state, with no quote left for Go's escaping to break.
    expect(await antigravityCommand(home)).toBe(quoted.replaceAll('"', ""));
    expect((await runCli(["terminal", "uninstall", "antigravity"], dependencies)).exitCode).toBe(0);
    expect(await readFile(settingsFile, "utf8")).toBe(original);
  });

  it.each([
    { folder: "Alice --wrap Bob", wrap: false, saved: true },
    { folder: "Alice --wrap Bob", wrap: true, saved: true },
    // Without a backup install reads our own command, where this decodable value once passed for a saved original.
    { folder: `Alice --wrap ${encodeWrappedStatuslineCommand("echo pwned")}`, wrap: false, saved: false }
  ])("repair reads only the trailing --wrap of a 2.1.2 command whose path holds $folder, wrap $wrap", async ({ folder, wrap, saved }) => {
    const home = path.join(await temporaryDirectory("openlimiter-terminal-"), folder);
    const stateDirectory = path.join(home, "state");
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    const own = saved ? "their-own-line" : null;
    const encoded = encodeWrappedStatuslineCommand("their-own-line");
    const base = await fallbackLauncherCommand(await installLauncher(stateDirectory), "cmd", own);
    const quoted = `${base} statusline --host antigravity` + (wrap ? ` --wrap ${encoded}` : "");
    const installed = JSON.stringify({ statusLine: { type: "command", command: quoted }, "openlimiter managed": true }, null, 2) + "\n";
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, installed);
    const original = JSON.stringify({ statusLine: { type: "command", command: "their-own-line" } });
    if (saved) await writeFile(`${settingsFile}.openlimiter-backup.json`, JSON.stringify({ version: 1, original, installed }));
    const ctx = { ...await context(home), stateDirectory, windowsShortPath: async (longPath: string) => longPath.replace(folder, "ALICEW~1") };

    expect(await repairAntigravityCommand(ctx)).toEqual({ ok: true, message: "Wired Antigravity CLI status line." });
    const command = await antigravityCommand(home);
    expect(command).not.toContain('"');
    expect(command.endsWith(wrap ? ` statusline --host antigravity --wrap ${encoded}` : " statusline --host antigravity"), command).toBe(true);
    expect(command.split("--wrap")).toHaveLength(wrap ? 2 : 1);
  });

  it("round trips Grok's [ui.status_line] table, including wrap and restore", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    ctx.wrap = true;
    const configFile = path.join(home, ".grok", "config.toml");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(
      configFile,
      ['[some.other.table]', 'value = 1', '', '[ui.status_line]', 'type = "command"', 'command = "their-own-line"'].join("\n"),
      "utf8"
    );
    expect(await hostStatus("grok", ctx)).toBe(STATUS_OWN_LINE_FOUND);

    await installHost("grok", ctx);
    const wrapped = await readFile(configFile, "utf8");
    expect(tomlValue(wrapped, ["ui", "status_line", "command"])).toContain('openlimiter.ps1" statusline --host grok --wrap ');
    expect(wrapped).toContain("[some.other.table]");

    await installHost("grok", ctx);
    const wrappedAgain = await readFile(configFile, "utf8");
    expect(wrappedAgain).toBe(wrapped);

    await uninstallHost("grok", ctx);
    const restored = await readFile(configFile, "utf8");
    expect(restored).toContain("[some.other.table]");
    expect(restored).toContain("[ui.status_line]");
    expect(restored).toContain('command = "their-own-line"');
  });

  it("round trips Codex's built in [tui] status line items", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const configFile = path.join(home, ".codex", "config.toml");
    expect(await hostStatus("codex", ctx)).toBe(STATUS_NOT_WIRED);

    await installHost("codex", ctx);
    expect(await hostStatus("codex", ctx)).toBe(STATUS_WIRED);
    const written = await readFile(configFile, "utf8");
    expect(written).toContain("[tui]");
    expect(written).toContain("five-hour-limit");
    expect(written).not.toContain("openlimiter statusline");

    await installHost("codex", ctx);
    const writtenAgain = await readFile(configFile, "utf8");
    expect(writtenAgain).toBe(written);

    await uninstallHost("codex", ctx);
    expect(await hostStatus("codex", ctx)).toBe(STATUS_NOT_WIRED);
  });

  it("tells apart a foreign Codex status line from no status line at all", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const configFile = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(configFile), { recursive: true });

    /* A [tui] section with nothing about a status line is still nothing
       wired, not somebody else's. */
    await writeFile(configFile, ['[tui]', 'model = "gpt-4"'].join("\n"), "utf8");
    expect(await hostStatus("codex", ctx)).toBe(STATUS_NOT_WIRED);

    /* A [tui] section that already names its own status_line items is
       somebody else's, and install saves it rather than claiming
       nothing was there. */
    await writeFile(
      configFile,
      ['[tui]', 'status_line = ["their-item"]'].join("\n"),
      "utf8"
    );
    expect(await hostStatus("codex", ctx)).toBe(STATUS_OWN_LINE_FOUND);

    await installHost("codex", ctx);
    expect(await hostStatus("codex", ctx)).toBe(STATUS_WIRED);
  });

  it("round trips the shell prompt snippet and prints every documented format", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const installed = await installHost("shell", ctx);
    expect(installed.ok).toBe(true);
    expect(installed.message).toContain("Starship snippet");
    expect(installed.message).toContain("tmux snippet");
    expect(installed.message).toContain("Oh My Posh segment");
    expect(installed.message).toContain("statusline --host shell");
    expect(await hostStatus("shell", ctx)).toBe(STATUS_WIRED);

    const installedAgain = await installHost("shell", ctx);
    expect(installedAgain.ok).toBe(true);

    const uninstalled = await uninstallHost("shell", ctx);
    expect(uninstalled.ok).toBe(true);
    expect(await hostStatus("shell", ctx)).toBe(STATUS_NOT_WIRED);
  });

  it("resolves the shell profile by asking pwsh first, never a hardcoded Documents path", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    await writeFile(path.join(home, "pwsh.exe"), "same named cwd fixture");
    const resolvedProfile = path.join(home, "asked-pwsh-profile.ps1");
    const calls: string[] = [];
    const ctx: TerminalHostContext = {
      homeDirectory: home,
      platform: "win32",
      environment: { SHELL: "pwsh.exe", SystemRoot: "D:\\Windows", PATH: "" },
      shellRunner: async (executable) => {
        calls.push(executable);
        if (executable === "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") {
          return { ok: true, stdout: resolvedProfile + "\r\n" };
        }
        return { ok: false };
      }
    };
    const installed = await installHost("shell", ctx);
    expect(installed.ok).toBe(true);
    expect(calls).toEqual(["D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
    expect(path.win32.isAbsolute(calls[0]!)).toBe(true);
    const written = await readFile(resolvedProfile, "utf8");
    expect(written).toContain("statusline --host shell");
    expect(await hostStatus("shell", ctx)).toBe(STATUS_WIRED);
  });

  it("asks the selected PowerShell and refuses installation when its profile cannot be resolved", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const resolvedProfile = path.join(home, "asked-powershell-profile.ps1");
    const ctxWithPowershell: TerminalHostContext = {
      homeDirectory: home,
      platform: "win32",
      environment: { SHELL: "powershell.exe" },
      shellRunner: async (executable) => {
        if (executable === windowsSystemTool("WindowsPowerShell", "v1.0", "powershell.exe", {})) {
          return { ok: true, stdout: resolvedProfile };
        }
        return { ok: false };
      }
    };
    await installHost("shell", ctxWithPowershell);
    expect(await readFile(resolvedProfile, "utf8")).toContain("statusline --host shell");

    const ctxWithNeither: TerminalHostContext = {
      homeDirectory: home,
      platform: "win32",
      environment: { SHELL: "powershell.exe" },
      shellRunner: async () => ({ ok: false })
    };
    const installed = await installHost("shell", ctxWithNeither);
    expect(installed.ok).toBe(false);
    expect(await hostStatus("shell", ctxWithNeither)).toBe(STATUS_NOT_WIRED);
    const fallbackPath = path.join(
      home,
      "Documents",
      "WindowsPowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
    await expect(readFile(fallbackPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists every host in the status table, one row each", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const table = await terminalStatusTable(ctx);
    const rows = table.split("\n");
    expect(rows).toHaveLength(11);
    expect(rows).toContain("Claude: " + STATUS_NOT_WIRED);
    expect(rows).toContain("Gemini: " + UNSUPPORTED_HOST_ALTERNATIVE);
  });
});

describe("terminal show and hide", () => {
  it("allows explicit selection before a provider has a reading", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const stateDirectory = await temporaryDirectory("openlimiter-terminal-state-");
    const ctx: TerminalHostContext = {
      homeDirectory: home,
      stateDirectory,
      platform: "win32",
      detectedProviders: []
    };
    const result = await terminalShow(["claude"], ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Showing in terminal: claude.");
  });

  it("shows a provider once it is detected, and hide reverses it", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const stateDirectory = await temporaryDirectory("openlimiter-terminal-state-");
    const ctx: TerminalHostContext = {
      homeDirectory: home,
      stateDirectory,
      platform: "win32",
      detectedProviders: ["claude", "grok"]
    };
    const shown = await terminalShow(["claude"], ctx);
    expect(shown.ok).toBe(true);
    expect(shown.message).toContain("claude");

    const hidden = await terminalHide(["claude"], ctx);
    expect(hidden.ok).toBe(true);
  });
});

describe("openlimiter terminal (CLI dispatch)", () => {
  it("status prints one row per host", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const result = await runCli(["terminal", "status"], { homeDirectory: home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n")).toHaveLength(11);
  });

  it("install and uninstall a named host", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const installed = await runCli(["terminal", "install", "claude"], { homeDirectory: home });
    expect(installed.exitCode).toBe(0);
    const status = await runCli(["terminal", "status"], { homeDirectory: home });
    expect(status.stdout).toContain("Claude: " + STATUS_WIRED);
    const uninstalled = await runCli(["terminal", "uninstall", "claude"], { homeDirectory: home });
    expect(uninstalled.exitCode).toBe(0);
    const statusAfter = await runCli(["terminal", "status"], { homeDirectory: home });
    expect(statusAfter.stdout).toContain("Claude: " + STATUS_NOT_WIRED);
  });

  it("the desktop's two Claude commands, in order, wire the status line and the prompt hook", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    /* The hook installer pins the node, script and agent it writes into the
       hook, so each is a real file under the home it checks. */
    const node = path.join(home, "node.exe");
    const script = path.join(home, "openlimiter.js");
    const claude = path.join(home, "claude.exe");
    for (const file of [node, script, claude]) await writeFile(file, "fixture", "utf8");
    const pinned = await stat(claude);
    const dependencies = {
      homeDirectory: home,
      environment: {},
      nodeExecutable: node,
      openLimiterScript: script,
      detectedAgentInstallations: {
        claude: { version: "2.1.257", executable: claude, fileSize: pinned.size, mtimeMilliseconds: pinned.mtimeMs }
      }
    };
    expect((await runCli(["terminal", "install", "claude"], dependencies)).exitCode).toBe(0);
    expect((await runCli(["hooks", "install", "claude"], dependencies)).exitCode).toBe(0);
    const settings = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.statusLine.command).toContain("statusline --host claude");
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain('"hook","--agent","claude"');
  });

  it("refuses an unknown host with a usage exit code", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const result = await runCli(["terminal", "install", "nope"], { homeDirectory: home });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("a bare call prints the checklist without installing anything", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const result = await runCli(["terminal"], { homeDirectory: home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(STATUS_NOT_WIRED);
    const status = await runCli(["terminal", "status"], { homeDirectory: home });
    expect(status.stdout).not.toContain(STATUS_WIRED);
  });

  it("--yes wires every host at once, unattended", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const dependencies = {
      homeDirectory: home,
      platform: "win32" as const,
      environment: { SHELL: "powershell.exe" },
      windowsCredentialRunner: async () => ({ ok: true as const, stdout: path.join(home, "profile.ps1") })
    };
    const result = await runCli(["terminal", "--yes"], dependencies);
    expect(result.exitCode).toBe(0);
    const status = await runCli(["terminal", "status"], dependencies);
    for (const host of ["Claude", "Antigravity", "Grok", "Codex", "Shell"]) {
      expect(status.stdout).toContain(host + ": " + STATUS_WIRED);
    }
  });

  it("--yes prints Antigravity's warning under its wired line", async () => {
    // Every short name of this home keeps its &, so cmd can never run Antigravity's command from it.
    const home = path.join(await temporaryDirectory("openlimiter-terminal-"), "Tom & Jerry");
    await mkdir(home);
    const result = await runCli(["terminal", "--yes"], {
      homeDirectory: home,
      platform: "win32",
      environment: { SHELL: "powershell.exe" },
      windowsCredentialRunner: async () => ({ ok: true as const, stdout: path.join(home, "profile.ps1") })
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "antigravity: Wired Antigravity CLI status line.\nAntigravity cannot run a status line from a path with spaces on this volume."
    );
  });

  it("--host wires exactly the one host it names", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const result = await runCli(["terminal", "--host", "grok"], { homeDirectory: home });
    expect(result.exitCode).toBe(0);
    const status = await runCli(["terminal", "status"], { homeDirectory: home });
    expect(status.stdout).toContain("Grok: " + STATUS_WIRED);
    expect(status.stdout).toContain("Claude: " + STATUS_NOT_WIRED);
  });

  it("show persists explicit selection with and without a connected provider", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const stateDirectory = await temporaryDirectory("openlimiter-terminal-state-");
    const refused = await runCli(["terminal", "show", "claude"], {
      homeDirectory: home,
      stateDirectory,
      environment: {}
    });
    expect(refused.exitCode).toBe(0);
    expect(refused.stdout).toContain("Showing in terminal: claude.");

    const allowed = await runCli(["terminal", "show", "claude"], {
      homeDirectory: home,
      stateDirectory,
      environment: { CLAUDE_CODE_STATUSLINE: "1" }
    });
    expect(allowed.exitCode).toBe(0);
    const stored = JSON.parse(
      await readFile(path.join(stateDirectory, CONFIG_FILE_NAME), "utf8")
    ) as { statusline: { visibility: Record<string, boolean> } };
    expect(stored.statusline.visibility).toEqual({ claude: true });

    const hidden = await runCli(["terminal", "hide", "claude"], {
      homeDirectory: home,
      stateDirectory,
      environment: { CLAUDE_CODE_STATUSLINE: "1" }
    });
    expect(hidden.exitCode).toBe(0);
  });

  it("show and hide need at least one provider id", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    for (const action of ["show", "hide"]) {
      const result = await runCli(["terminal", action], { homeDirectory: home });
      expect(result.exitCode).toBe(2);
    }
  });

  it("hide rejects unrecognized provider ids", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const stateDirectory = await temporaryDirectory("openlimiter-terminal-state-");
    const ctx: TerminalHostContext = {
      homeDirectory: home,
      stateDirectory,
      platform: "win32",
      detectedProviders: ["claude"]
    };

    const direct = await terminalHide(["unknown-provider"], ctx);
    expect(direct.ok).toBe(false);
    expect(direct.message).toContain("Unknown terminal segment or provider.");

    const cli = await runCli(["terminal", "hide", "unconnected"], {
      homeDirectory: home,
      stateDirectory,
      environment: {}
    });
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr).toContain("Unknown terminal segment or provider.");
  });
});

describe("terminal fail safely on malformed JSON/TOML and preserve user keys", () => {
  it("validates TOML syntax checking brackets, braces, quotes, and missing equals", () => {
    expect(validateToml('foo = "bar"\n[section]\nkey = 123')).toBe(true);
    expect(validateToml('array = [\n  "one",\n  "two"\n]')).toBe(true);
    expect(validateToml('inline = { a = 1, b = 2 }')).toBe(true);
    expect(validateToml('# comment\n\nkey = "val"')).toBe(true);

    expect(validateToml('foo = "bar')).toBe(false);
    expect(validateToml('array = [1, 2')).toBe(false);
    expect(validateToml('table = { a = 1')).toBe(false);
    expect(validateToml('broken line without equals')).toBe(false);
    expect(validateToml('[ui.status_line]\ninvalid_entry')).toBe(false);
  });

  it("refuses to install or uninstall when JSON is malformed", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const claudeFile = path.join(home, ".claude", "settings.json");
    await mkdir(path.dirname(claudeFile), { recursive: true });
    await writeFile(claudeFile, "{ invalid json", "utf8");

    const installResult = await installHost("claude", ctx);
    expect(installResult.ok).toBe(false);
    expect(installResult.message).toBe(`Could not read ${claudeFile}, fix it or move it aside`);

    const uninstallResult = await uninstallHost("claude", ctx);
    expect(uninstallResult.ok).toBe(false);
    expect(uninstallResult.message).toBe(`Could not read ${claudeFile}, fix it or move it aside`);
  });

  it("refuses to install or uninstall when TOML is malformed", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const grokFile = path.join(home, ".grok", "config.toml");
    await mkdir(path.dirname(grokFile), { recursive: true });
    await writeFile(grokFile, "[ui.status_line]\nmalformed line", "utf8");

    const installResult = await installHost("grok", ctx);
    expect(installResult.ok).toBe(false);
    expect(installResult.message).toBe(`Could not read ${grokFile}, fix it or move it aside`);

    const uninstallResult = await uninstallHost("grok", ctx);
    expect(uninstallResult.ok).toBe(false);
    expect(uninstallResult.message).toBe(`Could not read ${grokFile}, fix it or move it aside`);

    const codexFile = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(codexFile), { recursive: true });
    await writeFile(codexFile, 'unclosed = "string', "utf8");

    const codexInstall = await installHost("codex", ctx);
    expect(codexInstall.ok).toBe(false);
    expect(codexInstall.message).toBe(`Could not read ${codexFile}, fix it or move it aside`);
  });

  it("preserves sibling user keys in Claude and Antigravity JSON settings", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const claudeFile = path.join(home, ".claude", "settings.json");
    await mkdir(path.dirname(claudeFile), { recursive: true });
    await writeFile(claudeFile, JSON.stringify({ theme: "solarized", fontSize: 14 }), "utf8");

    await installHost("claude", ctx);
    const afterClaudeInstall = JSON.parse(await readFile(claudeFile, "utf8")) as Record<string, unknown>;
    expect(afterClaudeInstall["theme"]).toBe("solarized");
    expect(afterClaudeInstall["fontSize"]).toBe(14);
    expect(afterClaudeInstall["openlimiter managed"]).toBe(true);

    await uninstallHost("claude", ctx);
    const afterClaudeUninstall = JSON.parse(await readFile(claudeFile, "utf8")) as Record<string, unknown>;
    expect(afterClaudeUninstall["theme"]).toBe("solarized");
    expect(afterClaudeUninstall["fontSize"]).toBe(14);
    expect(afterClaudeUninstall["statusLine"]).toBeUndefined();
    expect(afterClaudeUninstall["openlimiter managed"]).toBeUndefined();

    const agyFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    await mkdir(path.dirname(agyFile), { recursive: true });
    await writeFile(agyFile, JSON.stringify({ theme: "dark", autoUpdate: false }), "utf8");

    await installHost("antigravity", ctx);
    const afterAgyInstall = JSON.parse(await readFile(agyFile, "utf8")) as Record<string, unknown>;
    expect(afterAgyInstall["theme"]).toBe("dark");
    expect(afterAgyInstall["autoUpdate"]).toBe(false);
    expect(afterAgyInstall["openlimiter managed"]).toBe(true);

    await uninstallHost("antigravity", ctx);
    const afterAgyUninstall = JSON.parse(await readFile(agyFile, "utf8")) as Record<string, unknown>;
    expect(afterAgyUninstall["theme"]).toBe("dark");
    expect(afterAgyUninstall["autoUpdate"]).toBe(false);
    expect(afterAgyUninstall["statusLine"]).toBeUndefined();
    expect(afterAgyUninstall["openlimiter managed"]).toBeUndefined();
  });

  it("preserves sibling user keys in Grok and Codex TOML configs", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const grokFile = path.join(home, ".grok", "config.toml");
    await mkdir(path.dirname(grokFile), { recursive: true });
    await writeFile(
      grokFile,
      ['[ui.status_line]', 'refresh_rate = 10', 'show_icons = true'].join("\n"),
      "utf8"
    );

    await installHost("grok", ctx);
    const afterGrokInstall = await readFile(grokFile, "utf8");
    expect(afterGrokInstall).toContain("refresh_rate = 10");
    expect(afterGrokInstall).toContain("show_icons = true");
    expect(afterGrokInstall).toContain("# openlimiter managed");
    expect(tomlValue(afterGrokInstall, ["ui", "status_line", "command"])).toContain('openlimiter.ps1" statusline --host grok');

    await uninstallHost("grok", ctx);
    const afterGrokUninstall = await readFile(grokFile, "utf8");
    expect(afterGrokUninstall).toContain("[ui.status_line]");
    expect(afterGrokUninstall).toContain("refresh_rate = 10");
    expect(afterGrokUninstall).toContain("show_icons = true");
    expect(afterGrokUninstall).not.toContain("# openlimiter managed");
    expect(afterGrokUninstall).not.toContain("openlimiter statusline");

    const codexFile = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(codexFile), { recursive: true });
    await writeFile(
      codexFile,
      ['[tui]', 'model = "gpt-4"', 'auto_scroll = false'].join("\n"),
      "utf8"
    );

    await installHost("codex", ctx);
    const afterCodexInstall = await readFile(codexFile, "utf8");
    expect(afterCodexInstall).toContain('model = "gpt-4"');
    expect(afterCodexInstall).toContain("auto_scroll = false");
    expect(afterCodexInstall).toContain("# openlimiter managed");
    expect(afterCodexInstall).toContain("status_line = [");

    await uninstallHost("codex", ctx);
    const afterCodexUninstall = await readFile(codexFile, "utf8");
    expect(afterCodexUninstall).toContain("[tui]");
    expect(afterCodexUninstall).toContain('model = "gpt-4"');
    expect(afterCodexUninstall).toContain("auto_scroll = false");
    expect(afterCodexUninstall).not.toContain("# openlimiter managed");
    expect(afterCodexUninstall).not.toContain("status_line = [");
  });
});
