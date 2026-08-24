"use client";

import { useEffect } from "react";

const SERVICE_WORKER_PROTOCOL = "5";

function buildKey(): string {
  const assets = Array.from(document.scripts)
    .map((script) => script.src)
    .filter((source) => source.includes("/_next/static/"))
    .sort()
    .join("|");
  let hash = 2_166_136_261;
  for (let index = 0; index < assets.length; index += 1) {
    hash ^= assets.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${SERVICE_WORKER_PROTOCOL}-${(hash >>> 0).toString(36)}`;
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
        if (!hadController || reloading) return;
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
