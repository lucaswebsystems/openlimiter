"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dashboard } from "./dashboard";
import { DeviceView } from "./device-view";
import { SkeletonRows } from "./pieces";
import { deviceSessionUsable, readDeviceSession } from "@/lib/device-session";

/**
 * Which product /app is, decided once, in the browser.
 *
 * There are two ways to have quota on this route and they are not two modes of
 * one screen. A signed in browser holds an account session, pastes documents,
 * and can change things. A paired phone holds a read scoped device token, no
 * account session at all, and can only look. Mounting one of them means the
 * other's effects never run, which is why this decision is a component rather
 * than a flag inside the dashboard: a phone should not be opening an account
 * client, and a browser should not be sending a device token it does not have.
 *
 * The choice needs local storage, so it cannot be made on the server. The
 * skeleton below is what the reader sees for that one frame, and it is the same
 * skeleton the dashboard itself opens with.
 */

/** Set on the document once a surface has mounted. Clears the launch splash. */
const READY_ATTR = "data-ol-ready";

type Surface = "unknown" | "device" | "account";

export function AppSurface({ lockup }: { lockup: ReactNode }) {
  const [surface, setSurface] = useState<Surface>("unknown");

  useEffect(() => {
    setSurface(deviceSessionUsable(readDeviceSession()) ? "device" : "account");
    document.documentElement.setAttribute(READY_ATTR, "1");
  }, []);

  if (surface === "unknown") {
    return (
      <div className="ol-dashboard">
        <SkeletonRows />
      </div>
    );
  }

  return surface === "device" ? <DeviceView lockup={lockup} /> : <Dashboard lockup={lockup} />;
}
