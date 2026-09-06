"use client";

import { useEffect } from "react";

const SERVICE_WORKER_PROTOCOL = "5";

const RELOAD_MARK = "ol-sw-reload-at";
const RELOAD_GUARD_MS = 30_000;

/**
 * The key changes once per deploy and never within one. It is inlined at
 * build time from next.config.ts; the previous version hashed the page's
 * script tags, which Next extends as it prefetches routes, so consecutive
 * loads registered different worker URLs and reloaded each other forever.
 */
function buildKey(): string {
  const build = process.env.NEXT_PUBLIC_BUILD_KEY ?? "static";
  return `${SERVICE_WORKER_PROTOCOL}-${build.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}`;
}

function reloadedRecently(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_MARK) ?? "0");
    if (Date.now() - last < RELOAD_GUARD_MS) return true;
    window.sessionStorage.setItem(RELOAD_MARK, String(Date.now()));
  } catch {
    /* Storage can be unavailable; a missing guard is not worth a crash. */
  }
  return false;
}

/**
 * Register the application shell's service worker, and only here.
 *
 * This component is rendered by the /app layout and nowhere else, so a visitor
 * who only ever reads the marketing pages or the documentation never installs
 * a worker at all. The scope is narrowed to /app for the same reason: even
 * once it is installed, the worker is not allowed to answer for the rest of
 * the site.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    /* An insecure origin has no service worker, and that is fine: the page
       works without one, it simply will not open offline. */
    if (!window.isSecureContext) return;
    const register = (): void => {
      const hadController = navigator.serviceWorker.controller !== null;
      let reloading = false;
      const update = (): void => {
        if (!hadController || reloading || reloadedRecently()) return;
        reloading = true;
        window.location.reload();
      };
      navigator.serviceWorker.addEventListener("controllerchange", update, { once: true });
      navigator.serviceWorker
        .register(`/sw.js?build=${buildKey()}`, {
          scope: "/app",
          updateViaCache: "none",
        })
        .then((registration) => registration.update())
        .catch(() => {
          navigator.serviceWorker.removeEventListener("controllerchange", update);
        });
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
    };
  }, []);
  return null;
}
