/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
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
} from "../core";
import { PROVIDER_RECOGNITION_ORDER } from "./provider-connect";

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
  GROK: "Grok Build",
  KIMI: "Kimi",
  MANUAL: "Manual",
};

const PROVIDER_CODE_BY_SPEC_ID: Readonly<
  Record<string, ProviderCode | undefined>
> = {
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

const DEFAULT_PROVIDER_CODES: readonly ProviderCode[] =
  PROVIDER_RECOGNITION_ORDER.flatMap((specId) => {
    const provider = PROVIDER_CODE_BY_SPEC_ID[specId];
    return provider === undefined ? [] : [provider];
  });

const PROVIDER_MARKS: Record<ProviderCode, string> = {
  CLAUDE:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  OPENROUTER:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.778 1.844v1.919c-3.16-.14-5.68.42-8.702 2.242-2.911 2.066-2.731 1.95-4.14 2.75-.792.447-3.934 1.131-3.936 1.131v4.229s3.003.555 3.795 1.132c1.41.798 1.228.683 4.14 2.75 3.02 1.821 5.68 2.382 8.703 2.21v1.919l7.222-4.168-7.222-4.17v2.176c-2.231.1-3.645-.075-6.257-1.444-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 2.61-1.37 4.025-1.545 6.255-1.446v2.176L24 6.014Z"/></svg>',
  CODEX:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.096 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.514 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.989 5.989 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073Zm-9.022 12.608a4.476 4.476 0 0 1-2.877-1.041l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.682v-6.736l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494Zm-9.661-4.125a4.471 4.471 0 0 1-.534-3.014l.142.085 4.783 2.758a.771.771 0 0 0 .78 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.499 4.499 0 0 1-6.141-1.646ZM2.341 7.896a4.485 4.485 0 0 1 2.365-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787a4.504 4.504 0 0 1-1.647-6.141Zm16.596 3.855-5.833-3.387 2.015-1.164a.076.076 0 0 1 .071 0l4.831 2.791a4.494 4.494 0 0 1-.677 8.104v-5.677a.79.79 0 0 0-.407-.667Zm2.011-3.023-.142-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.831-2.787a4.499 4.499 0 0 1 6.68 4.66ZM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.056V6.074a4.499 4.499 0 0 1 7.375-3.454l-.142.081-4.778 2.758a.795.795 0 0 0-.393.681Zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"/></svg>',
  ANTIGRAVITY:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ol-antigravity-gradient" x1="12" y1="1.8" x2="12" y2="22.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--ol-provider-google-red, #ea4335)"/><stop offset=".34" stop-color="var(--ol-provider-google-yellow, #fbbc04)"/><stop offset=".66" stop-color="var(--ol-provider-google-green, #34a853)"/><stop offset="1" stop-color="var(--ol-provider-google-blue, #4285f4)"/></linearGradient></defs><path d="M12 1.8C14.8 1.8 17.1 7.8 19.6 14.2C20.5 16.5 21.4 19 21.4 20.2C21.4 21.8 19.8 22.4 17.8 20.6C16.3 16.8 14.1 12.5 12 12.5C9.9 12.5 7.7 16.8 6.2 20.6C4.2 22.4 2.6 21.8 2.6 20.2C2.6 19 3.5 16.5 4.4 14.2C6.9 7.8 9.2 1.8 12 1.8Z" fill="url(#ol-antigravity-gradient)"/></svg>',
  GEMINI_CLI:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ol-gemini-gradient" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--ol-provider-gemini-blue, #4e82ee)"/><stop offset=".52" stop-color="var(--ol-provider-gemini-purple, #8e75b2)"/><stop offset="1" stop-color="var(--ol-provider-gemini-coral, #d96570)"/></linearGradient></defs><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="url(#ol-gemini-gradient)"/></svg>',
  OPENCODE:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 24H2V0h20Zm-5-19.2H7v14.4h10Z"/></svg>',
  GROK: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>',
  KIMI: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441"/></svg>',
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
  SEVEN_DAY_OAUTH_APPS: "Weekly OAuth apps",
  EXTRA_USAGE: "Extra usage",
  WEEKLY: "Weekly",
  THIRTY_DAY: "Monthly",
  MONTHLY: "Monthly",
  ON_DEMAND_MONTHLY: "On demand monthly",
  CREDITS: "Credits",
  BALANCE: "Credits",
  HARD_LIMIT: "Hard limit",
  LIMIT: "Hard limit",
};

/**
 * Where a model specific weekly bucket sorts.
 *
 * Right after the week it belongs to, and before the month, so the weekly group
 * reads as one block whatever models an account happens to have. Explicit ranks
 * above still win, which is what keeps Opus ahead of Sonnet.
 */
const MODEL_WEEKLY_RANK = 45;

/** The prefix Claude builds every model specific weekly code on. */
const MODEL_WEEKLY_PREFIX = "SEVEN_DAY_";

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
  SEVEN_DAY_OAUTH_APPS: 43,
  WEEKLY: 40,
  THIRTY_DAY: 50,
  MONTHLY: 50,
  ON_DEMAND_MONTHLY: 51,
  EXTRA_USAGE: 52,
  CREDITS: 60,
  BALANCE: 60,
  HARD_LIMIT: 70,
  LIMIT: 70,
};

