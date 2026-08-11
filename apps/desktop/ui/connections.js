/**
 * The Connections tab.
 *
 * Everything on it is a claim about this exact build, verified through the
 * backend adapter before it is drawn. A connection card exists only because
 * list_connections returned that record. The Claude card's state comes from
 * detect_local_tools. The OpenRouter form stores a key only through
 * connect_provider. When the backend does not carry those commands, because
 * this build predates them or the window is being served outside the shell,
 * the tab says so in one honest block and draws nothing in their place.
 *
 * What this file decides is layout and wording glue. What it never decides is
 * vocabulary or policy:
 *
 *   the sentence and the next action for every connection state come from
 *   packages/core/src/connection-state.ts, mirrored into this bundle, so a
 *   card here and a block on the web dashboard describe one state with one
 *   sentence;
 *
 *   when a connection is due for a refresh comes from
 *   packages/core/src/schedule.ts, the same arithmetic on every surface:
 *   doubling per consecutive failure capped at an hour, jitter on our own
 *   backoff only, and a provider's Retry-After respected as a floor.
 *
 * The clock belongs to Rust. Hidden webviews get their timers throttled by
 * the operating system, so the backend runs the metronome and emits a
 * collector-tick event about once a minute. This module wakes on the tick,
 * asks the schedule which connections are due, refreshes exactly those, and
 * writes a heartbeat stamp so a webview that has died is observable: the
 * stamp stops advancing while the process clock does not.
 *
 * A refresh is a pipeline, and every stage of it is the one implementation
 * the rest of the product runs. The backend chooses the address, performs the
 * read, and hands back a ProbeOutcome carrying the reader that was used and
 * the generation of that attempt. The body is parsed by the connector that
 * reader names, and by no other: this module never picks a parser by provider
 * name, by guessing, or by trying several. The rows are validated by the
 * mirrored normalizer, stamped remote_api, and folded into the snapshot cache
 * through the Rust lock handshake with the mirrored merge: cache_begin_write
 * hands over the current text and a generation stamp, this module merges,
 * cache_commit_write presents the stamp back, and a stale_generation or busy
 * refusal is retried exactly once from a fresh begin.
 *
 * Then, and only then, the attempt is CLOSED with what actually happened:
 * complete_attempt with parsed_test, cache_committed, drift or cache_failure.
 * That call is the only thing that can move a connection to CONNECTED, and it
 * is refused if the generation has moved on. This window writes no connection
 * state of its own: a status field no longer exists on the wire, because a
 * surface that can declare itself connected will eventually do so while
 * nothing has been read.
 */
import {
  CACHE_DOCUMENT_VERSION,
  CONNECTION_STATES,
  MAX_CACHE_ENTRIES,
  applyCollectionReport,
  canonicalJson,
  connectionNextAction,
  connectionSentence,
  isDue,
  mergeSnapshots,
  nextRefreshAt,
  normalizeMetersReport,
  readSuppressions,
} from "./engine/core/index.js";
import { parseAntigravityPayload } from "./engine/connectors/antigravity.js";
import { parseCodexPayload } from "./engine/connectors/codex.js";
import { parseOpencodePayload } from "./engine/connectors/opencode.js";
import { parseOpenrouterPayload } from "./engine/connectors/openrouter.js";
import * as backend from "./backend.js";

/** The event the Rust metronome emits, about once a minute. */
const TICK_EVENT = "collector-tick";

/** Where the heartbeat stamp lives, so a dead webview is observable. */
const HEARTBEAT_KEY = "openlimiter-collector-heartbeat";

/** Where the per connection schedule survives a window restart. */
const SCHEDULE_KEY = "openlimiter-schedule";

/**
 * The states the scheduler refreshes on its own.
 *
 * These are the three states the core's own next actions describe as being in
 * rotation: CONNECTED refreshes on its interval, DEGRADED waits out its
 * backoff and retries, STALE is overdue and refreshes at the next chance. A
 * connection waiting on a credential, or one that failed hard enough to need
 * a person, is never retried behind that person's back.
 */
const SCHEDULED_STATES = new Set(["CONNECTED", "DEGRADED", "STALE"]);

/** The 13 states as a set, to check a record's claim before believing it. */
const KNOWN_STATES = new Set(CONNECTION_STATES);

/**
 * The exact statusline wiring, byte for byte the block the documentation
 * publishes. Copy plus verify is the whole flow: this window never edits
 * anybody's settings file.
 */
const CLAUDE_SETUP_SNIPPET = `{
  "statusLine": {
    "type": "command",
    "command": "openlimiter statusline"
  }
}`;

/**
 * Everything this module knows about the world, in one place.
 *
 * `backendPresent` is three valued: null before the first probe answers, then
 * true or false. The render function treats null as "say nothing yet" so the
 * absent block never flashes on a build that does have the backend.
 */
const session = {
  ready: false,
  backendPresent: null,
  listError: null,
  connections: [],
  /** Providers whose refresh_provider came back CONNECTED in this run. */
  liveRefreshOk: new Set(),
  /** Per connection id: { attempt, nextAt }, the core schedule's inputs. */
  schedule: {},
  /**
   * Per connection id: the last action's feedback line, { text, tone }.
   * Kept here rather than only in the DOM because every render rebuilds the
   * cards, and a sentence that vanishes the instant the state redraws was
   * never read by anyone.
   */
  cardNotes: {},
  ticksThisRun: 0,
  lastTickAt: null,
  /** The last detect_local_tools answer for Claude Code, normalized. */
  claude: null,
  claudeProbed: false,
};

