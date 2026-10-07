/**
 * Recapture the marketing screenshots, as theme pairs.
 *
 *   node scripts/capture-screenshots.mjs
 *
 * The sixteen PNG captures land in apps/web/public/screenshots, followed by
 * their density-labelled WebP variants. Set OPENLIMITER_VIDEO_OUT to also
 * write tight, element-level PNGs for the promo video.
 *
 *   desktop-app.png        the packaged window on a macOS style desk, dark
 *   desktop-app-light.png  the same scene and the same window, light
 *   phone-1..4.png         the web app at phone size, dark, one per screen
 *   phone-1..4-light.png   the same four views, light
 *   edge-tab*.png          the real edge tab on the left edge, dark and light
 *   edge-panel*.png        the same tab with its real panel open, dark and light
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
import { execFile } from "node:child_process";
import { copyFile, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ansiHtml, assertCaptureSafe, demoSessions } from "./capture-screenshots-sanitize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..");
const DESKTOP_DIST = path.join(REPOSITORY, "apps", "desktop", "ui", "dist");
const OUTPUT = path.join(REPOSITORY, "apps", "web", "public", "screenshots");
const WALLPAPER = path.join(REPOSITORY, ".media", "images", "image_001.png");
const README_HOME = path.join(REPOSITORY, "assets", "readme", "openlimiter-2-0-home.png");
const STATUSLINE_SAMPLE = path.join(REPOSITORY, "apps", "web", "lib", "statusline-sample.json");
const VIDEO_OUT = process.env.OPENLIMITER_VIDEO_OUT?.trim()
  ? path.resolve(process.env.OPENLIMITER_VIDEO_OUT)
  : undefined;
const execFileAsync = promisify(execFile);

/** Where the built site is already being served. Nothing is started here. */
const SITE = process.env.OPENLIMITER_SITE ?? "http://127.0.0.1:3111";

/** The desk, in CSS pixels: a 1440 by 900 screen holds the whole Usage tab, and
    16/9 device pixels to the CSS pixel keeps the capture at the wallpaper's own
    2560 by 1600. */
const SCENE = { width: 1440, height: 900, scale: 16 / 9 };

/**
 * The phone, at the logical screen of the device the frames on the home page
 * are drawn as. 390 by 844 at three device pixels is 1170 by 2532.
 */
const PHONE = { width: 390, height: 844, scale: 3 };

/** Geometry lifted from the capture this replaces, the window centred on the wider desk. */
const MENUBAR_HEIGHT = 26;
const WINDOW = { left: 221, top: 93, width: 998, height: 642, titlebar: 37 };

/**
 * The edge tab and its panel, placed by the product's own rule
 * (apps/desktop/src-tauri/src/rail/placement.rs) on a 1512 by 982 work area:
 * the tab's top 70% down, the panel 4 pixels to its right and as tall as its
 * content asks, moved up to stay inside the work area. A panel taller than 90%
 * of the work area scrolls, and a scrolled panel is not captured.
 */
const EDGE = { work: { width: 1512, height: 982 }, tab: { width: 24, height: 44 }, panelWidth: 360, gap: 4, minPanel: 160, maxShare: 0.9, slice: 560 };

/* The desktop pictures show one person's three connected tools, so Home, the
   desk and the edge panel each fit whole, with nothing cut off. */
const DESKTOP_PROVIDERS = new Set(["CLAUDE", "CODEX", "OPENROUTER"]);

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

async function assertFfmpegAvailable() {
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-version"], { windowsHide: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("WebP capture requires ffmpeg on PATH. Install ffmpeg with libwebp, then run the capture again.");
    }
    throw new Error(`Could not start ffmpeg for WebP capture: ${error?.message ?? String(error)}`);
  }
}

