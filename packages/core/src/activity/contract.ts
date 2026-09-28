/** Local activity protocol. No collector, clock, storage or notification delivery. */
export const ACTIVITY_EVENT_VERSION = 1;
export const MAX_ACTIVITY_EVENT_BYTES = 8 * 1024;
export const MAX_ACTIVITY_SPOOL_BYTES = 16 * 1024 * 1024;
export const MAX_ACTIVITY_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
/** Proposed live cap, frozen for consumers of version 1. */
export const MAX_LIVE_ACTIVITY_SESSIONS = 64;
export const ACTIVITY_SESSION_RETIREMENT_MS = 24 * 60 * 60 * 1000;

export const ACTIVITY_AGENTS = [
  "claude_code", "codex", "muse", "gemini_cli", "cursor", "kimi", "grok", "antigravity"
] as const;
export const ACTIVITY_STATES = ["busy", "waiting", "done", "idle", "unknown"] as const;
export const ACTIVITY_SOURCES = ["hook", "registry", "transcript", "rollout", "editor_state"] as const;
export const ACTIVITY_SIGNALS = [
  "observation", "user_question", "claude_stop", "process_vanished", "session_ended"
] as const;
export type ActivityAgent = (typeof ACTIVITY_AGENTS)[number];
export type ActivityState = (typeof ACTIVITY_STATES)[number];
export type ActivityConfidence = "explicit" | "inferred";
export type ActivityOutcome = "cancelled" | "failed";

/** LOCAL ONLY. The hook reports ppid; the desktop resolves pid and startedAt together. */
export interface ActivityProcess {
  ppid?: number;
  pid?: number;
  startedAt?: string;
}

export interface ActivityEvent {
  version: typeof ACTIVITY_EVENT_VERSION;
  eventId: string;
  /** Exact opaque id from the agent payload, never a path or a fabricated parent id. */
  sessionId: string;
  sequence: number;
  agent: ActivityAgent;
  accountAlias?: string;
  observedAt: string;
  state: ActivityState;
  outcome?: ActivityOutcome;
  source: (typeof ACTIVITY_SOURCES)[number];
  confidence: ActivityConfidence;
  process?: ActivityProcess;
  /** Structural metadata only. Adapters must never attach the question itself. */
  signal?: (typeof ACTIVITY_SIGNALS)[number];
  parentSessionId?: string;
  isSidechain?: boolean;
}

export type HookActivityEvent = Omit<ActivityEvent, "source" | "process"> & {
  source: "hook";
  process?: { ppid: number; pid?: never; startedAt?: never };
};

/** Shared boundary primitives, deliberately independent of Node and browser state. */
export function isContractObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isContractInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
export function hasOnlyContractKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value["length"] > 0 && value["length"] <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const member = (values: readonly string[], value: unknown): boolean =>
  typeof value === "string" && values.includes(value);

