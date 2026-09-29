/**
 * Recapture the marketing screenshots, as theme pairs.
 *
 *   node scripts/capture-screenshots.mjs
 *
 * Sixteen files land in apps/web/public/screenshots:
 *
 *   desktop-app.png        the packaged window on a macOS style desk, dark
 *   desktop-app-light.png  the same scene and the same window, light
 *   phone-1..3.png         the web app at phone size, dark, one per view
 *   phone-1..3-light.png   the same three views, light
 *   rail-folded*.png       the real Rail folded, dark and light
 *   rail-unfolded*.png     the real Rail and attention card, dark and light
 *   desktop-home*.png      Home with the real Agents list, dark and light
 *   terminal-statusline*.png  real CLI ANSI output, dark and light
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
 *   Build the web app with synthetic public configuration only:
 *   NEXT_PUBLIC_SUPABASE_URL=https://capture.openlimiter.invalid
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=capture-only
 *   then serve that build on 127.0.0.1:3111.
 *   node apps/desktop/scripts/build-ui.mjs
 *
 * Uses the web app's installed Playwright. Run with a disposable profile for
 * HOME, USERPROFILE, APPDATA, LOCALAPPDATA and all XDG directories. No desktop
 * executable is started. All browser contexts reject nonlocal network traffic.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ansiHtml, assertCaptureSafe, demoSessions } from "./capture-screenshots-sanitize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..");
const DESKTOP_DIST = path.join(REPOSITORY, "apps", "desktop", "ui", "dist");
const OUTPUT = path.join(REPOSITORY, "apps", "web", "public", "screenshots");
const WALLPAPER = path.join(REPOSITORY, ".media", "images", "image_001.png");

/** Where the built site is already being served. Nothing is started here. */
const SITE = process.env.OPENLIMITER_SITE ?? "http://127.0.0.1:3111";

/** The desk, in CSS pixels, captured at two device pixels to the CSS pixel. */
const SCENE = { width: 1280, height: 800, scale: 2 };

/**
 * The phone, at the logical screen of the device the frames on the home page
 * are drawn as. 390 by 844 at three device pixels is 1170 by 2532.
 */
const PHONE = { width: 390, height: 844, scale: 3 };

/** Geometry lifted from the capture this replaces, so the scene is unchanged. */
const MENUBAR_HEIGHT = 26;
const WINDOW = { left: 141, top: 93, width: 998, height: 642, titlebar: 37 };

