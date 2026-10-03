import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserOpenInvocation, runCli } from "../src/cli.js";
import { REVOKED_SENTENCE } from "../src/hub-auth.js";
import type { HubReply, HubRequest, HubTransport } from "../src/hub.js";
import { SESSION_FILE_NAME, readSession, writeSession, type HubSession } from "../src/session.js";
import type { DeviceLoginChild, DeviceLoginRunner } from "../src/codex-device-login.js";

const CONFIGURED = { OPENLIMITER_SUPABASE_ANON_KEY: "sb_publishable_test_key" };
const NOW = "2026-09-07T12:00:00.000Z";

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

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [encode({ alg: "none" }), encode(claims), "signature"].join(".");
}

const START_BODY = JSON.stringify({
  user_code: "ABCD-1234",
  device_code: "device-code-0001",
  verification_url: "https://openlimiter.com/device",
  interval: 1,
  expires_in: 30
});

function approvedBody(): string {
  return JSON.stringify({
    status: "approved",
    token: jwt({ email: "person@example.com" }),
    expires_at: "2026-09-07T14:00:00.000Z",
    refresh_credential: "r".repeat(32),
    refresh_expires_at: "2026-10-07T12:00:00.000Z",
    device_id: "device-1234"
  });
}

function scriptedTransport(script: readonly HubReply[]): { transport: HubTransport; sent: HubRequest[] } {
  const sent: HubRequest[] = [];
  let index = 0;
  return {
    sent,
    transport: async (request) => {
      sent.push(request);
      const action = (JSON.parse(request.body) as { action?: string }).action;
      if (action === "ack") return { status: 200, body: JSON.stringify({ status: "consumed" }) };
      const reply = script[Math.min(index, script.length - 1)];
      index += 1;
      if (reply === undefined) throw new Error("no scripted reply");
      return reply;
    }
  };
}

function session(overrides: Partial<HubSession> = {}): HubSession {
  return {
    version: 1,
    token: "t".repeat(32),
    expiresAt: "2026-09-07T20:00:00.000Z",
    refreshCredential: "r".repeat(32),
    refreshExpiresAt: "2026-10-07T12:00:00.000Z",
    deviceId: "device-1234",
    accountLabel: "person@example.com",
    ...overrides
  };
}

const noSleep = async (): Promise<void> => undefined;

describe("openlimiter login", () => {
  it("passes a valid URL as one argument to the absolute Windows opener", () => {
    const url = "https://openlimiter.com/device";
    const invocation = browserOpenInvocation(url, "win32", {
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\fixture\\cmd.exe"
    });
    expect(invocation).toEqual({
      executable: "C:\\Windows\\System32\\rundll32.exe",
      arguments: ["url.dll,FileProtocolHandler", url],
      cwd: "C:\\Windows\\System32"
    });
    expect(path.win32.isAbsolute(invocation?.executable ?? "")).toBe(true);
    expect(invocation?.executable.toLowerCase()).not.toContain("cmd.exe");
    expect(invocation?.cwd).not.toBe(process.cwd());
  });

  it("signs in and writes a session file mode appropriate for the platform", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: approvedBody() }
    ]);
    const emitted: string[] = [];
    const result = await runCli(["login"], {
      stateDirectory,
      environment: CONFIGURED,
      hubTransport: transport,
      sleep: noSleep,
      emit: (line) => emitted.push(line),
      now: () => NOW,
      platform: "linux"
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("person@example.com");
    expect(emitted.some((line) => line.includes("ABCD-1234"))).toBe(true);
    const stored = await readSession(stateDirectory);
    expect(stored?.accountLabel).toBe("person@example.com");
  });

  it("opens the browser only with --open", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: approvedBody() }
    ]);
    let opened: string | null = null;
    await runCli(["login", "--open"], {
      stateDirectory,
      environment: CONFIGURED,
      hubTransport: transport,
      sleep: noSleep,
      openBrowser: (url) => {
        opened = url;
      },
      now: () => NOW,
      platform: "linux"
    });
    expect(opened).toBe("https://openlimiter.com/device");
  });

  it("fails with a usage exit code when denied", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: JSON.stringify({ status: "denied" }) }
    ]);
    const result = await runCli(["login"], {
      stateDirectory,
      environment: CONFIGURED,
      hubTransport: transport,
      sleep: noSleep,
      now: () => NOW,
      platform: "linux"
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("denied");
    expect(await readSession(stateDirectory)).toBeNull();
  });
});

