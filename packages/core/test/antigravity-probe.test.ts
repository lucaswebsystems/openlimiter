import { describe, expect, it } from "vitest";
import {
  AGY_NOT_RUNNING_SENTENCE,
  MAX_AGY_RESPONSE_BYTES,
  TOTAL_AGY_PROBE_DEADLINE_MS,
  enumerateAgyListeningPorts,
  isTrustedAgyExecutable,
  parseAgyQuotaSummary,
  parseLoopbackPort,
  parseNetstatPorts,
  probeAntigravity,
  resolveAgyExecutablePath
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

  it("enumerates listening ports on Windows via stubbed commands, once a resolver verifies the pid", async () => {
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
      env: { LOCALAPPDATA: "C:\\Users\\lucas\\AppData\\Local", ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\lucas" },
      runCommand: mockRunner,
      resolveExecutablePath: async () => "C:\\Program Files\\Antigravity\\agy.exe"
    });
    expect(ports).toEqual([57737]);
  });

  it("fails closed on the Windows tasklist fallback: no resolver, no trust, no port", async () => {
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
          stdout: "  TCP    127.0.0.1:57737        0.0.0.0:0              LISTENING       29012\r\n"
        };
      }
      return { ok: false as const };
    };

    /* No resolveExecutablePath at all: this build has nothing to check the
       bare name "agy.exe" against, so it trusts nothing rather than trusting
       it anyway. */
    const withoutResolver = await enumerateAgyListeningPorts({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\lucas\\AppData\\Local", ProgramFiles: "C:\\Program Files" }, runCommand: mockRunner });
    expect(withoutResolver).toEqual([]);

    /* A resolver that itself could not name the executable is the same
       answer: skipped, never trusted. */
    const withFailingResolver = await enumerateAgyListeningPorts({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\lucas\\AppData\\Local", ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\lucas" },
      runCommand: mockRunner,
      resolveExecutablePath: async () => null
    });
    expect(withFailingResolver).toEqual([]);
  });

  it("returns empty ports when agy is not running on Windows", async () => {
    const mockRunner = async () => ({
      ok: true as const,
      stdout: "INFO: No tasks are running which match the specified criteria.\r\n"
    });

    const ports = await enumerateAgyListeningPorts({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\lucas\\AppData\\Local", ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\lucas" },
      runCommand: mockRunner
    });
    expect(ports).toEqual([]);
  });

  it("enumerates ports on macOS/Linux via stubbed lsof", async () => {
    const mockRunner = async (executable: string) => {
      if (executable === "lsof") {
        return {
          ok: true as const,
          stdout: "agy  29012 user  4u  IPv4  0x1234  0t0  TCP 127.0.0.1:44321 (LISTEN)\n"
        };
      }
      if (executable === "ps") {
        return {
          ok: true as const,
          stdout: "/opt/agy\n"
        };
      }
      return { ok: false as const };
    };

    const ports = await enumerateAgyListeningPorts({
      platform: "darwin",
      runCommand: mockRunner
    });
    expect(ports).toEqual([44321]);
  });

  it("fails closed on macOS/Linux when the executable cannot be resolved, rather than trusting the port", async () => {
    const mockRunner = async (executable: string) => {
      if (executable === "lsof") {
        return {
          ok: true as const,
          stdout: "agy  29012 user  4u  IPv4  0x1234  0t0  TCP 127.0.0.1:44321 (LISTEN)\n"
        };
      }
      /* ps cannot name this pid's command: the process may already be gone. */
      return { ok: false as const };
    };

    const ports = await enumerateAgyListeningPorts({
      platform: "darwin",
      runCommand: mockRunner
    });
    expect(ports).toEqual([]);
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

  it("parses netstat output language-agnostically with wildcard peer check", () => {
    const ptNetstat = [
      "  TCP    127.0.0.1:45678        0.0.0.0:0              ESCUTANDO       1001",
      "  TCP    [::1]:45679            [::]:0                 ESCUTANDO       1001",
      "  TCP    127.0.0.1:8080         192.168.1.5:54321      ESTABELECIDA    1001",
      "  TCP    127.0.0.1:9999         0.0.0.0:0              ESCUTANDO       9999"
    ].join("\r\n");
    expect(parseNetstatPorts(ptNetstat, ["1001"])).toEqual([45678, 45679]);

    const deNetstat = [
      "  TCP    127.0.0.1:33333        0.0.0.0:0              ABHÖREN         2002",
      "  TCP    192.168.1.10:33333     0.0.0.0:0              ABHÖREN         2002"
    ].join("\r\n");
    expect(parseNetstatPorts(deNetstat, ["2002"])).toEqual([33333]);
  });

  it("validates trusted agy executable paths against install roots", () => {
    const winRoots = [
      "C:\\Users\\lucas\\AppData\\Local",
      "C:\\Program Files",
      "C:\\Users\\lucas\\AppData\\Local\\Programs"
    ];
    expect(
      isTrustedAgyExecutable("C:\\Program Files\\Antigravity\\agy.exe", "win32", winRoots)
    ).toBe(true);
    expect(
      isTrustedAgyExecutable("C:\\Users\\lucas\\AppData\\Local\\Programs\\agy.exe", "win32", winRoots)
    ).toBe(true);

    expect(isTrustedAgyExecutable("C:\\Downloads\\agy.exe", "win32", winRoots)).toBe(false);
    expect(isTrustedAgyExecutable("C:\\Temp\\agy.exe", "win32", winRoots)).toBe(false);
    expect(isTrustedAgyExecutable("agy.exe", "win32", winRoots)).toBe(false);
    expect(
      isTrustedAgyExecutable("C:\\Program Files\\..\\Downloads\\agy.exe", "win32", winRoots)
    ).toBe(false);
    expect(
      isTrustedAgyExecutable("C:\\Program Files\\Antigravity\\other.exe", "win32", winRoots)
    ).toBe(false);

    const unixRoots = ["/usr/bin", "/opt", "/home/user/.local"];
    expect(isTrustedAgyExecutable("/usr/bin/agy", "linux", unixRoots)).toBe(true);
    expect(isTrustedAgyExecutable("/opt/google/agy", "linux", unixRoots)).toBe(true);
    expect(isTrustedAgyExecutable("/tmp/agy", "linux", unixRoots)).toBe(false);
  });

  it("verifies PID and executable path through PowerShell CIM query", async () => {
    const mockCimRunner = async (cmd: string) => {
      if (cmd === "powershell.exe") {
        return {
          ok: true as const,
          stdout: "31415|C:\\Users\\lucas\\AppData\\Local\\Programs\\Antigravity\\agy.exe\r\n"
        };
      }
      if (cmd === "netstat.exe") {
        return {
          ok: true as const,
          stdout: "  TCP    127.0.0.1:41414        0.0.0.0:0              LISTENING       31415\r\n"
        };
      }
      return { ok: false as const };
    };

    const ports = await enumerateAgyListeningPorts({
      platform: "win32",
      runCommand: mockCimRunner,
      env: {
        USERPROFILE: "C:\\Users\\lucas"
      }
    });
    expect(ports).toEqual([41414]);

    const mockUntrustedRunner = async (cmd: string) => {
      if (cmd === "powershell.exe") {
        return {
          ok: true as const,
          stdout: "31415|C:\\Malicious\\agy.exe\r\n"
        };
      }
      return { ok: false as const };
    };
    const untrustedPorts = await enumerateAgyListeningPorts({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\lucas\\AppData\\Local", ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\lucas" },
      runCommand: mockUntrustedRunner
    });
    expect(untrustedPorts).toEqual([]);
  });

  it("resolveAgyExecutablePath asks Windows for the one pid's own record", async () => {
    const runner = async (executable: string, args: readonly string[]) => {
      expect(executable).toBe("powershell.exe");
      expect(args.join(" ")).toContain("ProcessId=31415");
      return { ok: true as const, stdout: "C:\\Program Files\\Antigravity\\agy.exe\r\n" };
    };
    expect(await resolveAgyExecutablePath("31415", "win32", runner)).toBe(
      "C:\\Program Files\\Antigravity\\agy.exe"
    );
  });

  it("resolveAgyExecutablePath asks ps on macOS", async () => {
    const runner = async (executable: string, args: readonly string[]) => {
      if (executable === "ps") {
        expect(args).toContain("31415");
        return { ok: true as const, stdout: "/opt/agy\n" };
      }
      return { ok: false as const };
    };
    expect(await resolveAgyExecutablePath("31415", "darwin", runner)).toBe("/opt/agy");
  });

  it("resolveAgyExecutablePath answers null rather than trusting a pid it could not resolve", async () => {
    expect(await resolveAgyExecutablePath("not-a-pid", "win32", async () => ({ ok: false }))).toBeNull();
    expect(await resolveAgyExecutablePath("31415", "win32", async () => ({ ok: false }))).toBeNull();
    expect(await resolveAgyExecutablePath("31415", "darwin", async () => ({ ok: true, stdout: "" }))).toBeNull();
  });

  it("threads a resolver from runAcquisition all the way down to the probe", async () => {
    const resolved: string[] = [];
    const result = await runAcquisition([antigravitySpec(() => [])], {
      transport: async () => ({ status: 200, body: "{}", retryAfterSeconds: null }),
      now: NOW,
      schedule: {},
      readCredential: async () => ({ ok: false, reason: "absent" }),
      resolveExecutablePath: async (pid) => {
        resolved.push(pid);
        return null;
      },
      probeAntigravity: async (options) => {
        expect(options?.resolveExecutablePath).toBeDefined();
        await options?.resolveExecutablePath?.("1234");
        return { ok: false, reason: "not_running" };
      }
    });
    expect(resolved).toEqual(["1234"]);
    expect(result.rows[0]?.status).toBe("stale");
  });

  it("enforces 64 KB response size cap in probeAntigravity", async () => {
    const result = await probeAntigravity({
      now: NOW,
      enumeratePorts: async () => [57737],
      probePort: async () => null
    });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(MAX_AGY_RESPONSE_BYTES).toBe(64 * 1024);
  });

  it("enforces overall probe deadline across ports", async () => {
    expect(TOTAL_AGY_PROBE_DEADLINE_MS).toBe(5_000);
    const result = await probeAntigravity({
      now: NOW,
      totalDeadlineMs: 50,
      enumeratePorts: async () => [11111, 22222],
      probePort: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return SAMPLE_SUMMARY_PAYLOAD;
      }
    });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });
});
