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

/** A numeric quota row, identified by its contract rather than its meter name. */
export function isKnownQuotaMeter(snapshot: Snapshot): boolean {
  return snapshot.unit === "PERCENT" &&
    (snapshot.kind === undefined || snapshot.kind === "quota_percent") &&
    snapshot.availability === undefined &&
    snapshot.meter !== "ACQUISITION" &&
    snapshot.meter !== "API_BUDGET_PERCENT";
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
    if (!isKnownQuotaMeter(snapshot)) return [];
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
