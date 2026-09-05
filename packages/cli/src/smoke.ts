/**
 * The live smoke harness: read this machine's real providers, once, on purpose.
 *
 * Every other test in this repository runs against a frozen fixture, which is
 * the right default and has one blind spot it can never close: a fixture proves
 * the parser reads the shape it was given, and says nothing about whether that
 * shape is still what a provider sends today. This is the one path that answers
 * the other question, and the reason it is a separate command rather than a
 * test is that it needs a real account and produces evidence a human reads.
 *
 * Three rules hold it in place.
 *
 * OFF BY DEFAULT. Nothing here runs unless `OPENLIMITER_LIVE=1` is set in the
 * environment. Without it the command prints one line saying so and exits zero,
 * because a smoke harness that could run by accident in CI is a smoke harness
 * that will one day read somebody's account in CI.
 *
 * NO NETWORK, EVER, FROM HERE. This module opens no sockets. It reads what the
 * real readers already wrote to this machine, and payload FILES a person points
 * it at, and it runs both through the real connector contracts. Fetching would
 * make this a second collection implementation, and a second implementation is
 * exactly what the browser mirror and the desktop reader exist to avoid.
 *
 * NOTHING IDENTIFYING LEAVES. The evidence file carries provider codes, meter
 * codes, numbers, instants and connection states. It carries no token, no
 * email, no key, no account alias and no path. `containsSecret` below is the
 * last gate: it reads the finished document back as text and refuses to write
 * it if anything that looks like a credential or a machine path survived.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectors } from "@openlimiter/connectors";
import {
  connectorMaturity,
  freshness,
  normalizeMeters,
  readSnapshotCache,
  resolveStateDirectory,
  type ConnectionStatus,
  type ProviderCode,
  type Snapshot
} from "@openlimiter/core";

/** The environment variable that turns this on. Nothing else does. */
export const LIVE_ENVIRONMENT_FLAG = "OPENLIMITER_LIVE";

/** What the command prints when the flag is absent. */
export const SKIPPED_NOTE =
  "openlimiter smoke: skipped. Set " + LIVE_ENVIRONMENT_FLAG +
  "=1 to read this machine's real providers.";

/**
 * Where a person points this at a payload they captured themselves.
 *
 * `OPENLIMITER_SMOKE_PAYLOAD_CLAUDE=/path/to/statusline.json` hands that file
 * to the Claude reader. This is how a live response reaches the real parser
 * without this module ever making the call: the person makes it, with their own
 * credential, in their own shell, and hands over the result.
 */
export const PAYLOAD_ENVIRONMENT_PREFIX = "OPENLIMITER_SMOKE_PAYLOAD_";

/** Where the evidence goes, when a person wants it somewhere else. */
export const EVIDENCE_DIRECTORY_ENVIRONMENT = "OPENLIMITER_EVIDENCE_DIR";

/** Largest payload file this harness will read. */
export const MAX_PAYLOAD_BYTES = 262_144;

/**
 * Anything that must never appear in an evidence file.
 *
 * Written as a refusal rather than a redaction on purpose. A redactor that
 * misses a pattern writes the secret; a gate that misses a pattern writes the
 * secret too, but a gate that FIRES is loud, and the failure mode of "we wrote
 * nothing and said why" is the only acceptable one here.
 */
