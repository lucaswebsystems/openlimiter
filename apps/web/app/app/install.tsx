"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "./sheet";
import { Button } from "./pieces";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallPath =
  | "pending"
  | "installed"
  | "prompt"
  | "menu"
  | "ios"
  | "inAppBrowser"
  | "manual";

export function runningInstalled(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function detectInstallPath(agent: string, hasPrompt: boolean, installed: boolean): InstallPath {
  if (installed) return "installed";
  if (hasPrompt) return "prompt";
  const ios = /iphone|ipad|ipod/iu.test(agent) ||
    (/macintosh/iu.test(agent) && /mobile/iu.test(agent));
  if (ios) {
    const safari = /version\/.*safari\//iu.test(agent) &&
      !/crios|fxios|edgios|opios|opt\/|gsa\//iu.test(agent);
    return safari ? "ios" : "inAppBrowser";
  }
  if (/android/iu.test(agent)) return "menu";
  return "manual";
}

function ShareGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5m-3.8 3.6L12 3.5l3.8 3.6M6.5 11H5.2a1.7 1.7 0 0 0-1.7 1.7v6.6A1.7 1.7 0 0 0 5.2 21h13.6a1.7 1.7 0 0 0 1.7-1.7v-6.6a1.7 1.7 0 0 0-1.7-1.7h-1.3" /></svg>;
}

function AddGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" /><path d="M12 8.4v7.2M8.4 12h7.2" /></svg>;
}

function DownloadGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11m-4.2-4.1 4.2 4.1 4.2-4.1M4.5 19.5h15" /></svg>;
}

function CheckGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7" /></svg>;
}

function InstallSheet({ path, open, onClose, returnFocus }: {
  path: InstallPath;
  open: boolean;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}) {
  const t = useTranslations("hub.install");
  return (
    <Sheet open={open} title={t("title")} closeLabel={t("close")} onClose={onClose} returnFocus={returnFocus}>
      <div className="ol-sheet-body">
      {path === "inAppBrowser" ? (
        <p className="mt-4 rounded-lg border border-hairline bg-raised px-3 py-3 text-sm leading-relaxed text-body">
          {t("openSafari")}
        </p>
      ) : path === "menu" ? (
        <p className="mt-4 rounded-lg border border-hairline bg-raised px-3 py-3 text-sm leading-relaxed text-body">
          {t("menu")}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("what")}</p>
          <ol className="ol-install-steps">
            <li><span><ShareGlyph /></span><p><strong>1.</strong> {t("stepShare")}</p></li>
            <li><span><AddGlyph /></span><p><strong>2.</strong> {t("stepChoose")}</p></li>
            <li><span><CheckGlyph /></span><p><strong>3.</strong> {t("stepAdd")}</p></li>
          </ol>
          {path === "manual" && (
            <p className="mt-4 rounded-lg border border-hairline bg-raised px-3 py-3 text-sm leading-relaxed text-body">
              {t("menu")}
            </p>
          )}
        </>
      )}
      </div>
      <div className="mt-5 flex justify-end">
        <Button tone="primary" className="ol-install-done" onClick={onClose}>{t("done")}</Button>
      </div>
    </Sheet>
  );
}

export interface InstallControlHandle {
  activate: (returnFocus?: HTMLElement) => void;
}

export const InstallControl = forwardRef<InstallControlHandle, {
  showButton?: boolean;
  compact?: boolean;
  onInstalledChange?: (installed: boolean) => void;
}>(function InstallControl({ showButton = true, compact = false, onInstalledChange }, forwardedRef) {
  const t = useTranslations("hub.install");
  const [path, setPath] = useState<InstallPath>("pending");
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [sheet, setSheet] = useState(false);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const installed = runningInstalled();
    setPath(detectInstallPath(navigator.userAgent, false, installed));
    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
      setPath("prompt");
    };
    const done = () => {
      setPrompt(null);
      setSheet(false);
      setPath("installed");
    };
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", done);
    };
  }, []);

  useEffect(() => {
    onInstalledChange?.(path === "installed");
  }, [onInstalledChange, path]);

  const activate = useCallback((node?: HTMLElement) => {
    const focus = node ?? trigger.current;
    setReturnFocus(focus ?? null);
    if (path === "installed") {
      focus?.focus();
      return;
    }
    if (path === "prompt" && prompt !== null) {
      void prompt.prompt().then(() => prompt.userChoice).then((choice) => {
        if (choice.outcome === "accepted") setPath("pending");
        else setPath(detectInstallPath(navigator.userAgent, false, false));
      }).catch(() => setPath(detectInstallPath(navigator.userAgent, false, false)));
      setPrompt(null);
      return;
    }
    setSheet(true);
  }, [path, prompt]);

  useImperativeHandle(forwardedRef, () => ({ activate }), [activate]);

  if (!showButton || path === "pending" || path === "installed") {
    return (
      <InstallSheet path={path} open={sheet} onClose={() => setSheet(false)} returnFocus={returnFocus} />
    );
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={compact ? "ol-install-row focus-ring" : "ol-install-button focus-ring"}
        onClick={() => activate()}
      >
        <DownloadGlyph />
        {t("action")}
      </button>
      <InstallSheet path={path} open={sheet} onClose={() => setSheet(false)} returnFocus={returnFocus} />
    </>
  );
});
