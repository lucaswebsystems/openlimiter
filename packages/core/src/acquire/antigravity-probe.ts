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
import path from "node:path";
import type { ConnectorLabels, RawMeter } from "../types.js";
import { OPENLIMITER_USER_AGENT } from "./identity.js";
import type { CredentialCommandRunner } from "./windows-credential.js";
import type { CredentialLookupOptions } from "./credentials.js";

export const AGY_QUOTA_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

export const AGY_NOT_RUNNING_SENTENCE = "Open Antigravity once to refresh";

export const AGY_PROBE_TIMEOUT_MILLISECONDS = 3_000;

export const MAX_AGY_RESPONSE_BYTES = 64 * 1024; // 64 KB

export const TOTAL_AGY_PROBE_DEADLINE_MS = 5_000; // 5 seconds

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
  readonly resolveExecutablePath?: (pid: string) => Promise<string | null>;
  readonly enumeratePorts?: () => Promise<readonly number[]>;
  readonly probePort?: (port: number) => Promise<unknown | null>;
  readonly totalDeadlineMs?: number;
}

export interface EnumerateAgyPortsOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: CredentialCommandRunner;
  readonly resolveExecutablePath?: (pid: string) => Promise<string | null>;
  readonly env?: NodeJS.ProcessEnv;
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
 * Extract loopback port from an address string (e.g. "127.0.0.1:57737" or "[::1]:57737").
 */
export function parseLoopbackPort(address: string): number | null {
  const lastColon = address.lastIndexOf(":");
  if (lastColon === -1) return null;
  let host = address.slice(0, lastColon);
  const portStr = address.slice(lastColon + 1);
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host !== "127.0.0.1" && host !== "::1") {
    return null;
  }
  const port = Number.parseInt(portStr, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

/**
 * Language-agnostic Windows netstat parser.
 *
 * Windows netstat lines have 5 whitespace-delimited tokens:
 * Protocol, Local Address, Foreign Address, State, PID.
 * A listening socket always has a wildcard foreign address (0.0.0.0:0, [::]:0, *:*).
 * Matching this wildcard avoids relying on English "LISTENING" or "TCP".
 */
export function parseNetstatPorts(
  report: string,
  pids: ReadonlySet<string> | readonly string[]
): readonly number[] {
  const pidSet = pids instanceof Set ? pids : new Set(pids);
  const ports: number[] = [];
  for (const line of report.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5) {
      continue;
    }
    const owner = fields[4];
    if (!pidSet.has(owner)) {
      continue;
    }
    const foreign = fields[2];
    if (foreign !== "0.0.0.0:0" && foreign !== "[::]:0" && foreign !== "*:*") {
      continue;
    }
    const localAddress = fields[1];
    if (localAddress === undefined) {
      continue;
    }
    const port = parseLoopbackPort(localAddress);
    if (port !== null && !ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}

/**
 * Parse output from lsof, handling both standard tabular output and "-F pn" output.
 */
export function parseLsofOutput(output: string): Array<{ pid: string; port: number }> {
  const results: Array<{ pid: string; port: number }> = [];
  let currentPid: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("p")) {
      currentPid = trimmed.slice(1).trim();
      continue;
    }
    if (trimmed.startsWith("n")) {
      if (currentPid) {
        const port = parseLoopbackPort(trimmed.slice(1).trim());
        if (port !== null) {
          results.push({ pid: currentPid, port });
        }
      }
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 8) {
      const pid = parts[1];
      if (pid === undefined) {
        continue;
      }
      for (const part of parts) {
        const port = parseLoopbackPort(part);
        if (port !== null) {
          results.push({ pid, port });
          break;
        }
      }
    }
  }
  return results;
}

/**
 * Valid install roots where legitimate software binaries are located.
 */
export function getAgyInstallRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  const roots: string[] = [];
  if (platform === "win32") {
    const keys = ["LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"];
    for (const key of keys) {
      const val = env[key];
      if (val && val.trim().length > 0) {
        roots.push(path.normalize(val.trim()));
      }
    }
    const userProfile = env["USERPROFILE"];
    if (userProfile && userProfile.trim().length > 0) {
      roots.push(path.normalize(path.join(userProfile.trim(), "AppData", "Local", "Programs")));
      roots.push(path.normalize(path.join(userProfile.trim(), ".local", "bin")));
    }
  } else {
    for (const fixed of ["/usr/bin", "/usr/local", "/opt", "/Applications", "/snap"]) {
      roots.push(fixed);
    }
    const home = env["HOME"];
    if (home && home.trim().length > 0) {
      roots.push(path.join(home.trim(), ".local"));
      roots.push(path.join(home.trim(), ".nvm"));
      roots.push(path.join(home.trim(), "Applications"));
    }
  }
  return roots;
}

