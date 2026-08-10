/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * The connection lifecycle, as one pure function and two human tables.
 *
 * A parser is not a connection. The product's central honesty problem is that
 * an implemented parser has been able to look like a live account, so the state
 * a connection is in has to be a value the whole product agrees on rather than
 * a sentence each surface invents. Everything here is data and arithmetic: no
 * clock, no network, no storage, so a surface can replay a connection's whole
 * history and get the same answer every time.
 */

export const CONNECTION_STATES = [
  "NOT_CONFIGURED",
  "DETECTED",
  "NEEDS_AUTH",
  "READY_TO_ENABLE",
  "CONNECTING",
  "CONNECTED",
  "DEGRADED",
  "STALE",
  "AUTH_EXPIRED",
  "IMPORT_ONLY",
  "MANUAL",
  "UNSUPPORTED",
  "ERROR"
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * How many consecutive network failures turn a degraded connection into a
 * broken one. One timeout is a bad moment; three in a row is a fault worth
 * showing a person.
 */
export const NETWORK_FAILURE_ERROR_THRESHOLD = 3;

export type ConnectionEvent =
  /** A supported local tool was found on this machine. */
  | { kind: "detected" }
  /** Setup established that this connection cannot proceed without a secret. */
  | { kind: "credential_required" }
  /** A secret was accepted into the operating system credential store. */
  | { kind: "credential_stored" }
  /** The user asked for this connection to start collecting. */
  | { kind: "enable_requested" }
  /** A remote read finished. `parsed` says whether we understood the body. */
  | { kind: "http_response"; status: number; parsed: boolean }
  /** A local read finished, for readers that never speak HTTP. */
  | { kind: "local_read"; parsed: boolean }
  /** A read never reached the provider. `consecutive` counts failures in a row. */
  | { kind: "network_failure"; consecutive: number }
  /** The newest observation aged past its own expiry. */
  | { kind: "expiry_passed" }
  /** The user removed this connection. */
  | { kind: "disconnected" }
  /** The product states this source can only be fed by an explicit import. */
  | { kind: "declared_import_only" }
  /** The product states this source is a user maintained plan. */
  | { kind: "declared_manual" }
  /** The product states no safe automatic source exists for this product. */
  | { kind: "declared_unsupported" };

/**
 * States that describe something the product declared rather than something it
 * attempted. A response cannot arrive in any of them, so a stray one is ignored
 * instead of quietly promoting an import only source to Connected.
 */
const declaredStates = new Set<ConnectionState>([
  "NOT_CONFIGURED",
  "IMPORT_ONLY",
  "MANUAL",
  "UNSUPPORTED"
]);

/**
 * What the transition function cannot work out from the current state alone.
 *
 * The one authentication question is whether this connection has ever worked,
 * and the current state cannot answer it. CONNECTED then a 404 lands in ERROR,
 * and a 401 arriving there would read as "we never had a credential" when what
 * actually happened is that a credential which used to work stopped, which is a
 * different sentence and a different button. So the fact is carried on the
 * connection record, where it belongs, and passed in. It is one way: nothing
 * ever sets it back to false, because a connection that worked once always did.
 */
export interface ConnectionContext {
  everConnected: boolean;
}

function afterResponse(
  state: ConnectionState,
  status: number,
  parsed: boolean,
  context: ConnectionContext
): ConnectionState {
  if (declaredStates.has(state)) return state;
  if (status === 401 || status === 403) {
    return context.everConnected ? "AUTH_EXPIRED" : "NEEDS_AUTH";
  }
  if (status === 429 || (status >= 500 && status <= 599)) return "DEGRADED";
  if (status < 200 || status > 299) return "ERROR";
  /*
   * The response arrived and was refused by our own parser. The connection is
   * healthy and our understanding of it is not, which is the exact failure the
   * Claude statusline contract mismatch was, so it reads as an error rather
   * than as a provider problem.
   */
  return parsed ? "CONNECTED" : "ERROR";
}

/**
 * Advance a connection by one event.
 *
 * Total and pure: every state, event and context triple has an answer, and an
 * event that makes no sense where it arrived leaves the state exactly as it was
 * rather than inventing a transition. The context is required rather than
 * defaulted, because a caller that forgets it would silently get the wrong
 * authentication answer, and a compiler error is cheaper than that.
 */
export function nextConnectionState(
  state: ConnectionState,
  event: ConnectionEvent,
  context: ConnectionContext
): ConnectionState {
  switch (event.kind) {
    case "disconnected":
      return "NOT_CONFIGURED";
    case "declared_import_only":
      return "IMPORT_ONLY";
    case "declared_manual":
      return "MANUAL";
    case "declared_unsupported":
      return "UNSUPPORTED";
    case "detected":
      return state === "NOT_CONFIGURED" ? "DETECTED" : state;
    case "credential_required":
      return state === "NOT_CONFIGURED" ||
        state === "DETECTED" ||
        state === "READY_TO_ENABLE"
        ? "NEEDS_AUTH"
        : state;
    case "credential_stored":
      return state === "NEEDS_AUTH" ||
        state === "AUTH_EXPIRED" ||
        state === "DETECTED"
        ? "READY_TO_ENABLE"
        : state;
    case "enable_requested":
      /*
       * A connection missing its credential cannot start collecting no matter
       * how many times the button is pressed, so those two states hold.
       */
      return state === "NEEDS_AUTH" ||
        state === "AUTH_EXPIRED" ||
        declaredStates.has(state)
        ? state
        : "CONNECTING";
    case "http_response":
      return afterResponse(state, event.status, event.parsed, context);
    case "local_read":
      if (declaredStates.has(state)) return state;
      return event.parsed ? "CONNECTED" : "ERROR";
    case "network_failure":
      if (declaredStates.has(state)) return state;
      return event.consecutive >= NETWORK_FAILURE_ERROR_THRESHOLD
        ? "ERROR"
        : "DEGRADED";
    case "expiry_passed":
      /*
       * Stale means the last reading is too old to trust, which only makes
       * sense once a reading exists. Nothing else ages.
       */
      return state === "CONNECTED" || state === "DEGRADED" ? "STALE" : state;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** One sentence per state, written for a person rather than for a log. */
export const connectionSentence = {
  NOT_CONFIGURED: "Not connected.",
  DETECTED: "Found on this machine but not collecting yet.",
  NEEDS_AUTH: "Waiting for a credential.",
  READY_TO_ENABLE: "Ready to start collecting.",
  CONNECTING: "Connecting.",
  CONNECTED: "Connected and collecting.",
  DEGRADED: "The provider is refusing reads for now.",
  STALE: "The last reading is older than it should be.",
  AUTH_EXPIRED: "The stored credential stopped working.",
  IMPORT_ONLY: "Reads only what you import. Nothing is collected automatically.",
  MANUAL: "Shows the plan you entered yourself.",
  UNSUPPORTED: "No safe automatic source exists for this product yet.",
  ERROR: "This connection failed and needs a look."
} as const satisfies Record<ConnectionState, string>;

/** The one thing to do next, in the words of the button that does it. */
export const connectionNextAction = {
  NOT_CONFIGURED: "Connect",
  DETECTED: "Enable local integration",
  NEEDS_AUTH: "Add credential",
  READY_TO_ENABLE: "Enable",
  CONNECTING: "Wait",
  CONNECTED: "Refresh now",
  DEGRADED: "Wait for the next retry",
  STALE: "Refresh now",
  AUTH_EXPIRED: "Reconnect",
  IMPORT_ONLY: "Import a payload",
  MANUAL: "Edit plan",
  UNSUPPORTED: "Add manual plan",
  ERROR: "View diagnostics"
} as const satisfies Record<ConnectionState, string>;
