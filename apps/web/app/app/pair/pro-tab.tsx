"use client";

import { useTranslations } from "next-intl";
import { proAccessState, type ProEntitlement } from "@/lib/pro";
import { offersTrial, locksPro } from "@/lib/pro-trial";
import { ProLockCard } from "../trial";

/**
 * The paired phone's Pro tab.
 *
 * A paired phone holds a read token and no account session, so the plan comes
 * from the latest server read (see phoneEntitlementOf in lib/phone-session.ts),
 * and the one rule the hub and /pro use, proAccessState, sorts it:
 *
 *   a plan that is on says so;
 *   an ended plan gets the hub's card with the two subscriptions;
 *   only an account that never had a plan gets the trial;
 *   a plan no read has reported says it is reading, then that it cannot be
 *   read, and offers nothing at all.
 *
 * Every case ends with the note that pairing shows bars and never turns push on.
 */
export function ProTab({
  entitlement,
  reading,
}: {
  /** Undefined until a read reports the plan; null for an account that never had one. */
  entitlement: ProEntitlement | null | undefined;
  /** No read has answered yet. */
  reading: boolean;
}) {
  const pro = useTranslations("hub.pro");
  const portal = useTranslations("proPortal");
  const state = entitlement === undefined ? null : proAccessState(entitlement);
  return (
    <div className="ol-phone-pro">
      {state === null ? (
        <section className="ol-lock" aria-label={pro("label")}>
          <div className="ol-lock-inner">
            <div className="ol-lock-head">
              <span className="ol-lock-chip">{pro("label")}</span>
              <p role="status">{pro(reading ? "phonePlan.loading" : "phonePlan.unavailable")}</p>
            </div>
          </div>
        </section>
      ) : offersTrial(state) || locksPro(state) ? (
        <ProLockCard
          client={null}
          entitlement={entitlement ?? null}
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
