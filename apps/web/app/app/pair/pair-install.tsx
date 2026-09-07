"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

/**
 * Adding the paired page to the phone's home screen, as one honest step.
 *
 * The two platforms that matter expose completely different amounts of help,
 * and this component asks each for exactly what it offers:
 *
 *   Chrome on Android fires `beforeinstallprompt` when the page qualifies.
 *   Holding that event and replaying it from one button is the whole install:
 *   one press, the platform's own sheet, done.
 *
 *   iOS Safari fires nothing and exposes no API. The only honest thing the
 *   page can do there is say the two taps Apple requires, as three short
 *   lines.
 *
 * Once the page is already running installed, in standalone display mode,
 * nothing is shown at all: the step has nothing left to ask for.
 *
 * ORDER MATTERS
 * -------------
 * The pair page mounts this only after it has consumed the URL fragment. iOS
 * drops the fragment when the installed copy is launched from its icon, so a
 * page that read the code after this step could find the address bar already
 * rewritten and the code gone.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type InstallKind = "hidden" | "android" | "ios" | "none";

/** True when this page is already running as an installed application. */
function runningInstalled(): boolean {
  if (typeof window === "undefined") return true;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  /* Older iOS reports it here and nowhere else. */
  const legacy = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return legacy === true;
}

/** True on an iPhone or an iPad, including an iPad that claims to be a Mac. */
function isAppleTouch(): boolean {
  if (typeof window === "undefined") return false;
  const agent = window.navigator.userAgent;
  if (/iphone|ipad|ipod/iu.test(agent)) return true;
  return /macintosh/iu.test(agent) && window.navigator.maxTouchPoints > 1;
}

export function PairInstallStep() {
  const t = useTranslations("hub");
  /* Hidden until the browser has had its say, so nothing flashes onto the
     screen of somebody already installed and then vanishes. */
  const [kind, setKind] = useState<InstallKind>("hidden");
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    if (runningInstalled()) return;
    if (isAppleTouch()) {
      setKind("ios");
      return;
    }
    /* Anything else waits on the one event that makes a button possible. */
    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
      setKind("android");
    };
    window.addEventListener("beforeinstallprompt", capture);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
    };
  }, []);

  const install = useCallback(() => {
    if (prompt === null) return;
    void prompt.prompt();
    /* An event can only be replayed once, whatever the answer was. */
    setPrompt(null);
    setKind("none");
  }, [prompt]);

  if (kind === "android") {
    return (
      <button
        type="button"
        onClick={install}
        className="lift-sm focus-ring inline-flex w-full items-center justify-center gap-2 rounded-lg border border-transparent bg-solid px-4 py-3 text-sm font-medium text-on-solid hover:bg-solid-hover"
      >
        {t("phoneInstall.add")}
      </button>
    );
  }

  if (kind === "ios") {
    return (
      <div className="rounded-2xl border border-hairline bg-surface p-5">
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-muted">
          <li>{t("phoneInstall.iosOne")}</li>
          <li>{t("phoneInstall.iosTwo")}</li>
          <li>{t("phoneInstall.iosThree")}</li>
        </ol>
      </div>
    );
  }

  return null;
}
