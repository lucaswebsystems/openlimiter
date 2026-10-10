import path from "node:path";
import {
  PROVIDER_CODES,
  RETENTION_MILLISECONDS,
  claudeMeterPresentation,
  floorFixed,
  freshness,
  providerMeterPresentation,
  providerMeterRank,
  providerMeterVisible,
  isSnapshotDisplayEligible,
  readAcquisitionSchedule,
  readJsonFileSafely,
  type Advice,
  type ProviderCode,
  type Snapshot,
  type SnapshotAvailability
} from "@openlimiter/core";
import { STATUSLINE_BAR_SEGMENTS, meterBar } from "./render.js";
import type { StatuslineColor, StatuslineConfig, StatuslineCaptions } from "./config.js";
import type { StatuslineSession } from "./statusline-ingest.js";
import { MONEY_TAGS, moneyCells } from "./api-spend.js";

/**
 * Reference terminal layout with host session details and labelled quota bars.
 * The host wraps the bar line. The optional legacy cells style keeps its own
 * width budget and advice header for existing configurations.
 */

/**
 * Which half of the row a provider belongs in.
 *
 * A subscription is a window that refills on a clock, so its percentage is
 * about how much of today is left. A credit or API balance is money, so its
 * percentage is about how much of the plan is left forever. Reading the two
 * kinds in one undifferentiated row invites treating a spent balance like a
 * window that will come back, so the subscriptions come first and the priced
 * meters sit at the end where they read as a different kind of fact.
 *
 * The table is exhaustive over the provider codes on purpose: a provider added
 * to the engine will not compile until somebody says which half it is in.
 */
const PROVIDER_CLASS: Record<ProviderCode, "subscription" | "api"> = {
  CLAUDE: "subscription",
  CODEX: "subscription",
  ANTIGRAVITY: "subscription",
  GEMINI_CLI: "subscription",
  OPENCODE: "subscription",
  GROK: "subscription",
  KIMI: "subscription",
  CURSOR: "subscription",
  MANUAL: "subscription",
  OPENROUTER: "api"
};

export const DEFAULT_PROVIDER_ORDER: readonly ProviderCode[] = [
  ...PROVIDER_CODES.filter((code) => PROVIDER_CLASS[code] === "subscription"),
  ...PROVIDER_CODES.filter((code) => PROVIDER_CLASS[code] === "api")
];

const providerCodes = new Set<string>(PROVIDER_CODES);

/**
 * The order the configured ids ask for, completed by the built in order.
 *
 * An id this version does not know, and an id named twice, are both dropped
 * rather than rejected. This runs on every redraw of somebody else's status
 * row; a stale provider id left in a configuration file is not a reason to
 * stop drawing the providers that are still there.
 */
export function resolveProviderOrder(
  configured: readonly string[]
): readonly ProviderCode[] {
  const listed: ProviderCode[] = [];
  for (const id of configured) {
    const code = id.toUpperCase();
    if (!providerCodes.has(code)) continue;
    const provider = code as ProviderCode;
    if (listed.includes(provider)) continue;
    listed.push(provider);
  }
  return [
    ...listed,
    ...DEFAULT_PROVIDER_ORDER.filter((code) => !listed.includes(code))
  ];
}

/* ------------------------------------------------------------------ meters */

export type MeterClass =
  | "session"
  | "daily"
  | "weekly"
  | "monthly"
  | "credits"
  | "other";

/** Shortest window first, then money, then anything unrecognised. */
const METER_CLASS_RANK: Record<MeterClass, number> = {
  session: 0,
  daily: 1,
  weekly: 2,
  monthly: 3,
  credits: 4,
  other: 5
};

const SIX_HOURS = 21_600;
const ONE_DAY = 86_400;
const SEVEN_DAYS = 604_800;
const THIRTY_ONE_DAYS = 2_678_400;

const AVAILABILITY_WORDS: Readonly<Record<SnapshotAvailability, string>> = {
  missing_credentials: "signed out",
  expired_credentials: "credential expired",
  access_denied: "access denied",
  missing_subscription: "subscription missing",
  unlimited: "unlimited",
  quota_unavailable: "quota unavailable",
  rate_limited: "rate limited",
  network_failure: "network failure",
  schema_drift: "schema changed"
};

function isAvailabilitySnapshot(snapshot: Snapshot): boolean {
  return snapshot.availability !== undefined || snapshot.meter.toUpperCase() === "ACQUISITION";
}

function isOpenRouterAccountBalance(snapshot: Snapshot): boolean {
  return snapshot.provider === "OPENROUTER" &&
    (snapshot.meter === "ACCOUNT_BALANCE" || snapshot.meter === "CREDITS");
}

function isBalanceSnapshot(snapshot: Snapshot): boolean {
  return isOpenRouterAccountBalance(snapshot) ||
    providerMeterPresentation(snapshot.provider, snapshot.meter)?.valueSemantics === "balance";
}

