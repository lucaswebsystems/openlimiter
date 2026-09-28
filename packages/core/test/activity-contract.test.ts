import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_AGENTS, ACTIVITY_EVENT_VERSION, ACTIVITY_SESSION_RETIREMENT_MS, ACTIVITY_STATES,
  MAX_ACTIVITY_EVENT_AGE_MS, MAX_ACTIVITY_EVENT_BYTES, MAX_ACTIVITY_SPOOL_BYTES, MAX_LIVE_ACTIVITY_SESSIONS,
  dedupeActivityEvents, isActivityDisplayRecord, isActivityEvent, isActivityUploadRecord, nextSessionState, readActivityEvent, shouldRetireActivitySession,
  toDisplayRecord, toUploadRecord, type ActivityEvent, type ActivitySession
} from "../src/activity/contract.js";

const at = "2026-09-28T12:00:00.000Z";
const now = Date.parse(at);
const event = (changes: Partial<ActivityEvent> = {}): ActivityEvent => ({
  version: 1, eventId: "event-0", sessionId: "payload-session", sequence: 0, agent: "claude_code",
  observedAt: at, state: "busy", source: "hook", confidence: "explicit", ...changes
});
const initial = (changes: Partial<ActivityEvent> = {}): ActivitySession => nextSessionState(null, event(changes)).session;
const following = (changes: Partial<ActivityEvent> = {}): ActivityEvent => event({ eventId: "event-1", sequence: 1, ...changes });

describe("activity boundary", () => {
  it("freezes limits and every agent", () => {
    expect([ACTIVITY_EVENT_VERSION, MAX_ACTIVITY_EVENT_BYTES, MAX_ACTIVITY_SPOOL_BYTES,
      MAX_ACTIVITY_EVENT_AGE_MS, MAX_LIVE_ACTIVITY_SESSIONS, ACTIVITY_SESSION_RETIREMENT_MS])
      .toEqual([1, 8192, 16777216, 86400000, 64, 86400000]);
    expect(ACTIVITY_AGENTS).toEqual(["claude_code", "codex", "muse", "gemini_cli", "cursor", "kimi", "grok", "antigravity"]);
    for (const agent of ACTIVITY_AGENTS) expect(isActivityEvent(event({ agent }), now)).toBe(true);
  });
  it("takes the exact opaque payload id and accepts every supported source", () => {
    expect(readActivityEvent(JSON.stringify(event()), now).sessionId).toBe("payload-session");
    for (const source of ["hook", "registry", "transcript", "rollout", "editor_state"] as const)
      expect(isActivityEvent(event({ source }), now, "desktop")).toBe(true);
  });
  it.each([
    { version: 2 }, { eventId: "" }, { sessionId: "" }, { sequence: -1 }, { sequence: 0.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 }, { agent: "other" }, { state: "ended" }, { source: "http" },
    { confidence: "likely" }, { outcome: "success" }, { accountAlias: "" }, { isSidechain: "true" },
    { observedAt: "2026-02-30T12:00:00.000Z" }, { observedAt: "2026-09-28" },
    { observedAt: "2026-09-28T12:00:00.001Z" }, { observedAt: "2026-09-27T11:59:59.999Z" },
    { state: "done", confidence: "inferred" }, { state: "done", outcome: "failed" },
    { signal: "user_question", confidence: "inferred" }, { signal: "claude_stop", agent: "codex" },
    { parentSessionId: "payload-session" }, { signal: "arbitrary" }, { prompt: "private" }
  ])("rejects malformed event %j", (changes) => {
    expect(isActivityEvent({ ...event(), ...changes }, now)).toBe(false);
  });
  it("allows age equality, rejects unknown properties and enforces original UTF8 byte size", () => {
    expect(isActivityEvent(event({ observedAt: new Date(now - MAX_ACTIVITY_EVENT_AGE_MS).toISOString() }), now)).toBe(true);
    const json = JSON.stringify(event());
    expect(readActivityEvent(json + " ".repeat(MAX_ACTIVITY_EVENT_BYTES - json.length), now)).toEqual(event());
    expect(() => readActivityEvent(json + " ".repeat(MAX_ACTIVITY_EVENT_BYTES), now)).toThrow("too large");
    expect(() => readActivityEvent(JSON.stringify({ ...event(), accountAlias: "🔥".repeat(2500) }), now)).toThrow("too large");
    expect(() => readActivityEvent("{broken", now)).toThrow("invalid JSON");
    expect(() => readActivityEvent(JSON.stringify({ ...event(), transcript: "private" }), now)).toThrow("invalid event");
    expect(isActivityEvent(event(), NaN)).toBe(false);
    expect(isActivityEvent(null, now)).toBe(false);
    const circular: Record<string, unknown> = { ...event() }; circular["process"] = circular;
    expect(isActivityEvent(circular, now)).toBe(false);
  });
  it("F16 restricts hooks to ppid and requires the desktop pid and start time pair", () => {
    expect(isActivityEvent(event({ process: { ppid: 42 } }), now)).toBe(true);
    const resolved = event({ process: { ppid: 42, pid: 7, startedAt: at } });
    expect(isActivityEvent(resolved, now)).toBe(false);
    expect(isActivityEvent(resolved, now, "desktop")).toBe(true);
    expect(isActivityEvent(event({ source: "registry" }), now)).toBe(false);
    for (const process of [{}, { ppid: 0 }, { pid: 7 }, { startedAt: at }, { ppid: 42, terminal: "private" },
      { pid: 7, startedAt: "2026-09-28T12:00:00.001Z" }]) {
      expect(isActivityEvent({ ...event(), process }, now)).toBe(false);
      if (Object.keys(process).length > 0) expect(isActivityEvent({ ...event(), process }, now, "desktop")).toBe(false);
    }
  });
});

