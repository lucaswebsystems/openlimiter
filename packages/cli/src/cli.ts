import {
  PROVIDER_CODES,
  buildAdvice,
  canonicalJson,
  dedupeFailures,
  failureFromConnectorReason,
  freshness,
  mergeSnapshots,
  normalizeMeters,
  normalizeMetersReport,
  readSnapshotCache,
  type CacheReadResult,
  type FailureCategory,
  type ProviderCode,
  type ProviderFailure,
  type RawMeter,
  type Snapshot
} from "@openlimiter/core";
import {
  antigravityFixture,
  claudeFixture,
  codexFixture,
  grokFixture,
  kimiFixture,
  connectors,
  manualFixture,
  opencodeFixture,
  openrouterFixture,
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseGrokPayload,
  parseKimiPayload,
  parseManualPayload,
  parseOpencodePayload,
  parseOpenrouterPayload
} from "@openlimiter/connectors";
import {
  AGENT_COMPATIBILITY,
  agentContextFromCache,
  agentContextSpillFromCache,
  agentVersionCompatibility,
  changeAgentHook,
  detectAgentInstallation,
  readAgentHookStatus,
  runAgentHook,
  validateAgentExecutableStamp,
  writeAgentContextSnapshot,
  type AgentId,
  type AgentInstallation,
  type HostedContextTrust,
  type HostedTrustLoadOptions,
  loadHostedContextTrust,
  renderClaudeStatusline
} from "@openlimiter/adapters";
import { homedir } from "node:os";
import {
  STATUSLINE_KEYS,
  defaultConfig,
  initialize,
  isStatuslineKey,
  readConfig,
  readStatuslineConfig,
  setStatuslineValue,
  statuslineValueText,
  writeConfig,
  type StatuslineConfig,
  type StatuslineKey
} from "./config.js";
import {
  INGEST_PROVENANCE,
  MANUAL_PROVENANCE,
  STATUSLINE_PROVENANCE,
  environmentWithLocalMarkers,
  STDIN_BYTE_LIMIT,
  parseJsonText,
  persistSnapshots,
  readManualDocument,
  withProvenance
} from "./ingest.js";
import {
  UnavailableCredentialStore,
  type CredentialStore
} from "./credentials.js";
import {
  DEFAULT_SERVE_PORT,
  serveBanner,
  startQuotaServer,
  type QuotaServerHandle
} from "./serve.js";
import {
  failureLine,
  failureLines,
  renderTable,
  supportsColor
} from "./render.js";
import {
  renderStatuslineLayout,
  statuslineColor
} from "./statusline.js";

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
  readStandardInput: (signal?: AbortSignal) => Promise<string | null>;
  /**
   * Whether output may carry terminal colour.
   *
   * Two surfaces depend on it. The QR symbol the serve command prints has to
   * state its own black and white, because a dark themed terminal would
   * otherwise invert it and no camera would read it. The meter bars and the
   * failure lines use it to choose between escape codes and plain ASCII, so a
   * capture redirected into a file carries no control characters at all.
   */
  colorOutput: boolean;
  homeDirectory: string;
  openLimiterScript: string;
  nodeExecutable: string;
  platform: NodeJS.Platform;
  detectedAgentInstallations: Readonly<Partial<Record<AgentId, AgentInstallation | null>>>;
  hostedContextTrust?: HostedContextTrust;
  hostedContextPublicKeys?: HostedTrustLoadOptions["pinnedPublicKeys"];
  hostedTrustConfigRoot?: string;
  /**
   * How the Windows owner and permissions of the trust file are read.
   *
   * The library default asks the operating system. A test injects a recorded
   * answer instead, so a hostile ownership case can be proved without touching
   * the security of a real file.
   */
  hostedTrustWindowsSecurity?: HostedTrustLoadOptions["windowsSecurity"];
  /**
   * Called once the serve command is listening.
   *
   * The serve command never returns on its own, so this is the seam a test or
   * a parent process uses to reach the handle and close it again.
   */
  onListening?: (handle: QuotaServerHandle) => void;
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
    readStandardInput: async () => null,
    colorOutput: supportsColor(process.env, process.stdout.isTTY === true),
    homeDirectory: homedir(),
    openLimiterScript: process.argv[1] ?? "",
    nodeExecutable: process.execPath,
    platform: process.platform,
    detectedAgentInstallations: {}
  };
}

