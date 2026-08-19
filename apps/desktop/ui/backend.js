/**
 * The one boundary between this window and the Rust process.
 *
 * Every Tauri invoke in the interface goes through this module, and no other
 * file names a command. The Rust side's shapes are the contract and this
 * adapter adapts to them, not the reverse:
 *
 *   connect_provider, test_provider, refresh_provider, disconnect_provider
 *   and update_connection take ONE argument named `input`, so the payload is
 *   { input: {...} } with snake_case fields inside;
 *
 *   ConnectProviderInput is flat:
 *     { provider_id, credential_kind, account_alias, secret }, where the
 *     first two are closed snake_case identifiers and NEITHER an endpoint nor
 *     a starting status may be named;
 *
 *   ProbeInput is { connection_id } and nothing else. The endpoint is derived
 *   in Rust from the stored connection's provider and credential kind, so
 *   this window cannot pair a secret with an address;
 *
 *   test_provider and refresh_provider answer with a body free tagged union:
 *   tested, cache_committed, or failed. Parsing, cache mutation and backoff
 *   have already happened in Rust when that result arrives;
 *
 *   UpdateConnectionInput is { connection_id, account_alias? }. There is no
 *   status input: connection state is written by Rust from what a read
 *   achieved, never by this window;
 *
 *   list_connections, detect_local_tools, list_detected_providers and
 *   collector_status take no
 *   arguments;
 *
 *   a failing command REJECTS with an object { kind }, out of a closed set of
 *   kinds, and this module is the one place those codes become sentences;
 *
 *   ConnectionRecord timestamps are epoch milliseconds or null.
 *
 * A command that is not registered at all reports BACKEND_ABSENT, the
 * interface renders an honest "this build has no connection backend yet"
 * state, and nothing is simulated in its place. No fake data, no demo
 * fallback, ever.
 *
 * Every call returns a result object rather than throwing:
 *
 *   { ok: true, value }
 *   { ok: false, reason: "backend_absent", command }
 *   { ok: false, reason: "command_failed", command, kind, message }
 *
 * `kind` is the backend's own failure code when it sent one, so a caller can
 * branch on stale_generation or busy, and `message` is the human sentence
 * with the raw kind kept visible inside it.
 *
 * SECRETS. connectProvider is the only function here that ever carries one.
 * The secret crosses this module exactly once, inside the invoke payload, on
 * its way to the operating system credential store. It is never logged, never
 * stored on any object that outlives the call, and never returned. A Codex
 * connection may carry its nonsecret account identifier beside the masked
 * label, but neither value is ever logged. There is no console call anywhere
 * in this file.
 */

/**
 * The Tauri surface, or null when this page is running outside the shell,
 * which is what a static serve of these files is. Outside the shell there is
 * no backend at all, so every command reports BACKEND_ABSENT and the window
 * renders exactly what it can prove, which is nothing.
 */
const runtime = (() => {
  if (typeof window === "undefined") return null;
  const tauri = window.__TAURI__;
  if (
    tauri === undefined ||
    tauri === null ||
    typeof tauri.core?.invoke !== "function"
  ) {
    return null;
  }
  return tauri;
})();

/** The reason code every caller checks for. */
export const BACKEND_ABSENT = "backend_absent";

/**
 * The backend's closed failure vocabulary, one human sentence per kind.
 *
 * The two kinds a caller can act on by simply trying again say so. The
 * credential kind names the operating system store, because "storage" would
 * leave a person checking the wrong thing. The network kinds name the step
 * that failed plainly. A kind outside this table still renders as itself
 * rather than as a shrug: a typed failure never becomes "failed without a
 * message".
 */
const FAILURE_SENTENCES = {
  invalid_input: "The backend refused this input as invalid.",
  not_found: "No such record exists in this build.",
  full: "The connection store is full, so nothing more can be added.",
  corrupt: "A stored record could not be read.",
  storage: "Writing to this machine's storage failed.",
  credential_store: "The operating system credential store refused the operation.",
  timeout: "The provider did not answer before the time limit.",
  connect: "The network connection to the provider could not be opened.",
  protocol: "The provider answered in a shape this build does not understand.",
  too_large: "The answer was too large to accept.",
  busy: "Another write held the cache. Trying again may succeed.",
  stale_generation: "The cache moved underneath this write. Trying again may succeed.",
  no_delivered_body:
    "That read never received an answer from the provider, so there is nothing " +
    "to record from it.",
  too_soon: "That was too soon after the last one. Trying again shortly may succeed.",
  not_json: "The text was not valid JSON.",
  codex_login_required: "Codex needs a current login. Run codex login.",
};

