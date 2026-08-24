import {
  dedupeFailures,
  failureSentence,
  floorFixed,
  freshness,
  type ProviderCode,
  type ProviderFailure,
  type Snapshot,
  type SnapshotPrecision,
  type SnapshotSource,
  type SnapshotState,
} from "@openlimiter/core";
import { PROVIDER_RECOGNITION_ORDER } from "./provider-connect.js";

export type HeadroomTone = "ok" | "watch" | "high" | "critical" | "none";

export interface ProviderWindowView {
  key: string;
  label: string;
  state: SnapshotState;
  stateLabel: string;
  tone: HeadroomTone;
  metricKind: "percent" | "bounded_spend" | "unbounded_spend";
  usedPercent: number | null;
  readout: string;
  detail: string;
  resetLabel: string | null;
  accessibleLabel: string;
}

export interface ProviderAccountRowView {
  key: string;
  provider: ProviderCode;
  providerLabel: string;
  accountId: string | null;
  accountLabel: string;
  showAccountLabel: boolean;
  sourceLabel: string | null;
  windows: readonly ProviderWindowView[];
  fallback: {
    kind: "not_found" | "manual_entry";
    title: string;
    detail: string;
  } | null;
  failure: string | null;
  demo: boolean;
}

export interface ProviderRowOptions {
  demo?: boolean;
  providers?: readonly ProviderCode[];
}

const PROVIDER_NAMES: Record<ProviderCode, string> = {
  CLAUDE: "Claude",
  OPENROUTER: "OpenRouter",
  CODEX: "Codex",
  ANTIGRAVITY: "Antigravity",
  GEMINI_CLI: "Gemini CLI",
  OPENCODE: "OpenCode",
  GROK: "Grok",
  KIMI: "Kimi",
  MANUAL: "Manual",
};

const PROVIDER_CODE_BY_SPEC_ID: Readonly<Record<string, ProviderCode | undefined>> = {
  "openai/codex": "CODEX",
  "anthropic/claude-code": "CLAUDE",
  "google/gemini-cli": "GEMINI_CLI",
  "google/antigravity": "ANTIGRAVITY",
  "xai/api": "GROK",
  "moonshot/api": "KIMI",
  "opencode/opencode": "OPENCODE",
  "openrouter/api": "OPENROUTER",
  "openlimiter/manual": "MANUAL",
};

const DEFAULT_PROVIDER_CODES: readonly ProviderCode[] = PROVIDER_RECOGNITION_ORDER.flatMap(
  (specId) => {
    const provider = PROVIDER_CODE_BY_SPEC_ID[specId];
    return provider === undefined ? [] : [provider];
  },
);

const PROVIDER_MARKS: Record<ProviderCode, string> = {
  CLAUDE:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1M7.8 3.1l8.4 17.8M20.9 7.8 3.1 16.2M16.2 3.1 7.8 20.9M3.1 7.8l17.8 8.4"/></svg>',
  OPENROUTER:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.778 1.844v1.919c-3.16-.14-5.68.42-8.702 2.242-2.911 2.066-2.731 1.95-4.14 2.75-.792.447-3.934 1.131-3.936 1.131v4.229s3.003.555 3.795 1.132c1.41.798 1.228.683 4.14 2.75 3.02 1.821 5.68 2.382 8.703 2.21v1.919l7.222-4.168-7.222-4.17v2.176c-2.231.1-3.645-.075-6.257-1.444-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 2.61-1.37 4.025-1.545 6.255-1.446v2.176L24 6.014Z"/></svg>',
  CODEX:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.096 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.514 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.989 5.989 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073Zm-9.022 12.608a4.476 4.476 0 0 1-2.877-1.041l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.682v-6.736l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494Zm-9.661-4.125a4.471 4.471 0 0 1-.534-3.014l.142.085 4.783 2.758a.771.771 0 0 0 .78 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.499 4.499 0 0 1-6.141-1.646ZM2.341 7.896a4.485 4.485 0 0 1 2.365-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787a4.504 4.504 0 0 1-1.647-6.141Zm16.596 3.855-5.833-3.387 2.015-1.164a.076.076 0 0 1 .071 0l4.831 2.791a4.494 4.494 0 0 1-.677 8.104v-5.677a.79.79 0 0 0-.407-.667Zm2.011-3.023-.142-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.831-2.787a4.499 4.499 0 0 1 6.68 4.66ZM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.056V6.074a4.499 4.499 0 0 1 7.375-3.454l-.142.081-4.778 2.758a.795.795 0 0 0-.393.681Zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"/></svg>',
  ANTIGRAVITY:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ol-antigravity-gradient" x1="12" y1="1.8" x2="12" y2="22.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--ol-provider-google-red)"/><stop offset=".34" stop-color="var(--ol-provider-google-yellow)"/><stop offset=".66" stop-color="var(--ol-provider-google-green)"/><stop offset="1" stop-color="var(--ol-provider-google-blue)"/></linearGradient></defs><path d="M12 1.8C14.8 1.8 17.1 7.8 19.6 14.2C20.5 16.5 21.4 19 21.4 20.2C21.4 21.8 19.8 22.4 17.8 20.6C16.3 16.8 14.1 12.5 12 12.5C9.9 12.5 7.7 16.8 6.2 20.6C4.2 22.4 2.6 21.8 2.6 20.2C2.6 19 3.5 16.5 4.4 14.2C6.9 7.8 9.2 1.8 12 1.8Z" fill="url(#ol-antigravity-gradient)"/></svg>',
  GEMINI_CLI:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ol-gemini-gradient" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--ol-provider-gemini-blue)"/><stop offset=".52" stop-color="var(--ol-provider-gemini-purple)"/><stop offset="1" stop-color="var(--ol-provider-gemini-coral)"/></linearGradient></defs><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="url(#ol-gemini-gradient)"/></svg>',
  OPENCODE:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 24H2V0h20Zm-5-19.2H7v14.4h10Z"/></svg>',
  GROK:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>',
  KIMI:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441"/></svg>',
  MANUAL:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M16.6 3.6a2 2 0 0 1 2.8 2.8L8.5 17.3l-3.7.9.9-3.7Z"/><path d="m14.6 5.6 3.8 3.8M4 21h16"/></svg>',
};