function succeed(stdout: string): CliResult {
  return { exitCode: EXIT_OK, stdout, stderr: "" };
}

async function resolvedHostedTrust(
  dependencies: CliDependencies,
  now: string,
  signal?: AbortSignal
): Promise<HostedContextTrust | undefined> {
  if (dependencies.hostedContextTrust !== undefined) {
    return dependencies.hostedContextTrust;
  }
  return await loadHostedContextTrust({
    homeDirectory: dependencies.homeDirectory,
    platform: dependencies.platform,
    now,
    ...(signal === undefined ? {} : { signal }),
    ...(dependencies.hostedContextPublicKeys === undefined
      ? {}
      : { pinnedPublicKeys: dependencies.hostedContextPublicKeys }),
    ...(dependencies.hostedTrustConfigRoot === undefined
      ? {}
      : { trustedPlatformConfigRoot: dependencies.hostedTrustConfigRoot }),
    ...(dependencies.hostedTrustWindowsSecurity === undefined
      ? {}
      : { windowsSecurity: dependencies.hostedTrustWindowsSecurity })
  });
}

function fail(exitCode: number, message: string, stdout = ""): CliResult {
  return { exitCode, stdout, stderr: message };
}

/** Fold red failure lines onto the end of a block of output. */
function withFailures(
  body: string,
  failures: readonly ProviderFailure[],
  color: boolean
): string {
  if (failures.length === 0) return body;
  return [body, ...failureLines(dedupeFailures(failures), color)].join("\n");
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

export interface RefreshResult {
  snapshots: Snapshot[];
  /** Only genuine failures. A connector offered nothing is not one. */
  failures: readonly ProviderFailure[];
}

/**
 * Collect meters from every connector.
 *
 * Payloads stay caller supplied. The one local source this command reads on its
 * own is the manual document in the state directory, which is the documented
 * way to feed a provider that has no interface at all.
 *
 * A connector that was handed nothing is not a failure and is never reported as
 * one: nothing was offered, so nothing could fail. A connector that was handed
 * something and refused it is a failure, and so is a meter that a connector
 * recognised and the normalizer then threw out. Those two are the only things
 * the human surfaces ever claim went wrong, because they are the only two this
 * code can actually tell apart.
 */
async function refresh(
  dependencies: CliDependencies,
  now: string
): Promise<RefreshResult> {
  const supplied = dependencies.payloads["manual"];
  const manual = supplied === undefined
    ? await readManualDocument(dependencies.stateDirectory)
    : supplied;
  /*
   * The manual connector is the only one this command reads from disk on its
   * own, so it is the only one whose provenance is the document. Everything
   * else here was handed in by a caller, which is an import by any other name.
   */
  const manualFromDisk = supplied === undefined;
  const environment = await environmentWithLocalMarkers(
    dependencies.environment,
    dependencies.stateDirectory
  );
  const raw: RawMeter[] = [];
  const failures: ProviderFailure[] = [];
  for (const connector of connectors) {
    const payload = connector.id === "manual"
      ? manual
      : dependencies.payloads[connector.id];
    const result = await connector.read({ payload, now, environment });
    if (result.ok) {
      const provenance = connector.id === "manual" && manualFromDisk
        ? MANUAL_PROVENANCE
        : INGEST_PROVENANCE;
      raw.push(...withProvenance(result.meters, provenance));
      continue;
    }
    if (payload === undefined) continue;
    failures.push({
      provider: connector.id.toUpperCase() as ProviderCode,
      category: failureFromConnectorReason(result.reason)
    });
  }
  const report = normalizeMetersReport(raw);
  for (const provider of report.rejected) {
    failures.push({ provider, category: "VALIDATION_REJECTED" });
  }
  if (report.snapshots.length === 0) return { snapshots: [], failures };
  const persisted = await persistSnapshots(
    report.snapshots,
    dependencies.stateDirectory,
    now
  );
  return { snapshots: persisted.merged, failures };
}

function demoSnapshots(now: string): Snapshot[] {
  const raw = [
    ...(parseClaudePayload(claudeFixture(now), now) ?? []),
    ...(parseOpenrouterPayload(openrouterFixture(), now) ?? []),
    ...(parseCodexPayload(codexFixture(now), now) ?? []),
    ...(parseGrokPayload(grokFixture(now), now) ?? []),
    ...(parseKimiPayload(kimiFixture(now), now) ?? []),
    ...(parseAntigravityPayload(antigravityFixture(now), now) ?? []),
    ...(parseOpencodePayload(opencodeFixture(now), now) ?? []),
    ...(parseManualPayload(manualFixture(now), now) ?? [])
  ];
  return normalizeMeters(withProvenance(raw, INGEST_PROVENANCE));
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
  "openlimiter hooks install <agent>",
  "openlimiter hooks uninstall <agent>",
  "openlimiter hooks status <agent>",
  "openlimiter hooks repair <agent>",
  "openlimiter status --agent-context",
  "openlimiter ingest [--provider <id>] [--payload <json>]",
  "openlimiter config get statusline[.<key>]",
  "openlimiter config set statusline.<key> <value>",
  "openlimiter doctor",
  "openlimiter demo",
  "openlimiter export",
  "openlimiter serve [--port <n>] [--host <address>] [--no-qr]",
  "",
  "statusline keys: " + STATUSLINE_KEYS.join(", ") + ".",
  "statusline and ingest read JSON from standard input when it is piped in.",
  "serve publishes read only quota on your local network, behind a token that",
  "changes on every start. It is for a trusted network, not the internet.",
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
    /* Claude Code wrote this to our standard input in this session. It is the
       one live reading the product currently has, and it says so. */
    const incoming = normalizeMeters(withProvenance(meters, STATUSLINE_PROVENANCE));
    if (incoming.length === 0) return null;
    try {
      return (await persistSnapshots(incoming, dependencies.stateDirectory, now)).merged;
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
  let failures: readonly ProviderFailure[] = [];
  if (argumentsList.includes("--refresh")) {
    try {
      failures = (await refresh(dependencies, now)).failures;
    } catch {
      return fail(EXIT_FAILURE, "openlimiter snapshot: the cache could not be written.");
    }
  }
  const cached = await readSnapshotCache(dependencies.stateDirectory);
  if (!cached.ok && cached.reason !== "missing") {
    await writeAgentContextSnapshot(
      [],
      dependencies.stateDirectory,
      now,
      PROVIDER_CODES
    ).catch(() => undefined);
    return fail(EXIT_FAILURE, "openlimiter snapshot: quota state could not be read.");
  }
  const snapshots = cached.ok ? cached.snapshots : [];
  try {
    await writeAgentContextSnapshot(
      snapshots,
      dependencies.stateDirectory,
      now,
      PROVIDER_CODES
    );
  } catch {
    return fail(EXIT_FAILURE, "openlimiter snapshot: agent context could not be written.");
  }
  const stdout = withFailures(
    renderTable(snapshots, now, dependencies.colorOutput),
    failures,
    dependencies.colorOutput
  );
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

/** The label a cache level failure is printed against, in place of a provider. */
const CACHE_SUBJECT = "CACHE";

/**
 * What doctor can honestly say went wrong.
 *
 * The cache is the only thing this command reads, so it is the only thing it
 * reports on, and it reports against the cache rather than against a provider
 * because it cannot know which provider a corrupt file was going to name. A
 * cache that would not parse is unreadable, a cache that parsed with rows
 * thrown out is a validation rejection, and a cache that is simply not there
 * yet is neither: it is a tool that has not been given anything.
 */
function cacheFailureCategory(
  cached: CacheReadResult
): FailureCategory | null {
  if (!cached.ok) {
    return cached.reason === "missing" ? null : "PAYLOAD_UNREADABLE";
  }
  return cached.dropped === 0 ? null : "VALIDATION_REJECTED";
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
  const lines = [
    doctorRows(snapshots, environment, now),
    "CACHE " + status + " DROPPED " + String(dropped)
  ];
  const category = cacheFailureCategory(cached);
  if (category !== null) {
    lines.push(failureLine(CACHE_SUBJECT, category, dependencies.colorOutput));
  }
  const stdout = lines.join("\n");
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
  if (text === null || text.trim() === "") {
    return fail(EXIT_USAGE, "openlimiter ingest: no input was supplied on standard input.");
  }
  /*
   * The connector says what its payload IS, and this boundary obeys it.
   *
   * Assuming JSON here made the OpenCode reader unreachable from this command
   * entirely: its payload is a logged in HTML page, so every real capture died
   * at JSON.parse with "input is not valid JSON" and no page could ever be
   * ingested. A text connector is handed the raw text, bounded exactly as the
   * JSON path is bounded, and nothing is parsed on its behalf.
   */
  let meters: readonly RawMeter[] | null;
  if (provider === undefined) {
    const document = parseJsonText(text);
    if (!document.ok) {
      return fail(EXIT_FAILURE, "openlimiter ingest: input is not valid JSON.");
    }
    meters = parseManualPayload(document.value, now);
  } else {
    const connector = connectors.find((candidate) => candidate.id === provider);
    if (connector === undefined) {
      return fail(EXIT_USAGE, "openlimiter ingest: unknown provider.");
    }
    let payload: unknown;
    if (connector.encoding === "text") {
      if (text.length > STDIN_BYTE_LIMIT) {
        return fail(EXIT_FAILURE, "openlimiter ingest: input is larger than accepted.");
      }
      payload = text;
    } else {
      const document = parseJsonText(text);
      if (!document.ok) {
        return fail(EXIT_FAILURE, "openlimiter ingest: input is not valid JSON.");
      }
      payload = document.value;
    }
    const result = await connector.read({
      payload,
      now,
      environment: dependencies.environment
    });
    meters = result.ok ? result.meters : null;
  }
  /*
   * However this document reached the command, a person handed it over. It is
   * an import, not a live reading, whichever connector parsed it, and a card
   * that showed it as live would be the exact claim this wave exists to stop.
   */
  const incoming = meters === null
    ? []
    : normalizeMeters(withProvenance(meters, INGEST_PROVENANCE));
  if (incoming.length === 0) {
    return fail(
      EXIT_FAILURE,
      "openlimiter ingest: no bounded meter survived validation."
    );
  }
  try {
    const persisted = await persistSnapshots(incoming, dependencies.stateDirectory, now);
    return succeed(
      "Ingested " + String(incoming.length) +
      " bounded meters. Cached meters: " + String(persisted.merged.length) + "."
    );
  } catch {
    return fail(EXIT_FAILURE, "openlimiter ingest: the cache could not be written.");
  }
}

/**
 * Draw the statusline.
 *
 * Standard input first, so a Claude Code session payload is ingested and drawn
 * in the same call, then the cache. The layout comes from the configuration
 * file and the fallback is the layout's own default, so a machine with no
 * configuration still gets bars.
 *
 * `bars false` hands the whole job back to the adapter that produced the 0.1.0
 * line. That path is byte for byte what it always was, which is the point of
 * keeping it: it is the escape hatch for anything already parsing this output.
 */
async function statuslineCommand(
  dependencies: CliDependencies,
  now: string
): Promise<CliResult> {
  const ingested = await ingestStandardInput(dependencies, now);
  const snapshots = ingested ?? await cachedSnapshots(dependencies.stateDirectory);
  if (ingested === null) {
    await writeAgentContextSnapshot(
      snapshots,
      dependencies.stateDirectory,
      now,
      PROVIDER_CODES
    ).catch(() => undefined);
  }
  const advice = buildAdvice(snapshots, now, PROVIDER_CODES);
  const config = await readStatuslineConfig(dependencies.stateDirectory);
  if (!config.bars) return succeed(renderClaudeStatusline(advice));
  return succeed(renderStatuslineLayout({
    advice,
    snapshots,
    now,
    config,
    color: statuslineColor(
      config.color,
      dependencies.environment,
      dependencies.colorOutput
    )
  }));
}

const agentAliases: Readonly<Record<string, AgentId>> = {
  agy: "antigravity",
  antigravity: "antigravity",
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  grok: "grok",
  "grok-build": "grok",
  kimi: "kimi",
  opencode: "opencode"
};

function agentArgument(value: string | undefined): AgentId | null {
  return value === undefined ? null : agentAliases[value.toLowerCase()] ?? null;
}

async function hookProtocolCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[],
  now: string
): Promise<CliResult> {
  const agentFlag = flagValue(argumentsList, "--agent");
  if (agentFlag === undefined) {
    const hostedTrust = await resolvedHostedTrust(dependencies, now);
    return succeed(await agentContextFromCache(
      dependencies.stateDirectory,
      now,
      PROVIDER_CODES,
      hostedTrust === undefined ? {} : { hostedTrust }
    ));
  }
  const agent = agentArgument(agentFlag);
  const hostVersion = flagValue(argumentsList, "--host-version");
  if (agent === null || hostVersion === undefined) return succeed("");
  if (
    agent === "opencode" &&
    dependencies.environment["OPENLIMITER_EXPERIMENTAL_OPENCODE"] !== "1"
  ) return succeed("");
  const fallback = (): CliResult => succeed(runAgentHook({
    agent,
    hostVersion,
    rawInput: null,
    context: ""
  }).stdout);
  /*
   * The deadline both chooses the answer and cancels the work behind it.
   * Racing alone left the loser running, so a slow read could still reach the
   * context cache and rewrite a spill file long after the host had been given
   * its reply. Every step below sees the same signal and stops at it.
   */
  const deadline = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CliResult>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      resolve(fallback());
    }, 450);
  });
  const work = (async (): Promise<CliResult> => {
    if (flagValue(argumentsList, "--managed-hook") === "openlimiter-v1") {
      const executable = flagValue(argumentsList, "--agent-executable");
      const fileSize = Number(flagValue(argumentsList, "--agent-file-size"));
      const mtime = Number(flagValue(argumentsList, "--agent-mtime-ms"));
      if (
        executable === undefined ||
        !(await validateAgentExecutableStamp(executable, fileSize, mtime))
      ) return fallback();
    }
    const rawInput = await dependencies.readStandardInput(deadline.signal);
    if (deadline.signal.aborted) return fallback();
    const hostedTrust = await resolvedHostedTrust(dependencies, now, deadline.signal);
    if (deadline.signal.aborted) return fallback();
    const context = await agentContextFromCache(
      dependencies.stateDirectory,
      now,
      PROVIDER_CODES,
      {
        ...(hostedTrust === undefined ? {} : { hostedTrust }),
        signal: deadline.signal
      }
    );
    return succeed(runAgentHook({ agent, hostVersion, rawInput, context }).stdout);
  })();
  /* The race still sees a failure that arrives in time. This second handler
     only keeps a failure that arrives too late from becoming an unhandled
     rejection in the host process. */
  void work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    deadline.abort();
  }
}