/** Strict spool boundary. now is epoch milliseconds supplied by the consumer. */
export function isActivityEvent(value: unknown, now: number, origin: "hook" | "desktop" = "hook"): value is ActivityEvent {
  if (!Number.isFinite(now) || !isContractObject(value)) return false;
  if (!hasOnlyContractKeys(value, ["version", "eventId", "sessionId", "sequence", "agent", "accountAlias",
    "observedAt", "state", "outcome", "source", "confidence", "process", "signal", "parentSessionId", "isSidechain"])) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_ACTIVITY_EVENT_BYTES) return false;
  } catch { return false; }
  if (value["version"] !== ACTIVITY_EVENT_VERSION || !identifier(value["eventId"]) || !identifier(value["sessionId"]) ||
    !Number.isSafeInteger(value["sequence"]) || (value["sequence"] as number) < 0 ||
    !member(ACTIVITY_AGENTS, value["agent"]) || !member(ACTIVITY_STATES, value["state"]) ||
    !member(ACTIVITY_SOURCES, value["source"]) || !member(["explicit", "inferred"], value["confidence"]) ||
    !isContractInstant(value["observedAt"])) return false;
  const age = now - Date.parse(value["observedAt"]);
  if (age < 0 || age > MAX_ACTIVITY_EVENT_AGE_MS) return false;
  if (origin === "hook" && value["source"] !== "hook") return false;
  if (value["accountAlias"] !== undefined && !identifier(value["accountAlias"])) return false;
  if (value["parentSessionId"] !== undefined && (!identifier(value["parentSessionId"]) || value["parentSessionId"] === value["sessionId"])) return false;
  if (value["isSidechain"] !== undefined && typeof value["isSidechain"] !== "boolean") return false;
  if (value["signal"] !== undefined && !member(ACTIVITY_SIGNALS, value["signal"])) return false;
  if (value["signal"] === "claude_stop" && value["agent"] !== "claude_code") return false;
  if (value["outcome"] !== undefined && !member(["cancelled", "failed"], value["outcome"])) return false;
  if (value["outcome"] !== undefined && value["state"] === "done") return false;
  if ((value["state"] === "done" || value["signal"] === "user_question" || value["signal"] === "claude_stop") && value["confidence"] !== "explicit") return false;
  if (value["process"] !== undefined) {
    const process = value["process"];
    if (!isContractObject(process) || !hasOnlyContractKeys(process, ["ppid", "pid", "startedAt"])) return false;
    if (process["ppid"] !== undefined && !pid(process["ppid"])) return false;
    if (origin === "hook" && (process["ppid"] === undefined || process["pid"] !== undefined || process["startedAt"] !== undefined)) return false;
    if ((process["pid"] === undefined) !== (process["startedAt"] === undefined)) return false;
    if (process["pid"] !== undefined && (!pid(process["pid"]) || !isContractInstant(process["startedAt"]))) return false;
    if (isContractInstant(process["startedAt"]) && process["startedAt"] > value["observedAt"]) return false;
  }
  return true;
}

/** Validate original byte size before parsing; reserialization alone misses whitespace padding. */
export function readActivityEvent(serialized: string, now: number, origin: "hook" | "desktop" = "hook"): ActivityEvent {
  if (new TextEncoder().encode(serialized).byteLength > MAX_ACTIVITY_EVENT_BYTES) throw new TypeError("activity: event too large");
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new TypeError("activity: invalid JSON"); }
  if (!isActivityEvent(value, now, origin)) throw new TypeError("activity: invalid event");
  return value;
}

export interface ActivitySession {
  sessionId: string;
  agent: ActivityAgent;
  accountAlias?: string;
  state: ActivityState;
  confidence: ActivityConfidence;
  outcome?: ActivityOutcome;
  firstObservedAt: string;
  observedAt: string;
  stateChangedAt: string;
  endedAt?: string;
  sequence: number;
  seenEventIds: readonly string[];
  process?: ActivityProcess;
  awaitingInput: boolean;
  /** Set only by a separate user preference, never copied from events. */
  userProjectLabel?: string;
}
export interface ActivityTransition {
  session: ActivitySession;
  notification: "agent_waiting" | "agent_done" | null;
  reason: "baseline" | "applied" | "duplicate" | "out_of_order" | "other_session" | "child" | "lower_confidence";
}

/** Batch dedupe across sessions before applying per session sequence precedence. */
export function dedupeActivityEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  const ids = new Set<string>();
  const sequences = new Set<string>();
  return events.filter((event) => {
    const key = JSON.stringify([event.sessionId, event.sequence]);
    if (ids.has(event.eventId) || sequences.has(key)) return false;
    ids.add(event.eventId);
    sequences.add(key);
    return true;
  });
}

/**
 * Call only with validated events. Sequence is monotonic for a session across sources.
 * Suppressed observations still advance dedupe, but never weaken the winning evidence.
 */
