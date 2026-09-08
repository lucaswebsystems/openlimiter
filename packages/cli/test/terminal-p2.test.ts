import { cp, link, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireRefreshLock } from "@openlimiter/core";
import { installHost, uninstallHost, hostStatus, STATUS_NOT_WIRED, STATUS_WIRED, validateToml, type TerminalHostContext } from "../src/terminal.js";
import { installLauncher, launcherCommand, RUNTIME_STAMP_FILE_NAME, verifyLauncher } from "../src/terminal-launcher.js";
import { decodeWrappedStatuslineCommand, encodeWrappedStatuslineCommand } from "../src/statusline-wrapper.js";
import { editToml, tomlValue } from "../src/terminal-toml.js";
import { runCli } from "../src/index.js";

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

const roots: string[] = [];
async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openlimiter-p2-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
function context(homeDirectory: string, environment: Record<string, string> = {}): TerminalHostContext {
  return { homeDirectory, platform: process.platform, environment };
}

async function executeThroughShell(command: string): Promise<number | null> {
  const executable = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `${command} --help`]
    : ["-c", `${command} --help`];
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", resolve);
  });
}
const layouts = {
  claude: { file: [".claude", "settings.json"], original: '{\n "statusLine": {"type":"command","command":"echo hi","padding":4,"refreshInterval":9}, "theme":"dark"\n}\n' },
  antigravity: { file: [".gemini", "antigravity-cli", "settings.json"], original: '{"statusLine":{"type":"command","command":"echo hi","padding":3},"theme":"dark"}\n' },
  grok: { file: [".grok", "config.toml"], original: '[ui.status_line]\ntype = "command"\ncommand = "echo hi"\nrefresh_rate = 9\n[other]\nflag = true\n' },
  codex: { file: [".codex", "config.toml"], original: '[tui]\nstatus_line = ["model-name"]\nstatus_line_use_colors = false\nother = 42\n' }
};
async function seed(home: string, host: keyof typeof layouts): Promise<string> {
  const fixture = layouts[host];
  const file = path.join(home, ...fixture.file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, fixture.original);
  return file;
}

describe("P2 ownership and full backups", () => {
  for (const host of Object.keys(layouts) as (keyof typeof layouts)[]) {
    it(`03 leaves unmanaged ${host} settings byte identical`, async () => {
      const home = await scratch(), file = await seed(home, host);
      expect((await uninstallHost(host, context(home))).ok).toBe(true);
      expect(await readFile(file, "utf8")).toBe(layouts[host].original);
    });
    it(`03 restores every original ${host} setting and preserves the first backup on reinstall`, async () => {
      const home = await scratch(), file = await seed(home, host);
      expect((await installHost(host, context(home))).ok).toBe(true);
      const backup = await readFile(file + ".openlimiter-backup.json", "utf8");
      expect(JSON.parse(backup).original).toBe(layouts[host].original);
      expect((await installHost(host, context(home))).ok).toBe(true);
      expect(await readFile(file + ".openlimiter-backup.json", "utf8")).toBe(backup);
      expect((await uninstallHost(host, context(home))).ok).toBe(true);
      expect(await readFile(file, "utf8")).toBe(layouts[host].original);
    }, 20_000);
    it(`03 refuses to remove changed ${host} values even with its marker`, async () => {
      const home = await scratch(), file = await seed(home, host);
      expect((await installHost(host, context(home))).ok).toBe(true);
      const installed = await readFile(file, "utf8");
      const changed = host === "claude" || host === "antigravity"
        ? JSON.stringify({ ...JSON.parse(installed), statusLine: "echo replacement" })
        : installed.replace(host === "grok" ? 'type = "command"' : 'status_line_use_colors = true', host === "grok" ? 'type = "custom"' : 'status_line_use_colors = false');
      await writeFile(file, changed);
      await uninstallHost(host, context(home));
      expect(await readFile(file, "utf8")).toBe(changed);
      expect((await installHost(host, context(home))).ok).toBe(false);
      expect(JSON.parse(await readFile(file + ".openlimiter-backup.json", "utf8")).original).toBe(layouts[host].original);
    }, 20_000);
  }

  it("refuses a restore when the file changes before the locked reread", async () => {
    const home = await scratch();
    const file = await seed(home, "claude");
    const ctx = context(home);
    expect((await installHost("claude", ctx)).ok).toBe(true);
    const installed = await readFile(file, "utf8");
    const lock = await acquireRefreshLock(path.dirname(file), Date.now(), ".settings.json.openlimiter.lock");
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;
    const uninstall = uninstallHost("claude", ctx);
    await new Promise(resolve => setTimeout(resolve, 50));
    const changed = JSON.stringify({ ...JSON.parse(installed), userEdit: true });
    await writeFile(file, changed);
    await lock.release();
    const result = await uninstall;
    expect(result.ok).toBe(false);
    expect(result.message).toContain(await realpath(file));
    expect(await readFile(file, "utf8")).toBe(changed);
  }, 30_000);
});