async function hooksCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[]
): Promise<CliResult> {
  const requestedAction = argumentsList[1];
  const action = requestedAction === "repair" ? "install" : requestedAction;
  const agent = agentArgument(argumentsList[2]);
  if (
    (action !== "install" && action !== "uninstall" && action !== "status") ||
    agent === null
  ) {
    return fail(
      EXIT_USAGE,
      "openlimiter hooks: use install, uninstall, status, or repair with a known agent."
    );
  }
  if (action === "status") {
    const status = await readAgentHookStatus(agent, {
      homeDirectory: dependencies.homeDirectory
    });
    const hasKnownInstallation = Object.prototype.hasOwnProperty.call(
      dependencies.detectedAgentInstallations,
      agent
    );
    const installation = hasKnownInstallation
      ? dependencies.detectedAgentInstallations[agent] ?? null
      : await detectAgentInstallation(agent, {
          environment: dependencies.environment,
          platform: dependencies.platform
        });
    const gate = AGENT_COMPATIBILITY[agent];
    const compatibility = installation === null
      ? null
      : agentVersionCompatibility(agent, installation.version);
    const location = status.configPath ?? "NONE";
    return succeed([
      "agent=" + agent,
      "installed=" + (status.installed ? "yes" : "no"),
      "config=" + location,
      ...(compatibility === "newer" && gate.minimumTestedVersion !== null
        ? [
            "warning=detected version " + installation!.version +
              " is newer than minimum tested " + gate.minimumTestedVersion
          ]
        : [])
    ].join("\n"));
  }
  const knownInstallation = Object.prototype.hasOwnProperty.call(
    dependencies.detectedAgentInstallations,
    agent
  ) ? dependencies.detectedAgentInstallations[agent] : undefined;
  const result = await changeAgentHook(agent, action, {
    homeDirectory: dependencies.homeDirectory,
    openLimiterScript: dependencies.openLimiterScript,
    nodeExecutable: dependencies.nodeExecutable,
    environment: dependencies.environment,
    platform: dependencies.platform,
    ...(knownInstallation === undefined
      ? {}
      : knownInstallation === null
        ? { detectedVersion: null }
        : {
            detectedVersion: knownInstallation.version,
            agentExecutable: knownInstallation.executable,
            agentFileSize: knownInstallation.fileSize,
            agentMtimeMilliseconds: knownInstallation.mtimeMilliseconds
          })
  });
  const preview = [
    "agent=" + result.agent,
    "action=" + result.action,
    "changed=" + (result.changed ? "yes" : "no"),
    "config=" + (result.configPath ?? "NONE"),
    "backup=" + (result.backupPath ?? "NONE"),
    "version=" + (result.version ?? "NONE")
  ].join("\n");
  return result.supported
    ? succeed(preview)
    : fail(EXIT_FAILURE, "openlimiter hooks: " + result.message, preview);
}