/** Wired by initConnections. Nothing here runs before that. */
let options = null;

let el = null;

function grabElements() {
  el = {
    panel: document.getElementById("panel-connections"),
    schedulerLine: document.getElementById("scheduler-line"),
    absent: document.getElementById("connections-absent"),
    reprobe: document.getElementById("connections-reprobe"),
    empty: document.getElementById("connections-empty"),
    cards: document.getElementById("connections-cards"),
    openrouterAdd: document.getElementById("openrouter-add"),
    openrouterKind: () =>
      document.querySelector('input[name="openrouter-kind"]:checked'),
    openrouterKey: document.getElementById("openrouter-key"),
    openrouterAlias: document.getElementById("openrouter-alias"),
    openrouterSubmit: document.getElementById("openrouter-submit"),
    openrouterNote: document.getElementById("openrouter-note"),
    claudeCard: document.getElementById("claude-card"),
    claudeState: document.getElementById("claude-state"),
    claudeStateCode: document.getElementById("claude-state-code"),
    claudeSentence: document.getElementById("claude-sentence"),
    claudeDetail: document.getElementById("claude-detail"),
    claudeSnippet: document.getElementById("claude-snippet"),
    claudeCopy: document.getElementById("claude-copy"),
    claudeVerify: document.getElementById("claude-verify"),
    claudeNote: document.getElementById("claude-note"),
  };
}

/* ------------------------------------------------------------------ storage */

