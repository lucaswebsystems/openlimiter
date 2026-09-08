"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { readExpiredProSummary, type ProExpiredSummary } from "@/lib/pro";

type SummaryNamespace = "hub.pro" | "proPortal";
type ReadState = "loading" | "ready" | "error";

export function ExpiredProSummary({
  client,
  namespace,
}: {
  client: SupabaseClient | null;
  namespace: SummaryNamespace;
}) {
  const t = useTranslations(namespace);
  const [state, setState] = useState<ReadState>("loading");
  const [summary, setSummary] = useState<ProExpiredSummary | null>(null);

  useEffect(() => {
    if (client === null) {
      setState("error");
      setSummary(null);
      return;
    }
    let live = true;
    setState("loading");
    setSummary(null);
    void readExpiredProSummary(client).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setState("error");
        return;
      }
      setSummary(result.value);
      setState("ready");
    });
    return () => {
      live = false;
    };
  }, [client]);

  if (state === "loading") {
    return <p className="text-sm leading-relaxed text-muted" role="status">{t("lost.loading")}</p>;
  }
  if (state === "error" || summary === null) {
    return <p className="text-sm leading-relaxed text-muted" role="alert">{t("lost.unavailable")}</p>;
  }

  const phoneStatus = summary.phonePaired ? t("lost.paired") : t("lost.notPaired");
  const hostedContextStatus = summary.hostedContextEnabled ? t("lost.on") : t("lost.off");
  const listClassName = namespace === "hub.pro" ? "ol-lock-list" : "space-y-1";
  const itemClassName = namespace === "hub.pro" ? undefined : "text-sm leading-relaxed text-muted";

  return (
    <>
      <ul className={listClassName}>
        <li className={itemClassName}>
          {namespace === "hub.pro" && <span aria-hidden="true" className="ol-lock-dot" />}
          {summary.alertCount === 0
            ? t("lost.noAlerts")
            : t("lost.alerts", { count: summary.alertCount })}
        </li>
        <li className={itemClassName}>
          {namespace === "hub.pro" && <span aria-hidden="true" className="ol-lock-dot" />}
          {t("lost.phone", { status: phoneStatus })}
        </li>
        <li className={itemClassName}>
          {namespace === "hub.pro" && <span aria-hidden="true" className="ol-lock-dot" />}
          {t("lost.multiAccount", { count: summary.additionalAccountCount })}
        </li>
        <li className={itemClassName}>
          {namespace === "hub.pro" && <span aria-hidden="true" className="ol-lock-dot" />}
          {t("lost.hostedContext", { status: hostedContextStatus })}
        </li>
      </ul>
      <p className="text-sm leading-relaxed text-body">{t("restore")}</p>
    </>
  );
}