function availabilityText(snapshot: Snapshot, now: string): string {
  if (snapshot.availability === undefined) return "not measured";
  if (snapshot.provider === "OPENROUTER" && snapshot.meter === "KEY_LIMIT" &&
      snapshot.availability === "unlimited") return "No key cap";
  if (snapshot.provider === "OPENROUTER" && snapshot.meter === "ACCOUNT_BALANCE" &&
      snapshot.availability === "missing_credentials") return "unavailable";
  if (snapshot.provider === "CODEX" && snapshot.meter === "CREDITS" &&
      snapshot.availability === "unlimited") return "unlimited credits";
  if (snapshot.availability === "rate_limited" && snapshot.retryAt !== undefined) {
    const retryAt = Date.parse(snapshot.retryAt);
    const nowAt = Date.parse(now);
    if (Number.isFinite(retryAt) && Number.isFinite(nowAt) && retryAt > nowAt) {
      return "rate limited until " + new Date(retryAt).toISOString().slice(11, 16);
    }
  }
  return AVAILABILITY_WORDS[snapshot.availability];
}

function availabilityCell(label: string, snapshot: Snapshot, now: string): StatuslineCell {
  const text = label + " " + availabilityText(snapshot, now);
  return { plain: text, painted: text, percent: Number.NEGATIVE_INFINITY };
}

/**
 * The classes a meter name maps to when its window states no duration.
 *
 * Only names this project already emits, plus the obvious synonyms a hand
 * written manual document reaches for. Anything else is `other` and sorts
 * last, which is the honest answer: an unrecognised name is not evidence of a
 * short window.
 */
const METER_NAME_CLASS: Readonly<Record<string, MeterClass>> = {
  SESSION: "session",
  PRIMARY: "session",
  FIVE_HOUR: "session",
  HOURLY: "session",
  DAILY: "daily",
  DAY: "daily",
  WEEKLY: "weekly",
  WEEK: "weekly",
  SEVEN_DAY: "weekly",
  MONTHLY: "monthly",
  MONTH: "monthly",
  CREDITS: "credits",
  BALANCE: "credits"
};

/**
 * Which kind of window a reading measures.
 *
 * The window's own duration decides it wherever a connector states one,
 * because a duration is a fact and a name is a label. The name table is the
 * fallback for the connectors that state a window kind and no length.
 */
export function meterClass(snapshot: Snapshot): MeterClass {
  if (snapshot.unit === "CREDITS" || snapshot.window.kind === "lifetime") {
    return "credits";
  }
  const duration = snapshot.window.durationSeconds;
  if (duration !== undefined) {
    if (duration <= SIX_HOURS) return "session";
    if (duration <= ONE_DAY) return "daily";
    if (duration <= SEVEN_DAYS) return "weekly";
    if (duration <= THIRTY_ONE_DAYS) return "monthly";
    return "other";
  }
  return METER_NAME_CLASS[snapshot.meter] ?? "other";
}

/* ------------------------------------------------------------------- cells */

export interface StatuslineCell {
  /** The cell with no escape codes, which is what the width budget measures. */
  readonly plain: string;
  /** The cell as printed, painted when colour is allowed. */
  readonly painted: string;
  /** The reading behind it, which decides what survives when cells are shed. */
  readonly percent: number;
}

/** Two spaces between cells, so a reader can tell one cell from the next. */
export const CELL_GAP = "  ";

function buildCell(
  label: string,
  snapshot: Snapshot,
  state: "fresh" | "stale",
  color: boolean,
  wide?: boolean,
  bars = true
): StatuslineCell {
  const percent = Math.round(snapshot.value) + "%";
  if (!bars) {
    const text = label + " " + percent;
    return { plain: text, painted: text, percent: snapshot.value };
  }
  const bar = meterBar(snapshot.value, state, false, STATUSLINE_BAR_SEGMENTS, wide);
  return {
    plain: label + " " + bar + " " + percent,
    painted: label + " " + (color ? paintBand(bar, snapshot.value, state) + " " + paintBand(percent, snapshot.value, state) : bar + " " + percent),
    percent: snapshot.value
  };
}

function balanceCell(label: string, snapshot: Snapshot, stale: boolean): StatuslineCell {
  let value: string;
  if (
    snapshot.currency === "USD" &&
    snapshot.usedAmount !== undefined &&
    snapshot.limitAmount !== undefined
  ) {
    value = "$" + Math.max(0, snapshot.limitAmount - snapshot.usedAmount).toFixed(2);
  } else if (isOpenRouterAccountBalance(snapshot) && snapshot.unit === "CREDITS") {
    // The current balance identity can carry a direct credit amount, as the
    // capture fixture does. Version 3 also retires the ambiguous legacy name,
    // but an already loaded balance keeps the same terminal meaning.
    value = "$" + snapshot.value.toFixed(2);
  } else {
    value = floorFixed(snapshot.value, 2) + " credits";
  }
  const text = label + " " + (stale ? "~" : "") + value;
  return { plain: text, painted: text, percent: Number.NEGATIVE_INFINITY };
}

interface Reading {
  snapshot: Snapshot;
  state: "fresh" | "stale";
}