async function encodeWebp(source, target, scale) {
  const filter = scale === 1 ? undefined : `scale=trunc(iw*${scale}):trunc(ih*${scale}):flags=lanczos`;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", source];
  if (filter !== undefined) args.push("-vf", filter);
  args.push("-frames:v", "1", "-c:v", "libwebp", "-quality", "88", "-compression_level", "6", target);
  try {
    await execFileAsync("ffmpeg", args, { windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || String(error);
    throw new Error(`ffmpeg could not encode ${path.basename(source)} as WebP: ${detail}`);
  }
}

async function emitWebpVariants(pngNames) {
  await assertFfmpegAvailable();
  const outputs = [];
  for (const name of pngNames) {
    const source = path.join(OUTPUT, name);
    const stem = name.replace(/\.png$/u, "");
    const variants = name.startsWith("phone-")
      ? [["3x", 1], ["2x", 2 / 3], ["1x", 1 / 3]]
      : [["2x", 1], ["1x", 1 / 2]];
    for (const [density, scale] of variants) {
      const output = `${stem}@${density}.webp`;
      await encodeWebp(source, path.join(OUTPUT, output), scale);
      outputs.push(output);
    }
  }
  return outputs;
}

/* ------------------------------------------------------------------ *
 * The numbers in the pictures
 * ------------------------------------------------------------------ */

/**
 * Synthetic fixture readings stamped like a real machine (statusline
 * provenance for Claude, fresh states, plausible as of timestamps).
 */
export async function demoSnapshots(now) {
  const packagedEngine = path.join(DESKTOP_DIST, "engine");
  const packagedFixtures = path.join(packagedEngine, "connectors", "fixtures.js");
  const builtPackages = path.join(REPOSITORY, "packages");
  const usePackagedEngine = await stat(packagedFixtures).then(() => true, () => false);
  const connectorsDirectory = usePackagedEngine
    ? path.join(packagedEngine, "connectors")
    : path.join(builtPackages, "connectors", "dist");
  const coreEntry = usePackagedEngine
    ? path.join(packagedEngine, "core", "index.js")
    : path.join(builtPackages, "core", "dist", "index.js");
  // Import the packaged readers directly. The desktop bundle intentionally
  // contains a subset of the connector package's barrel exports. A sample only
  // generation run can use the root build before the desktop UI is bundled.
  const connectors = Object.assign({}, ...await Promise.all(
    ["fixtures", "claude", "openrouter", "codex", "antigravity", "opencode", "manual"].map(name =>
      import(pathToFileURL(path.join(connectorsDirectory, `${name}.js`)).href)),
  ));
  const core = await import(pathToFileURL(coreEntry).href);
  const rawSnapshots = core.normalizeMeters([
    ...(connectors.parseClaudePayload(connectors.claudeFixture(now), now) ?? []),
    ...(connectors.parseClaudePayload({
      five_hour: { utilization: 42, resets_at: new Date(Date.parse(now) + 18_000 * 1000).toISOString() },
      seven_day: { utilization: 64, resets_at: new Date(Date.parse(now) + 604_800 * 1000).toISOString() },
      seven_day_fable: { utilization: 69, resets_at: new Date(Date.parse(now) + 604_800 * 1000).toISOString() },
    }, now) ?? []),
    ...(connectors.parseOpenrouterPayload(connectors.openrouterFixture(), now) ?? []),
    ...(connectors.parseCodexPayload({
      ...connectors.codexFixture(now),
      rateLimits: {
        ...connectors.codexFixture(now).rateLimits,
        secondary: { usedPercent: 84, resetsAt: Math.floor(Date.parse(now) / 1000) + 604_800, windowDurationMins: 10_080 },
      },
    }, now) ?? []),
    ...(connectors.parseAntigravityPayload(connectors.antigravityFixture(now), now) ?? []),
    ...(connectors.parseOpencodePayload(connectors.opencodeFixture(now), now) ?? []),
    ...(connectors.parseManualPayload(connectors.manualFixture(now), now) ?? []),
  ]);
  const futureExpiry = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  return core.mergeSnapshots([], rawSnapshots).map((snapshot) => {
    const stamped = {
      ...snapshot,
      observedAt: now,
      expiresAt: futureExpiry,
    };
    if (snapshot.provider === "CODEX" && snapshot.meter === "SEVEN_DAY") stamped.value = DEMO_SHARED_METERS.CODEX_SEVEN_DAY;
    if (snapshot.provider === "ANTIGRAVITY" && snapshot.meter === "FIVE_HOUR") stamped.value = DEMO_SHARED_METERS.ANTIGRAVITY_FIVE_HOUR;
    if (snapshot.provider === "OPENROUTER" && snapshot.meter === "ACCOUNT_BALANCE") {
      stamped.unit = "CREDITS";
      stamped.value = DEMO_SHARED_METERS.OPENROUTER_ACCOUNT_BALANCE;
      stamped.usedAmount = undefined;
      stamped.limitAmount = undefined;
    }
    if (snapshot.provider === "CLAUDE" && snapshot.source === "native_payload") {
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
            if (name === "notification_settings") return Promise.resolve({enabled:true,threshold60:true,threshold80:true,threshold90:true,reset:true,quietStart:"22:00",quietEnd:"07:00",followSystemTimeZone:true,timeZone:"America/Sao_Paulo",snoozedUntil:null});
            if (name === "plugin:rail|rail_snapshot") return Promise.resolve({ accounts: [], flags: [], sessions: [], window: { available: true, visible: true, unfolded: false, keepOpen: false, offset: 0, cardOpen: false, cardAnchor: null } });
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

/**
 * The edge tab or its panel (`entry`), with the same fixture bridge as the
 * window: the panel reads read_cache like Home, and both read the sanitized
 * sessions from rail_snapshot. `?open` draws the tab lifted, as it is while
 * its panel shows. The panel's height report lands in window.__heights.
 */
export async function edgePage(entry, theme, snapshots, sessions) {
  const html = await readFile(path.join(DESKTOP_DIST, `${entry}.html`), "utf8");
  const cache = JSON.stringify(JSON.stringify({ version: 2, snapshots }));
  const stub = `<script>
    localStorage.setItem("openlimiter-theme", ${JSON.stringify(theme)});
    window.__heights = [];
    window.__TAURI__ = {
      core: {
        invoke: async function (name, args) {
          if (name === "read_cache") return ${cache};
          if (name === "read_manual") return "";
          if (name === "plugin:rail|rail_snapshot") return { accounts: [], flags: [], sessions: ${JSON.stringify(sessions)},
            window: { available: true, visible: true, unfolded: false, keepOpen: false, offset: 0, cardOpen: location.search.includes("open"), cardAnchor: null } };
          if (name === "plugin:rail|rail_card_height") { window.__heights.push(args.height); return null; }
          return null;
        }
      },
      event: { listen: function () { return Promise.resolve(function () {}); } }
    };
  </script>`;
  return html.replace('<script type="module"', stub + '<script type="module"');
}

/**
 * Where the tab and a panel `natural` pixels tall sit on the EDGE work area,
 * and the left edge slice of it the pictures show, all in CSS pixels.
 */
export function edgeLayout(natural) {
  const { work, tab: size, panelWidth, gap, minPanel, maxShare, slice } = EDGE;
  const tallest = Math.floor(work.height * maxShare);
  if (!Number.isFinite(natural) || natural <= 0 || natural > tallest) {
    throw new Error(`The edge panel asked for ${natural} pixels; past ${tallest} it scrolls, and a clipped panel is not captured.`);
  }
  const tab = { left: 0, top: Math.round(work.height * 0.7), ...size };
  const height = Math.max(natural, minPanel);
  const panel = { left: tab.width + gap, top: Math.min(tab.top, work.height - height), width: panelWidth, height };
  // Both windows keep their own transparent inset, so the slice ends at their edges.
  const top = Math.min(tab.top, panel.top);
  const bottom = Math.max(tab.top + tab.height, panel.top + panel.height);
  return { tab, panel, view: { left: 0, top, width: slice, height: bottom - top } };
}

/** The folded tab in context: a slice from the screen edge, the tab at its own
    place and centred top to bottom, the wallpaper around it. */
export function edgeTabLayout(layout, width = 200, height = 140) {
  const top = layout.tab.top + Math.round((layout.tab.height - height) / 2);
  return { ...layout, view: { left: 0, top, width, height } };
}

/** The slice: the wallpaper as the whole work area, the tab, and the panel when `open`. */
export function edgeScene(origin, theme, layout, open) {
  const { view } = layout;
  const place = ({ left, top, width, height }) =>
    `position:absolute;left:${left - view.left}px;top:${top - view.top}px;width:${width}px;height:${height}px;border:0`;
  const pointer = open ? `<svg aria-hidden="true" viewBox="0 0 24 32" width="24" height="32" style="position:absolute;left:${layout.tab.left - view.left + 7}px;top:${layout.tab.top - view.top + 9}px;filter:drop-shadow(0 1px 1px rgb(0 0 0 / .45));pointer-events:none">
      <path d="M2.5 1.8v23.7l6.1-5.2 4.1 9.2 4.2-1.9-4.1-9.1h8.1z" fill="#fff" stroke="#15171b" stroke-width="1.7" stroke-linejoin="round"/>
    </svg>` : "";
  return `<!doctype html><html lang="en" style="color-scheme:${theme}"><body style="margin:0;overflow:hidden;background:transparent">
    <iframe title="desk" src="${origin}/wallpaper" style="${place({ left: 0, top: 0, ...EDGE.work })}"></iframe>
    <iframe title="tab" src="${origin}/edge-tab-${theme}${open ? "?open" : ""}" style="${place(layout.tab)}"></iframe>
    ${open ? `<iframe title="panel" src="${origin}/edge-panel-${theme}" style="${place(layout.panel)}"></iframe>` : ""}
    ${pointer}
  </body></html>`;
}

/** Nothing but the desk's photograph, for the edge pictures. */
async function wallpaperPage() {
  const wallpaper = `data:image/png;base64,${(await readFile(WALLPAPER)).toString("base64")}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>wallpaper</title></head>
    <body style="margin:0;height:100vh;background:url(${wallpaper}) center / cover no-repeat"></body></html>`;
}

export const DEMO_SHARED_METERS = Object.freeze({
  CODEX_SEVEN_DAY: 84,
  ANTIGRAVITY_FIVE_HOUR: 94,
  OPENROUTER_ACCOUNT_BALANCE: 12.54,
});

export const SAMPLE_VALUES = [
  { provider: "CLAUDE", meter: "FIVE_HOUR", value: 42 },
  { provider: "CLAUDE", meter: "SEVEN_DAY", value: 64 },
  { provider: "CLAUDE", meter: "SEVEN_DAY_FABLE", value: 69 },
  /* The line's one orange reading: the terminal shot must show all four bands. */
  { provider: "CODEX", meter: "SEVEN_DAY", value: DEMO_SHARED_METERS.CODEX_SEVEN_DAY },
  { provider: "ANTIGRAVITY", meter: "FIVE_HOUR", value: DEMO_SHARED_METERS.ANTIGRAVITY_FIVE_HOUR },
];

export function statuslineSnapshots(snapshots) {
  const rows = SAMPLE_VALUES.map((wanted) => {
    const row = snapshots.find((candidate) => candidate.provider === wanted.provider &&
      (wanted.meter === undefined || candidate.meter === wanted.meter) && candidate.unit === "PERCENT");
    if (row === undefined) throw new Error(`The ${wanted.provider} fixture has no ${wanted.meter ?? "percentage"} status line row.`);
    return { ...row, value: wanted.value };
  });
  const openrouter = snapshots.find((row) => row.provider === "OPENROUTER");
  if (openrouter === undefined) throw new Error("The OpenRouter fixture has no balance row.");
  return [...rows, {
    ...openrouter,
    unit: "CREDITS",
    value: DEMO_SHARED_METERS.OPENROUTER_ACCOUNT_BALANCE,
    usedAmount: undefined,
    limitAmount: undefined,
  }];
}

function statuslineApiSpend(now) {
  const month = now.slice(0, 7) + "-01";
  return {
    sources: [
      { id: "capture-openrouter", provider: "openrouter", enabled: true },
      { id: "capture-openai", provider: "openai", enabled: true },
      { id: "capture-anthropic", provider: "anthropic", enabled: true },
    ],
    samples: [
      { sourceId: "capture-openrouter", sequence: 1, month, spendUsd: null, balanceUsd: "12.54", observedAt: now, currencySource: "provider_usd" },
      { sourceId: "capture-openai", sequence: 1, month, spendUsd: "8.20", balanceUsd: null, observedAt: now, currencySource: "provider_usd" },
      { sourceId: "capture-anthropic", sequence: 1, month, spendUsd: "3.10", balanceUsd: null, observedAt: now, currencySource: "provider_usd" },
    ],
  };
}

async function statuslineOutput(snapshots, now) {
  const { renderStatuslineLayout } = await import(pathToFileURL(path.join(REPOSITORY, "packages/cli/dist/statusline.js")));
  const { DEFAULT_STATUSLINE } = await import(pathToFileURL(path.join(REPOSITORY, "packages/cli/dist/config.js")));
  /* Limits and money only: the session cells (model, effort, context) would
     push the line past one row on a wide screen, and the owner wants one row. */
  return renderStatuslineLayout({ snapshots: statuslineSnapshots(snapshots), now, config: DEFAULT_STATUSLINE,
    apiSpend: statuslineApiSpend(now), advice: { inject: false, reason: "UNKNOWN" }, host: "claude", color: true, unicode: true });
}

/** Interpret only the colour escapes emitted by the real CLI band renderer. */
export function ansiSpans(text) {
  assertCaptureSafe(text);
  const colors = { "31": "red", "32": "green", "33": "yellow", "38;5;208": "orange" };
  const spans = [];
  let at = 0;
  let band;
  for (const match of text.matchAll(/\x1b\[([\d;]*)m/gu)) {
    if (match.index > at) spans.push({ text: text.slice(at, match.index), ...(band === undefined ? {} : { band }) });
    band = match[1] === "0" || match[1] === "" ? undefined : colors[match[1]];
    if (band === undefined && match[1] !== "0" && match[1] !== "") throw new Error("Unsupported terminal colour in status line sample.");
    at = match.index + match[0].length;
  }
  if (at < text.length) spans.push({ text: text.slice(at), ...(band === undefined ? {} : { band }) });
  if (spans.some((span) => span.text.includes("\x1b"))) throw new Error("Unsupported terminal escape in status line sample.");
  return spans;
}

export async function statuslineSample(snapshots, now) {
  const output = await statuslineOutput(snapshots, now);
  return { cells: output.split(" | ").map(ansiSpans) };
}

async function writeStatuslineSample(snapshots, now) {
  const sample = await statuslineSample(snapshots, now);
  await writeFile(STATUSLINE_SAMPLE, JSON.stringify(sample, null, 2) + "\n", "utf8");
  return sample;
}

export async function terminalPage(theme, snapshots, now, { wrap = true } = {}) {
  const output = await statuslineOutput(snapshots, now);
  /* A cell stays whole, and its separator belongs to the following cell. */
  const cells = output.split(" | ");
  const body = cells.map((cell, index) => `<span class="cell">${index === 0 ? "" : " | "}${ansiHtml(cell)}</span>`).join("");
  const lightBandColors = theme === "light"
    ? ".band-yellow{color:#9a6700}.band-orange{color:#bc4c00}.band-red{color:#cf222e}"
    : "";
  for (const band of ["green", "yellow", "orange", "red"]) {
    if (!body.includes(`band-${band}`)) throw new Error(`CLI capture did not render ${band}.`);
  }
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">
    <link rel="stylesheet" href="engine/ui/tokens.css"><style>
      *{box-sizing:border-box}body{margin:0;padding:44px;background:var(--ol-canvas);color:var(--ol-body);font-family:var(--ol-font-sans)}
      p{font-size:16px;color:var(--ol-muted)}pre{margin-top:34px;font:19px/2 ui-monospace,monospace;white-space:${wrap ? "pre-wrap" : "pre"};${wrap ? "" : "display:table;width:max-content;max-width:none;"}}.cell{display:${wrap ? "inline-block" : "inline"};white-space:pre}
      ${["green", "yellow", "orange", "red"].map(b => `.band-${b}{color:var(--ol-band-${b}-label)}`).join("")}${lightBandColors}
</style></head><body><p>openlimiter statusline</p><pre>${body}</pre></body></html>`;
}

async function fitTerminalCapture(page) {
  await page.setViewportSize({ width: 1200, height: 1 });
  const measurement = await page.locator("pre").evaluate((pre) => {
    const frame = pre.getBoundingClientRect();
    const longestLine = Math.max(0, ...Array.from(pre.querySelectorAll(".cell"), (cell) => {
      const rect = cell.getBoundingClientRect();
      return rect.right - frame.left;
    }));
    return { frameWidth: pre.clientWidth, longestLine };
  });
  if (measurement.longestLine > measurement.frameWidth + 0.5) {
    throw new Error(`The terminal status line exceeds its frame: ${measurement.longestLine} > ${measurement.frameWidth}.`);
  }
  const height = await page.evaluate(() => Math.ceil(document.scrollingElement?.scrollHeight ?? document.body.scrollHeight));
  await page.setViewportSize({ width: 1200, height });
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
    await page.locator('#usage-rows [data-provider-card]').nth(2).waitFor({ state: "attached" });
    await closeWhatsNew(page);
    await page.getByRole('tab', { name: 'Connect Tools', exact: true }).click();
    await page.locator('#key-rows [data-key-row]').first().waitFor({ state: "attached" });
    await page.getByRole('tab', { name: 'Usage', exact: true }).click();
    await page.locator('#agents-section:not([hidden])').waitFor();
    /* Reset the viewport before each tab measurement. scrollHeight cannot shrink
       below the current viewport, so a taller tab would otherwise leave blank space. */
    const tabHeight = async () => {
      await page.setViewportSize({ width: 1000, height: 1 });
      return page.evaluate(() => document.scrollingElement.scrollHeight);
    };
    const homeHeight = await tabHeight();
    await page.setViewportSize({ width: 1000, height: homeHeight });
    await shoot("desktop-home");
    await page.getByRole('tab', { name: 'Connect Tools', exact: true }).click();
    await page.locator('#key-rows [data-key-row]').first().waitFor({ state: "attached" });
    const connectHeight = await tabHeight();
    await page.setViewportSize({ width: 1000, height: connectHeight });
    await shoot("desktop-connect");
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.locator('#tab-panel-settings #settings-appearance').waitFor({ state: "attached" });
    const settingsHeight = await tabHeight();
    await page.setViewportSize({ width: 1000, height: settingsHeight });
    await shoot("desktop-settings");
    /* The panel reports the height its content needs at its own width, and
       native code sizes the window to it; the pictures place both windows the
       same way. Measured any wider, wrapped labels would not count. */
    await page.setViewportSize({ width: EDGE.panelWidth, height: 760 });
    await page.goto(`${origin}/edge-panel-${theme}`, { waitUntil: "networkidle" });
    await page.locator("[data-provider-card]").first().waitFor();
    const layout = edgeLayout(await page.evaluate(() => window.__heights.at(-1)));
    for (const open of [false, true]) {
      const captureLayout = open ? layout : edgeTabLayout(layout);
      await page.setViewportSize({ width: captureLayout.view.width, height: captureLayout.view.height });
      await page.setContent(edgeScene(origin, theme, captureLayout, open));
      await page.frameLocator('iframe[title="tab"]').locator(open ? ".edge-tab.open" : ".edge-tab").waitFor();
      if (open) {
        const panel = page.frameLocator('iframe[title="panel"]');
        await panel.locator('.q-agent[data-state="waiting"]').waitFor();
        await panel.locator("[data-provider-card]").first().waitFor();
        const clipped = await panel.locator("#panel-scroll").evaluate(scroll => scroll.scrollHeight - scroll.clientHeight);
        if (clipped > 1) throw new Error(`The edge panel clips ${clipped} pixels at the height it asked for.`);
      }
      await page.waitForTimeout(500);
      await shoot(open ? "edge-panel" : "edge-tab");
    }
    await page.goto(`${origin}/terminal-${theme}`, { waitUntil: "networkidle" });
    await fitTerminalCapture(page);
    await shoot("terminal-statusline");
  } finally { await context.close(); }
  return names;
}

/* The desk window follows the complete active Usage tab, including Agents and
   a bottom gutter, so the one screen capture does not cut the list. */
async function fitWindowToLimits(page) {
  const home = page.frameLocator("iframe");
  const content = await home.locator("#tab-panel-usage").evaluate(panel => Math.ceil(panel.getBoundingClientRect().bottom) + 16);
  await page.evaluate(({ content, titlebar, menubar, desk }) => {
    const frame = document.querySelector(".window");
    frame.style.height = `${content + titlebar}px`;
    frame.style.top = `${menubar + Math.round((desk - menubar - content - titlebar) / 2)}px`;
    frame.querySelector("iframe").style.height = `${content}px`;
  }, { content, titlebar: WINDOW.titlebar, menubar: MENUBAR_HEIGHT, desk: SCENE.height });
  /* Spend and Agents sit inside the measured tab, so after the resize the last
     visible one must still end inside the window. */
  const last = home.locator("#spend-section:not([hidden]), #agents-section:not([hidden])").last();
  if (await last.count()) {
    const end = await last.evaluate(section => section.getBoundingClientRect().bottom);
    if (end > content) throw new Error("The desk window would cut a visible section.");
  }
  if (content + WINDOW.titlebar > SCENE.height - MENUBAR_HEIGHT) throw new Error("The desk window would run past the desk.");
}

/* What's New opens once per version over Home; video frames need the same
   honest Home state as the marketing captures, without a modal over it. */
async function closeWhatsNew(page) {
  const whatsNew = page.locator("dialog.whats-new[open]");
  if (await whatsNew.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
    await whatsNew.locator("button").click();
    await whatsNew.waitFor({ state: "detached" });
  }
}

async function assertCapturePageSafe(page) {
  for (const frame of page.frames()) {
    assertCaptureSafe(await frame.locator("body").innerText());
  }
}

async function captureVideoElement(page, locator, name, options = {}) {
  await assertCapturePageSafe(page);
  assertCaptureSafe(await locator.innerText());
  await locator.screenshot({
    path: path.join(VIDEO_OUT, name),
    animations: "disabled",
    ...options,
  });
  return name;
}

async function captureVideoShots(browser, port) {
  await mkdir(VIDEO_OUT, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({
    viewport: { width: 1000, height: 760 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const written = [];
  const transparent = { omitBackground: true };
  try {
    await page.goto(`${origin}/scene-dark`, { waitUntil: "networkidle" });
    await page.frameLocator("iframe").locator("#agents-mount .q-agent").nth(2).waitFor();
    await closeWhatsNew(page.frameLocator("iframe"));
    await fitWindowToLimits(page);
    written.push(await captureVideoElement(page, page.locator(".window"), "home-window.png"));

    await page.goto(`${origin}/window-dark`, { waitUntil: "networkidle" });
    await page.locator("#agents-mount .q-agent").nth(2).waitFor();
    await closeWhatsNew(page);
    for (const state of ["busy", "waiting", "done"]) {
      const row = page.locator(`#agents-mount .q-agent[data-state="${state}"]`);
      await row.waitFor();
      written.push(await captureVideoElement(page, row, `agents-row-${state}.png`, transparent));
    }

    /* The alerts section renders only when the stubbed bridge reports native
       notifications; without it this optional shot is skipped, not faked. */
    try {
      await page.getByRole("tab", { name: "Settings", exact: true }).click();
      const alerts = page.locator("#tab-panel-settings #settings-alerts");
      await alerts.waitFor({ timeout: 8000 });
      if ((await alerts.innerText()).includes("Desktop alerts stay free")) {
        written.push(await captureVideoElement(page, alerts, "settings-alerts.png", transparent));
      } else {
        process.stdout.write("skip settings-alerts.png: section does not say desktop alerts stay free\n");
      }
    } catch {
      process.stdout.write("skip settings-alerts.png: alerts section not rendered by the stub\n");
    }

    await page.goto(`${origin}/edge-tab-dark`, { waitUntil: "networkidle" });
    await page.locator("#attention:not([hidden])").waitFor();
    written.push(await captureVideoElement(page, page.locator(".edge-tab"), "edge-tab.png", transparent));

    await page.goto(`${origin}/edge-panel-dark`, { waitUntil: "networkidle" });
    await page.locator('.q-agent[data-state="waiting"]').waitFor();
    const card = page.locator("#panel-card");
    const cardText = await card.innerText();
    if (!cardText.includes("Claude Code") || !cardText.includes("Needs you")) {
      throw new Error("Video capture requires the edge panel to show Claude Code needing you.");
    }
    written.push(await captureVideoElement(page, card, "edge-panel.png", transparent));

    await page.setViewportSize({ width: 2000, height: 760 });
    for (const theme of ["dark", "light"]) {
      await page.goto(`${origin}/terminal-line-${theme}`, { waitUntil: "networkidle" });
      written.push(await captureVideoElement(page, page.locator("pre"), `statusline-${theme}.png`, transparent));
    }
  } finally {
    await context.close();
  }
  return written;
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
].join("\n");

/* Each view names both the real screen it opens and where that screen starts. */
const PHONE_VIEWS = [
  { file: "phone-1", screen: "paired", tab: "usage", from: "top" },
  { file: "phone-2", screen: "paired", tab: "pro", from: "top" },
  { file: "phone-3", screen: "install", tab: "usage", from: "top" },
  { file: "phone-4", screen: "pair", from: "top" },
];

const CAPTURE_PAIR_CODE = "ABCD2345";
const CAPTURE_CLAIM_ID = "00000000-0000-4000-8000-000000000002";

/**
 * The two synthetic wire answers that keep the real pair page waiting. A
 * request that breaks the client's contract (lib/pro-device.ts: a claim with
 * the code and a device, a poll with the issued claim id) gets null, which
 * fails the capture instead of photographing whatever the page does next.
 */
export function pairingCaptureResponse(request, expiresAt) {
  const action = request?.action;
  if (action === "claim" && request.code === CAPTURE_PAIR_CODE && request.device !== null && typeof request.device === "object" && !Array.isArray(request.device)) {
    return { status: 200, body: { claim_id: CAPTURE_CLAIM_ID, expires_at: expiresAt } };
  }
  if (action === "poll" && request.claim_id === CAPTURE_CLAIM_ID) return { status: 200, body: { status: "claimed" } };
  return null;
}

/**
 * Runs in the page: the scroll nearest the view's start at which neither edge
 * of the screen crosses a line of text, shadow roots included, or null.
 */
function wholeLinesScroll(from) {
  const lines = [];
  const walk = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.shadowRoot !== null) walk(node.shadowRoot);
        continue;
      }
      if (!node.textContent.trim() || !node.parentElement?.checkVisibility()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) lines.push([rect.top + window.scrollY, rect.bottom + window.scrollY]);
    }
  };
  walk(document.body);
  const height = window.innerHeight;
  const end = document.scrollingElement.scrollHeight - height;
  const card = document.querySelector("openlimiter-provider-row")?.getBoundingClientRect();
  const target = from === "top" ? 0
    : from === "end" ? end
    : from === "middle" ? Math.round(end / 2)
    : Math.round((card?.bottom ?? 0) + window.scrollY + 8);
  const cuts = (edge) => lines.some(([top, bottom]) => edge > top + 1 && edge < bottom - 1);
  for (let offset = 0; offset <= 240; offset++) {
    for (const y of [target + offset, target - offset]) {
      if (y >= 0 && y <= end && !cuts(y) && !cuts(y + height)) return y;
    }
  }
  return null;
}

async function capturePhone(browser, theme, snapshots, now) {
  // Build the local site with NEXT_PUBLIC_SUPABASE_URL=https://capture.openlimiter.invalid
  // and NEXT_PUBLIC_SUPABASE_ANON_KEY=capture-only. No real service is contacted.
  const api = "https://capture.openlimiter.invalid";
  const siteOrigin = new URL(SITE).origin;
  const phoneRows = snapshots.map((row) => ({
    account_id: "demo",
    provider: row.provider,
    code: row.meter,
    percent: row.unit === "PERCENT" ? Math.round(row.value) : null,
    amount: row.unit === "CREDITS" ? row.value : null,
    currency: row.unit === "CREDITS" ? row.currency ?? null : null,
    resets_at: row.resetAt ?? null,
    observed_at: row.observedAt ?? now,
    stale: false,
  }));
  const written = [];
  for (const view of PHONE_VIEWS) {
    const context = await browser.newContext({
      viewport: { width: PHONE.width, height: PHONE.height },
      deviceScaleFactor: PHONE.scale,
      colorScheme: theme,
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
      userAgent: view.screen === "install"
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1"
        : undefined,
    });
    const onboarded = true;
    const user = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated",
      user_metadata: { full_name: "Demo", openlimiter_onboarded: onboarded }, app_metadata: { provider: "github" }, created_at: now };
    const session = { access_token: "capture-only", refresh_token: "capture-only", token_type: "bearer", expires_in: 86400,
      expires_at: Math.floor(Date.parse(now) / 1000) + 86400, user };
    let syncedReads = 0;
    let pairClaims = 0;
    let pairPolls = 0;
    let pairRejected = 0;
    let phoneReads = 0;
    let phoneRenewals = 0;
    const pairExpiresAt = new Date(Date.now() + 120_000).toISOString();
    const phoneExpiresAt = Math.floor(Date.now() / 1_000) + 86_400;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === siteOrigin && view.screen !== "pair") {
        if (url.pathname === "/app/pair/api/read") {
          phoneReads++;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ body: { rows: phoneRows } }) });
          return;
        }
        if (url.pathname === "/app/pair/api/renew") {
          phoneRenewals++;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ expires_at: phoneExpiresAt }) });
          return;
        }
        return route.continue();
      }
      if (url.origin === api) {
        const action = route.request().postDataJSON()?.action;
        if (view.screen === "pair" && url.pathname === "/functions/v1/pair-device") {
          const request = route.request();
          const response = request.method() === "POST" ? pairingCaptureResponse(request.postDataJSON(), pairExpiresAt) : null;
          if (response === null) {
            pairRejected++;
            return route.abort();
          }
          await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
          /* Counted once answered, so a poll in flight never passes for one the page has read. */
          if (action === "claim") pairClaims++;
          if (action === "poll") pairPolls++;
          return;
        }
        if (view.screen === "pair") return route.abort();
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
      if (url.origin === siteOrigin) return route.continue();
      return route.abort();
    });
    await context.addInitScript(
      ([kind, auth, includeSession, seedPairMeta]) => {
        window.localStorage.setItem("openlimiter-theme", kind);
        if (seedPairMeta) window.localStorage.setItem("openlimiter-phone-pair-meta", JSON.stringify({ label: "Demo phone", expiresAt: Math.floor(Date.now() / 1_000) + 1 }));
        if (includeSession) window.localStorage.setItem("sb-capture-auth-token", auth);
      },
      [theme, JSON.stringify(session), view.screen !== "pair", view.screen !== "pair"],
    );
    const page = await context.newPage();
    try {
      /* A paired phone's Usage and Pro tabs and its install button live on the
         pair page, never on /app; only the pair view brings a code. */
      const route = `/app/pair${view.screen === "pair" ? `#code=${CAPTURE_PAIR_CODE}` : ""}`;
      if (view.screen !== "install") {
        await page.addInitScript(() => {
          const nativeMatchMedia = window.matchMedia.bind(window);
          window.matchMedia = (query) => {
            const result = nativeMatchMedia(query);
            if (query.includes("display-mode: standalone")) {
              Object.defineProperty(result, "matches", { configurable: true, value: true });
            }
            return result;
          };
          Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
        });
      }
      await page.goto(SITE + route, { waitUntil: "domcontentloaded" });
      if (view.screen !== "install") await page.addStyleTag({ content: STANDALONE });

      if (view.screen === "paired" || view.screen === "install") {
        await page.locator("#ol-phone-panel-usage openlimiter-provider-row").first().waitFor({ timeout: 20000 });
        const firstCard = page.locator("openlimiter-provider-row article.row").first();
        await firstCard.waitFor();
        for (const selector of [".window-name", ".window-percent", ".window-reset"]) {
          await firstCard.locator(selector).first().waitFor({ state: "attached" });
        }
        if (!phoneReads || !phoneRenewals) throw new Error("Phone capture requires the paired read and renewal routes to answer.");
        if (view.tab === "pro") {
          await page.getByRole("tab", { name: "Pro", exact: true }).click();
          await page.locator("#ol-phone-panel-pro:not([hidden])").waitFor();
        } else if (view.screen === "install") {
          await page.getByRole("button", { name: "Install app", exact: true }).click();
          await page.locator('[role="dialog"]').waitFor();
          await page.getByText("Add OpenLimiter to your Home Screen", { exact: true }).waitFor();
        }
      } else {
        /* The readout's paragraph also holds a screen reader prefix, so the
           code is a substring of its text, never the whole of it. */
        await page.locator("p.font-mono", { hasText: CAPTURE_PAIR_CODE }).waitFor({ timeout: 20000 }).catch(async (error) => {
          throw new Error(`The pair page never showed the waiting code. It read: ${(await deepText(page)).slice(0, 400)}`, { cause: error });
        });
        for (let waited = 0; pairPolls === 0 && waited < 20000; waited += 250) await page.waitForTimeout(250);
        await page.waitForTimeout(500);
        if (pairRejected !== 0 || pairClaims !== 1 || pairPolls === 0) {
          throw new Error("Phone pairing capture did not claim and poll the synthetic code under the client's contract.");
        }
      }

      assertCaptureSafe(await deepText(page));
      const top = await page.evaluate(wholeLinesScroll, view.from);
      if (top === null) throw new Error(`No scroll position lets ${view.file} show whole lines of text at both edges.`);
      await page.evaluate((y) => window.scrollTo(0, y), top);
      await page.waitForTimeout(300);
      const name = view.file + (theme === "light" ? "-light" : "") + ".png";
      if (view.screen === "pair" && (pairRejected !== 0 || !(await page.locator("p.font-mono", { hasText: CAPTURE_PAIR_CODE }).isVisible()))) {
        throw new Error("The pair page left its waiting phase before the shutter.");
      }
      await page.screenshot({ path: path.join(OUTPUT, name) });
      written.push(name);
    } finally {
      await context.close();
    }
  }
  return written;
}