export function nextSessionState(previous: ActivitySession | null, event: ActivityEvent): ActivityTransition {
  if (previous !== null) {
    if (previous.sessionId !== event.sessionId || previous.agent !== event.agent)
      return { session: previous, notification: null, reason: "other_session" };
    if (previous.seenEventIds.includes(event.eventId) || previous.sequence === event.sequence)
      return { session: previous, notification: null, reason: "duplicate" };
    if (event.sequence < previous.sequence || event.observedAt < previous.observedAt)
      return { session: previous, notification: null, reason: "out_of_order" };
  }
  const base: ActivitySession = previous ?? {
    sessionId: event.sessionId, agent: event.agent, state: "unknown", confidence: "inferred",
    firstObservedAt: event.observedAt, observedAt: event.observedAt, stateChangedAt: event.observedAt,
    sequence: event.sequence, seenEventIds: [], awaitingInput: false,
    ...(event.accountAlias === undefined ? {} : { accountAlias: event.accountAlias })
  };
  const session: ActivitySession = {
    ...base, sequence: event.sequence, seenEventIds: [...base.seenEventIds, event.eventId], observedAt: event.observedAt
  };
  // A sidechain observation attributed to a parent cannot change that parent's state.
  if (event.isSidechain) return { session, notification: null, reason: previous === null ? "baseline" : "child" };
  const identityChanged = base.process?.pid !== undefined && event.process?.pid !== undefined &&
    (base.process["pid"] !== event.process["pid"] || base.process["startedAt"] !== event.process["startedAt"]);
  const vanished = event.signal === "process_vanished" || event.signal === "session_ended" || identityChanged;
  if (!vanished && previous !== null && base.confidence === "explicit" && event.confidence === "inferred")
    return { session, notification: null, reason: "lower_confidence" };

  let state = event.state;
  let awaitingInput = base.awaitingInput;
  if (event.signal === "user_question") { state = "waiting"; awaitingInput = true; }
  if (event.signal === "claude_stop" && awaitingInput) state = "waiting";
  if (state === "busy" && event.confidence === "explicit") awaitingInput = false;
  if (vanished) { state = "unknown"; awaitingInput = false; }
  // A failure or cancellation is never a success, including defensive typed calls.
  if (event.outcome !== undefined && state === "done") state = "unknown";
  if (state === "done" && event.confidence !== "explicit") state = "unknown";
  if (state !== "waiting") awaitingInput = false;
  session.state = state;
  session.confidence = vanished ? "inferred" : event.confidence;
  session.awaitingInput = awaitingInput;
  if (state !== base.state) session.stateChangedAt = event.observedAt;
  delete session.outcome;
  if (event.outcome !== undefined) session.outcome = event.outcome;
  delete session.endedAt;
  if (vanished || state === "done" || event.outcome !== undefined)
    session.endedAt = base.state === state && base.outcome === event.outcome ? base.endedAt ?? event.observedAt : event.observedAt;
  if (event.process !== undefined && !identityChanged) session.process = {
    ...(base.process?.pid === undefined ? {} : { pid: base.process.pid, startedAt: base.process.startedAt! }),
    ...(event.process["ppid"] === undefined ? {} : { ppid: event.process["ppid"] }),
    ...(event.process["pid"] === undefined ? {} : { pid: event.process["pid"], startedAt: event.process["startedAt"]! })
  };
  if (identityChanged) delete session.process;
  const notification = previous !== null && base.state !== state && event.outcome === undefined &&
    session.confidence === "explicit" ? state === "waiting" ? "agent_waiting" : state === "done" ? "agent_done" : null : null;
  return { session, notification, reason: previous === null ? "baseline" : "applied" };
}

/** Retirement uses the state/ending time, so repeated idle polls cannot keep it alive. */
export function shouldRetireActivitySession(session: ActivitySession, now: number): boolean {
  const since = session.endedAt ?? (session.state === "idle" ? session.stateChangedAt : undefined);
  return since !== undefined && Number.isFinite(now) && now - Date.parse(since) >= ACTIVITY_SESSION_RETIREMENT_MS;
}

