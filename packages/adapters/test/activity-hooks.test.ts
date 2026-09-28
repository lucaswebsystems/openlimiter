import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACTIVITY_HOOK_EVENTS, changeAgentHook, changeAgentHookFixture, readAgentHookStatus, type HookInstallOptions } from "../src/hook-installation.js";
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
