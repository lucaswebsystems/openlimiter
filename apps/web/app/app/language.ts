import {
  floorFixed,
  type Advice,
  type ConnectionState,
  type MeterView,
  type ProviderCode,
  type SnapshotSourceKind,
  type SnapshotState,
} from "./engine";

/** The engine's four overall reason codes. */
type AdviceReason = Advice["reason"];

/**
 * The words and the thresholds the dashboard renders with.
 *
 * Nothing here decides anything about quota. Every number that matters is
 * already decided by the engine; this module only chooses which colour band a
 * decided number falls in, and which English sentence a decided enum code is
 * shown as. The desktop window carries the same three functions in plain
 * JavaScript, so the two surfaces cannot describe one reading differently.
 */

/** The four pressure bands, plus the band a meter with no reading gets. */
export type Pressure = "ok" | "watch" | "high" | "critical" | "none";

/**
 * The band a percentage falls in.
 *
 *   ok        0 to 59
 *   watch     60 to 79
 *   high      80 to 89
 *   critical  90 and above
 *
 * EIGHTY IS THE ENGINE'S OWN NUMBER. packages/core/src/policy.ts calls a
 * provider NEAR_CAP at 80 and stops recommending it there, so a meter turning
 * orange is the same event as the agent being told to route away: the human
 * and the agent see the same threshold at the same moment. Red at 90 is the
 * human's own band on top of that, the point at which it is worth acting
 * rather than merely knowing.
 *
 * Nothing here feeds back into the engine. No number, no reason code and no
 * recommendation is derived from these bands: they choose a colour and stop.
 * The desktop window and the command line tool carry the same four.
 */
export function pressureOf(percent: number): Pressure {
  if (!Number.isFinite(percent)) return "none";
  if (percent >= 90) return "critical";
  if (percent >= 80) return "high";
  if (percent >= 60) return "watch";
  return "ok";
}

/**
 * A reading as bar geometry, clamped to the track and nothing else.
 *
 * The bar this feeds is continuous, so the number that decides its length is
 * the number itself rather than a step. The old bar was ten blocks with a half
 * step every five percent, which drew 91 and 97 identically: two readings four
 * days apart in a weekly window looked like the same reading. Nothing is
 * rounded here and nothing is bucketed. The only arithmetic is the clamp, which
 * exists because a track cannot be longer than itself.
 *
 * A value that is not a number at all is not a zero, so this returns null and
 * the caller draws the unknown track, which has no fill in it.
 */
export function meterFraction(percent: number): number | null {
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, percent));
}

/**
 * The same clamped reading as a CSS width.
 *
 * Every decimal the source carried survives into the style, because the whole
 * point of a continuous bar is that a tenth of a percent moves it. Number's own
 * string form is used rather than a fixed number of places, so 91 stays "91%"
 * and 97.2 stays "97.2%" instead of both being padded or both being trimmed.
 */