function loadPlaywright() {
  const require = createRequire(path.join(REPOSITORY, "apps/web/package.json"));
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return require(name);
    } catch {
      /* Try the next one. */
    }
  }
  if (process.env.APPDATA) {
    const globalPath = path.join(process.env.APPDATA, "npm", "node_modules");
    try {
      const globalRequire = createRequire(path.join(globalPath, "index.js"));
      for (const name of ["playwright", "playwright-core"]) {
        try {
          return globalRequire(name);
        } catch {
          /* Try next */
        }
      }
    } catch {
      /* Ignored */
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
 * Synthetic fixture readings stamped like a real machine (statusline
 * provenance for Claude, fresh states, plausible as of timestamps).
 */
export async function demoSnapshots(now) {
  const engine = path.join(DESKTOP_DIST, "engine");
  // Import the packaged readers directly. The desktop bundle intentionally
  // contains a subset of the connector package's barrel exports.
  const connectors = Object.assign({}, ...await Promise.all(
    ["fixtures", "claude", "openrouter", "codex", "antigravity", "opencode", "manual"].map(name =>
      import(pathToFileURL(path.join(engine, "connectors", `${name}.js`)).href)),
  ));
  const core = await import(pathToFileURL(path.join(engine, "core", "index.js")).href);
  const rawSnapshots = core.normalizeMeters([
    ...(connectors.parseClaudePayload(connectors.claudeFixture(now), now) ?? []),
    ...(connectors.parseOpenrouterPayload(connectors.openrouterFixture(), now) ?? []),
    ...(connectors.parseCodexPayload(connectors.codexFixture(now), now) ?? []),
    ...(connectors.parseAntigravityPayload(connectors.antigravityFixture(now), now) ?? []),
    ...(connectors.parseOpencodePayload(connectors.opencodeFixture(now), now) ?? []),
    ...(connectors.parseManualPayload(connectors.manualFixture(now), now) ?? []),
  ]);
  const futureExpiry = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  return rawSnapshots.map((snapshot) => {
    const stamped = {
      ...snapshot,
      observedAt: now,
      expiresAt: futureExpiry,
    };
    if (snapshot.provider === "CLAUDE") {
      stamped.provenance = {
        sourceKind: "statusline_payload",
        observedVia: "claude_code_statusline",
      };
    }
    return stamped;
  });
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

async function scenePage(theme, windowUrl) {
  const skin = AURORA[theme];
  /* The desk is a photograph now, Lucas's call (2026-08-10): a nature
     landscape in the spirit of a current macOS default, generated on this
     machine so there is no third party licence, frozen in the media ledger.
     One picture for both themes, exactly as a real desk keeps its wallpaper
     when the system theme flips; the aurora skin still paints the menu bar,
     the title bar and the window chrome, and its base gradient stays
     underneath as the paint before the photograph arrives. */
  const wallpaper = `data:image/png;base64,${(await readFile(WALLPAPER)).toString("base64")}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>scene</title><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${SCENE.width}px;height:${SCENE.height}px;overflow:hidden}
  body{font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  .desk{position:relative;width:100%;height:100%;background:url("${wallpaper}") center / cover no-repeat, ${skin.base};overflow:hidden}
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
export async function windowPage(theme, snapshots, sessions) {
  const html = await readFile(path.join(DESKTOP_DIST, "index.html"), "utf8");
  const cache = JSON.stringify(JSON.stringify({ version: 1, snapshots }));
  /* A returning user: first run finished with the pictured providers set up,
     so Home is on screen rather than the first run sheet. The keys come from
     the shipped modules so a version bump cannot quietly hide Home again. */
  const { FIRST_RUN_STORAGE_KEY } = await import(pathToFileURL(path.join(DESKTOP_DIST, "first-run.js")).href);
  const { CONFIGURED_PROVIDERS_STORAGE_KEY } = await import(pathToFileURL(path.join(DESKTOP_DIST, "configured-providers.js")).href);
  const configured = JSON.stringify([...new Set(snapshots.map((row) => row.provider))]);
  const stub = `<script>
      window.localStorage.setItem("openlimiter-theme", ${JSON.stringify(theme)});
      window.localStorage.setItem(${JSON.stringify(FIRST_RUN_STORAGE_KEY)}, "complete");
      window.localStorage.setItem(${JSON.stringify(CONFIGURED_PROVIDERS_STORAGE_KEY)}, ${JSON.stringify(configured)});
      document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)});
      window.__TAURI__ = {
        core: {
          invoke: function (name) {
            if (name === "read_cache") return Promise.resolve(${cache});
            /* The Rust AccountStatus of a signed out release build. A null here
               throws in first run before it can check the stored completion. */
            if (name === "account_status") return Promise.resolve({configured:true,signedIn:false,email:null,syncEnabled:true,backendReachable:true});
            if (name === "plugin:activity|activity_sessions") return Promise.resolve(${JSON.stringify(sessions)});
            if (name === "plugin:activity|activity_notification_preferences") return Promise.resolve({local:{enabled:true,quietHours:null,mutedProviders:[]},sound:"silent"});
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

export async function railPage(theme, sessions, now) {
  const html = await readFile(path.join(DESKTOP_DIST, "rail.html"), "utf8");
  const accounts = [["claude", 42, "green"]].map(([provider, value, band]) => ({ provider, account: "", headlineMeterId: "SESSION",
    kind: "quota_percent", availability: "available", value, meaning: "used", band,
    freshness: "fresh", windowLabel: "Session", observedAt: now,
    resetAt: new Date(Date.parse(now) + 7200000).toISOString() }));
  const stub = `<script>
    localStorage.setItem("openlimiter-theme", ${JSON.stringify(theme)});
    window.__TAURI__ = {core:{invoke:async function(name) {
      if (name === "plugin:rail|rail_snapshot") return {
        accounts:${JSON.stringify(accounts)}, sessions:${JSON.stringify(sessions)},
        window:{unfolded:location.search.includes("unfolded"),keepOpen:false,cardOpen:true,offset:0}
      };
      return null;
    }}};
  </script>`;
  return html.replace('<script type="module"', stub + '<script type="module"');
}

export async function terminalPage(theme, snapshots, now) {
  const { renderStatuslineLayout } = await import(pathToFileURL(path.join(REPOSITORY, "packages/cli/dist/statusline.js")));
  const { DEFAULT_STATUSLINE } = await import(pathToFileURL(path.join(REPOSITORY, "packages/cli/dist/config.js")));
  const seen = new Set();
  const rows = snapshots.filter(row => {
    if (row.unit !== "PERCENT" || row.usedAmount !== undefined || row.provider === "OPENROUTER" || seen.has(row.provider)) return false;
    seen.add(row.provider); return true;
  }).slice(0, 4)
    .map((row, index) => ({ ...row, value: [42, 64, 84, 94][index] }));
  const output = renderStatuslineLayout({ snapshots: rows, now, config: DEFAULT_STATUSLINE,
    advice: { inject: false, reason: "UNKNOWN" }, host: "shell", color: true, unicode: true });
  const body = ansiHtml(output);
  for (const band of ["green", "yellow", "orange", "red"]) {
    if (!body.includes(`band-${band}`)) throw new Error(`CLI capture did not render ${band}.`);
  }
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">
    <link rel="stylesheet" href="engine/ui/tokens.css"><style>
      *{box-sizing:border-box}body{margin:0;padding:44px;background:var(--ol-canvas);color:var(--ol-body);font-family:var(--ol-font-sans)}
      p{font-size:16px;color:var(--ol-muted)}pre{margin-top:34px;font:19px/2 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      ${["green", "yellow", "orange", "red"].map(b => `.band-${b}{color:var(--ol-band-${b}-label)}`).join("")}
    </style></head><body><p>openlimiter statusline</p><pre>${body}</pre></body></html>`;
}

async function captureProductDetails(browser, theme, port) {
  const origin = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block" });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const names = [];
  const shoot = async name => {
    for (const frame of page.frames()) assertCaptureSafe(await frame.locator("body").innerText());
    const file = `${name}${theme === "light" ? "-light" : ""}.png`;
    await page.screenshot({ path: path.join(OUTPUT, file) }); names.push(file);
  };
  try {
    await page.goto(`${origin}/window-${theme}`, { waitUntil: "networkidle" });
    await page.locator(".agents-row").nth(2).waitFor();
    await page.locator("#agents-mount").scrollIntoViewIfNeeded();
    await shoot("desktop-home");
    await page.setViewportSize({ width: 640, height: 400 });
    for (const state of ["folded", "unfolded"]) {
      const desk = `<iframe src="${origin}/scene-${theme}" style="position:absolute;width:1280px;height:800px;transform:scale(.5);transform-origin:top left;border:0"></iframe>`;
      const rail = `<iframe src="${origin}/rail-${theme}?${state}" style="position:absolute;left:0;top:12px;width:${state === "folded" ? 8 : 56}px;height:380px;border:0"></iframe>`;
      const card = state === "unfolded" ? `<iframe src="${origin}/rail-${theme}?card" style="position:absolute;left:72px;top:12px;width:350px;height:380px;border:0"></iframe>` : "";
      await page.setContent(`<body style="margin:0">${desk}${rail}${card}</body>`);
      await page.waitForTimeout(500);
      for (const frame of page.frames().filter(frame => frame.url().includes("/rail-"))) await frame.locator('[data-agent="waiting"]').waitFor();
      await shoot(`rail-${state}`);
    }
    await page.setViewportSize({ width: 1200, height: 300 });
    await page.goto(`${origin}/terminal-${theme}`, { waitUntil: "networkidle" });
    await shoot("terminal-statusline");
  } finally { await context.close(); }
  return names;
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
  /* The installed app hides the marketing chrome. Names the header's
     class AND both element shapes, because the capture is the only guard
     this contract has: Sol caught this rule still matching an element the
     header stopped being months of commits ago. */
  ".site-header, body > nav, body > footer, body > footer, footer { display: none !important; }",
  ".ol-appmark-small { display: none !important; }",
  ".ol-appmark-full { display: flex !important; }",
  "nextjs-portal { display: none !important; }",
  /* The safe area, which a headless browser reports as zero and a phone with an
     island reports as about 59 pixels. The route already spends
     `env(safe-area-inset-top)` here, so this only supplies the number the device
     would have supplied, and it is what keeps the frame's island from landing on
     the first line of the page. */
  ".ol-shell { padding-top: 40px !important; }",
].join("\n");

/* Each view names the text that proves its panel actually hydrated. The old
   fixed 1600ms wait stopped being enough when the bundle grew with the locale
   wave, and a capture of the loading skeleton looked like an open sheet over
   a blurred void. Waiting for real content cannot rot the same way. */
const PHONE_VIEWS = [
  { file: "phone-1", scrollY: 0 },
  { file: "phone-2", scrollY: 500 },
  { file: "phone-3", scrollY: 1000 },
];

async function capturePhone(browser, theme, snapshots, now) {
  const context = await browser.newContext({
    viewport: { width: PHONE.width, height: PHONE.height },
    deviceScaleFactor: PHONE.scale,
    colorScheme: theme,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  // Build the local site with NEXT_PUBLIC_SUPABASE_URL=https://capture.openlimiter.invalid
  // and NEXT_PUBLIC_SUPABASE_ANON_KEY=capture-only. No real service is contacted.
  const api = "https://capture.openlimiter.invalid";
  const user = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated",
    user_metadata: { full_name: "Demo", openlimiter_onboarded: true }, app_metadata: { provider: "github" }, created_at: now };
  const session = { access_token: "capture-only", refresh_token: "capture-only", token_type: "bearer", expires_in: 86400,
    expires_at: Math.floor(Date.parse(now) / 1000) + 86400, user };
  let syncedReads = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === api) {
      const action = route.request().postDataJSON()?.action;
      let body = {};
      if (url.pathname.startsWith("/auth/")) body = user;
      else if (action === "read_usage") {
        syncedReads++;
        body = { rows: snapshots.filter(row => row.unit === "PERCENT").map(row => ({
          provider: row.provider, account_id: "demo", window_id: row.meter, used_percent: row.value,
          resets_at: row.resetAt, observed_at: now, stale: false,
        })) };
      } else if (url.pathname.endsWith("/entitlement")) body = { entitlement: null, devices: [] };
      else body = { rows: [], keys: [] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    }
    if (url.origin === new URL(SITE).origin) return route.continue();
    return route.abort();
  });
  /* Only the stubbed sync response supplies phone readings. No local fallback
     can make a failed sign in or an invalid sync response look successful. */
  await context.addInitScript(
    ([kind, auth]) => {
      window.localStorage.setItem("openlimiter-theme", kind);
      window.localStorage.setItem("openlimiter-app-mode", "live");
      window.localStorage.setItem("openlimiter-app-view", "grid");
      window.localStorage.setItem("sb-capture-auth-token", auth);
    },
    [theme, JSON.stringify(session)],
  );
  const page = await context.newPage();
  const written = [];
  for (const view of PHONE_VIEWS) {
    await page.goto(SITE + "/app", { waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: STANDALONE });
    /* The launch splash clears at 760ms, the busy floor is 240ms, and then
       the panel must actually contain its proof text before the shutter. */
    await page.waitForTimeout(1600);
    await page.waitForFunction(() => document.body.textContent.includes("Claude") && document.body.textContent.includes("Codex"), null, { timeout: 20000 });
    await page.locator(".ol-live-meter-card").waitFor();
    if (!syncedReads) throw new Error("Phone capture requires a signed in fixture API read. Rebuild with the documented synthetic API configuration.");
    assertCaptureSafe(await page.locator("body").innerText());
    await page.evaluate((y) => window.scrollTo(0, y), view.scrollY);
    await page.waitForTimeout(300);
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
    serviceWorkers: "block",
  });
  const origin = `http://127.0.0.1:${port}`;
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${String(port)}/scene-${theme}`, {
    waitUntil: "networkidle",
  });
  await page.frameLocator("iframe").locator(".agents-row").nth(2).waitFor();
  await page.waitForTimeout(1200);
  assertCaptureSafe(await page.frameLocator("iframe").locator("body").innerText());
  const name = theme === "light" ? "desktop-app-light.png" : "desktop-app.png";
  await page.screenshot({ path: path.join(OUTPUT, name) });
  await context.close();
  return name;
}

async function main() {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(SITE).hostname)) {
    throw new Error("Screenshot capture requires a local fixture site.");
  }
  const { chromium } = loadPlaywright();
  const now = new Date().toISOString();
  const snapshots = await demoSnapshots(now);
  const sessions = demoSessions(now);
  assertCaptureSafe(snapshots);
  await mkdir(OUTPUT, { recursive: true });
  if (snapshots.length === 0) {
    throw new Error("The fixtures produced no snapshots. Run pnpm build first.");
  }

  const pages = new Map();
  for (const theme of ["dark", "light"]) {
    pages.set("/window-" + theme, await windowPage(theme, snapshots, sessions));
    pages.set("/rail-" + theme, await railPage(theme, sessions.filter(session => session.state === "waiting"), now));
    pages.set("/terminal-" + theme, await terminalPage(theme, snapshots, now));
  }
  const { server, port } = await startDesk(pages);
  for (const theme of ["dark", "light"]) {
    pages.set("/scene-" + theme, await scenePage(theme, `/window-${theme}`));
  }

  /* A machine that already has a Chromium can name it rather than downloading
     a second one. Empty means let Playwright resolve its own. */
  const executablePath = process.env.OPENLIMITER_CHROMIUM;
  const browser = await chromium.launch(
    executablePath === undefined || executablePath === "" ? { headless: true } : { headless: true, executablePath },
  );
  const written = [];
  try {
    for (const theme of ["dark", "light"]) {
      written.push(await captureDesk(browser, theme, port));
      written.push(...(await captureProductDetails(browser, theme, port)));
      written.push(...(await capturePhone(browser, theme, snapshots, now)));
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