const WINDOW_NAMES: Readonly<Record<string, string>> = {
  FIVE_HOUR: "5 hour session",
  SESSION: "Session",
  PRIMARY: "Primary window",
  SECONDARY: "Secondary window",
  HOURLY: "Hourly",
  FIVE_MINUTE: "5 minute window",
  DAILY: "Daily",
  ONE_DAY: "Daily",
  SEVEN_DAY: "Weekly",
  SEVEN_DAY_OPUS: "Weekly Opus",
  SEVEN_DAY_SONNET: "Weekly Sonnet",
  WEEKLY: "Weekly",
  THIRTY_DAY: "Monthly",
  MONTHLY: "Monthly",
  ON_DEMAND_MONTHLY: "On demand monthly",
  CREDITS: "Credits",
  BALANCE: "Credits",
  HARD_LIMIT: "Hard limit",
  LIMIT: "Hard limit",
};

const WINDOW_RANK: Readonly<Record<string, number>> = {
  FIVE_HOUR: 10,
  SESSION: 10,
  PRIMARY: 15,
  SECONDARY: 16,
  HOURLY: 20,
  FIVE_MINUTE: 5,
  DAILY: 30,
  ONE_DAY: 30,
  SEVEN_DAY: 40,
  SEVEN_DAY_OPUS: 41,
  SEVEN_DAY_SONNET: 42,
  WEEKLY: 40,
  THIRTY_DAY: 50,
  MONTHLY: 50,
  ON_DEMAND_MONTHLY: 51,
  CREDITS: 60,
  BALANCE: 60,
  HARD_LIMIT: 70,
  LIMIT: 70,
};

const STATE_LABELS: Record<SnapshotState, string> = {
  fresh: "Live",
  stale: "Stale",
  unknown: "Unknown",
};

const SOURCE_LABELS: Record<SnapshotSource, string> = {
  native_payload: "Local",
  documented_api: "API",
  internal_payload: "Provider",
  authenticated_page: "Web",
  manual_entry: "Manual",
};

const PRECISION_LABELS: Record<SnapshotPrecision, string> = {
  exact: "exact",
  estimated: "estimated",
  manual: "manual",
};

