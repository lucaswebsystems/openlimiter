"use client";

import { useTranslations } from "next-intl";
import type { SyncedApiSpend } from "@/lib/synced-usage";
import { DollarRow, observationAgeMinutes } from "./pieces";
import { syncedPeriodOf } from "@/lib/synced-usage";

export function SyncedSpendRows({ sources, now, failed = false }: { sources: SyncedApiSpend[]; now: string; failed?: boolean }) {
  const t = useTranslations("hub");
  return <div className="ol-device-money">
    {sources.map((row) => {
      const format = new Intl.NumberFormat(undefined, { style: "currency", currency: row.currency });
      const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
      const period = syncedPeriodOf(row.periodStart, row.periodEnd);
      const age = observationAgeMinutes(row.observedAt, now);
      const stale = failed || age === null || age > 5;
      return (
        <DollarRow
          key={`${row.provider}:${row.accountLabel}:${row.currency}:${row.periodStart}:${row.periodEnd}`}
          name={t(`syncedSpend.source${period.mode === "through" ? "Through" : "UpTo"}`, {
            provider: row.provider,
            account: row.accountLabel,
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
