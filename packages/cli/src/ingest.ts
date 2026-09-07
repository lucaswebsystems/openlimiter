import path from "node:path";
import {
  MANUAL_FILE_MARKER,
  MANUAL_FILE_NAME,
  parseGrokPayload
} from "@openlimiter/connectors";
import {
  mergeSnapshotCache,
  readJsonFileSafely,
  resolveStateDirectory,
  type CacheMergeResult,
  type RawMeter,
  type Snapshot,
  type SnapshotProvenance
} from "@openlimiter/core";
import { writeAgentContextSnapshot } from "@openlimiter/adapters";

/** Largest document accepted on standard input. */
export const STDIN_BYTE_LIMIT = 262_144;

/** Hard ceiling on how long a command waits for standard input. */
export const STDIN_TIMEOUT_MILLISECONDS = 500;

/**
 * Read one status line payload as bytes, once.
 *
 * Wrapper mode needs the bytes rather than decoded text because the foreign
 * command must receive exactly what Claude wrote. There is deliberately no
 * payload logging and no intermediate file.
 */
export async function readStandardInputBuffer(
  stream: NodeJS.ReadStream = process.stdin,
  timeoutMilliseconds = STDIN_TIMEOUT_MILLISECONDS
): Promise<Buffer> {
  if (stream.isTTY === true) return Buffer.alloc(0);
  return await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish();
    const timer = setTimeout(finish, timeoutMilliseconds);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.resume();
  });
}

/** Largest manual document accepted from the state directory. */
export const MANUAL_FILE_BYTE_LIMIT = 65_536;

export type JsonText = { ok: true; value: unknown } | { ok: false };

/**
 * Read standard input without ever blocking a caller forever.
 *
 * A terminal is treated as no input at all, the stream is bounded by size, and
 * a stream that never ends still resolves once the timeout elapses. Claude Code
 * writes its statusline payload and closes the pipe, so the common path costs
 * one tick rather than the full timeout.
 */
export async function readStandardInputText(
  stream: NodeJS.ReadStream = process.stdin,
  byteLimit = STDIN_BYTE_LIMIT,
  timeoutMilliseconds = STDIN_TIMEOUT_MILLISECONDS,
  signal?: AbortSignal
): Promise<string | null> {
  if (stream.isTTY === true || signal?.aborted === true) return null;
  return await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const collected = (): string | null => {
      if (chunks.length === 0) return null;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return null;
      }
    };
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
      resolve(value);
    };
    /* A caller on a deadline stops listening the moment the deadline passes,
       so a producer that never closes the pipe cannot keep this read alive
       behind an answer that has already been given. */
    const onAbort = (): void => finish(null);
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > byteLimit) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(collected());
    const onError = (): void => finish(null);
    const timer = setTimeout(() => finish(collected()), timeoutMilliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.resume();
  });
}

/** Parse untrusted text as JSON without throwing. */
export function parseJsonText(text: string | null): JsonText {
  if (text === null) return { ok: false };
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > STDIN_BYTE_LIMIT) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Where a reading came from, stated by the code that actually knows.
 *
 * A parser is handed a payload and cannot tell whether Claude Code piped it in
 * a moment ago or a person pasted it from a chat window last week, and those
 * two readings deserve different words on a card. Only these boundaries know,
 * so the stamp is applied here and the parsers stay pure functions of their
 * input. Every value below is ours: nothing a provider sends can become one.
 */

/** A live Claude Code session payload, arriving on standard input. */
export const STATUSLINE_PROVENANCE: SnapshotProvenance = {
  sourceKind: "statusline_payload",
  observedVia: "claude_code_statusline"
};

/** A live Antigravity CLI session payload, arriving on standard input. */
export const ANTIGRAVITY_STATUSLINE_PROVENANCE: SnapshotProvenance = {
  sourceKind: "statusline_payload",
  observedVia: "local_command"
};

export function parseAntigravityStatuslinePayload(
  payload: unknown,
  now: string
): RawMeter[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const quota = root["quota"];
  if (typeof quota !== "object" || quota === null) return null;

  const meters: RawMeter[] = [];
  for (const [bucketId, bucketVal] of Object.entries(quota as Record<string, unknown>)) {
    if (typeof bucketVal !== "object" || bucketVal === null) continue;
    const b = bucketVal as Record<string, unknown>;

    const remaining = typeof b["remaining_fraction"] === "number"
      ? b["remaining_fraction"]
      : typeof b["remainingFraction"] === "number"
        ? b["remainingFraction"]
        : null;
    if (remaining === null || Number.isNaN(remaining)) continue;
    const fraction = Math.max(0, Math.min(1, remaining));
    const value = Math.round(Math.max(0, Math.min(100, (1 - fraction) * 100)) * 10) / 10;

    let meterCode: string;
    let durationSeconds = 18_000;
    const idLower = bucketId.toLowerCase();
    if (idLower === "gemini-5h" || idLower === "3p-5h" || idLower.endsWith("-5h") || idLower.includes("5h")) {
      meterCode = "FIVE_HOUR";
      durationSeconds = 18_000;
    } else if (
      idLower === "gemini-weekly" ||
      idLower === "3p-weekly" ||
      idLower.endsWith("-weekly") ||
      idLower.includes("weekly") ||
      idLower.includes("7d")
    ) {
      meterCode = "SEVEN_DAY";
      durationSeconds = 604_800;
    } else {
      // Drop unknown bucket IDs; do not fabricate fake meters
      continue;
    }

    const resetTime = typeof b["reset_time"] === "string"
      ? b["reset_time"]
      : typeof b["resetTime"] === "string"
        ? b["resetTime"]
        : null;
    const resetInSeconds = typeof b["reset_in_seconds"] === "number"
      ? b["reset_in_seconds"]
      : typeof b["resetInSeconds"] === "number"
        ? b["resetInSeconds"]
        : null;

    let resetAt: string | undefined = undefined;
    if (resetTime && !Number.isNaN(Date.parse(resetTime))) {
      resetAt = new Date(resetTime).toISOString();
    } else if (resetInSeconds !== null && !Number.isNaN(resetInSeconds) && resetInSeconds >= 0) {
      resetAt = new Date(new Date(now).getTime() + resetInSeconds * 1000).toISOString();
    }

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
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "internal-endpoint",
        automationRisk: "high",
        verification: "UNVERIFIED"
      }
    });
  }

  return meters.length > 0 ? meters : null;
}

