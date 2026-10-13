import { createHash } from "node:crypto";
import path from "node:path";
import {
  MANUAL_FILE_MARKER,
  MANUAL_FILE_NAME,
  parseAntigravityPayload,
  parseGrokPayload
} from "@openlimiter/connectors";
import { stat, unlink } from "node:fs/promises";
import {
  canonicalJson,
  errorClassOf,
  mergeSnapshotCache,
  opaqueAccountId,
  readJsonFileSafely,
  resolveStateDirectory,
  withStateLock,
  writeFileAtomically,
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
    let total = 0;
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
      const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (length > STDIN_BYTE_LIMIT - total) {
        chunks.length = 0;
        finish();
        stream.destroy();
        return;
      }
      total += length;
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
        stream.destroy();
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
  observedVia: "antigravity_cli_statusline"
};

/** Account identity Antigravity documents in the same invocation payload. */
export function antigravityStatuslineAccount(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const email = (payload as Record<string, unknown>)["email"];
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return null;
  }
  return opaqueAccountId("ANTIGRAVITY", normalized);
}

export function parseAntigravityStatuslinePayload(
  payload: unknown,
  now: string
): RawMeter[] | null {
  return parseAntigravityPayload(payload, now);
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

/** The file that remembers the last status line write that failed, for doctor. */
export const STATUSLINE_FAILURE_NAME = "openlimiter-statusline-failure.json";

/**
 * Which write failed: reading the payload, the cache, or the agent context
 * export that follows a cache write.
 */
export const STATUSLINE_FAILURE_STAGES = ["ingest", "cache_write", "agent_context"] as const;
export type StatuslineFailureStage = (typeof STATUSLINE_FAILURE_STAGES)[number];

export interface StatuslineFailure {
  readonly at: string;
  readonly stage: StatuslineFailureStage;
  /** A code, never the message: a message can carry a path or a token. */
  readonly errorClass: string;
}

/**
 * Remember a status line write that failed. The status line itself must still
 * draw, so nobody is told at the time; doctor reads it back. Best effort,
 * because a machine that cannot write its cache may not write this either.
 */
export async function recordStatuslineFailure(directory: string | undefined, now: string, stage: StatuslineFailureStage, error: unknown): Promise<void> {
  await writeFileAtomically(
    path.join(directory ?? resolveStateDirectory(), STATUSLINE_FAILURE_NAME),
    canonicalJson({ at: now, errorClass: errorClassOf(error), stage, version: 1 })
  ).catch(() => undefined);
}

/** The last status line write failure, if one is still on record. */
export async function readStatuslineFailure(directory: string | undefined): Promise<StatuslineFailure | null> {
  const document = await readJsonFileSafely(path.join(directory ?? resolveStateDirectory(), STATUSLINE_FAILURE_NAME), 4_096);
  if (!document.ok || typeof document.value !== "object" || document.value === null) return null;
  const { at, stage, errorClass } = document.value as Record<string, unknown>;
  return typeof at === "string" && Number.isFinite(Date.parse(at)) &&
    (STATUSLINE_FAILURE_STAGES as readonly unknown[]).includes(stage) &&
    typeof errorClass === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(errorClass)
    ? { at, stage: stage as StatuslineFailureStage, errorClass }
    : null;
}

/**
 * When each Claude Code reading first arrived, newest first, so a rerun keeps it.
 *
 * Only digests of the session id and of the reading are kept, never either
 * one itself, and only the last CLAUDE_READINGS_LIMIT of them.
 */
export const CLAUDE_READINGS_FILE_NAME = "openlimiter-claude-readings.json";
export const CLAUDE_READINGS_LIMIT = 64;

interface ClaudeReading {
  readonly session: string;
  readonly reading: string;
  readonly observedAt: string;
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

async function readClaudeReadings(file: string): Promise<ClaudeReading[]> {
  const document = await readJsonFileSafely(file, 65_536);
  const readings = document.ok ? objectField(document.value)["readings"] : undefined;
  if (!Array.isArray(readings)) return [];
  return readings.slice(0, CLAUDE_READINGS_LIMIT).filter((entry): entry is ClaudeReading => {
    const { session, reading, observedAt } = objectField(entry);
    return typeof session === "string" && /^[0-9a-f]{32}$/u.test(session) &&
      typeof reading === "string" && /^[0-9a-f]{32}$/u.test(reading) &&
      typeof observedAt === "string" && observedAt.length <= 64 && Number.isFinite(Date.parse(observedAt));
  });
}

/** The transcript's last write, capped at now, or null when it cannot be read. */
async function transcriptWritten(value: unknown, now: string): Promise<string | null> {
  /* Only a local absolute path is looked at, never a network share. */
  if (typeof value !== "string" || value.length > 4_096 || !path.isAbsolute(value) || /^[\\/]{2}/u.test(value)) return null;
  try {
    const info = await stat(value);
    return info.isFile() && Number.isFinite(info.mtimeMs)
      ? new Date(Math.min(info.mtimeMs, Date.parse(now))).toISOString()
      : null;
  } catch {
    return null;
  }
}

/**
 * When the reading in a Claude Code status line payload was observed.
 *
 * Claude Code reruns an idle window's status line on a timer and hands it the
 * rate limits its last API response carried. A rerun is not a new reading,
 * and stamping it with the render's clock let an old number replace a newer
 * poll. So the time is the API response's, never the render's: a session whose
 * API time and rate limits are unchanged keeps the time stored when they first
 * appeared; a session seen for the first time takes its transcript's last
 * write, capped at now; anything else is a new response, now. The log is
 * written only when a reading is new, under the state lock, and a failure
 * falls back to the transcript rather than to now.
 */
export async function observedClaudeReading(
  meters: readonly RawMeter[],
  payload: unknown,
  now: string,
  directory: string
): Promise<RawMeter[]> {
  const root = objectField(payload);
  const firstSight = async (): Promise<string> =>
    await transcriptWritten(root["transcript_path"], now) ?? now;
  const sessionId = root["session_id"];
  let observedAt: string;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) {
    observedAt = await firstSight();
  } else {
    const session = digest(sessionId);
    const reading = digest(canonicalJson({
      api: objectField(root["cost"])["total_api_duration_ms"] ?? null,
      limits: root["rate_limits"] ?? null
    }));
    const file = path.join(directory, CLAUDE_READINGS_FILE_NAME);
    const stored = (entries: readonly ClaudeReading[]): string | undefined =>
      entries.find((entry) => entry.session === session && entry.reading === reading)?.observedAt;
    const known = stored(await readClaudeReadings(file));
    try {
      observedAt = known ?? await withStateLock(directory, async () => {
        const entries = await readClaudeReadings(file);
        const again = stored(entries);
        if (again !== undefined) return again;
        const time = entries.some((entry) => entry.session === session) ? now : await firstSight();
        await writeFileAtomically(file, canonicalJson({
          readings: [{ observedAt: time, reading, session }, ...entries].slice(0, CLAUDE_READINGS_LIMIT),
          version: 1
        }));
        return time;
      });
    } catch {
      observedAt = await firstSight();
    }
    if (Date.parse(observedAt) > Date.parse(now)) observedAt = now;
  }
  if (observedAt === now) return [...meters];
  const shift = Date.parse(observedAt) - Date.parse(now);
  return meters.map((meter) => ({
    ...meter,
    observedAt,
    expiresAt: typeof meter.expiresAt === "string"
      ? new Date(Date.parse(meter.expiresAt) + shift).toISOString()
      : meter.expiresAt
  }));
}

/** Forget it, which a status line write that fully succeeded is the proof of. */
export async function clearStatuslineFailure(directory: string | undefined): Promise<void> {
  await unlink(path.join(directory ?? resolveStateDirectory(), STATUSLINE_FAILURE_NAME)).catch(() => undefined);
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
    directory ?? resolveStateDirectory(),
    Date.parse(now)
  );
  await writeAgentContextSnapshot(merged.merged, directory, now);
  return merged;
}