async function explicitStatusCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[],
  now: string
): Promise<CliResult> {
  if (!argumentsList.includes("--agent-context")) {
    return fail(EXIT_USAGE, "openlimiter status: use --agent-context.");
  }
  const hostedTrust = await resolvedHostedTrust(dependencies, now);
  const context = await agentContextFromCache(
    dependencies.stateDirectory,
    now,
    PROVIDER_CODES,
    hostedTrust === undefined ? {} : { hostedTrust }
  );
  const spill = await agentContextSpillFromCache(dependencies.stateDirectory, now);
  const stdout = [context, spill].filter((value) => value !== "").join("\n");
  return stdout === ""
    ? fail(EXIT_NO_DATA, "openlimiter status: no current agent context is available.")
    : succeed(stdout);
}

/* --------------------------------------------------------------- config */

/** The one section this command reads and writes. */
const CONFIG_SECTION = "statusline";

const configUsage = [
  "openlimiter config: use one of",
  "  openlimiter config get statusline[.<key>]",
  "  openlimiter config set statusline.<key> <value>",
  "Keys: " + STATUSLINE_KEYS.join(", ") + "."
].join("\n");

/**
 * Split `statusline.width` into its section and its key.
 *
 * A bare section name is a request for every key in it. Anything that is not
 * the statusline section is refused rather than guessed at, because the config
 * file also records connector detection and that is written by init, not by
 * hand.
 */