/**
 * The five bands, as the eye reads them.
 *
 * `tone` answers how much headroom is left and `state` answers whether the
 * reading can be trusted at all. A stale reading has no band, whatever its
 * last number was, so distrust wins over pressure here and the meter is drawn
 * hatched rather than coloured. Colour alone never carries the answer: every
 * band ships a shape beside the percentage, which is what keeps the meter
 * legible in greyscale and to a person who does not separate red from green.
 */
export type QuotaBand = "green" | "yellow" | "orange" | "red" | "stale";

const BAND_ICONS: Record<QuotaBand, string> = {
  /* Checkmark shield: normal headroom. */
  green:
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.2 2.9 3v4.3c0 3 2.1 5.8 5.1 6.6 3-.8 5.1-3.6 5.1-6.6V3Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m5.8 7.9 1.6 1.7 3-3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* Warning triangle: the watch threshold. */
  yellow:
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2.2 14 13H2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.4v3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".85" fill="currentColor"/></svg>',
  /* Alert diamond: high utilisation. */
  orange:
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.6 14.4 8 8 14.4 1.6 8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 4.9v3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="10.7" r=".85" fill="currentColor"/></svg>',
  /* Octagon exclamation: critical depletion. */
  red: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.5 1.4h5l3.6 3.6v5l-3.6 3.6h-5L1.9 10v-5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 4.6v3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="10.8" r=".85" fill="currentColor"/></svg>',
  /* Disconnected circle: stale, unknown, or logged out. */
  stale:
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.7 3.7l8.6 8.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

/**
 * The artwork and the band shape, for a surface that is not this row.
 *
 * The tray popover draws its own compact rows at 360 pixels, where this row's
 * grid does not fit. It still has to be the same product, so it reaches for
 * the same drawings here rather than keeping a second copy that slowly
 * becomes a second opinion about what Claude's mark looks like.
 */
export function providerMarkMarkup(provider: ProviderCode): string {
  return PROVIDER_MARKS[provider];
}

export function bandIconSvg(band: QuotaBand): string {
  return BAND_ICONS[band];
}

/** The band for a used percentage that is known to be fresh. */
export function bandForPercent(usedPercent: number): QuotaBand {
  return BAND_BY_TONE[headroomTone(usedPercent)] ?? "stale";
}

const BAND_BY_TONE: Readonly<Record<HeadroomTone, QuotaBand | null>> = {
  ok: "green",
  watch: "yellow",
  high: "orange",
  critical: "red",
  none: null,
};

/** The band a drawn window belongs to, or null when there is nothing to band. */
export function windowBand(window: ProviderWindowView): QuotaBand | null {
  if (window.state !== "fresh") return "stale";
  return BAND_BY_TONE[window.tone];
}

function bandIconMarkup(window: ProviderWindowView): string {
  const band = windowBand(window);
  if (band === null) return "";
  return '<span class="band-icon" aria-hidden="true">' + BAND_ICONS[band] + "</span>";
}

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

/**
 * A model specific weekly bucket, in words.
 *
 * Claude states one weekly pool per model, and those codes are built from names
 * the provider chose, so this build cannot hold a label for each one and must
 * not shout the code at a person instead. The cadence stays in front, where the
 * eye reads it, and the model follows in brackets: SEVEN_DAY_FABLE_5 reads as
 * "Weekly (Fable 5)". An explicit label always wins, because "Weekly Opus" was
 * already shipped and reads better than the generated form.
 */
function modelWeeklyName(code: string): string | null {
  if (!code.startsWith(MODEL_WEEKLY_PREFIX)) return null;
  const words = code
    .slice(MODEL_WEEKLY_PREFIX.length)
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return null;
  const model = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return "Weekly (" + model + ")";
}

function windowName(code: string, provider: ProviderCode): string {
  if (provider === "OPENROUTER" && (code === "CREDITS" || code === "BALANCE")) {
    return "Credit spend";
  }
  const known = WINDOW_NAMES[code];
  if (known !== undefined) return known;
  const modelWeekly = modelWeeklyName(code);
  if (modelWeekly !== null) return modelWeekly;
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
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
    )
    .join(" ");
}

