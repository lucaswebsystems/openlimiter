/**
 * Recapture the marketing screenshots, as theme pairs.
 *
 *   node scripts/capture-screenshots.mjs
 *
 * Eight files land in apps/web/public/screenshots:
 *
 *   desktop-app.png        the packaged window on a macOS style desk, dark
 *   desktop-app-light.png  the same scene and the same window, light
 *   phone-1..3.png         the web app at phone size, dark, one per view
 *   phone-1..3-light.png   the same three views, light
 *
 * WHAT IS IN THE PICTURES, AND WHAT IS NOT
 * ----------------------------------------
 * Every number is a synthetic fixture out of packages/connectors, normalised by
 * the same core the product runs, so no account, credential, path or real usage
 * figure can appear in a capture. The desktop window runs its real code against
 * a stubbed Tauri bridge that answers `read_cache` with those fixtures and
 * nothing else: the window does not know it is being photographed.
 *
 * The desk itself is drawn here, in our own palette. It is a macOS shaped scene
 * because the window is a macOS build, and not one pixel of it is an Apple
 * asset: the wallpaper is our aurora, the menu bar is schematic, and the window
 * chrome is a rectangle with three dots.
 *
 * REQUIREMENTS
 * ------------
 * A running production build of the site on the port below, for the phone
 * captures, and a built desktop window for the desk:
 *
 *   pnpm --dir apps/web build && pnpm --dir apps/web exec next start -p 3111
 *   node apps/desktop/scripts/build-ui.mjs
 *
 * Playwright is not a dependency of this repository, because nothing that ships
 * needs a browser. Install it where you run this:
 *
 *   npm i -g playwright && npx playwright install chromium
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..");
const DESKTOP_DIST = path.join(REPOSITORY, "apps", "desktop", "ui", "dist");
const OUTPUT = path.join(REPOSITORY, "apps", "web", "public", "screenshots");

/** Where the built site is already being served. Nothing is started here. */
const SITE = process.env.OPENLIMITER_SITE ?? "http://127.0.0.1:3111";

/** The desk, in CSS pixels, captured at two device pixels to the CSS pixel. */
const SCENE = { width: 1280, height: 800, scale: 2 };

/**
 * The phone, at the logical screen of the device the frames on the home page
 * are drawn as. 440 by 956 at two device pixels is 880 by 1912, and the frame
 * renders it edge to edge, so nothing is ever scaled on one axis only.
 */
const PHONE = { width: 440, height: 956, scale: 2 };

/** Geometry lifted from the capture this replaces, so the scene is unchanged. */
const MENUBAR_HEIGHT = 26;
const WINDOW = { left: 141, top: 93, width: 998, height: 642, titlebar: 37 };

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return require(name);
    } catch {
      /* Try the next one. */
    }
  }
  throw new Error(
    "Playwright is not resolvable from here. Install it, then run this again:\n" +
      "  npm i -g playwright && npx playwright install chromium",
  );
}

/* ------------------------------------------------------------------ *
 * The numbers in the pictures
 * ------------------------------------------------------------------ */

/**
 * Every bundled synthetic fixture, parsed and normalised exactly the way a
 * paste would be. This is the same set `openlimiter demo` and the web app's
 * demo mode use, which is why a capture and the demo agree to the decimal.
 */
async function demoSnapshots(now) {
  const engine = path.join(DESKTOP_DIST, "engine");
  const connectors = await import(
    pathToFileURL(path.join(engine, "connectors", "index.js")).href
  );
  const core = await import(pathToFileURL(path.join(engine, "core", "index.js")).href);
  return core.normalizeMeters([
    ...(connectors.parseClaudePayload(connectors.claudeFixture(now), now) ?? []),
    ...(connectors.parseOpenrouterPayload(connectors.openrouterFixture(), now) ?? []),
    ...(connectors.parseCodexPayload(connectors.codexFixture(now), now) ?? []),
    ...(connectors.parseAntigravityPayload(connectors.antigravityFixture(now), now) ?? []),
    ...(connectors.parseOpencodePayload(connectors.opencodeFixture(now), now) ?? []),
    ...(connectors.parseManualPayload(connectors.manualFixture(now), now) ?? []),
  ]);
}

/* ------------------------------------------------------------------ *
 * The desk
 * ------------------------------------------------------------------ */

/**
 * The wallpaper.
 *
 * Flowing colour bands in the spirit of a current macOS desktop, drawn from our
 * own tokens: the canvas dark underneath, the brand blue as the dominant band,
 * a violet neighbour it melts into, and one warm edge so the composition has
 * somewhere to end. Every band is an oversized ellipse under a heavy blur,
 * which is what gives the soft flowing boundary a gradient stop cannot.
 *
 * The grain on top is one inline SVG turbulence at four percent. It kills the
 * banding a wide blue to violet ramp shows on an eight bit display, and it is
 * the reason the picture reads as a photograph of a desk rather than as a CSS
 * gradient.
 */
