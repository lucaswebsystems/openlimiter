import { describe, expect, it } from "vitest";
import {
  AGY_NOT_RUNNING_SENTENCE,
  enumerateAgyListeningPorts,
  parseAgyQuotaSummary,
  probeAntigravity
} from "../src/acquire/antigravity-probe.js";
import { runAcquisition } from "../src/acquire/runner.js";
import { antigravitySpec } from "../src/acquire/providers.js";
import { normalizeMeter } from "../src/normalizer.js";

const NOW = "2026-09-07T05:00:00.000Z";

const SAMPLE_SUMMARY_PAYLOAD = {
  response: {
    groups: [
      {
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Gemini Limit",
            window: "weekly",
            remainingFraction: 0.76,
            resetTime: "2026-09-14T05:00:00Z"
          },
          {
            bucketId: "gemini-5h",
            displayName: "5-Hour Gemini Limit",
            window: "5h",
            remainingFraction: 0.73,
            resetTime: "2026-09-07T07:18:00Z"
          },
          {
            bucketId: "3p-weekly",
            displayName: "Weekly 3P Limit",
            window: "weekly",
            remainingFraction: 1.0,
            resetTime: "2026-09-14T05:00:00Z"
          }
        ]
      }
    ]
  }
};

describe("Antigravity loopback probe", () => {
  it("parses quota summary payload into raw meters", () => {
    const meters = parseAgyQuotaSummary(SAMPLE_SUMMARY_PAYLOAD, NOW);
    expect(meters).not.toBeNull();
    expect(meters).toHaveLength(2);

    const weekly = meters?.find((m) => m.meter === "SEVEN_DAY");
    expect(weekly).toBeDefined();
    expect(weekly?.value).toBe(24);
    // window is unknown on the RawMeter boundary type by design; narrow it
    // through the same normalizer the runtime uses rather than casting.
    const weeklySnapshot = weekly !== undefined ? normalizeMeter(weekly) : null;
    expect(weeklySnapshot).not.toBeNull();
    expect(weeklySnapshot?.window.durationSeconds).toBe(604_800);
    expect(weekly?.resetAt).toBe("2026-09-14T05:00:00.000Z");

    const fiveHour = meters?.find((m) => m.meter === "FIVE_HOUR");
    expect(fiveHour).toBeDefined();
    expect(fiveHour?.value).toBe(27);
    const fiveHourSnapshot = fiveHour !== undefined ? normalizeMeter(fiveHour) : null;
    expect(fiveHourSnapshot).not.toBeNull();
    expect(fiveHourSnapshot?.window.durationSeconds).toBe(18_000);
    expect(fiveHour?.resetAt).toBe("2026-09-07T07:18:00.000Z");
  });

  it("handles unwrapped groups in quota payload", () => {
    const unwrapped = {
      groups: SAMPLE_SUMMARY_PAYLOAD.response.groups
    };
    const meters = parseAgyQuotaSummary(unwrapped, NOW);
    expect(meters).not.toBeNull();
    expect(meters).toHaveLength(2);
  });

  it("returns null on malformed or empty payloads", () => {
    expect(parseAgyQuotaSummary(null, NOW)).toBeNull();
    expect(parseAgyQuotaSummary({}, NOW)).toBeNull();
    expect(parseAgyQuotaSummary({ response: { groups: [] } }, NOW)).toBeNull();
  });

  it("enumerates listening ports on Windows via stubbed commands", async () => {
    const mockRunner = async (executable: string) => {
      if (executable === "tasklist.exe") {
        return {
          ok: true as const,
          stdout: '"agy.exe","29012","Console","1","58,984 K"\r\n'
        };
      }
      if (executable === "netstat.exe") {
        return {
          ok: true as const,
          stdout:
            "  TCP    127.0.0.1:57737        0.0.0.0:0              LISTENING       29012\r\n" +
            "  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       12345\r\n"
        };
      }
      return { ok: false as const };
    };

    const ports = await enumerateAgyListeningPorts({
      platform: "win32",
      runCommand: mockRunner
    });
    expect(ports).toEqual([57737]);
  });

  it("returns empty ports when agy is not running on Windows", async () => {
    const mockRunner = async () => ({
      ok: true as const,
      stdout: "INFO: No tasks are running which match the specified criteria.\r\n"
    });

    const ports = await enumerateAgyListeningPorts({
      platform: "win32",
      runCommand: mockRunner
    });
    expect(ports).toEqual([]);
  });

  it("enumerates ports on macOS/Linux via stubbed lsof", async () => {
    const mockRunner = async () => ({
      ok: true as const,
      stdout: "agy  29012 user  4u  IPv4  0x1234  0t0  TCP 127.0.0.1:44321 (LISTEN)\n"
    });

    const ports = await enumerateAgyListeningPorts({
      platform: "darwin",
      runCommand: mockRunner
    });
    expect(ports).toEqual([44321]);
  });

  it("probe reports not_running when port list is empty", async () => {
    const result = await probeAntigravity({
      now: NOW,
      enumeratePorts: async () => []
    });
    expect(result).toEqual({ ok: false, reason: "not_running" });
  });

  it("probe returns meters when port answers quota summary", async () => {
    const result = await probeAntigravity({
      now: NOW,
      enumeratePorts: async () => [57737],
      probePort: async () => SAMPLE_SUMMARY_PAYLOAD
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meters).toHaveLength(2);
      expect(result.meters[0]?.provider).toBe("ANTIGRAVITY");
    }
  });

  it("runAcquisition records read when probe succeeds", async () => {
    const result = await runAcquisition([antigravitySpec(() => [])], {
      transport: async () => ({ status: 200, body: "{}", retryAfterSeconds: null }),
      now: NOW,
      schedule: {},
      probeAntigravity: async () => ({
        ok: true,
        meters: parseAgyQuotaSummary(SAMPLE_SUMMARY_PAYLOAD, NOW) ?? []
      })
    });

    expect(result.rows[0]?.status).toBe("read");
    expect(result.rows[0]?.reason).toBeNull();
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0];
    expect(report?.ok).toBe(true);
    if (report?.ok === true) {
      expect(report.snapshots).toHaveLength(2);
    }
  });

  it("runAcquisition reports stale and refresh prompt when agy is not running", async () => {
    const result = await runAcquisition([antigravitySpec(() => [])], {
      transport: async () => ({ status: 200, body: "{}", retryAfterSeconds: null }),
      now: NOW,
      schedule: {},
      readCredential: async () => ({
        ok: true,
        credential: {
          secret: "token",
          accountId: null,
          expiresAtMilliseconds: null,
          origin: "vendor_store"
        }
      }),
      probeAntigravity: async () => ({ ok: false, reason: "not_running" })
    });

    expect(result.rows[0]?.status).toBe("stale");
    expect(result.rows[0]?.reason).toBe(AGY_NOT_RUNNING_SENTENCE);
    expect(result.reports).toHaveLength(0);
  });
});
