import {
  PROVIDER_CODES,
  buildAdvice,
  canonicalJson,
  floorFixed,
  freshness,
  mergeSnapshots,
  normalizeMeters,
  readSnapshotCache,
  type ProviderCode,
  type RawMeter,
  type Snapshot
} from "@openlimiter/core";
import {
  antigravityFixture,
  claudeFixture,
  codexFixture,
  connectors,
  manualFixture,
  opencodeFixture,
  openrouterFixture,
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseManualPayload,
  parseOpencodePayload,
  parseOpenrouterPayload
} from "@openlimiter/connectors";
import {
  agentContextFromCache,
  renderClaudeStatusline
} from "@openlimiter/adapters";
import { initialize } from "./config.js";
import {
  environmentWithLocalMarkers,
  parseJsonText,
  persistSnapshots,
  readManualDocument
} from "./ingest.js";
import {
  UnavailableCredentialStore,
  type CredentialStore
} from "./credentials.js";

export interface CliDependencies {
  environment: Readonly<Record<string, string | undefined>>;
  stateDirectory?: string;
  credentialStore: CredentialStore;
  promptForSecret: () => Promise<string>;
  now: () => string;
  payloads: Readonly<Record<string, unknown>>;
  /**
   * Standard input reader.
   *
   * The library default supplies nothing. The executable injects the real
   * reader, which keeps every command deterministic when it is called in
   * process by a test or another tool.
   */
  readStandardInput: () => Promise<string | null>;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Exit codes. Enumerated so a script can tell these cases apart. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_NO_DATA = 3;

function defaults(): CliDependencies {
  return {
    environment: process.env,
    credentialStore: new UnavailableCredentialStore(),
    promptForSecret: async () => "",
    now: () => new Date().toISOString(),
    payloads: {},
    readStandardInput: async () => null
  };
}

function succeed(stdout: string): CliResult {
  return { exitCode: EXIT_OK, stdout, stderr: "" };
}

function fail(exitCode: number, message: string, stdout = ""): CliResult {
  return { exitCode, stdout, stderr: message };
}

function renderTable(snapshots: readonly Snapshot[], now: string): string {
  if (snapshots.length === 0) return "No bounded quota data is available.";
  const lines = ["PROVIDER METER USAGE STATE RESET"];
  for (const snapshot of snapshots) {
    lines.push([
      snapshot.provider,
      snapshot.meter,
      floorFixed(snapshot.value, 2) + snapshot.unit,
      freshness(snapshot.observedAt, snapshot.expiresAt, now),
      snapshot.resetAt ?? "NONE"
    ].join(" "));
  }
  return lines.join("\n");
}

async function cachedSnapshots(directory?: string): Promise<Snapshot[]> {
  const cached = await readSnapshotCache(directory);
  return cached.ok ? cached.snapshots : [];
}

function flagValue(
  argumentsList: readonly string[],
  flag: string
): string | undefined {
  const index = argumentsList.indexOf(flag);
  return index < 0 ? undefined : argumentsList[index + 1];
}

/**
 * Collect meters from every connector.
 *
 * Payloads stay caller supplied. The one local source this command reads on its
 * own is the manual document in the state directory, which is the documented
 * way to feed a provider that has no interface at all.
 */
async function refresh(
  dependencies: CliDependencies,
  now: string
): Promise<Snapshot[]> {
  const supplied = dependencies.payloads["manual"];
  const manual = supplied === undefined
    ? await readManualDocument(dependencies.stateDirectory)
    : supplied;
  const environment = await environmentWithLocalMarkers(
    dependencies.environment,
    dependencies.stateDirectory
  );
  const raw: RawMeter[] = [];
  for (const connector of connectors) {
    const payload = connector.id === "manual"
      ? manual
      : dependencies.payloads[connector.id];
    const result = await connector.read({ payload, now, environment });
    if (result.ok) raw.push(...result.meters);
  }
  const snapshots = normalizeMeters(raw);
  if (snapshots.length === 0) return [];
  return (await persistSnapshots(snapshots, dependencies.stateDirectory)).merged;
}

function demoSnapshots(now: string): Snapshot[] {
  const raw = [
    ...(parseClaudePayload(claudeFixture(now), now) ?? []),
    ...(parseOpenrouterPayload(openrouterFixture(), now) ?? []),
    ...(parseCodexPayload(codexFixture(now), now) ?? []),
    ...(parseAntigravityPayload(antigravityFixture(now), now) ?? []),
    ...(parseOpencodePayload(opencodeFixture(now), now) ?? []),
    ...(parseManualPayload(manualFixture(now), now) ?? [])
  ];
  return normalizeMeters(raw);
}

function doctorRows(
  snapshots: readonly Snapshot[],
  environment: Readonly<Record<string, string | undefined>>,
  now: string
): string {
  const lines = ["CONNECTOR DETECTED FRESHNESS DRIFT"];
  for (const connector of connectors) {
    const provider = connector.id.toUpperCase() as ProviderCode;
    const states = snapshots
      .filter((snapshot) => snapshot.provider === provider)
      .map((snapshot) => freshness(snapshot.observedAt, snapshot.expiresAt, now));
    const state = states.includes("fresh")
      ? "fresh"
      : states.includes("stale")
        ? "stale"
        : "unknown";
    lines.push([
      connector.id,
      connector.detect(environment) ? "yes" : "no",
      state,
      "UNVERIFIED"
    ].join(" "));
  }
  return lines.join("\n");
}

const help = [
  "openlimiter init",
  "openlimiter snapshot [--refresh]",
  "openlimiter statusline",
  "openlimiter hook [--dry-run]",
  "openlimiter ingest [--provider <id>] [--payload <json>]",
  "openlimiter doctor",
  "openlimiter demo",
  "openlimiter export",
  "",
  "statusline and ingest read JSON from standard input when it is piped in.",
  "Exit codes: 0 success, 1 failure, 2 usage, 3 no bounded quota data."
].join("\n");

/**
 * Parse a Claude Code statusline payload from standard input and cache it.
 *
 * This is the path that gives the tool something to meter. It performs no
 * network access at all: it validates the JSON that Claude Code already wrote
 * to this process. Every failure returns null so the caller can fall back to
 * the cache instead of breaking the host tool.
 */
async function ingestStandardInput(
  dependencies: CliDependencies,
  now: string
): Promise<Snapshot[] | null> {
  try {
    const document = parseJsonText(await dependencies.readStandardInput());
    if (!document.ok) return null;
    const meters = parseClaudePayload(document.value, now);
    if (meters === null) return null;
    const incoming = normalizeMeters(meters);
    if (incoming.length === 0) return null;
    try {
      return (await persistSnapshots(incoming, dependencies.stateDirectory)).merged;
    } catch {
      const existing = await cachedSnapshots(dependencies.stateDirectory);
      return mergeSnapshots(existing, incoming);
    }
  } catch {
    return null;
  }
}

async function initCommand(dependencies: CliDependencies): Promise<CliResult> {
  const environment = await environmentWithLocalMarkers(
    dependencies.environment,
    dependencies.stateDirectory
  );
  try {
    const result = await initialize(
      environment,
      dependencies.credentialStore,
      dependencies.promptForSecret,
      dependencies.stateDirectory
    );
    const detected = result.config.connectors
      .filter((connector) => connector.detected)
      .map((connector) => connector.id)
      .join(",");
    return succeed(
      "Configuration saved. Detected: " + (detected === "" ? "none" : detected)
    );
  } catch {
    return fail(EXIT_FAILURE, "openlimiter init: configuration could not be written.");
  }
}

async function snapshotCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[],
  now: string
): Promise<CliResult> {
  if (argumentsList.includes("--refresh")) {
    try {
      await refresh(dependencies, now);
    } catch {
      return fail(EXIT_FAILURE, "openlimiter snapshot: the cache could not be written.");
    }
  }
  const cached = await readSnapshotCache(dependencies.stateDirectory);
  if (!cached.ok && cached.reason !== "missing") {
    return fail(EXIT_FAILURE, "openlimiter snapshot: quota state could not be read.");
  }
  const snapshots = cached.ok ? cached.snapshots : [];
  const stdout = renderTable(snapshots, now);
  return snapshots.length === 0
    ? fail(
        EXIT_NO_DATA,
        "openlimiter snapshot: no bounded quota data is available.",
        stdout
      )
    : succeed(stdout);
}

