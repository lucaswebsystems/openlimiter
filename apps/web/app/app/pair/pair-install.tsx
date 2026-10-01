"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

/**
 * Adding the paired page to the phone's home screen, as one short row.
 *
 * The two platforms that matter expose completely different amounts of help,
 * and this component asks each for exactly what it offers:
 *
 *   Chrome on Android fires `beforeinstallprompt` when the page qualifies.
 *   Holding that event and replaying it from one button is the whole install:
 *   one press, the platform's own sheet, done. Chrome only fires it after the
 *   reader has tapped and lingered, so when it has not come within a moment
 *   the row says where Chrome's own menu item is instead. Rendering nothing
 *   there left the reader with no install at all.
 *
 *   iOS Safari fires nothing and exposes no API. The only honest thing the
 *   page can do there is point at the Share button, drawn, and name the item.
 *   Any other iOS browser or app webview either lacks that item or installs
 *   without the cookie copy Safari makes, so it is sent to Safari.
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

type InstallKind = "hidden" | "android" | "androidMenu" | "ios" | "safari" | "none";

/** How long Chrome gets to offer its own prompt before the menu line shows. */
export const ANDROID_PROMPT_WAIT = 3_000;

/** True when this page is already running as an installed application. */
export function runningInstalled(): boolean {
  if (typeof window === "undefined") return true;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  /* Older iOS reports it here and nowhere else. */
  const legacy = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return legacy === true;
}

function isIos(): boolean {
  return /iphone|ipad|ipod/iu.test(window.navigator.userAgent);
}

/**
 * True only for actual Safari on an iPhone or an iPad.
 *
 * Every browser on iOS embeds WebKit, so Chrome, Firefox and Edge carry
 * "Safari" in their user agent too and are ruled out by name. An app's own
 * webview (a QR scanner, the Google app) has no "Version/" token, which real
 * Safari always sends.
 */
function isIosSafari(): boolean {
  const agent = window.navigator.userAgent;
  return /version\/.*safari\//iu.test(agent) && !/crios|fxios|edgios|opios|opt\//iu.test(agent);
}

/**
 * True only when the platform itself is Android.
 *
 * `beforeinstallprompt` is a Chromium feature, not an Android one: desktop
 * Chrome and Chrome OS fire it too, for the same reasons a desktop tab can be
 * "installed" as an app window. Gating on the user agent is what keeps a
 * desktop visitor from seeing a row drawn for a phone.
 */
function isAndroidUserAgent(): boolean {
  return /android/iu.test(window.navigator.userAgent);
}

/** The iOS Share symbol, drawn here: a tray open at the top, an arrow leaving it. */
function ShareGlyph({ label }: { label: string }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 24 24"
      className="h-6 w-6 flex-none text-brand"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M9 10H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2" />
    </svg>
  );
}

const ROW =
  "flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-surface px-4 py-3 text-sm font-medium text-heading";

export function PairInstallStep() {
  const t = useTranslations("hub");
  /* Hidden until the browser has had its say, so nothing flashes onto the
     screen of somebody already installed and then vanishes. */
  const [kind, setKind] = useState<InstallKind>("hidden");
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    if (runningInstalled()) return;
    if (isIos()) {
      setKind(isIosSafari() ? "ios" : "safari");
      return;
    }
    if (!isAndroidUserAgent()) return;
    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
      setKind("android");
    };
    const fallback = window.setTimeout(() => {
      setKind((current) => (current === "hidden" ? "androidMenu" : current));
    }, ANDROID_PROMPT_WAIT);
    window.addEventListener("beforeinstallprompt", capture);
    return () => {
      window.clearTimeout(fallback);
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
      <p role="status" aria-live="polite" className={ROW}>
        <ShareGlyph label={t("phoneInstall.share")} />
        <span aria-hidden="true" className="text-muted">→</span>
        <span>{t("phoneInstall.ios")}</span>
      </p>
    );
  }

  if (kind === "safari" || kind === "androidMenu") {
    return (
      <p role="status" aria-live="polite" className={ROW}>
        {kind === "safari" ? t("phoneInstall.openSafari") : t("phoneInstall.androidMenu")}
      </p>
    );
  }

  return null;
}