const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{6,}/u],
  ["a bearer token", /\bBearer\s+\S/iu],
  ["an api key", /\b(?:sk|pk|xai|sess)-[A-Za-z0-9]{8,}/u],
  /* Case blind: Windows paths are, so the lower case spelling names the
     same directory and leaks the same name. A case sensitive pattern here
     caught the tidy spelling and let the one a shell prints straight by. */
  ["a windows user path", /[A-Za-z]:\\+Users\\+[^\\\\"]+/iu],
  ["a unix home path", /\/(?:home|Users)\/[^/"]+/u],
  ["an authorization header", /"?authorization"?\s*[:=]/iu],
  ["a cookie", /\b(?:set-)?cookie\b/iu]
];

/** The first thing that must not be here, or null when the text is clean. */
export function containsSecret(text: string): string | null {
  for (const [reason, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/**
 * The directory the evidence is written into.
 *
 * The mission workspace, `launch-2026-09-01/providers`, which sits beside the
 * checkout rather than inside it. It is found by walking up from the repository
 * root, because a worktree may be checked out at `launch-2026-09-01/wt/<lane>`
 * or beside the workspace, and a fixed number of parent steps is right in one
 * of those layouts and silently wrong in the other. The environment variable
 * wins over both, for a person who wants the file somewhere else entirely.
 */
export function evidenceDirectory(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): string {
  const override = environment[EVIDENCE_DIRECTORY_ENVIRONMENT];
  if (override !== undefined && override !== "") return path.resolve(override);
  let directory = path.resolve(repositoryRoot);
  for (let step = 0; step < 6; step += 1) {
    const parent = path.dirname(directory);
    if (parent === directory) break;
    if (path.basename(parent) === "launch-2026-09-01") {
      return path.join(parent, "providers");
    }
    directory = parent;
  }
  return path.resolve(repositoryRoot, "..", "..", "launch-2026-09-01", "providers");
}

/** The evidence file for one provider on one day. */
export function evidenceFileName(provider: ProviderCode, day: string): string {
  return provider.toLowerCase().replace(/_/gu, "-") + "-" + day + ".json";
}

/** The calendar day an instant falls on, in UTC, so a file name never drifts. */
export function evidenceDay(now: string): string {
  const parsed = Date.parse(now);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : "unknown";
}

export interface SmokeMeter {
  readonly meter: string;
  readonly value: number;
  readonly unit: string;
  readonly resetAt: string | null;
  readonly state: "fresh" | "stale" | "unknown";
  readonly source: string;
  readonly precision: string;
}

export interface SmokeProvider {
  readonly provider: ProviderCode;
  readonly connector: string;
  readonly maturity: "stable" | "beta";
  readonly detected: boolean;
  /** Where the reading came from: a payload file, the local cache, or nothing. */
  readonly via: "payload_file" | "snapshot_cache" | "none";
  readonly connection: ConnectionStatus | null;
  readonly meters: readonly SmokeMeter[];
}

/**
 * One printed line per provider per meter, in the shape a human scans.
 *
 * Percent and reset, because those are the two things a person is checking, and
 * nothing else, because every other field on a snapshot is either a constant or
 * a thing that could carry an identity.
 */
export function smokeLine(entry: SmokeProvider, meter: SmokeMeter): string {
  return [
    entry.provider.padEnd(12),
    meter.meter.padEnd(22),
    (meter.value.toFixed(1) + "%").padStart(7),
    meter.state.padEnd(8),
    meter.resetAt ?? "no reset stated"
  ].join(" ");
}

/** The line for a provider that produced nothing, which is still a result. */
export function silentLine(entry: SmokeProvider): string {
  const detail = entry.connection === null
    ? entry.detected ? "detected, no reading" : "not configured"
    : entry.connection.state + ", " + entry.connection.instruction;
  return entry.provider.padEnd(12) + " " + detail;
}

function snapshotMeter(snapshot: Snapshot, now: string): SmokeMeter {
  return {
    meter: snapshot.meter,
    value: snapshot.value,
    unit: snapshot.unit,
    resetAt: snapshot.resetAt,
    state: freshness(snapshot.observedAt, snapshot.expiresAt, now),
    source: snapshot.source,
    precision: snapshot.precision
  };
}

/**
 * The evidence document, with nothing in it that could name a person.
 *
 * Built by naming every field that goes IN rather than by deleting fields that
 * must stay out. An allow list cannot be defeated by a provider adding a field,
 * and a deny list can, which is the whole argument.
 */
export function sanitizeEvidence(
  entry: SmokeProvider,
  now: string
): Record<string, unknown> {
  return {
    schema: "openlimiter.smoke.evidence.v1",
    provider: entry.provider,
    connector: entry.connector,
    maturity: entry.maturity,
    observedAt: now,
    detected: entry.detected,
    readVia: entry.via,
    connection: entry.connection === null
      ? null
      : {
          state: entry.connection.state,
          reason: entry.connection.reason,
          instruction: entry.connection.instruction
        },
    meterCount: entry.meters.length,
    meters: entry.meters.map((meter) => ({
      meter: meter.meter,
      value: meter.value,
      unit: meter.unit,
      resetAt: meter.resetAt,
      state: meter.state,
      source: meter.source,
      precision: meter.precision
    }))
  };
}

/** A payload file a person pointed this harness at, or null. */
async function readPayloadFile(
  connectorId: string,
  encoding: "json" | "text",
  environment: Readonly<Record<string, string | undefined>>
): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string } | null> {
  const key = PAYLOAD_ENVIRONMENT_PREFIX + connectorId.toUpperCase();
  const file = environment[key];
  if (file === undefined || file === "") return null;
  let text: string;
  try {
    text = await readFile(path.resolve(file), "utf8");
  } catch {
    return { ok: false, reason: "could not be read" };
  }
  if (text.length > MAX_PAYLOAD_BYTES) return { ok: false, reason: "is too large" };
  if (encoding === "text") return { ok: true, payload: text };
  try {
    return { ok: true, payload: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
}

export interface SmokeDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly stateDirectory: string;
  readonly now: string;
}

/**
 * Read every provider this machine has, through the real readers.
 *
 * A payload file wins when one was supplied, because that is a reading taken
 * today. Otherwise the local snapshot cache stands in: those rows were written
 * by the real collectors on this machine, so they still answer the question
 * this harness exists for, and the document says which of the two it was.
 */
export async function collectSmoke(
  dependencies: SmokeDependencies
): Promise<readonly SmokeProvider[]> {
  const cached = await readSnapshotCache(dependencies.stateDirectory);
  const cachedRows = cached.ok ? cached.snapshots : [];
  const entries: SmokeProvider[] = [];
  for (const connector of connectors) {
    const provider = connector.id.toUpperCase() as ProviderCode;
    const detected = connector.detect(dependencies.environment);
    const supplied = await readPayloadFile(
      connector.id,
      connector.encoding,
      dependencies.environment
    );
    let connection: ConnectionStatus | null = null;
    let meters: SmokeMeter[] = [];
    let via: SmokeProvider["via"] = "none";
    if (supplied !== null && supplied.ok) {
      const result = await connector.read({
        payload: supplied.payload,
        now: dependencies.now,
        environment: dependencies.environment
      });
      connection = result.connection ?? null;
      if (result.ok) {
        via = "payload_file";
        meters = normalizeMeters(result.meters)
          .map((snapshot) => snapshotMeter(snapshot, dependencies.now));
      }
    }
    if (meters.length === 0) {
      const rows = cachedRows.filter((row) => row.provider === provider);
      if (rows.length > 0) {
        via = "snapshot_cache";
        meters = rows.map((row) => snapshotMeter(row, dependencies.now));
      }
    }
    entries.push({
      provider,
      connector: connector.id,
      maturity: connectorMaturity(connector),
      detected,
      via,
      connection,
      meters
    });
  }
  return entries;
}

export interface SmokeOutcome {
  readonly lines: readonly string[];
  readonly written: readonly string[];
  readonly refused: readonly string[];
}

/**
 * Run the harness and write one evidence file per provider that reported.
 *
 * A provider with no reading writes no file: an evidence file saying nothing
 * happened is a file somebody will one day cite as proof that something did.
 */
export async function runSmoke(
  dependencies: SmokeDependencies,
  directory: string
): Promise<SmokeOutcome> {
  const entries = await collectSmoke(dependencies);
  const lines: string[] = [];
  const written: string[] = [];
  const refused: string[] = [];
  const day = evidenceDay(dependencies.now);
  let created = false;
  for (const entry of entries) {
    if (entry.meters.length === 0) {
      lines.push(silentLine(entry));
      continue;
    }
    for (const meter of entry.meters) lines.push(smokeLine(entry, meter));
    const document = JSON.stringify(sanitizeEvidence(entry, dependencies.now), null, 2);
    const secret = containsSecret(document);
    if (secret !== null) {
      refused.push(entry.provider + ": evidence withheld, it contained " + secret);
      continue;
    }
    if (!created) {
      await mkdir(directory, { recursive: true });
      created = true;
    }
    const file = path.join(directory, evidenceFileName(entry.provider, day));
    await writeFile(file, document + "\n", "utf8");
    written.push(evidenceFileName(entry.provider, day));
  }
  return { lines, written, refused };
}

/**
 * The command, including the half of it that does nothing.
 *
 * Returns the exit code rather than calling `process.exit`, so the whole thing
 * stays testable and the skipped path can be asserted to be exactly what it
 * claims: no reads, no writes, exit zero.
 */
export async function smokeMain(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  write: (line: string) => void = (line) => process.stdout.write(line + "\n")
): Promise<number> {
  if (environment[LIVE_ENVIRONMENT_FLAG] !== "1") {
    write(SKIPPED_NOTE);
    return 0;
  }
  const directory = evidenceDirectory(repositoryRoot, environment);
  const outcome = await runSmoke(
    {
      environment,
      stateDirectory: resolveStateDirectory({ environment }),
      now: new Date().toISOString()
    },
    directory
  );
  write("PROVIDER     METER                  PERCENT STATE    RESETS AT");
  for (const line of outcome.lines) write(line);
  for (const refusal of outcome.refused) write("WITHHELD " + refusal);
  write(
    outcome.written.length === 0
      ? "No evidence written: no provider reported a reading."
      : "Wrote " + String(outcome.written.length) + " evidence file(s): " +
        outcome.written.join(", ")
  );
  return 0;
}
