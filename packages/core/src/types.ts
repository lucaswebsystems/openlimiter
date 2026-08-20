export const PROVIDER_CODES = [
  "CLAUDE",
  "OPENROUTER",
  "CODEX",
  "ANTIGRAVITY",
  "GEMINI_CLI",
  "OPENCODE",
  "MANUAL"
] as const;

export type ProviderCode = (typeof PROVIDER_CODES)[number];
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
 * The one currency an amount may be stated in, for now.
 *
 * A literal rather than a string keeps a provider from writing its own text
 * into a field a human reads. When a second currency is genuinely supported it
 * is added here and the normalizer's set below grows with it.
 */
export type SnapshotCurrency = "USD";

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

export interface ConnectorLabels {
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
  verification: "UNVERIFIED";
}

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
  currency?: SnapshotCurrency;
  /**
   * Which account this reading belongs to, when a source names one.
   *
   * Absent means one unnamed account, which is every reading written before
   * multiple accounts existed. Absent is not the same as an account called
   * "default": a row without this field keeps the identity it always had.
   */
  accountId?: string;
  /** How the reading arrived. Absent means it was never recorded. */
  provenance?: SnapshotProvenance;
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
  provenance?: unknown;
}

export interface ConnectorReadContext {
  payload?: unknown;
  now: string;
  environment: Readonly<Record<string, string | undefined>>;
}

export type ConnectorResult =
  | { ok: true; meters: readonly RawMeter[] }
  | { ok: false; reason: "unknown" | "unavailable" | "not_configured" };

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

export interface ConnectorContract {
  readonly id: Lowercase<ProviderCode>;
  readonly displayName: string;
  readonly labels: ConnectorLabels;
  /** Whether this connector's parser wants parsed JSON or the raw text. */
  readonly encoding: ConnectorEncoding;
  detect(environment: Readonly<Record<string, string | undefined>>): boolean;
  read(context: ConnectorReadContext): Promise<ConnectorResult>;
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
