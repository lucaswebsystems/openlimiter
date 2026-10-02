"use client";

import { useTranslations } from "next-intl";
import type { SyncedApiSpend } from "@/lib/synced-usage";
import { DollarRow, observationAgeMinutes } from "./pieces";
import { syncedPeriodOf } from "@/lib/synced-usage";

export function SyncedSpendRows({ sources, now, failed = false }: { sources: SyncedApiSpend[]; now: string; failed?: boolean }) {
  const t = useTranslations("hub");
  const readingsT = useTranslations("desktopReadings");
  const accounts = new Map<string, string[]>();
  for (const row of sources) {
    const held = accounts.get(row.provider) ?? [];
    if (!held.includes(row.accountId)) held.push(row.accountId);
    accounts.set(row.provider, held);
  }
  for (const held of accounts.values()) held.sort((left, right) => left.localeCompare(right));
  return <div className="ol-device-money">
    {sources.map((row) => {
      const format = new Intl.NumberFormat(undefined, { style: "currency", currency: row.currency });
      const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
      const period = syncedPeriodOf(row.periodStart, row.periodEnd);
      const age = observationAgeMinutes(row.observedAt, now);
      const stale = failed || age === null || age > 5;
      const providerAccounts = accounts.get(row.provider) ?? [row.accountId];
      const accountIndex = providerAccounts.indexOf(row.accountId) + 1;
      const carriedLabel = row.accountLabel?.trim() ?? "";
      const safeLabel = carriedLabel !== "" && carriedLabel !== row.accountId &&
        !carriedLabel.includes("@") && carriedLabel !== "default"
        ? carriedLabel
        : readingsT("accountFallback", { count: accountIndex });
      const periodKey = period.mode === "through" ? "Through" : "UpTo";
      const sourceKey = providerAccounts.length > 1
        ? `syncedSpend.source${periodKey}`
        : `syncedSpend.source${periodKey}Single`;
      return (
        <DollarRow
          key={`${row.provider}:${row.accountId}:${row.currency}:${row.periodStart}:${row.periodEnd}`}
          name={t(sourceKey, {
            provider: row.provider,
            account: safeLabel,
            start: period.start,
            end: period.end,
          })}
          amountText={format.format(row.amountMinor / 10 ** digits)}
          stale={stale}
          freshLabel={t("cloud.fresh")}
          staleLabel={t("cloud.stale")}
          observationLabel={age === null ? t("cloud.observationUnknown") : t("cloud.observationAge", { minutes: age })}
          stateAnnouncement={t("cloud.stateAnnouncement", { state: stale ? t("cloud.stale") : t("cloud.fresh") })}
        />
      );
    })}
  </div>;
}
