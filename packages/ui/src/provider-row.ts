import {
  PROVIDER_CODES,
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

export type HeadroomTone = "ok" | "watch" | "high" | "critical" | "none";

export interface ProviderWindowView {
  key: string;
  label: string;
  state: SnapshotState;
  stateLabel: string;
  tone: HeadroomTone;
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
  OPENCODE: "OpenCode",
  GROK: "Grok",
  KIMI: "Kimi",
  MANUAL: "Manual",
};

const PROVIDER_MARKS: Record<ProviderCode, string> = {
  CLAUDE:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1M7.8 3.1l8.4 17.8M20.9 7.8 3.1 16.2M16.2 3.1 7.8 20.9M3.1 7.8l17.8 8.4"/></svg>',
  OPENROUTER:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.778 1.844v1.919c-3.16-.14-5.68.42-8.702 2.242-2.911 2.066-2.731 1.95-4.14 2.75-.792.447-3.934 1.131-3.936 1.131v4.229s3.003.555 3.795 1.132c1.41.798 1.228.683 4.14 2.75 3.02 1.821 5.68 2.382 8.703 2.21v1.919l7.222-4.168-7.222-4.17v2.176c-2.231.1-3.645-.075-6.257-1.444-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 2.61-1.37 4.025-1.545 6.255-1.446v2.176L24 6.014Z"/></svg>',
  CODEX:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.096 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.514 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.989 5.989 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073Zm-9.022 12.608a4.476 4.476 0 0 1-2.877-1.041l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.682v-6.736l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494Zm-9.661-4.125a4.471 4.471 0 0 1-.534-3.014l.142.085 4.783 2.758a.771.771 0 0 0 .78 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.499 4.499 0 0 1-6.141-1.646ZM2.341 7.896a4.485 4.485 0 0 1 2.365-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787a4.504 4.504 0 0 1-1.647-6.141Zm16.596 3.855-5.833-3.387 2.015-1.164a.076.076 0 0 1 .071 0l4.831 2.791a4.494 4.494 0 0 1-.677 8.104v-5.677a.79.79 0 0 0-.407-.667Zm2.011-3.023-.142-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.831-2.787a4.499 4.499 0 0 1 6.68 4.66ZM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.056V6.074a4.499 4.499 0 0 1 7.375-3.454l-.142.081-4.778 2.758a.795.795 0 0 0-.393.681Zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"/></svg>',
  ANTIGRAVITY:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053Z"/></svg>',
  OPENCODE:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 24H2V0h20Zm-5-19.2H7v14.4h10Z"/></svg>',
  GROK:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 4l16 16M20 4 4 20M8 12h8"/></svg>',
  KIMI:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M18.5 17.5A8 8 0 1 1 14 4.8a6.5 6.5 0 0 0 4.5 12.7Z"/></svg>',
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

function windowName(code: string): string {
  const known = WINDOW_NAMES[code];
  if (known !== undefined) return known;
  const words = code
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return "Usage window";
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
  const label = windowName(snapshot.meter);
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
  const readout = hasMoney
    ? "$" + floorFixed(snapshot.usedAmount ?? 0, 2)
    : used + "%";
  const detail = hasMoney
    ? "$" + floorFixed(snapshot.limitAmount ?? 0, 2) + " limit, " + available + "% free"
    : available + "% free";
  const reset = resetLabel === null ? "" : ", " + resetLabel.toLowerCase();

  return {
    key: snapshot.meter,
    label,
    state,
    stateLabel: STATE_LABELS[state],
    tone,
    usedPercent,
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
    title: "Not found",
    detail: "Connect in Accounts",
  };
}

export function buildProviderAccountRows(
  snapshots: readonly Snapshot[],
  now: string,
  failures: readonly ProviderFailure[] = [],
  options: ProviderRowOptions = {},
): readonly ProviderAccountRowView[] {
  const providers = options.providers ?? PROVIDER_CODES;
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

function windowMarkup(window: ProviderWindowView): string {
  const valueAttributes =
    window.usedPercent === null
      ? 'aria-valuetext="Unknown"'
      : 'aria-valuenow="' + String(window.usedPercent) + '" aria-valuetext="' +
        escapeText(window.readout + ", " + window.detail) + '"';
  const fill =
    window.usedPercent === null
      ? ""
      : '<span class="bar-fill" style="width:' + String(window.usedPercent) + '%"></span>';
  const reset =
    window.resetLabel === null
      ? ""
      : '<span class="reset"><span class="reset-clock" aria-hidden="true"></span>' +
        escapeText(window.resetLabel) + "</span>";

  return (
    '<section class="window" data-tone="' + window.tone + '" data-state="' +
    window.state + '" aria-label="' + escapeText(window.accessibleLabel) + '">' +
    '<div class="window-head"><span class="window-label">' + escapeText(window.label) +
    '</span><span class="state"><span class="state-dot" aria-hidden="true"></span>' +
    escapeText(window.stateLabel) + "</span></div>" +
    '<div class="metric-line"><strong class="readout">' + escapeText(window.readout) +
    '</strong>' + reset + "</div>" +
    '<div class="bar" role="progressbar" aria-label="' + escapeText(window.label) +
    '" aria-valuemin="0" aria-valuemax="100" ' + valueAttributes + ">" + fill + "</div>" +
    '<div class="window-foot">' + escapeText(window.detail) + "</div></section>"
  );
}

export function providerRowMarkup(row: ProviderAccountRowView): string {
  const demo = row.demo ? '<span class="demo">Demo data</span>' : "";
  const source =
    row.sourceLabel === null
      ? ""
      : '<span class="source">' + escapeText(row.sourceLabel) + "</span>";
  const failure =
    row.failure === null
      ? ""
      : '<p class="failure" role="status"><span aria-hidden="true">!</span>' +
        escapeText(row.failure) + "</p>";
  const content =
    row.fallback === null
      ? '<div class="windows" role="group" aria-label="Usage windows" tabindex="0">' +
        row.windows.map(windowMarkup).join("") + "</div>"
      : '<div class="fallback" data-kind="' + row.fallback.kind + '"><strong>' +
        escapeText(row.fallback.title) + "</strong><span>" +
        escapeText(row.fallback.detail) + "</span></div>";

  return (
    '<article class="row" aria-label="' + escapeText(row.providerLabel + ", " + row.accountLabel) + '">' +
    '<header class="identity"><div class="identity-main"><span class="mark" aria-hidden="true">' +
    PROVIDER_MARKS[row.provider] + '</span><div class="provider"><div class="provider-line"><strong>' +
    escapeText(row.providerLabel) + '</strong><span class="account-value">' +
    escapeText(row.accountLabel) + '</span></div><span class="provider-code">' + row.provider +
    '</span></div></div><div class="identity-foot">' + demo + source +
    "</div>" + failure + "</header>" + content + "</article>"
  );
}

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
  grid-template-columns: minmax(13.5rem, 15.5rem) minmax(0, 1fr);
  min-width: 0;
  min-height: var(--ol-row-min-height);
  border-bottom: 1px solid var(--row-hairline);
  background: var(--row-surface);
  transition: background-color var(--ol-motion-fast) var(--ol-ease-out);
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
  width: 2rem;
  height: 2rem;
  flex: none;
  place-items: center;
  border: 1px solid var(--row-hairline);
  border-radius: var(--ol-radius-sm);
  background: var(--row-raised);
  color: var(--row-soft);
  box-shadow: var(--ol-elev-1);
}
.mark svg { width: 1rem; height: 1rem; }
:host([data-provider="CLAUDE"]) .mark { color: var(--ol-provider-claude); }
:host([data-provider="OPENROUTER"]) .mark { color: var(--ol-provider-openrouter); }
:host([data-provider="CODEX"]) .mark { color: var(--ol-provider-codex); }
:host([data-provider="ANTIGRAVITY"]) .mark { color: var(--ol-provider-antigravity); }
:host([data-provider="OPENCODE"]) .mark { color: var(--ol-provider-opencode); }
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
:host([data-provider="ANTIGRAVITY"]) .mark svg,
:host([data-provider="OPENCODE"]) .mark svg { fill: currentColor; }
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
  font-weight: 650;
  line-height: var(--ol-leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-code {
  color: var(--row-faint);
  font-family: var(--ol-font-mono);
  font-size: var(--ol-text-micro);
  letter-spacing: 0.07em;
  line-height: 1;
}
.account-value {
  overflow: hidden;
  max-width: 7rem;
  padding: 0.125rem var(--ol-space-1);
  border: 1px solid var(--row-hairline);
  border-radius: var(--ol-radius-xs);
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
  min-height: 0.75rem;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ol-space-2);
  padding-left: 2.75rem;
}
.source, .demo { font-size: var(--ol-text-micro); line-height: 1.2; }
.source { color: var(--row-muted); }
.demo {
  padding: 0.125rem var(--ol-space-1);
  border-radius: var(--ol-radius-pill);
  background: var(--row-accent-subtle);
  color: var(--row-accent);
}
.failure {
  display: flex;
  margin: 0;
  align-items: flex-start;
  gap: var(--ol-space-1);
  padding-left: 2.75rem;
  color: var(--row-critical);
  font-size: var(--ol-text-micro);
  line-height: var(--ol-leading-body);
}
.windows {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(auto-fit, minmax(10.25rem, 1fr));
}
.windows:focus-visible { outline: 2px solid var(--row-accent); outline-offset: -2px; }
.window {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: var(--ol-space-2);
  padding: var(--ol-space-3) var(--ol-space-4);
  border-left: 1px solid var(--row-hairline);
}
.window-head {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--ol-space-2);
}
.window-label {
  overflow: hidden;
  color: var(--row-soft);
  font-size: var(--ol-text-micro);
  font-weight: 650;
  letter-spacing: 0.055em;
  line-height: 1.1;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.state {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--ol-space-1);
  color: var(--row-muted);
  font-size: var(--ol-text-micro);
  line-height: 1;
}
.state-dot {
  width: 0.375rem;
  height: 0.375rem;
  border-radius: var(--ol-radius-pill);
  background: currentColor;
}
.window[data-state="fresh"] .state { color: var(--row-live); }
.window[data-state="fresh"] .state-dot {
  animation: olLivePulse 2.4s var(--ol-ease-out) infinite;
}
.window[data-state="stale"] .state-dot { background: transparent; box-shadow: inset 0 0 0 1px currentColor; }
.window[data-state="unknown"] .state-dot { opacity: 0.45; }
.metric-line {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ol-space-2);
}
.readout {
  color: var(--row-muted);
  font-family: var(--ol-font-mono);
  font-size: var(--ol-text-title);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1;
}
.window[data-tone="ok"] .readout { color: var(--row-ok); }
.window[data-tone="watch"] .readout { color: var(--row-watch); }
.window[data-tone="high"] .readout { color: var(--row-high); }
.window[data-tone="critical"] .readout { color: var(--row-critical); }
.reset {
  display: inline-flex;
  overflow: hidden;
  min-width: 0;
  align-items: center;
  gap: var(--ol-space-1);
  color: var(--row-muted);
  font-family: var(--ol-font-mono);
  font-size: var(--ol-text-micro);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reset-clock {
  position: relative;
  width: 0.625rem;
  height: 0.625rem;
  flex: none;
  border: 1px solid currentColor;
  border-radius: var(--ol-radius-pill);
  opacity: 0.72;
}
.reset-clock::before {
  position: absolute;
  top: 0.12rem;
  left: 0.25rem;
  width: 1px;
  height: 0.19rem;
  background: currentColor;
  content: "";
}
.reset-clock::after {
  position: absolute;
  top: 0.29rem;
  left: 0.25rem;
  width: 0.18rem;
  height: 1px;
  background: currentColor;
  content: "";
}
.bar {
  position: relative;
  height: var(--ol-meter-height);
  overflow: hidden;
  border-radius: var(--ol-meter-radius);
  background: var(--row-track);
}
.window[data-state="unknown"] .bar { background: transparent; box-shadow: inset 0 0 0 1px var(--row-ghost); }
.bar-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--row-ghost);
  transition: width var(--ol-motion-base) var(--ol-ease-out), background-color var(--ol-motion-fast) var(--ol-ease-out);
}
.window[data-tone="ok"] .bar-fill { background: var(--row-ok); }
.window[data-tone="watch"] .bar-fill { background: var(--row-watch); }
.window[data-tone="high"] .bar-fill { background: var(--row-high); }
.window[data-tone="critical"] .bar-fill { background: var(--row-critical); }
.window[data-state="stale"] .bar-fill { opacity: 0.58; }
.window-foot {
  overflow: hidden;
  min-width: 0;
  color: var(--row-muted);
  font-size: var(--ol-text-micro);
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fallback {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ol-space-3);
  padding: var(--ol-space-3) var(--ol-space-4);
}
.fallback strong {
  flex: none;
  color: var(--row-critical);
  font-size: var(--ol-text-body);
  font-weight: 650;
}
.fallback span {
  overflow: hidden;
  color: var(--row-muted);
  font-size: var(--ol-text-caption);
  line-height: var(--ol-leading-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fallback[data-kind="manual_entry"] strong { color: var(--row-accent); }
@keyframes olLivePulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--ol-live-soft); }
  50% { box-shadow: 0 0 0 0.25rem transparent; }
}
@media (hover: hover) {
  .row:hover { background: var(--row-raised); }
}
@media (max-width: 639px) {
  .row { display: block; }
  .identity {
    min-height: 4rem;
    border-right: 0;
    border-bottom: 1px solid var(--row-hairline);
  }
  .windows {
    grid-template-columns: none;
    grid-auto-columns: min(72vw, var(--ol-window-mobile-width));
    grid-auto-flow: column;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scroll-snap-type: inline proximity;
    scrollbar-width: thin;
  }
  .window { border-left: 1px solid var(--row-hairline); scroll-snap-align: start; }
  .window:first-child { border-left: 0; }
  .fallback { min-height: 4rem; }
}
@media (prefers-reduced-motion: reduce) {
  .windows { scroll-behavior: auto; }
  .window[data-state="fresh"] .state-dot { animation: none; }
}
`;

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
