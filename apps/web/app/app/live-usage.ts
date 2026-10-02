import registry from "../../lib/provider-specs.generated.json";
import {
  freshness,
  freshnessPolicy,
  type ProviderCode,
  type Snapshot,
} from "./engine";
import type { SyncedProviderUsage } from "@/lib/synced-usage";

const CONNECTOR_PROVIDERS: Readonly<Record<string, ProviderCode | undefined>> = {
  antigravity: "ANTIGRAVITY",
  claude: "CLAUDE",
  codex: "CODEX",
  cursor: "CURSOR",
  "gemini-cli": "GEMINI_CLI",
  grok: "GROK",
  kimi: "KIMI",
  opencode: "OPENCODE",
  openrouter: "OPENROUTER",
};

interface RegistryEntry {
  directory: { connectorId: string } | null;
  displaySurfaces: readonly string[];
  meters: readonly { kind: string; unit: string; meterCode: string | null }[];
}

const KNOWN_METERS = new Map<ProviderCode, Set<string>>();
for (const entry of registry.providers as RegistryEntry[]) {
  if (entry.directory === null) continue;
  const provider = CONNECTOR_PROVIDERS[entry.directory.connectorId];
  if (provider === undefined || !entry.displaySurfaces.includes("web")) continue;
  const meters = KNOWN_METERS.get(provider) ?? new Set<string>();
  for (const meter of entry.meters) {
    if (
      (meter.kind === "subscription_quota" || meter.kind === "model_quota") &&
      meter.unit === "percent_used" && meter.meterCode !== null
    ) {
      meters.add(meter.meterCode);
    }
  }
  KNOWN_METERS.set(provider, meters);
}

const CONNECTOR_ALIASES: Readonly<Partial<Record<ProviderCode, readonly string[]>>> = {
  ANTIGRAVITY: ["FIVE_HOUR", "SEVEN_DAY", "THIRD_PARTY_SESSION", "THIRD_PARTY_WEEKLY"],
  CODEX: ["FIVE_HOUR", "SEVEN_DAY", "PRIMARY", "SECONDARY", "PRIMARY_WINDOW", "SECONDARY_WINDOW"],
  GROK: ["WEEKLY", "MONTHLY", "ON_DEMAND_MONTHLY"],
};
for (const [provider, meters] of Object.entries(CONNECTOR_ALIASES)) {
  const known = KNOWN_METERS.get(provider as ProviderCode) ?? new Set<string>();
  for (const meter of meters ?? []) known.add(meter);
  KNOWN_METERS.set(provider as ProviderCode, known);
}

/** A provider quota meter that a checked connector or provider spec can emit. */
export function isKnownQuotaMeter(provider: ProviderCode, meter: string): boolean {
  if (meter === "ACQUISITION" || meter === "API_BUDGET_PERCENT") return false;
  if (provider === "CLAUDE" && /^SEVEN_DAY_[A-Z0-9_]{1,36}$/u.test(meter)) return true;
  if (provider === "MANUAL") return /^[A-Z0-9_]{2,48}$/u.test(meter);
  return KNOWN_METERS.get(provider)?.has(meter) ?? false;
}

function safeAccountLabel(label: string | undefined, accountId: string): string | null {
  const value = label?.trim() ?? "";
  if (value === "" || value === accountId || value.includes("@") || value === "default") return null;
  return value;
}

function providerExpiry(snapshot: Snapshot, now: string): string {
  return freshnessPolicy({
    sourceClass: snapshot.source,
    observedAt: snapshot.observedAt,
    now,
    provider: snapshot.provider,
    writer: "desktop",
  }).expiresAt;
}