function readingsFor(
  snapshots: readonly Snapshot[],
  provider: ProviderCode,
  now: string
): Reading[] {
  const providerRows = snapshots.filter((snapshot) =>
    snapshot.provider === provider && providerMeterVisible(snapshot.provider, snapshot.meter) &&
    isSnapshotDisplayEligible(snapshot));
  const latestAccount = new Map<string | undefined, number>();
  for (const snapshot of providerRows) {
    const observed = Date.parse(snapshot.observedAt);
    if (Number.isFinite(observed) && observed <= Date.parse(now)) {
      latestAccount.set(snapshot.accountId, Math.max(latestAccount.get(snapshot.accountId) ?? 0, observed));
    }
  }
  // Dormant accounts remain in the cache, but cannot displace an active account.
  // A provider whose every account went quiet keeps its newest one, marked
  // stale, for as long as the data rules hold a stale reading.
  const newest = Math.max(0, ...latestAccount.values());
  const shownAccount = (accountId: string | undefined): boolean => {
    const age = Date.parse(now) - (latestAccount.get(accountId) ?? 0);
    return age <= ONE_DAY * 1000 ||
      (latestAccount.get(accountId) === newest && age <= RETENTION_MILLISECONDS);
  };
  const readings = providerRows
    .filter((snapshot) => (snapshot.unit === "PERCENT" ||
      isBalanceSnapshot(snapshot) ||
      isAvailabilitySnapshot(snapshot)) &&
      shownAccount(snapshot.accountId))
    .map((snapshot) => ({
      snapshot,
      state: freshness(snapshot.observedAt, snapshot.expiresAt, now)
    }))
    .filter((reading): reading is Reading => reading.state !== "unknown")
    .sort((left, right) => {
      const presentationRank = (providerMeterRank(provider, left.snapshot.meter) ?? 90) -
        (providerMeterRank(provider, right.snapshot.meter) ?? 90);
      if (presentationRank !== 0) return presentationRank;
      const rank = METER_CLASS_RANK[meterClass(left.snapshot)] -
        METER_CLASS_RANK[meterClass(right.snapshot)];
      if (rank !== 0) return rank;
      return left.snapshot.meter < right.snapshot.meter ? -1 : 1;
    });
  const balanceRows = provider === "OPENROUTER"
    ? readings.filter(({ snapshot }) => isOpenRouterAccountBalance(snapshot))
    : [];
  const measuredBalances = balanceRows.filter(({ snapshot }) => !isAvailabilitySnapshot(snapshot));
  const newestBalance = provider === "OPENROUTER"
    ? (measuredBalances.length > 0 ? measuredBalances : balanceRows).reduce<Reading | undefined>(
      (newest, reading) => newest === undefined ||
        Date.parse(reading.snapshot.observedAt) > Date.parse(newest.snapshot.observedAt) ? reading : newest,
      undefined,
    )
    : undefined;
  const selectedReadings = newestBalance === undefined
    ? readings
    : readings.filter(({ snapshot }) => !isOpenRouterAccountBalance(snapshot) || snapshot === newestBalance.snapshot);
  const measuredAccounts = new Set(
    selectedReadings
      .filter((reading) => !isAvailabilitySnapshot(reading.snapshot))
      .map((reading) => reading.snapshot.accountId)
  );
  // Only measured readings are drawn: a provider that cannot be measured right
  // now is left out of the line entirely, exactly as it is left off Home.
  // Unlimited is an answer, not a failure, so it stays.
  return selectedReadings.filter((reading) =>
    !isAvailabilitySnapshot(reading.snapshot) ||
    providerMeterPresentation(reading.snapshot.provider, reading.snapshot.meter)?.displayAvailability === true ||
    reading.snapshot.availability === "unlimited" && !measuredAccounts.has(reading.snapshot.accountId)
  );
}

function claudeFamilyCodesFor(
  snapshot: Snapshot,
  snapshots: readonly Snapshot[]
): readonly string[] {
  return snapshots
    .filter((candidate) => candidate.provider === "CLAUDE" && candidate.accountId === snapshot.accountId)
    .map((candidate) => candidate.meter);
}

function tightest(readings: readonly Reading[]): Reading | undefined {
  let worst = readings[0];
  for (const reading of readings.slice(1)) {
    if (worst === undefined || reading.snapshot.value > worst.snapshot.value) worst = reading;
  }
  return worst;
}

function worstReadings(provider: ProviderCode, readings: readonly Reading[]): Reading[] {
  if (provider === "OPENROUTER") {
    const keyRows = readings.filter(({ snapshot }) => snapshot.meter === "KEY_LIMIT");
    const balanceRows = readings.filter(({ snapshot }) => snapshot.meter === "ACCOUNT_BALANCE");
    return [tightest(keyRows), tightest(balanceRows)].filter((row): row is Reading => row !== undefined);
  }
  const percentages = readings.filter(({ snapshot }) =>
    !isAvailabilitySnapshot(snapshot) && !isBalanceSnapshot(snapshot));
  return [tightest(percentages.length > 0 ? percentages : readings)]
    .filter((row): row is Reading => row !== undefined);
}

/**
 * One cell per provider, or one per meter.
 *
 * The filter is the same one the advice policy uses, so the cells and the
 * reason code leading them are always describing the same set of readings. A
 * provider with several meters shows its worst one, because a status row exists
 * to tell you what is about to stop you, and the meter closest to its cap is
 * that. The full set is one `openlimiter snapshot` away, and `meters all` puts
 * it back in the row for anyone who wants it there.
 *
 * `wide` is the terminal's 256 colour claim, handed straight to the shared bar
 * so a statusline cell and a table row draw the same reading in the same band
 * colour. Left off, the bar reads the environment for itself.
 */
