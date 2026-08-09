"use client";

import { useEffect } from "react";

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
    if (!("serviceWorker" in navigator)) return;
    /* An insecure origin has no service worker, and that is fine: the page
       works without one, it simply will not open offline. */
    if (!window.isSecureContext) return;
    const register = (): void => {
      navigator.serviceWorker.register("/sw.js", { scope: "/app" }).catch(() => {
        /* A refused registration costs the offline copy and nothing else. */
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
