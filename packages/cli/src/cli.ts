import {
  ACQUISITION_OUTCOME_SENTENCE,
  CREDENTIAL_FAILURE_SENTENCE,
  PROVIDER_CODES,
  acquireRefreshLock,
  clearRefreshSpawnFailure,
  mergeAcquiredSnapshots,
  createFetchTransport,
  readRefreshSpawnFailure,
  antigravitySpec,
  buildAdvice,
  canonicalJson,
  claudeSpec,
  codexSpec,
  dedupeFailures,
  desktopHoldsCache,
  failureFromConnectorReason,
  freshness,
  geminiCliSpec,
  grokSpec,
  isProviderDue,
  kimiSpec,
  mergeSnapshots,
  normalizeMeters,
  normalizeMetersReport,
  openrouterSpec,
  readAcquisitionCredential,
  readAcquisitionSchedule,
  readSnapshotCache,
  readWindowsCredentialWith,
  resolveStateDirectory,
  runAcquisition,
  spawnDetachedRefresh,
  writeAcquisitionSchedule,
  probeAntigravity,
  type AntigravityProbeOptions,
  type AntigravityProbeResult,
  type AcquisitionProvider,
  type AcquisitionRow,
  type AcquisitionSchedule,
  type AcquisitionSpec,
  type AcquisitionTransport,
  type AcquiredCredential,
  type CacheReadResult,
  type CredentialCommandRunner,
  type CredentialResult,
  type DetachedSpawn,
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
  parseAntigravityCodeAssistPayload,
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseGeminiCliPayload,
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
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  PROVIDER_KEYS,
  STATUSLINE_KEYS,
  defaultConfig,
  initialize,
  isProviderKey,
  isStatuslineKey,
  providerValueText,
  readConfig,
  readProvidersConfig,
  readStatuslineConfig,
  setProviderValue,
  setStatuslineValue,
  statuslineValueText,
  writeConfig,
  type ProviderKey,
  type ProvidersConfig,
  type StatuslineConfig,
  type StatuslineKey
} from "./config.js";
import {
  ACQUISITION_PROVENANCE,
  ANTIGRAVITY_STATUSLINE_PROVENANCE,
  GROK_STATUSLINE_PROVENANCE,
  INGEST_PROVENANCE,
  MANUAL_PROVENANCE,
  STATUSLINE_PROVENANCE,
  environmentWithLocalMarkers,
  STDIN_BYTE_LIMIT,
  parseAntigravityStatuslinePayload,
  parseGrokStatuslinePayload,
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
  failureLine,
  failureLines,
  renderTable,
  supportsColor
} from "./render.js";
import {
  isStatuslineHost,
  renderStatuslineLayout,
  statuslineColor,
  type StatuslineHost
} from "./statusline.js";
import {
  TERMINAL_HOST_NAMES,
  installHost,
  terminalHide,
  terminalShow,
  terminalStatusTable,
  uninstallHost,
  type TerminalHostContext
} from "./terminal.js";
import {
  createFetchHubTransport,
  hubConfigured,
  type HubTransport
} from "./hub.js";
import {
  REVOKED_SENTENCE,
  ensureFreshSession,
  isAborted,
  runDeviceLogin
} from "./hub-auth.js";
import { runSync } from "./hub-sync.js";
import {
  deleteSession,
  readSession,
  writeSession,
  type HubSession
} from "./session.js";
import {
  DeviceLoginError,
  LOGIN_TIMEOUT_MILLISECONDS,
  SystemDeviceLoginRunner,
  managedCodexHome,
  startCodexDeviceLogin,
  versionIsSupported as codexVersionIsSupported,
  type DeviceLoginFailure,
  type DeviceLoginRunner
} from "./codex-device-login.js";

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
   * The meter bars and the failure lines use it to choose between escape
   * codes and plain ASCII, so a capture redirected into a file carries no
   * control characters at all.
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
   * How acquisition requests leave this machine.
   *
   * Injected everywhere, so a test proves the whole path against recorded
   * responses and never opens a socket. The library default is the runtime's
   * own fetch behind the closed endpoint table in the core package.
   */
  acquisitionTransport: AcquisitionTransport;
  /**
   * How a refresh is started behind a render.
   *
   * The child outlives this process on purpose: a status line has to return in
   * milliseconds and a round of provider requests does not fit in that.
   */
  spawnDetached: DetachedSpawn;
  /**
   * How the Windows Credential Manager is asked for one entry.
   *
   * Only Antigravity needs it, and only on Windows. Absent means the file
   * fallback is the only path, which is what every other platform uses.
   */
  windowsCredentialRunner?: CredentialCommandRunner;
  /**
   * Probe running Antigravity instances on loopback ports.
   *
   * Reaches nothing by default in tests. The real executable injects the real
   * loopback probe.
   */
  probeAntigravity?: (options?: AntigravityProbeOptions) => Promise<AntigravityProbeResult>;
  /**
   * Interactive prompt choice helper.
   */
  promptChoice?: (question: string) => Promise<string>;
  /**
   * How a hub request leaves this machine.
   *
   * Injected everywhere, exactly like `acquisitionTransport`, so a test proves
   * the whole sign in and sync path against recorded responses and never opens
   * a socket. The library default throws, and the real executable injects the
   * runtime's own fetch behind the closed endpoint table in `hub.ts`.
   */
  hubTransport: HubTransport;
  /**
   * Open a URL in the person's browser. Used only when `--open` is passed to
   * `login`, since the code and address are always printed either way.
   */
  openBrowser: (url: string) => void;
  /** An injectable delay, so a poll loop never makes a test wait in real time. */
  sleep: (milliseconds: number) => Promise<void>;
  /**
   * Progress a long running command wants seen before it returns.
   *
   * `login`, `sync` and `setup` can run for minutes at a time, and a person
   * watching a blank terminal for three minutes while a device code sits
   * unprinted is the whole flow failing in a way no exit code explains. This
   * is separate from the command's own `CliResult`, which still carries a
   * final one line summary once the command actually finishes.
   */
  emit: (line: string) => void;
  /** Set when Ctrl C should end a poll loop rather than the whole process. */
  interruptSignal?: AbortSignal;
  /**
   * How an owner only ACL is applied to the session file on Windows.
   *
   * Best effort and independent of `windowsCredentialRunner`: this one writes
   * an ACL rather than reading a credential, but the shape of "run this helper
   * with these arguments" is the same, so the two share a type.
   */
  windowsAclRunner?: CredentialCommandRunner;
  /**
   * How the Codex device sign in child process is started, keyed by the
   * executable this machine detected.
   *
   * The library default never spawns anything: it answers every login attempt
   * with a closed `spawn` failure, so a test or another tool that calls
   * `runCli` in process starts no child unless it asked for one.
   */
  codexDeviceLoginRunnerFactory: (executable: string) => DeviceLoginRunner;
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
    detectedAgentInstallations: {},
    /*
     * The library defaults reach nothing outside this process, exactly as the
     * standard input reader above does. The executable injects the real
     * transport, the real spawner and the real credential helper, so a test or
     * another tool that calls runCli in process opens no socket, starts no
     * child and runs no shell unless it asked for one.
     */
    acquisitionTransport: async () => {
      throw new Error("No acquisition transport was injected");
    },
    spawnDetached: () => undefined,
    probeAntigravity: async () => ({ ok: false, reason: "not_running" }),
    promptChoice: async () => "",
    hubTransport: async () => {
      throw new Error("No hub transport was injected");
    },
    openBrowser: () => undefined,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    emit: () => undefined,
    codexDeviceLoginRunnerFactory: () => ({
      start: async () => {
        throw new DeviceLoginError("spawn");
      }
    })
  };
}