export function statuslineCells(
  snapshots: readonly Snapshot[],
  now: string,
  order: readonly ProviderCode[],
  meters: StatuslineConfig["meters"],
  color: boolean,
  wide?: boolean,
  bars = true,
  hostProvider: ProviderCode | null = null,
  captions: StatuslineCaptions = "short"
): readonly StatuslineCell[] {
  const cells: StatuslineCell[] = [];
  for (const provider of order) {
    const readings = readingsFor(snapshots, provider, now);
    if (readings.length === 0) continue;
    if (meters === "all") {
      for (const reading of readings) {
        if (isAvailabilitySnapshot(reading.snapshot)) {
          cells.push(availabilityCell(captionFor(reading.snapshot, hostProvider, captions, claudeFamilyCodesFor(reading.snapshot, snapshots)), reading.snapshot, now));
          continue;
        }
        const meterTag = captionFor(reading.snapshot, hostProvider, captions, claudeFamilyCodesFor(reading.snapshot, snapshots));
        if (providerMeterPresentation(provider, reading.snapshot.meter)?.valueSemantics === "balance") {
          cells.push(balanceCell(meterTag, reading.snapshot, reading.state === "stale"));
          continue;
        }
        cells.push(buildCell(
          meterTag,
          reading.snapshot,
          reading.state,
          color,
          wide,
          bars
        ));
      }
      continue;
    }
    for (const worst of worstReadings(provider, readings)) {
      const label = captionFor(worst.snapshot, hostProvider, captions, claudeFamilyCodesFor(worst.snapshot, snapshots));
      if (isAvailabilitySnapshot(worst.snapshot)) {
        cells.push(availabilityCell(label, worst.snapshot, now));
        continue;
      }
      if (providerMeterPresentation(provider, worst.snapshot.meter)?.valueSemantics === "balance") {
        cells.push(balanceCell(label, worst.snapshot, worst.state === "stale"));
        continue;
      }
      cells.push(buildCell(label, worst.snapshot, worst.state, color, wide, bars));
    }
  }
  return cells;
}

/** The compact one line style, with the same meter meanings as the bar style. */
export function renderPlainStatusline(
  advice: Advice,
  snapshots: readonly Snapshot[],
  now: string,
  order: readonly ProviderCode[],
  meters: StatuslineConfig["meters"],
  pollHint?: string,
  hostProvider: ProviderCode | null = null,
): string {
  if (!advice.inject || advice.reason === "UNKNOWN") return "OpenLimiter UNKNOWN";
  const cells = statuslineCells(snapshots, now, order, meters, false, undefined, false, hostProvider);
  if (cells.length === 0) return "OpenLimiter UNKNOWN";
  const recommendation = advice.recommendation.code === "PREFER"
    ? " PREFER " + advice.recommendation.provider
    : " NONE";
  const unknown = advice.unknownProviders.length === 0
    ? ""
    : " UNKNOWN " + advice.unknownProviders.join(",");
  return "OpenLimiter " + advice.reason + " " + cells.map((cell) => cell.plain).join(" ") +
    recommendation + unknown + (pollHint === undefined ? "" : " " + pollHint);
}

/* -------------------------------------------------------- the weekly cell */

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Whether a poll refusal is recorded for a Claude login on this line: by the
 * desktop, per account, in `request-policy.json`, or by this tool's own poll
 * in its schedule. A refusal whose wait is over is no longer one.
 */
async function claudeRefused(snapshots: readonly Snapshot[], now: string, directory: string): Promise<boolean> {
  const at = Date.parse(now);
  const own = (await readAcquisitionSchedule(directory))["CLAUDE"];
  if (own?.refusalRevision !== undefined && Date.parse(own.nextAttemptAt) > at) return true;
  const policy = await readJsonFileSafely(path.join(directory, "request-policy.json"));
  const claude = policy.ok ? field(field(policy.value, "providers"), "claude") : undefined;
  return snapshots.some((snapshot) => snapshot.provider === "CLAUDE" && snapshot.accountId !== undefined &&
    typeof field(field(claude, "refusal_revisions"), snapshot.accountId) === "string" &&
    Number(field(field(claude, "accounts"), snapshot.accountId)) > at);
}

/**
 * The cell that says why the Claude weekly bar is missing, or nothing.
 *
 * It appears while Claude has a reading on this line and no weekly, fresh or
 * stale. Both consents count, this tool's `providers.claude.poll` and the
 * desktop's `claude-poll.json`: off on both says so, a recorded refusal says
 * refused, and otherwise the weekly is waiting for its next poll.
 */
export async function claudeWeeklyHint(
  snapshots: readonly Snapshot[],
  now: string,
  cliPoll: boolean,
  directory: string
): Promise<string | undefined> {
  if (!snapshots.some((snapshot) => snapshot.provider === "CLAUDE") ||
      readingsFor(snapshots, "CLAUDE", now).some(({ snapshot }) =>
        snapshot.meter.startsWith("SEVEN_DAY") && !isAvailabilitySnapshot(snapshot))) {
    return undefined;
  }
  const desktop = await readJsonFileSafely(path.join(directory, "claude-poll.json"));
  const desktopPoll = desktop.ok && field(desktop.value, "version") === 1 && field(desktop.value, "enabled") === true;
  if (!cliPoll && !desktopPoll) return "7d off";
  return await claudeRefused(snapshots, now, directory) ? "7d refused" : "7d waiting";
}

