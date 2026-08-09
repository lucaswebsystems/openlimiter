import {
  PROVIDER_CODES,
  buildAdvice,
  canonicalJson,
  freshness,
  normalizeMeters,
  readSnapshotCache,
  writeSnapshotCache,
  type ProviderCode,
  type Snapshot
} from "@openlimiter/core";
import {
  FIXTURE_NOW,
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
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function defaults(): CliDependencies {
  return {
    environment: process.env,
    credentialStore: new UnavailableCredentialStore(),
    promptForSecret: async () => "",
    now: () => new Date().toISOString(),
    payloads: {}
  };
}

function renderTable(snapshots: readonly Snapshot[], now: string): string {
  if (snapshots.length === 0) return "No bounded quota data is available.";
  const lines = ["PROVIDER METER USAGE STATE RESET"];
  for (const snapshot of snapshots) {
    lines.push([
      snapshot.provider,
      snapshot.meter,
      snapshot.value.toFixed(2) + snapshot.unit,
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

async function refresh(
  dependencies: CliDependencies,
  now: string
): Promise<Snapshot[]> {
  const raw = [];
  for (const connector of connectors) {
    const result = await connector.read({
      payload: dependencies.payloads[connector.id],
      now,
      environment: dependencies.environment
    });
    if (result.ok) raw.push(...result.meters);
  }
  const snapshots = normalizeMeters(raw);
  if (snapshots.length > 0) {
    await writeSnapshotCache(snapshots, dependencies.stateDirectory);
  }
  return snapshots;
}

function demoSnapshots(): Snapshot[] {
  const raw = [
    ...(parseClaudePayload(claudeFixture, FIXTURE_NOW) ?? []),
    ...(parseOpenrouterPayload(openrouterFixture, FIXTURE_NOW) ?? []),
    ...(parseCodexPayload(codexFixture, FIXTURE_NOW) ?? []),
    ...(parseAntigravityPayload(antigravityFixture, FIXTURE_NOW) ?? []),
    ...(parseOpencodePayload(opencodeFixture, FIXTURE_NOW) ?? []),
    ...(parseManualPayload(manualFixture, FIXTURE_NOW) ?? [])
  ];
  return normalizeMeters(raw);
}

function doctorRows(
  snapshots: readonly Snapshot[],
  dependencies: CliDependencies,
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
      connector.detect(dependencies.environment) ? "yes" : "no",
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
  "openlimiter doctor",
  "openlimiter demo",
  "openlimiter export"
].join("\n");

export async function runCli(
  argumentsList: readonly string[],
  overrides: Partial<CliDependencies> = {}
): Promise<CliResult> {
  const dependencies = { ...defaults(), ...overrides };
  const command = argumentsList[0] ?? "help";
  const now = dependencies.now();
  try {
    if (command === "init") {
      const result = await initialize(
        dependencies.environment,
        dependencies.credentialStore,
        dependencies.promptForSecret,
        dependencies.stateDirectory
      );
      const detected = result.config.connectors
        .filter((connector) => connector.detected)
        .map((connector) => connector.id)
        .join(",");
      return {
        exitCode: 0,
        stdout: "Configuration saved. Detected: " + (detected === "" ? "none" : detected),
        stderr: ""
      };
    }
    if (command === "snapshot") {
      const refreshed = argumentsList.includes("--refresh")
        ? await refresh(dependencies, now)
        : [];
      const snapshots = refreshed.length > 0
        ? refreshed
        : await cachedSnapshots(dependencies.stateDirectory);
      return { exitCode: 0, stdout: renderTable(snapshots, now), stderr: "" };
    }
    if (command === "statusline") {
      const snapshots = await cachedSnapshots(dependencies.stateDirectory);
      const advice = buildAdvice(snapshots, now, PROVIDER_CODES);
      return { exitCode: 0, stdout: renderClaudeStatusline(advice), stderr: "" };
    }
    if (command === "hook") {
      const context = await agentContextFromCache(
        dependencies.stateDirectory,
        now,
        PROVIDER_CODES
      );
      return { exitCode: 0, stdout: context, stderr: "" };
    }
    if (command === "doctor") {
      const snapshots = await cachedSnapshots(dependencies.stateDirectory);
      return {
        exitCode: 0,
        stdout: doctorRows(snapshots, dependencies, now),
        stderr: ""
      };
    }
    if (command === "demo") {
      return {
        exitCode: 0,
        stdout: renderTable(demoSnapshots(), FIXTURE_NOW),
        stderr: ""
      };
    }
    if (command === "export") {
      const snapshots = await cachedSnapshots(dependencies.stateDirectory);
      return { exitCode: 0, stdout: canonicalJson(snapshots), stderr: "" };
    }
    return {
      exitCode: command === "help" ? 0 : 1,
      stdout: help,
      stderr: ""
    };
  } catch {
    if (command === "hook") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "statusline") {
      return { exitCode: 0, stdout: "OpenLimiter UNKNOWN", stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: "No bounded quota data is available.",
      stderr: ""
    };
  }
}