describe("D18 borrowed status lines", () => {
  it.each(["claude", "antigravity", "grok"] as const)("runs the original from the installed %s launcher after its entire runtime disappears", async host => {
    const home = await scratch(), file = await seed(home, host);
    const ctx = context(home);
    expect((await installHost(host, ctx)).ok).toBe(true);
    const installed = await readFile(file, "utf8");
    const data = host === "grok" ? null : JSON.parse(installed);
    const command = host === "grok" ? tomlValue(installed, ["ui", "status_line", "command"]) as string
      : host === "claude" ? data.statusLine.command as string : data.statusLine as string;
    await rm(path.join(home, ".openlimiter", "terminal-runtime"), { recursive: true, force: true });
    const output = await open(path.join(home, "stdout"), "w");
    const error = await open(path.join(home, "stderr"), "w");
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = process.platform === "win32"
          ? spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], { stdio: ["ignore", output.fd, error.fd], windowsHide: true, windowsVerbatimArguments: true })
          : spawn("/bin/sh", ["-c", command], { stdio: ["ignore", output.fd, error.fd] });
        child.once("error", reject); child.once("close", resolve);
      });
      expect(code).toBe(0);
    } finally { await output.close(); await error.close(); }
    expect(await readFile(path.join(home, "stdout"), "utf8")).toBe(process.platform === "win32" ? "hi\r\n" : "hi\n");
    expect(await readFile(path.join(home, "stderr"), "utf8")).toBe("");
  }, 30_000);

  it.each(["claude", "antigravity", "grok"] as const)("overrides %s by default, keeps the first command through mode changes and restores its exact bytes", async host => {
    const home = await scratch(), file = await seed(home, host);
    const ctx = context(home);
    const first = await installHost(host, ctx);
    expect(first.ok).toBe(true);
    expect(first.message).toContain(`openlimiter terminal uninstall ${host} restores it`);
    expect(first.message).toContain("previous");
    const installed = await readFile(file, "utf8");
    expect(installed).not.toContain(" --wrap ");
    expect(installed).not.toContain("echo hi");
    expect(JSON.parse(await readFile(file + ".openlimiter-backup.json", "utf8")).original).toBe(layouts[host].original);
    expect((await installHost(host, ctx)).message).not.toContain("previous");
    expect((await installHost(host, { ...ctx, wrap: true })).ok).toBe(true);
    const wrapped = await readFile(file, "utf8");
    expect(wrapped).toContain(` --wrap ${encodeWrappedStatuslineCommand("echo hi")}`);
    expect((await installHost(host, ctx)).ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe(installed);
    expect((await uninstallHost(host, ctx)).ok).toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from(layouts[host].original));
  }, 30_000);

  it.each(Object.keys(layouts) as (keyof typeof layouts)[])("refuses changed %s settings even when the marker was removed", async host => {
    const home = await scratch(), file = await seed(home, host);
    expect((await installHost(host, context(home))).ok).toBe(true);
    await writeFile(file, layouts[host].original);
    const result = await uninstallHost(host, context(home));
    expect(result.ok).toBe(false);
    expect(result.message.split("\n")).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe(layouts[host].original);
  }, 30_000);

  it.each(["all", "--yes"])("passes the explicit wrap flag through install and restores all hosts through dispatch with %s", async all => {
    const home = await scratch();
    for (const host of Object.keys(layouts) as (keyof typeof layouts)[]) await seed(home, host);
    const profile = path.join(home, "profile.ps1");
    const original = 'function prompt { "my bars> " }\r\n# keep final bytes';
    await writeFile(profile, original);
    const deps = {
      homeDirectory: home, platform: "win32" as const,
      environment: { SHELL: "powershell.exe" },
      windowsCredentialRunner: async () => ({ ok: true as const, stdout: profile })
    };
    expect((await runCli(["terminal", "--yes", "--wrap"], deps)).exitCode).toBe(0);
    expect(await readFile(path.join(home, ...layouts.claude.file), "utf8")).toContain(" --wrap ");
    expect((await runCli(["terminal", "install", "claude"], deps)).exitCode).toBe(0);
    expect(await readFile(path.join(home, ...layouts.claude.file), "utf8")).not.toContain(" --wrap ");
    expect((await runCli(["terminal", "install", "claude", "--wrap"], deps)).exitCode).toBe(0);
    expect(await readFile(path.join(home, ...layouts.claude.file), "utf8")).toContain(" --wrap ");
    expect((await runCli(["terminal", "uninstall", all], deps)).exitCode).toBe(0);
    for (const host of Object.keys(layouts) as (keyof typeof layouts)[]) {
      expect(await readFile(path.join(home, ...layouts[host].file))).toEqual(Buffer.from(layouts[host].original));
    }
    expect(await readFile(profile)).toEqual(Buffer.from(original));
  }, 30_000);
});

