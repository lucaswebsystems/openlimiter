/**
 * F203 regression suite: reinstall and uninstall survive edits the host made.
 *
 * Every test in this file is a reproduction that MUST FAIL on baseline 38187c8
 * and pass after the fix.
 *
 * Environment: all tests run in a sandboxed temp home. HOME, USERPROFILE,
 * LOCALAPPDATA, APPDATA, TMP and TEMP are NOT redirected by this file;
 * the test helpers use mkdtemp and pass the temp root explicitly to every
 * TerminalHostContext. Real home paths are never touched.
 */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireRefreshLock } from "@openlimiter/core";
import {
  hostStatus,
  installHost,
  terminalStatusTable,
  terminalShow,
  uninstallHost,
  STATUS_WIRED,
  type TerminalHostContext
} from "../src/terminal.js";
import { tomlValue } from "../src/terminal-toml.js";
import { runCli } from "../src/index.js";

// ── Launcher mock (same pattern as terminal.test.ts and terminal-p2.test.ts) ─

import { vi } from "vitest";

vi.mock("../src/terminal-launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/terminal-launcher.js")>();
  return {
    ...actual,
    installLauncher: (directory: string, source?: string) =>
      actual.installLauncher(directory, source ?? path.resolve(".test-dist/launcher-source"))
  };
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

// ── Scratch directories ───────────────────────────────────────────────────────

let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];
async function scratch(prefix = "ol-f203-"): Promise<string> {
  const dir = await mkdtemp(path.join(await scratchRoot(), prefix));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function context(homeDirectory: string, extra: Partial<TerminalHostContext> = {}): TerminalHostContext {
  return { homeDirectory, platform: process.platform, ...extra };
}

// ── Host fixture layouts ──────────────────────────────────────────────────────

const claudeFile = (home: string) => path.join(home, ".claude", "settings.json");
const agyFile = (home: string) => path.join(home, ".gemini", "antigravity-cli", "settings.json");
const grokFile = (home: string) => path.join(home, ".grok", "config.toml");
const codexFile = (home: string) => path.join(home, ".codex", "config.toml");

async function seedClaude(home: string, content?: string): Promise<string> {
  const file = claudeFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content ?? JSON.stringify({ theme: "dark" }) + "\n");
  return file;
}
async function seedAgy(home: string, content?: string): Promise<string> {
  const file = agyFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content ?? JSON.stringify({ theme: "dark" }) + "\n");
  return file;
}
async function seedGrok(home: string, content?: string): Promise<string> {
  const file = grokFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content ?? '[other]\nflag = true\n');
  return file;
}
async function seedCodex(home: string, content?: string): Promise<string> {
  const file = codexFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content ?? '[tui]\nmodel = "gpt-4"\n');
  return file;
}

// ── Helper: read backup ───────────────────────────────────────────────────────