function absent(command) {
  return { ok: false, reason: BACKEND_ABSENT, command };
}

function failed(command, kind, message) {
  return { ok: false, reason: "command_failed", command, kind, message };
}

/**
 * Whether an invoke rejection means the command does not exist in this build.
 *
 * Tauri rejects an unknown command with a sentence naming it as not found,
 * and a command outside the capability allowlist as not allowed. Both mean
 * the same thing to this window: the backend it is talking to does not carry
 * the connection subsystem, so the honest rendering is the absent state, not
 * an error card that implies the subsystem exists and broke. A typed { kind }
 * rejection is never absence: it is the subsystem answering.
 */
function isMissingCommand(error) {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return /not found|unknown command|not allowed/iu.test(text);
}

/** The backend's failure kind out of a rejection, or null. */
function kindOf(error) {
  if (error !== null && typeof error === "object" && typeof error.kind === "string") {
    return error.kind;
  }
  return null;
}

/** A rejection as one result, typed kinds mapped to their sentences. */
function failureOf(command, error) {
  const kind = kindOf(error);
  if (kind !== null) {
    const sentence =
      FAILURE_SENTENCES[kind] ?? "The backend reported " + kind + ".";
    return failed(command, kind, sentence + " (" + kind + ")");
  }
  if (typeof error === "string" && error !== "") {
    return failed(command, null, error);
  }
  if (error instanceof Error && error.message !== "") {
    return failed(command, null, error.message);
  }
  return failed(command, null, "The command failed without a message.");
}

async function call(command, args) {
  if (runtime === null) return absent(command);
  try {
    const value = await runtime.core.invoke(command, args);
    return { ok: true, value };
  } catch (error) {
    if (isMissingCommand(error)) return absent(command);
    return failureOf(command, error);
  }
}

/* --------------------------------------------------------- reading commands */

/* The four commands the first desktop release shipped with. They exist in
   every build this window can be running inside, but they go through the same
   result shape anyway, so a static serve of these files degrades to the empty
   state instead of a module level crash. */

/** The snapshot cache as text, or null when there is nothing to read. */
export async function readCache() {
  return call("read_cache");
}

/** The manual quota document as text, or null. */
export async function readManual() {
  return call("read_manual");
}

/** Where the cache is looked for, so the window can say so plainly. */
export async function stateDirectory() {
  return call("state_directory");
}

/** Put one normalized percentage per provider on the native tray. */
export async function setTrayStatus(status) {
  return call("set_tray_status", status);
}

/**
 * Listen for a backend event.
 *
 * Outside the shell there is no event system, so this resolves to a no op
 * unlisten function and the handler simply never fires, which is the truth:
 * no backend, no ticks.
 */
export async function listen(event, handler) {
  if (runtime === null || typeof runtime.event?.listen !== "function") {
    return () => {};
  }
  return runtime.event.listen(event, handler);
}

/* ------------------------------------------------------ connection commands */

/**
 * The closed provider vocabulary the wire speaks, lowercase.
 *
 * Shorter than the engine's PROVIDER_CODES: CLAUDE is a local statusline
 * payload and MANUAL is a document a person maintains, so neither holds a
 * credential and neither can be connected through this path.
 */
export const WIRE_PROVIDER_IDS = Object.freeze([
  "openrouter",
  "codex",
  "antigravity",
  "opencode",
]);

/** The closed credential vocabulary the wire speaks. */
export const WIRE_CREDENTIAL_KINDS = Object.freeze([
  "openrouter_inference_key",
  "openrouter_management_key",
  "codex_session",
  "antigravity_session",
  "opencode_browser_session",
]);

function refusedInput(command) {
  return failed(
    command,
    "invalid_input",
    FAILURE_SENTENCES.invalid_input + " (invalid_input)",
  );
}

