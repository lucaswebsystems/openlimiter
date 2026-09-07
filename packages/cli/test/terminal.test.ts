import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECT_FIRST_SENTENCE,
  STATUS_NOT_WIRED,
  STATUS_OWN_LINE_FOUND,
  STATUS_WIRED,
  TERMINAL_HOST_NAMES,
  UNSUPPORTED_HOST_ALTERNATIVE,
  hostStatus,
  installHost,
  terminalHide,
  terminalShow,
  terminalStatusTable,
  uninstallHost,
  validateToml,
  type TerminalHostContext
} from "../src/terminal.js";
import { CONFIG_FILE_NAME, runCli } from "../src/index.js";

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
    await rm(directory, { recursive: true, force: true });
  }
});

async function context(homeDirectory: string): Promise<TerminalHostContext> {
  return {
    homeDirectory,
    platform: "win32"
  };
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
    expect(afterInstall.statusLine.command).toBe("openlimiter statusline --host claude");

    /* Installing a second time must not wrap its own command around itself. */
    const installedAgain = await installHost("claude", ctx);
    expect(installedAgain.ok).toBe(true);
    const afterSecondInstall = JSON.parse(await readFile(settingsFile, "utf8")) as {
      statusLine: { command: string };
    };
    expect(afterSecondInstall.statusLine.command).toBe("openlimiter statusline --host claude");

    const uninstalled = await uninstallHost("claude", ctx);
    expect(uninstalled.ok).toBe(true);
    expect(await hostStatus("claude", ctx)).toBe(STATUS_NOT_WIRED);
    const afterUninstall = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
    expect(afterUninstall["statusLine"]).toBeUndefined();
  });

  it("wraps and restores an existing Claude status line through --wrap", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
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
    expect(wrapped.statusLine.command).toContain("openlimiter statusline --host claude --wrap ");
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
    const settingsFile = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ statusLine: "their-own-line" }), "utf8");
    expect(await hostStatus("antigravity", ctx)).toBe(STATUS_OWN_LINE_FOUND);

    await installHost("antigravity", ctx);
    const wrapped = JSON.parse(await readFile(settingsFile, "utf8")) as { statusLine: string };
    expect(wrapped.statusLine).toContain("openlimiter statusline --host antigravity --wrap ");

    await installHost("antigravity", ctx);
    const wrappedAgain = JSON.parse(await readFile(settingsFile, "utf8")) as { statusLine: string };
    expect(wrappedAgain.statusLine).toBe(wrapped.statusLine);

    await uninstallHost("antigravity", ctx);
    const restored = JSON.parse(await readFile(settingsFile, "utf8")) as { statusLine: string };
    expect(restored.statusLine).toBe("their-own-line");
  });

  it("round trips Grok's [ui.status_line] table, including wrap and restore", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
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
    expect(wrapped).toContain('command = "openlimiter statusline --host grok --wrap ');
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
       somebody else's, and install wraps around it rather than claiming
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
    expect(installed.message).toContain("openlimiter statusline --host shell");
    expect(await hostStatus("shell", ctx)).toBe(STATUS_WIRED);

    const installedAgain = await installHost("shell", ctx);
    expect(installedAgain.ok).toBe(true);

    const uninstalled = await uninstallHost("shell", ctx);
    expect(uninstalled.ok).toBe(true);
    expect(await hostStatus("shell", ctx)).toBe(STATUS_NOT_WIRED);
  });

  it("resolves the shell profile by asking pwsh first, never a hardcoded Documents path", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const resolvedProfile = path.join(home, "asked-pwsh-profile.ps1");
    const calls: string[] = [];
    const ctx: TerminalHostContext = {
      homeDirectory: home,
      platform: "win32",
      shellRunner: async (executable) => {
        calls.push(executable);
        if (executable === "pwsh.exe") return { ok: true, stdout: resolvedProfile + "\r\n" };
        return { ok: false };
      }
    };
    const installed = await installHost("shell", ctx);
    expect(installed.ok).toBe(true);
    expect(calls).toEqual(["pwsh.exe"]);
    const written = await readFile(resolvedProfile, "utf8");
    expect(written).toContain("openlimiter statusline");
    expect(await hostStatus("shell", ctx)).toBe(STATUS_WIRED);
  });

  it("falls back to powershell.exe when pwsh cannot answer, and to the hardcoded guess when neither can", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const resolvedProfile = path.join(home, "asked-powershell-profile.ps1");
    const ctxWithPowershell: TerminalHostContext = {
      homeDirectory: home,
      platform: "win32",
      shellRunner: async (executable) => {
        if (executable === "powershell.exe") return { ok: true, stdout: resolvedProfile };
        return { ok: false };
      }
    };
    await installHost("shell", ctxWithPowershell);
    expect(await readFile(resolvedProfile, "utf8")).toContain("openlimiter statusline");

    const ctxWithNeither: TerminalHostContext = {
      homeDirectory: home,
      platform: "win32",
      shellRunner: async () => ({ ok: false })
    };
    const installed = await installHost("shell", ctxWithNeither);
    expect(installed.ok).toBe(true);
    /* Neither shell answered: the same hardcoded default this build always
       used, not an error. */
    expect(await hostStatus("shell", ctxWithNeither)).toBe(STATUS_WIRED);
    const fallbackPath = path.join(
      home,
      "Documents",
      "WindowsPowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
    expect(await readFile(fallbackPath, "utf8")).toContain("openlimiter statusline");
  });

  it("lists every host in the status table, one row each", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const ctx = await context(home);
    const table = await terminalStatusTable(ctx);
    const rows = table.split("\n");
    expect(rows).toHaveLength(8);
    expect(rows).toContain("Claude: " + STATUS_NOT_WIRED);
    expect(rows).toContain("Gemini: " + UNSUPPORTED_HOST_ALTERNATIVE);
  });
});

