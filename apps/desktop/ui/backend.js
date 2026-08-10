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
 *     { provider_id, account_alias, key_kind, status, secret };
 *
 *   ProbeInput is { connection_id, endpoint } where endpoint is the closed
 *   string "openrouter_key" or "openrouter_credits";
 *
 *   UpdateConnectionInput is { connection_id, account_alias?, status? };
 *
 *   list_connections, detect_local_tools and cache_begin_write take no
 *   arguments; cache_commit_write takes { input: { text, generation } };
 *
 *   a failing command REJECTS with an object { kind }, out of a closed set of
 *   kinds, and this module is the one place those codes become sentences;
 *
 *   ConnectionRecord timestamps are epoch milliseconds or null;
 *
 *   EndpointOutcome is { status, body, retry_after_seconds } with body null
 *   on every response outside the 200s.
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
 * stored on any object that outlives the call, and never returned: the only
 * thing a caller ever gets back about a credential is the masked label the
 * Rust side chose to publish. There is no console call anywhere in this file.
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
  not_json: "The text was not valid JSON.",
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

/** Put the current pressure on the tray. */
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
 * The interface's key kind words, mapped to the bare wire words.
 *
 * The backend validates key_kind against exactly ["inference", "management"]
 * and rejects anything else as invalid_input before the secret reaches the
 * credential store. The interface speaks in fuller words, so the translation
 * happens here, at the boundary, in one place. Anything that is not a
 * management key is an inference key, because those are the only two kinds
 * the wire has.
 */
function wireKeyKind(kind) {
  return /management/iu.test(String(kind ?? "")) ? "management" : "inference";
}

/**
 * Store a credential and create a connection record.
 *
 * The one call that carries a secret. See the header: it crosses here once,
 * inside the payload, and nothing about it is kept or logged on this side.
 * provider_id crosses uppercase and key_kind crosses as a bare wire word,
 * because the backend validates both against closed sets.
 */
export async function connectProvider({ providerId, accountAlias, keyKind, status, secret }) {
  return call("connect_provider", {
    input: {
      provider_id: String(providerId).toUpperCase(),
      account_alias: accountAlias,
      key_kind: wireKeyKind(keyKind),
      status,
      secret,
    },
  });
}

/** Ask the provider a question that proves the stored credential works. */
export async function testProvider({ connectionId, endpoint }) {
  return call("test_provider", {
    input: { connection_id: connectionId, endpoint },
  });
}

/** Perform one collection read for this connection, now. */
export async function refreshProvider({ connectionId, endpoint }) {
  return call("refresh_provider", {
    input: { connection_id: connectionId, endpoint },
  });
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

/**
 * Change a connection record: the alias, or the state the mirrored core state
 * machine computed. Never the secret. The backend stamps its own timestamps
 * off the status transition, which is why a successful refresh ends here.
 */
export async function updateConnection({ connectionId, accountAlias, status }) {
  const input = { connection_id: connectionId };
  if (accountAlias !== undefined) input.account_alias = accountAlias;
  if (status !== undefined) input.status = status;
  return call("update_connection", { input });
}

/** What supported local tools exist on this machine, without reading secrets. */
export async function detectLocalTools() {
  return call("detect_local_tools");
}

/* ---------------------------------------------------------- cache handshake */

/**
 * Open the cache write handshake: the current cache text under the lock, and
 * the generation stamp the commit must present.
 */
export async function cacheBeginWrite() {
  return call("cache_begin_write");
}

/** Commit the merged cache text, or be refused if the generation moved. */
export async function cacheCommitWrite({ text, generation }) {
  return call("cache_commit_write", { input: { text, generation } });
}

/**
 * The begin handshake's answer in one canonical shape.
 *
 * Null text is an empty cache, which is a real state. A missing generation is
 * not: without the stamp no commit can be honest, so the caller fails closed
 * and writes nothing.
 */
export function normalizeBeginWrite(value) {
  if (value === null || typeof value !== "object") {
    return { text: null, generation: null };
  }
  const text = value.text ?? value.cache_text ?? null;
  const generation = value.generation ?? value.gen ?? null;
  return {
    text: typeof text === "string" ? text : null,
    generation:
      typeof generation === "number" && Number.isFinite(generation)
        ? generation
        : null,
  };
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
    credentialKind: pick(record, [
      "key_kind",
      "keyKind",
      "credential_kind",
      "credentialKind",
    ]),
    maskedLabel: pick(record, [
      "masked_label",
      "maskedLabel",
      "credential_label",
      "credentialLabel",
    ]),
    lastSuccessAt: instantOf(
      pick(record, [
        "last_success_at",
        "lastSuccessAt",
        "last_successful_refresh_at",
        "lastSuccessfulRefreshAt",
      ]),
    ),
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
      pick(record, ["consecutive_failures", "consecutiveFailures", "failure_count", "failureCount"]),
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

/**
 * An EndpointOutcome in one canonical shape:
 * { status, body, retryAfterSeconds }, with body null outside the 200s
 * exactly as the backend sends it. A status this cannot read is null, and a
 * null status is an answer nothing downstream may claim anything from.
 */
export function normalizeOutcome(value) {
  if (value === null || typeof value !== "object") {
    return { status: null, body: null, retryAfterSeconds: null };
  }
  const status = numberOf(value.status);
  const body = typeof value.body === "string" ? value.body : null;
  const retryAfterSeconds = numberOf(
    value.retry_after_seconds ?? value.retryAfterSeconds,
  );
  return { status, body, retryAfterSeconds };
}
