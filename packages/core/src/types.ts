import type { ConnectionStatus, SnapshotAvailability } from "./connection-state.js";
import { WAVE_PROVIDERS, type WaveProviderCode } from "./providers/index.js";
export type { SnapshotAvailability } from "./connection-state.js";

/** The providers that shipped before the 2.1 wave, always switched on. */
const SHIPPED_PROVIDER_CODES = [
  "CLAUDE",
  "OPENROUTER",
  "CODEX",
  "ANTIGRAVITY",
  "GEMINI_CLI",
  "OPENCODE",
  "GROK",
  "KIMI",
  "CURSOR"
] as const;

/**
 * Every provider code the product knows. The 2.1 providers are part of it, so
 * every table keyed by provider already names them and the lanes that build
 * them write only their own files.
 */
export type ProviderCode = (typeof SHIPPED_PROVIDER_CODES)[number] | WaveProviderCode | "MANUAL";

/**
 * The providers this build has switched on: the ones it stores, shows, polls,
 * advises on and names on the status line. Every "which providers are there"
 * question in the product reads this list. A 2.1 provider joins it when its
 * own descriptor in `providers/` says `enabled: true`, and nowhere else.
 */
export const PROVIDER_CODES: readonly ProviderCode[] = [
  ...SHIPPED_PROVIDER_CODES,
  ...WAVE_PROVIDERS.filter((provider) => provider.enabled).map((provider) => provider.code),
  "MANUAL"
];

/**
 * The 2.1 providers still switched off. None of them is stored, displayed or
 * polled: the normalizer, the advice policy and the status line read
 * PROVIDER_CODES, so a row naming one of these is refused like an unknown
 * code, and refused anonymously. Its switch lives in three places, each the
 * provider lane's own file and held together by tests: `enabled` in its
 * descriptor here, `ENABLED` in its Rust module, and `enabled` in its spec.
 */
export const PENDING_PROVIDER_CODES: readonly ProviderCode[] =
  WAVE_PROVIDERS.filter((provider) => !provider.enabled).map((provider) => provider.code);

/** Whether a code names a provider this build has switched on. */
export function isEnabledProviderCode(value: unknown): value is ProviderCode {
  return typeof value === "string" && (PROVIDER_CODES as readonly string[]).includes(value);
}
export type SnapshotState = "fresh" | "stale" | "unknown";
export type SnapshotUnit = "PERCENT" | "CREDITS" | "TOKENS" | "REQUESTS";
export type SnapshotPrecision = "exact" | "estimated" | "manual";
export type SnapshotSource =
  | "native_payload"
  | "documented_api"
  | "internal_payload"
  | "authenticated_page"
  | "manual_entry";

export interface SnapshotWindow {
  kind: "rolling" | "fixed" | "lifetime" | "unknown";
  durationSeconds?: number;
}

/**
 * The currencies an amount may be stated in, exactly as the provider stated it.
 *
 * A literal rather than a string keeps a provider from writing its own text
 * into a field a human reads. CNY joined for providers that bill in yuan
 * (DeepSeek among them); amounts are never converted, because a converted
 * balance is a number no provider ever said.
 */
export type SnapshotCurrency = "USD" | "CNY";

export const SNAPSHOT_KINDS = [
  "quota_percent", "money_balance", "spend", "token_count", "runtime_info"
] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

export const CONNECTOR_VERIFICATIONS = [
  "UNVERIFIED", "VERIFIED_FIXTURES", "VERIFIED_LIVE"
] as const;
export type ConnectorVerification = (typeof CONNECTOR_VERIFICATIONS)[number];

export interface VerificationEvidence {
  providerVersion: string;
  accountShape: string;
  os: string;
  /** Canonical ISO instant, using the same format as observedAt. */
  date: string;
}

/** Largest money amount a reading may carry. Above this it is not a plan. */
export const MAX_SNAPSHOT_AMOUNT = 1_000_000;

/**
 * What a credit based plan has spent, and out of how much.
 *
 * Optional everywhere and travelling as one unit: a reading either carries all
 * three of these or none of them, so a surface can never print a used figure
 * with no limit beside it. A percentage never depends on them, which is why a
 * pair that fails validation is dropped while the percentage survives.
 */
export interface SnapshotAmounts {
  usedAmount: number;
  limitAmount: number;
  currency: SnapshotCurrency;
}

/**
 * How an observation reached us, stated in our own vocabulary.
 *
 * A provider tells us what its meter reads. It never tells us how we read it,
 * so this field is written by OpenLimiter and only ever holds one of the values
 * below. A human surface can then say "this came from your local Claude Code"
 * or "this came from an official API" without a provider being able to write
 * that sentence for us.
 */