const GRAIN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">' +
      '<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch"/>' +
      '<feColorMatrix type="saturate" values="0"/></filter>' +
      '<rect width="240" height="240" filter="url(#n)" opacity="0.5"/></svg>',
  );

const AURORA = {
  dark: {
    base: "linear-gradient(168deg, #07070b 0%, #0d0d0f 46%, #0b0a12 100%)",
    bands: [
      { x: "14%", y: "-6%", w: "78%", h: "82%", color: "rgba(8, 102, 255, 0.62)" },
      { x: "62%", y: "-14%", w: "70%", h: "78%", color: "rgba(108, 74, 240, 0.50)" },
      { x: "78%", y: "58%", w: "62%", h: "72%", color: "rgba(255, 138, 80, 0.26)" },
      { x: "-12%", y: "48%", w: "66%", h: "76%", color: "rgba(11, 90, 208, 0.42)" },
      { x: "34%", y: "72%", w: "58%", h: "58%", color: "rgba(125, 180, 255, 0.18)" },
    ],
    grain: 0.05,
    menubar: "rgba(9, 9, 13, 0.62)",
    menubarText: "#f4f4f6",
    menubarDim: "rgba(244, 244, 246, 0.78)",
    titlebar: "linear-gradient(180deg, #26262b 0%, #1d1d21 100%)",
    titlebarText: "rgba(250, 250, 250, 0.86)",
    windowBorder: "rgba(255, 255, 255, 0.10)",
    windowShadow:
      "0 2px 4px rgba(0, 0, 0, 0.36), 0 28px 60px -18px rgba(0, 0, 0, 0.72), 0 70px 140px -50px rgba(0, 0, 0, 0.85)",
    hairline: "rgba(255, 255, 255, 0.07)",
  },
  light: {
    base: "linear-gradient(168deg, #ffffff 0%, #f3f5fb 46%, #f8f4ff 100%)",
    bands: [
      { x: "14%", y: "-6%", w: "78%", h: "82%", color: "rgba(8, 102, 255, 0.30)" },
      { x: "62%", y: "-14%", w: "70%", h: "78%", color: "rgba(122, 92, 245, 0.26)" },
      { x: "78%", y: "58%", w: "62%", h: "72%", color: "rgba(255, 166, 110, 0.30)" },
      { x: "-12%", y: "48%", w: "66%", h: "76%", color: "rgba(11, 90, 208, 0.22)" },
      { x: "34%", y: "72%", w: "58%", h: "58%", color: "rgba(255, 255, 255, 0.55)" },
    ],
    grain: 0.035,
    menubar: "rgba(255, 255, 255, 0.66)",
    menubarText: "#16161a",
    menubarDim: "rgba(22, 22, 26, 0.78)",
    titlebar: "linear-gradient(180deg, #f0f0f2 0%, #e6e6e9 100%)",
    titlebarText: "rgba(13, 13, 15, 0.74)",
    windowBorder: "rgba(13, 13, 15, 0.14)",
    windowShadow:
      "0 2px 4px rgba(13, 13, 15, 0.10), 0 28px 60px -18px rgba(13, 13, 15, 0.26), 0 70px 140px -50px rgba(13, 13, 15, 0.34)",
    hairline: "rgba(13, 13, 15, 0.08)",
  },
};

const MENU_GLYPHS = `
<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M2.5 8.6a14 14 0 0 1 19 0M5.6 12.2a9.6 9.6 0 0 1 12.8 0M8.8 15.8a5 5 0 0 1 6.4 0"/><circle cx="12" cy="19.2" r="1.1" fill="currentColor" stroke="none"/></svg>
<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.6 15.6 4 4"/></svg>
<svg viewBox="0 0 30 24" width="19" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="8" width="21" height="10" rx="3"/><rect x="4" y="10" width="14" height="6" rx="1.6" fill="currentColor" stroke="none"/><path d="M25.4 11.6v4.2" stroke-linecap="round" stroke-width="2.4"/></svg>
`;

