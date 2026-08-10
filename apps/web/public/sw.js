/**
 * The service worker for the OpenLimiter application shell.
 *
 * It exists for one reason: so the page at /app opens on a phone that has no
 * signal, and opens instantly the second time. It caches the shell, the build
 * assets that shell actually loads, and the icons, and it touches nothing else
 * on this origin. The marketing pages and the documentation are never cached
 * and never intercepted, so a deploy changes them the instant it lands.
 *
 * Three rules keep it from ever serving something out of date.
 *
 *   1. The cache name carries a version. On activate, every cache whose name
 *      is not the current one is deleted, so an old shell cannot survive a
 *      deploy.
 *   2. A page request goes to the network first and only falls back to the
 *      cache when the network fails. Fresh HTML always wins when it can be
 *      had, which is what stops a stale application shell after a deploy.
 *   3. Everything under /_next/static carries a content hash in its own name,
 *      so a file at one of those URLs can never change. Those are the only
 *      assets served cache first, and a deploy simply asks for different
 *      names.
 *
 * The install step fetches the shell once and reads the build asset URLs
 * straight out of the HTML it got back, which is the only way a worker with no
 * build step can know the hashed names. It is best effort throughout: a fetch
 * that fails costs the warm start and nothing else.
 *
 * It performs no analytics, contacts no third party, and stores nothing but
 * responses this origin already sent.
 */

/* Bump this string on any change to the shell or to this file. */
const VERSION = "openlimiter-app-v3";

/* The one path this worker is allowed to touch, and its assets. */
const SHELL = "/app";
const ASSETS = [
  "/app",
  "/manifest.webmanifest",
  "/icons/openlimiter-192.png",
  "/icons/openlimiter-512.png",
  "/icons/openlimiter-maskable-512.png",
];

/** Immutable build output. Hashed names, so cache first is always correct. */
const BUILD_PREFIX = "/_next/static/";

function ownsPath(pathname) {
  return (
    pathname === SHELL ||
    pathname.startsWith(SHELL + "/") ||
    pathname === "/manifest.webmanifest" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith(BUILD_PREFIX)
  );
}

/**
 * Every build asset the shell references, read out of the shell itself.
 *
 * The scripts, the stylesheet and the font the first paint needs all live at
 * hashed URLs this file cannot know ahead of time, and they are all present as
 * plain text in the HTML the server just sent. Pulling them out of that text
 * is what makes the second launch instant with no build step in the loop.
 */
async function shellAssets(cache) {
  const response = await fetch(SHELL, { cache: "reload" });
  if (!response.ok) return [];
  await cache.put(SHELL, response.clone());
  const html = await response.text();
  const found = html.match(/\/_next\/static\/[A-Za-z0-9._\-/]+/gu);
  if (found === null) return [];
  return [...new Set(found)];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then(async (cache) => {
        /* A single asset that will not fetch must not sink the whole install. */
        await Promise.allSettled(ASSETS.map((asset) => cache.add(asset)));
        try {
          const build = await shellAssets(cache);
          await Promise.allSettled(build.map((asset) => cache.add(asset)));
        } catch {
          /* No warm start this time. The worker is still perfectly useful. */
        }
      })
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
