/**
 * The service worker for the OpenLimiter application shell.
 *
 * It exists for one reason: so the page at /app opens on a phone that has no
 * signal. It caches the shell and the icons, and it touches nothing else on
 * this origin. The marketing pages and the documentation are never cached and
 * never intercepted, so a deploy changes them the instant it lands.
 *
 * Two rules keep it from ever serving something out of date.
 *
 *   1. The cache name carries a version. On activate, every cache whose name
 *      is not the current one is deleted, so an old shell cannot survive a
 *      deploy.
 *   2. A page request goes to the network first and only falls back to the
 *      cache when the network fails. Fresh HTML always wins when it can be
 *      had, which is what stops a stale application shell after a deploy.
 *
 * It performs no analytics, contacts no third party, and stores nothing but
 * responses this origin already sent.
 */

/* Bump this string on any change to the shell or to this file. */
const VERSION = "openlimiter-app-v1";

/* The one path this worker is allowed to touch, and its assets. */
const SHELL = "/app";
const ASSETS = [
  "/app",
  "/manifest.webmanifest",
  "/icons/openlimiter-192.png",
  "/icons/openlimiter-512.png",
  "/icons/openlimiter-maskable-512.png",
];

function ownsPath(pathname) {
  return pathname === SHELL || pathname.startsWith(SHELL + "/") ||
    pathname === "/manifest.webmanifest" || pathname.startsWith("/icons/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      /* A single asset that will not fetch must not sink the whole install. */
      .then((cache) => Promise.allSettled(ASSETS.map((asset) => cache.add(asset))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("openlimiter-app-") && name !== VERSION)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  /* Anything on another origin, or anywhere else on this one, is left alone.
     Not calling respondWith is what hands the request back to the browser. */
  if (url.origin !== self.location.origin) return;
  if (!ownsPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() =>
          caches
            .match(SHELL)
            .then((cached) =>
              cached ??
              new Response(
                "<!doctype html><meta charset=utf-8><title>OpenLimiter</title>" +
                  "<p>This device is offline and the application shell was never cached.</p>",
                { headers: { "content-type": "text/html; charset=utf-8" }, status: 503 },
              ),
            ),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached !== undefined) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