/** The line separator every multi line report in this file joins on. */
const NEWLINE = "\n";

/**
 * The dependencies that actually reach the world, built once for the executable.
 *
 * Exported rather than inlined in the executable because the executable has two
 * entry paths, the ordinary one and the wrapped status line, and the wrapped one
 * used to build its own smaller set. A wrapped status line therefore rendered
 * bars forever and never started the refresh that keeps them true, which is the
 * one configuration a person following the install instructions ends up with.
 * One factory, both paths, and a test can assert what is in it.
 */
/**
 * Run one helper executable with arguments and a timeout, and hand back its
 * standard output or a plain failure.
 *
 * Shared by two dependencies that otherwise have nothing to do with each
 * other: reading one Windows Credential Manager entry, and applying an owner
 * only ACL to the session file. Both are "run this helper, get its stdout or
 * nothing back", so both get the same runner rather than two copies of the
 * same `execFile` wrapper.
 */
const execFileRunner: CredentialCommandRunner = async (
  executable,
  helperArguments,
  timeoutMilliseconds
) =>
  await new Promise((resolve) => {
    execFile(
      executable,
      [...helperArguments],
      { timeout: timeoutMilliseconds, maxBuffer: 262_144, windowsHide: true },
      (error, stdout) => {
        resolve(error === null ? { ok: true, stdout } : { ok: false });
      }
    );
  });

/** Open a URL in the person's browser, best effort and never awaited. */
function openBrowserPlatform(url: string, platform: NodeJS.Platform): void {
  if (!/^https:\/\//u.test(url) || url.length > 2_048) return;
  const [command, commandArguments] = platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, commandArguments, { stdio: "ignore", detached: true });
    child.once("error", () => undefined);
    child.unref();
  } catch {
    /* The code and the address are already printed, which is enough on its
       own to sign in from. Opening a tab is a convenience, not the path. */
  }
}

export function runtimeDependencies(): Pick<
  CliDependencies,
  | "acquisitionTransport"
  | "spawnDetached"
  | "windowsCredentialRunner"
  | "probeAntigravity"
  | "hubTransport"
  | "openBrowser"
  | "emit"
  | "windowsAclRunner"
  | "codexDeviceLoginRunnerFactory"