/* ------------------------------------------------------------------ layout */

/**
 * Everything that is not a cell.
 *
 * The reason code, the recommendation and the unknown list are the same three
 * fields the 0.1.0 line carried and they carry the same words, moved to the
 * front so that the row can end wherever the cells end. They are never wrapped
 * and never dropped: a row of bars with no verdict in front of it is a picture,
 * not a status.
 */
export function statuslineHead(advice: Advice): string {
  const recommendation = advice.recommendation.code === "PREFER"
    ? " PREFER " + advice.recommendation.provider
    : " NONE";
  const unknown = advice.unknownProviders.length === 0
    ? ""
    : " UNKNOWN " + advice.unknownProviders.join(",");
  return "OpenLimiter " + advice.reason + recommendation + unknown;
}

function moreCell(dropped: number): StatuslineCell {
  const text = "+" + String(dropped) + " more";
  return { plain: text, painted: text, percent: Number.NEGATIVE_INFINITY };
}

/**
 * Fill the rows left to right and report where it got to.
 *
 * A cell is placed whole or not at all, so the break always lands between two
 * cells. Nothing is ever cut in half, because half a bar reads as a reading and
 * is not one.
 */
function packed(
  head: string,
  cells: readonly StatuslineCell[],
  width: number,
  rows: number
): StatuslineCell[][] {
  const laid: StatuslineCell[][] = [];
  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    const current: StatuslineCell[] = [];
    let used = row === 0 ? head.length : 0;
    while (index < cells.length) {
      const cell = cells[index]!;
      const needed = used === 0
        ? cell.plain.length
        : used + CELL_GAP.length + cell.plain.length;
      if (needed > width) break;
      used = needed;
      current.push(cell);
      index += 1;
    }
    laid.push(current);
  }
  return laid;
}

function fittedCount(rows: readonly StatuslineCell[][]): number {
  return rows.reduce((total, row) => total + row.length, 0);
}

/**
 * The worst cells, restored to display order.
 *
 * When the row cannot hold everything, what it drops has to be the readings
 * that matter least, and the reading that matters least is the one furthest
 * from its cap. Ties keep display order, so the choice is stable between
 * redraws of the same data.
 */
function worstCells(
  cells: readonly StatuslineCell[],
  keep: number
): StatuslineCell[] {
  return cells
    .map((cell, index) => ({ cell, index }))
    .sort((left, right) =>
      right.cell.percent - left.cell.percent || left.index - right.index)
    .slice(0, keep)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.cell);
}

function paintRows(head: string, rows: readonly StatuslineCell[][]): string {
  const lines: string[] = [];
  rows.forEach((row, index) => {
    const body = row.map((cell) => cell.painted).join(CELL_GAP);
    if (index === 0) {
      lines.push(body === "" ? head : head + CELL_GAP + body);
      return;
    }
    if (body !== "") lines.push(body);
  });
  return lines.join("\n");
}

export type StatuslineHost =
  | "claude"
  | "antigravity"
  | "grok"
  | "codex"
  | "shell";

export const STATUSLINE_HOSTS: readonly StatuslineHost[] = [
  "claude",
  "antigravity",
  "grok",
  "codex",
  "shell"
];

export function isStatuslineHost(value: string): value is StatuslineHost {
  return (STATUSLINE_HOSTS as readonly string[]).includes(value.toLowerCase());
}

export const PROVIDER_SHORT_TAGS: Readonly<Record<ProviderCode, string>> = {
  CLAUDE: "cl",
  CODEX: "cx",
  ANTIGRAVITY: "ag",
  GEMINI_CLI: "gm",
  GROK: "gk",
  KIMI: "km",
  CURSOR: "cu",
  OPENCODE: "oc",
  OPENROUTER: "or",
  MANUAL: "mn"
};

export const HOST_PROVIDER: Readonly<Record<StatuslineHost, ProviderCode | null>> = {
  claude: "CLAUDE",
  antigravity: "ANTIGRAVITY",
  grok: "GROK",
  codex: "CODEX",
  shell: null
};

export const BAR_CELL_SEPARATOR = " | ";
export const TEN_BLOCK_FULL = "█";
export const TEN_BLOCK_EMPTY = "░";

export function windowCode(snapshot: Snapshot): string {
  const presentation = providerMeterPresentation(snapshot.provider, snapshot.meter);
  const claude = snapshot.provider === "CLAUDE" ? claudeMeterPresentation(snapshot.meter) : null;
  if (claude !== null && (claude.model !== null || claude.labelKey === "claudeExtraUsage")) {
    return claude.compactLabel.toLowerCase();
  }
  if (snapshot.unit === "CREDITS" || snapshot.window.kind === "lifetime") {
    return "";
  }
  const duration = snapshot.window.durationSeconds;
  const meterName = snapshot.meter.toUpperCase();
  if (meterName.includes("MONTH") || meterName === "ON_DEMAND_MONTHLY") return "mo";
  if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
    if (duration % ONE_DAY === 0) return String(duration / ONE_DAY) + "d";
    if (duration % 3600 === 0) return String(duration / 3600) + "h";
    if (duration % 60 === 0) return String(duration / 60) + "m";
    return String(duration) + "s";
  }
  if (meterName === "FIVE_HOUR" || meterName === "SESSION") return "5h";
  if (meterName === "DAILY" || meterName === "DAY") return "1d";
  if (meterName === "WEEKLY" || meterName === "SEVEN_DAY") return "7d";
  if (meterName === "MONTHLY" || meterName === "MONTH") return "mo";
  return "";
}

