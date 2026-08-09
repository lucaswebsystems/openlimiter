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

export interface AdviceProvider {
  provider: ProviderCode;
  state: "fresh" | "stale";
  usagePercent: number;
  resetAt: string | null;
}

export interface Advice {
  inject: boolean;
  reason: AdviceReason;
  providers: readonly AdviceProvider[];
  unknownProviders: readonly ProviderCode[];
}

export interface Forecast {
  burnRatePerHour: number;
  hoursToExhaustion: number | null;
}