describe("P2 TOML parsing", () => {
  it("02 wraps escaped quotes without truncation and restores exact original bytes", async () => {
    const home = await scratch(), file = await seed(home, "grok");
    const original = '# keep this comment\n[ui.status_line]\ncommand = "echo \\"hi\\""\ntype = "command"\n[other]\nvalues = ["a", "b"]\n';
    await writeFile(file, original);
    expect((await installHost("grok", { ...context(home), wrap: true })).ok).toBe(true);
    const updated = await readFile(file, "utf8");
    expect(validateToml(updated)).toBe(true);
    const command = tomlValue(updated, ["ui", "status_line", "command"]) as string;
    expect(decodeWrappedStatuslineCommand(command.split(" --wrap ")[1]!)).toBe('echo "hi"');
    expect(tomlValue(updated, ["other", "values"])).toEqual(["a", "b"]);
    await uninstallHost("grok", context(home));
    expect(await readFile(file, "utf8")).toBe(original);
  }, 20_000);
  it("02 handles literal and multiline strings, quoted keys, arrays and inline tables", () => {
    const text = `["ui".'status_line']\ncommand = '''echo "hi"\nnext'''\nkeep = {nested = [1, {yes = true}]}\n[other]\nx = """\\\n  words \\"quoted\\"\nmore"""\n`;
    const updated = editToml(text, ["ui", "status_line"], { command: 'echo "safe"', type: "command" });
    expect(tomlValue(updated, ["ui", "status_line", "command"])).toBe('echo "safe"');
    expect(updated).toContain("keep = {nested = [1, {yes = true}]}");
    expect(validateToml(updated)).toBe(true);
  });
  it.each(['key = nope', 'key = 01', 'key = "\\q"', 'key = 1\nkey = 2', '[tui]\n[tui]', 'x = 1\n[x]\na = 2', 'a = { x = 1, x = 2 }', 'd = 2026-02-30', 'a.b = 1\n[[a]]', '# invalid\u0000'])
    ("02 refuses invalid complete documents: %s", text => expect(validateToml(text)).toBe(false));
});

describe("P2 durable runtime", () => {
  it("10 executes after the temporary npx source disappears with an empty PATH", async () => {
    const home = await scratch();
    // Use the compiled test build and its package manifests, just as npm's
    // temporary installation does. Copy only shipped code, never user configuration.
    const source = path.join(home, "_npx", "node_modules", "openlimiter");
    await cp(compiledLauncherSource, source, { recursive: true, dereference: true });
    const launcher = await installLauncher(path.join(home, "state"), source);
    await rm(path.join(home, "_npx"), { recursive: true, force: true });
    await expect(verifyLauncher(launcher)).resolves.toBeUndefined();
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(launcher.node, [launcher.entry, "--help"], {
        env: { PATH: "", SystemRoot: process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? "", HOME: path.dirname(launcher.entry), USERPROFILE: path.dirname(launcher.entry) },
        cwd: path.dirname(launcher.entry), stdio: "ignore", windowsHide: true
      });
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(exitCode).toBe(0);
    expect(launcher.entry).not.toContain("_npx");
  }, 30_000);
  it("10 reports failure and leaves host settings intact if a launcher cannot be installed", async () => {
    const home = await scratch(), file = await seed(home, "claude");
    const state = path.join(home, "blocked");
    await writeFile(state, "not a directory");
    expect((await installHost("claude", { ...context(home), stateDirectory: state })).ok).toBe(false);
    expect(await readFile(file, "utf8")).toBe(layouts.claude.original);
  });
});