describe("terminal show and hide", () => {
  it("refuses a provider with no login or key on this machine", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const stateDirectory = await temporaryDirectory("openlimiter-terminal-state-");
    const ctx: TerminalHostContext = {
      homeDirectory: home,
      stateDirectory,
      platform: "win32",
      detectedProviders: []
    };
    const result = await terminalShow(["claude"], ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(CONNECT_FIRST_SENTENCE);
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
    expect(result.stdout.split("\n")).toHaveLength(8);
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
    const result = await runCli(["terminal", "--yes"], { homeDirectory: home });
    expect(result.exitCode).toBe(0);
    const status = await runCli(["terminal", "status"], { homeDirectory: home });
    for (const host of ["Claude", "Antigravity", "Grok", "Codex", "Shell"]) {
      expect(status.stdout).toContain(host + ": " + STATUS_WIRED);
    }
  });

  it("--host wires exactly the one host it names", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const result = await runCli(["terminal", "--host", "grok"], { homeDirectory: home });
    expect(result.exitCode).toBe(0);
    const status = await runCli(["terminal", "status"], { homeDirectory: home });
    expect(status.stdout).toContain("Grok: " + STATUS_WIRED);
    expect(status.stdout).toContain("Claude: " + STATUS_NOT_WIRED);
  });

  it("show refuses an unconnected provider through the CLI, and succeeds once connected", async () => {
    const home = await temporaryDirectory("openlimiter-terminal-");
    const stateDirectory = await temporaryDirectory("openlimiter-terminal-state-");
    const refused = await runCli(["terminal", "show", "claude"], {
      homeDirectory: home,
      stateDirectory,
      environment: {}
    });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain(CONNECT_FIRST_SENTENCE);

    const allowed = await runCli(["terminal", "show", "claude"], {
      homeDirectory: home,
      stateDirectory,
      environment: { CLAUDE_CODE_STATUSLINE: "1" }
    });
    expect(allowed.exitCode).toBe(0);
    const stored = JSON.parse(
      await readFile(path.join(stateDirectory, CONFIG_FILE_NAME), "utf8")
    ) as { statusline: { show: string[] } };
    expect(stored.statusline.show).toEqual(["claude"]);

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

  it("hide rejects unrecognized or unconnected provider ids", async () => {
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
    expect(direct.message).toBe(CONNECT_FIRST_SENTENCE);

    const cli = await runCli(["terminal", "hide", "unconnected"], {
      homeDirectory: home,
      stateDirectory,
      environment: {}
    });
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr).toContain(CONNECT_FIRST_SENTENCE);
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
    expect(afterGrokInstall).toContain('command = "openlimiter statusline --host grok"');

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