describe("activity precedence", () => {
  it.each(ACTIVITY_STATES)("first %s observation is a silent baseline", (state) => {
    expect(nextSessionState(null, event({ state }))).toMatchObject({ notification: null, reason: "baseline", session: { state } });
  });
  it.each([
    ["inferred", "explicit", "waiting", "waiting", "agent_waiting"],
    ["explicit", "inferred", "busy", "waiting", null],
    ["inferred", "inferred", "busy", "busy", null],
    ["explicit", "explicit", "done", "done", "agent_done"],
    ["explicit", "explicit", "waiting", "waiting", null]
  ] as const)("%s evidence then %s %s becomes %s", (priorConfidence, confidence, state, expected, notification) => {
    const previous = initial({ state: priorConfidence === "inferred" ? "idle" : "waiting", confidence: priorConfidence });
    const result = nextSessionState(previous, following({ state, confidence }));
    expect(result.session.state).toBe(expected);
    expect(result.notification).toBe(notification);
    expect(previous.sequence).toBe(0);
  });
  it("permission waiting beats recency and still consumes sequence and event id", () => {
    const waiting = initial({ state: "waiting" });
    const heuristic = following({ state: "busy", confidence: "inferred", source: "editor_state" });
    const result = nextSessionState(waiting, heuristic);
    expect(result).toMatchObject({ notification: null, reason: "lower_confidence", session: { state: "waiting", confidence: "explicit", sequence: 1 } });
    expect(nextSessionState(result.session, heuristic).reason).toBe("duplicate");
    expect(nextSessionState(result.session, following({ eventId: "new-id" })).reason).toBe("duplicate");
  });
  it("dedupes ids, session sequences and reordered timestamps without notifying twice", () => {
    const before = initial();
    const done = following({ state: "done" });
    const after = nextSessionState(before, done);
    expect(after.notification).toBe("agent_done");
    for (const duplicate of [done, { ...done, sequence: 99 }, { ...done, eventId: "different" }])
      expect(nextSessionState(after.session, duplicate)).toMatchObject({ notification: null, reason: "duplicate" });
    expect(nextSessionState(after.session, event({ eventId: "old" })).reason).toBe("out_of_order");
    expect(nextSessionState(after.session, following({ eventId: "late", sequence: 2, observedAt: "2026-09-28T11:59:59.000Z" })).reason).toBe("out_of_order");
    expect(dedupeActivityEvents([event(), event({ sessionId: "another" }), event({ eventId: "different" }),
      following(), event({ eventId: "unique", sessionId: "another" })])).toHaveLength(3);
  });
  it.each(["process_vanished", "session_ended"] as const)("%s overrides explicit evidence with unknown", (signal) => {
    expect(nextSessionState(initial(), following({ signal, state: "done", confidence: "inferred" })))
      .toMatchObject({ notification: null, session: { state: "unknown", confidence: "inferred", endedAt: at } });
  });
  it("pid reuse becomes unknown and never leaves a targetable reused process", () => {
    const before = initial({ process: { pid: 42, startedAt: "2026-09-28T11:00:00.000Z" } });
    const after = nextSessionState(before, following({ state: "done", process: { pid: 42, startedAt: at } }));
    expect(after.session.state).toBe("unknown");
    expect(after.session.process).toBeUndefined();
    expect(after.notification).toBeNull();
    expect(nextSessionState(before, following({ process: { ppid: 10 } })).session.process)
      .toEqual({ ppid: 10, pid: 42, startedAt: "2026-09-28T11:00:00.000Z" });
  });
  it("child completion cannot complete the parent, including sidechain events using its id", () => {
    const parent = initial();
    expect(nextSessionState(parent, following({ sessionId: "child", parentSessionId: parent.sessionId, state: "done" })))
      .toEqual({ session: parent, notification: null, reason: "other_session" });
    expect(nextSessionState(parent, following({ isSidechain: true, state: "done" })))
      .toMatchObject({ notification: null, reason: "child", session: { state: "busy" } });
    expect(nextSessionState(null, event({ isSidechain: true, state: "done" })).session.state).toBe("unknown");
    expect(nextSessionState(parent, following({ agent: "codex", state: "done" })).reason).toBe("other_session");
  });
  it("N2 retains waiting through Claude Stop after a question until explicit new work", () => {
    const question = nextSessionState(initial(), following({ signal: "user_question", state: "waiting" }));
    expect(question.notification).toBe("agent_waiting");
    const stop = nextSessionState(question.session, event({ eventId: "stop", sequence: 2, signal: "claude_stop", state: "done" }));
    expect(stop.session.state).toBe("waiting");
    expect(stop.notification).toBeNull();
    const busy = nextSessionState(stop.session, event({ eventId: "work", sequence: 3 }));
    expect(busy.session.awaitingInput).toBe(false);
    expect(nextSessionState(busy.session, event({ eventId: "stop-2", sequence: 4, signal: "claude_stop", state: "done" })).notification).toBe("agent_done");
  });
  it.each(["failed", "cancelled"] as const)("%s remains separate from successful completion", (outcome) => {
    const result = nextSessionState(initial(), following({ outcome, state: "idle" }));
    expect(result.notification).toBeNull();
    expect(result.session).toMatchObject({ state: "idle", outcome });
    expect(toDisplayRecord(result.session).outcome).toBe(outcome);
    expect(toUploadRecord(result.session)).not.toHaveProperty("outcome");
    expect(nextSessionState(initial(), following({ outcome, state: "done" })).session.state).toBe("unknown");
  });
  it("retires idle and ended sessions at 24h even with repeated observations", () => {
    for (const state of ["idle", "done"] as const) {
      const before = initial({ state });
      expect(shouldRetireActivitySession(before, now + ACTIVITY_SESSION_RETIREMENT_MS - 1)).toBe(false);
      const after = nextSessionState(before, following({ state, observedAt: new Date(now + 1000).toISOString() })).session;
      expect(shouldRetireActivitySession(after, now + ACTIVITY_SESSION_RETIREMENT_MS)).toBe(true);
    }
    expect(shouldRetireActivitySession(initial(), now + ACTIVITY_SESSION_RETIREMENT_MS)).toBe(false);
    const ended = nextSessionState(initial(), following({ signal: "process_vanished" })).session;
    expect(shouldRetireActivitySession(ended, now + ACTIVITY_SESSION_RETIREMENT_MS)).toBe(true);
    expect(shouldRetireActivitySession(ended, NaN)).toBe(false);
  });
});