describe("openlimiter logout and whoami", () => {
  it("whoami fails plainly when nobody is signed in", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const result = await runCli(["whoami"], { stateDirectory });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not signed in");
    expect(result.stdout).toBe("");
  });

  it.each(["person@example.com", "Personal account"])("whoami identifies account %s before the labelled device", async (accountLabel) => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    await writeSession(session({ accountLabel }), { directory: stateDirectory, platform: "linux" });
    const result = await runCli(["whoami"], { stateDirectory });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split(/\r?\n/)).toEqual([
      "Account: " + accountLabel,
      "Device: device-1234"
    ]);
    expect(result.stderr).toBe("");
  });

  it("logout deletes the session file", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    await writeSession(session(), { directory: stateDirectory, platform: "linux" });
    const result = await runCli(["logout"], { stateDirectory });
    expect(result.exitCode).toBe(0);
    expect(await readSession(stateDirectory)).toBeNull();
  });
});

describe("openlimiter sync", () => {
  it("refuses to sync when nobody is signed in", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const result = await runCli(["sync"], { stateDirectory, environment: CONFIGURED });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not signed in");
  });

  it("prints nothing to sync yet when the cache is empty", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    await writeSession(session(), { directory: stateDirectory, platform: "linux" });
    const result = await runCli(["sync"], {
      stateDirectory,
      environment: CONFIGURED,
      hubTransport: async () => {
        throw new Error("must not be called with nothing to sync");
      },
      now: () => NOW
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nothing to sync");
  });

  it("clears the session and prints the hub sentence on a revoked epoch", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    await writeSession(session({ expiresAt: "2020-01-01T00:00:00.000Z" }), {
      directory: stateDirectory,
      platform: "linux"
    });
    const result = await runCli(["sync"], {
      stateDirectory,
      environment: CONFIGURED,
      hubTransport: async () => ({ status: 401, body: "" }),
      now: () => NOW
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(REVOKED_SENTENCE);
    expect(await readSession(stateDirectory)).toBeNull();
  });
});

describe("openlimiter setup, the three step first run", () => {
  function noAgentsInstalled(): Record<string, string> {
    /* An empty PATH means detectAgentInstallation finds nothing on this
       machine, whatever is really installed on the box running the suite. */
    return { PATH: "", Path: "" };
  }

  it("runs bare with no arguments, and setup is the same command", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const homeDirectory = await temporaryDirectory("openlimiter-hub-home-");
    const bare = await runCli([], {
      stateDirectory,
      homeDirectory,
      environment: noAgentsInstalled(),
      platform: "linux",
      now: () => NOW
    });
    const named = await runCli(["setup"], {
      stateDirectory: await temporaryDirectory("openlimiter-hub-"),
      homeDirectory,
      environment: noAgentsInstalled(),
      platform: "linux",
      now: () => NOW
    });
    expect(bare.exitCode).toBe(0);
    expect(named.exitCode).toBe(0);
    expect(bare.stdout).toContain("1. Sign in");
    expect(bare.stdout).toContain("2. Connect");
    expect(bare.stdout).toContain("3. Show bars in");
  });

  it("asks once before enabling Claude in an interactive terminal", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const homeDirectory = await temporaryDirectory("openlimiter-hub-home-");
    let questions = 0;
    await runCli(["setup"], {
      stateDirectory,
      homeDirectory,
      environment: noAgentsInstalled(),
      platform: "linux",
      now: () => NOW,
      interactive: true,
      promptChoice: async (question) => {
        if (question.includes("Show Fable limit")) questions += 1;
        return question.includes("Show Fable limit") ? "" : "s";
      }
    });
    expect(questions).toBe(1);
    expect((await runCli(["config", "get", "providers.claude.poll"], { stateDirectory })).stdout)
      .toBe("providers.claude.poll=true");
    await runCli(["setup"], {
      stateDirectory,
      homeDirectory,
      environment: noAgentsInstalled(),
      platform: "linux",
      now: () => NOW,
      interactive: true,
      promptChoice: async (question) => {
        if (question.includes("Show Fable limit")) questions += 1;
        return "s";
      }
    });
    expect(questions).toBe(1);
  });

  it("records Claude polling off when setup is unattended", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    await runCli(["setup"], {
      stateDirectory,
      homeDirectory: await temporaryDirectory("openlimiter-hub-home-"),
      environment: noAgentsInstalled(),
      platform: "linux",
      now: () => NOW,
      interactive: false,
      promptChoice: async () => { throw new Error("unattended setup must not prompt"); }
    });
    expect((await runCli(["config", "get", "providers.claude.poll"], { stateDirectory })).stdout)
      .toBe("providers.claude.poll=false");
  });

  it("skips signing in when the hub is switched off, and still shows the checklist", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const homeDirectory = await temporaryDirectory("openlimiter-hub-home-");
    const result = await runCli([], {
      stateDirectory,
      homeDirectory,
      environment: { ...noAgentsInstalled(), OPENLIMITER_SUPABASE_ANON_KEY: "off" },
      platform: "linux",
      now: () => NOW
    });
    expect(result.stdout).toContain("Skipped: the hub is not configured");
    expect(await readSession(stateDirectory)).toBeNull();
  });

  it("says already signed in when a session already exists, and never opens a login", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const homeDirectory = await temporaryDirectory("openlimiter-hub-home-");
    await writeSession(session(), { directory: stateDirectory, platform: "linux" });
    const result = await runCli([], {
      stateDirectory,
      homeDirectory,
      environment: { ...CONFIGURED, ...noAgentsInstalled() },
      platform: "linux",
      now: () => NOW,
      hubTransport: async () => {
        throw new Error("must not sign in again");
      }
    });
    expect(result.stdout).toContain("Already signed in as person@example.com.");
  });

  it("signs in when accepted, through Enter, and skips when told S", async () => {
    const homeDirectory = await temporaryDirectory("openlimiter-hub-home-");

    const acceptedDirectory = await temporaryDirectory("openlimiter-hub-");
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: approvedBody() }
    ]);
    const accepted = await runCli([], {
      stateDirectory: acceptedDirectory,
      homeDirectory,
      environment: { ...CONFIGURED, ...noAgentsInstalled() },
      platform: "linux",
      now: () => NOW,
      hubTransport: transport,
      sleep: noSleep,
      promptChoice: async () => ""
    });
    expect(accepted.stdout).toContain("Signed in as person@example.com.");
    expect(await readSession(acceptedDirectory)).not.toBeNull();

    const skippedDirectory = await temporaryDirectory("openlimiter-hub-");
    const skipped = await runCli([], {
      stateDirectory: skippedDirectory,
      homeDirectory,
      environment: { ...CONFIGURED, ...noAgentsInstalled() },
      platform: "linux",
      now: () => NOW,
      hubTransport: async () => {
        throw new Error("must not sign in when skipped");
      },
      promptChoice: async () => "s"
    });
    expect(skipped.stdout).toContain("Skipped.");
    expect(await readSession(skippedDirectory)).toBeNull();
  });

  it("labels every agent row when nothing is installed, and never spawns Codex", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-hub-");
    const homeDirectory = await temporaryDirectory("openlimiter-hub-home-");
    let spawned = false;
    const runnerFactory = (): DeviceLoginRunner => ({
      start: async () => {
        spawned = true;
        throw new Error("must not spawn Codex with nothing installed");
      }
    });
    const result = await runCli([], {
      stateDirectory,
      homeDirectory,
      environment: noAgentsInstalled(),
      platform: "linux",
      now: () => NOW,
      sleep: noSleep,
      promptChoice: async () => "",
      codexDeviceLoginRunnerFactory: runnerFactory
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("claude: install");
    expect(result.stdout).toContain("codex: install");
    /* Grok and Kimi are D5's untested device login candidates: not a plain
       install nudge, since a device style sign in would work if installed. */
    expect(result.stdout).toContain("grok: verified on install");
    expect(result.stdout).toContain("kimi: verified on install");
    expect(spawned).toBe(false);
  });
});