describe("P2 launcher trust and migration", () => {
  it("replaces a runtime with an old version stamp", async () => {
    const home = await scratch();
    const state = path.join(home, "state");
    const launcher = await installLauncher(state, compiledLauncherSource);
    await writeFile(path.join(state, "terminal-runtime", RUNTIME_STAMP_FILE_NAME), JSON.stringify({ version: "0.0.0", files: {} }));
    await installLauncher(state, compiledLauncherSource);
    const stamp = JSON.parse(await readFile(path.join(state, "terminal-runtime", RUNTIME_STAMP_FILE_NAME), "utf8")) as { version: string };
    const source = JSON.parse(await readFile(path.join(compiledLauncherSource, "package.json"), "utf8")) as { version: string };
    expect(stamp.version).toBe(source.version);
    await expect(verifyLauncher(launcher)).resolves.toBeUndefined();
  }, 30_000);

  it("restores a missing shipped runtime file", async () => {
    const home = await scratch();
    const state = path.join(home, "state");
    const launcher = await installLauncher(state, compiledLauncherSource);
    const missing = path.join(state, "terminal-runtime", "node_modules", "openlimiter", "dist", "bin.js");
    await rm(missing);
    await installLauncher(state, compiledLauncherSource);
    await expect(readFile(missing, "utf8")).resolves.toContain("runCli");
    await expect(verifyLauncher(launcher)).resolves.toBeUndefined();
  }, 30_000);

  it("leaves a runtime with a matching stamp in place", async () => {
    const home = await scratch();
    const state = path.join(home, "state");
    await installLauncher(state, compiledLauncherSource);
    const runtime = path.join(state, "terminal-runtime");
    const before = await stat(runtime);
    const stampBefore = await readFile(path.join(runtime, RUNTIME_STAMP_FILE_NAME), "utf8");
    await installLauncher(state, compiledLauncherSource);
    expect((await stat(runtime)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path.join(runtime, RUNTIME_STAMP_FILE_NAME), "utf8")).toBe(stampBefore);
  }, 30_000);

  it("replaces a foreign runtime entry even when it exits successfully", async () => {
    const home = await scratch();
    const state = path.join(home, "state");
    const runtime = path.join(state, "terminal-runtime");
    const node = path.join(runtime, process.platform === "win32" ? "node.exe" : "node");
    await mkdir(runtime, { recursive: true });
    try { await link(process.execPath, node); } catch { await cp(process.execPath, node); }
    await writeFile(path.join(runtime, "openlimiter.cjs"), 'process.stdout.write("foreign");\n');

    const launcher = await installLauncher(state, compiledLauncherSource);
    await expect(verifyLauncher(launcher)).resolves.toBeUndefined();
    expect(await readFile(launcher.entry, "utf8")).not.toBe('process.stdout.write("foreign");\n');
  }, 30_000);

  it("refuses a symbolic link at the runtime target", async () => {
    const home = await scratch();
    const state = path.join(home, "state");
    const target = path.join(home, "runtime target");
    await mkdir(target, { recursive: true });
    await mkdir(state, { recursive: true });
    await symlink(target, path.join(state, "terminal-runtime"), process.platform === "win32" ? "junction" : "dir");
    await expect(installLauncher(state, compiledLauncherSource)).rejects.toThrow("Invalid launcher");
  });

  it("writes the current runtime path after the state directory moves", async () => {
    const home = await scratch();
    const firstState = path.join(home, "first state");
    const secondState = path.join(home, "second state");
    const ctx = { ...context(home), stateDirectory: firstState };
    await expect(installHost("claude", ctx)).resolves.toMatchObject({ ok: true });
    const file = path.join(home, ".claude", "settings.json");
    const first = JSON.parse(await readFile(file, "utf8")) as { statusLine: { command: string } };
    await expect(installHost("claude", { ...ctx, stateDirectory: secondState })).resolves.toMatchObject({ ok: true });
    const second = JSON.parse(await readFile(file, "utf8")) as { statusLine: { command: string } };
    expect(second.statusLine.command).not.toBe(first.statusLine.command);
    expect(second.statusLine.command).toContain(path.join(secondState, "terminal-launchers"));
  }, 30_000);

  it("migrates a legacy OpenLimiter command without wrapping it", async () => {
    const home = await scratch();
    const file = await seed(home, "claude");
    await writeFile(file, JSON.stringify({ statusLine: { type: "command", command: "openlimiter statusline --host claude" } }));
    await expect(installHost("claude", context(home))).resolves.toMatchObject({ ok: true });
    const command = (JSON.parse(await readFile(file, "utf8")) as { statusLine: { command: string } }).statusLine.command;
    expect(command.match(/\s--wrap\s/g) ?? []).toHaveLength(0);
    expect(await hostStatus("claude", context(home))).toBe(STATUS_WIRED);
  }, 30_000);

  it("unwraps a legacy wrapper and wraps the real user command once", async () => {
    const home = await scratch();
    const file = await seed(home, "claude");
    const userCommand = "echo user status";
    const legacy = `openlimiter statusline --host claude --wrap ${encodeWrappedStatuslineCommand(userCommand)}`;
    await writeFile(file, JSON.stringify({ statusLine: { type: "command", command: legacy } }));
    await expect(installHost("claude", { ...context(home), wrap: true })).resolves.toMatchObject({ ok: true });
    const command = (JSON.parse(await readFile(file, "utf8")) as { statusLine: { command: string } }).statusLine.command;
    const encoded = command.match(/\s--wrap\s+([A-Za-z0-9_-]+)/)?.[1];
    expect(encoded).toBeDefined();
    expect(decodeWrappedStatuslineCommand(encoded!)).toBe(userCommand);
    expect(command.match(/\s--wrap\s/g) ?? []).toHaveLength(1);
  }, 30_000);
});

