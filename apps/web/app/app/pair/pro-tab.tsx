"use client";

import { ProLockCard } from "../trial";

export function ProTab() {
  return (
    <div className="ol-phone-pro">
      <ProLockCard
        client={null}
        entitlement={null}
        onStartTrial={() => window.location.assign("/app?trial=1")}
      />
    </div>
  );
}