/** The one caption rule used by bar cells, legacy cells, and availability. */
export function captionFor(
  snapshot: Snapshot,
  hostProvider: ProviderCode | null,
  captions: StatuslineCaptions = "short",
  familyCodes: readonly string[] = []
): string {
  const provider = snapshot.provider;
  const presentation = providerMeterPresentation(provider, snapshot.meter, familyCodes);
  const claude = provider === "CLAUDE" ? claudeMeterPresentation(snapshot.meter, familyCodes) : null;
  if (claude !== null && (claude.model !== null || claude.labelKey === "claudeExtraUsage")) {
    return claude.compactLabel.toLowerCase();
  }
  if (provider === "ANTIGRAVITY" &&
      (snapshot.meter === "THIRD_PARTY_SESSION" || snapshot.meter === "THIRD_PARTY_WEEKLY")) {
    const scoped = presentation?.compactLabel.toLowerCase() ?? windowCode(snapshot);
    return captions === "tagged" || hostProvider !== provider
      ? PROVIDER_SHORT_TAGS[provider] + scoped
      : scoped;
  }
  if (provider === "OPENROUTER" && snapshot.meter === "KEY_LIMIT" && snapshot.availability === undefined) {
    const key = presentation?.compactLabel.toLowerCase() ?? "key";
    return captions === "tagged" || hostProvider !== provider
      ? PROVIDER_SHORT_TAGS[provider] + " " + key
      : key;
  }
  const code = windowCode(snapshot);
  if (code === "") return PROVIDER_SHORT_TAGS[provider];
  if (captions === "tagged" || hostProvider !== provider) {
    return PROVIDER_SHORT_TAGS[provider] + code;
  }
  return code;
}

function visibilityKey(snapshot: Snapshot): string {
  if (snapshot.provider === "CLAUDE") {
    const presentation = claudeMeterPresentation(snapshot.meter);
    if (presentation?.labelKey === "claudeWeeklyFable") return "fable";
    if (presentation?.model !== null && presentation?.model !== undefined) {
      return presentation.model.split(/[\s-]+/u)[0]!.toLowerCase();
    }
    if (presentation?.labelKey === "claudeExtraUsage") return "extra";
  }
  return windowCode(snapshot).toLowerCase();
}

function windowVisible(snapshot: Snapshot, visibility: Readonly<Record<string, boolean>>): boolean {
  const specific = visibility[visibilityKey(snapshot)];
  if (specific !== undefined) return specific;
  if (snapshot.provider === "CLAUDE" && claudeMeterPresentation(snapshot.meter)?.modelScoped) {
    return visibility["7d"] !== false;
  }
  return true;
}

export function tenBlockBar(value: number, unicode = true): string {
  const clamped = Math.min(100, Math.max(0, value));
  const filled = clamped > 0 ? Math.max(1, Math.floor(clamped / 10)) : 0;
  const empty = 10 - filled;
  return "[" + (unicode ? TEN_BLOCK_FULL : "#").repeat(filled) + (unicode ? TEN_BLOCK_EMPTY : ".").repeat(empty) + "]";
}

function compactResetDuration(diffSec: number): string {
  if (diffSec >= 86_400) {
    const days = Math.floor(diffSec / 86_400);
    const hours = Math.floor((diffSec % 86_400) / 3600);
    return String(days) + "d" + (hours > 0 ? String(hours) + "h" : "");
  }
  if (diffSec >= 3600) {
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    return String(hours) + "h" + (mins > 0 ? String(mins) + "m" : "");
  }
  return diffSec >= 60 ? String(Math.floor(diffSec / 60)) + "m" : String(diffSec) + "s";
}

export function formatResetTime(resetAt: string | null | undefined, now: string): string {
  if (!resetAt) return "";
  const diffMs = new Date(resetAt).getTime() - new Date(now).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (!Number.isFinite(diffSec) || diffSec <= 0) return "";
  return "·" + compactResetDuration(diffSec);
}

export function paintBand(
  text: string,
  value: number,
  _state: "fresh" | "stale",
  _wide = false
): string {
  if (value >= 90) return "\x1b[31m" + text + "\x1b[0m";
  if (value >= 80) return "\x1b[38;5;208m" + text + "\x1b[0m";
  if (value >= 60) return "\x1b[33m" + text + "\x1b[0m";
  return "\x1b[32m" + text + "\x1b[0m";
}

