import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACTIVITY_HOOK_EVENTS, changeAgentHook, changeAgentHookFixture, detectAgentInstallation, readAgentHookStatus, type HookInstallOptions } from "../src/hook-installation.js";
import type { AgentId } from "../src/stubs.js";

const roots: string[] = [];
function setup(): HookInstallOptions {
  const homeDirectory = mkdtempSync(path.join(tmpdir(), "openlimiter-lifecycle-"));
  roots.push(homeDirectory);
  const openLimiterScript = path.join(homeDirectory, "openlimiter.js");
  writeFileSync(openLimiterScript, "// fixture executable\n");
  return { homeDirectory, openLimiterScript, nodeExecutable: process.execPath, detectedVersion: "99.0.0" };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("lifecycle hook installers", () => {
  it.each(["muse", "cursor"] as const)("installs and removes %s hooks through a symlinked home", async (agent) => {
    const options = setup();
    const aliases = setup();
    const homeDirectory = path.join(aliases.homeDirectory, "linked-home");
    symlinkSync(options.homeDirectory, homeDirectory, process.platform === "win32" ? "junction" : "dir");
    const linked = { ...options, homeDirectory, openLimiterScript: path.join(homeDirectory, "openlimiter.js") };
    expect(await changeAgentHook(agent, "install", linked)).toMatchObject({ supported: true, changed: true });
    expect(await readAgentHookStatus(agent, linked)).toMatchObject({ installed: true });
    expect(await changeAgentHook(agent, "install", linked)).toMatchObject({ supported: true, changed: false });
    expect(await changeAgentHook(agent, "uninstall", linked)).toMatchObject({ supported: true, changed: true });
    expect(await readAgentHookStatus(agent, linked)).toMatchObject({ installed: false });
  });

  it("accepts a symlinked Muse project root but refuses config and runtime links beneath it", async () => {
    const options = setup();
    const aliases = setup();
    const projectDirectory = path.join(aliases.homeDirectory, "linked-project");
    symlinkSync(options.homeDirectory, projectDirectory, process.platform === "win32" ? "junction" : "dir");
    const linked = { ...options, projectDirectory };
    expect(await changeAgentHook("muse", "install", linked)).toMatchObject({ supported: true, changed: true });
    const config = path.join(projectDirectory, ".muse");
    rmSync(config, { recursive: true });
    const outside = path.join(aliases.homeDirectory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, config, process.platform === "win32" ? "junction" : "dir");
    expect(await changeAgentHook("muse", "install", linked)).toMatchObject({ supported: false, changed: false });
    expect(await readAgentHookStatus("muse", linked)).toMatchObject({ installed: false });
    expect(readdirSync(outside)).toEqual([]);
    rmSync(config, { recursive: true });
    const runtime = path.join(options.homeDirectory, "runtime");
    symlinkSync(outside, runtime, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(path.join(outside, "openlimiter.js"), "// fixture executable\n");
    expect(await changeAgentHook("muse", "install", { ...linked, openLimiterScript: path.join(runtime, "openlimiter.js") })).toMatchObject({ supported: false, changed: false });
    expect(readdirSync(options.homeDirectory)).not.toContain(".muse");
  });

  it("detects an executable through a symlinked PATH root while refusing executable links", async () => {
    const options = setup();
    const aliases = setup();
    const alias = path.join(aliases.homeDirectory, "linked-bin");
    symlinkSync(options.homeDirectory, alias, process.platform === "win32" ? "junction" : "dir");
    const executable = path.join(alias, "codex");
    writeFileSync(executable, "// synthetic version fixture\n");
    const detection = {
      environment: { PATH: alias }, platform: "linux" as const,
      runCommand: async () => ({ ok: true as const, stdout: "codex 1.0.0", stderr: "" })
    };
    expect(await detectAgentInstallation("codex", detection)).toMatchObject({ executable, version: "1.0.0" });
    rmSync(executable);
    symlinkSync(aliases.homeDirectory, executable, process.platform === "win32" ? "junction" : "dir");
    expect(await detectAgentInstallation("codex", detection)).toBeNull();
  });

  it("accepts a plain native Codex binary", async () => {
    const options = setup();
    const executable = path.join(options.homeDirectory, "codex");
    writeFileSync(executable, "native codex fixture\n");
    const detected = await detectAgentInstallation("codex", {
      environment: { PATH: options.homeDirectory },
      platform: "linux",
      runCommand: async (command) => ({
        ok: true as const,
        stdout: command === executable ? "codex 1.2.3" : "",
        stderr: ""
      })
    });
    expect(detected).toMatchObject({ executable, version: "1.2.3" });
  });

  it.runIf(process.platform !== "win32")("resolves the official npm Codex launcher link to its native vendor binary", async () => {
    const options = setup();
    const packageRoot = path.join(options.homeDirectory, "node_modules", "@openai", "codex");
    const launcher = path.join(packageRoot, "bin", "codex.js");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const triple = arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
    const native = path.join(packageRoot, "node_modules", "@openai", `codex-linux-${arch}`, "vendor", triple, "codex", "codex");
    mkdirSync(path.dirname(launcher), { recursive: true });
    mkdirSync(path.dirname(native), { recursive: true });
    writeFileSync(launcher, "official launcher fixture\n");
    writeFileSync(native, "native codex fixture\n");
    const executable = path.join(options.homeDirectory, "codex");
    symlinkSync(launcher, executable);
    const detected = await detectAgentInstallation("codex", {
      environment: { PATH: options.homeDirectory },
      platform: "linux",
      runCommand: async (command) => ({
        ok: true as const,
        stdout: command === native ? "codex 2.3.4" : "",
        stderr: ""
      })
    });
    expect(detected).toMatchObject({ executable: native, version: "2.3.4" });
  });

  it.runIf(process.platform !== "win32")("refuses a Codex executable link to anything other than the official npm launcher", async () => {
    const options = setup();
    const target = path.join(options.homeDirectory, "unrelated-codex");
    writeFileSync(target, "unrelated executable fixture\n");
    symlinkSync(target, path.join(options.homeDirectory, "codex"));
    const runCommand = async () => ({ ok: true as const, stdout: "codex 9.9.9", stderr: "" });
    expect(await detectAgentInstallation("codex", {
      environment: { PATH: options.homeDirectory }, platform: "linux", runCommand
    })).toBeNull();
  });

  it.runIf(process.platform !== "win32")("refuses a Codex launcher under an evilnode_modules suffix lookalike", async () => {
    const options = setup();
    const launcher = path.join(
      options.homeDirectory,
      "evilnode_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js"
    );
    mkdirSync(path.dirname(launcher), { recursive: true });
    writeFileSync(launcher, "lookalike launcher fixture\n");
    symlinkSync(launcher, path.join(options.homeDirectory, "codex"));
    const runCommand = async () => ({ ok: true as const, stdout: "codex 9.9.9", stderr: "" });

    await expect(detectAgentInstallation("codex", {
      ...options,
      runCommand,
      environment: { PATH: options.homeDirectory }
    })).resolves.toBeNull();
  });

  it.each(["claude", "codex", "muse", "gemini", "cursor"] as const)("installs, reinstalls, and removes exactly owned %s lifecycle handlers while preserving edits", async (agent) => {
    const options = setup();
    const install = await changeAgentHookFixture(agent, "install", options);
    expect(install.supported).toBe(true);
    expect(install.changed).toBe(true);
    const configPath = install.configPath!;
    const document = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Object.keys(document.hooks).sort()).toEqual([...ACTIVITY_HOOK_EVENTS[agent]!].sort());
    for (const event of ACTIVITY_HOOK_EVENTS[agent]!) {
      const handlers = agent === "cursor" ? document.hooks[event] : document.hooks[event].flatMap((group: { hooks: unknown[] }) => group.hooks);
      expect(JSON.stringify(handlers)).toContain("openlimiter-activity-v1");
    }
    if (agent === "muse" || agent === "cursor") expect(JSON.stringify(document)).not.toContain("--host-version");
    else expect(JSON.stringify(document)).toContain("--host-version");
    expect(await readAgentHookStatus(agent, options)).toMatchObject({ installed: true });
    expect(await changeAgentHookFixture(agent, "install", options)).toMatchObject({ supported: true, changed: false });
    const first = ACTIVITY_HOOK_EVENTS[agent]![0]!;
    const unrelated = { type: "command", command: "echo unrelated openlimiter-activity-v1" };
    document.hooks[first].push(agent === "cursor" ? unrelated : { matcher: "user-filter", hooks: [unrelated] });
    document.userSetting = { keep: true };
    writeFileSync(configPath, JSON.stringify(document));
    expect(await changeAgentHookFixture(agent, "install", options)).toMatchObject({ supported: true });
    expect(await changeAgentHookFixture(agent, "uninstall", options)).toMatchObject({ supported: true, changed: true });
    const removed = JSON.parse(readFileSync(configPath, "utf8"));
    expect(removed.userSetting).toEqual({ keep: true });
    expect(removed.hooks[first]).toEqual([agent === "cursor" ? unrelated : { matcher: "user-filter", hooks: [unrelated] }]);
    expect(await readAgentHookStatus(agent, options)).toMatchObject({ installed: false });
    expect(await changeAgentHookFixture(agent, "uninstall", options)).toMatchObject({ supported: true, changed: false });
  });

  it.each(["muse", "cursor"] as const)("enables the %s activity installer without fabricating a tested budget version", async (agent) => {
    expect(await changeAgentHook(agent, "install", setup())).toMatchObject({ supported: true, changed: true });
  });

  it("supports Muse project hooks separately from user settings", async () => {
    const options = setup();
    const projectDirectory = path.join(options.homeDirectory, "project");
    mkdirSync(projectDirectory);
    expect(await changeAgentHook("muse", "install", { ...options, projectDirectory })).toMatchObject({
      supported: true, configPath: path.join(projectDirectory, ".muse", "hooks.json")
    });
    expect(await changeAgentHook("muse", "install", options)).toMatchObject({
      supported: true, configPath: path.join(options.homeDirectory, ".config", "muse", "settings.json")
    });
  });

  it.each(["gemini", "antigravity", "grok", "kimi"] as AgentId[])("preserves the production gate for %s", async (agent) => {
    expect(await changeAgentHook(agent, "install", setup())).toMatchObject({ supported: false, changed: false });
  });

  it("preserves an edited activity command and an unrecognized Cursor version", async () => {
    const options = setup();
    const installed = await changeAgentHook("cursor", "install", options);
    const config = installed.configPath!;
    const document = JSON.parse(readFileSync(config, "utf8"));
    document.hooks.stop[0].command += " --user-edit";
    writeFileSync(config, JSON.stringify(document));
    expect(await changeAgentHook("cursor", "uninstall", options)).toMatchObject({ supported: true });
    expect(JSON.parse(readFileSync(config, "utf8")).hooks.stop).toEqual(document.hooks.stop);
    document.version = 42;
    const unknown = JSON.stringify(document);
    writeFileSync(config, unknown);
    expect(await changeAgentHook("cursor", "install", options)).toMatchObject({ supported: false });
    expect(readFileSync(config, "utf8")).toBe(unknown);
  });
});