/**
 * Validate that an executable path is trusted:
 * 1. Absolute path, no parent traversal ("..")
 * 2. Named agy.exe (Windows) or agy (non-Windows)
 * 3. Resides under one of the legitimate install roots
 */
export function isTrustedAgyExecutable(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  roots: readonly string[] = getAgyInstallRoots(platform)
): boolean {
  if (!executablePath || typeof executablePath !== "string") return false;
  const p = platform === "win32" ? path.win32 : path.posix;
  const normalized = p.normalize(executablePath);
  if (executablePath.includes("..") || normalized.split(p.sep).includes("..")) {
    return false;
  }
  if (!p.isAbsolute(executablePath)) {
    return false;
  }
  const baseName = p.basename(normalized);
  const expectedName = platform === "win32" ? "agy.exe" : "agy";
  if (platform === "win32") {
    if (baseName.toLowerCase() !== expectedName.toLowerCase()) {
      return false;
    }
  } else {
    if (baseName !== expectedName) {
      return false;
    }
  }

  const normPath = platform === "win32" ? normalized.toLowerCase() : normalized;
  return roots.some((root) => {
    const normRoot = platform === "win32" ? root.toLowerCase() : root;
    return (
      normPath.startsWith(normRoot.endsWith(p.sep) ? normRoot : normRoot + p.sep) ||
      normPath === normRoot
    );
  });
}

/**
 * Enumerate listening loopback ports belonging to running agy processes.
 */
export async function enumerateAgyListeningPorts(
  options?: EnumerateAgyPortsOptions
): Promise<readonly number[]> {
  const platform = options?.platform ?? process.platform;
  const runner = options?.runCommand ?? execFilePromise;

  if (platform === "win32") {
    const roots = getAgyInstallRoots("win32", options?.env ?? process.env);
    const trustedPids = new Set<string>();

    const cimScript =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name;" +
      "Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | ForEach-Object {" +
      "$owner=(Invoke-CimMethod -InputObject $_ -MethodName GetOwner);" +
      "if ($owner -and $owner.User -and (\"$($owner.Domain)\\$($owner.User)\" -eq $me)) {" +
      "\"$($_.ProcessId)|$($_.ExecutablePath)\" } }";

    const cimRes = await runner(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", cimScript],
      AGY_PROBE_TIMEOUT_MILLISECONDS
    );

    if (cimRes.ok && cimRes.stdout.trim().length > 0) {
      for (const line of cimRes.stdout.split(/\r?\n/)) {
        const parts = line.trim().split("|");
        if (parts.length >= 2) {
          const rawPid = parts[0];
          if (rawPid === undefined) {
            continue;
          }
          const pid = rawPid.trim();
          const exePath = parts.slice(1).join("|").trim();
          if (isTrustedAgyExecutable(exePath, "win32", roots)) {
            trustedPids.add(pid);
          }
        }
      }
    } else {
      // Fallback to tasklist if CIM is unavailable
      const tasklistRes = await runner(
        "tasklist.exe",
        ["/FI", "IMAGENAME eq agy.exe", "/FO", "CSV", "/NH"],
        AGY_PROBE_TIMEOUT_MILLISECONDS
      );
      if (tasklistRes.ok) {
        for (const line of tasklistRes.stdout.split(/\r?\n/)) {
          const match = /^"agy\.exe","(\d+)"/i.exec(line.trim());
          if (match && match[1]) {
            const pid = match[1];
            if (options?.resolveExecutablePath) {
              const exePath = await options.resolveExecutablePath(pid);
              if (exePath && isTrustedAgyExecutable(exePath, "win32", roots)) {
                trustedPids.add(pid);
              }
            } else {
              trustedPids.add(pid);
            }
          }
        }
      }
    }

    if (trustedPids.size === 0) return [];

    const netstatRes = await runner(
      "netstat.exe",
      ["-ano", "-p", "tcp"],
      AGY_PROBE_TIMEOUT_MILLISECONDS
    );
    if (!netstatRes.ok) return [];

    return parseNetstatPorts(netstatRes.stdout, trustedPids);
  }

  const roots = getAgyInstallRoots(platform, options?.env ?? process.env);
  const lsofRes = await runner(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-c", "agy"],
    AGY_PROBE_TIMEOUT_MILLISECONDS
  );
  if (!lsofRes.ok) return [];

  const pidPorts = parseLsofOutput(lsofRes.stdout);
  if (pidPorts.length === 0) return [];

  const verifiedPids = new Map<string, boolean>();
  const ports: number[] = [];

  for (const { pid, port } of pidPorts) {
    let trusted = verifiedPids.get(pid);
    if (trusted === undefined) {
      if (options?.resolveExecutablePath) {
        const exePath = await options.resolveExecutablePath(pid);
        trusted = exePath !== null && isTrustedAgyExecutable(exePath, platform, roots);
      } else {
        let exePath: string | null = null;
        if (platform === "linux") {
          try {
            const fsPromises = await import("node:fs/promises");
            exePath = await fsPromises.readlink(`/proc/${pid}/exe`);
          } catch {
            exePath = null;
          }
        } else {
          const psRes = await runner("ps", ["-o", "comm=", "-p", pid], AGY_PROBE_TIMEOUT_MILLISECONDS);
          if (psRes.ok && psRes.stdout.trim().length > 0) {
            exePath = psRes.stdout.trim();
          }
        }
        if (exePath !== null) {
          trusted = isTrustedAgyExecutable(exePath, platform, roots);
        } else {
          trusted = true;
        }
      }
      verifiedPids.set(pid, trusted);
    }

    if (trusted && !ports.includes(port)) {
      ports.push(port);
    }
  }

  return ports;
}