function loadSchedule() {
  try {
    const raw = window.localStorage.getItem(SCHEDULE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSchedule() {
  try {
    window.localStorage.setItem(SCHEDULE_KEY, JSON.stringify(session.schedule));
  } catch {
    /* Storage refused. The schedule still applies to this window. */
  }
}

function storedHeartbeat() {
  try {
    return window.localStorage.getItem(HEARTBEAT_KEY);
  } catch {
    return null;
  }
}

function writeHeartbeat(now) {
  session.lastTickAt = now;
  try {
    window.localStorage.setItem(HEARTBEAT_KEY, now);
  } catch {
    /* Storage refused. The in memory stamp still renders. */
  }
}

/* ----------------------------------------------------------------- language */

/**
 * A state code as the short word a chip can hold.
 *
 * The code itself, in sentence case: STALE is "Stale", AUTH_EXPIRED is "Auth
 * expired". The full sentence from the core rides in the title. Nothing is
 * reworded, because the vocabulary is the core's and this file only changes
 * its case.
 */
export function stateWord(code) {
  const text = String(code).toLowerCase().replace(/_/gu, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The core sentence for a state, or an honest refusal for a code outside it. */
function sentenceFor(state) {
  return KNOWN_STATES.has(state)
    ? connectionSentence[state]
    : "This build does not know this state code, so it claims nothing about it.";
}

function timeWord(iso) {
  if (iso === null || iso === undefined) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleString();
}

/* ---------------------------------------------------------------- schedule */

/**
 * When this connection may next be asked, from the webview's own schedule
 * first and the record's stamp second. Null means the core calls it due.
 */
function nextAtOf(record) {
  const local = session.schedule[record.id];
  return local?.nextAt ?? record.nextRefreshAt ?? null;
}

/**
 * The base interval handed to the core.
 *
 * When the record carries none this passes the absence straight through, and
 * the core's own clamp answers: usableBase treats an unusable base as one
 * second, which in practice means "due at every tick", with the tick cadence
 * owned by the Rust metronome. That is the core's decision, deliberately not
 * repeated or replaced here.
 */
function baseOf(record) {
  return record.baseSeconds ?? Number.NaN;
}

/* ----------------------------------------------------------------- backend */

async function syncConnections() {
  const result = await backend.listConnections();
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) {
      session.backendPresent = false;
      session.connections = [];
    } else {
      session.backendPresent = true;
      session.listError = result.message;
    }
    return;
  }
  session.backendPresent = true;
  session.listError = null;
  session.connections = backend.normalizeConnectionList(result.value);
}

/**
 * Which parser may read a body, keyed by the reader that fetched it.
 *
 * The backend states the reader on every outcome, and this table is the only
 * way a body ever reaches a parser. There is no fallback entry and no default:
 * a reader this build does not know produces no parse at all, which is honest
 * unknown rather than a body handed to whichever parser happened to be nearby.
 */
const PARSER_BY_READER = {
  openrouter_key: parseOpenrouterPayload,
  openrouter_credits: parseOpenrouterPayload,
  codex_usage: parseCodexPayload,
  antigravity_quota: parseAntigravityPayload,
  opencode_usage: parseOpencodePayload,
};

/**
 * What each reader's body IS, before a parser sees it.
 *
 * Four of the five answer JSON. OpenCode answers a logged in HTML page, because
 * it publishes no usage interface at all, so its body is handed over as the raw
 * text it arrived as. Running that through a JSON parser first would turn every
 * real OpenCode response into a parse failure, and a parse failure is drift:
 * the provider would go permanently unknown for a reason that was entirely
 * ours. A reader missing from this table is not defaulted to JSON, it is
 * refused, for the same reason the parser table has no fallback entry.
 */
const ENCODING_BY_READER = {
  openrouter_key: "json",
  openrouter_credits: "json",
  codex_usage: "json",
  antigravity_quota: "json",
  opencode_usage: "text",
};

function parseJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A 2xx body as validated snapshots, stamped with how they arrived, or null.
 *
 * The parser is the mirrored connector the READER names and the validator is
 * the mirrored normalizer: nothing about the shape of a reading is decided
 * here, and nothing here chooses which parser runs.
 *
 * Exported because it is the ONLY place in this window that turns a body into
 * rows. app.js used to carry a second copy, and the copy did what a second copy
 * always does: it drifted. It kept an unconditional JSON.parse after the shared
 * one had learned about text, so every real OpenCode page became drift on the
 * connect form while parsing correctly everywhere else.
 * The one thing this function adds is provenance, remote_api over
 * remote_http, because provenance is written by whatever performed the read
 * and this pipeline is the reader. A body the parser refuses produces null,
 * and null writes nothing anywhere.
 */
export function snapshotsFromBody(readerId, body, now) {
  const parse = Object.prototype.hasOwnProperty.call(PARSER_BY_READER, readerId)
    ? PARSER_BY_READER[readerId]
    : null;
  const encoding = Object.prototype.hasOwnProperty.call(ENCODING_BY_READER, readerId)
    ? ENCODING_BY_READER[readerId]
    : null;
  if (parse === null || encoding === null) return null;
  const document = encoding === "text" ? body : parseJson(body);
  if (document === null) return null;
  const meters = parse(document, now);
  if (meters === null || meters.length === 0) return null;
  const stamped = meters.map((meter) => ({
    ...meter,
    provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
  }));
  const report = normalizeMetersReport(stamped);
  return report.snapshots.length === 0 ? null : report.snapshots;
}

/**
 * Fold one collection report into the snapshot cache, through the Rust lock
 * handshake, with the same pure fold every other writer uses.
 *
 * A report rather than a list of rows, because only a report can say that a
 * provider DRIFTED. Drift removes that identity's rows and leaves a standing
 * suppression in the document, which is what makes the provider read unknown
 * on the statusline, in the agent context and on the dashboard in the same
 * instant, rather than only on the card the person happens to be looking at.
 *
 * begin hands over the cache text and a generation stamp; commit presents
 * the stamp back and is refused with stale_generation when the cache moved
 * in between, or busy when another writer holds it. Either refusal is
 * retried exactly once from a fresh begin, because the second attempt merges
 * against the newer text and so loses nothing. A second refusal is reported,
 * not retried again: the tick cadence retries soon enough, and a loop here
 * would fight the CLI for the lock.
 */
async function applyReportToCache(report) {
  for (let round = 0; round < 2; round += 1) {
    const begun = await backend.cacheBeginWrite();
    if (!begun.ok) {
      return {
        ok: false,
        message: begun.reason === backend.BACKEND_ABSENT
          ? "This build has no connection backend yet."
          : begun.message,
      };
    }
    const handshake = backend.normalizeBeginWrite(begun.value);
    if (handshake.generation === null) {
      return {
        ok: false,
        message:
          "The cache handshake carried no generation stamp, so nothing was written.",
      };
    }
    const document = parseJson(handshake.text ?? "");
    const existingRows =
      document !== null && Array.isArray(document.snapshots)
        ? normalizeMetersReport(document.snapshots).snapshots
        : [];
    /* A suppression list this build cannot read is not treated as an empty
       one. Writing over it would quietly un suppress every identity it was
       protecting, so the write is refused and the reader keeps showing
       unknown until a person looks at the file. */
    const read = readSuppressions(document?.suppressions);
    if (!read.ok) {
      return {
        ok: false,
        message:
          "The cache carries drift suppressions this build cannot read, so " +
          "nothing was written and every affected provider stays unknown.",
      };
    }
    const after = applyCollectionReport(
      { snapshots: existingRows, suppressions: read.suppressions },
      report,
    );
    if (after.snapshots.length > MAX_CACHE_ENTRIES) {
      return {
        ok: false,
        message: "The merged cache would exceed its bounds, so nothing was written.",
      };
    }
    const text = canonicalJson(
      after.suppressions.length === 0
        ? { snapshots: after.snapshots, version: CACHE_DOCUMENT_VERSION }
        : {
            snapshots: after.snapshots,
            suppressions: after.suppressions,
            version: CACHE_DOCUMENT_VERSION,
          },
    );
    const commit = await backend.cacheCommitWrite({
      text,
      generation: handshake.generation,
    });
    if (commit.ok) return { ok: true };
    if (
      round === 0 &&
      (commit.kind === "stale_generation" || commit.kind === "busy")
    ) {
      continue;
    }
    return {
      ok: false,
      message: commit.reason === backend.BACKEND_ABSENT
        ? "This build has no connection backend yet."
        : commit.message,
    };
  }
  /* Unreachable: both rounds return. Stated for the reader. */
  return { ok: false, message: "The cache write did not complete." };
}

/**
 * One probe of one connection: the read, and the parse of whatever came back.
 *
 * Shared by Test Connection and by the refresh pipeline; only the latter goes
 * on to touch the cache. Nothing here writes a connection state: the backend
 * has already settled the record by the time this returns, and the attempt is
 * closed separately once the outcome downstream is known.
 *
 * The shape returned is deliberately small:
 *
 *   absent      the backend does not carry this command at all
 *   generation  the attempt this probe opened, or null when there is none
 *   snapshots   validated rows, or null when nothing could be believed
 *   drifted     the provider answered 2xx and the parser refused the body,
 *               which is the one signal that means the interface changed
 *   note        a sentence for the card, or null
 */
async function probe(record, refresh) {
  const command = refresh ? backend.refreshProvider : backend.testProvider;
  const result = await command({ connectionId: record.id });
  const now = new Date().toISOString();
  const empty = {
    absent: false,
    generation: null,
    snapshots: null,
    drifted: false,
    retryAfterSeconds: null,
    note: null,
  };
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) {
      session.backendPresent = false;
      return { ...empty, absent: true };
    }
    return { ...empty, note: result.message };
  }
  const outcome = backend.normalizeProbeOutcome(result.value);
  if (outcome.kind === "unreadable") {
    return {
      ...empty,
      note: "The backend's answer could not be read, so nothing is claimed from it.",
    };
  }
  if (outcome.kind === "transport_failure") {
    return {
      ...empty,
      generation: outcome.attemptGeneration,
      note: "The read did not reach the provider (" + outcome.failure + ").",
    };
  }
  const inTwoHundreds = outcome.status >= 200 && outcome.status <= 299;
  /* An empty body is not an answer. No parser here can read a meter out of zero
     bytes, and the backend refuses to complete an attempt that delivered one, so
     calling it drift would report a provider interface change that did not
     happen. It is a read that produced nothing, which is what it says. */
  if (!inTwoHundreds || outcome.body === null || outcome.body === "") {
    return {
      ...empty,
      generation: outcome.attemptGeneration,
      retryAfterSeconds: outcome.retryAfterSeconds,
      note: "The provider answered " + String(outcome.status) + ".",
    };
  }
  const snapshots = snapshotsFromBody(outcome.readerId, outcome.body, now);
  return {
    absent: false,
    generation: outcome.attemptGeneration,
    snapshots,
    /* A well formed answer the parser could not read is the definition of
       drift: the credential is fine and the interface is not. */
    drifted: snapshots === null,
    retryAfterSeconds: outcome.retryAfterSeconds,
    note:
      snapshots === null
        ? "The provider answered, and this build could not read the answer. " +
          "The reading is unknown rather than guessed."
        : null,
  };
}

/**
 * Close the attempt with what actually happened, and let Rust settle the state.
 *
 * A completion is refused when the generation has moved, which is the point:
 * a slow parse belonging to a superseded request must not stamp a success onto
 * the request that replaced it.
 */
async function closeAttempt(record, generation, disposition) {
  if (generation === null) return { ok: false, stale: false };
  const result = await backend.completeAttempt({
    connectionId: record.id,
    attemptGeneration: generation,
    disposition,
  });
  return { ok: result.ok, stale: result.kind === "stale_generation" };
}

/**
 * One refresh for one connection: probe, parse, commit to the cache through
 * the handshake, and close the attempt. Success means validated snapshots
 * reached the cache in this run, which is the one fact that lets a meters row
 * say Connected.
 */
async function runRefresh(record) {
  const attempt = await probe(record, true);
  if (attempt.absent) return { succeeded: false, note: null };

  const observedAt = new Date().toISOString();
  let note = attempt.note;
  let committed = false;
  if (attempt.snapshots !== null && record.provider !== null) {
    const commit = await applyReportToCache({
      ok: true,
      provider: record.provider,
      observedAt,
      snapshots: attempt.snapshots,
    });
    committed = commit.ok;
    if (!commit.ok) note = commit.message;
  } else if (attempt.drifted && record.provider !== null) {
    /* The provider answered well and this build could not read the answer.
       The rows go, the suppression stays, and nothing downstream may show a
       number for this provider until a later run parses again. */
    const suppressed = await applyReportToCache({
      ok: false,
      provider: record.provider,
      observedAt,
      reason: "drift",
    });
    if (!suppressed.ok) note = suppressed.message;
  }
  /* The disposition is the honest description of what this run achieved, and
     nothing else may be sent: a 2xx that drifted is drift, and a parse that
     could not be written is a cache failure, never a quiet success. */
  if (attempt.generation !== null) {
    const disposition = committed
      ? "cache_committed"
      : attempt.drifted
        ? "drift"
        : attempt.snapshots !== null
          ? "cache_failure"
          : null;
    if (disposition !== null) {
      await closeAttempt(record, attempt.generation, disposition);
    }
  }

  const after = new Date().toISOString();
  const previous = session.schedule[record.id];
  const attemptCount = committed ? 0 : (previous?.attempt ?? 0) + 1;
  session.schedule[record.id] = {
    attempt: attemptCount,
    nextAt: nextRefreshAt(after, {
      attempt: attemptCount,
      baseSeconds: baseOf(record),
      retryAfterSeconds: attempt.retryAfterSeconds,
      random: Math.random,
    }),
  };
  saveSchedule();
  await syncConnections();
  if (committed && record.provider !== null) {
    session.liveRefreshOk.add(record.provider);
  }
  return { succeeded: committed, note };
}

/**
 * One tick from the Rust metronome.
 *
 * Heartbeat first, unconditionally, because the stamp's whole job is to
 * advance whenever this webview is alive to receive a tick. Then the due
 * connections, one at a time rather than in a burst, so a machine with five
 * connections does not open five requests in one instant.
 */
async function onTick() {
  const now = new Date().toISOString();
  session.ticksThisRun += 1;
  writeHeartbeat(now);
  await syncConnections();
  if (session.backendPresent === true) {
    const due = session.connections.filter(
      (record) =>
        KNOWN_STATES.has(record.state) &&
        SCHEDULED_STATES.has(record.state) &&
        isDue(nextAtOf(record), now),
    );
    let changed = false;
    for (const record of due) {
      const outcome = await runRefresh(record);
      changed = changed || outcome.succeeded;
    }
    if (changed) options.onMetersChanged();
  }
  render();
}

/* ---------------------------------------------------------- claude detection */

/** The first defined value under any of several key spellings. */
function pick(record, names) {
  for (const name of names) {
    const value = record?.[name];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/**
 * The detect_local_tools answer, reduced to the three facts the card needs:
 * was Claude Code found, is the statusline pointed at OpenLimiter, and did
 * the backend hand over a state of its own. Every spelling a serializer
 * plausibly produces is accepted; anything unreadable is null, and null is
 * rendered as not knowing rather than as either answer.
 */
function normalizeDetection(value) {
  let entry = null;
  if (Array.isArray(value)) {
    entry = value.find((item) => {
      const name = pick(item, ["id", "tool", "name", "toolId", "tool_id"]);
      return typeof name === "string" && /claude/iu.test(name);
    }) ?? null;
  } else if (value !== null && typeof value === "object") {
    entry = pick(value, ["claudeCode", "claude_code", "claude", "CLAUDE"]) ?? value;
  }
  if (entry === null || typeof entry !== "object") return null;
  const found = pick(entry, ["installed", "present", "found", "detected"]);
  const wired = pick(entry, [
    "statuslineWired",
    "statusline_wired",
    "statuslineConfigured",
    "statusline_configured",
    "wired",
    "configured",
  ]);
  const state = pick(entry, ["state", "status"]);
  return {
    found: typeof found === "boolean" ? found : null,
    wired: typeof wired === "boolean" ? wired : null,
    state: typeof state === "string" && KNOWN_STATES.has(state) ? state : null,
  };
}

async function detectClaude() {
  const result = await backend.detectLocalTools();
  session.claudeProbed = true;
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) session.backendPresent = false;
    session.claude = null;
    return;
  }
  session.backendPresent = true;
  session.claude = normalizeDetection(result.value);
}

/**
 * The Claude card's state, in the core's own vocabulary.
 *
 * The backend's own state wins when it sent one. Otherwise: not found is
 * NOT_CONFIGURED, found but not wired is DETECTED, and wired splits on
 * whether a fresh statusline reading is actually in the cache right now,
 * which is the difference between ready to collect and collecting. Null
 * means detection itself was impossible, and the card says that instead.
 */
function claudeStateOf() {
  const detection = session.claude;
  if (detection === null) return null;
  if (detection.state !== null) return detection.state;
  if (detection.found === null) return null;
  if (detection.found === false) return "NOT_CONFIGURED";
  if (detection.wired !== true) return "DETECTED";
  return options.hasFreshLocalClaude() ? "CONNECTED" : "READY_TO_ENABLE";
}

/* ---------------------------------------------------------------- dom kit */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setNote(node, text, tone) {
  node.textContent = text;
  node.dataset.tone = tone ?? "plain";
}

/** A card's feedback line: shown now, and kept across the next renders. */
function keepCardNote(id, node, text, tone) {
  session.cardNotes[id] = { text, tone: tone ?? "plain" };
  setNote(node, text, tone);
}

/** The state chip a card leads with: a dot, then the code, in mono. */
function stateChip(state) {
  const known = KNOWN_STATES.has(state);
  const chip = element("span", "chip muted conn-state");
  chip.dataset.connectionState = known ? state : "UNRECOGNISED";
  chip.title = sentenceFor(state);
  const dot = element("span", "state-dot");
  dot.setAttribute("aria-hidden", "true");
  chip.append(dot);
  chip.append(element("span", "mono tracked", String(state)));
  return chip;
}

function fact(label, value) {
  const wrap = element("div", "conn-fact");
  wrap.append(element("dt", "fact-label", label));
  wrap.append(element("dd", "fact-value", value));
  return wrap;
}

/* ------------------------------------------------------------------ cards */

/**
 * One connection record as one card: every field the connection architecture
 * names, each rendered from the record or rendered as an honest absence.
 * Nothing on the card is a default pretending to be data.
 */
function connectionCard(record, now) {
  const node = element("div", "surface conn-card");

  const head = element("div", "conn-head");
  const identity = element("div", "card-id");
  const mark = element("span", "card-mark");
  mark.innerHTML = record.provider === null ? "" : options.markFor(record.provider);
  identity.append(mark);
  const names = element("div");
  names.append(
    element(
      "div",
      "name",
      record.provider === null ? "Unknown provider" : options.providerName(record.provider),
    ),
  );
  if (record.product !== null) {
    names.append(element("div", "code", String(record.product)));
  }
  identity.append(names);
  head.append(identity);
  /* A record that carries no state gets a placeholder code, not a claim:
     NOT_CONFIGURED is a real state with a real sentence, and this is not it. */
  head.append(stateChip(record.state ?? "UNSTATED"));
  node.append(head);

  node.append(element("p", "conn-sentence", sentenceFor(record.state)));

  const facts = element("dl", "conn-facts");
  facts.append(
    fact("Account", record.accountAlias === null ? "No alias set" : String(record.accountAlias)),
  );
  facts.append(
    fact("Source", record.sourceType === null ? "Not stated" : String(record.sourceType)),
  );
  facts.append(
    fact(
      "Credential",
      record.credentialKind === null && record.maskedLabel === null
        ? "None stored"
        : [record.credentialKind, record.maskedLabel]
            .filter((part) => part !== null)
            .map((part) => String(part))
            .join(" · "),
    ),
  );
  facts.append(
    fact(
      "Last successful refresh",
      timeWord(record.lastSuccessAt) ?? "None recorded",
    ),
  );
  const next = nextAtOf(record);
  facts.append(
    fact(
      "Next refresh",
      !KNOWN_STATES.has(record.state) || !SCHEDULED_STATES.has(record.state)
        ? "Not scheduled"
        : next === null || isDue(next, now)
          ? "At the next collector tick"
          : (timeWord(next) ?? "At the next collector tick"),
    ),
  );
  node.append(facts);

  const note = element("p", "conn-note");
  note.setAttribute("role", "status");
  /* The last action's sentence survives the redraw that action caused. */
  const kept = session.cardNotes[record.id];
  if (kept !== undefined) setNote(note, kept.text, kept.tone);

  const actions = element("div", "conn-actions");
  if (KNOWN_STATES.has(record.state)) {
    actions.append(
      element("span", "chip muted next-hint", "Next: " + connectionNextAction[record.state]),
    );
  }

  const test = element("button", undefined, "Test connection");
  test.type = "button";
  const refreshNow = element("button", undefined, "Refresh now");
  refreshNow.type = "button";
  const disconnect = element("button", undefined, "Disconnect");
  disconnect.type = "button";
  const controls = [test, refreshNow, disconnect];
  const busy = (on) => {
    for (const control of controls) control.disabled = on;
  };

  test.addEventListener("click", () => {
    void (async () => {
      busy(true);
      setNote(note, "Asking the provider.", "plain");
      const asked = await probe(record, false);
      if (asked.absent) {
        keepCardNote(record.id, note, "This build has no connection backend yet.", "bad");
        render();
        return;
      }
      /* A test completes only when a connector actually understood the body.
         Anything else leaves the backend's own verdict standing. */
      if (asked.snapshots !== null) {
        await closeAttempt(record, asked.generation, "parsed_test");
      } else if (asked.drifted) {
        await closeAttempt(record, asked.generation, "drift");
      }
      await syncConnections();
      const settled = session.connections.find((entry) => entry.id === record.id);
      if (asked.note !== null) {
        keepCardNote(record.id, note, "The test failed. " + asked.note, "bad");
      } else {
        keepCardNote(
          record.id,
          note,
          sentenceFor(settled?.state ?? record.state),
          asked.snapshots !== null ? "ok" : "bad",
        );
      }
      render();
    })();
  });

  refreshNow.addEventListener("click", () => {
    void (async () => {
      busy(true);
      setNote(note, "Refreshing.", "plain");
      const outcome = await runRefresh(record);
      if (outcome.succeeded) {
        options.onMetersChanged();
        keepCardNote(
          record.id,
          note,
          "Refreshed. The reading is in the cache and on the meters.",
          "ok",
        );
      } else if (outcome.note !== null) {
        keepCardNote(record.id, note, outcome.note, "bad");
      } else {
        const fresh = session.connections.find((entry) => entry.id === record.id);
        keepCardNote(record.id, note, sentenceFor(fresh?.state ?? record.state), "bad");
      }
      render();
    })();
  });

  /* Disconnect asks twice. The second press within a few seconds is the
     consent; anything later starts over. No dialog, no framework. */
  let confirming = null;
  disconnect.addEventListener("click", () => {
    if (confirming === null) {
      disconnect.textContent = "Press again to disconnect";
      disconnect.classList.add("confirming");
      confirming = window.setTimeout(() => {
        confirming = null;
        disconnect.textContent = "Disconnect";
        disconnect.classList.remove("confirming");
      }, 4_000);
      return;
    }
    window.clearTimeout(confirming);
    confirming = null;
    void (async () => {
      busy(true);
      const result = await backend.disconnectProvider(record.id);
      if (result.ok) {
        /* The credential is gone, so the schedule entry has nothing to
           schedule, the note has no card to sit on, and the live mark no
           longer has a connection behind it. */
        delete session.schedule[record.id];
        delete session.cardNotes[record.id];
        saveSchedule();
        if (
          record.provider !== null &&
          !session.connections.some(
            (entry) => entry.provider === record.provider && entry.id !== record.id,
          )
        ) {
          session.liveRefreshOk.delete(record.provider);
        }
      } else {
        keepCardNote(
          record.id,
          note,
          result.reason === backend.BACKEND_ABSENT
            ? "This build has no connection backend yet."
            : "Disconnecting failed: " + result.message,
          "bad",
        );
      }
      await syncConnections();
      options.onMetersChanged();
      render();
    })();
  });

  actions.append(test, refreshNow, disconnect);
  node.append(actions);
  node.append(note);
  return node;
}

/* ----------------------------------------------------------------- render */

function renderSchedulerLine() {
  if (session.backendPresent === false) {
    el.schedulerLine.textContent =
      "No collector tick can arrive: this build has no connection backend.";
    return;
  }
  const stored = storedHeartbeat();
  const stamp = timeWord(session.lastTickAt ?? stored);
  if (session.lastTickAt === null) {
    el.schedulerLine.textContent =
      stamp === null
        ? "No collector tick has been received yet in this run."
        : "No collector tick has been received yet in this run. Last heartbeat written " +
          stamp +
          ".";
    return;
  }
  el.schedulerLine.textContent =
    "Collector heartbeat " +
    stamp +
    ". Ticks received this run: " +
    String(session.ticksThisRun) +
    ".";
}

function renderClaude() {
  el.claudeSnippet.textContent = CLAUDE_SETUP_SNIPPET;
  /* No backend, no look. Saying "looking" while nothing can look would be a
     claim about an activity this build cannot perform. */
  if (session.backendPresent === false) {
    el.claudeState.hidden = true;
    el.claudeSentence.textContent =
      "Detecting a local tool needs the connection backend, and this build has none.";
    el.claudeDetail.textContent =
      "The setup block below still works: copy it, wire it by hand, and the statusline reports on its own.";
    el.claudeVerify.disabled = true;
    return;
  }
  const state = session.claudeProbed ? claudeStateOf() : null;
  if (state === null) {
    el.claudeState.hidden = true;
    el.claudeSentence.textContent = session.claudeProbed
      ? "The detection answer could not be read, so nothing is claimed about this machine."
      : "Looking for Claude Code on this machine.";
    el.claudeDetail.textContent = "";
    el.claudeVerify.disabled = false;
    return;
  }
  el.claudeState.hidden = false;
  el.claudeState.dataset.connectionState = state;
  el.claudeState.title = connectionSentence[state];
  el.claudeStateCode.textContent = state;
  el.claudeSentence.textContent = connectionSentence[state];
  const detection = session.claude;
  el.claudeDetail.textContent =
    state === "NOT_CONFIGURED"
      ? "Claude Code was not found on this machine."
      : state === "DETECTED"
        ? "Claude Code was found. Its statusline command does not point at OpenLimiter yet."
        : detection !== null && detection.wired === true
          ? "Claude Code was found and its statusline command points at OpenLimiter."
          : "Claude Code was found.";
  el.claudeVerify.disabled = false;
}

function render() {
  if (!session.ready) return;
  const now = new Date().toISOString();
  renderSchedulerLine();

  const absent = session.backendPresent === false;
  el.absent.hidden = !absent;
  el.openrouterAdd.hidden = absent || session.backendPresent === null;

  el.cards.textContent = "";
  if (session.backendPresent === true) {
    for (const record of session.connections) {
      el.cards.append(connectionCard(record, now));
    }
    if (session.listError !== null) {
      const line = element("p", "conn-note");
      line.dataset.tone = "bad";
      line.setAttribute("role", "status");
      line.textContent = "Listing connections failed: " + session.listError;
      el.cards.append(line);
    }
  }
  el.empty.hidden = !(
    session.backendPresent === true &&
    session.connections.length === 0 &&
    session.listError === null
  );

  renderClaude();
}

/* ---------------------------------------------------------------- actions */

async function submitOpenrouter() {
  const input = el.openrouterKey;
  const kindChoice = el.openrouterKind();
  const kind = kindChoice === null ? "api_key" : kindChoice.value;
  const secret = input.value.trim();
  /* Cleared before anything else happens, success or failure, so the secret
     never sits in a form field while a request is in flight. */
  input.value = "";
  if (secret === "") {
    setNote(el.openrouterNote, "Nothing was pasted, so nothing was stored.", "bad");
    return;
  }
  /* The contract wants an alias on every connection, because account
     identity is first class. An unnamed account is honestly called default,
     which is what it is until a second account makes a name matter. */
  const alias = el.openrouterAlias.value.trim() || "default";
  el.openrouterSubmit.disabled = true;
  setNote(el.openrouterNote, "Storing the key in the credential store.", "plain");
  /* The two OpenRouter credential kinds, as the wire spells them. A stored
     and untested credential lands in READY_TO_ENABLE, which the backend
     derives: this window no longer states a starting state. */
  const credentialKind = /management/iu.test(String(kind))
    ? "openrouter_management_key"
    : "openrouter_inference_key";
  const connected = await backend.connectProvider({
    providerId: "openrouter",
    credentialKind,
    accountAlias: alias,
    secret,
  });
  if (!connected.ok) {
    if (connected.reason === backend.BACKEND_ABSENT) {
      session.backendPresent = false;
      setNote(el.openrouterNote, "This build has no connection backend yet.", "bad");
    } else {
      setNote(el.openrouterNote, "Connecting failed. " + connected.message, "bad");
    }
    el.openrouterSubmit.disabled = false;
    render();
    return;
  }
  await syncConnections();
  const returned =
    typeof connected.value === "string"
      ? connected.value
      : (backend.normalizeConnection(connected.value)?.id ?? null);
  const record =
    (returned !== null
      ? session.connections.find((entry) => entry.id === returned)
      : undefined) ??
    session.connections.filter((entry) => entry.provider === "OPENROUTER").at(-1);
  if (record === undefined) {
    setNote(
      el.openrouterNote,
      "The key was stored, and no connection record came back to test.",
      "bad",
    );
    el.openrouterSubmit.disabled = false;
    render();
    return;
  }
  setNote(el.openrouterNote, "Stored. Testing the connection now.", "plain");
  const asked = await probe(record, false);
  if (asked.absent) {
    setNote(el.openrouterNote, "This build has no connection backend yet.", "bad");
    el.openrouterSubmit.disabled = false;
    render();
    return;
  }
  if (asked.snapshots !== null) {
    await closeAttempt(record, asked.generation, "parsed_test");
  } else if (asked.drifted) {
    await closeAttempt(record, asked.generation, "drift");
  }
  await syncConnections();
  const settled = session.connections.find((entry) => entry.id === record.id);
  if (asked.note !== null) {
    setNote(el.openrouterNote, "The test failed. " + asked.note, "bad");
  } else {
    setNote(
      el.openrouterNote,
      "Test finished. " + sentenceFor(settled?.state ?? record.state),
      asked.snapshots !== null ? "ok" : "bad",
    );
  }
  el.openrouterAlias.value = "";
  el.openrouterSubmit.disabled = false;
  render();
}

async function copyClaudeSnippet() {
  try {
    await window.navigator.clipboard.writeText(CLAUDE_SETUP_SNIPPET);
    setNote(
      el.claudeNote,
      "Copied. Add it to your Claude Code settings.json, then press Verify.",
      "ok",
    );
  } catch {
    /* Clipboard refused. The block is selectable, so select it for the
       person instead of failing with nothing to show. */
    const selection = window.getSelection();
    if (selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(el.claudeSnippet);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setNote(
      el.claudeNote,
      "Copying was refused here, so the block is selected. Copy it by hand.",
      "bad",
    );
  }
}

async function verifyClaude() {
  el.claudeVerify.disabled = true;
  setNote(el.claudeNote, "Detecting.", "plain");
  await detectClaude();
  const state = claudeStateOf();
  setNote(
    el.claudeNote,
    state === null
      ? "Detection is not available in this build."
      : connectionSentence[state],
    state === null ? "bad" : "plain",
  );
  render();
}

/* ------------------------------------------------------------------ public */

/**
 * What the meters view may say about a provider's connection.
 *
 * Null when there is nothing to say: no backend, or no record for this
 * provider. Otherwise the record's state and whether a live refresh has
 * actually succeeded in this run, which is the one fact that permits the
 * word Connected on a meters row.
 */
export function connectionFactFor(provider) {
  if (session.backendPresent !== true) return null;
  const records = session.connections.filter((entry) => entry.provider === provider);
  if (records.length === 0) return null;
  const best =
    records.find((entry) => entry.state === "CONNECTED") ?? records[0];
  return {
    state: KNOWN_STATES.has(best.state) ? best.state : null,
    liveOk: session.liveRefreshOk.has(provider),
  };
}

/**
 * The meters just re-read the cache. The Claude card's split between ready
 * and collecting depends on that cache, so it is redrawn.
 */
export function noteMetersRefreshed() {
  if (!session.ready) return;
  renderClaude();
}

/**
 * The Connections tab was brought on screen. On a build where the backend
 * probe said absent this asks again, because the person may have switched
 * builds under the same profile, and a stale absent block would be a claim
 * about the wrong build.
 */
export function connectionsTabShown() {
  if (!session.ready) return;
  void (async () => {
    await syncConnections();
    if (session.backendPresent === true && !session.claudeProbed) {
      await detectClaude();
    }
    render();
  })();
}

async function bootstrap() {
  await syncConnections();
  if (session.backendPresent === true) await detectClaude();
  render();
}

export function initConnections(configuration) {
  options = configuration;
  grabElements();
  session.schedule = loadSchedule();
  session.ready = true;

  el.reprobe.addEventListener("click", () => {
    void bootstrap();
  });
  el.openrouterSubmit.addEventListener("click", () => {
    void submitOpenrouter();
  });
  el.claudeCopy.addEventListener("click", () => {
    void copyClaudeSnippet();
  });
  el.claudeVerify.addEventListener("click", () => {
    void verifyClaude();
  });

  void backend.listen(TICK_EVENT, () => {
    void onTick();
  });
  void bootstrap();
}