export function barStyleCells(
  snapshots: readonly Snapshot[],
  now: string,
  order: readonly ProviderCode[],
  host: StatuslineHost,
  show: readonly string[],
  metersSetting: StatuslineConfig["meters"],
  color: boolean,
  wide?: boolean,
  explicitSelection = false,
  visibility: Readonly<Record<string, boolean>> = {},
  unicode = true,
  inputCaptions: StatuslineCaptions = "short"
): readonly StatuslineCell[] {
  const cells: StatuslineCell[] = [];
  const hostProvider = HOST_PROVIDER[host];
  const allowedProviders = show.length === 0 && !explicitSelection
    ? null
    : new Set(show.map((s) => s.toLowerCase()));

  for (const provider of order) {
    const shortTag = PROVIDER_SHORT_TAGS[provider];
    const isAllowed = visibility[provider.toLowerCase()] ?? (allowedProviders === null ||
      allowedProviders.has(provider.toLowerCase()) ||
      allowedProviders.has(shortTag));

    if (!isAllowed) continue;

    const readings = readingsFor(snapshots, provider, now).filter(({ snapshot }) =>
      windowVisible(snapshot, visibility));
    // Nothing measured means nothing drawn, even for a provider someone chose.
    if (readings.length === 0) continue;

    let selectedReadings: Reading[] = [];
    if (provider === hostProvider) {
      selectedReadings = readings;
    } else if (metersSetting === "all") {
      selectedReadings = readings;
    } else {
      selectedReadings = worstReadings(provider, readings);
    }

    for (const reading of selectedReadings) {
      const { snapshot, state } = reading;
      const ageSeconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(snapshot.observedAt)) / 1000));
      const stale = state === "stale" || ageSeconds >= 180 || snapshot.precision === "estimated";

      if (isAvailabilitySnapshot(snapshot)) {
        const tag = captionFor(snapshot, hostProvider, inputCaptions, claudeFamilyCodesFor(snapshot, snapshots));
        const plain = tag + " " + availabilityText(snapshot, now);
        const chosen = visibility[provider.toLowerCase()] === true ||
          allowedProviders?.has(provider.toLowerCase()) || allowedProviders?.has(shortTag);
        const unknown = chosen && snapshot.availability !== "unlimited";
        cells.push({ plain: plain + (unknown ? " [?]" : ""), painted: plain +
          (unknown ? (color ? " \x1b[31m[?]\x1b[0m" : " [?]") : ""), percent: Number.NEGATIVE_INFINITY });
        continue;
      }

      if (isBalanceSnapshot(snapshot)) {
        cells.push(balanceCell(captionFor(snapshot, hostProvider, inputCaptions, claudeFamilyCodesFor(snapshot, snapshots)), snapshot, stale));
        continue;
      }

      if (provider === "OPENROUTER" && snapshot.meter === "KEY_LIMIT" &&
          snapshot.usedAmount !== undefined && snapshot.limitAmount !== undefined &&
          snapshot.currency === "USD") {
        const amount = (stale ? "~" : "") + "$" + snapshot.usedAmount.toFixed(2) +
          "/$" + snapshot.limitAmount.toFixed(2);
        const plain = captionFor(snapshot, hostProvider, inputCaptions, claudeFamilyCodesFor(snapshot, snapshots)) + " " + amount;
        cells.push({ plain, painted: plain, percent: snapshot.value });
        continue;
      }

      if (snapshot.provider === "CLAUDE" && snapshot.meter === "EXTRA_USAGE" &&
          snapshot.usedAmount !== undefined && snapshot.limitAmount !== undefined &&
          snapshot.currency === "USD") {
        const amount = (stale ? "~" : "") + "$" + snapshot.usedAmount.toFixed(2) +
          "/$" + snapshot.limitAmount.toFixed(2);
        const tag = captionFor(snapshot, hostProvider, inputCaptions, claudeFamilyCodesFor(snapshot, snapshots));
        const plain = tag + " " + amount;
        cells.push({ plain, painted: plain, percent: snapshot.value });
        continue;
      }

      if (snapshot.usedAmount !== undefined && snapshot.currency === "USD") {
        const tag = captionFor(snapshot, hostProvider, inputCaptions, claudeFamilyCodesFor(snapshot, snapshots));
        const plain = tag + " spend " + (stale ? "~" : "") + "$" + snapshot.usedAmount.toFixed(2);
        cells.push({ plain, painted: plain, percent: snapshot.value });
        continue;
      }

      const tag = captionFor(snapshot, hostProvider, inputCaptions, claudeFamilyCodesFor(snapshot, snapshots));

      const bar = tenBlockBar(snapshot.value, unicode);
      const percentStr = (stale ? "~" : "") + Math.round(snapshot.value) + "%";
      const resetStr = formatResetTime(snapshot.resetAt, now).replace("·", unicode ? "·" : ".");

      const label = tag;
      const plain = resetStr !== ""
        ? label + " " + bar + " " + percentStr + " " + resetStr
        : label + " " + bar + " " + percentStr;

      let painted = plain;
      if (color) {
        const paintedBar = paintBand(bar, snapshot.value, stale ? "stale" : "fresh", wide);
        const paintedPct = paintBand(percentStr, snapshot.value, stale ? "stale" : "fresh", wide);
        painted = resetStr !== ""
          ? label + " " + paintedBar + " " + paintedPct + " " + resetStr
          : label + " " + paintedBar + " " + paintedPct;
      }

      cells.push({
        plain,
        painted,
        percent: snapshot.value
      });
    }
  }

  return cells;
}