async function exportCommand(dependencies: CliDependencies): Promise<CliResult> {
  const cached = await readSnapshotCache(dependencies.stateDirectory);
  if (!cached.ok && cached.reason !== "missing") {
    return fail(EXIT_FAILURE, "openlimiter export: quota state could not be read.");
  }
  const snapshots = cached.ok ? cached.snapshots : [];
  const stdout = canonicalJson(snapshots);
  return snapshots.length === 0
    ? fail(
        EXIT_NO_DATA,
        "openlimiter export: no bounded quota data is available.",
        stdout
      )
    : succeed(stdout);
}

async function doctorCommand(
  dependencies: CliDependencies,
  now: string
): Promise<CliResult> {
  const environment = await environmentWithLocalMarkers(
    dependencies.environment,
    dependencies.stateDirectory
  );
  const cached = await readSnapshotCache(dependencies.stateDirectory);
  const snapshots = cached.ok ? cached.snapshots : [];
  const status = cached.ok ? "ok" : cached.reason;
  const dropped = cached.ok ? cached.dropped : 0;
  const stdout = doctorRows(snapshots, environment, now) +
    "\nCACHE " + status + " DROPPED " + String(dropped);
  if (!cached.ok && cached.reason !== "missing") {
    return fail(EXIT_FAILURE, "openlimiter doctor: quota state could not be read.", stdout);
  }
  return succeed(stdout);
}