/** Every visible string on the page, shadow roots included, for the safety check. */
function deepText(page) {
  return page.evaluate(() => {
    const parts = [];
    const walk = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.parentElement?.tagName) && node.parentElement?.checkVisibility()) parts.push(node.textContent);
        }
        else if (node.shadowRoot !== null) walk(node.shadowRoot);
      }
    };
    walk(document.body);
    return parts.join(" ");
  });
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
  const home = page.frameLocator("iframe");
  await home.locator('#usage-rows [data-provider-card]').nth(2).waitFor({ state: "attached" });
  await closeWhatsNew(home);
  await home.getByRole('tab', { name: 'Connect Tools', exact: true }).click();
  await home.locator('#key-rows [data-key-row]').first().waitFor({ state: "attached" });
  await home.getByRole('tab', { name: 'Usage', exact: true }).click();
  await home.locator('#agents-section:not([hidden])').waitFor();
  /* The desk shows the window as a person uses it, after What's New is closed. */
  await fitWindowToLimits(page);
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
  await writeStatuslineSample(snapshots, now);
  await mkdir(OUTPUT, { recursive: true });
  if (snapshots.length === 0) {
    throw new Error("The fixtures produced no snapshots. Run pnpm build first.");
  }

  const desktop = snapshots.filter(row => DESKTOP_PROVIDERS.has(row.provider));
  const pages = new Map([["/wallpaper", await wallpaperPage()]]);
  for (const theme of ["dark", "light"]) {
    pages.set("/window-" + theme, await windowPage(theme, desktop, sessions));
    for (const entry of ["edge-tab", "edge-panel"]) pages.set(`/${entry}-${theme}`, await edgePage(entry, theme, desktop, sessions));
    pages.set("/terminal-" + theme, await terminalPage(theme, snapshots, now));
    pages.set("/terminal-line-" + theme, await terminalPage(theme, snapshots, now, { wrap: false }));
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
  let video = [];
  try {
    for (const theme of ["dark", "light"]) {
      written.push(await captureDesk(browser, theme, port));
      written.push(...(await captureProductDetails(browser, theme, port)));
      written.push(...(await capturePhone(browser, theme, snapshots, now)));
    }
    if (VIDEO_OUT !== undefined) video = await captureVideoShots(browser, port);
  } finally {
    await browser.close();
    server.close();
  }

  await copyFile(path.join(OUTPUT, "desktop-home.png"), README_HOME);
  const webp = await emitWebpVariants(written);
  written.push(...webp);

  for (const name of written.sort()) {
    const info = await stat(path.join(OUTPUT, name));
    process.stdout.write(name.padEnd(24) + String(info.size).padStart(9) + " bytes\n");
  }
  for (const name of video.sort()) {
    const info = await stat(path.join(VIDEO_OUT, name));
    process.stdout.write(`video/${name}`.padEnd(32) + String(info.size).padStart(9) + " bytes\n");
  }
  const readmeInfo = await stat(README_HOME);
  process.stdout.write(`readme/${path.basename(README_HOME)}`.padEnd(32) + String(readmeInfo.size).padStart(9) + " bytes\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--statusline-sample-only")) {
    const now = "2026-10-01T12:00:00.000Z";
    await writeStatuslineSample(await demoSnapshots(now), now);
  } else {
    await main();
  }
}