function scenePage(theme, windowUrl) {
  const skin = AURORA[theme];
  const bands = skin.bands
    .map(
      (band) =>
        `<span class="band" style="left:${band.x};top:${band.y};width:${band.w};height:${band.h};background:${band.color}"></span>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>scene</title><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${SCENE.width}px;height:${SCENE.height}px;overflow:hidden}
  body{font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  .desk{position:relative;width:100%;height:100%;background:${skin.base};overflow:hidden}
  .band{position:absolute;border-radius:50%;filter:blur(120px);will-change:transform}
  .grain{position:absolute;inset:0;background-image:url("${GRAIN}");background-size:240px 240px;opacity:${String(skin.grain)};mix-blend-mode:overlay;pointer-events:none}
  .menubar{position:absolute;inset:0 0 auto 0;height:${String(MENUBAR_HEIGHT)}px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;background:${skin.menubar};backdrop-filter:blur(28px);color:${skin.menubarText};font-size:13px;line-height:1}
  .menu-left{display:flex;align-items:center;gap:18px}
  .menu-left .app{font-weight:700}
  .menu-left span:not(.app){color:${skin.menubarDim}}
  .menu-right{display:flex;align-items:center;gap:13px;color:${skin.menubarDim}}
  .menu-right svg{display:block}
  .clock{font-size:13px;letter-spacing:0.01em}
  .window{position:absolute;left:${String(WINDOW.left)}px;top:${String(WINDOW.top)}px;width:${String(WINDOW.width)}px;height:${String(WINDOW.height)}px;border-radius:12px;overflow:hidden;border:1px solid ${skin.windowBorder};box-shadow:${skin.windowShadow}}
  .titlebar{position:relative;height:${String(WINDOW.titlebar)}px;display:flex;align-items:center;padding:0 16px;background:${skin.titlebar};border-bottom:1px solid ${skin.hairline}}
  .dots{display:flex;gap:8px}
  .dot{width:12px;height:12px;border-radius:50%}
  .title{position:absolute;left:0;right:0;text-align:center;font-size:13px;font-weight:500;color:${skin.titlebarText};pointer-events:none}
  iframe{display:block;width:100%;height:${String(WINDOW.height - WINDOW.titlebar)}px;border:0;background:transparent}
</style></head>
<body><div class="desk">
  ${bands}
  <div class="grain"></div>
  <div class="menubar">
    <div class="menu-left"><span class="app">OpenLimiter</span><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span></div>
    <div class="menu-right">${MENU_GLYPHS}<span class="clock">Tue 21:41</span></div>
  </div>
  <div class="window">
    <div class="titlebar">
      <div class="dots"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span></div>
      <div class="title">OpenLimiter</div>
    </div>
    <iframe src="${windowUrl}" title="OpenLimiter"></iframe>
  </div>
</div></body></html>`;
}

/**
 * The window's own page, with one thing added: a Tauri bridge that answers out
 * of the fixtures instead of out of a real machine.
 *
 * A classic inline script runs before any deferred module, so the stub is in
 * place before app.js reads it, and app.js is byte for byte the shipped file.
 */
async function windowPage(theme, snapshots) {
  const html = await readFile(path.join(DESKTOP_DIST, "index.html"), "utf8");
  const cache = JSON.stringify(JSON.stringify({ version: 1, snapshots }));
  const stub = `<script>
      window.localStorage.setItem("openlimiter-theme", ${JSON.stringify(theme)});
      document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)});
      window.__TAURI__ = {
        core: {
          invoke: function (name) {
            if (name === "read_cache") return Promise.resolve(${cache});
            if (name === "read_manual") return Promise.resolve("");
            if (name === "state_directory") return Promise.resolve("the demo fixtures");
            return Promise.resolve(null);
          }
        },
        event: { listen: function () { return Promise.resolve(function () {}); } }
      };
    </script>`;
  return html.replace('<script type="module"', stub + '\n    <script type="module"');
}

/* ------------------------------------------------------------------ *
 * A static server for the desk, so everything is one origin
 * ------------------------------------------------------------------ */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function startDesk(pages) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const page = pages.get(url.pathname);
    if (page !== undefined) {
      response.writeHead(200, { "content-type": TYPES[".html"] });
      response.end(page);
      return;
    }
    const file = path.join(DESKTOP_DIST, path.normalize(url.pathname).replace(/^[\\/]+/u, ""));
    if (!file.startsWith(DESKTOP_DIST)) {
      response.writeHead(403).end();
      return;
    }
    readFile(file)
      .then((body) => {
        response.writeHead(200, {
          "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(404).end();
      });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/**
 * The installed state, applied by hand.
 *
 * A phone capture should show the application, not a marketing header above a
 * picture of one, and the route already hides the site chrome under
 * `display-mode: standalone`. Chromium's media emulation does not reliably
 * carry that feature through a navigation, so the same three rules the route's
 * own stylesheet applies are injected instead. Nothing here invents a state the
 * product does not have: an installed copy renders exactly this.
 *
 * The launch splash is deliberately not brought along, because a capture of a
 * splash screen is a capture of nothing, and the development overlay is not
 * part of the product at all.
 */
const STANDALONE = [
  "body > nav, body > footer { display: none !important; }",
  ".ol-appmark-small { display: none !important; }",
  ".ol-appmark-full { display: flex !important; }",
  "nextjs-portal { display: none !important; }",
  /* The safe area, which a headless browser reports as zero and a phone with an
     island reports as about 59 pixels. The route already spends
     `env(safe-area-inset-top)` here, so this only supplies the number the device
     would have supplied, and it is what keeps the frame's island from landing on
     the first line of the page. */
  ".ol-shell { padding-top: 62px !important; }",
].join("\n");

const PHONE_VIEWS = [
  { file: "phone-1", tab: "tab-meters" },
  { file: "phone-2", tab: "tab-context" },
  { file: "phone-3", tab: "tab-connections" },
];

async function capturePhone(browser, theme, snapshots) {
  const context = await browser.newContext({
    viewport: { width: PHONE.width, height: PHONE.height },
    deviceScaleFactor: PHONE.scale,
    colorScheme: theme,
    isMobile: true,
    hasTouch: true,
  });
  /* Demo mode, in the demo store, exactly the way the application writes it. */
  await context.addInitScript(
    ([kind, rows]) => {
      window.localStorage.setItem("openlimiter-theme", kind);
      window.localStorage.setItem("openlimiter-app-mode", "demo");
      window.localStorage.setItem("openlimiter-app-demo", rows);
      window.localStorage.setItem("openlimiter-app-view", "grid");
    },
    [theme, JSON.stringify(snapshots)],
  );
  const page = await context.newPage();
  /*
   * Installed, not in a tab.
   *
   * The route hides the site header and footer under `display-mode: standalone`
   * and swaps the dashboard's small mark for the full lockup, which is the
   * state a phone capture should show: a marketing nav across the top of a
   * picture of an application is the wrong picture. Playwright has no first
   * class switch for that media feature, so it goes through the protocol, and
   * the colour scheme goes with it because this call replaces the whole set.
   */
  const written = [];
  for (const view of PHONE_VIEWS) {
    await page.goto(SITE + "/app", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("html[data-ol-ready]", { state: "attached" });
    await page.addStyleTag({ content: STANDALONE });
    await page.click("#" + view.tab);
    /* The launch splash clears at 760ms, the busy floor is 240ms, and the
       reveal animations are shorter than either. */
    await page.waitForTimeout(1600);
    const name = view.file + (theme === "light" ? "-light" : "") + ".png";
    await page.screenshot({ path: path.join(OUTPUT, name) });
    written.push(name);
  }
  await context.close();
  return written;
}

async function captureDesk(browser, theme, port) {
  const context = await browser.newContext({
    viewport: { width: SCENE.width, height: SCENE.height },
    deviceScaleFactor: SCENE.scale,
    colorScheme: theme,
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${String(port)}/scene-${theme}`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(1200);
  const name = theme === "light" ? "desktop-app-light.png" : "desktop-app.png";
  await page.screenshot({ path: path.join(OUTPUT, name) });
  await context.close();
  return name;
}

async function main() {
  const { chromium } = loadPlaywright();
  const now = new Date().toISOString();
  const snapshots = await demoSnapshots(now);
  if (snapshots.length === 0) {
    throw new Error("The fixtures produced no snapshots. Run pnpm build first.");
  }

  const pages = new Map();
  for (const theme of ["dark", "light"]) {
    pages.set("/window-" + theme, await windowPage(theme, snapshots));
  }
  const { server, port } = await startDesk(pages);
  for (const theme of ["dark", "light"]) {
    pages.set("/scene-" + theme, scenePage(theme, `/window-${theme}`));
  }

  /* A machine that already has a Chromium can name it rather than downloading
     a second one. Empty means let Playwright resolve its own. */
  const executablePath = process.env.OPENLIMITER_CHROMIUM;
  const browser = await chromium.launch(
    executablePath === undefined || executablePath === "" ? {} : { executablePath },
  );
  const written = [];
  try {
    for (const theme of ["dark", "light"]) {
      written.push(await captureDesk(browser, theme, port));
      written.push(...(await capturePhone(browser, theme, snapshots)));
    }
  } finally {
    await browser.close();
    server.close();
  }

  for (const name of written.sort()) {
    const info = await stat(path.join(OUTPUT, name));
    process.stdout.write(name.padEnd(24) + String(info.size).padStart(9) + " bytes\n");
  }
}

await main();
