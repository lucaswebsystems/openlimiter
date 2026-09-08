import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installHost, uninstallHost, hostStatus, STATUS_NOT_WIRED, validateToml, type TerminalHostContext } from "../src/terminal.js";
import { installLauncher, verifyLauncher } from "../src/terminal-launcher.js";
import { decodeWrappedStatuslineCommand } from "../src/statusline-wrapper.js";
import { editToml, tomlValue } from "../src/terminal-toml.js";
import { runCli } from "../src/index.js";

vi.mock("../src/terminal-launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/terminal-launcher.js")>();
  return { ...actual, installLauncher: (directory: string, source?: string) => actual.installLauncher(directory, source ?? path.resolve("packages/cli")) };
});

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
});

describe("P2 TOML parsing", () => {
  it("02 wraps escaped quotes without truncation and restores exact original bytes", async () => {
    const home = await scratch(), file = await seed(home, "grok");
    const original = '# keep this comment\n[ui.status_line]\ncommand = "echo \\"hi\\""\ntype = "command"\n[other]\nvalues = ["a", "b"]\n';
    await writeFile(file, original);
    expect((await installHost("grok", context(home))).ok).toBe(true);
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
    // Use the actual package layout and dependencies, just as npm's temporary
    // installation does. Copy only shipped code, never user configuration.
    const source = path.join(home, "_npx", "node_modules", "openlimiter");
    await mkdir(source, { recursive: true });
    await cp(path.resolve("packages/cli/dist"), path.join(source, "dist"), { recursive: true });
    await cp(path.resolve("packages/cli/package.json"), path.join(source, "package.json"));
    await cp(path.resolve("packages/cli/node_modules"), path.join(source, "node_modules"), { recursive: true, dereference: true });
    const launcher = await installLauncher(path.join(home, "state"), source);
    await rm(path.join(home, "_npx"), { recursive: true, force: true });
    await expect(verifyLauncher(launcher)).resolves.toBeUndefined();
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
    expect(installed).toContain("$function:global:OpenLimiterOriginalPrompt = $function:prompt");
    expect(installed).toContain("& $function:global:OpenLimiterOriginalPrompt");
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
      expect(rendered.match(/local bar/g)).toHaveLength(1);
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
    expect((await installHost("shell", { ...ctx, environment: { SHELL: "/bin/fish" } })).ok).toBe(false);
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
    expect(await readFile(file, "utf8")).toContain("OpenLimiterOriginalPrompt");
  }, 20_000);
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
