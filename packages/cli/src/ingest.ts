import path from "node:path";
import {
  MANUAL_FILE_MARKER,
  MANUAL_FILE_NAME
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

/** Largest document accepted on standard input. */
export const STDIN_BYTE_LIMIT = 262_144;

/** Hard ceiling on how long a command waits for standard input. */
export const STDIN_TIMEOUT_MILLISECONDS = 500;

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
  timeoutMilliseconds = STDIN_TIMEOUT_MILLISECONDS
): Promise<string | null> {
  if (stream.isTTY === true) return null;
  return await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const collected = (): string | null =>
      chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8");
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
      resolve(value);
    };
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
  directory: string | undefined
): Promise<CacheMergeResult> {
  return await mergeSnapshotCache(
    incoming,
    directory ?? resolveStateDirectory()
  );
}