export function meterWidth(percent: number): string | null {
  const fraction = meterFraction(percent);
  return fraction === null ? null : String(fraction) + "%";
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * A reset window in the words a person would use.
 *
 * Two units at most, largest first, because "resets in 6d 23h" is something
 * you can plan around and "resets in 6d 23h 14m 09s" is a stopwatch.
 */
export function countdown(resetAt: string | null, now: string): string {
  if (resetAt === null) return "no reset window";
  const target = Date.parse(resetAt);
  const current = Date.parse(now);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return "no reset window";
  const remaining = target - current;
  if (remaining <= 0) return "reset window has passed";
  if (remaining < MINUTE) return "resets in under a minute";
  if (remaining < HOUR) {
    return "resets in " + String(Math.floor(remaining / MINUTE)) + "m";
  }
  if (remaining < DAY) {
    const hours = Math.floor(remaining / HOUR);
    const minutes = Math.floor((remaining % HOUR) / MINUTE);
    return "resets in " + String(hours) + "h " + String(minutes) + "m";
  }
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  return "resets in " + String(days) + "d " + String(hours) + "h";
}

/** What a freshness state means, in one short phrase. */
export const freshnessWord: Record<SnapshotState, string> = {
  fresh: "Fresh",
  stale: "Stale",
  unknown: "Unknown",
};

/**
 * A meter code, in the words a person uses for that stretch of time.
 *
 * The engine names a window after the thing it is: FIVE_HOUR is the rolling
 * window a session burns through, SEVEN_DAY is the week. Those are the right
 * names in a payload and the wrong ones on a card, so this is the one place
 * they are translated, and every surface reads from it.
 *
 * A provider may report a meter nobody here has heard of, because a manual
 * document names its own, so an unmapped code is never dropped and never left
 * shouting in upper case: it is title cased and shown as it is.
 */
const METER_NAMES: Record<string, string> = {
  FIVE_HOUR: "Current session",
  SESSION: "Current session",
  PRIMARY: "Primary window",
  SECONDARY: "Secondary window",
  HOURLY: "Hourly",
  DAILY: "Daily",
  ONE_DAY: "Daily",
  SEVEN_DAY: "Weekly",
  WEEKLY: "Weekly",
  THIRTY_DAY: "Monthly",
  MONTHLY: "Monthly",
  CREDITS: "Credits",
  BALANCE: "Credits",
};

export function meterName(code: string): string {
  const known = METER_NAMES[code];
  if (known !== undefined) return known;
  const words = code.toLowerCase().split(/[\s_-]+/u).filter((word) => word !== "");
  if (words.length === 0) return code;
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

/**
 * Where a meter sits in the reading order.
 *
 * Shortest window first, money last, which is the order somebody actually
 * checks: what is left in this session, then today, then the week, then the
 * month, then the balance. Nothing here depends on how many meters a provider
 * reports, so a provider that grows a third window slots into the same order
 * with no change to any surface.
 */
const METER_RANK: Record<string, number> = {
  FIVE_HOUR: 10,
  SESSION: 10,
  PRIMARY: 15,
  SECONDARY: 16,
  HOURLY: 20,
  DAILY: 30,
  ONE_DAY: 30,
  SEVEN_DAY: 40,
  WEEKLY: 40,
  THIRTY_DAY: 50,
  MONTHLY: 50,
  CREDITS: 60,
  BALANCE: 60,
};

/** Unmapped codes sort after every known one, then alphabetically. */
export function meterRank(code: string): number {
  return METER_RANK[code] ?? 90;
}

/** Sort any list of meters into the reading order above, by code. */
export function byMeterOrder(left: string, right: string): number {
  const difference = meterRank(left) - meterRank(right);
  return difference !== 0 ? difference : left.localeCompare(right);
}

/**
 * How many meters a card is showing, when that is worth saying.
 *
 * One meter is the ordinary case and stating it is filler, so a card with one
 * meter says nothing at all. This returns null there and the caller renders
 * nothing rather than an empty chip.
 */
export function meterCountLabel(count: number): string | null {
  return count < 2 ? null : String(count) + " meters";
}

/** The plain sentence under an overall state chip. */
export const reasonSentence: Record<AdviceReason, string> = {
  HEALTHY: "Every readable meter is under 80%.",
  NEAR_CAP: "At least one readable meter is at 80% or more.",
  AT_CAP: "At least one readable meter has reached its cap.",
  /* Not "nothing readable has been supplied": that sentence described a parser
     to its author rather than a state to its reader, and the audit named it. */
  UNKNOWN: "No provider has reported yet, so nothing is claimed.",
};

/**
 * The band an overall reason code is painted in.
 *
 * NEAR_CAP is orange rather than red now that the two scales agree on eighty:
 * the engine raises NEAR_CAP at exactly the percentage a meter turns orange, so
 * the chip and the bars say the same thing. AT_CAP keeps red, which is the one
 * state that means stop.
 */
export const reasonPressure: Record<AdviceReason, Pressure> = {
  HEALTHY: "ok",
  NEAR_CAP: "high",
  AT_CAP: "critical",
  UNKNOWN: "none",
};

/** Why there is no provider to prefer, when there is none. */
export const noRecommendationSentence: Record<string, string> = {
  NO_KNOWN_PROVIDER: "No provider has a readable meter.",
  NO_FRESH_DATA: "Every reading has aged past its own expiry.",
  NO_HEALTHY_PROVIDER: "Every readable provider is at 80% or more.",
};

const PROVIDER_NAMES: Record<ProviderCode, string> = {
  CLAUDE: "Claude",
  OPENROUTER: "OpenRouter",
  CODEX: "Codex",
  ANTIGRAVITY: "Antigravity",
  OPENCODE: "OpenCode",
  MANUAL: "Manual",
};

export function providerName(code: string): string {
  return PROVIDER_NAMES[code as ProviderCode] ?? code;
}

/** What each provider's meters are read from, in four or five words. */
const PROVIDER_ORIGIN: Record<ProviderCode, string> = {
  CLAUDE: "Statusline payload",
  OPENROUTER: "Documented credits API",
  CODEX: "Provider managed payload",
  ANTIGRAVITY: "Provider managed payload",
  OPENCODE: "Authenticated page",
  MANUAL: "Written down by you",
};

export function providerOrigin(code: string): string {
  return PROVIDER_ORIGIN[code as ProviderCode] ?? "";
}

/* --------------------------------------------------------- connection state */

/**
 * How a reading actually reached this device.
 *
 * Four states, and only one of them is the word connected, which nothing can
 * reach today. A parser existing is not a connection: five of the six providers
 * here have a parser and no reader, which means somebody has to hand the
 * document over, and the interface has to say so rather than let a filled bar
 * imply a live account.
 *
 *   LOCAL_CLI     a tool already running on this machine wrote the payload
 *   IMPORT_ONLY   the shape parses, and nothing here fetches it for you
 *   MANUAL        a number you wrote down yourself
 *   CONNECTED     OpenLimiter itself held a credential and made the request
 *
 * CONNECTED is reserved rather than aspirational. It is here because the
 * provenance vocabulary already names `remote_api`, and a state that exists in
 * the data with no word for it would be silently painted as one of the other
 * three. No reader in this product can produce it yet, so in practice it only
 * appears if a stamped reading claims it.
 *
 * The code is what a bug report should quote and the label is what a person
 * reads, so the chip shows the label and carries the code in its title.
 */
export type SourceState = "LOCAL_CLI" | "IMPORT_ONLY" | "MANUAL" | "CONNECTED";

export const sourceStateLabel: Record<SourceState, string> = {
  LOCAL_CLI: "Local CLI",
  IMPORT_ONLY: "Import only",
  MANUAL: "Manual",
  CONNECTED: "Connected",
};

/** One sentence per state, for the chip's tooltip and the connections list. */
export const sourceStateSentence: Record<SourceState, string> = {
  LOCAL_CLI:
    "A tool on this machine writes the payload, and OpenLimiter reads what it wrote.",
  IMPORT_ONLY:
    "The payload shape is parsed. Nothing here signs in or fetches it, so you supply the document.",
  MANUAL: "Figures you keep yourself. Nothing is read from an account.",
  CONNECTED:
    "OpenLimiter held a credential and asked the provider itself. No reader in this build does that yet.",
};

/** What a provider's state is before any reading has arrived. */
const PROVIDER_DEFAULT_SOURCE: Record<ProviderCode, SourceState> = {
  CLAUDE: "LOCAL_CLI",
  OPENROUTER: "IMPORT_ONLY",
  CODEX: "IMPORT_ONLY",
  ANTIGRAVITY: "IMPORT_ONLY",
  OPENCODE: "IMPORT_ONLY",
  MANUAL: "MANUAL",
};

/**
 * The one place a stamped provenance becomes a source state.
 *
 * `unknown` maps to nothing on purpose. It is the value the normalizer writes
 * when a provenance was present and could not be believed, so treating it as an
 * answer would let a malformed stamp overrule a source literal that is fine.
 * Null here means fall through to the literal logic below.
 */
const PROVENANCE_SOURCE_STATE: Record<SnapshotSourceKind, SourceState | null> = {
  statusline_payload: "LOCAL_CLI",
  explicit_ingest: "IMPORT_ONLY",
  manual_document: "MANUAL",
  remote_api: "CONNECTED",
  unknown: null,
};

/**
 * The state a reading is shown in, decided by the reading rather than by a
 * table where one exists.
 *
 * PROVENANCE FIRST, AND WHY
 * -------------------------
 * `source` is the provider's own word for the shape of the document: a Claude
 * statusline block is `native_payload` whether Claude Code handed it over on
 * this machine or somebody pasted a copy of it out of a chat log. Keying the
 * chip off that literal chipped an imported Claude payload as Local CLI, which
 * is the one sentence this chip exists to never say wrongly.
 *
 * `provenance.sourceKind` is OpenLimiter's own word for how the reading
 * arrived, written by whatever read it and never by a provider, so it is the
 * better answer whenever there is one. When it is absent, or stamped `unknown`,
 * the literal logic below runs exactly as it always did: this is a preference,
 * not a replacement, and a store full of rows written before provenance existed
 * renders byte for byte the way it used to.
 */
export function sourceStateOf(
  provider: string,
  source?: MeterView["source"],
  provenance?: MeterView["provenance"],
): SourceState {
  const stamped =
    provenance === undefined ? null : PROVENANCE_SOURCE_STATE[provenance.sourceKind];
  if (stamped !== null) return stamped;
  if (source === "native_payload") return "LOCAL_CLI";
  if (source === "manual_entry") return "MANUAL";
  if (source !== undefined) return "IMPORT_ONLY";
  return PROVIDER_DEFAULT_SOURCE[provider as ProviderCode] ?? "IMPORT_ONLY";
}

/**
 * What each provider can actually do today, in one honest line each.
 *
 * This is the connections list, and it is deliberately the least exciting text
 * in the product. Nothing here is a promise: a line says what happens if you
 * try it right now.
 *
 * Two of these fields are scoped to THIS SURFACE, a browser page, and say so
 * in their names. `browserState` is the connection state machine's state for
 * the provider here: every remote and local tool provider is IMPORT_ONLY in a
 * browser, whatever the desktop app can do, because this page holds no
 * credential and makes no request. Its sentence and next action come from the
 * core tables, so the browser and the desktop describe one state with one
 * sentence. `documentPath` is where the document a person imports comes from,
 * as the command or file that produces it.
 */
export interface ConnectionFact {
  provider: ProviderCode;
  state: SourceState;
  line: string;
  /** The core state machine's state for this provider, in a browser. */
  browserState: ConnectionState;
  /** The command or file the imported document comes from, or null. */
  documentPath: string | null;
}

export const CONNECTION_FACTS: readonly ConnectionFact[] = [
  {
    provider: "CLAUDE",
    state: "LOCAL_CLI",
    line: "Claude Code writes a rate limit block to its statusline command. Point that command at OpenLimiter and the reading arrives on its own.",
    browserState: "IMPORT_ONLY",
    documentPath: null,
  },
  {
    provider: "OPENROUTER",
    state: "IMPORT_ONLY",
    line: "The documented credits response parses. This page holds no key and makes no request, so paste or ingest the response. A live OpenRouter connection is the desktop application's job.",
    browserState: "IMPORT_ONLY",
    documentPath: "openlimiter ingest --provider openrouter",
  },
  {
    provider: "CODEX",
    state: "IMPORT_ONLY",
    line: "The usage payload the Codex tooling produces parses. Internal shape, no reader, so the document comes from you.",
    browserState: "IMPORT_ONLY",
    documentPath: "openlimiter ingest --provider codex",
  },
  {
    provider: "ANTIGRAVITY",
    state: "IMPORT_ONLY",
    line: "The quota payload the Antigravity tooling produces parses. Internal shape, no reader, so the document comes from you.",
    browserState: "IMPORT_ONLY",
    documentPath: "openlimiter ingest --provider antigravity",
  },
  {
    provider: "OPENCODE",
    state: "IMPORT_ONLY",
    line: "The usage view behind an existing session parses. Nothing here opens or holds that session.",
    browserState: "IMPORT_ONLY",
    documentPath: "openlimiter ingest --provider opencode",
  },
  {
    provider: "MANUAL",
    state: "MANUAL",
    line: "Write down what you know for anything with no interface at all. It never breaks and it never guesses.",
    browserState: "MANUAL",
    documentPath: "manual.json in the state directory, or openlimiter ingest --provider manual",
  },
];

/**
 * The exact statusline wiring, byte for byte the block the documentation and
 * the desktop application publish. It renders on the Claude connection block
 * because the answer to "how do I connect Claude" is this object and nothing
 * else, and it must be the same object everywhere it appears.
 */
export const CLAUDE_STATUSLINE_WIRING = `{
  "statusLine": {
    "type": "command",
    "command": "openlimiter statusline"
  }
}`;

/**
 * The label a bar is announced with.
 *
 * A screen reader hears the same three facts a sighted reader sees: which
 * meter, what the number is, and how much of it to trust.
 */
export function meterLabel(meter: MeterView, percent: string, now: string): string {
  const money = amountSentence(meter);
  return (
    meterName(meter.meter) +
    " at " +
    percent +
    " percent, " +
    freshnessWord[meter.state].toLowerCase() +
    ", " +
    countdown(meter.resetAt, now) +
    (money === null ? "" : ", " + money)
  );
}

/**
 * A credit plan, in money.
 *
 * Only ever called for a reading the normalizer let through with all three of
 * its money fields intact, so there is no half stated case to handle here. The
 * spend is truncated rather than rounded, for the same reason a percentage is:
 * telling somebody they have spent more than they have is the one error worth
 * designing against.
 */
export interface AmountParts {
  /** What has been spent, already formatted with its symbol. */
  spent: string;
  /** What was loaded, already formatted with its symbol. */
  loaded: string;
}

export function amountLine(meter: MeterView): AmountParts | null {
  if (
    meter.usedAmount === undefined ||
    meter.limitAmount === undefined ||
    meter.currency === undefined
  ) return null;
  return {
    spent: "$" + floorFixed(meter.usedAmount, 2),
    loaded: "$" + floorFixed(meter.limitAmount, 2),
  };
}

/** The same two figures as one sentence, for a screen reader and a tooltip. */
export function amountSentence(meter: MeterView): string | null {
  const parts = amountLine(meter);
  return parts === null ? null : parts.spent + " spent of " + parts.loaded + " loaded";
}