describe("P2 TOML and configuration roots", () => {
  it.each(["claude", "codex"] as const)("uses the canonical default %s root through a home alias", async host => {
    const home = await scratch();
    const target = path.join(home, "real home");
    const alias = path.join(home, "home alias");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    const file = await seed(target, host);
    const ctx = context(alias);
    expect((await uninstallHost(host, ctx)).ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe(layouts[host].original);
    expect((await installHost(host, ctx)).ok).toBe(true);
    expect(await hostStatus(host, ctx)).toBe(STATUS_WIRED);
    expect((await uninstallHost(host, ctx)).ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe(layouts[host].original);
  }, 30_000);

  it.each(["claude", "codex"] as const)("installs a missing default %s root through a home alias", async host => {
    const home = await scratch();
    const target = path.join(home, "real home");
    const alias = path.join(home, "home alias");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    const ctx = context(alias);
    expect((await installHost(host, ctx)).ok).toBe(true);
    expect(await hostStatus(host, ctx)).toBe(STATUS_WIRED);
    expect((await uninstallHost(host, ctx)).ok).toBe(true);
    await expect(readFile(path.join(target, ...layouts[host].file))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it.each(["claude", "codex"] as const)("refuses a %s configuration link that escapes the canonical root", async host => {
    const home = await scratch();
    const outside = path.join(home, "outside");
    const file = await seed(home, host);
    const protectedFile = process.platform === "win32" ? path.join(outside, "original") : outside;
    if (process.platform === "win32") await mkdir(outside);
    await writeFile(protectedFile, layouts[host].original);
    await rm(file);
    // Junctions exercise Windows redirection without requiring Developer Mode.
    // POSIX uses a file symlink. Both must fail the root boundary check before IO.
    await symlink(outside, file, process.platform === "win32" ? "junction" : "file");
    const variable = host === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    const refusal = { ok: false, message: `${variable} must point to a file under its root.` };
    expect(await installHost(host, context(home))).toEqual(refusal);
    expect(await uninstallHost(host, context(home))).toEqual(refusal);
    expect(await readFile(protectedFile, "utf8")).toBe(layouts[host].original);
  });

  it.each([
    "tui.status_line = [\"model-name\"]\n",
    "tui = { status_line = [\"model-name\"], other = \"keep\" }\n",
    "[tui]\nstatus_line = [\"model-name\"]\n"
  ])("edits an existing Codex tui representation without a duplicate table: %s", original => {
    const updated = editToml(original, ["tui"], { status_line: ["openlimiter"], status_line_use_colors: true });
    expect(validateToml(updated)).toBe(true);
    expect(tomlValue(updated, ["tui", "status_line"])).toEqual(["openlimiter"]);
    expect(tomlValue(updated, ["tui", "status_line_use_colors"])).toBe(true);
    expect((updated.match(/^\[tui\]$/gmu) ?? [])).toHaveLength(original.startsWith("[tui]") ? 1 : 0);
  });

  it("accepts a UTF eight byte order mark and preserves it through an edit", () => {
    const original = `\ufeff[ui.status_line]\ncommand = "echo hi"\n`;
    const updated = editToml(original, ["ui", "status_line"], { command: "echo safe", type: "command" });
    expect(validateToml(updated)).toBe(true);
    expect(updated.charCodeAt(0)).toBe(0xfeff);
    expect(tomlValue(updated, ["ui", "status_line", "command"])).toBe("echo safe");
  });

  it("rejects a relative configuration override", async () => {
    const home = await scratch();
    const result = await installHost("claude", context(home, { CLAUDE_CONFIG_DIR: "relative config" }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("CLAUDE_CONFIG_DIR");
    expect(result.message).toContain("absolute");
  });

  it("follows a configuration root symlink to its canonical target", async () => {
    const home = await scratch();
    const target = path.join(home, "real config café");
    const link = path.join(home, "config alias");
    const file = path.join(target, "settings.json");
    await mkdir(target, { recursive: true });
    await writeFile(file, JSON.stringify({ statusLine: { type: "command", command: "echo user" } }));
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const result = await installHost("claude", context(home, { CLAUDE_CONFIG_DIR: link }));
    expect(result.ok).toBe(true);
    const stored = JSON.parse(await readFile(file, "utf8")) as { statusLine: { command: string } };
    expect(stored.statusLine.command).not.toContain(" --wrap ");
    expect(await readFile(path.join(link, "settings.json"), "utf8")).toBe(await readFile(file, "utf8"));
  }, 30_000);

  it("executes a launcher command through a path with spaces and non ASCII text", async () => {
    const home = await scratch();
    const state = path.join(home, "state with spaces café");
    const launcher = await installLauncher(state, compiledLauncherSource);
    expect(await executeThroughShell(launcherCommand(launcher, process.platform === "win32" ? "powershell" : "posix"))).toBe(0);
  }, 30_000);
});

describe("P2 shell profiles", () => {
  it.each(["bash", "zsh"])("11 installs in %s and preserves the existing prompt and profile", async shell => {
    const home = await scratch();
    const ctx = { ...context(home, { SHELL: `/bin/${shell}`, ZDOTDIR: path.join(home, "zsh") }), platform: "linux" as const };
    const file = shell === "bash" ? path.join(home, ".bashrc") : path.join(home, "zsh", ".zshrc");
    const original = shell === "bash" ? 'PS1="custom> "\nPROMPT_COMMAND="echo prior"\n' : 'PROMPT="custom> "\nprecmd() { echo prior; }\n';
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, original);
    expect((await installHost("shell", ctx)).ok).toBe(true);
    const installed = await readFile(file, "utf8");
    expect(installed.startsWith(original)).toBe(true);
    expect(installed).toContain(shell === "bash" ? "PROMPT_COMMAND+=" : "add-zsh-hook precmd");
    expect(installed).not.toContain("function prompt");
    await writeFile(file, installed + "\n# later user edit\n");
    expect((await uninstallHost("shell", ctx)).ok).toBe(false);
    expect(await readFile(file, "utf8")).toBe(installed + "\n# later user edit\n");
    await writeFile(file, installed);
    await uninstallHost("shell", ctx);
    expect(await readFile(file, "utf8")).toBe(original);
  }, 20_000);
  it("11 preserves the PowerShell prompt script and avoids wrapping it twice", async () => {
    const home = await scratch(), file = path.join(home, "profile.ps1");
    const original = 'function prompt { "custom> " }\n';
    await writeFile(file, original);
    const ctx = { ...context(home, { SHELL: "powershell.exe" }), platform: "win32" as const, shellRunner: async () => ({ ok: true as const, stdout: file }) };
    expect((await installHost("shell", ctx)).ok).toBe(true);
    const installed = await readFile(file, "utf8");
    expect(installed.startsWith(original)).toBe(true);
    expect((await installHost("shell", ctx)).ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe(installed);
    if (process.platform === "win32") {
      // Execute the generated wrapper twice with a local bar. Real statusline
      // acquisition is deliberately excluded from this offline prompt test.
      const script = path.join(home, "check.ps1"), output = path.join(home, "output.txt");
      const offline = installed.replace(/\$bar = .* statusline --host shell/, '$bar = "local bar"');
      await writeFile(script, offline + "\n" + offline + '\nWrite-Output (prompt)\n');
      const handle = await open(output, "w");
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(path.join(process.env["SystemRoot"] ?? process.env["SYSTEMROOT"]!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
            { stdio: ["ignore", handle.fd, handle.fd], windowsHide: true });
          child.once("error", reject); child.once("close", resolve);
        });
        expect(code).toBe(0);
      } finally { await handle.close(); }
      const rendered = await readFile(output, "utf8");
      expect(rendered).toContain("custom> ");
      expect(rendered).toContain("local bar");
    }
    await uninstallHost("shell", ctx);
    expect(await readFile(file, "utf8")).toBe(original);
  }, 20_000);
  it("11 reports profile write failures and unsupported shells without a success status", async () => {
    const home = await scratch();
    await mkdir(path.join(home, ".bashrc"));
    const ctx = { ...context(home, { SHELL: "/bin/bash" }), platform: "linux" as const };
    expect((await installHost("shell", ctx)).ok).toBe(false);
    expect(await hostStatus("shell", ctx)).toBe(STATUS_NOT_WIRED);
    const skipped = await installHost("shell", { ...ctx, environment: { SHELL: "/bin/fish" } });
    expect(skipped.ok).toBe(true);
    expect(skipped.message).toContain("fish");
    await expect(readFile(path.join(home, ".openlimiter", "shell-snippet.txt"), "utf8")).resolves.toContain("statusline");
  });
  it("11 resolves the actual Windows shell through npm ancestors instead of COMSPEC", async () => {
    const home = await scratch(), file = path.join(home, "PowerShell", "profile.ps1");
    const calls: string[] = [];
    const ctx: TerminalHostContext = {
      ...context(home, { COMSPEC: "cmd.exe" }), platform: "win32",
      shellRunner: async (executable, args) => {
        calls.push(executable);
        return { ok: true, stdout: args.at(-1) === "$PROFILE" ? file : "pwsh.exe" };
      }
    };
    expect((await installHost("shell", ctx)).ok).toBe(true);
    expect(calls).toEqual(["powershell.exe", "pwsh.exe"]);
    expect(await hostStatus("shell", ctx)).toBe(STATUS_WIRED);
    await uninstallHost("shell", ctx);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});

describe("P2 all host installation", () => {
  it("skips fish with a manual snippet while installing the other hosts", async () => {
    const home = await scratch();
    const result = await runCli(["terminal", "--yes"], {
      homeDirectory: home,
      platform: "linux",
      environment: { SHELL: "/usr/bin/fish" }
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shell: Skipped fish shell.");
    expect(result.stdout).toContain(path.join(home, ".openlimiter", "shell-snippet.txt"));
    const status = await runCli(["terminal", "status"], {
      homeDirectory: home,
      platform: "linux",
      environment: { SHELL: "/usr/bin/fish" }
    });
    for (const host of ["Claude", "Antigravity", "Grok", "Codex"]) {
      expect(status.stdout).toContain(`${host}: Wired`);
    }
  }, 30_000);
});

describe("P2 configuration overrides", () => {
  it.each(["claude", "codex"] as const)("12 uses the active %s directory for install, status and uninstall through dispatch", async host => {
    const home = await scratch(), inactive = await seed(home, host);
    const directory = path.join(home, "active config");
    const environment = host === "claude" ? { CLAUDE_CONFIG_DIR: directory } : { CODEX_HOME: directory };
    const deps = { homeDirectory: home, environment, platform: process.platform };
    expect((await runCli(["terminal", "install", host], deps)).exitCode).toBe(0);
    const active = path.join(directory, host === "claude" ? "settings.json" : "config.toml");
    expect(await readFile(active, "utf8")).toContain("openlimiter managed");
    expect(await readFile(inactive, "utf8")).toBe(layouts[host].original);
    expect((await runCli(["terminal", "status"], deps)).stdout).toContain(host === "claude" ? "Claude: Wired" : "Codex: Wired");
    expect((await runCli(["terminal", "uninstall", host], deps)).exitCode).toBe(0);
    await expect(readFile(active)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(inactive, "utf8")).toBe(layouts[host].original);
  }, 20_000);
});
