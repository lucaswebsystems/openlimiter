import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";

vi.mock("../src/terminal-launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/terminal-launcher.js")>();
  return { ...actual, installLauncher: async (directory: string) => ({ node: process.execPath, entry: path.join(directory, "test-launcher.cjs") }) };
});

const NOW = "2026-09-07T12:00:00.000Z";
const ENV = { PATH: "", Path: "", SHELL: "/bin/bash", OPENLIMITER_SUPABASE_ANON_KEY: "sb_publishable_test_key" };
const roots: string[] = [];
async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "openlimiter-setup-shell-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function deps(homeDirectory: string, stateDirectory: string): Promise<CliDependencies> {
  return {
    stateDirectory, homeDirectory,
    platform: "linux", environment: ENV, now: () => NOW,
    promptChoice: async () => "s", promptForSecret: async () => "", payloads: {},
    colorOutput: false, readStandardInput: async () => null,
    nodeExecutable: process.execPath, openLimiterScript: "test-cli.js",
    spawnDetached: () => undefined, emit: () => undefined, sleep: async () => undefined,
    openBrowser: () => undefined,
    detectedAgentInstallations: {},
    credentialStore: { get: async () => null, set: async () => undefined },
    acquisitionTransport: async () => ({ status: 404, body: "{}", retryAfterSeconds: null }),
    hubTransport: async () => ({ status: 503, body: "" }),
    codexDeviceLoginRunnerFactory: () => ({ start: async () => { throw new Error("Unexpected login"); } }),
  };
}

function extractManaged(text: string): string {
  const match = text.match(/# openlimiter managed\n[\s\S]*?\n# end openlimiter managed/);
  return match ? match[0] : "";
}

describe("setup rewrites an owned shell hook", () => {
  it("rewrites a managed block left by an older version", async () => {
    const root = await scratch();
    const homeDirectory = path.join(root, "home");
    const stateDirectory = path.join(root, "state");
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });

    const { installHost } = await import("../src/terminal.js");
    const context = { homeDirectory, platform: "linux", environment: ENV, stateDirectory };
    await installHost("shell", context as never);

    const profile = path.join(homeDirectory, ".bashrc");
    const backupFile = profile + ".openlimiter-backup.json";
    const original = await readFile(profile, "utf8");
    const expectedBlock = extractManaged(original);
    const backup = JSON.parse(await readFile(backupFile, "utf8"));

    // Simulate an older, unedited owned hook: change the managed block and keep
    // the backup in sync so ownership still holds.
    const older = original.replace("PROMPT_COMMAND", "PROMPT_COMMAND_OLD");
    await writeFile(profile, older);
    await writeFile(backupFile, JSON.stringify({ ...backup, installed: older }));

    const result = await runCli(["setup"], { ...(await deps(homeDirectory, stateDirectory)), emit: () => undefined });
    expect(result.exitCode).toBe(0);

    const after = await readFile(profile, "utf8");
    expect(extractManaged(after)).toBe(expectedBlock);
  });

  it("leaves an edited profile alone", async () => {
    const root = await scratch();
    const homeDirectory = path.join(root, "home");
    const stateDirectory = path.join(root, "state");
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });

    const { installHost } = await import("../src/terminal.js");
    const context = { homeDirectory, platform: "linux", environment: ENV, stateDirectory };
    await installHost("shell", context as never);

    const profile = path.join(homeDirectory, ".bashrc");
    const before = (await readFile(profile, "utf8")) + "\n# user edit\n";
    await writeFile(profile, before);

    const result = await runCli(["setup"], { ...(await deps(homeDirectory, stateDirectory)), emit: () => undefined });
    expect(result.exitCode).toBe(0);

    const after = await readFile(profile, "utf8");
    expect(after).toBe(before);
  });
});