function httpPost(
  isHttps: boolean,
  port: number,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }

    const transport = isHttps ? https : http;
    const body = "{}";
    let settled = false;

    const onAbort = () => {
      if (!settled) {
        settled = true;
        req.destroy();
        resolve(null);
      }
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

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
          if (!settled) {
            settled = true;
            resolve(null);
          }
          return;
        }

        let totalBytes = 0;
        let data = "";

        res.on("data", (chunk: Buffer | string) => {
          totalBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
          if (totalBytes > MAX_AGY_RESPONSE_BYTES) {
            req.destroy();
            res.destroy();
            if (!settled) {
              settled = true;
              resolve(null);
            }
            return;
          }
          data += chunk;
        });

        res.on("end", () => {
          if (settled) return;
          settled = true;
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });

        res.on("error", () => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });

    req.on("timeout", () => {
      req.destroy();
      if (!settled) {
        settled = true;
        resolve(null);
      }
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
  timeoutMs = AGY_PROBE_TIMEOUT_MILLISECONDS,
  signal?: AbortSignal
): Promise<unknown | null> {
  const httpsRes = await httpPost(true, port, AGY_QUOTA_PATH, timeoutMs, signal);
  if (httpsRes !== null) return httpsRes;
  return await httpPost(false, port, AGY_QUOTA_PATH, timeoutMs, signal);
}

/**
 * Run the Antigravity probe:
 * 1. Discover listening ports for running agy processes.
 * 2. If no processes found, report "not_running".
 * 3. Probe loopback ports and parse quota summary.
 * Enforces a hard total deadline across all ports probed.
 */
export async function probeAntigravity(
  options?: AntigravityProbeOptions
): Promise<AntigravityProbeResult> {
  const now = options?.now ?? new Date().toISOString();
  const totalTimeoutMs = options?.totalDeadlineMs ?? TOTAL_AGY_PROBE_DEADLINE_MS;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, totalTimeoutMs);

  try {
    const enumeratePorts =
      options?.enumeratePorts ??
      (() =>
        enumerateAgyListeningPorts({
          ...(options?.lookup?.platform !== undefined ? { platform: options.lookup.platform } : {}),
          ...(options?.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
          ...(options?.resolveExecutablePath !== undefined
            ? { resolveExecutablePath: options.resolveExecutablePath }
            : {})
        }));
    const probePort =
      options?.probePort ??
      ((port: number) => probeAgyLoopback(port, AGY_PROBE_TIMEOUT_MILLISECONDS, abortController.signal));

    if (abortController.signal.aborted) {
      return { ok: false, reason: "unreachable" };
    }

    const ports = await enumeratePorts();
    if (abortController.signal.aborted) {
      return { ok: false, reason: "unreachable" };
    }

    if (ports.length === 0) {
      return { ok: false, reason: "not_running" };
    }

    for (const port of ports) {
      if (abortController.signal.aborted) {
        return { ok: false, reason: "unreachable" };
      }
      const probePromise = probePort(port);
      const payload = await Promise.race([
        probePromise,
        new Promise<null>((resolve) => {
          if (abortController.signal.aborted) {
            resolve(null);
          } else {
            abortController.signal.addEventListener("abort", () => resolve(null), { once: true });
          }
        })
      ]);
      if (abortController.signal.aborted) {
        return { ok: false, reason: "unreachable" };
      }
      if (payload !== null) {
        const meters = parseAgyQuotaSummary(payload, now);
        if (meters !== null && meters.length > 0) {
          return { ok: true, meters };
        }
      }
    }

    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timeoutId);
  }
}

