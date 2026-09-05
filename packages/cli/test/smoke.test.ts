import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIXTURE_NOW, claudeFixture } from "@openlimiter/connectors";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVIDENCE_DIRECTORY_ENVIRONMENT,
  LIVE_ENVIRONMENT_FLAG,
  PAYLOAD_ENVIRONMENT_PREFIX,
  SKIPPED_NOTE,
  collectSmoke,
  containsSecret,
  evidenceDay,
  evidenceDirectory,
  evidenceFileName,
  runSmoke,
  sanitizeEvidence,
  smokeLine,
  smokeMain,
  type SmokeProvider
} from "../src/index.js";

/**
 * The live smoke harness, tested without ever going live.
 *
 * Everything asserted here runs with the flag off or against a payload FILE in
 * a temporary directory, so this suite reads no account, opens no socket and
 * writes nothing outside its own scratch space. That is the same guarantee the
 * harness itself makes, held one level up.
 */

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openlimiter-smoke-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A payload file a person captured themselves, handed over by path. */
async function payloadFile(document: unknown): Promise<string> {
  const directory = await temporaryDirectory();
  const file = path.join(directory, "payload.json");
  await writeFile(file, JSON.stringify(document), "utf8");
  return file;
}

describe("smoke: off unless somebody says otherwise", () => {
  it("prints a note and exits zero with no flag set", async () => {
    const printed: string[] = [];
    const code = await smokeMain("/nowhere", {}, (line) => printed.push(line));
    expect(code).toBe(0);
    expect(printed).toEqual([SKIPPED_NOTE]);
  });

  it("stays off for any value that is not exactly one", async () => {
    /* "true", "yes" and "0" are all things a person types by accident. Only the
       documented value turns this on, because the cost of a false positive here
       is reading somebody's real account without being asked. */
    for (const value of ["0", "true", "yes", "", "11", " 1"]) {
      const printed: string[] = [];
      const code = await smokeMain(
        "/nowhere",
        { [LIVE_ENVIRONMENT_FLAG]: value },
        (line) => printed.push(line)
      );
      expect(code, value).toBe(0);
      expect(printed, value).toEqual([SKIPPED_NOTE]);
    }
  });

  it("says how to turn it on, in the note it prints", () => {
    expect(SKIPPED_NOTE).toContain(LIVE_ENVIRONMENT_FLAG + "=1");
  });
});

describe("smoke: nothing identifying leaves", () => {
  const secrets: readonly (readonly [string, string])[] = [
    ["an email address", '{"note":"someone@example.test"}'],
    ["a JSON web token", '{"token":"eyJhbGciOiJIUzI1NiJ9"}'],
    ["a bearer token", '{"header":"Bearer abc123"}'],
    ["an api key", '{"key":"sk-ABCDEFGH1234"}'],
    ["a windows user path", '{"path":"C:\\\\Users\\\\someone\\\\openlimiter"}'],
    ["a windows user path", '{"path":"c:\\\\users\\\\someone\\\\openlimiter"}'],
    ["a unix home path", '{"path":"/home/someone/.openlimiter"}'],
    ["an authorization header", '{"authorization":"x"}'],
    ["a cookie", '{"cookie":"session=x"}']
  ];

  for (const [reason, document] of secrets) {
    it("refuses a document carrying " + reason, () => {
      expect(containsSecret(document)).toBe(reason);
    });
  }

  it("passes a document that carries only codes, numbers and instants", () => {
    const clean = JSON.stringify(sanitizeEvidence(
      {
        provider: "CLAUDE",
        connector: "claude",
        maturity: "stable",
        detected: true,
        via: "payload_file",
        connection: { state: "CONNECTED", reason: null, instruction: "Refresh now" },
        meters: [{
          meter: "SEVEN_DAY_FABLE_5",
          value: 21.5,
          unit: "PERCENT",
          resetAt: "2026-09-11T00:00:00.000Z",
          state: "fresh",
          source: "native_payload",
          precision: "exact"
        }]
      } satisfies SmokeProvider,
      FIXTURE_NOW
    ));
    expect(containsSecret(clean)).toBeNull();
  });

  it("builds the evidence from an allow list, so a new field cannot leak", () => {
    /* A deny list is defeated by a provider adding a field. This one names
       every key that goes in, so a field nobody anticipated is simply absent. */
    const document = sanitizeEvidence(
      {
        provider: "CLAUDE",
        connector: "claude",
        maturity: "stable",
        detected: true,
        via: "snapshot_cache",
        connection: null,
        meters: []
      } satisfies SmokeProvider,
      FIXTURE_NOW
    );
    expect(Object.keys(document).sort()).toEqual([
      "connection",
      "connector",
      "detected",
      "maturity",
      "meterCount",
      "meters",
      "observedAt",
      "provider",
      "readVia",
      "schema"
    ]);
  });
});