function parseConfigPath(
  target: string | undefined
): { section: string; key: string | null } | null {
  if (target === undefined || target === "") return null;
  const separator = target.indexOf(".");
  if (separator < 0) return { section: target, key: null };
  return {
    section: target.slice(0, separator),
    key: target.slice(separator + 1)
  };
}

function configGet(
  keys: readonly StatuslineKey[],
  statusline: StatuslineConfig
): string {
  return keys
    .map((key) => CONFIG_SECTION + "." + key + "=" + statuslineValueText(statusline, key))
    .join("\n");
}

/**
 * Read or change the statusline layout.
 *
 * The configuration file is the only thing this command touches, one key at a
 * time, and every value is validated before it is written. A rejected value
 * exits 2 and names what it would have accepted; nothing partial is ever
 * written, because the write replaces the whole document atomically.
 */
async function configCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[]
): Promise<CliResult> {
  const action = argumentsList[1];
  if (action !== "get" && action !== "set") {
    return fail(EXIT_USAGE, configUsage);
  }
  const target = parseConfigPath(argumentsList[2]);
  if (target === null || target.section !== CONFIG_SECTION) {
    return fail(
      EXIT_USAGE,
      "openlimiter config: only the statusline section can be read or written."
    );
  }
  if (target.key !== null && !isStatuslineKey(target.key)) {
    return fail(
      EXIT_USAGE,
      "openlimiter config: unknown statusline key. Known keys: " +
        STATUSLINE_KEYS.join(", ") + "."
    );
  }
  const stored = await readConfig(dependencies.stateDirectory);
  if (!stored.ok && stored.reason !== "missing") {
    return fail(EXIT_FAILURE, "openlimiter config: configuration could not be read.");
  }
  const config = stored.ok
    ? stored.config
    : defaultConfig(dependencies.environment);
  if (action === "get") {
    return succeed(configGet(
      target.key === null ? STATUSLINE_KEYS : [target.key],
      config.statusline
    ));
  }
  if (target.key === null) {
    return fail(
      EXIT_USAGE,
      "openlimiter config: set needs a key, as in statusline.width."
    );
  }
  const value = argumentsList[3];
  if (value === undefined) {
    return fail(EXIT_USAGE, "openlimiter config: set needs a value.");
  }
  const update = setStatuslineValue(config.statusline, target.key, value);
  if (!update.ok) return fail(EXIT_USAGE, "openlimiter config: " + update.message);
  try {
    await writeConfig(
      { ...config, statusline: update.statusline },
      dependencies.stateDirectory
    );
  } catch {
    return fail(EXIT_FAILURE, "openlimiter config: configuration could not be written.");
  }
  return succeed(configGet([target.key], update.statusline));
}