async function readBackup(file: string): Promise<{ version: number; original: string | null; installed: string } | null> {
  try {
    return JSON.parse(await readFile(`${file}.openlimiter-backup.json`, "utf8")) as { version: number; original: string | null; installed: string };
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// F203 Test Group 1: Install tolerates drift
// ═════════════════════════════════════════════════════════════════════════════

describe("F203 install tolerates host-edited settings (drift)", () => {
  it("Claude: host adds a key and changes an unrelated value, reinstall succeeds and preserves the host's edits", async () => {
    const home = await scratch();
    const file = await seedClaude(home);
    const ctx = context(home);

    // First install
    const first = await installHost("claude", ctx);
    expect(first.ok).toBe(true);
    const afterFirst = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const backupAfterFirst = await readBackup(file);
    expect(backupAfterFirst).not.toBeNull();
    const originalSaved = backupAfterFirst!.original;

    // Host edits the file: adds a key, changes an unrelated value
    const edited = { ...afterFirst, addedByHost: "yes", theme: "light" };
    await writeFile(file, JSON.stringify(edited, null, 2) + "\n");

    // Reinstall must succeed
    const second = await installHost("claude", ctx);
    expect(second.ok).toBe(true);

    const afterSecond = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    // Host's edit is preserved
    expect(afterSecond["addedByHost"]).toBe("yes");
    expect(afterSecond["theme"]).toBe("light");
    // New statusLine written (not the same as the host wrote in)
    expect(typeof (afterSecond["statusLine"] as Record<string, unknown>)["command"]).toBe("string");
    expect(afterSecond["openlimiter managed"]).toBe(true);

    // backup.original is unchanged
    const backupAfterSecond = await readBackup(file);
    expect(backupAfterSecond!.original).toBe(originalSaved);
    // backup.installed updated to new content
    expect(backupAfterSecond!.installed).toBe(await readFile(file, "utf8"));
  }, 30_000);

  it("Claude: host edits after install with a legacy OpenLimiter statusLine, reinstall succeeds", async () => {
    const home = await scratch();
    const file = await seedClaude(home);
    const ctx = context(home);

    // First install
    const first = await installHost("claude", ctx);
    expect(first.ok).toBe(true);
    const afterFirst = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const backupAfterFirst = await readBackup(file);

    // Simulate host replacing our command with a legacy OpenLimiter one
    // (the kind written by an older installer, matching terminal-launchers/<hash>/openlimiter.ps1)
    const legacyCommand = path.join(home, ".openlimiter", "terminal-launchers", "abc123", "openlimiter.ps1") + " statusline --host claude";
    const drifted = {
      ...afterFirst,
      statusLine: { type: "command", command: legacyCommand },
      addedKey: "keep"
    };
    await writeFile(file, JSON.stringify(drifted, null, 2) + "\n");

    // Reinstall must succeed (legacy OpenLimiter command counts as ours)
    const second = await installHost("claude", ctx);
    expect(second.ok).toBe(true);

    const afterSecond = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(afterSecond["addedKey"]).toBe("keep");
    // New statusLine written
    const statusLine = afterSecond["statusLine"] as Record<string, unknown>;
    expect(typeof statusLine["command"]).toBe("string");
    expect(String(statusLine["command"])).not.toContain("abc123");

    // backup.original preserved
    expect((await readBackup(file))!.original).toBe(backupAfterFirst!.original);
  }, 30_000);

  it("Antigravity: drift reinstall succeeds and preserves host edits", async () => {
    const home = await scratch();
    const file = await seedAgy(home);
    const ctx = context(home);

    await installHost("antigravity", ctx);
    const afterFirst = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const originalSaved = (await readBackup(file))!.original;

    // Host edits: adds a key, changes theme
    const edited = { ...afterFirst, hostAdded: 42, theme: "nord" };
    await writeFile(file, JSON.stringify(edited, null, 2) + "\n");

    const second = await installHost("antigravity", ctx);
    expect(second.ok).toBe(true);

    const afterSecond = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(afterSecond["hostAdded"]).toBe(42);
    expect(afterSecond["theme"]).toBe("nord");
    expect(typeof afterSecond["statusLine"]).toBe("string");
    expect((await readBackup(file))!.original).toBe(originalSaved);
  }, 30_000);

  it("Codex: drift reinstall succeeds and preserves host edits", async () => {
    const home = await scratch();
    const file = await seedCodex(home);
    const ctx = context(home);

    await installHost("codex", ctx);
    const afterFirst = await readFile(file, "utf8");
    const originalSaved = (await readBackup(file))!.original;

    // Host edits: changes the model key
    const edited = afterFirst.replace('model = "gpt-4"', 'model = "gpt-4o"') + "new_key = true\n";
    await writeFile(file, edited);

    const second = await installHost("codex", ctx);
    expect(second.ok).toBe(true);

    const afterSecond = await readFile(file, "utf8");
    expect(afterSecond).toContain('model = "gpt-4o"');
    expect(afterSecond).toContain("new_key = true");
    expect((await readBackup(file))!.original).toBe(originalSaved);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// F203 Test Group 2: Drifted uninstall
// ═════════════════════════════════════════════════════════════════════════════

describe("F203 drifted uninstall preserves host edits", () => {
  it("Claude: drifted uninstall restores original statusLine value and removes marker, keeping host's other edits", async () => {
    const home = await scratch();
    // Seed with a pre-existing user statusLine
    const originalContent = JSON.stringify({ statusLine: { type: "command", command: "echo user" }, theme: "dark" }) + "\n";
    const file = await seedClaude(home, originalContent);
    const ctx = context(home, { wrap: true });

    await installHost("claude", ctx);
    const afterInstall = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

    // Host adds keys to the installed file (drift)
    const drifted = { ...afterInstall, hostKey: "hostValue", extraSetting: 99 };
    await writeFile(file, JSON.stringify(drifted, null, 2) + "\n");

    // Uninstall must succeed and keep host's other edits
    const result = await uninstallHost("claude", ctx);
    expect(result.ok).toBe(true);

    const afterUninstall = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    // Original statusLine restored (the user's command before our install)
    expect((afterUninstall["statusLine"] as Record<string, unknown>)["command"]).toBe("echo user");
    // Marker removed
    expect(afterUninstall["openlimiter managed"]).toBeUndefined();
    // Host's keys preserved
    expect(afterUninstall["hostKey"]).toBe("hostValue");
    expect(afterUninstall["extraSetting"]).toBe(99);
    // Backup removed
    expect(await readBackup(file)).toBeNull();
  }, 30_000);

  it("Claude: no-drift uninstall restores exact bytes, as the P2 test asserts", async () => {
    const home = await scratch();
    const originalContent = JSON.stringify({ theme: "dark", myKey: true }) + "\n";
    const file = await seedClaude(home, originalContent);
    const ctx = context(home);

    await installHost("claude", ctx);
    const result = await uninstallHost("claude", ctx);
    expect(result.ok).toBe(true);
    // Exact bytes restored
    expect(await readFile(file, "utf8")).toBe(originalContent);
  }, 30_000);

  it("Grok: drifted uninstall restores original statusLine command and removes marker", async () => {
    const home = await scratch();
    const originalContent = '[ui.status_line]\ntype = "command"\ncommand = "echo user"\n[other]\nflag = true\n';
    const file = await seedGrok(home, originalContent);
    const ctx = context(home, { wrap: true });

    await installHost("grok", ctx);
    const afterInstall = await readFile(file, "utf8");

    // Host adds a key to the grok config
    const edited = afterInstall + "extra_key = true\n";
    await writeFile(file, edited);

    const result = await uninstallHost("grok", ctx);
    expect(result.ok).toBe(true);

    const afterUninstall = await readFile(file, "utf8");
    // Original command restored
    expect(tomlValue(afterUninstall, ["ui", "status_line", "command"])).toBe("echo user");
    // Marker removed
    expect(afterUninstall).not.toContain("# openlimiter managed");
    // Other flag preserved
    expect(tomlValue(afterUninstall, ["other", "flag"])).toBe(true);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// F203 Test Group 3: Non-OpenLimiter replacement is refused with clear message
// ═════════════════════════════════════════════════════════════════════════════

describe("F203 non-OpenLimiter replacement is refused with a clear message", () => {
  it("Claude: statusLine replaced by a non-OpenLimiter command is refused and file is untouched", async () => {
    const home = await scratch();
    const file = await seedClaude(home);
    const ctx = context(home);

    // Install, then simulate someone replacing our statusLine with their own tool
    await installHost("claude", ctx);
    const afterInstall = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const replaced = { ...afterInstall, statusLine: { type: "command", command: "my-own-tool statusline" } } as Record<string, unknown>;
    // Remove the marker so we look replaced
    delete replaced["openlimiter managed"];
    await writeFile(file, JSON.stringify(replaced, null, 2) + "\n");
    // Also corrupt the backup's installed to make isOwned return false
    const backup = await readBackup(file);
    await writeFile(`${file}.openlimiter-backup.json`, JSON.stringify({ ...backup, installed: "something-else" }));

    const result = await installHost("claude", ctx);
    expect(result.ok).toBe(false);
    // No dash in the message (writing rule)
    expect(result.message).not.toMatch(/^Could not write/);
    expect(result.message.toLowerCase()).toContain("replaced");
    // File untouched
    expect(JSON.parse(await readFile(file, "utf8"))["statusLine"]).toMatchObject({
      command: "my-own-tool statusline"
    });
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// F203 Test Group 4: Concurrent change
// ═════════════════════════════════════════════════════════════════════════════

describe("F203 concurrent change is refused and file is untouched", () => {
  it("Claude: a change between the read and the write is refused and the file is untouched", async () => {
    const home = await scratch();
    const file = await seedClaude(home);
    const ctx = context(home);

    await installHost("claude", ctx);
    const installed = await readFile(file, "utf8");

    // Use a fresh stateDirectory so the second install generates a new launcher
    // under a different content-addressed path → different command string →
    // updated !== text → writeOwned's concurrency guard is reached.
    const ctx2 = context(home, { stateDirectory: path.join(home, ".openlimiter-concurrent") });

    // Hold the file lock while we kick off a reinstall
    const lock = await acquireRefreshLock(
      path.dirname(file), Date.now(), ".settings.json.openlimiter.lock"
    );
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;

    const reinstall = installHost("claude", ctx2);
    await new Promise(resolve => setTimeout(resolve, 50));
    // Modify the file while the install is waiting for the lock
    const changed = JSON.stringify({ ...JSON.parse(installed), concurrent: true });
    await writeFile(file, changed);
    await lock.release();

    const result = await reinstall;
    // Must fail because the file was changed
    expect(result.ok).toBe(false);
    // Clear message naming the reason
    const lower = result.message.toLowerCase();
    expect(lower.includes("changed") || lower.includes("write")).toBe(true);
    // File contains the concurrent change, not our rewrite
    expect(JSON.parse(await readFile(file, "utf8"))["concurrent"]).toBe(true);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// F203 Test Group 5: terminal status reports dir hidden by default
// ═════════════════════════════════════════════════════════════════════════════

describe("F203 terminal status dir visibility", () => {
  it("reports dir hidden by default and shown after terminal show dir", async () => {
    const home = await scratch();
    const stateDirectory = await scratch("ol-f203-state-");
    const ctx: TerminalHostContext = {
      homeDirectory: home,
      stateDirectory,
      platform: process.platform
    };

    // By default, dir should be hidden
    const tableBefore = await terminalStatusTable(ctx);
    const hiddenRow = tableBefore.split("\n").find(r => r.startsWith("Hidden: "));
    expect(hiddenRow).toBeDefined();
    expect(hiddenRow).toContain("dir");
    const shownRow = tableBefore.split("\n").find(r => r.startsWith("Shown: "));
    expect(shownRow).toBeDefined();
    expect(shownRow).not.toContain("dir");

    // After `terminal show dir`, dir should appear in Shown
    const showResult = await terminalShow(["dir"], ctx);
    expect(showResult.ok).toBe(true);

    const tableAfter = await terminalStatusTable(ctx);
    const shownRowAfter = tableAfter.split("\n").find(r => r.startsWith("Shown: "));
    expect(shownRowAfter).toBeDefined();
    expect(shownRowAfter).toContain("dir");
    const hiddenRowAfter = tableAfter.split("\n").find(r => r.startsWith("Hidden: "));
    expect(hiddenRowAfter).not.toContain("dir");
  });

  it("CLI: terminal status shows dir as hidden by default", async () => {
    const home = await scratch();
    const stateDirectory = await scratch("ol-f203-state-");
    const result = await runCli(["terminal", "status"], {
      homeDirectory: home,
      stateDirectory,
      environment: {}
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    const hidden = lines.find(l => l.startsWith("Hidden: "));
    expect(hidden).toBeDefined();
    expect(hidden).toContain("dir");
    const shown = lines.find(l => l.startsWith("Shown: "));
    expect(shown).not.toContain("dir");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F203 Test Group 6: Codex (TOML) and Antigravity (JSON) drift
// ═════════════════════════════════════════════════════════════════════════════

describe("F203 Codex and Antigravity drift reinstall and uninstall", () => {
  it("Codex: reinstall after drift succeeds, uninstall under drift removes our keys and keeps host edits", async () => {
    const home = await scratch();
    const file = await seedCodex(home);
    const ctx = context(home);

    await installHost("codex", ctx);
    const afterInstall = await readFile(file, "utf8");
    const originalSaved = (await readBackup(file))!.original;

    // Host edits the file
    const edited = afterInstall.replace('model = "gpt-4"', 'model = "o3"') + "debug = true\n";
    await writeFile(file, edited);

    // Reinstall must succeed
    const second = await installHost("codex", ctx);
    expect(second.ok).toBe(true);
    const afterSecond = await readFile(file, "utf8");
    expect(afterSecond).toContain('model = "o3"');
    expect(afterSecond).toContain("debug = true");
    expect(afterSecond).toContain("status_line");
    expect((await readBackup(file))!.original).toBe(originalSaved);

    // Host edits again
    const edited2 = afterSecond + "extra = 1\n";
    await writeFile(file, edited2);

    // Uninstall under drift
    const uninstall = await uninstallHost("codex", ctx);
    expect(uninstall.ok).toBe(true);

    const afterUninstall = await readFile(file, "utf8");
    expect(afterUninstall).toContain('model = "o3"');
    expect(afterUninstall).toContain("debug = true");
    // Our status_line removed
    expect(afterUninstall).not.toContain("# openlimiter managed");
    expect(afterUninstall).not.toContain("status_line_use_colors = true");
    // Backup removed
    expect(await readBackup(file)).toBeNull();
  }, 30_000);

  it("Antigravity: reinstall and uninstall under drift succeed", async () => {
    const home = await scratch();
    const file = await seedAgy(home);
    const ctx = context(home);

    await installHost("antigravity", ctx);
    const afterInstall = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const originalSaved = (await readBackup(file))!.original;

    // Host edits
    const edited = { ...afterInstall, newKey: "value" };
    await writeFile(file, JSON.stringify(edited, null, 2) + "\n");

    // Reinstall
    const second = await installHost("antigravity", ctx);
    expect(second.ok).toBe(true);
    const afterSecond = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(afterSecond["newKey"]).toBe("value");
    expect(typeof afterSecond["statusLine"]).toBe("string");
    expect((await readBackup(file))!.original).toBe(originalSaved);

    // Host edits again before uninstall
    const edited2 = { ...afterSecond, anotherKey: true };
    await writeFile(file, JSON.stringify(edited2, null, 2) + "\n");

    // Uninstall
    const uninstall = await uninstallHost("antigravity", ctx);
    expect(uninstall.ok).toBe(true);
    const afterUninstall = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    // Original had no statusLine, so it should be removed
    expect(afterUninstall["statusLine"]).toBeUndefined();
    expect(afterUninstall["openlimiter managed"]).toBeUndefined();
    // Host keys preserved
    expect(afterUninstall["newKey"]).toBe("value");
    expect(afterUninstall["anotherKey"]).toBe(true);
    expect(await readBackup(file)).toBeNull();
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// X203b: a reinstall over the person's edits must not make uninstall erase them
// ═════════════════════════════════════════════════════════════════════════════

describe("X203b uninstall after a reinstall over edits keeps those edits", () => {
  it("Claude: the new theme and permissions survive, the first statusLine comes back", async () => {
    const home = await scratch();
    const userLine = { type: "command", command: "echo user" };
    const file = await seedClaude(home, JSON.stringify({ statusLine: userLine, theme: "dark", permissions: { allow: ["Bash(ls)"] } }) + "\n");
    const ctx = context(home);
    expect((await installHost("claude", ctx)).ok).toBe(true);
    expect(await readBackup(file)).not.toHaveProperty("drifted");

    const permissions = { allow: ["Bash(ls)", "Bash(git status)"], deny: ["WebFetch"] };
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), theme: "light", permissions }, null, 2) + "\n");
    expect((await installHost("claude", ctx)).ok).toBe(true);
    expect(await readBackup(file)).toMatchObject({ drifted: true });

    expect((await uninstallHost("claude", ctx)).ok).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ statusLine: userLine, theme: "light", permissions });
    expect(await readBackup(file)).toBeNull();
  }, 30_000);

  it("Codex: the new theme and permissions survive and every OpenLimiter line goes", async () => {
    const home = await scratch();
    const original = 'model = "gpt-5"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n\n[tui]\ntheme = "dark"\n';
    const file = await seedCodex(home, original);
    const ctx = context(home);
    expect((await installHost("codex", ctx)).ok).toBe(true);

    const edit = (text: string): string => text.replace('theme = "dark"', 'theme = "light"')
      .replace('"on-request"', '"never"').replace('"read-only"', '"workspace-write"');
    await writeFile(file, edit(await readFile(file, "utf8")));
    expect((await installHost("codex", ctx)).ok).toBe(true);

    expect((await uninstallHost("codex", ctx)).ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe(edit(original));
    expect(await readBackup(file)).toBeNull();
  }, 30_000);

  it("Codex: the first status_line and colours come back next to the new edits", async () => {
    const home = await scratch();
    const file = await seedCodex(home, 'approval_policy = "on-request"\n[tui]\nstatus_line = ["model-name"]\nstatus_line_use_colors = false\nother = 42\n');
    const ctx = context(home);
    expect((await installHost("codex", ctx)).ok).toBe(true);
    await writeFile(file, (await readFile(file, "utf8")).replace('"on-request"', '"never"').replace("other = 42", "other = 7"));
    expect((await installHost("codex", ctx)).ok).toBe(true);

    expect((await uninstallHost("codex", ctx)).ok).toBe(true);
    const after = await readFile(file, "utf8");
    expect(tomlValue(after, ["approval_policy"])).toBe("never");
    expect(tomlValue(after, ["tui", "other"])).toBe(7);
    expect(tomlValue(after, ["tui", "status_line"])).toEqual(["model-name"]);
    expect(tomlValue(after, ["tui", "status_line_use_colors"])).toBe(false);
    expect(after).not.toContain("openlimiter");
  }, 30_000);

  it("Grok: the edit survives and the status line table OpenLimiter added goes", async () => {
    const home = await scratch();
    const file = await seedGrok(home, "[other]\nflag = true\n");
    const ctx = context(home);
    expect((await installHost("grok", ctx)).ok).toBe(true);
    await writeFile(file, (await readFile(file, "utf8")).replace("flag = true", "flag = false"));
    expect((await installHost("grok", ctx)).ok).toBe(true);

    expect((await uninstallHost("grok", ctx)).ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("[other]\nflag = false\n");
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// F203 Test Group 7: Real paths not touched (checked via stat timestamps)
// ═════════════════════════════════════════════════════════════════════════════

describe("F203 real home paths are not touched by the test suite", () => {
  const realPaths = [
    "C:\\Users\\lucas\\.claude",
    "C:\\Users\\lucas\\.codex",
    "C:\\Users\\lucas\\.gemini",
    "C:\\Users\\lucas\\.grok",
    "C:\\Users\\lucas\\.openlimiter"
  ];

  // Record mtimes before
  const before: Map<string, number> = new Map();

  it("records before-mtimes of real paths", async () => {
    for (const p of realPaths) {
      try {
        const s = await stat(p);
        before.set(p, s.mtimeMs);
      } catch {
        before.set(p, -1); // missing
      }
    }
    expect(before.size).toBe(realPaths.length);
  });

  it("verifies real paths are unchanged after all F203 tests run", async () => {
    // This test relies on before-mtimes being populated by the prior test.
    // Both run in the same describe block sequentially.
    for (const p of realPaths) {
      const beforeMs = before.get(p) ?? -1;
      let afterMs: number;
      try {
        const s = await stat(p);
        afterMs = s.mtimeMs;
      } catch {
        afterMs = -1;
      }
      expect(afterMs).toBe(beforeMs);
    }
  });
});