> {
  return {
    acquisitionTransport: createFetchTransport(),
    probeAntigravity,
    spawnDetached: (executable, argumentsList, options) => {
      const child = spawn(executable, [...argumentsList], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      /*
       * A detached spawn reports a missing executable asynchronously, long
       * after this function returned and usually after the render has already
       * been printed. Without this listener that arrives as an unhandled error
       * event and takes the host process down with it, which for a status line
       * means taking down somebody's terminal prompt.
       */
      child.once("error", () => {
        options.onError?.();
      });
      /* Unreferenced so this process can exit while the refresh continues. */
      child.unref();
    },
    windowsCredentialRunner: execFileRunner,
    windowsAclRunner: execFileRunner,
    hubTransport: createFetchHubTransport(),
    openBrowser: (url) => openBrowserPlatform(url, process.platform),
    emit: (line) => {
      process.stdout.write(line + "\n");
    },
    codexDeviceLoginRunnerFactory: (executable) => new SystemDeviceLoginRunner(executable)
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

/* ---------------------------------------------------------- acquisition */

/**
 * How a terminal with no desktop app gets fresh bars.
 *
 * Everything below is wiring, and only wiring. Credential discovery, the closed
 * endpoint table, the cadence, the backoff and the lock all live in the core
 * package, and the parsers all live in the connector package; this is the one
 * place that knows both exist. That separation is why a test can prove a whole
 * round without a socket and without a real login.
 */

/**
 * The specifications this machine will run, wired to the real parsers.
 *
 * Claude is here whatever the switch says, because a row that is off still owes
 * a person the sentence explaining why its bar is older than the rest. Every
 * other provider is unconditional: a provider with no local login simply
 * reports that it has none.
 */
export function acquisitionSpecs(providers: ProvidersConfig): AcquisitionSpec[] {
  return [
    claudeSpec({ parse: parseClaudePayload, enabled: providers.claude.poll }),
    codexSpec(parseCodexPayload),
    geminiCliSpec(parseGeminiCliPayload),
    antigravitySpec(parseAntigravityCodeAssistPayload),
    grokSpec(parseGrokPayload),
    kimiSpec(parseKimiPayload),
    openrouterSpec(parseOpenrouterPayload)
  ];
}

/**
 * Where each provider's credential is read from.
 *
 * Six of them belong to a vendor's own client and are read off disk, unchanged,
 * by the core. OpenRouter is the exception and always was: its key is one a
 * person typed into this tool, so it lives in the operating system credential
 * store under this product's own name and is read from there.
 */
function credentialReader(
  dependencies: CliDependencies
): (provider: AcquisitionProvider) => Promise<CredentialResult> {
  const runner = dependencies.windowsCredentialRunner;
  return async (provider) => {
    if (provider === "OPENROUTER") {
      let secret: string | null;
      try {
        secret = await dependencies.credentialStore.get("openlimiter", "openrouter");
      } catch {
        return { ok: false, reason: "unreadable" };
      }
      /*
       * The environment is the second place, and today it is the only one that
       * works in a published build: this package ships no credential store
       * driver, so the store above always answers nothing until one is wired.
       * A terminal person therefore has one documented way to supply the key,
       * and it is the same variable a shell profile already knows how to keep.
       */
      secret ??= dependencies.environment["OPENLIMITER_OPENROUTER_KEY"] ?? null;
      return secret === null || secret === ""
        ? { ok: false, reason: "absent" }
        : {
            ok: true,
            credential: {
              secret,
              accountId: null,
              expiresAtMilliseconds: null,
              origin: "user_key"
            }
          };
    }
    return await readAcquisitionCredential(provider, {
      platform: dependencies.platform,
      environment: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
      now: dependencies.now(),
      ...(runner === undefined || dependencies.platform !== "win32"
        ? {}
        : {
            readWindowsCredential: async (target) =>
              await readWindowsCredentialWith(target, { runCommand: runner })
          })
    });
  };
}

/**
 * What is written onto every acquired reading before it is validated.
 *
 * Two facts, both about this process rather than about the provider: the
 * reading arrived over the network just now, and this command is what wrote it.
 * The second is what stops two refreshers on one machine from both polling.
 */
function acquisitionStamp(
  meters: readonly RawMeter[],
  credential: AcquiredCredential
): RawMeter[] {
  void credential;
  return withProvenance(meters, ACQUISITION_PROVENANCE).map(
    (meter) => ({ ...meter, writer: "cli" as const })
  );
}

/**
 * What doctor can say about one provider without asking the provider anything.
 *
 * Doctor never touches the network, so this reads three local things and stops:
 * whether a credential exists, what the schedule says, and whether the cache
 * already holds a fresh row for this provider. That is enough to tell apart the
 * four states a person cares about, which are "not set up here", "waiting out a
 * backoff", "set up and current" and "set up and something is wrong".
 */
async function acquisitionStatusRow(
  spec: AcquisitionSpec,
  schedule: AcquisitionSchedule,
  readCredential: (provider: AcquisitionProvider) => Promise<CredentialResult>,
  snapshots: readonly Snapshot[],
  now: string
): Promise<AcquisitionRow> {
  const entry = schedule[spec.provider];
  const nextAttemptAt = entry?.nextAttemptAt ?? null;
  /* The same sentence the round itself printed. A provider that says something
     better than the shared vocabulary must say it in both places, or doctor
     quietly contradicts the command a person just ran. */
  const sentence = (outcome: NonNullable<typeof entry>["outcome"]): string =>
    spec.outcomeSentence?.[outcome] ?? ACQUISITION_OUTCOME_SENTENCE[outcome];
  if (spec.enabled === false) {
    return {
      provider: spec.provider,
      detected: false,
      status: "off",
      reason: spec.disabledReason ?? null,
      nextAttemptAt: null,
      disclosure: spec.disclosure
    };
  }
  const credential = await readCredential(spec.credentialProvider);
  if (!credential.ok) {
    const absent = credential.reason === "absent";
    return {
      provider: spec.provider,
      detected: !absent,
      status: absent ? "not_detected" : "stale",
      reason: CREDENTIAL_FAILURE_SENTENCE[credential.reason],
      nextAttemptAt,
      disclosure: spec.disclosure
    };
  }
  const held = credential.credential;
  const accountId = spec.accountIdFor?.(held) ?? null;
  const disclosure = spec.disclosureFor?.(held) ?? spec.disclosure;
  const identity = {
    provider: spec.provider,
    ...(accountId === null ? {} : { accountId }),
    detected: true,
    disclosure
  };
  if (!isProviderDue(entry, now)) {
    return {
      ...identity,
      status: "waiting",
      reason: entry === undefined ? null : sentence(entry.outcome),
      nextAttemptAt
    };
  }
  const fresh = snapshots.some(
    (snapshot) => snapshot.provider === spec.provider &&
      freshness(snapshot.observedAt, snapshot.expiresAt, now) === "fresh"
  );
  return {
    ...identity,
    status: fresh ? "read" : "stale",
    reason: fresh
      ? null
      : entry === undefined
        ? "this provider has not been read yet on this machine"
        : sentence(entry.outcome),
    nextAttemptAt
  };
}

/** The acquisition block doctor prints under the connector block. */
async function acquisitionDoctorRows(
  dependencies: CliDependencies,
  snapshots: readonly Snapshot[],
  now: string
): Promise<string> {
  const providers = await readProvidersConfig(dependencies.stateDirectory);
  const schedule = await readAcquisitionSchedule(dependencies.stateDirectory);
  const readCredential = credentialReader(dependencies);
  const rows: string[] = [];
  for (const spec of acquisitionSpecs(providers)) {
    rows.push(acquisitionLine(
      await acquisitionStatusRow(spec, schedule, readCredential, snapshots, now),
      snapshots
    ));
  }
  const failedAt = await readRefreshSpawnFailure(dependencies.stateDirectory);
  if (failedAt !== null) {
    rows.push("REFRESH SPAWN FAILED " + failedAt +
      " the background refresh could not be started on this machine");
  }
  return [ACQUISITION_HEADER, ...rows].join(NEWLINE);
}

/**
 * Where a person can still see a reading this row could not take.
 *
 * Antigravity and Gemini CLI meter the same Google Code Assist pool. When
 * Google withholds the reading from this client but another tool on the machine
 * has already written one, the honest thing is to point at it rather than leave
 * a bare refusal, so the person knows the number exists and where.
 */
function sharedQuotaNote(
  row: AcquisitionRow,
  snapshots: readonly Snapshot[]
): string | null {
  if (row.provider !== "ANTIGRAVITY") return null;
  return snapshots.some((snapshot) => snapshot.provider === "GEMINI_CLI")
    ? "the shared Code Assist quota is shown under gemini_cli"
    : null;
}

/** One row of the refresh report, in the space separated grammar doctor uses. */
function acquisitionLine(
  row: AcquisitionRow,
  snapshots: readonly Snapshot[] = []
): string {
  const shared = row.status === "read" ? null : sharedQuotaNote(row, snapshots);
  const note = [row.reason ?? row.disclosure ?? "", shared ?? ""]
    .filter((part) => part !== "")
    .join(", ");
  return [
    row.provider.toLowerCase() + (row.accountId === undefined ? "" : "/" + row.accountId),
    row.detected ? "yes" : "no",
    row.status,
    row.nextAttemptAt ?? "NONE",
    note
  ].join(" ").trimEnd();
}

const ACQUISITION_HEADER = "PROVIDER DETECTED STATUS NEXT NOTE";

/**
 * Run one round of acquisition and fold what it found into the cache.
 *
 * Three refusals come before any request. A desktop that wrote inside the last
 * interval already owns this machine's refreshing, so this command stands down
 * rather than doubling the traffic a provider sees. A refresh already running
 * holds the lock, so this one exits instead of racing it on the same
 * credentials. And a provider inside its own backoff is skipped by the runner
 * without being asked anything.
 *
 * Only a successful read writes. A refusal, a rate limit or a shape this build
 * did not understand leaves every cached row exactly where it was, to age out
 * through the ordinary freshness rule.
 */
async function refreshCommand(
  dependencies: CliDependencies,
  now: string
): Promise<CliResult> {
  const lock = await acquireRefreshLock(dependencies.stateDirectory);
  if (!lock.ok) {
    return succeed([
      ACQUISITION_HEADER,
      "SKIPPED another refresh is already running on this machine"
    ].join(NEWLINE));
  }
  try {
    /*
     * Desktop ownership is decided HERE, under the lock, and nowhere else.
     * Checking it before taking the lock read a cache that a desktop could
     * start writing a millisecond later, and this round would then poll every
     * provider a second time for nothing. One check, on the only side of the
     * lock where the answer cannot change underneath it.
     */
    const settled = await readSnapshotCache(dependencies.stateDirectory);
    if (desktopHoldsCache(settled.ok ? settled.snapshots : [], now)) {
      return succeed([
        ACQUISITION_HEADER,
        "SKIPPED the desktop app refreshed this cache inside the last interval"
      ].join(NEWLINE));
    }
    /* A round that got this far is proof a refresh can start on this machine. */
    await clearRefreshSpawnFailure(dependencies.stateDirectory);
    const providers = await readProvidersConfig(dependencies.stateDirectory);
    const schedule = await readAcquisitionSchedule(dependencies.stateDirectory);
    const result = await runAcquisition(acquisitionSpecs(providers), {
      transport: dependencies.acquisitionTransport,
      now,
      schedule,
      readCredential: credentialReader(dependencies),
      stamp: acquisitionStamp,
      ...(dependencies.probeAntigravity === undefined
        ? {}
        : { probeAntigravity: dependencies.probeAntigravity })
    });
    /*
     * Ownership is checked before every write, not once at the start. A round
     * can outlive its lock if this machine was suspended mid refresh, and a
     * round that lost its lock must not write over the round that took it.
     *
     * The refresh lock only coordinates other copies of THIS tool. The desktop
     * tray is a separate process that knows nothing about it, so the write
     * itself has to be safe against a desktop row that appeared since this
     * round started reading. `mergeAcquiredSnapshots` decides that per row,
     * inside the cache lock both processes do share, keeping whichever row is
     * newer and leaving a tie with the row already there.
     */
    for (const report of result.reports) {
      if (!(await lock.stillOwned())) {
        return succeed([
          ACQUISITION_HEADER,
          "SKIPPED this refresh lost its lock before it could write"
        ].join(NEWLINE));
      }
      if (!report.ok) continue;
      try {
        await mergeAcquiredSnapshots(report, dependencies.stateDirectory);
      } catch {
        /* One provider's write failing is that provider's problem. The rest of
           the round still has readings worth keeping. */
      }
    }
    if (!(await lock.stillOwned())) {
      return succeed([
        ACQUISITION_HEADER,
        "SKIPPED this refresh lost its lock before it could write"
      ].join(NEWLINE));
    }
    await writeAcquisitionSchedule(result.schedule, dependencies.stateDirectory);
    const merged = await cachedSnapshots(dependencies.stateDirectory);
    await writeAgentContextSnapshot(
      merged,
      dependencies.stateDirectory,
      now,
      PROVIDER_CODES
    ).catch(() => undefined);
    /*
     * A sync after a successful refresh, when a session exists. This round
     * already runs off the status line's own path (`startRefreshBehind` spawns
     * it detached and never waits), so nothing here can add to a render.
     */
    await triggerSyncAfterRefresh(dependencies, now);
    return succeed([
      ACQUISITION_HEADER,
      ...result.rows.map((row) => acquisitionLine(row, merged))
    ].join(NEWLINE));
  } catch {
    return fail(EXIT_FAILURE, "openlimiter refresh: the refresh did not complete.");
  } finally {
    await lock.release();
  }
}

/**
 * Start a refresh behind a render, when one is worth starting.
 *
 * Every failure here is swallowed on purpose. This is called from a status line
 * and from a snapshot, and neither of them may fail because a refresh could not
 * be started: the bars this render already has are still true.
 */
async function startRefreshBehind(
  dependencies: CliDependencies,
  snapshots: readonly Snapshot[],
  now: string
): Promise<void> {
  try {
    await spawnDetachedRefresh({
      snapshots,
      now,
      ...(dependencies.stateDirectory === undefined
        ? {}
        : { stateDirectory: dependencies.stateDirectory }),
      nodeExecutable: dependencies.nodeExecutable,
      openLimiterScript: dependencies.openLimiterScript,
      spawn: dependencies.spawnDetached
    });
  } catch {
    /* Nothing to report and nothing a person could do about it. */
  }
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
  /*
   * PAYLOAD, not DETECTED. This column has always meant "a payload for this
   * connector was pushed into this process", which is a different question from
   * the acquisition table's "a login for this provider exists on this machine",
   * and the two answered differently for the same provider under the same word.
   * One of them had to be renamed and this is the one whose word was wrong.
   */
  const lines = ["CONNECTOR PAYLOAD FRESHNESS DRIFT"];
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
  "openlimiter",
  "openlimiter setup",
  "openlimiter login [--open]",
  "openlimiter logout",
  "openlimiter whoami",
  "openlimiter sync",
  "openlimiter init",
  "openlimiter snapshot [--refresh]",
  "openlimiter statusline [--host claude|antigravity|grok|codex|shell]",
  "openlimiter terminal [--yes] [--host <id>]",
  "openlimiter terminal status",
  "openlimiter terminal install <host>",
  "openlimiter terminal uninstall <host>",
  "openlimiter terminal show <provider ...>",
  "openlimiter terminal hide <provider ...>",
  "openlimiter refresh",
  "openlimiter hook [--dry-run]",
  "openlimiter hooks install <agent>",
  "openlimiter hooks uninstall <agent>",
  "openlimiter hooks status <agent>",
  "openlimiter hooks repair <agent>",
  "openlimiter status --agent-context",
  "openlimiter ingest [--provider <id>] [--payload <json>]",
  "openlimiter config get statusline[.<key>]",
  "openlimiter config set statusline.<key> <value>",
  "openlimiter config get providers[.<key>]",
  "openlimiter config set providers.<key> <value>",
  "openlimiter doctor",
  "openlimiter demo",
  "openlimiter export",
  "",
  "statusline keys: " + STATUSLINE_KEYS.join(", ") + ".",
  "providers keys: " + PROVIDER_KEYS.join(", ") + ".",
  "terminal hosts: " + TERMINAL_HOST_NAMES.join(", ") + ".",
  "statusline and ingest read JSON from standard input when it is piped in.",
  "openlimiter with no arguments runs setup: sign in, connect, show bars in.",
  "login opens the device code sign in; sync uploads one round to the hub when",
  "a session exists, and refresh triggers it automatically after itself.",
  "refresh reads the logins your provider tools already stored on this machine",
  "and asks each provider for its own usage, at most once every 15 minutes. It",
  "stands down while the desktop app is running. statusline and snapshot start",
  "it in the background when the cache is older than a minute.",
  "Exit codes: 0 success, 1 failure, 2 usage, 3 no bounded quota data."
].join("\n");

/**
 * Parse a status line host's payload from standard input and cache it.
 *
 * This is the path that gives the tool something to meter. It performs no
 * network access at all: it validates the JSON the host already wrote to this
 * process. Every failure returns null so the caller can fall back to the
 * cache instead of breaking the host tool.
 *
 * Which parser runs, and which provenance the reading is stamped with, are
 * decided by the host. Codex names no scripting interface at all (its status
 * line draws only its own built in items) and shell prompts read the cache
 * only, so neither ever hands this anything to parse.
 */
async function ingestStandardInput(
  dependencies: CliDependencies,
  now: string,
  host: StatuslineHost = "claude"
): Promise<Snapshot[] | null> {
  if (host === "codex" || host === "shell") return null;
  try {
    const document = parseJsonText(await dependencies.readStandardInput());
    if (!document.ok) return null;
    const meters = host === "antigravity"
      ? parseAntigravityStatuslinePayload(document.value, now)
      : host === "grok"
        ? parseGrokStatuslinePayload(document.value, now)
        : parseClaudePayload(document.value, now);
    if (meters === null) return null;
    const provenance = host === "antigravity"
      ? ANTIGRAVITY_STATUSLINE_PROVENANCE
      : host === "grok"
        ? GROK_STATUSLINE_PROVENANCE
        : STATUSLINE_PROVENANCE;
    /* The host wrote this to our standard input in this session. It is a live
       reading, and it says so. */
    const incoming = normalizeMeters(withProvenance(meters, provenance));
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
  if (argumentsList.includes("--refresh")) {
    await startRefreshBehind(dependencies, snapshots, now);
  }
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
    await acquisitionDoctorRows(dependencies, snapshots, now),
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
 * Standard input first, so a host's session payload is ingested and drawn in
 * the same call, then the cache. `--host` names which host is asking, which
 * decides both how standard input is parsed and which grammar the bar style
 * draws (a provider's own window carries no tag, every other window does).
 * Absent or unrecognised falls back to `claude`, which is what every
 * installation before this one already assumed. The layout comes from the
 * configuration file and the fallback is the layout's own default, so a
 * machine with no configuration still gets bars.
 *
 * `bars false` hands the whole job back to the adapter that produced the 0.1.0
 * line. That path is byte for byte what it always was, which is the point of
 * keeping it: it is the escape hatch for anything already parsing this output.
 */
async function statuslineCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[],
  now: string
): Promise<CliResult> {
  const hostFlag = flagValue(argumentsList, "--host");
  const host: StatuslineHost = hostFlag !== undefined && isStatuslineHost(hostFlag)
    ? (hostFlag.toLowerCase() as StatuslineHost)
    : "claude";
  const ingested = await ingestStandardInput(dependencies, now, host);
  const snapshots = ingested ?? await cachedSnapshots(dependencies.stateDirectory);
  /*
   * The refresh that keeps the other providers current starts here and is never
   * waited for. This render draws whatever the cache already holds, the child
   * outlives this process, and the next render shows what it found. That is the
   * whole reason a terminal person needs no background service.
   */
  await startRefreshBehind(dependencies, snapshots, now);
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
    ),
    host
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

/** The two sections this command reads and writes. */
const CONFIG_SECTION = "statusline";
const PROVIDERS_SECTION = "providers";

const configUsage = [
  "openlimiter config: use one of",
  "  openlimiter config get statusline[.<key>]",
  "  openlimiter config set statusline.<key> <value>",
  "  openlimiter config get providers[.<key>]",
  "  openlimiter config set providers.<key> <value>",
  "Statusline keys: " + STATUSLINE_KEYS.join(", ") + ".",
  "Providers keys: " + PROVIDER_KEYS.join(", ") + "."
].join(NEWLINE);

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
    .join(NEWLINE);
}

function providersGet(
  keys: readonly ProviderKey[],
  providers: ProvidersConfig
): string {
  return keys
    .map((key) => PROVIDERS_SECTION + "." + key + "=" + providerValueText(providers, key))
    .join(NEWLINE);
}

/**
 * Read or change one provider switch.
 *
 * Split from the statusline path rather than folded into it because the two
 * sections mean different things: a statusline key changes what a person sees,
 * and a providers key changes what this machine asks a provider. Only the
 * second one has a network consequence, and it deserves its own words.
 */
async function providersConfigCommand(
  dependencies: CliDependencies,
  action: "get" | "set",
  key: string | null,
  value: string | undefined
): Promise<CliResult> {
  if (key !== null && !isProviderKey(key)) {
    return fail(
      EXIT_USAGE,
      "openlimiter config: unknown providers key. Known keys: " +
        PROVIDER_KEYS.join(", ") + "."
    );
  }
  const stored = await readConfig(dependencies.stateDirectory);
  if (!stored.ok && stored.reason !== "missing") {
    return fail(EXIT_FAILURE, "openlimiter config: configuration could not be read.");
  }
  const config = stored.ok ? stored.config : defaultConfig(dependencies.environment);
  if (action === "get") {
    return succeed(providersGet(
      key === null ? PROVIDER_KEYS : [key],
      config.providers
    ));
  }
  if (key === null) {
    return fail(
      EXIT_USAGE,
      "openlimiter config: set needs a key, as in providers.claude.poll."
    );
  }
  if (value === undefined) {
    return fail(EXIT_USAGE, "openlimiter config: set needs a value.");
  }
  const update = setProviderValue(config.providers, key, value);
  if (!update.ok) return fail(EXIT_USAGE, "openlimiter config: " + update.message);
  try {
    await writeConfig(
      { ...config, providers: update.providers },
      dependencies.stateDirectory
    );
  } catch {
    return fail(EXIT_FAILURE, "openlimiter config: configuration could not be written.");
  }
  return succeed(providersGet([key], update.providers));
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
  if (target === null) return fail(EXIT_USAGE, configUsage);
  if (target.section === PROVIDERS_SECTION) {
    return await providersConfigCommand(
      dependencies,
      action,
      target.key,
      argumentsList[3]
    );
  }
  if (target.section !== CONFIG_SECTION) {
    return fail(
      EXIT_USAGE,
      "openlimiter config: only the statusline and providers sections can be " +
        "read or written."
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

const terminalUsage = [
  "openlimiter terminal [--yes] [--host <id>]",
  "openlimiter terminal status",
  "openlimiter terminal install <host>",
  "openlimiter terminal uninstall <host>",
  "openlimiter terminal show <provider ...>",
  "openlimiter terminal hide <provider ...>",
  "",
  "hosts: " + TERMINAL_HOST_NAMES.join(", ") + "."
].join("\n");

/** The provider ids this machine has a login or a key for, right now. */
async function detectedProviderIds(
  dependencies: CliDependencies
): Promise<readonly string[]> {
  const environment = await environmentWithLocalMarkers(
    dependencies.environment,
    dependencies.stateDirectory
  );
  return connectors
    .filter((connector) => connector.detect(environment))
    .map((connector) => connector.id);
}

function terminalContext(
  dependencies: CliDependencies,
  detected: readonly string[]
): TerminalHostContext {
  return {
    homeDirectory: dependencies.homeDirectory,
    ...(dependencies.stateDirectory === undefined
      ? {}
      : { stateDirectory: dependencies.stateDirectory }),
    platform: dependencies.platform,
    detectedProviders: detected
  };
}

/**
 * Wire, unwire and report on a status line host, and choose what a terminal
 * shows.
 *
 * A bare call is the checklist: every host this build knows, whether it is
 * already wired, and the one line that wires the rest. It never opens an
 * interactive prompt, because this command runs as often from a script as
 * from a person at a keyboard and a prompt neither can answer would hang one
 * of them. `--yes` is the unattended equivalent of answering yes to every
 * host in the checklist; `--host <id>` wires exactly one.
 */
async function terminalCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[]
): Promise<CliResult> {
  const action = argumentsList[1];
  const detected = await detectedProviderIds(dependencies);
  const context = terminalContext(dependencies, detected);
  const knownHost = (value: string | undefined): value is string =>
    value !== undefined && TERMINAL_HOST_NAMES.includes(value.toLowerCase());

  if (action === "status") {
    return succeed(await terminalStatusTable(context));
  }

  if (action === "install" || action === "uninstall") {
    const host = argumentsList[2];
    if (!knownHost(host)) {
      return fail(
        EXIT_USAGE,
        "openlimiter terminal: " + action + " needs a known host. hosts: " +
          TERMINAL_HOST_NAMES.join(", ") + "."
      );
    }
    const result = action === "install"
      ? await installHost(host, context)
      : await uninstallHost(host, context);
    return result.ok ? succeed(result.message) : fail(EXIT_FAILURE, result.message);
  }

  if (action === "show" || action === "hide") {
    const providerIds = argumentsList.slice(2);
    if (providerIds.length === 0) {
      return fail(
        EXIT_USAGE,
        "openlimiter terminal: " + action + " needs at least one provider id."
      );
    }
    const result = action === "show"
      ? await terminalShow(providerIds, context)
      : await terminalHide(providerIds, context);
    return result.ok ? succeed(result.message) : fail(EXIT_USAGE, result.message);
  }

  if (action === undefined || action === "--yes" || action === "--host") {
    const hostFlag = flagValue(argumentsList, "--host");
    if (argumentsList.includes("--host") && !knownHost(hostFlag)) {
      return fail(
        EXIT_USAGE,
        "openlimiter terminal: --host needs a known host. hosts: " +
          TERMINAL_HOST_NAMES.join(", ") + "."
      );
    }
    if (knownHost(hostFlag)) {
      const result = await installHost(hostFlag, context);
      return result.ok ? succeed(result.message) : fail(EXIT_FAILURE, result.message);
    }
    if (argumentsList.includes("--yes")) {
      const lines: string[] = [];
      let allOk = true;
      for (const host of TERMINAL_HOST_NAMES) {
        const result = await installHost(host, context);
        if (!result.ok) allOk = false;
        lines.push(host + ": " + (result.message.split("\n")[0] ?? result.message));
      }
      return allOk ? succeed(lines.join("\n")) : fail(EXIT_FAILURE, lines.join("\n"));
    }
    const table = await terminalStatusTable(context);
    return succeed([
      table,
      "",
      "Wire one host: openlimiter terminal install <host>",
      "Wire every host this build supports: openlimiter terminal --yes",
      "hosts: " + TERMINAL_HOST_NAMES.join(", ") + "."
    ].join("\n"));
  }

  return fail(EXIT_USAGE, terminalUsage);
}

/* ------------------------------------------------------------------- hub */

/**
 * Sign in to the hub through the device code flow.
 *
 * The code and the address are shown the moment the hub hands them over,
 * through `dependencies.emit`, because the poll that follows can take up to
 * three minutes and a person watching a blank terminal for that long is the
 * whole flow failing in a way no exit code explains. `--open` additionally
 * opens a browser tab; the code and the address are printed either way.
 */
async function loginCommand(
  dependencies: CliDependencies,
  argumentsList: readonly string[]
): Promise<CliResult> {
  const outcome = await runDeviceLogin({
    environment: dependencies.environment,
    transport: dependencies.hubTransport,
    sleep: dependencies.sleep,
    emit: dependencies.emit,
    ...(dependencies.interruptSignal === undefined ? {} : { interruptSignal: dependencies.interruptSignal }),
    openBrowser: dependencies.openBrowser,
    open: argumentsList.includes("--open")
  });
  if (outcome.kind === "signed_in") {
    await writeSession(outcome.session, {
      ...(dependencies.stateDirectory === undefined ? {} : { directory: dependencies.stateDirectory }),
      platform: dependencies.platform,
      ...(dependencies.windowsAclRunner === undefined ? {} : { windowsAclRunner: dependencies.windowsAclRunner })
    });
    return succeed("Signed in as " + outcome.session.accountLabel + ".");
  }
  if (outcome.kind === "cancelled") return fail(EXIT_FAILURE, "openlimiter login: cancelled.");
  if (outcome.kind === "denied") return fail(EXIT_FAILURE, "openlimiter login: the sign in was denied.");
  if (outcome.kind === "expired") {
    return fail(EXIT_FAILURE, "openlimiter login: the code expired before it was approved.");
  }
  if (outcome.kind === "not_configured") {
    return fail(EXIT_FAILURE, "openlimiter login: the hub is not configured on this build.");
  }
  return fail(EXIT_FAILURE, "openlimiter login: " + outcome.message + ".");
}

/** Forget the stored session. Nothing on the hub is asked to do anything. */
async function logoutCommand(dependencies: CliDependencies): Promise<CliResult> {
  await deleteSession(dependencies.stateDirectory);
  return succeed("Signed out.");
}

/** Print who is signed in, or say plainly that nobody is. */
async function whoamiCommand(dependencies: CliDependencies): Promise<CliResult> {
  const session = await readSession(dependencies.stateDirectory);
  if (session === null) return fail(EXIT_FAILURE, "openlimiter whoami: not signed in.");
  return succeed(["Account: " + session.accountLabel, "Device: " + session.deviceId].join(NEWLINE));
}

/** Persist a session that renewal freshened, using the caller's own options. */
async function persistRenewedSession(
  dependencies: CliDependencies,
  session: HubSession
): Promise<void> {
  await writeSession(session, {
    ...(dependencies.stateDirectory === undefined ? {} : { directory: dependencies.stateDirectory }),
    platform: dependencies.platform,
    ...(dependencies.windowsAclRunner === undefined ? {} : { windowsAclRunner: dependencies.windowsAclRunner })
  });
}

/**
 * Build and upload one sync envelope, from the CLI's own explicit command.
 *
 * Renewal happens here, before anything is uploaded, exactly as the
 * deliverable requires: a token within an hour of expiry or already expired
 * is refreshed first, and a hub side revocation ends the session rather than
 * being treated as an ordinary network failure.
 */
async function syncCommand(dependencies: CliDependencies, now: string): Promise<CliResult> {
  const directory = dependencies.stateDirectory ?? resolveStateDirectory();
  const session = await readSession(directory);
  if (session === null) {
    return fail(EXIT_FAILURE, "openlimiter sync: not signed in, run openlimiter login.");
  }
  const renewal = await ensureFreshSession(session, now, dependencies.environment, dependencies.hubTransport);
  if (renewal.kind === "revoked") {
    await deleteSession(directory);
    return fail(EXIT_FAILURE, REVOKED_SENTENCE);
  }
  if (renewal.kind === "error") {
    return fail(EXIT_FAILURE, "openlimiter sync: could not renew the session, try again.");
  }
  if (renewal.kind === "renewed") await persistRenewedSession(dependencies, renewal.session);
  const active = renewal.session;
  const snapshots = await cachedSnapshots(dependencies.stateDirectory);
  const result = await runSync({
    directory,
    environment: dependencies.environment,
    transport: dependencies.hubTransport,
    now,
    token: active.token,
    deviceId: active.deviceId,
    snapshots
  });
  if (result.kind === "accepted") {
    return succeed(
      "Synced: accepted, tier " + (result.tier ?? "free") + ", rows " + String(result.rows) + "."
    );
  }
  if (result.kind === "nothing_to_sync") return succeed("openlimiter sync: nothing to sync yet.");
  if (result.kind === "revoked") {
    await deleteSession(directory);
    return fail(EXIT_FAILURE, REVOKED_SENTENCE);
  }
  if (result.kind === "rejected") {
    return fail(EXIT_FAILURE, "openlimiter sync: the hub rejected the upload.");
  }
  return fail(EXIT_FAILURE, "openlimiter sync: the hub could not be reached, try again.");
}

/**
 * Renew and upload behind an acquisition round, when a session exists.
 *
 * Called only from `refreshCommand`, which already runs off the status line's
 * own path (see `startRefreshBehind`): a round started from a status line
 * spawns this whole command detached and never waits on it, so nothing here
 * can add to the milliseconds a render takes. Every failure is swallowed: a
 * refresh that could not sync still refreshed, and a hub that is unconfigured,
 * unreachable or has revoked this device is not this command's business to
 * report.
 */
async function triggerSyncAfterRefresh(
  dependencies: CliDependencies,
  now: string
): Promise<void> {
  try {
    const directory = dependencies.stateDirectory ?? resolveStateDirectory();
    const session = await readSession(directory);
    if (session === null) return;
    const renewal = await ensureFreshSession(session, now, dependencies.environment, dependencies.hubTransport);
    if (renewal.kind === "revoked") {
      await deleteSession(directory);
      return;
    }
    if (renewal.kind === "error") return;
    if (renewal.kind === "renewed") await persistRenewedSession(dependencies, renewal.session);
    const active = renewal.session;
    const snapshots = await cachedSnapshots(dependencies.stateDirectory);
    const outcome = await runSync({
      directory,
      environment: dependencies.environment,
      transport: dependencies.hubTransport,
      now,
      token: active.token,
      deviceId: active.deviceId,
      snapshots
    });
    if (outcome.kind === "revoked") await deleteSession(directory);
  } catch {
    /* A refresh that could not sync still refreshed. */
  }
}

/* -------------------------------------------------------------- setup */

const SETUP_SIGN_IN_PROMPT = "Sign in to sync your bars to the hub and your phone (free)";

async function promptOrSkip(dependencies: CliDependencies, question: string): Promise<boolean> {
  const answer = await dependencies.promptChoice?.(question) ?? "";
  return !answer.trim().toLowerCase().startsWith("s");
}

/** Step one: sign in, or say plainly why this machine did not. */
async function setupSignInStep(dependencies: CliDependencies): Promise<string[]> {
  const lines: string[] = ["1. Sign in", SETUP_SIGN_IN_PROMPT];
  const existing = await readSession(dependencies.stateDirectory);
  if (existing !== null) {
    lines.push("Already signed in as " + existing.accountLabel + ".");
    return lines;
  }
  if (!hubConfigured(dependencies.environment)) {
    lines.push("Skipped: the hub is not configured on this build.");
    return lines;
  }
  const proceed = await promptOrSkip(dependencies, "Enter to sign in, S to skip: ");
  if (!proceed) {
    lines.push("Skipped.");
    return lines;
  }
  const outcome = await runDeviceLogin({
    environment: dependencies.environment,
    transport: dependencies.hubTransport,
    sleep: dependencies.sleep,
    emit: dependencies.emit,
    ...(dependencies.interruptSignal === undefined ? {} : { interruptSignal: dependencies.interruptSignal }),
    openBrowser: dependencies.openBrowser,
    open: false
  });
  if (outcome.kind === "signed_in") {
    await writeSession(outcome.session, {
      ...(dependencies.stateDirectory === undefined ? {} : { directory: dependencies.stateDirectory }),
      platform: dependencies.platform,
      ...(dependencies.windowsAclRunner === undefined ? {} : { windowsAclRunner: dependencies.windowsAclRunner })
    });
    lines.push("Signed in as " + outcome.session.accountLabel + ".");
  } else if (outcome.kind === "cancelled") {
    lines.push("Cancelled.");
  } else {
    lines.push("Could not sign in this time. Run openlimiter login later.");
  }
  return lines;
}

/** Which acquisition provider reads this agent's own login, when one exists. */
const AGENT_CREDENTIAL_PROVIDER: Readonly<Partial<Record<AgentId, AcquisitionProvider>>> = {
  claude: "CLAUDE",
  codex: "CODEX",
  gemini: "GEMINI_CLI",
  antigravity: "ANTIGRAVITY",
  grok: "GROK",
  kimi: "KIMI"
};

/**
 * Agents whose device style sign in is untested on this build (decision D5):
 * shown as "verified on install" instead of a plain install nudge, and never
 * offered an interactive sign in of their own.
 */
const UNVERIFIED_DEVICE_LOGIN_AGENTS: ReadonlySet<AgentId> = new Set(["grok", "kimi"]);

type ConnectRowState = "use_current_login" | "sign_in" | "install" | "verified_on_install";

const CONNECT_ROW_LABEL: Readonly<Record<ConnectRowState, string>> = {
  use_current_login: "use current login",
  sign_in: "sign in",
  install: "install",
  verified_on_install: "verified on install"
};

async function connectRowState(
  agent: AgentId,
  installed: AgentInstallation | null,
  readCredential: (provider: AcquisitionProvider) => Promise<CredentialResult>
): Promise<ConnectRowState> {
  if (installed === null) {
    return UNVERIFIED_DEVICE_LOGIN_AGENTS.has(agent) ? "verified_on_install" : "install";
  }
  const provider = AGENT_CREDENTIAL_PROVIDER[agent];
  if (provider === undefined) return "sign_in";
  const credential = await readCredential(provider);
  return credential.ok ? "use_current_login" : "sign_in";
}

function codexFailureSentence(reason: DeviceLoginFailure): string {
  if (reason === "not_installed") return "not installed";
  if (reason === "too_old") return "this version is too old, upgrade Codex";
  if (reason === "storage") return "could not prepare a folder for this sign in";
  if (reason === "spawn") return "could not be started";
  return "printed no code to sign in with";
}

/**
 * Offer Codex's device sign in, watch it to an ending, and say which.
 *
 * `codex login --device-auth` runs with `CODEX_HOME` pointed at a folder this
 * product owns under its own state directory, so the person's own Codex
 * configuration is never touched. Ctrl C cancels the wait and kills the
 * child; the built in 180 second timeout does the same when nobody finishes.
 */
async function runCodexDeviceSignIn(
  dependencies: CliDependencies,
  installed: AgentInstallation
): Promise<string> {
  if (!codexVersionIsSupported(installed.version)) {
    return "Codex: " + codexFailureSentence("too_old") + ".";
  }
  const stateDirectory = dependencies.stateDirectory ?? resolveStateDirectory();
  const sessionId = randomUUID().replace(/-/gu, "");
  const home = managedCodexHome(stateDirectory, sessionId);
  if (home === null) return "Codex: " + codexFailureSentence("storage") + ".";
  const runner = dependencies.codexDeviceLoginRunnerFactory(installed.executable);
  let started;
  try {
    started = await startCodexDeviceLogin(runner, home, Date.now());
  } catch (error) {
    const reason = error instanceof DeviceLoginError ? error.reason : "spawn";
    return "Codex: " + codexFailureSentence(reason) + ".";
  }
  const { session, start } = started;
  dependencies.emit("Codex code: " + start.userCode);
  dependencies.emit("Codex at: " + start.verificationUrl);
  const deadline = Date.now() + LOGIN_TIMEOUT_MILLISECONDS;
  for (;;) {
    if (isAborted(dependencies.interruptSignal)) {
      session.cancel();
      return "Codex: sign in cancelled.";
    }
    const state = await session.state(Date.now());
    if (state.kind === "complete") return "Codex: signed in.";
    if (state.kind === "cancelled") return "Codex: sign in cancelled.";
    if (state.kind === "timed_out") return "Codex: sign in timed out.";
    if (state.kind === "failed") {
      return "Codex: " + codexFailureSentence(state.reason) + ".";
    }
    if (Date.now() >= deadline) {
      session.cancel();
      return "Codex: sign in timed out.";
    }
    await dependencies.sleep(1_000);
  }
}

/** Step two: detect installed agent CLIs and their logins, one row each. */
async function setupConnectStep(dependencies: CliDependencies): Promise<string[]> {
  const lines: string[] = ["2. Connect"];
  const environment = await environmentWithLocalMarkers(
    dependencies.environment,
    dependencies.stateDirectory
  );
  const readCredential = credentialReader(dependencies);
  let codexInstalled: AgentInstallation | null = null;
  let codexNeedsSignIn = false;
  for (const agent of CONNECT_AGENT_IDS) {
    const installed = await detectAgentInstallation(agent, {
      environment,
      platform: dependencies.platform
    });
    const state = await connectRowState(agent, installed, readCredential);
    lines.push(agent + ": " + CONNECT_ROW_LABEL[state]);
    if (agent === "codex") {
      codexInstalled = installed;
      codexNeedsSignIn = state === "sign_in";
    }
  }
  if (codexNeedsSignIn && codexInstalled !== null) {
    const proceed = await promptOrSkip(
      dependencies,
      "Codex has no login yet. Sign in now? Enter to start, S to skip: "
    );
    if (proceed) lines.push(await runCodexDeviceSignIn(dependencies, codexInstalled));
  } else {
    await promptOrSkip(dependencies, "Enter to accept: ");
  }
  return lines;
}

const CONNECT_AGENT_IDS: readonly AgentId[] = [
  "claude",
  "codex",
  "gemini",
  "antigravity",
  "grok",
  "kimi",
  "opencode"
];

/** Step three: the existing terminal checklist, unchanged. */
async function setupShowBarsStep(dependencies: CliDependencies): Promise<string[]> {
  const result = await terminalCommand(dependencies, ["terminal"]);
  return ["3. Show bars in", result.stdout];
}

/**
 * The three step first run: sign in, connect, show bars in, then the bars
 * themselves, once.
 */
async function setupCommand(dependencies: CliDependencies, now: string): Promise<CliResult> {
  const sections: string[] = [];
  sections.push(...(await setupSignInStep(dependencies)));
  sections.push(...(await setupConnectStep(dependencies)));
  sections.push(...(await setupShowBarsStep(dependencies)));
  const snapshots = await cachedSnapshots(dependencies.stateDirectory);
  sections.push(renderTable(snapshots, now, dependencies.colorOutput));
  return succeed(sections.join(NEWLINE));
}

export async function runCli(
  argumentsList: readonly string[],
  overrides: Partial<CliDependencies> = {}
): Promise<CliResult> {
  const dependencies = { ...defaults(), ...overrides };
  const command = argumentsList[0] ?? "setup";
  const now = dependencies.now();
  try {
    if (command === "setup") return await setupCommand(dependencies, now);
    if (command === "login") return await loginCommand(dependencies, argumentsList);
    if (command === "logout") return await logoutCommand(dependencies);
    if (command === "whoami") return await whoamiCommand(dependencies);
    if (command === "sync") return await syncCommand(dependencies, now);
    if (command === "init") return await initCommand(dependencies);
    if (command === "snapshot") {
      return await snapshotCommand(dependencies, argumentsList, now);
    }
    if (command === "statusline") {
      return await statuslineCommand(dependencies, argumentsList, now);
    }
    if (command === "terminal") {
      return await terminalCommand(dependencies, argumentsList);
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
    if (command === "refresh") return await refreshCommand(dependencies, now);
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
    /* A detached refresh writes to a discarded stream and has nobody to tell,
       so it fails quietly rather than leaving an exit code nothing reads. */
    if (command === "refresh") return { exitCode: EXIT_OK, stdout: "", stderr: "" };
    if (command === "statusline") {
      return { exitCode: EXIT_OK, stdout: "OpenLimiter UNKNOWN", stderr: "" };
    }
    return fail(EXIT_FAILURE, "openlimiter: the command did not complete.");
  }
}