// SHA-256 over a domain separated, length delimited identity. Pure and usable in every lane.
// This is a stable pseudonym, not a secret or an authorization token.
function opaqueSessionId(agent: ActivityAgent, sessionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(["openlimiter.activity.v1", agent, sessionId]));
  const words = new Uint32Array(Math.ceil((bytes.length + 9) / 64) * 16);
  bytes.forEach((byte, index) => { words[index >>> 2] = words[index >>> 2]! | byte << (24 - (index % 4) * 8); });
  words[bytes.length >>> 2] = words[bytes.length >>> 2]! | 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 1] = bytes.length * 8;
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (n: number, shift: number): number => n >>> shift | n << (32 - shift);
  for (let offset = 0; offset < words.length; offset += 16) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      const x = w[i - 15] ?? 0, y = w[i - 2] ?? 0;
      w[i] = i < 16 ? words[offset + i]! : w[i - 16]! + (rotate(x,7) ^ rotate(x,18) ^ x >>> 3) + w[i - 7]! + (rotate(y,17) ^ rotate(y,19) ^ y >>> 10);
    }
    let [a,b,c,d,e,f,g,j] = h as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) | 0;
      const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      j=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    [a,b,c,d,e,f,g,j].forEach((value, i) => { h[i] = (h[i]! + value) >>> 0; });
  }
  return h.map((value) => value["toString"](16).padStart(8, "0")).join("");
}

export interface ActivityUploadRecord {
  sessionId: string;
  agent: ActivityAgent;
  state: ActivityState;
  confidence: ActivityConfidence;
  firstObservedAt: string;
  observedAt: string;
  stateChangedAt: string;
  userProjectLabel?: string;
}
export interface ActivityDisplayRecord extends ActivityUploadRecord { outcome?: ActivityOutcome }

function isProjectedActivityRecord(value: unknown, display: boolean): boolean {
  if (!isContractObject(value) || !hasOnlyContractKeys(value, ["sessionId", "agent", "state", "confidence", "firstObservedAt",
    "observedAt", "stateChangedAt", "userProjectLabel", ...(display ? ["outcome"] : [])])) return false;
  if (typeof value["sessionId"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["sessionId"]) ||
    !member(ACTIVITY_AGENTS, value["agent"]) || !member(ACTIVITY_STATES, value["state"]) ||
    !member(["explicit", "inferred"], value["confidence"]) || !isContractInstant(value["firstObservedAt"]) ||
    !isContractInstant(value["observedAt"]) || !isContractInstant(value["stateChangedAt"])) return false;
  if (value["firstObservedAt"] > value["stateChangedAt"] || value["stateChangedAt"] > value["observedAt"]) return false;
  if (value["state"] === "done" && value["confidence"] !== "explicit") return false;
  if (value["userProjectLabel"] !== undefined && !identifier(value["userProjectLabel"])) return false;
  return value["outcome"] === undefined || (display && member(["cancelled", "failed"], value["outcome"]) && value["state"] !== "done");
}
export function isActivityUploadRecord(value: unknown): value is ActivityUploadRecord {
  return isProjectedActivityRecord(value, false);
}
export function isActivityDisplayRecord(value: unknown): value is ActivityDisplayRecord {
  return isProjectedActivityRecord(value, true);
}

/** An explicit allowlist. Never spread a session, event, alias or process into either record. */
export function toUploadRecord(session: ActivitySession): ActivityUploadRecord {
  const record: ActivityUploadRecord = {
    sessionId: opaqueSessionId(session.agent, session.sessionId), agent: session.agent,
    state: session.state, confidence: session.confidence, firstObservedAt: session.firstObservedAt,
    observedAt: session.observedAt, stateChangedAt: session.stateChangedAt
  };
  if (session.userProjectLabel !== undefined) {
    if (!identifier(session.userProjectLabel)) throw new TypeError("activity: invalid user project label");
    record.userProjectLabel = session.userProjectLabel;
  }
  return record;
}
export function toDisplayRecord(session: ActivitySession): ActivityDisplayRecord {
  return { ...toUploadRecord(session), ...(session.outcome === undefined ? {} : { outcome: session.outcome }) };
}