describe("smoke: where the evidence lands", () => {
  it("finds the mission workspace from a lane worktree", () => {
    expect(evidenceDirectory(
      path.join("C:", "work", "launch-2026-09-01", "wt", "lane-ts-connectors"),
      {}
    )).toBe(path.join("C:", "work", "launch-2026-09-01", "providers"));
  });

  it("finds the same workspace from a checkout beside it", () => {
    expect(evidenceDirectory(
      path.join("C:", "work", "launch-2026-09-01", "openlimiter"),
      {}
    )).toBe(path.join("C:", "work", "launch-2026-09-01", "providers"));
  });

  it("lets a person send the evidence somewhere else entirely", async () => {
    const elsewhere = await temporaryDirectory();
    expect(evidenceDirectory("/anywhere", {
      [EVIDENCE_DIRECTORY_ENVIRONMENT]: elsewhere
    })).toBe(path.resolve(elsewhere));
  });

  it("names a file after the provider and the day", () => {
    expect(evidenceFileName("CLAUDE", "2026-09-04")).toBe("claude-2026-09-04.json");
    expect(evidenceFileName("GEMINI_CLI", "2026-09-04"))
      .toBe("gemini-cli-2026-09-04.json");
  });

  it("takes the day in UTC, so a file name never depends on a time zone", () => {
    expect(evidenceDay("2026-09-04T23:59:59.000Z")).toBe("2026-09-04");
    expect(evidenceDay("not an instant")).toBe("unknown");
  });
});

describe("smoke: reading a provider through the real reader", () => {
  it("reads a payload file a person captured, and says it came from one", async () => {
    /* This is the whole design in one test: the person makes the call with
       their own credential and hands over the result, and the harness runs it
       through the shipped connector rather than a second implementation. */
    const state = await temporaryDirectory();
    const file = await payloadFile(claudeFixture(FIXTURE_NOW));
    const entries = await collectSmoke({
      environment: { [PAYLOAD_ENVIRONMENT_PREFIX + "CLAUDE"]: file },
      stateDirectory: state,
      now: FIXTURE_NOW
    });
    const claude = entries.find((entry) => entry.provider === "CLAUDE");
    expect(claude?.via).toBe("payload_file");
    expect(claude?.connection?.state).toBe("CONNECTED");
    expect(claude?.meters.map((meter) => meter.meter)).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
    expect(claude?.meters[0]?.value).toBe(42);
  });

  it("says a provider that produced nothing produced nothing", async () => {
    const state = await temporaryDirectory();
    const entries = await collectSmoke({
      environment: {},
      stateDirectory: state,
      now: FIXTURE_NOW
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.meters, entry.provider).toHaveLength(0);
      expect(entry.via, entry.provider).toBe("none");
    }
  });

  it("carries the beta maturity through to the evidence", async () => {
    const state = await temporaryDirectory();
    const entries = await collectSmoke({
      environment: {},
      stateDirectory: state,
      now: FIXTURE_NOW
    });
    const opencode = entries.find((entry) => entry.provider === "OPENCODE");
    expect(opencode?.maturity).toBe("beta");
  });

  it("prints percent and reset on one line per provider per meter", () => {
    const line = smokeLine(
      {
        provider: "CLAUDE",
        connector: "claude",
        maturity: "stable",
        detected: true,
        via: "payload_file",
        connection: null,
        meters: []
      } satisfies SmokeProvider,
      {
        meter: "SEVEN_DAY_OPUS",
        value: 61,
        unit: "PERCENT",
        resetAt: "2026-09-11T00:00:00.000Z",
        state: "fresh",
        source: "native_payload",
        precision: "exact"
      }
    );
    expect(line).toContain("CLAUDE");
    expect(line).toContain("SEVEN_DAY_OPUS");
    expect(line).toContain("61.0%");
    expect(line).toContain("2026-09-11T00:00:00.000Z");
  });
});

describe("smoke: writing the evidence", () => {
  it("writes one sanitized file for a provider that reported", async () => {
    const state = await temporaryDirectory();
    const output = await temporaryDirectory();
    const file = await payloadFile(claudeFixture(FIXTURE_NOW));
    const outcome = await runSmoke(
      {
        environment: { [PAYLOAD_ENVIRONMENT_PREFIX + "CLAUDE"]: file },
        stateDirectory: state,
        now: FIXTURE_NOW
      },
      output
    );
    expect(outcome.written).toEqual(["claude-2026-01-01.json"]);
    expect(outcome.refused).toEqual([]);
    const written = await readFile(path.join(output, "claude-2026-01-01.json"), "utf8");
    expect(containsSecret(written)).toBeNull();
    const document = JSON.parse(written) as Record<string, unknown>;
    expect(document["provider"]).toBe("CLAUDE");
    expect(document["meterCount"]).toBe(2);
    expect(written).not.toContain(state);
    expect(written).not.toContain(file);
  });

  it("writes nothing at all when no provider reported", async () => {
    /* An evidence file saying nothing happened is a file somebody will one day
       cite as proof that something did. */
    const state = await temporaryDirectory();
    const output = path.join(await temporaryDirectory(), "unwritten");
    const outcome = await runSmoke(
      { environment: {}, stateDirectory: state, now: FIXTURE_NOW },
      output
    );
    expect(outcome.written).toEqual([]);
    await expect(readdir(output)).rejects.toThrow();
    expect(outcome.lines.every((line) => line.includes("not configured"))).toBe(true);
  });
});
