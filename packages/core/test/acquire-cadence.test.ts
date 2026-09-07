import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACQUISITION_BLOCKED_BACKOFF_SECONDS,
  ACQUISITION_CLIENT_VERSION,
  ACQUISITION_INTERVAL_SECONDS,
  ACQUISITION_OUTCOME_SENTENCE,
  ACQUISITION_RATE_LIMIT_BACKOFF_SECONDS,
  ACQUISITION_STATE_FILE_NAME,
  DESKTOP_OWNERSHIP_SECONDS,
  backoffSecondsFor,
  isProviderDue,
  nextAttemptInstant,
  outcomeForStatus,
  readAcquisitionSchedule,
  retryAfterSeconds,
  writeAcquisitionSchedule
} from "../src/index.js";

const NOW = "2026-01-01T00:00:00.000Z";

let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), "openlimiter-cadence-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("acquisition cadence", () => {
  it("mirrors the desktop's three constants exactly", () => {
    /* apps/desktop/src-tauri/src/claude_oauth.rs lines 20 to 23. Two clients
       on one machine that disagree about cadence poll twice as often as either
       intended, and the provider only ever sees the total. */
    expect(ACQUISITION_INTERVAL_SECONDS).toBe(900);
    expect(ACQUISITION_RATE_LIMIT_BACKOFF_SECONDS).toBe(3_600);
    expect(ACQUISITION_BLOCKED_BACKOFF_SECONDS).toBe(86_400);
    expect(DESKTOP_OWNERSHIP_SECONDS).toBe(ACQUISITION_INTERVAL_SECONDS);
  });

  it("states the published version it identifies as", async () => {
    /* Read from the source tree rather than from beside the compiled test, so
       the constant is held against the version that actually ships. */
    const manifest = JSON.parse(
      await readFile(
        path.join(process.cwd(), "packages", "core", "package.json"),
        "utf8"
      )
    ) as { version: string };
    expect(ACQUISITION_CLIENT_VERSION).toBe(manifest.version);
  });

  it("earns the right backoff per outcome", () => {
    expect(backoffSecondsFor("ok")).toBe(ACQUISITION_INTERVAL_SECONDS);
    expect(backoffSecondsFor("rate_limited")).toBe(
      ACQUISITION_RATE_LIMIT_BACKOFF_SECONDS
    );
    expect(backoffSecondsFor("blocked")).toBe(ACQUISITION_BLOCKED_BACKOFF_SECONDS);
    expect(backoffSecondsFor("transport")).toBe(ACQUISITION_INTERVAL_SECONDS);
  });

  it("treats Retry-After as a floor and never as a discount", () => {
    /* A provider asking for more time gets it. A provider asking for less than
       our own interval does not talk us into polling sooner. */
    expect(backoffSecondsFor("rate_limited", 7_200)).toBe(7_200);
    expect(backoffSecondsFor("rate_limited", 60)).toBe(
      ACQUISITION_RATE_LIMIT_BACKOFF_SECONDS
    );
    expect(backoffSecondsFor("ok", 10)).toBe(ACQUISITION_INTERVAL_SECONDS);
    expect(backoffSecondsFor("rate_limited", 999_999)).toBe(
      ACQUISITION_BLOCKED_BACKOFF_SECONDS
    );
  });

  it("reads a Retry-After header only when it is a count of seconds", () => {
    expect(retryAfterSeconds("120")).toBe(120);
    expect(retryAfterSeconds(" 60 ")).toBe(60);
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds("0")).toBeNull();
  });

  it("turns a status into a decision", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(204)).toBe("ok");
    expect(outcomeForStatus(401)).toBe("unauthorized");
    expect(outcomeForStatus(403)).toBe("blocked");
    expect(outcomeForStatus(429)).toBe("rate_limited");
    expect(outcomeForStatus(500)).toBe("remote_error");
    expect(outcomeForStatus(302)).toBe("remote_error");
  });

  it("schedules the next attempt from the outcome", () => {
    expect(nextAttemptInstant("ok", NOW)).toBe("2026-01-01T00:15:00.000Z");
    expect(nextAttemptInstant("rate_limited", NOW)).toBe("2026-01-01T01:00:00.000Z");
    expect(nextAttemptInstant("blocked", NOW)).toBe("2026-01-02T00:00:00.000Z");
    expect(nextAttemptInstant("ok", "not a clock")).toBeNull();
  });

  it("counts an unreadable or missing schedule as due", () => {
    expect(isProviderDue(undefined, NOW)).toBe(true);
    expect(isProviderDue(
      { lastAttemptAt: NOW, nextAttemptAt: "nonsense", outcome: "ok" },
      NOW
    )).toBe(true);
    expect(isProviderDue(
      { lastAttemptAt: NOW, nextAttemptAt: "2026-01-01T00:15:00.000Z", outcome: "ok" },
      NOW
    )).toBe(false);
    expect(isProviderDue(
      { lastAttemptAt: NOW, nextAttemptAt: "2026-01-01T00:15:00.000Z", outcome: "ok" },
      "2026-01-01T00:15:00.000Z"
    )).toBe(true);
  });

  it("round trips the schedule file and carries no secret in it", async () => {
    const directory = await temporaryDirectory();
    await writeAcquisitionSchedule({
      CODEX: {
        lastAttemptAt: NOW,
        nextAttemptAt: "2026-01-01T01:00:00.000Z",
        outcome: "rate_limited"
      }
    }, directory);
    const stored = await readFile(
      path.join(directory, ACQUISITION_STATE_FILE_NAME),
      "utf8"
    );
    expect(stored).not.toMatch(/token|secret|authorization|bearer/iu);
    expect(await readAcquisitionSchedule(directory)).toEqual({
      CODEX: {
        lastAttemptAt: NOW,
        nextAttemptAt: "2026-01-01T01:00:00.000Z",
        outcome: "rate_limited"
      }
    });
  });

  it("reads an unusable schedule file as no schedule at all", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, ACQUISITION_STATE_FILE_NAME),
      "{ not json",
      "utf8"
    );
    expect(await readAcquisitionSchedule(directory)).toEqual({});
    await writeFile(
      path.join(directory, ACQUISITION_STATE_FILE_NAME),
      JSON.stringify({
        version: 1,
        providers: { CODEX: { lastAttemptAt: "x", nextAttemptAt: "y", outcome: "ok" } }
      }),
      "utf8"
    );
    expect(await readAcquisitionSchedule(directory)).toEqual({});
  });

  it("says what happened in words with no dashes", () => {
    for (const sentence of Object.values(ACQUISITION_OUTCOME_SENTENCE)) {
      expect(sentence).not.toMatch(/[-–—]/u);
      expect(sentence.length).toBeGreaterThan(0);
    }
  });
});