/** A live Grok Build session payload, arriving on standard input. */
export const GROK_STATUSLINE_PROVENANCE: SnapshotProvenance = {
  sourceKind: "statusline_payload",
  observedVia: "local_command"
};

/**
 * Parse the JSON Grok Build hands its status line command on standard input.
 *
 * Grok Build documents no payload shape of its own for `[ui.status_line]`
 * (host research, 2026-09-06): the config table only names a command, items
 * and a refresh interval, and the field says "stdin JSON with session
 * fields" with nothing more specific. The one Grok quota shape this codebase
 * has already validated is the session cost payload the network connector
 * reads (`config.currentPeriod`, `config.creditUsagePercent`), so this reuses
 * that parser rather than inventing an unresearched one. Should Grok Build's
 * own status line document turn out to differ, only this function changes.
 */
export function parseGrokStatuslinePayload(
  payload: unknown,
  now: string
): RawMeter[] | null {
  return parseGrokPayload(payload, now);
}

/** A payload a person handed us with `openlimiter ingest`. */
export const INGEST_PROVENANCE: SnapshotProvenance = {
  sourceKind: "explicit_ingest",
  observedVia: "ingest_command"
};

/** The manual quota document, read from the state directory. */
export const MANUAL_PROVENANCE: SnapshotProvenance = {
  sourceKind: "manual_document",
  observedVia: "manual_json"
};

/**
 * A reading this command fetched itself, over the network, just now.
 *
 * The same stamp the desktop writes for the same act, so a row acquired by the
 * terminal and a row acquired by the tray describe themselves identically and
 * a surface never has to know which process was running.
 */
export const ACQUISITION_PROVENANCE: SnapshotProvenance = {
  sourceKind: "remote_api",
  observedVia: "remote_http"
};

/**
 * Stamp provenance onto meters a parser just produced.
 *
 * Applied at the boundary, before normalization, so the normalizer validates
 * the stamp the same way it validates everything else and a stamp this code got
 * wrong is caught rather than trusted.
 */
export function withProvenance(
  meters: readonly RawMeter[],
  provenance: SnapshotProvenance
): RawMeter[] {
  return meters.map((meter) => ({ ...meter, provenance }));
}

function manualFilePath(directory: string | undefined): string {
  return path.join(directory ?? resolveStateDirectory(), MANUAL_FILE_NAME);
}

/**
 * Read the manual quota document from the state directory.
 *
 * The document is untrusted input. It is bounded by size, opened through the
 * same descriptor first read as the cache, and handed to the manual connector
 * for validation. A missing or unreadable file is simply no data.
 */
export async function readManualDocument(
  directory: string | undefined
): Promise<unknown> {
  const document = await readJsonFileSafely(
    manualFilePath(directory),
    MANUAL_FILE_BYTE_LIMIT
  );
  return document.ok ? document.value : undefined;
}

/** Report whether a manual document is present, without reading it. */
export async function manualFilePresent(directory: string | undefined): Promise<boolean> {
  const document = await readJsonFileSafely(
    manualFilePath(directory),
    MANUAL_FILE_BYTE_LIMIT
  );
  return document.ok;
}

/**
 * Build the environment map a connector sees.
 *
 * Local facts that only the CLI can observe become explicit markers, so
 * detection stays a pure function of the environment and doctor never claims a
 * connector is ready when it can receive no data.
 */
export async function environmentWithLocalMarkers(
  environment: Readonly<Record<string, string | undefined>>,
  directory: string | undefined
): Promise<Record<string, string | undefined>> {
  const resolved: Record<string, string | undefined> = { ...environment };
  if (await manualFilePresent(directory)) {
    resolved[MANUAL_FILE_MARKER] = "available";
  } else {
    delete resolved[MANUAL_FILE_MARKER];
  }
  return resolved;
}

/**
 * Merge validated snapshots into the cache.
 *
 * Quota observed by one command stays visible to the next one. The read, the
 * merge, and the write happen under one lock inside the core, so a concurrent
 * writer cannot drop these rows.
 */
export async function persistSnapshots(
  incoming: readonly Snapshot[],
  directory: string | undefined,
  now: string
): Promise<CacheMergeResult> {
  const merged = await mergeSnapshotCache(
    incoming,
    directory ?? resolveStateDirectory()
  );
  await writeAgentContextSnapshot(merged.merged, directory, now);
  return merged;
}
