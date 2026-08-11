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
 *   a probe answers with a tagged union, ProbeOutcome, whose kind is
 *   "response" or "transport_failure", and every arm carries connection_id,
 *   reader_id and attempt_generation;
 *
 *   CompleteAttemptInput is { connection_id, attempt_generation, disposition }
 *   where disposition is one of parsed_test, cache_committed, drift or
 *   cache_failure. An attempt is only a success once it completes;
 *
 *   UpdateConnectionInput is { connection_id, account_alias? }. There is no
 *   status input: connection state is written by Rust from what a read
 *   achieved, never by this window;
 *
 *   list_connections, detect_local_tools and cache_begin_write take no
 *   arguments; cache_commit_write takes { input: { text, generation } };
 *
 *   a failing command REJECTS with an object { kind }, out of a closed set of
 *   kinds, and this module is the one place those codes become sentences;
 *
 *   ConnectionRecord timestamps are epoch milliseconds or null;
 *
 *   a "response" arm carries { status, body, retry_after_seconds } with body
 *   null on every response outside the 200s.
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

/** The closed reader vocabulary, which is how a parser gets selected. */
export const WIRE_READER_IDS = Object.freeze([
  "openrouter_key",
  "openrouter_credits",
  "codex_usage",
  "antigravity_quota",
  "opencode_usage",
]);

/** The four ways an attempt may be closed. */
export const ATTEMPT_DISPOSITIONS = Object.freeze([
  "parsed_test",
  "cache_committed",
  "drift",
  "cache_failure",
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

/**
 * Close the attempt a probe opened, with what actually happened downstream.
 *
 * The generation binds this completion to that exact request. A completion
 * presenting a generation the backend has already moved past is refused with
 * stale_generation, which is how a slow parse from a superseded attempt can
 * never stamp a success onto a newer one.
 */
export async function completeAttempt({
  connectionId,
  attemptGeneration,
  disposition,
}) {
  if (!ATTEMPT_DISPOSITIONS.includes(disposition)) {
    return refusedInput("complete_attempt");
  }
  if (typeof attemptGeneration !== "number" || !Number.isFinite(attemptGeneration)) {
    return refusedInput("complete_attempt");
  }
  return call("complete_attempt", {
    input: {
      connection_id: connectionId,
      attempt_generation: attemptGeneration,
      disposition,
    },
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
 * Change a connection record's account alias. That is the whole verb.
 *
 * There is no status parameter and no status field on the wire. A connection's
 * state follows from what a read achieved, and Rust is the only thing that
 * observes that: it stamps the state when a probe settles and again when an
 * attempt completes. A window that could write the state could claim a
 * connection was working while nothing had ever been read from it, which is
 * exactly the dishonesty this product exists to remove.
 */
export async function updateConnection({ connectionId, accountAlias }) {
  const input = { connection_id: connectionId };
  if (accountAlias !== undefined) input.account_alias = accountAlias;
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

/**
 * A ProbeOutcome in one canonical shape.
 *
 * The union is mirrored exactly, with no third possibility invented: a value
 * whose kind is not one of the two, or whose reader is not in the closed
 * reader vocabulary, or whose generation or connection cannot be read, is
 * { kind: "unreadable" }. Unreadable is a failure everywhere downstream, never
 * a quietly emptied response, because a body with no reader has no parser and
 * a completion with no generation cannot be honest.
 */
export function normalizeProbeOutcome(value) {
  const unreadable = { kind: "unreadable" };
  if (value === null || typeof value !== "object") return unreadable;
  const readerId = value.reader_id ?? value.readerId ?? null;
  if (!WIRE_READER_IDS.includes(readerId)) return unreadable;
  const attemptGeneration = numberOf(
    value.attempt_generation ?? value.attemptGeneration,
  );
  if (attemptGeneration === null) return unreadable;
  const connectionId = value.connection_id ?? value.connectionId ?? null;
  if (typeof connectionId !== "string" || connectionId === "") return unreadable;
  const base = { connectionId, readerId, attemptGeneration };
  if (value.kind === "response") {
    const status = numberOf(value.status);
    if (status === null) return unreadable;
    return {
      kind: "response",
      ...base,
      status,
      body: typeof value.body === "string" ? value.body : null,
      retryAfterSeconds: numberOf(
        value.retry_after_seconds ?? value.retryAfterSeconds,
      ),
    };
  }
  if (value.kind === "transport_failure") {
    return {
      kind: "transport_failure",
      ...base,
      failure:
        typeof value.failure === "string" && value.failure !== ""
          ? value.failure
          : "unknown",
    };
  }
  return unreadable;
}
