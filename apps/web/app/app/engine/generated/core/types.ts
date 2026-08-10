/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
export const PROVIDER_CODES = [
  "CLAUDE",
  "OPENROUTER",
  "CODEX",
  "ANTIGRAVITY",
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
}

export interface ConnectorReadContext {
  payload?: unknown;
  now: string;
  environment: Readonly<Record<string, string | undefined>>;
}

export type ConnectorResult =
  | { ok: true; meters: readonly RawMeter[] }
  | { ok: false; reason: "unknown" | "unavailable" | "not_configured" };

export interface ConnectorContract {
  readonly id: Lowercase<ProviderCode>;
  readonly displayName: string;
  readonly labels: ConnectorLabels;
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
