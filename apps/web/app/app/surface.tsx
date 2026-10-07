"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Dashboard } from "./dashboard";
import { DeviceView } from "./device-view";
import { SkeletonRows } from "./pieces";
import { deviceSessionUsable, readDeviceSession } from "@/lib/device-session";
import { readPhonePairMeta } from "@/lib/phone-session";
import { PhoneTabs } from "./pair/phone-tabs";
import { authStorageKey } from "@/lib/account-client";

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
  const [pairedPhone, setPairedPhone] = useState(false);
  const [phonePairingHint, setPhonePairingHint] = useState(false);
  const t = useTranslations("hub");

  useEffect(() => {
    setSurface(deviceSessionUsable(readDeviceSession()) ? "device" : "account");
    const paired = readPhonePairMeta() !== null;
    setPairedPhone(paired);
    const key = authStorageKey();
    let signedIn = false;
    try { signedIn = key !== null && (localStorage.getItem(key) !== null || sessionStorage.getItem(key) !== null); }
    catch { /* A refused store behaves like a signed out browser. */ }
    setPhonePairingHint(!paired && !signedIn && /Mobi|Android|iPhone|iPad/iu.test(navigator.userAgent));
    document.documentElement.setAttribute(READY_ATTR, "1");
  }, []);

  if (surface === "unknown") {
    return (
      <div className="ol-dashboard">
        <SkeletonRows />
      </div>
    );
  }

  const product = surface === "device" ? <DeviceView lockup={lockup} /> : <Dashboard lockup={lockup} />;

  return (
    <>
      {product}
      {phonePairingHint && (
        <p className="ol-phone-pair-hint">
          <Link href="/app/pair" className="focus-ring">{t("phonePairHint")}</Link>
        </p>
      )}
      {pairedPhone && <PhoneTabs active="pro" />}
    </>
  );
}