function windowName(code: string, provider: ProviderCode): string {
  if (provider === "OPENROUTER" && (code === "CREDITS" || code === "BALANCE")) {
    return "Credit spend";
  }
  const known = WINDOW_NAMES[code];
  if (known !== undefined) return known;
  const numbered = code.match(/^(.+)_([2-9][0-9]*)$/u);
  if (numbered !== null) {
    const base = WINDOW_NAMES[numbered[1] ?? ""];
    if (base !== undefined) return base + " " + (numbered[2] ?? "");
  }
  const words = code
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return "Usage window";
  if (provider === "GEMINI_CLI" && words[0] === "gemini") {
    return words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
      .replace(/([0-9]) ([0-9])/gu, "$1.$2");
  }
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

function compareWindows(left: Snapshot, right: Snapshot): number {
  const rank = (WINDOW_RANK[left.meter] ?? 90) - (WINDOW_RANK[right.meter] ?? 90);
  return rank !== 0 ? rank : left.meter.localeCompare(right.meter);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function headroomTone(usedPercent: number): HeadroomTone {
  if (!Number.isFinite(usedPercent)) return "none";
  const remaining = 100 - clampPercent(usedPercent);
  if (remaining <= 10) return "critical";
  if (remaining <= 20) return "high";
  if (remaining <= 40) return "watch";
  return "ok";
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function resetCountdown(resetAt: string | null, now: string): string | null {
  if (resetAt === null) return null;
  const target = Date.parse(resetAt);
  const current = Date.parse(now);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return null;
  const remaining = target - current;
  if (remaining <= 0) return "Reset time passed";
  if (remaining < MINUTE) return "Resets in under a minute";
  if (remaining < HOUR) {
    return "Resets in " + String(Math.floor(remaining / MINUTE)) + "m";
  }
  if (remaining < DAY) {
    const hours = Math.floor(remaining / HOUR);
    const minutes = Math.floor((remaining % HOUR) / MINUTE);
    return "Resets in " + String(hours) + "h " + String(minutes) + "m";
  }
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  return "Resets in " + String(days) + "d " + String(hours) + "h";
}

function sourceLine(snapshot: Snapshot): string {
  const precision = PRECISION_LABELS[snapshot.precision];
  return precision === "exact"
    ? SOURCE_LABELS[snapshot.source]
    : SOURCE_LABELS[snapshot.source] + ", " + precision;
}

function toWindowView(snapshot: Snapshot, now: string): ProviderWindowView {
  const state = freshness(snapshot.observedAt, snapshot.expiresAt, now);
  const label = windowName(snapshot.meter, snapshot.provider);
  const usedPercent = state === "unknown" ? null : clampPercent(snapshot.value);
  const tone = usedPercent === null ? "none" : headroomTone(usedPercent);
  const resetLabel = state === "unknown" ? null : resetCountdown(snapshot.resetAt, now);

  if (usedPercent === null) {
    return {
      key: snapshot.meter,
      label,
      state,
      stateLabel: STATE_LABELS[state],
      tone,
      metricKind: "percent",
      usedPercent,
      readout: "Unknown",
      detail: "No reading",
      resetLabel,
      accessibleLabel: label + ", no reliable reading",
    };
  }

  const used = floorFixed(usedPercent, 1);
  const available = floorFixed(100 - usedPercent, 1);
  const hasMoney =
    snapshot.usedAmount !== undefined &&
    snapshot.limitAmount !== undefined &&
    snapshot.currency !== undefined;
  const unboundedSpend = snapshot.unit === "CREDITS" && !hasMoney;
  const metricKind = hasMoney
    ? "bounded_spend"
    : unboundedSpend
      ? "unbounded_spend"
      : "percent";
  const readout = hasMoney
    ? "$" + floorFixed(snapshot.usedAmount ?? 0, 2)
    : unboundedSpend
      ? floorFixed(snapshot.value, 2) + " credits spent"
      : used + "%";
  const detail = hasMoney
    ? "$" + floorFixed(snapshot.limitAmount ?? 0, 2) + " limit, " + available + "% free"
    : unboundedSpend
      ? "No budget ceiling"
      : available + "% free";
  const reset = resetLabel === null ? "" : ", " + resetLabel.toLowerCase();

  return {
    key: snapshot.meter,
    label,
    state,
    stateLabel: STATE_LABELS[state],
    tone: unboundedSpend ? "none" : tone,
    metricKind,
    usedPercent: unboundedSpend ? null : usedPercent,
    readout,
    detail,
    resetLabel,
    accessibleLabel: label + ", " + readout + ", " + detail + reset,
  };
}

function compareAccountIds(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left.localeCompare(right);
}

function fallbackFor(
  provider: ProviderCode,
): NonNullable<ProviderAccountRowView["fallback"]> {
  if (provider === "MANUAL") {
    return {
      kind: "manual_entry",
      title: "Manual entry",
      detail: "Add a limit in Accounts",
    };
  }
  return {
    kind: "not_found",
    title: "Not connected",
    detail: "Open Accounts",
  };
}

export function buildProviderAccountRows(
  snapshots: readonly Snapshot[],
  now: string,
  failures: readonly ProviderFailure[] = [],
  options: ProviderRowOptions = {},
): readonly ProviderAccountRowView[] {
  const observed = new Set(snapshots.map((snapshot) => snapshot.provider));
  const providers =
    options.providers ?? DEFAULT_PROVIDER_CODES.filter((provider) => observed.has(provider));
  const failureByProvider = new Map(
    dedupeFailures(failures).map((failure) => [
      failure.provider,
      failureSentence[failure.category],
    ]),
  );
  const rows: ProviderAccountRowView[] = [];

  for (const provider of providers) {
    const groups = new Map<string | null, Snapshot[]>();
    for (const snapshot of snapshots) {
      if (snapshot.provider !== provider) continue;
      const accountId = snapshot.accountId ?? null;
      const held = groups.get(accountId);
      if (held === undefined) groups.set(accountId, [snapshot]);
      else held.push(snapshot);
    }

    if (groups.size === 0) {
      const fallback = fallbackFor(provider);
      rows.push({
        key: provider + ":fallback",
        provider,
        providerLabel: PROVIDER_NAMES[provider],
        accountId: null,
        accountLabel: provider === "MANUAL" ? "Local" : "No account",
        showAccountLabel: false,
        sourceLabel: null,
        windows: [],
        fallback,
        failure: failureByProvider.get(provider) ?? null,
        demo: options.demo ?? false,
      });
      continue;
    }

    const accountIds = [...groups.keys()].sort(compareAccountIds);
    for (const accountId of accountIds) {
      const accountSnapshots = [...(groups.get(accountId) ?? [])].sort(compareWindows);
      const lead = accountSnapshots[0];
      rows.push({
        key:
          provider +
          ":account:" +
          (accountId === null ? "absent" : "named:" + accountId),
        provider,
        providerLabel: PROVIDER_NAMES[provider],
        accountId,
        accountLabel: accountId ?? "Local account",
        showAccountLabel: groups.size > 1,
        sourceLabel: lead === undefined ? null : sourceLine(lead),
        windows: accountSnapshots.map((snapshot) => toWindowView(snapshot, now)),
        fallback: null,
        failure: failureByProvider.get(provider) ?? null,
        demo: options.demo ?? false,
      });
    }
  }

  return rows;
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percentLabel(window: ProviderWindowView): string {
  return window.usedPercent === null ? "No data" : floorFixed(window.usedPercent, 1) + "%";
}

export type ProviderMetricColumn = "session" | "week" | "month";

const METRIC_METERS: Readonly<Record<ProviderMetricColumn, ReadonlySet<string>>> = {
  session: new Set(["FIVE_MINUTE", "HOURLY", "FIVE_HOUR", "SESSION"]),
  week: new Set([
    "SEVEN_DAY",
    "SEVEN_DAY_OPUS",
    "SEVEN_DAY_SONNET",
    "WEEKLY"
  ]),
  month: new Set(["THIRTY_DAY", "MONTHLY", "ON_DEMAND_MONTHLY"]),
};

function baseMeterKey(key: string): string {
  return key.replace(/_([2-9][0-9]*)$/u, "");
}

export function closestToLimit(
  windows: readonly ProviderWindowView[],
): ProviderWindowView | null {
  let closest: ProviderWindowView | null = null;
  for (const window of windows) {
    if (closest === null) {
      closest = window;
      continue;
    }
    if (window.usedPercent === null) continue;
    if (closest.usedPercent === null || window.usedPercent > closest.usedPercent) {
      closest = window;
    }
  }
  return closest;
}

export function windowForMetric(
  windows: readonly ProviderWindowView[],
  metric: ProviderMetricColumn,
): ProviderWindowView | null {
  return closestToLimit(
    windows.filter((window) => METRIC_METERS[metric].has(baseMeterKey(window.key))),
  );
}

function meterMarkup(window: ProviderWindowView, className: string): string {
  if (window.metricKind === "unbounded_spend") {
    return '<span class="' + className + ' neutral" aria-label="' +
      escapeText(window.label + ", no budget ceiling") + '"></span>';
  }
  const valueAttributes =
    window.usedPercent === null
      ? 'aria-valuetext="No data"'
      : 'aria-valuenow="' + String(window.usedPercent) + '" aria-valuetext="' +
        escapeText(percentLabel(window) + " used") + '"';
  const fill =
    window.usedPercent === null
      ? ""
      : '<span class="meter-fill" style="width:' + String(window.usedPercent) + '%"></span>';

  return (
    '<span class="' + className + '" role="progressbar" aria-label="' +
    escapeText(window.label) + '" aria-valuemin="0" aria-valuemax="100" ' +
    valueAttributes + ">" + fill + "</span>"
  );
}

function compactResetLabel(resetLabel: string | null): string {
  if (resetLabel === null || resetLabel === "Reset time passed") return "";
  if (resetLabel === "Resets in under a minute") return "under 1m";
  return resetLabel.replace(/^Resets in /u, "");
}

function windowLineMarkup(window: ProviderWindowView): string {
  const reset = compactResetLabel(window.resetLabel);
  return (
    '<div class="window-line" data-tone="' + window.tone + '" data-state="' +
    window.state + '" aria-label="' + escapeText(window.accessibleLabel) + '">' +
    '<span class="window-name" title="' + escapeText(window.label) + '">' +
    escapeText(window.label) + "</span>" + meterMarkup(window, "window-meter") +
    '<strong class="window-percent">' + escapeText(window.readout) + "</strong>" +
    '<span class="window-reset">' + escapeText(reset) + "</span></div>"
  );
}

export function providerTableHeaderMarkup(): string {
  return "";
}

export function providerRowMarkup(row: ProviderAccountRowView): string {
  return (
    '<article class="row" aria-label="' + escapeText(row.providerLabel + ", " + row.accountLabel) + '">' +
    '<header class="identity"><span class="mark" aria-hidden="true">' +
    PROVIDER_MARKS[row.provider] + '</span><strong class="provider-name">' +
    escapeText(row.providerLabel) + "</strong></header>" +
    '<div class="windows">' + row.windows.map(windowLineMarkup).join("") + "</div></article>"
  );
}

const PROVIDER_TABLE_COLUMNS =
  "minmax(10.5rem, 12.5rem) minmax(12rem, 1fr) repeat(3, minmax(3.75rem, 4.5rem)) minmax(5rem, 5.75rem)";

const PROVIDER_ROW_STYLE = `
:host {
  display: block;
  min-width: 0;
  color: var(--ol-heading, var(--heading));
  font-family: var(--ol-font-sans, ui-sans-serif, system-ui, sans-serif);
  --row-surface: var(--ol-surface, var(--surface));
  --row-raised: var(--ol-raised, var(--raised));
  --row-elevated: var(--ol-elevated, var(--raised));
  --row-heading: var(--ol-heading, var(--heading));
  --row-soft: var(--ol-soft, var(--soft));
  --row-muted: var(--ol-muted, var(--muted));
  --row-faint: var(--ol-faint, var(--muted));
  --row-hairline: var(--ol-hairline, var(--hairline));
  --row-hairline-strong: var(--ol-hairline-strong, var(--hairline-strong));
  --row-ok: var(--ol-meter-ok, var(--meter-ok));
  --row-watch: var(--ol-meter-watch, var(--meter-watch));
  --row-high: var(--ol-meter-high, var(--meter-high));
  --row-critical: var(--ol-meter-critical, var(--meter-critical));
  --row-track: var(--ol-meter-empty, var(--meter-empty));
  --row-ghost: var(--ol-meter-ghost, var(--meter-ghost));
  --row-live: var(--ol-live, var(--meter-ok));
  --row-accent: var(--ol-accent, var(--accent));
  --row-accent-subtle: var(--ol-accent-subtle, var(--accent-subtle));
}
* { box-sizing: border-box; }
.row {
  display: grid;
  grid-template-columns: ${PROVIDER_TABLE_COLUMNS};
  min-width: 0;
  min-height: 5.25rem;
  overflow: hidden;
  border: 1px solid var(--row-hairline);
  border-radius: var(--ol-radius-md);
  background: var(--row-surface);
  box-shadow: var(--ol-elev-1);
  transition: border-color var(--ol-motion-fast) var(--ol-ease-out), background-color var(--ol-motion-fast) var(--ol-ease-out), transform var(--ol-motion-base) var(--ol-ease-out);
}
.identity {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: var(--ol-space-2);
  padding: var(--ol-space-3) var(--ol-space-4);
  border-right: 1px solid var(--row-hairline);
}
.identity-main {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ol-space-3);
}
.mark {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  flex: none;
  place-items: center;
  border: 1px solid var(--row-hairline);
  border-radius: var(--ol-radius-sm);
  background: var(--row-raised);
  color: var(--row-heading);
  box-shadow: var(--ol-elev-1);
}
.mark svg { width: 1.125rem; height: 1.125rem; }
:host([data-provider="CLAUDE"]) .mark { color: var(--ol-provider-claude); }
:host([data-provider="OPENROUTER"]) .mark { color: var(--ol-provider-openrouter); }
:host([data-provider="CODEX"]) .mark { color: var(--ol-provider-codex); }
:host([data-provider="ANTIGRAVITY"]) .mark { color: var(--ol-provider-antigravity); }
:host([data-provider="GEMINI_CLI"]) .mark { color: var(--ol-provider-gemini); }
:host([data-provider="OPENCODE"]) .mark { color: var(--ol-provider-opencode); }
:host([data-provider="GROK"]) .mark { color: var(--ol-provider-grok); }
:host([data-provider="KIMI"]) .mark { color: var(--ol-provider-kimi); }
:host([data-provider="MANUAL"]) .mark { color: var(--ol-provider-manual); }
:host([data-provider="CLAUDE"]) .mark svg,
:host([data-provider="MANUAL"]) .mark svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
:host([data-provider="OPENROUTER"]) .mark svg,
:host([data-provider="CODEX"]) .mark svg,
:host([data-provider="OPENCODE"]) .mark svg,
:host([data-provider="GROK"]) .mark svg,
:host([data-provider="KIMI"]) .mark svg { fill: currentColor; }
.provider {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--ol-space-1);
}
.provider-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ol-space-2);
}
.provider strong {
  overflow: hidden;
  color: var(--row-heading);
  font-size: var(--ol-text-label);
  font-weight: var(--ol-weight-bold);
  line-height: var(--ol-leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-value {
  overflow: hidden;
  max-width: 7rem;
  padding: var(--ol-space-1) var(--ol-space-2);
  border: 1px solid var(--row-hairline);
  border-radius: var(--ol-radius-pill);
  background: var(--row-raised);
  color: var(--row-soft);
  font-family: var(--ol-font-mono);
  font-size: var(--ol-text-micro);
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identity-foot {
  display: flex;
  min-height: var(--ol-text-micro);
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ol-space-2);
  padding-left: var(--ol-space-7);
}
.source, .demo { font-size: var(--ol-text-micro); line-height: 1.2; }
.source { color: var(--row-muted); }
.demo {
  padding: var(--ol-space-1) var(--ol-space-2);
  border-radius: var(--ol-radius-pill);
  background: var(--row-accent-subtle);
  color: var(--row-accent);
}
.fallback-state,
.fallback-detail {
  overflow: hidden;
  font-size: var(--ol-text-micro);
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fallback-state { color: var(--row-soft); font-weight: var(--ol-weight-semibold); }
.fallback-state[data-kind="manual_entry"] { color: var(--row-accent); }
.fallback-detail { color: var(--row-muted); }
.failure {
  display: flex;
  margin: 0;
  align-items: flex-start;
  gap: var(--ol-space-1);
  padding-left: var(--ol-space-7);
  color: var(--row-critical);
  font-size: var(--ol-text-micro);
  line-height: var(--ol-leading-body);
}
.usage {
  display: grid;
  min-width: 0;
  align-items: center;
  padding: var(--ol-space-3) var(--ol-space-4);
  border-right: 1px solid var(--row-hairline);
}
.usage-line {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(4rem, 1fr) auto auto;
  align-items: center;
  gap: var(--ol-space-2);
}
.state {
  display: inline-flex;
  width: 0.5rem;
  height: 0.5rem;
  align-self: center;
  color: var(--row-muted);
}
.state-dot {
  width: 100%;
  height: 100%;
  border-radius: var(--ol-radius-pill);
  background: currentColor;
}
.usage[data-state="fresh"] .state { color: var(--row-live); }
.usage[data-state="fresh"] .state-dot {
  animation: olLivePulse 2.4s var(--ol-ease-out) infinite;
}
.usage[data-state="stale"] .state-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1px currentColor;
}
.usage[data-state="unknown"] .state-dot { opacity: 0.45; }
.hero-readout {
  color: var(--row-muted);
  font-family: var(--ol-font-sans, ui-sans-serif, system-ui, sans-serif);
  font-size: var(--ol-text-title);
  font-variant-numeric: tabular-nums;
  font-weight: var(--ol-weight-bold);
  letter-spacing: -0.035em;
  line-height: 1;
  white-space: nowrap;
}
.usage[data-tone="ok"] .hero-readout { color: var(--row-ok); }
.usage[data-tone="watch"] .hero-readout { color: var(--row-watch); }
.usage[data-tone="high"] .hero-readout { color: var(--row-high); }
.usage[data-tone="critical"] .hero-readout { color: var(--row-critical); }
.hero-meter {
  position: relative;
  display: block;
  min-width: 0;
  height: var(--ol-meter-height);
  overflow: hidden;
  border-radius: var(--ol-meter-radius);
  background: var(--row-track);
}
.usage[data-state="unknown"] .hero-meter {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--row-ghost);
}
.meter-fill {
  display: block;
  height: 100%;
  transform-origin: left center;
  border-radius: inherit;
  background: var(--row-ghost);
  animation: olMeterArrive var(--ol-motion-slow) var(--ol-ease-out) both;
  transition: width var(--ol-motion-base) var(--ol-ease-out), background-color var(--ol-motion-fast) var(--ol-ease-out), opacity var(--ol-motion-fast) var(--ol-ease-out);
}
.usage[data-tone="ok"] .meter-fill { background: var(--row-ok); }
.usage[data-tone="watch"] .meter-fill { background: var(--row-watch); }
.usage[data-tone="high"] .meter-fill { background: var(--row-high); }
.usage[data-tone="critical"] .meter-fill { background: var(--row-critical); }
.usage[data-state="stale"] .meter-fill { opacity: 0.58; }
.metric,
.reset {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  padding: var(--ol-space-3) var(--ol-space-2);
  border-right: 1px solid var(--row-hairline);
  color: var(--row-muted);
  font-family: var(--ol-font-sans, ui-sans-serif, system-ui, sans-serif);
  font-size: var(--ol-text-body);
  font-variant-numeric: tabular-nums;
  font-weight: var(--ol-weight-semibold);
  line-height: var(--ol-leading-tight);
  white-space: nowrap;
}
.metric-empty { color: var(--row-faint); font-weight: var(--ol-weight-medium); }
.reset {
  gap: var(--ol-space-1);
  border-right: 0;
  font-size: var(--ol-text-micro);
  font-weight: var(--ol-weight-semibold);
}
.reset-clock {
  position: relative;
  width: 0.6875rem;
  height: 0.6875rem;
  flex: none;
  border: 1px solid currentColor;
  border-radius: var(--ol-radius-pill);
  opacity: 0.72;
}
.reset-clock::before {
  position: absolute;
  top: 0.13rem;
  left: 0.28rem;
  width: 1px;
  height: 0.2rem;
  background: currentColor;
  content: "";
}
.reset-clock::after {
  position: absolute;
  top: 0.32rem;
  left: 0.28rem;
  width: 0.19rem;
  height: 1px;
  background: currentColor;
  content: "";
}
@keyframes olLivePulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--ol-live-soft); }
  50% { box-shadow: 0 0 0 0.25rem transparent; }
}
@keyframes olMeterArrive {
  from { transform: scaleX(0.84); }
  to { transform: scaleX(1); }
}
@media (hover: hover) {
  .row:hover {
    border-color: var(--row-hairline-strong);
    background: var(--row-raised);
  }
}
@media (max-width: 639px) {
  .row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-template-areas:
      "identity identity identity"
      "usage usage reset"
      "session week month";
    min-height: 0;
  }
  .identity {
    grid-area: identity;
    min-height: 4rem;
    padding: var(--ol-space-3);
    border-right: 0;
    border-bottom: 1px solid var(--row-hairline);
  }
  .mark {
    width: 2.25rem;
    height: 2.25rem;
  }
  .identity-foot,
  .failure { padding-left: 3rem; }
  .usage {
    grid-area: usage;
    min-height: 3.75rem;
    padding: var(--ol-space-3);
  }
  .usage-line { grid-template-columns: minmax(3.75rem, 1fr) auto auto; }
  .hero-readout { font-size: var(--ol-text-title); }
  .metric,
  .reset {
    min-height: 2.75rem;
    padding: var(--ol-space-2);
    border-top: 1px solid var(--row-hairline);
  }
  .metric-session { grid-area: session; }
  .metric-week { grid-area: week; }
  .metric-month { grid-area: month; border-right: 0; }
  .reset {
    grid-area: reset;
    min-height: 3.75rem;
    border-top: 0;
  }
}

/* One provider heading, then one compact four item line for every window. */
.row {
  display: block;
  min-height: 0;
  padding: var(--ol-space-4);
  overflow: hidden;
}
.identity {
  display: flex;
  min-height: 0;
  flex-direction: row;
  align-items: center;
  gap: var(--ol-space-2);
  padding: 0;
  border: 0;
}
.mark {
  width: 1.75rem;
  height: 1.75rem;
  border: 0;
  border-radius: var(--ol-radius-sm);
  background: var(--row-raised);
  box-shadow: none;
}
.mark svg { width: 0.9375rem; height: 0.9375rem; }
.provider-name {
  min-width: 0;
  overflow: hidden;
  color: var(--row-heading);
  font-size: var(--ol-text-label);
  font-weight: var(--ol-weight-bold);
  line-height: var(--ol-leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.windows {
  display: grid;
  gap: var(--ol-space-3);
  margin-top: var(--ol-space-4);
}
.window-line {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(7rem, 0.85fr) minmax(8rem, 1.8fr) 4.5rem 5rem;
  align-items: center;
  gap: var(--ol-space-3);
}
.window-name,
.window-reset,
.window-percent {
  min-width: 0;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  line-height: var(--ol-leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.window-name {
  color: var(--row-soft);
  font-size: var(--ol-text-body);
}
.window-meter {
  position: relative;
  display: block;
  min-width: 0;
  height: var(--ol-meter-height);
  overflow: hidden;
  border-radius: var(--ol-meter-radius);
  background: var(--row-track);
}
.window-line[data-state="unknown"] .window-meter {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--row-ghost);
}
.window-line[data-tone="ok"] .meter-fill { background: var(--row-ok); }
.window-line[data-tone="watch"] .meter-fill { background: var(--row-watch); }
.window-line[data-tone="high"] .meter-fill { background: var(--row-high); }
.window-line[data-tone="critical"] .meter-fill { background: var(--row-critical); }
.window-meter.neutral {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--row-hairline-strong);
}
.window-line[data-state="stale"] .meter-fill { opacity: 0.58; }
.window-percent {
  color: var(--row-accent);
  font-size: var(--ol-text-body);
  font-weight: var(--ol-weight-bold);
  text-align: right;
}
.window-line[data-tone="ok"] .window-percent { color: var(--row-ok); }
.window-line[data-tone="watch"] .window-percent { color: var(--row-watch); }
.window-line[data-tone="high"] .window-percent { color: var(--row-high); }
.window-line[data-tone="critical"] .window-percent { color: var(--row-critical); }
.window-line[data-tone="none"] .window-percent { color: var(--row-soft); }
.window-reset {
  min-height: 1em;
  color: var(--row-muted);
  font-size: var(--ol-text-micro);
  text-align: right;
}
@media (max-width: 639px) {
  .row { padding: var(--ol-space-3); }
  .identity {
    min-height: 0;
    padding: 0;
    border: 0;
  }
  .windows {
    gap: var(--ol-space-2);
    margin-top: var(--ol-space-3);
  }
  .window-line {
    grid-template-columns: minmax(4.8rem, 0.9fr) minmax(4.5rem, 1.25fr) 3.35rem 3.5rem;
    gap: var(--ol-space-2);
  }
  .window-name,
  .window-percent { font-size: var(--ol-text-micro); }
  .window-reset { font-size: var(--ol-text-micro); }
}
@media (prefers-reduced-motion: reduce) {
  .meter-fill,
  .usage[data-state="fresh"] .state-dot { animation: none; }
}
`;

const PROVIDER_TABLE_HEADER_STYLE = `
:host {
  display: block;
  min-width: 0;
  color: var(--ol-muted, var(--muted));
  font-family: var(--ol-font-sans, ui-sans-serif, system-ui, sans-serif);
}
* { box-sizing: border-box; }
.table-head {
  display: grid;
  min-width: 0;
  grid-template-columns: ${PROVIDER_TABLE_COLUMNS};
  align-items: center;
  color: var(--ol-muted, var(--muted));
  font-size: var(--ol-text-micro);
  font-weight: var(--ol-weight-bold);
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
}
.table-head > span { min-width: 0; }
.head-usage { padding: 0 var(--ol-space-4); }
.head-session,
.head-week,
.head-month,
.head-resets { text-align: center; }
@media (max-width: 639px) {
  .table-head {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-template-areas:
      "usage usage resets"
      "session week month";
    row-gap: var(--ol-space-3);
    padding-top: var(--ol-space-1);
  }
  .head-provider { display: none; }
  .head-usage { grid-area: usage; padding-left: var(--ol-space-3); }
  .head-session { grid-area: session; }
  .head-week { grid-area: week; }
  .head-month { grid-area: month; }
  .head-resets { grid-area: resets; text-align: center; }
}
`;

export const PROVIDER_TABLE_HEADER_TAG = "openlimiter-provider-table-header";

export function defineProviderTableHeaderElement(): void {
  if (typeof globalThis.customElements === "undefined") return;
  if (globalThis.customElements.get(PROVIDER_TABLE_HEADER_TAG) !== undefined) return;
  const BaseElement = globalThis.HTMLElement;
  if (typeof BaseElement === "undefined") return;

  class OpenLimiterProviderTableHeader extends BaseElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML =
        "<style>" + PROVIDER_TABLE_HEADER_STYLE + "</style>" + providerTableHeaderMarkup();
    }
  }

  globalThis.customElements.define(PROVIDER_TABLE_HEADER_TAG, OpenLimiterProviderTableHeader);
}

export function createProviderTableHeaderElement(ownerDocument?: Document): HTMLElement {
  defineProviderTableHeaderElement();
  const documentRef = ownerDocument ?? globalThis.document;
  if (documentRef === undefined) {
    throw new Error("A document is required to create a provider table header.");
  }
  return documentRef.createElement(PROVIDER_TABLE_HEADER_TAG);
}

export const PROVIDER_ROW_TAG = "openlimiter-provider-row";

interface ProviderRowHost extends HTMLElement {
  rowData: ProviderAccountRowView;
}

export function defineProviderRowElement(): void {
  if (typeof globalThis.customElements === "undefined") return;
  if (globalThis.customElements.get(PROVIDER_ROW_TAG) !== undefined) return;
  const BaseElement = globalThis.HTMLElement;
  if (typeof BaseElement === "undefined") return;

  class OpenLimiterProviderRow extends BaseElement implements ProviderRowHost {
    readonly #root: ShadowRoot;
    #rowData: ProviderAccountRowView | null = null;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: "open" });
    }

    set rowData(value: ProviderAccountRowView) {
      this.#rowData = value;
      this.dataset["provider"] = value.provider;
      if (value.accountId === null) delete this.dataset["account"];
      else this.dataset["account"] = value.accountId;
      this.#render();
    }

    get rowData(): ProviderAccountRowView {
      if (this.#rowData === null) {
        throw new Error("Provider row data has not been assigned.");
      }
      return this.#rowData;
    }

    #render(): void {
      if (this.#rowData === null) return;
      this.#root.innerHTML =
        "<style>" + PROVIDER_ROW_STYLE + "</style>" + providerRowMarkup(this.#rowData);
    }
  }

  globalThis.customElements.define(PROVIDER_ROW_TAG, OpenLimiterProviderRow);
}

export function setProviderRowData(
  element: HTMLElement,
  row: ProviderAccountRowView,
): void {
  defineProviderRowElement();
  (element as ProviderRowHost).rowData = row;
}

export function createProviderRowElement(
  row: ProviderAccountRowView,
  ownerDocument?: Document,
): HTMLElement {
  defineProviderRowElement();
  const documentRef = ownerDocument ?? globalThis.document;
  if (documentRef === undefined) {
    throw new Error("A document is required to create a provider row.");
  }
  const element = documentRef.createElement(PROVIDER_ROW_TAG);
  setProviderRowData(element, row);
  return element;
}