describe("F17 projections", () => {
  it("validates public records with closed fields and ordered timestamps", () => {
    const uploaded = toUploadRecord(initial());
    expect(isActivityUploadRecord(uploaded)).toBe(true);
    expect(isActivityDisplayRecord(uploaded)).toBe(true);
    const failed = toDisplayRecord(initial({ state: "idle", outcome: "failed" }));
    expect(isActivityDisplayRecord(failed)).toBe(true);
    expect(isActivityUploadRecord(failed)).toBe(false);
    for (const change of [
      { sessionId: "raw-payload-id" }, { agent: "other" }, { state: "ended" }, { confidence: "maybe" },
      { state: "done", confidence: "inferred" }, { observedAt: "not-a-date" }, { userProjectLabel: "" },
      { stateChangedAt: "2026-09-28T11:59:59.999Z" }, { stateChangedAt: "2026-09-28T12:00:00.001Z" },
      { process: { pid: 1 } }, { accountAlias: "private" }, { prompt: "private" }, { terminalHandle: "private" }
    ]) {
      expect(isActivityUploadRecord({ ...uploaded, ...change })).toBe(false);
      expect(isActivityDisplayRecord({ ...uploaded, ...change })).toBe(false);
    }
    expect(isActivityDisplayRecord({ ...uploaded, state: "done", outcome: "failed" })).toBe(false);
  });
  it("drops markers from every event free text field and injected sensitive fields", () => {
    const marker = "PRIVATE_MARKER_937";
    const poisoned = {
      ...event({ eventId: marker + "event", sessionId: marker + "session", accountAlias: marker + "alias", parentSessionId: marker + "parent" }),
      prompt: marker, transcript: marker, toolArguments: marker, approvalText: marker, path: marker,
      terminalHandle: marker, userProjectLabel: marker, process: { ppid: 42, pid: 43, startedAt: at, terminal: marker }
    };
    expect(isActivityEvent(poisoned, now, "desktop")).toBe(false);
    // Defense in depth against an adapter bypassing the strict boundary.
    const session = nextSessionState(null, poisoned).session;
    for (const record of [toDisplayRecord(session), toUploadRecord(session)]) {
      expect(JSON.stringify(record)).not.toContain(marker);
      expect(record.sessionId).toMatch(/^[a-f0-9]{64}$/u);
      expect(Object.keys(record).sort()).toEqual(["agent", "confidence", "firstObservedAt", "observedAt", "sessionId", "state", "stateChangedAt"].sort());
    }
    for (const field of ["prompt", "transcript", "toolArguments", "approvalText", "path", "terminalHandle", "userProjectLabel"])
      expect(session).not.toHaveProperty(field);
    expect(session.process).not.toHaveProperty("terminal");
  });
  it.each(["short", "🔥".repeat(50), "a".repeat(256)])("produces standard stable SHA256 pseudonyms for %s", (sessionId) => {
    const session = initial({ sessionId });
    const expected = createHash("sha256").update(JSON.stringify(["openlimiter.activity.v1", "claude_code", sessionId])).digest("hex");
    expect(toUploadRecord(session).sessionId).toBe(expected);
    expect(toDisplayRecord(session).sessionId).toBe(expected);
    expect(toUploadRecord({ ...session, agent: "codex" }).sessionId).not.toBe(expected);
  });
  it("only a separate user chosen project label is eligible for projection", () => {
    const session = { ...initial(), userProjectLabel: "My project" };
    expect(toUploadRecord(session).userProjectLabel).toBe("My project");
    expect(toDisplayRecord(session).userProjectLabel).toBe("My project");
    expect(() => toUploadRecord({ ...session, userProjectLabel: "" })).toThrow("project label");
  });
});
