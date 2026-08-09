import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIXTURE_NOW,
  antigravityFixture,
  claudeFixture,
  codexFixture,
  manualFixture,
  opencodeFixture,
  openrouterFixture
} from "@openlimiter/connectors";
import {
  CONFIG_FILE_NAME,
  OperatingSystemCredentialStore,
  runCli,
  type CredentialStore
} from "../src/index.js";

class MemoryCredentialStore implements CredentialStore {
  value: string | null = null;

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(_service: string, _account: string, secret: string): Promise<void> {
    this.value = secret;
  }
}

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openlimiter-cli-test-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const payloads = {
  claude: claudeFixture,
  openrouter: openrouterFixture,
  codex: codexFixture,
  antigravity: antigravityFixture,
  opencode: opencodeFixture,
  manual: manualFixture
} as const;

describe("CLI", () => {
  it("initializes every connector as enabled and stores only the prompted key", async () => {
    const directory = await temporaryDirectory();
    const store = new MemoryCredentialStore();
    let prompts = 0;
    const result = await runCli(["init"], {
      stateDirectory: directory,
      environment: { OPENLIMITER_OPENROUTER_CREDENTIAL: "available" },
      credentialStore: store,
      promptForSecret: async () => {
        prompts += 1;
        return "sk-DEMO-000";
      },
      now: () => FIXTURE_NOW
    });
    expect(result.exitCode).toBe(0);
    expect(prompts).toBe(1);
    expect(store.value).toBe("sk-DEMO-000");
    const configText = await readFile(path.join(directory, CONFIG_FILE_NAME), "utf8");
    const config = JSON.parse(configText) as {
      connectors: { enabled: boolean }[];
    };
    expect(config.connectors).toHaveLength(6);
    expect(config.connectors.every((connector) => connector.enabled)).toBe(true);
    expect(configText.includes("sk-DEMO-000")).toBe(false);
  });

  it("refreshes only from supplied payloads and writes a bounded cache", async () => {
    const directory = await temporaryDirectory();
    const result = await runCli(["snapshot", "--refresh"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      payloads
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CLAUDE FIVE_HOUR 42.00PERCENT");
    expect(result.stdout).toContain("OPENROUTER CREDITS 37.00PERCENT");
    expect(result.stdout.includes("demo@example.test")).toBe(false);
  });

  it("renders statusline and identical dry run hook output from cache", async () => {
    const directory = await temporaryDirectory();
    await runCli(["snapshot", "--refresh"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      payloads
    });
    const statusline = await runCli(["statusline"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    });
    expect(statusline.stdout).toContain("OpenLimiter HEALTHY");
    const hook = await runCli(["hook"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    });
    const dry = await runCli(["hook", "--dry-run"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    });
    expect(dry.stdout).toBe(hook.stdout);
    expect(hook.stdout).toContain("<openlimiter_untrusted_data>");
    expect(hook.stdout.includes("demo@example.test")).toBe(false);
  });

  it("returns safe empty output when cache input is unavailable", async () => {
    const directory = await temporaryDirectory();
    expect((await runCli(["hook"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    }))).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await runCli(["statusline"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    })).stdout).toBe("OpenLimiter UNKNOWN");
    expect((await runCli(["snapshot"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    })).stdout).toBe("No bounded quota data is available.");
  });

  it("keeps doctor output redacted and marks drift", async () => {
    const directory = await temporaryDirectory();
    const result = await runCli(["doctor"], {
      stateDirectory: directory,
      environment: {
        OPENLIMITER_OPENROUTER_CREDENTIAL: "available",
        SYNTHETIC_SECRET: "sk-DEMO-000"
      },
      now: () => FIXTURE_NOW
    });
    expect(result.stdout).toContain("openrouter yes unknown UNVERIFIED");
    expect(result.stdout.includes("sk-DEMO-000")).toBe(false);
  });

  it("renders demo fixtures without writing cache and exports canonical JSON", async () => {
    const directory = await temporaryDirectory();
    const demo = await runCli(["demo"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    });
    expect(demo.stdout).toContain("MANUAL MONTHLY 35.00PERCENT");
    const emptyExport = await runCli(["export"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    });
    expect(emptyExport.stdout).toBe("[]");
    await runCli(["snapshot", "--refresh"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      payloads
    });
    const populatedExport = await runCli(["export"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    });
    expect(Array.isArray(JSON.parse(populatedExport.stdout))).toBe(true);
  });

  it("fails open on an unsafe state path", async () => {
    const parent = await temporaryDirectory();
    const file = path.join(parent, "not-a-directory");
    await writeFile(file, "synthetic", "utf8");
    expect(await runCli(["hook"], {
      stateDirectory: file,
      now: () => FIXTURE_NOW
    })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});

describe("credential adapter", () => {
  it("delegates only to the injected operating system driver", async () => {
    let stored = "";
    const adapter = new OperatingSystemCredentialStore({
      async getPassword() {
        return stored === "" ? null : stored;
      },
      async setPassword(_service, _account, secret) {
        stored = secret;
      }
    });
    expect(await adapter.get("openlimiter", "openrouter")).toBeNull();
    await adapter.set("openlimiter", "openrouter", "sk-DEMO-000");
    expect(await adapter.get("openlimiter", "openrouter")).toBe("sk-DEMO-000");
  });
});