function liveExpiry(snapshot: Snapshot, now: string): string | null {
  const current = Date.parse(now);
  const observed = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(current) || !Number.isFinite(observed) || observed > current) return null;
  if (snapshot.resetAt !== null) {
    const reset = Date.parse(snapshot.resetAt);
    return Number.isFinite(reset) && reset > current && reset >= observed
      ? new Date(reset).toISOString()
      : null;
  }
  const expiresAt = providerExpiry(snapshot, now);
  return freshness(snapshot.observedAt, expiresAt, now) === "fresh" ? expiresAt : null;
}

/**
 * The readings the web app may draw.
 *
 * A reset instant is the authoritative boundary for a measured window. A row
 * without one uses the existing provider poll policy: Codex is seven minutes,
 * Antigravity thirteen minutes, Claude and the conservative fallback nineteen
 * minutes. Legacy default identities lose whenever an identified account for
 * the same provider exists.
 */
export function visibleQuotaSnapshots(
  snapshots: readonly Snapshot[],
  now: string,
  fallbackLabel: (count: number) => string = (count) => `Account ${count}`,
): Snapshot[] {
  const identified = new Set(
    snapshots
      .filter((row) => row.accountId !== undefined && row.accountId !== "default")
      .map((row) => row.provider),
  );
  const live = snapshots.flatMap((snapshot) => {
    if (snapshot.unit !== "PERCENT" || !isKnownQuotaMeter(snapshot.provider, snapshot.meter)) return [];
    if (snapshot.accountId === "default" && identified.has(snapshot.provider)) return [];
    const expiresAt = liveExpiry(snapshot, now);
    return expiresAt === null ? [] : [{ ...snapshot, expiresAt }];
  });

  const accounts = new Map<ProviderCode, string[]>();
  for (const snapshot of live) {
    if (snapshot.accountId === undefined) continue;
    const held = accounts.get(snapshot.provider) ?? [];
    if (!held.includes(snapshot.accountId)) held.push(snapshot.accountId);
    accounts.set(snapshot.provider, held);
  }
  for (const held of accounts.values()) held.sort((left, right) => left.localeCompare(right));

  return live
    .map((snapshot) => {
      if (snapshot.accountId === undefined) {
        const withoutLabel = { ...snapshot };
        delete withoutLabel.accountLabel;
        return withoutLabel;
      }
      const position = (accounts.get(snapshot.provider)?.indexOf(snapshot.accountId) ?? 0) + 1;
      const label = safeAccountLabel(snapshot.accountLabel, snapshot.accountId) ?? fallbackLabel(position);
      return { ...snapshot, accountLabel: label };
    })
    .sort((left, right) =>
      left.provider.localeCompare(right.provider) ||
      (left.accountId ?? "").localeCompare(right.accountId ?? "") ||
      left.meter.localeCompare(right.meter)
    );
}

/** Turn the owner scoped read into engine snapshots, then apply web visibility. */
export function snapshotsFromSyncedUsage(
  providers: readonly SyncedProviderUsage[],
  now: string,
  fallbackLabel?: (count: number) => string,
): Snapshot[] {
  const supported = new Set<string>(Object.keys(CONNECTOR_PROVIDERS).map((key) => CONNECTOR_PROVIDERS[key]).filter(Boolean) as string[]);
  const snapshots = providers.flatMap((provider) => {
    if (!supported.has(provider.provider)) return [];
    return provider.windows.map((window): Snapshot => ({
      provider: provider.provider as ProviderCode,
      meter: window.windowName,
      value: window.percentage,
      unit: "PERCENT",
      window: { kind: "rolling" },
      resetAt: window.resetAt,
      source: "documented_api",
      precision: "exact",
      observedAt: window.observedAt,
      expiresAt: freshnessPolicy({
        sourceClass: "documented_api",
        observedAt: window.observedAt,
        now,
        provider: provider.provider,
        writer: "desktop",
      }).expiresAt,
      accountId: provider.accountId,
      ...(provider.accountLabel === null ? {} : { accountLabel: provider.accountLabel }),
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    }));
  });
  return visibleQuotaSnapshots(snapshots, now, fallbackLabel);
}
