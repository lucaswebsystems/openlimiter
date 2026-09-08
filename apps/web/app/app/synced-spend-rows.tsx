"use client";

import { useTranslations } from "next-intl";
import type { SyncedApiSpend } from "@/lib/synced-usage";
import { DollarRow } from "./pieces";

export function SyncedSpendRows({ sources, now, failed = false }: { sources: SyncedApiSpend[]; now: string; failed?: boolean }) {
  const t = useTranslations("hub");
  return <div className="ol-device-money">
    {sources.map((row) => {
      const format = new Intl.NumberFormat(undefined, { style: "currency", currency: row.currency });
      const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
      return <DollarRow
        key={`${row.provider}:${row.accountLabel}:${row.currency}:${row.periodStart}:${row.periodEnd}`}
        name={t("syncedSpend.source", {
          provider: row.provider, account: row.accountLabel,
          start: new Date(row.periodStart).toLocaleDateString(undefined, { timeZone: "UTC" }),
          end: new Date(row.periodEnd).toLocaleDateString(undefined, { timeZone: "UTC" }),
        })}
        amountText={format.format(row.amountMinor / 10 ** digits)}
        stale={failed || Date.parse(now) - Date.parse(row.observedAt) > 5 * 60_000}
      />;
    })}
  </div>;
}