function renderBarStatusline(input: StatuslineLayoutInput): string {
  const { config } = input;
  const host = input.host ?? "claude";
  const cells = barStyleCells(
    input.snapshots,
    input.now,
    resolveProviderOrder(config.order),
    host,
    config.show,
    config.meters,
    input.color,
    input.wide,
    config.showMode === "explicit",
    config.visibility,
    input.unicode,
    config.captions
  );
  const listed = new Set(config.show.map((entry) => entry.toLowerCase()));
  const apiMoney = moneyCells(input.apiSpend, {
    now: input.now,
    allowed: (name) => {
      const tag = name === "openrouter" ? "or" : MONEY_TAGS[name];
      return config.visibility?.[name] ??
        (config.show.length === 0 && config.showMode !== "explicit" || listed.has(name) || tag !== undefined && listed.has(tag));
    }
  });
  const session = input.session ?? {};
  const shown = (key: string): boolean => config.visibility?.[key] !== false;
  const parts: string[] = [];
  const identity = [shown("model") ? session.model : undefined, shown("effort") ? session.effort : undefined].filter(Boolean).join(" ");
  if (identity) parts.push(identity);
  // The folder is opt in: the line goes from model and effort straight to the
  // context window unless someone runs `openlimiter terminal show dir`.
  if (config.visibility?.["dir"] === true && session.dir) parts.push(session.dir);
  if (shown("ctx") && session.ctx !== undefined) parts.push("ctx " + Math.round(session.ctx) + "%");
  parts.push(...cells.map((cell) => cell.painted));
  parts.push(...apiMoney.map((cell) => input.color && cell.band !== null
    ? cell.prefix + paintBand(cell.amount, cell.band, "fresh")
    : cell.plain));
  if (shown("style") && session.style) parts.push(session.style);
  if (input.pollHint && shown("7d")) parts.push(input.pollHint);
  // The host owns wrapping. A column guess must not silently hide a provider.
  return parts.join(BAR_CELL_SEPARATOR) || STATUSLINE_UNKNOWN;
}

export interface StatuslineLayoutInput {
  advice: Advice;
  snapshots: readonly Snapshot[];
  now: string;
  config: StatuslineConfig;
  color: boolean;
  /** Legacy caller compatibility; the reference palette is locked. */
  wide?: boolean;
  host?: StatuslineHost;
  session?: StatuslineSession;
  unicode?: boolean;
  /** The parsed `api-spend-v1.json`, when the desktop app has saved one. */
  apiSpend?: unknown;
  pollHint?: string;
}

/** What the statusline says when it has nothing bounded to say. */
export const STATUSLINE_UNKNOWN = "OpenLimiter UNKNOWN";

/**
 * Draw the whole line, stacking it rather than truncating it.
 *
 * The budget is a budget, not a terminal measurement: nothing here asks the
 * operating system how wide the window is, because a statusline host runs this
 * command with no terminal attached and the answer would be an invention. The
 * number in the configuration is the number that is honoured.
 */
export function renderStatuslineLayout(input: StatuslineLayoutInput): string {
  const { advice, config } = input;
  if (config.style === "cells") {
    if (!advice.inject || advice.reason === "UNKNOWN") return STATUSLINE_UNKNOWN;
    const cells = statuslineCells(
      input.snapshots.filter((snapshot) => windowVisible(snapshot, config.visibility ?? {})),
      input.now,
      resolveProviderOrder(config.order).filter((provider) =>
        config.visibility?.[provider.toLowerCase()] ??
        (config.show.length === 0 && config.showMode !== "explicit" ||
        config.show.includes(provider.toLowerCase()) || config.show.includes(PROVIDER_SHORT_TAGS[provider]))),
      config.meters,
      input.color,
      input.wide,
      true,
      HOST_PROVIDER[input.host ?? "claude"],
      config.captions
    );
    if (cells.length === 0) return STATUSLINE_UNKNOWN;
    const head = statuslineHead(advice);
    const whole = packed(head, cells, config.width, config.rows);
    if (fittedCount(whole) === cells.length) return paintRows(head, whole);
    for (let keep = fittedCount(whole); keep >= 0; keep -= 1) {
      const shown = [...worstCells(cells, keep), moreCell(cells.length - keep)];
      const attempt = packed(head, shown, config.width, config.rows);
      if (fittedCount(attempt) === shown.length) return paintRows(head, attempt);
    }
    return head;
  }

  return renderBarStatusline(input);
}

/**
 * Whether this render may paint.
 *
 * `NO_COLOR` wins over every setting, including `always`. It is the one
 * convention a person can set once, for every tool on the machine, and a
 * configuration file inside one tool is not the place to overrule it.
 */
export function statuslineColor(
  setting: StatuslineColor,
  environment: Readonly<Record<string, string | undefined>>,
  automatic: boolean,
  host?: StatuslineHost
): boolean {
  if (environment["NO_COLOR"] !== undefined) return false;
  if (setting === "never") return false;
  if (setting === "always") return true;
  return automatic || host === "claude";
}

/** Node writes UTF8 on every OS; fall back only for an explicit encoding limitation. */
export function statuslineUnicode(environment: Readonly<Record<string, string | undefined>>): boolean {
  const locale = environment["LC_ALL"] || environment["LC_CTYPE"] || environment["LANG"];
  return environment["TERM"] !== "dumb" && !/^(C|POSIX)$/i.test(locale ?? "");
}
