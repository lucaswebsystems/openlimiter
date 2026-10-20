"use client";

import { useTranslations } from "next-intl";
import { phoneProState, type PhonePlan } from "@/lib/phone-session";
import { ProLockCard } from "../trial";

/**
 * The paired phone's Pro tab.
 *
 * A paired phone holds a read token and no account session, so the plan comes
 * from that token (see app/app/pair/api/read/route.ts). An account with Pro on
 * sees what it has; an account without Pro, or a phone that has not read yet,
 * sees the hub's own card: the one Pro list, the trial and the prices after it.
 * Either way the tab says that pairing shows bars and never turns push on.
 */
export function ProTab({ plan = null }: { plan?: PhonePlan | null }) {
  const pro = useTranslations("hub.pro");
  const portal = useTranslations("proPortal");
  const state = phoneProState(plan);
  return (
    <div className="ol-phone-pro">
      {state === null ? (
        <ProLockCard
          client={null}
          entitlement={null}
          onStartTrial={() => window.location.assign("/app?trial=1")}
        />
      ) : (
        <section className="ol-lock" aria-label={portal(`plan.${state}.title`)}>
          <div className="ol-lock-inner">
            <div className="ol-lock-head">
              <span className="ol-lock-chip">{pro("label")}</span>
              <h2>{portal(`plan.${state}.title`)}</h2>
              <p>{portal(`plan.${state}.body`)}</p>
            </div>
          </div>
        </section>
      )}
      <p className="ol-trial-note">{pro("phonePush")}</p>
    </div>
  );
}
