import { describe, expect, it } from "vitest";
import {
  CONNECTION_STATES,
  NETWORK_FAILURE_ERROR_THRESHOLD,
  connectionNextAction,
  connectionSentence,
  nextConnectionState,
  type ConnectionContext,
  type ConnectionEvent,
  type ConnectionState
} from "../src/index.js";

/** A connection that has never completed a read. */
const fresh: ConnectionContext = { everConnected: false };

/** A connection that worked at least once, whatever state it is in now. */
const proven: ConnectionContext = { everConnected: true };

const contexts: readonly [string, ConnectionContext][] = [
  ["a connection that never worked", fresh],
  ["a connection that worked once", proven]
];

/** States that describe a declaration, where a response cannot arrive. */
const declared = new Set<ConnectionState>([
  "NOT_CONFIGURED",
  "IMPORT_ONLY",
  "MANUAL",
  "UNSUPPORTED"
]);

const events: readonly ConnectionEvent[] = [
  { kind: "detected" },
  { kind: "credential_required" },
  { kind: "credential_stored" },
  { kind: "enable_requested" },
  { kind: "http_response", status: 200, parsed: true },
  { kind: "http_response", status: 200, parsed: false },
  { kind: "http_response", status: 401, parsed: false },
  { kind: "http_response", status: 403, parsed: false },
  { kind: "http_response", status: 404, parsed: false },
  { kind: "http_response", status: 429, parsed: false },
  { kind: "http_response", status: 500, parsed: false },
  { kind: "local_read", parsed: true },
  { kind: "local_read", parsed: false },
  { kind: "network_failure", consecutive: 1 },
  { kind: "network_failure", consecutive: NETWORK_FAILURE_ERROR_THRESHOLD },
  { kind: "expiry_passed" },
  { kind: "disconnected" },
  { kind: "declared_import_only" },
  { kind: "declared_manual" },
  { kind: "declared_unsupported" }
];

describe("connection states", () => {
  it("names the thirteen states from the connection architecture", () => {
    expect(CONNECTION_STATES).toHaveLength(13);
    expect(new Set(CONNECTION_STATES).size).toBe(13);
  });

  it("gives every state a sentence and a next action", () => {
    for (const state of CONNECTION_STATES) {
      expect(connectionSentence[state].length).toBeGreaterThan(3);
      expect(connectionNextAction[state].length).toBeGreaterThan(2);
    }
  });

  it.each(contexts)("answers every state and event pair for %s", (_name, context) => {
    const known = new Set<string>(CONNECTION_STATES);
    for (const state of CONNECTION_STATES) {
      for (const event of events) {
        expect(known.has(nextConnectionState(state, event, context))).toBe(true);
      }
    }
  });

  it.each(contexts)("is pure and repeatable for %s", (_name, context) => {
    for (const state of CONNECTION_STATES) {
      for (const event of events) {
        const first = nextConnectionState(state, event, context);
        const second = nextConnectionState(state, event, context);
        expect(second).toBe(first);
      }
    }
  });
});