export const SNAPSHOT_SOURCE_KINDS = [
  "statusline_payload",
  "explicit_ingest",
  "manual_document",
  "remote_api",
  "unknown"
] as const;

export type SnapshotSourceKind = (typeof SNAPSHOT_SOURCE_KINDS)[number];

/**
 * Which reader carried the observation. Closed for the same reason as above.
 *
 * The first three name a concrete path this product actually has, because a
 * source chip saying "your Claude Code statusline" and one saying "you imported
 * this" are the difference between a live reading and a paste, and a generic
 * reader kind cannot tell a person which they are looking at. The rest are the
 * reader kinds the connection architecture defines, kept for paths that exist
 * on paper before they exist in code.
 */
export const SNAPSHOT_OBSERVED_VIA = [
  "claude_code_statusline",
  "ingest_command",
  "manual_json",
  "local_event",
  "local_file",
  "local_command",
  "remote_http",
  "user_entry",
  "unknown"
] as const;

export type SnapshotObservedVia = (typeof SNAPSHOT_OBSERVED_VIA)[number];

export interface SnapshotProvenance {
  sourceKind: SnapshotSourceKind;
  observedVia: SnapshotObservedVia;
}

/**
 * Which OpenLimiter process last wrote a row.
 *
 * The cache is shared by every surface on the machine, and two of them can
 * poll: the desktop tray, which runs all day, and the command line tool, which
 * wakes up when a status line asks it to. Without this field neither can tell
 * whether the other is already keeping the rows fresh, so both poll and the
 * provider sees twice the traffic it should.
 *
 * Absent is the honest answer for every row written before this field existed
 * and for any row whose writer could not be believed, and absent means unknown
 * rather than "nobody": a reader that finds no marker falls back to polling,
 * which is the same behaviour the product always had.
 */
export const SNAPSHOT_WRITERS = ["desktop", "cli"] as const;

export type SnapshotWriter = (typeof SNAPSHOT_WRITERS)[number];

/**
 * What a reading's provenance becomes when the stated provenance cannot be
 * believed. The reading itself still stands: how a number arrived is a separate
 * question from whether the number is in range.
 */
export const UNKNOWN_PROVENANCE: SnapshotProvenance = {
  sourceKind: "unknown",
  observedVia: "unknown"
};

/**
 * Shape of an account identifier, when a source names one.
 *
 * Lowercase, digits and hyphens, never a space, so it can be joined into a cache
 * identity with a space separator and never collide. It is an opaque local alias
 * and is not required to be an account name any provider would recognise.
 */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * Plan concepts: source = source plus provenance, precision = precision,
 * verification = labels.verification. Validation never upgrades verification.
 */
export type ConnectorLabels = {
  credentialOrigin:
    | "official-local-tool"
    | "user-key"
    | "browser-session"
    | "user-entered";
  dataInterfaceStatus:
    | "native-statusline-payload"
    | "documented-api"
    | "internal-endpoint"
    | "authenticated-scrape"
    | "manual";
  automationRisk: "low" | "high";
} & (
  | { verification: "UNVERIFIED" | "VERIFIED_FIXTURES"; verificationEvidence?: never }
  | { verification: "VERIFIED_LIVE"; verificationEvidence?: VerificationEvidence }
);

export interface Snapshot {
  provider: ProviderCode;
  meter: string;
  value: number;
  unit: SnapshotUnit;
  window: SnapshotWindow;
  resetAt: string | null;
  source: SnapshotSource;
  precision: SnapshotPrecision;
  observedAt: string;
  expiresAt: string;
  labels: ConnectorLabels;
  /** Present only when the provider's own documented payload carried money. */
  usedAmount?: number;
  limitAmount?: number;
  /**
   * With the pair above, the currency of both. Alone, only on a money_balance
   * or spend reading that is not a percent, where it is the currency of `value`
   * itself: a balance has no denominator to travel in a pair with.
   */
  currency?: SnapshotCurrency;
  /**
   * Which account this reading belongs to, when a source names one.
   *
   * Absent means one unnamed account, which is every reading written before
   * multiple accounts existed. Absent is not the same as an account called
   * "default": a row without this field keeps the identity it always had.
   */
  accountId?: string;
  /**
   * A human name for the account this row belongs to.
   *
   * `accountId` is an identifier: lowercase, hyphenated, safe to key a cache
   * on, and unreadable. A surface that prints it prints exactly that, which is
   * fine for an account a person named and wrong for one this product had to
   * invent, such as the Gemini CLI login borrowed for the shared Code Assist
   * pool. Absent means the surface should fall back to the identifier, which is
   * what every row written before this field did.
   */
  accountLabel?: string;
  /** How the reading arrived. Absent means it was never recorded. */
  provenance?: SnapshotProvenance;
  /**
   * Which process wrote this row, when the writer said so.
   *
   * Never part of the row's identity, so a row that gains or loses the marker
   * merges exactly as it always did.
   */
  writer?: SnapshotWriter;
  /** Absent means unknown. Never infer this from unit. */
  kind?: SnapshotKind;
  /**
   * The meter could not be read. Consumers must never count a row carrying
   * availability as a numeric reading, including when value is zero.
   */
  availability?: SnapshotAvailability;
  /** Canonical ISO instant. Allowed only when availability is rate_limited. */
  retryAt?: string;
}

