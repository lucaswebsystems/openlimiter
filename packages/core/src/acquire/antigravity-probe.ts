/**
 * The Antigravity loopback probe.
 *
 * Antigravity quota is served live by a running agy process on a loopback port.
 * It speaks Connect protocol (POST with Connect-Protocol-Version: 1) and
 * answers RetrieveUserQuotaSummary over loopback HTTPS with a self-signed
 * certificate. When an agy process is alive on this machine, probing this
 * loopback endpoint gives an honest, authoritative reading with zero cloud
 * impersonation.
 *
 * When no agy process is running, this probe reports that fact plainly and
 * never attempts to spawn agy.
 */

import { execFile } from "node:child_process";
import https from "node:https";
import http from "node:http";
import type { ConnectorLabels, RawMeter } from "../types.js";
import { OPENLIMITER_USER_AGENT } from "./identity.js";
import type { CredentialCommandRunner } from "./windows-credential.js";
import type { CredentialLookupOptions } from "./credentials.js";

export const AGY_QUOTA_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

export const AGY_NOT_RUNNING_SENTENCE = "Open Antigravity once to refresh";

export const AGY_PROBE_TIMEOUT_MILLISECONDS = 3_000;

export const ANTIGRAVITY_PROBE_LABELS: ConnectorLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
};

export interface AgyBucketPayload {
  readonly bucketId?: string;
  readonly displayName?: string;
  readonly window?: string;
  readonly remainingFraction?: number;
  readonly resetTime?: string;
}

export interface AgyGroupPayload {
  readonly buckets?: readonly AgyBucketPayload[];
}

export interface AgyQuotaSummaryPayload {
  readonly response?: {
    readonly groups?: readonly AgyGroupPayload[];
  };
  readonly groups?: readonly AgyGroupPayload[];
}

export interface AntigravityProbeSuccess {
  readonly ok: true;
  readonly meters: readonly RawMeter[];
}

export interface AntigravityProbeFailure {
  readonly ok: false;
  readonly reason: "not_running" | "unreachable" | "invalid_response";
}

export type AntigravityProbeResult =
  | AntigravityProbeSuccess
  | AntigravityProbeFailure;

export interface AntigravityProbeOptions {
  readonly now?: string;
  readonly lookup?: CredentialLookupOptions;
  readonly runCommand?: CredentialCommandRunner;
  readonly enumeratePorts?: () => Promise<readonly number[]>;
  readonly probePort?: (port: number) => Promise<unknown | null>;
}

/**
 * Parse the Connect protocol RetrieveUserQuotaSummary response.
 *
 * Maps gemini-5h to FIVE_HOUR (18,000s) and gemini-weekly to SEVEN_DAY (604,800s).
 * Percentage is rounded to 1 decimal place: (1 - remainingFraction) * 100.
 */
export function parseAgyQuotaSummary(
  payload: unknown,
  now: string
): readonly RawMeter[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const unwrapped =
    typeof root["response"] === "object" && root["response"] !== null
      ? (root["response"] as Record<string, unknown>)
      : root;
  const groups = unwrapped["groups"];
  if (!Array.isArray(groups)) return null;

  const meters: RawMeter[] = [];
  for (const entry of groups) {
    if (typeof entry !== "object" || entry === null) continue;
    const buckets = (entry as Record<string, unknown>)["buckets"];
    if (!Array.isArray(buckets)) continue;

    for (const item of buckets) {
      if (typeof item !== "object" || item === null) continue;
      const b = item as Record<string, unknown>;
      const bucketId = typeof b["bucketId"] === "string" ? b["bucketId"] : "";
      if (!bucketId.startsWith("gemini")) continue;

      const windowName =
        typeof b["window"] === "string" ? b["window"].toLowerCase() : "";
      let meterCode: "FIVE_HOUR" | "SEVEN_DAY" | null = null;
      let durationSeconds = 0;
      if (windowName === "5h") {
        meterCode = "FIVE_HOUR";
        durationSeconds = 18_000;
      } else if (windowName === "weekly") {
        meterCode = "SEVEN_DAY";
        durationSeconds = 604_800;
      }
      if (meterCode === null) continue;

      const remaining =
        typeof b["remainingFraction"] === "number" ? b["remainingFraction"] : null;
      if (remaining === null || Number.isNaN(remaining)) continue;
      const fraction = Math.max(0, Math.min(1, remaining));
      const value =
        Math.round(Math.max(0, Math.min(100, (1 - fraction) * 100)) * 10) / 10;

      const resetTime = typeof b["resetTime"] === "string" ? b["resetTime"] : null;
      const resetAt =
        resetTime !== null && !Number.isNaN(Date.parse(resetTime))
          ? new Date(resetTime).toISOString()
          : undefined;

      const expiresAt = new Date(new Date(now).getTime() + 300_000).toISOString();

      meters.push({
        provider: "ANTIGRAVITY",
        meter: meterCode,
        value,
        unit: "PERCENT",
        window: { kind: "rolling", durationSeconds },
        resetAt,
        source: "internal_payload",
        precision: "estimated",
        observedAt: now,
        expiresAt,
        labels: ANTIGRAVITY_PROBE_LABELS
      });
    }
  }

  return meters.length > 0 ? meters : null;
}