/**
 * Publish the cached quota on the local network, read only.
 *
 * This is the one command that does not finish. It returns its banner as soon
 * as the socket is bound, and the listening socket is what keeps the process
 * alive afterwards, so the caller writes the banner exactly once and then gets
 * out of the way.
 */
async function serveCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[]
): Promise<CliResult> {
  const portText = flagValue(argumentsList, "--port");
  if (argumentsList.includes("--port") && portText === undefined) {
    return fail(EXIT_USAGE, "openlimiter serve: the port flag needs a value.");
  }
  const port = portText === undefined ? DEFAULT_SERVE_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return fail(
      EXIT_USAGE,
      "openlimiter serve: the port must be a whole number from 0 to 65535."
    );
  }
  const host = flagValue(argumentsList, "--host");
  if (argumentsList.includes("--host") && host === undefined) {
    return fail(EXIT_USAGE, "openlimiter serve: the host flag needs a value.");
  }
  try {
    const handle = await startQuotaServer({
      port,
      ...(host === undefined ? {} : { host }),
      stateDirectory: dependencies.stateDirectory,
      now: dependencies.now
    });
    dependencies.onListening?.(handle);
    return succeed(
      serveBanner(handle, {
        color: dependencies.colorOutput,
        withoutQr: argumentsList.includes("--no-qr")
      })
    );
  } catch {
    return fail(
      EXIT_FAILURE,
      "openlimiter serve: that address and port could not be opened."
    );
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
      return await statuslineCommand(dependencies, now);
    }
    if (command === "config") {
      return await configCommand(dependencies, argumentsList);
    }
    if (command === "hook") {
      return await hookProtocolCommand(dependencies, argumentsList, now);
    }
    if (command === "hooks") return await hooksCommand(dependencies, argumentsList);
    if (command === "status") {
      return await explicitStatusCommand(dependencies, argumentsList, now);
    }
    if (command === "doctor") return await doctorCommand(dependencies, now);
    if (command === "demo") {
      return succeed(
        renderTable(demoSnapshots(now), now, dependencies.colorOutput)
      );
    }
    if (command === "export") return await exportCommand(dependencies);
    if (command === "ingest") {
      return await ingestCommand(dependencies, argumentsList, now);
    }
    if (command === "serve") return await serveCommand(dependencies, argumentsList);
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