export function windowRank(code: string): number {
  const known = WINDOW_RANK[code];
  if (known !== undefined) return known;
  return code.startsWith(MODEL_WEEKLY_PREFIX) ? MODEL_WEEKLY_RANK : 90;
}

function compareWindows(left: Snapshot, right: Snapshot): number {
  const rank = windowRank(left.meter) - windowRank(right.meter);
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

export function resetCountdown(
  resetAt: string | null,
  now: string
): string | null {
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
  const resetLabel =
    state === "unknown" ? null : resetCountdown(snapshot.resetAt, now);

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
    ? "$" +
      floorFixed(snapshot.limitAmount ?? 0, 2) +
      " limit, " +
      available +
      "% free"
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
  provider: ProviderCode
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
  options: ProviderRowOptions = {}
): readonly ProviderAccountRowView[] {
  const observed = new Set(snapshots.map((snapshot) => snapshot.provider));
  const providers =
    options.providers ??
    DEFAULT_PROVIDER_CODES.filter((provider) => observed.has(provider));
  const failureByProvider = new Map(
    dedupeFailures(failures).map((failure) => [
      failure.provider,
      failureSentence[failure.category],
    ])
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
      const accountSnapshots = [...(groups.get(accountId) ?? [])].sort(
        compareWindows
      );
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
        windows: accountSnapshots.map((snapshot) =>
          toWindowView(snapshot, now)
        ),
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
  return window.usedPercent === null
    ? "No data"
    : floorFixed(window.usedPercent, 1) + "%";
}

export type ProviderMetricColumn = "session" | "week" | "month";

const METRIC_METERS: Readonly<
  Record<ProviderMetricColumn, ReadonlySet<string>>
> = {
  session: new Set(["FIVE_MINUTE", "HOURLY", "FIVE_HOUR", "SESSION"]),
  week: new Set(["SEVEN_DAY", "SEVEN_DAY_OPUS", "SEVEN_DAY_SONNET", "WEEKLY"]),
  month: new Set(["THIRTY_DAY", "MONTHLY", "ON_DEMAND_MONTHLY"]),
};

function baseMeterKey(key: string): string {
  return key.replace(/_([2-9][0-9]*)$/u, "");
}

export function closestToLimit(
  windows: readonly ProviderWindowView[]
): ProviderWindowView | null {
  let closest: ProviderWindowView | null = null;
  for (const window of windows) {
    if (closest === null) {
      closest = window;
      continue;
    }
    if (window.usedPercent === null) continue;
    if (
      closest.usedPercent === null ||
      window.usedPercent > closest.usedPercent
    ) {
      closest = window;
    }
  }
  return closest;
}

export function windowForMetric(
  windows: readonly ProviderWindowView[],
  metric: ProviderMetricColumn
): ProviderWindowView | null {
  return closestToLimit(
    windows.filter((window) =>
      METRIC_METERS[metric].has(baseMeterKey(window.key))
    )
  );
}

function meterMarkup(window: ProviderWindowView, className: string): string {
  if (window.metricKind === "unbounded_spend") {
    return (
      '<span class="' +
      className +
      ' neutral" aria-label="' +
      escapeText(window.label + ", no budget ceiling") +
      '"></span>'
    );
  }
  const valueAttributes =
    window.usedPercent === null
      ? 'aria-valuetext="No data"'
      : 'aria-valuenow="' +
        String(window.usedPercent) +
        '" aria-valuetext="' +
        escapeText(percentLabel(window) + " used") +
        '"';
  const fill =
    window.usedPercent === null
      ? ""
      : '<span class="meter-fill" style="width:' +
        String(window.usedPercent) +
        '%"></span>';

  return (
    '<span class="' +
    className +
    '" role="progressbar" aria-label="' +
    escapeText(window.label) +
    '" aria-valuemin="0" aria-valuemax="100" ' +
    valueAttributes +
    ">" +
    fill +
    "</span>"
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
    '<div class="window-line" data-tone="' +
    window.tone +
    '" data-state="' +
    window.state +
    '" data-band="' +
    (windowBand(window) ?? "none") +
    '" aria-label="' +
    escapeText(window.accessibleLabel) +
    '">' +
    '<span class="window-name" title="' +
    escapeText(window.label) +
    '">' +
    escapeText(window.label) +
    "</span>" +
    meterMarkup(window, "window-meter") +
    '<span class="window-readout">' +
    bandIconMarkup(window) +
    '<strong class="window-percent">' +
    escapeText(window.readout) +
    "</strong></span>" +
    '<span class="window-reset">' +
    escapeText(reset) +
    "</span></div>"
  );
}

export function providerTableHeaderMarkup(): string {
  return "";
}

export function providerRowMarkup(row: ProviderAccountRowView): string {
  return (
    '<article class="row" aria-label="' +
    escapeText(row.providerLabel + ", " + row.accountLabel) +
    '">' +
    '<header class="identity"><span class="identity-name">' +
    '<span class="mark" aria-hidden="true">' +
    PROVIDER_MARKS[row.provider] +
    '</span><strong class="provider-name">' +
    escapeText(row.providerLabel) +
    "</strong>" +
    (row.showAccountLabel
      ? '<span class="account-label">' + escapeText(row.accountLabel) + "</span>"
      : "") +
    "</span>" +
    /* Two column headings, over the two columns they name. They are what
       turns a stack of lines into a table a person can read down. */
    '<span class="column-label">Used</span>' +
    '<span class="column-label">Resets in</span>' +
    "</header>" +
    '<div class="windows">' +
    row.windows.map(windowLineMarkup).join("") +
    "</div></article>"
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
  --row-ok: var(--ol-band-green-fill, var(--ol-meter-ok, var(--meter-ok)));
  --row-watch: var(--ol-band-yellow-fill, var(--ol-meter-watch, var(--meter-watch)));
  --row-high: var(--ol-band-orange-fill, var(--ol-meter-high, var(--meter-high)));
  --row-critical: var(--ol-band-red-fill, var(--ol-meter-critical, var(--meter-critical)));
  --row-ok-label: var(--ol-band-green-label, var(--row-ok));
  --row-watch-label: var(--ol-band-yellow-label, var(--row-watch));
  --row-high-label: var(--ol-band-orange-label, var(--row-high));
  --row-critical-label: var(--ol-band-red-label, var(--row-critical));
  --row-stale-label: var(--ol-band-stale-label, var(--ol-muted, var(--muted)));
  --row-hatched: var(--ol-band-hatched-pattern, var(--ol-track, var(--track)));
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
.mark svg { width: 1.25rem; height: 1.25rem; }
:host([data-provider="CLAUDE"]) .mark { color: var(--ol-provider-claude); }
:host([data-provider="OPENROUTER"]) .mark { color: var(--ol-provider-openrouter); }
:host([data-provider="CODEX"]) .mark { color: var(--ol-provider-codex); }
:host([data-provider="ANTIGRAVITY"]) .mark { color: var(--ol-provider-antigravity); }
:host([data-provider="GEMINI_CLI"]) .mark { color: var(--ol-provider-gemini); }
:host([data-provider="OPENCODE"]) .mark { color: var(--ol-provider-opencode); }
:host([data-provider="GROK"]) .mark { color: var(--ol-provider-grok); }
:host([data-provider="KIMI"]) .mark { color: var(--ol-provider-kimi); }
:host([data-provider="MANUAL"]) .mark { color: var(--ol-provider-manual); }
:host([data-provider="MANUAL"]) .mark svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
:host([data-provider="CLAUDE"]) .mark svg,
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
  font-weight: var(--ol-weight-semibold);
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
  font-weight: var(--ol-weight-semibold);
  letter-spacing: -0.035em;
  line-height: 1;
  white-space: nowrap;
}
.usage[data-tone="ok"] .hero-readout { color: var(--row-ok-label); }
.usage[data-tone="watch"] .hero-readout { color: var(--row-watch-label); }
.usage[data-tone="high"] .hero-readout { color: var(--row-high-label); }
.usage[data-tone="critical"] .hero-readout { color: var(--row-critical-label); }
.usage[data-state="stale"] .hero-readout,
.usage[data-state="unknown"] .hero-readout { color: var(--row-stale-label); }
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
.metric-empty { color: var(--row-faint); font-weight: var(--ol-weight-regular); }
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

/*
 * One provider heading, then one compact four item line for every window.
 *
 * The heading and the lines share a single grid definition, named once below.
 * That is the whole point of this block: the mark and the provider name start
 * on the same left edge as every window name under them, and the two column
 * headings sit exactly over the percentage and the countdown they name. A
 * heading laid out on its own axis is what makes a card read as a poster with
 * a table stapled underneath rather than as one object.
 */
.row {
  display: grid;
  /* One column. The wide table template above belongs to the other form this
     component can take, and leaving it in place put the heading and the lines
     into six columns that neither of them was written for. */
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: var(--ol-space-3);
  min-height: 0;
  padding: var(--ol-space-4);
  overflow: hidden;
  /* The one grid the heading and every line share, in one place. */
  --row-columns: minmax(7rem, 0.85fr) minmax(8rem, 1.8fr) 4.5rem 5rem;
}
.identity {
  display: grid;
  min-height: 0;
  grid-template-columns: var(--row-columns);
  align-items: center;
  gap: var(--ol-space-3);
  padding: 0 0 var(--ol-space-3);
  border: 0;
  border-bottom: 1px solid var(--row-hairline);
}
.identity-name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ol-space-2);
  /* Over the name and the meter, so the mark never crowds the first bar. */
  grid-column: 1 / 3;
}
.account-label {
  min-width: 0;
  overflow: hidden;
  color: var(--row-muted);
  font-size: var(--ol-text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.column-label {
  color: var(--row-muted);
  font-size: var(--ol-text-micro);
  letter-spacing: 0.08em;
  line-height: 1;
  text-align: right;
  text-transform: uppercase;
  white-space: nowrap;
}
.mark {
  width: 1.75rem;
  height: 1.75rem;
  border: 0;
  border-radius: var(--ol-radius-sm);
  background: var(--row-raised);
  box-shadow: none;
}
.mark svg { width: 1.25rem; height: 1.25rem; }
.provider-name {
  min-width: 0;
  overflow: hidden;
  color: var(--row-heading);
  font-size: var(--ol-text-label);
  font-weight: var(--ol-weight-semibold);
  line-height: var(--ol-leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.windows {
  display: grid;
  gap: var(--ol-space-3);
}
.window-line {
  display: grid;
  min-width: 0;
  grid-template-columns: var(--row-columns);
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
.window-line[data-band="green"] .meter-fill { background: var(--row-ok); }
.window-line[data-band="yellow"] .meter-fill { background: var(--row-watch); }
.window-line[data-band="orange"] .meter-fill { background: var(--row-high); }
.window-line[data-band="red"] .meter-fill { background: var(--row-critical); }
.window-meter.neutral {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--row-hairline-strong);
}
/* A stale window is hatched across the whole track, not a faded colour bar.
   The last number is still printed beside it, and the hatch is what says the
   number is old. Fading the fill would have quietly broken its contrast. */
.window-line[data-band="stale"] .window-meter {
  background: var(--row-hatched);
}
.window-line[data-band="stale"] .meter-fill { background: transparent; }
.window-readout {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: var(--ol-space-1);
}
/* Shape beside hue. The band icon is the half of the answer that survives
   greyscale, a colour vision difference, and a glance from across a desk. */
.band-icon {
  display: inline-flex;
  flex: none;
  color: inherit;
}
.band-icon svg {
  width: 0.875rem;
  height: 0.875rem;
  display: block;
}
.window-percent {
  color: var(--row-accent);
  font-size: var(--ol-text-body);
  font-weight: var(--ol-weight-semibold);
  text-align: right;
}
.window-line[data-band="green"] .window-readout { color: var(--row-ok-label); }
.window-line[data-band="yellow"] .window-readout { color: var(--row-watch-label); }
.window-line[data-band="orange"] .window-readout { color: var(--row-high-label); }
.window-line[data-band="red"] .window-readout { color: var(--row-critical-label); }
.window-line[data-band="stale"] .window-readout { color: var(--row-stale-label); }
.window-line .window-percent { color: inherit; }
.window-line[data-band="none"] .window-readout { color: var(--row-soft); }
/* Crossing 60, 80 or 90 changes the hue. The width tween is the slower of the
   two so the bar arrives at its new length just after it has admitted its new
   band, which is what makes a threshold feel crossed rather than redrawn. */
.meter-fill {
  transition: width var(--ol-motion-base, 180ms)
      var(--ol-ease-out, cubic-bezier(0.16, 1, 0.3, 1)),
    background-color var(--ol-motion-fast, 120ms) linear;
}
.window-readout {
  transition: color var(--ol-motion-fast, 120ms) linear;
}
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
  .row {
    gap: var(--ol-space-2);
    /* One override, and the heading follows the lines because they read the
       same variable rather than repeating the same four values twice. */
    --row-columns: minmax(4.8rem, 0.9fr) minmax(4.5rem, 1.25fr) 3.35rem 3.5rem;
  }
  .windows { gap: var(--ol-space-2); }
  .identity,
  .window-line { gap: var(--ol-space-2); }
  .account-label { display: none; }
  .window-name,
  .window-percent { font-size: var(--ol-text-micro); }
  .band-icon svg { width: 0.75rem; height: 0.75rem; }
  .window-reset { font-size: var(--ol-text-micro); }
}
@media (prefers-reduced-motion: reduce) {
  .meter-fill,
  .usage[data-state="fresh"] .state-dot { animation: none; }
  .meter-fill,
  .window-readout { transition: none; }
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
  font-weight: var(--ol-weight-semibold);
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
  if (globalThis.customElements.get(PROVIDER_TABLE_HEADER_TAG) !== undefined)
    return;
  const BaseElement = globalThis.HTMLElement;
  if (typeof BaseElement === "undefined") return;

  class OpenLimiterProviderTableHeader extends BaseElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML =
        "<style>" +
        PROVIDER_TABLE_HEADER_STYLE +
        "</style>" +
        providerTableHeaderMarkup();
    }
  }

  globalThis.customElements.define(
    PROVIDER_TABLE_HEADER_TAG,
    OpenLimiterProviderTableHeader
  );
}

export function createProviderTableHeaderElement(
  ownerDocument?: Document
): HTMLElement {
  defineProviderTableHeaderElement();
  const documentRef = ownerDocument ?? globalThis.document;
  if (documentRef === undefined) {
    throw new Error(
      "A document is required to create a provider table header."
    );
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
        "<style>" +
        PROVIDER_ROW_STYLE +
        "</style>" +
        providerRowMarkup(this.#rowData);
    }
  }

  globalThis.customElements.define(PROVIDER_ROW_TAG, OpenLimiterProviderRow);
}

export function setProviderRowData(
  element: HTMLElement,
  row: ProviderAccountRowView
): void {
  defineProviderRowElement();
  (element as ProviderRowHost).rowData = row;
}

export function createProviderRowElement(
  row: ProviderAccountRowView,
  ownerDocument?: Document
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