/**
 * Store a credential and create a connection record.
 *
 * The one call that carries a secret. See the header: it crosses here once,
 * inside the payload, and nothing about it is kept or logged on this side.
 *
 * Both identifiers cross as the exact closed words the registry, the Rust and
 * this file all spell one way. An identifier outside its vocabulary is refused
 * here rather than coerced into a neighbouring one: guessing which provider
 * somebody meant is how a secret ends up at the wrong address.
 */
export async function connectProvider({
  providerId,
  credentialKind,
  accountAlias,
  secret,
}) {
  const provider = String(providerId ?? "").toLowerCase();
  const credential = String(credentialKind ?? "").toLowerCase();
  if (!WIRE_PROVIDER_IDS.includes(provider)) return refusedInput("connect_provider");
  if (!WIRE_CREDENTIAL_KINDS.includes(credential)) {
    return refusedInput("connect_provider");
  }
  return call("connect_provider", {
    input: {
      provider_id: provider,
      credential_kind: credential,
      account_alias: accountAlias,
      secret,
    },
  });
}

/**
 * Ask the provider a question that proves the stored credential works.
 *
 * No endpoint crosses. Rust derives the address from the stored connection,
 * which is the whole point of the version 2 contract: this window can name a
 * connection and can name nothing about where that connection reads from.
 */
export async function testProvider({ connectionId }) {
  return call("test_provider", {
    input: { connection_id: connectionId },
  });
}

/** Perform one collection read for this connection, now. */
export async function refreshProvider({ connectionId }) {
  return call("refresh_provider", {
    input: { connection_id: connectionId },
  });
}

/** The native collector heartbeat and its last closed failure, if any. */
export async function collectorStatus() {
  return call("collector_status");
}

/** Remove the connection and its stored credential. */
export async function disconnectProvider(connectionId) {
  return call("disconnect_provider", {
    input: { connection_id: connectionId },
  });
}

/** Every connection record the backend holds. */
export async function listConnections() {
  return call("list_connections");
}

/** What supported local tools exist on this machine, without reading secrets. */
export async function detectLocalTools() {
  return call("detect_local_tools");
}

/** The provider and account presence report owned by the native detector. */
export async function listDetectedProviders() {
  return call("list_detected_providers");
}

/** Check the real CLI and Claude Code settings without changing either. */
export async function claudeConnectPreflight({ configuredCliPath } = {}) {
  return call("claude_connect_preflight", {
    input: {
      ...(configuredCliPath === undefined
        ? {}
        : { configured_cli_path: configuredCliPath }),
    },
  });
}

/** Back up Claude Code settings and add only the OpenLimiter entries. */
export async function claudeConnectApply({ configuredCliPath } = {}) {
  return call("claude_connect_apply", {
    input: {
      ...(configuredCliPath === undefined
        ? {}
        : { configured_cli_path: configuredCliPath }),
    },
  });
}

/** Remove only the entries owned by OpenLimiter. */
export async function claudeDisconnect() {
  return call("claude_disconnect");
}

/* ------------------------------------------------------------ record shapes */