export interface RawMeter {
  provider: unknown;
  meter: unknown;
  value: unknown;
  unit: unknown;
  window: unknown;
  resetAt: unknown;
  source: unknown;
  precision: unknown;
  observedAt: unknown;
  expiresAt: unknown;
  labels: unknown;
  usedAmount?: unknown;
  limitAmount?: unknown;
  currency?: unknown;
  accountId?: unknown;
  accountLabel?: unknown;
  provenance?: unknown;
  writer?: unknown;
  kind?: unknown;
  availability?: unknown;
  retryAt?: unknown;
}

export interface ConnectorReadContext {
  payload?: unknown;
  now: string;
  environment: Readonly<Record<string, string | undefined>>;
}

/**
 * What a reader answers, and how its connection is doing while it answers.
 *
 * `connection` is optional so every existing caller keeps compiling, and it is
 * the same value on both branches on purpose: a reader that returned meters can
 * still be degraded, and a reader that returned nothing still owes a person one
 * sentence about what to do. The status is written by OpenLimiter from the
 * closed vocabulary in connection-state.ts, never by a provider payload.
 */
export type ConnectorResult =
  | { ok: true; meters: readonly RawMeter[]; connection?: ConnectionStatus }
  | {
      ok: false;
      reason: "unknown" | "unavailable" | "not_configured";
      connection?: ConnectionStatus;
    };

/**
 * What a connector's payload IS, before its parser sees it.
 *
 * Almost every provider answers JSON. OpenCode answers a logged in HTML page,
 * because it publishes no usage interface at all. That difference cannot live
 * only in the reader that happens to know about it: the desktop pipeline, the
 * ingest command and the web engine all hand payloads to parsers, and any one
 * of them that assumes JSON silently breaks the text reader. So the connector
 * declares it, and every payload boundary asks.
 */
export type ConnectorEncoding = "json" | "text";

/**
 * How much the INTERFACE behind a reader can be relied on.
 *
 * Not how good the parser is. A reader pointed at a documented response and a
 * reader pointed at a rendered page can both be flawless and still deserve
 * different sentences on a surface, because only one of them has a contract
 * behind it. Absent means stable, so a reader says nothing unless it has
 * something to admit.
 */
export type ConnectorMaturity = "stable" | "beta" | "experimental";

export interface ConnectorContract {
  readonly id: Lowercase<ProviderCode>;
  readonly displayName: string;
  readonly labels: ConnectorLabels;
  /** Whether this connector's parser wants parsed JSON or the raw text. */
  readonly encoding: ConnectorEncoding;
  /** Stated only when it is not stable, so silence is never a claim. */
  readonly maturity?: ConnectorMaturity;
  detect(environment: Readonly<Record<string, string | undefined>>): boolean;
  read(context: ConnectorReadContext): Promise<ConnectorResult>;
}

/** A reader's maturity, with the default spelled out rather than assumed. */
export function connectorMaturity(connector: ConnectorContract): ConnectorMaturity {
  return connector.maturity ?? "stable";
}

export type AdviceReason = "HEALTHY" | "NEAR_CAP" | "AT_CAP" | "UNKNOWN";

export type AdviceRecommendation =
  | {
      code: "PREFER";
      provider: ProviderCode;
      reason: "LOWEST_USAGE" | "ORDERED_TIE_BREAK";
    }
  | {
      code: "NONE";
      provider: null;
      reason: "NO_KNOWN_PROVIDER" | "NO_FRESH_DATA" | "NO_HEALTHY_PROVIDER";
    };

export interface AdviceProvider {
  provider: ProviderCode;
  state: "fresh" | "stale";
  usagePercent: number;
  resetAt: string | null;
}

export interface Advice {
  inject: boolean;
  reason: AdviceReason;
  recommendation: AdviceRecommendation;
  providers: readonly AdviceProvider[];
  unknownProviders: readonly ProviderCode[];
}

export interface Forecast {
  burnRatePerHour: number;
  hoursToExhaustion: number | null;
}