function execFilePromise(
  executable: string,
  args: readonly string[],
  timeout: number
): Promise<{ ok: true; stdout: string } | { ok: false }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { timeout, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false });
        } else {
          resolve({ ok: true, stdout: stdout.toString() });
        }
      }
    );
  });
}

/**
 * Enumerate listening loopback ports belonging to running agy processes.
 */
export async function enumerateAgyListeningPorts(
  options?: {
    platform?: NodeJS.Platform;
    runCommand?: CredentialCommandRunner;
  }
): Promise<readonly number[]> {
  const platform = options?.platform ?? process.platform;
  const runner = options?.runCommand ?? execFilePromise;

  if (platform === "win32") {
    const tasklistRes = await runner(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq agy.exe", "/FO", "CSV", "/NH"],
      AGY_PROBE_TIMEOUT_MILLISECONDS
    );
    if (!tasklistRes.ok) return [];
    const pids = new Set<string>();
    for (const line of tasklistRes.stdout.split("\n")) {
      const match = /^"agy\.exe","(\d+)"/i.exec(line.trim());
      if (match && match[1]) {
        pids.add(match[1]);
      }
    }
    if (pids.size === 0) return [];

    const netstatRes = await runner(
      "netstat.exe",
      ["-ano", "-p", "tcp"],
      AGY_PROBE_TIMEOUT_MILLISECONDS
    );
    if (!netstatRes.ok) return [];

    const ports: number[] = [];
    for (const line of netstatRes.stdout.split("\n")) {
      const match = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(
        line.trim()
      );
      if (match && match[1] && match[2] && pids.has(match[2])) {
        const port = Number.parseInt(match[1], 10);
        if (port > 0 && !ports.includes(port)) {
          ports.push(port);
        }
      }
    }
    return ports;
  }

  const lsofRes = await runner(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-c", "agy"],
    AGY_PROBE_TIMEOUT_MILLISECONDS
  );
  if (!lsofRes.ok) return [];

  const ports: number[] = [];
  for (const line of lsofRes.stdout.split("\n")) {
    const match = /127\.0\.0\.1:(\d+)/.exec(line);
    if (match && match[1]) {
      const port = Number.parseInt(match[1], 10);
      if (port > 0 && !ports.includes(port)) {
        ports.push(port);
      }
    }
  }
  return ports;
}

function httpPost(
  isHttps: boolean,
  port: number,
  path: string,
  timeoutMs: number
): Promise<unknown | null> {
  return new Promise((resolve) => {
    const transport = isHttps ? https : http;
    const body = "{}";
    const req = transport.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "User-Agent": OPENLIMITER_USER_AGENT,
          "Content-Length": Buffer.byteLength(body)
        },
        rejectUnauthorized: false,
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Probe an agy loopback port for quota summary.
 * Attempts HTTPS with self-signed certificate acceptance first, then plain HTTP.
 */
export async function probeAgyLoopback(
  port: number,
  timeoutMs = AGY_PROBE_TIMEOUT_MILLISECONDS
): Promise<unknown | null> {
  const httpsRes = await httpPost(true, port, AGY_QUOTA_PATH, timeoutMs);
  if (httpsRes !== null) return httpsRes;
  return await httpPost(false, port, AGY_QUOTA_PATH, timeoutMs);
}

/**
 * Run the Antigravity probe:
 * 1. Discover listening ports for running agy processes.
 * 2. If no processes found, report "not_running".
 * 3. Probe loopback ports and parse quota summary.
 */
export async function probeAntigravity(
  options?: AntigravityProbeOptions
): Promise<AntigravityProbeResult> {
  const now = options?.now ?? new Date().toISOString();
  const enumeratePorts =
    options?.enumeratePorts ??
    (() =>
      enumerateAgyListeningPorts({
        ...(options?.lookup?.platform !== undefined ? { platform: options.lookup.platform } : {}),
        ...(options?.runCommand !== undefined ? { runCommand: options.runCommand } : {})
      }));
  const probePort = options?.probePort ?? ((port: number) => probeAgyLoopback(port));

  const ports = await enumeratePorts();
  if (ports.length === 0) {
    return { ok: false, reason: "not_running" };
  }

  for (const port of ports) {
    const payload = await probePort(port);
    if (payload !== null) {
      const meters = parseAgyQuotaSummary(payload, now);
      if (meters !== null && meters.length > 0) {
        return { ok: true, meters };
      }
    }
  }

  return { ok: false, reason: "unreachable" };
}