/** The first defined value under any of several key spellings. */
function pick(record, names) {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/**
 * A timestamp as an ISO string. The contract says epoch milliseconds or
 * null; a string is taken as already formatted. Anything unreadable is null,
 * and null is rendered as unknown, never as an invented instant.
 */
function instantOf(value) {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One connection record in one canonical shape.
 *
 * The record's own fields are snake_case per the contract; the camelCase
 * spellings are read as a harmless tolerance, never required. A field the
 * record does not carry is null, and the interface renders null as an honest
 * absence. Nothing is defaulted into looking configured.
 */
export function normalizeConnection(record) {
  if (record === null || typeof record !== "object") return null;
  const id = pick(record, ["id", "connection_id", "connectionId"]);
  if (id === null) return null;
  const provider = pick(record, ["provider_id", "provider", "providerId"]);
  return {
    id: String(id),
    provider: provider === null ? null : String(provider).toUpperCase(),
    product: pick(record, ["product", "product_name", "productName"]),
    accountAlias: pick(record, ["account_alias", "accountAlias", "alias"]),
    /* Left exactly as sent. The view checks it against the core's own state
       list and shows an unrecognised code as the code, claiming nothing. */
    state: pick(record, ["status", "state", "connection_state", "connectionState"]),
    sourceType: pick(record, ["source_type", "sourceType", "reader_kind", "readerKind"]),
    credentialKind: pick(record, ["credential_kind", "credentialKind"]),
    /* Which reader this connection uses, and therefore which parser its body
       may be handed to. Read from the record, never chosen here. */
    readerId: pick(record, ["reader_id", "readerId"]),
    attemptGeneration: numberOf(
      pick(record, ["attempt_generation", "attemptGeneration"]),
    ),
    maskedLabel: pick(record, [
      "masked_label",
      "maskedLabel",
      "credential_label",
      "credentialLabel",
    ]),
    lastSuccessAt: instantOf(pick(record, ["last_success_at", "lastSuccessAt"])),
    lastAttemptAt: instantOf(pick(record, ["last_attempt_at", "lastAttemptAt"])),
    nextRefreshAt: instantOf(
      pick(record, ["next_refresh_at", "nextRefreshAt", "next_attempt_at", "nextAttemptAt"]),
    ),
    baseSeconds: numberOf(
      pick(record, [
        "base_seconds",
        "baseSeconds",
        "refresh_interval_seconds",
        "refreshIntervalSeconds",
      ]),
    ),
    consecutiveFailures: numberOf(
      pick(record, ["consecutive_failures", "consecutiveFailures"]),
    ),
    everConnected:
      pick(record, ["ever_connected", "everConnected"]) === true,
  };
}

/** A list command result as canonical records, dropping nothing silently. */
export function normalizeConnectionList(value) {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && Array.isArray(value.connections)
      ? value.connections
      : [];
  const records = [];
  for (const entry of list) {
    const record = normalizeConnection(entry);
    if (record !== null) records.push(record);
  }
  return records;
}

export const COLLECTOR_FAILURE_SENTENCES = Object.freeze({
  timeout: "The provider did not answer before the time limit.",
  connect: "The network connection to the provider could not be opened.",
  tls: "TLS negotiation with the provider failed.",
  oversize: "The provider answer was too large to accept.",
  invalid_utf8: "The provider answer was not valid UTF-8.",
  provider_response: "The provider refused the quota read.",
  empty_body: "The provider returned no quota document.",
  drift: "The provider answered, but its quota document no longer matched the reader.",
  cache: "The quota was read, but the local cache could not be updated.",
  busy: "That connection already has a collection in progress.",
  internal: "The native collector could not complete its local transaction.",
});

/** A native collection result, with no response body anywhere on the wire. */
export function normalizeCollectionOutcome(value) {
  const unreadable = {
    kind: "unreadable",
    succeeded: false,
    reason: "internal",
    status: null,
    message: "The backend's collection result could not be read.",
  };
  if (value === null || typeof value !== "object") return unreadable;
  const connectionId = value.connection_id ?? value.connectionId;
  if (typeof connectionId !== "string" || connectionId === "") return unreadable;
  if (value.kind === "tested" || value.kind === "cache_committed") {
    return {
      kind: value.kind,
      connectionId,
      succeeded: true,
      reason: null,
      status: null,
      message: null,
    };
  }
  if (value.kind !== "failed") return unreadable;
  const reason = typeof value.reason === "string" ? value.reason : "internal";
  const status = numberOf(value.status);
  const base = COLLECTOR_FAILURE_SENTENCES[reason] ??
    "The native collector reported " + reason + ".";
  return {
    kind: "failed",
    connectionId,
    succeeded: false,
    reason,
    status,
    message: status === null ? base : base + " Provider status: " + String(status) + ".",
  };
}

/** Collector status survives a renderer reload because Rust owns it. */
export function normalizeCollectorStatus(value) {
  if (value === null || typeof value !== "object") {
    return { ticks: 0, lastPassAt: null, lastFailure: "internal" };
  }
  const ticks = numberOf(value.ticks);
  const lastFailure = value.last_failure ?? value.lastFailure ?? null;
  return {
    ticks: ticks === null ? 0 : ticks,
    lastPassAt: instantOf(value.last_pass_at ?? value.lastPassAt),
    lastFailure: typeof lastFailure === "string" ? lastFailure : null,
  };
}
