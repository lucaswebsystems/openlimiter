import {
  RETENTION_MILLISECONDS,
  freshnessPolicy,
  providerMeterPresentation,
  providerMeterVisible,
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
  if (!providerMeterVisible(snapshot.provider, snapshot.meter)) return false;
  const presentation = providerMeterPresentation(snapshot.provider, snapshot.meter);
  if (snapshot.availability !== undefined) return presentation?.displayAvailability === true;
  if (presentation?.valueSemantics === "balance") {
    return snapshot.unit === "CREDITS" || snapshot.usedAmount !== undefined;
  }
  return snapshot.unit === "PERCENT" &&
    (snapshot.kind === undefined || snapshot.kind === "quota_percent") &&
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

/**
 * The shared stale rule, one reading at a time: fresh for its provider's
 * refresh horizon, never for a reset still ahead, then stale (flat grey with
 * its age) for the seven days the data rules hold a stale reading, then gone.
 */
function heldExpiry(snapshot: Snapshot, now: string): string | null {
  const age = Date.parse(now) - Date.parse(snapshot.observedAt);
  return age >= 0 && age <= RETENTION_MILLISECONDS ? providerExpiry(snapshot, now) : null;
}

/**
 * The readings the web app may draw.
 *
 * Every reading follows the shared stale rule by `heldExpiry`, with the
 * provider poll policy as its refresh horizon: Codex is seven minutes,
 * Antigravity thirteen minutes, Claude and the conservative fallback nineteen
 * minutes. Every account with a reading in those seven days shows, as on the
 * desktop, so a quiet second login stays beside a current one, stale. Legacy
 * default identities lose whenever an identified account for the same
 * provider exists.
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
  const eligible = snapshots.filter((snapshot) => isKnownQuotaMeter(snapshot) &&
    !(snapshot.accountId === "default" && identified.has(snapshot.provider)));
  const live = eligible.flatMap((snapshot) => {
    const expiresAt = heldExpiry(snapshot, now);
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
    return provider.windows.flatMap((window): Snapshot[] => {
      const balance = provider.provider === "OPENROUTER" && window.windowName === "ACCOUNT_BALANCE" &&
        window.percentage === null && window.amount !== undefined && window.currency !== undefined &&
        window.kind === "money_balance";
      if (!balance && window.percentage === null) return [];
      return [{
      provider: provider.provider as ProviderCode,
      meter: window.windowName,
      value: balance ? window.amount ?? 0 : window.percentage ?? 0,
      unit: balance ? "CREDITS" : "PERCENT",
      window: { kind: balance ? "lifetime" : "rolling" },
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
      ...(balance ? { kind: "money_balance" as const, currency: window.currency } : {}),
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    }];
    });
  });
  return visibleQuotaSnapshots(snapshots, now, fallbackLabel);
}