/**
 * Accept quota data from any script or agent.
 *
 * Without a provider flag the document is a manual quota document, the same
 * shape the manual connector reads from disk. With a provider flag the document
 * is handed to that connector's own parser, so the resulting snapshot keeps
 * that connector's honest labels. Nothing here reaches the network.
 */
async function ingestCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[],
  now: string
): Promise<CliResult> {
  const provider = flagValue(argumentsList, "--provider");
  const inline = flagValue(argumentsList, "--payload");
  if (argumentsList.includes("--provider") && provider === undefined) {
    return fail(EXIT_USAGE, "openlimiter ingest: the provider flag needs a value.");
  }
  if (argumentsList.includes("--payload") && inline === undefined) {
    return fail(EXIT_USAGE, "openlimiter ingest: the payload flag needs a value.");
  }
  const text = inline ?? await dependencies.readStandardInput();
  const document = parseJsonText(text);
  if (!document.ok) {
    return text === null || text.trim() === ""
      ? fail(EXIT_USAGE, "openlimiter ingest: no input was supplied on standard input.")
      : fail(EXIT_FAILURE, "openlimiter ingest: input is not valid JSON.");
  }
  let meters: readonly RawMeter[] | null;
  if (provider === undefined) {
    meters = parseManualPayload(document.value, now);
  } else {
    const connector = connectors.find((candidate) => candidate.id === provider);
    if (connector === undefined) {
      return fail(EXIT_USAGE, "openlimiter ingest: unknown provider.");
    }
    const result = await connector.read({
      payload: document.value,
      now,
      environment: dependencies.environment
    });
    meters = result.ok ? result.meters : null;
  }
  const incoming = meters === null ? [] : normalizeMeters([...meters]);
  if (incoming.length === 0) {
    return fail(
      EXIT_FAILURE,
      "openlimiter ingest: no bounded meter survived validation."
    );
  }
  try {
    const persisted = await persistSnapshots(incoming, dependencies.stateDirectory);
    return succeed(
      "Ingested " + String(incoming.length) +
      " bounded meters. Cached meters: " + String(persisted.merged.length) + "."
    );
  } catch {
    return fail(EXIT_FAILURE, "openlimiter ingest: the cache could not be written.");
  }
}

export async function runCli(
  argumentsList: readonly string[],
  overrides: Partial<CliDependencies> = {}
): Promise<CliResult> {
  const dependencies = { ...defaults(), ...overrides };
  const command = argumentsList[0] ?? "help";
  const now = dependencies.now();
  try {
    if (command === "init") return await initCommand(dependencies);
    if (command === "snapshot") {
      return await snapshotCommand(dependencies, argumentsList, now);
    }
    if (command === "statusline") {
      const ingested = await ingestStandardInput(dependencies, now);
      const snapshots = ingested ?? await cachedSnapshots(dependencies.stateDirectory);
      return succeed(
        renderClaudeStatusline(buildAdvice(snapshots, now, PROVIDER_CODES))
      );
    }
    if (command === "hook") {
      return succeed(await agentContextFromCache(
        dependencies.stateDirectory,
        now,
        PROVIDER_CODES
      ));
    }
    if (command === "doctor") return await doctorCommand(dependencies, now);
    if (command === "demo") return succeed(renderTable(demoSnapshots(now), now));
    if (command === "export") return await exportCommand(dependencies);
    if (command === "ingest") {
      return await ingestCommand(dependencies, argumentsList, now);
    }
    if (command === "help" || command === "--help" || command === "-h") {
      return succeed(help);
    }
    return fail(EXIT_USAGE, "openlimiter: unknown command.", help);
  } catch {
    /*
     * The hook and statusline paths are invoked by another tool. They report
     * nothing rather than breaking their host. Every other command surfaces the
     * failure with a redacted message so a script can react to it.
     */
    if (command === "hook") return { exitCode: EXIT_OK, stdout: "", stderr: "" };
    if (command === "statusline") {
      return { exitCode: EXIT_OK, stdout: "OpenLimiter UNKNOWN", stderr: "" };
    }
    return fail(EXIT_FAILURE, "openlimiter: the command did not complete.");
  }
}