describe("connection transitions", () => {
  it("connects on a parsed success", () => {
    expect(nextConnectionState("CONNECTING", {
      kind: "http_response",
      status: 200,
      parsed: true
    }, fresh)).toBe("CONNECTED");
    expect(nextConnectionState("CONNECTING", { kind: "local_read", parsed: true }, fresh))
      .toBe("CONNECTED");
  });

  it("calls a response we cannot parse an error, not a provider fault", () => {
    expect(nextConnectionState("CONNECTING", {
      kind: "http_response",
      status: 200,
      parsed: false
    }, fresh)).toBe("ERROR");
    expect(nextConnectionState("CONNECTED", { kind: "local_read", parsed: false }, fresh))
      .toBe("ERROR");
  });

  /**
   * The authentication answer comes from the record, not from the state.
   *
   * Every state gets both answers asserted, because the fact that decides it
   * is "has this connection ever worked", and no single state can carry that.
   * The regression underneath this is CONNECTED, then a 404 into ERROR, then a
   * 401: the state has forgotten, the record has not.
   */
  it.each([401, 403])("asks for a credential after %s when nothing ever worked", (
    status
  ) => {
    for (const state of CONNECTION_STATES) {
      if (declared.has(state)) continue;
      expect(nextConnectionState(
        state,
        { kind: "http_response", status, parsed: false },
        fresh
      )).toBe("NEEDS_AUTH");
    }
  });

  it.each([401, 403])("calls %s expiry from any state once it has worked", (status) => {
    for (const state of CONNECTION_STATES) {
      if (declared.has(state)) continue;
      expect(nextConnectionState(
        state,
        { kind: "http_response", status, parsed: false },
        proven
      )).toBe("AUTH_EXPIRED");
    }
  });

  it("remembers a credential worked even after an unrelated error", () => {
    const record = { everConnected: false };
    let state: ConnectionState = "CONNECTING";
    state = nextConnectionState(
      state,
      { kind: "http_response", status: 200, parsed: true },
      record
    );
    expect(state).toBe("CONNECTED");
    /* This is the flag a caller persists the moment a read succeeds. */
    record.everConnected = true;
    state = nextConnectionState(
      state,
      { kind: "http_response", status: 404, parsed: false },
      record
    );
    expect(state).toBe("ERROR");
    state = nextConnectionState(
      state,
      { kind: "http_response", status: 401, parsed: false },
      record
    );
    expect(state).toBe("AUTH_EXPIRED");
  });

  it.each([429, 500, 502, 503, 599])("degrades on %s", (status) => {
    expect(nextConnectionState("CONNECTED", {
      kind: "http_response",
      status,
      parsed: false
    }, fresh)).toBe("DEGRADED");
  });

  it("errors on a status that is neither success, auth nor overload", () => {
    expect(nextConnectionState("CONNECTED", {
      kind: "http_response",
      status: 404,
      parsed: false
    }, fresh)).toBe("ERROR");
  });

  it("degrades on one network failure and errors on repeated ones", () => {
    expect(nextConnectionState("CONNECTED", { kind: "network_failure", consecutive: 1 }, fresh))
      .toBe("DEGRADED");
    expect(nextConnectionState("DEGRADED", {
      kind: "network_failure",
      consecutive: NETWORK_FAILURE_ERROR_THRESHOLD
    }, fresh)).toBe("ERROR");
    expect(nextConnectionState("DEGRADED", {
      kind: "network_failure",
      consecutive: NETWORK_FAILURE_ERROR_THRESHOLD - 1
    }, fresh)).toBe("DEGRADED");
  });

  it("goes stale only from a state that has a reading", () => {
    expect(nextConnectionState("CONNECTED", { kind: "expiry_passed" }, fresh)).toBe("STALE");
    expect(nextConnectionState("DEGRADED", { kind: "expiry_passed" }, fresh)).toBe("STALE");
    for (const state of ["NOT_CONFIGURED", "DETECTED", "NEEDS_AUTH"] as const) {
      expect(nextConnectionState(state, { kind: "expiry_passed" }, fresh)).toBe(state);
    }
  });

  it("returns to not configured from anywhere on disconnect", () => {
    for (const state of CONNECTION_STATES) {
      expect(nextConnectionState(state, { kind: "disconnected" }, fresh)).toBe("NOT_CONFIGURED");
    }
  });

  it("walks the ordinary first run path", () => {
    const path: ConnectionEvent[] = [
      { kind: "detected" },
      { kind: "credential_required" },
      { kind: "credential_stored" },
      { kind: "enable_requested" },
      { kind: "http_response", status: 200, parsed: true }
    ];
    const seen: ConnectionState[] = [];
    let state: ConnectionState = "NOT_CONFIGURED";
    for (const event of path) {
      state = nextConnectionState(state, event, fresh);
      seen.push(state);
    }
    expect(seen).toEqual([
      "DETECTED",
      "NEEDS_AUTH",
      "READY_TO_ENABLE",
      "CONNECTING",
      "CONNECTED"
    ]);
  });

  it("recovers from expired authentication only after a new credential", () => {
    expect(nextConnectionState("AUTH_EXPIRED", { kind: "enable_requested" }, fresh))
      .toBe("AUTH_EXPIRED");
    expect(nextConnectionState("AUTH_EXPIRED", { kind: "credential_stored" }, fresh))
      .toBe("READY_TO_ENABLE");
    expect(nextConnectionState("NEEDS_AUTH", { kind: "enable_requested" }, fresh))
      .toBe("NEEDS_AUTH");
  });

  it("never promotes a declared source to connected", () => {
    for (const state of ["IMPORT_ONLY", "MANUAL", "UNSUPPORTED", "NOT_CONFIGURED"] as const) {
      expect(nextConnectionState(state, {
        kind: "http_response",
        status: 200,
        parsed: true
      }, fresh)).toBe(state);
      expect(nextConnectionState(state, { kind: "local_read", parsed: true }, fresh)).toBe(state);
      expect(nextConnectionState(state, { kind: "enable_requested" }, fresh)).toBe(state);
    }
  });

  it("lets the product declare a source at any time", () => {
    expect(nextConnectionState("CONNECTED", { kind: "declared_import_only" }, fresh))
      .toBe("IMPORT_ONLY");
    expect(nextConnectionState("CONNECTED", { kind: "declared_manual" }, fresh)).toBe("MANUAL");
    expect(nextConnectionState("CONNECTED", { kind: "declared_unsupported" }, fresh))
      .toBe("UNSUPPORTED");
  });
});
