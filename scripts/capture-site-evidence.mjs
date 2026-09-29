/**
 * Capture before and after evidence for the public 2.0 site.
 *
 *   node scripts/capture-site-evidence.mjs
 *
 * The script writes only the twelve requested PNGs under
 * launch-2026-10-relaunch/evidence/site-2-0.
 */
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..");
const LAUNCH_ROOT = path.basename(path.dirname(REPOSITORY)) === "wt"
  ? path.resolve(REPOSITORY, "..", "..")
  : REPOSITORY;
const OUTPUT = path.join(LAUNCH_ROOT, "evidence", "site-2-0");
const BEFORE = "https://openlimiter.com";
/* A local next start answers the marketing routes with a redirect loop, so the
   after set is taken from production right after the 2.0 deploy:
   OPENLIMITER_EVIDENCE=after OPENLIMITER_AFTER=https://openlimiter.com */
const AFTER = process.env.OPENLIMITER_AFTER ?? "http://localhost:3111";
const PHASES = (process.env.OPENLIMITER_EVIDENCE ?? "before,after").split(",");
const WIDTHS = [375, 768, 1440];
const PAGES = [
  { name: "home", path: "/" },
  { name: "download", path: "/download" },
];

export function loadPlaywright() {
  const require = createRequire(path.join(REPOSITORY, "apps/web/package.json"));
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return require(name);
    } catch {
      /* Try the next installed package. */
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
          /* Try the next installed package. */
        }
      }
    } catch {
      /* The global fallback is optional. */
    }
  }
  throw new Error(
    "Playwright is not resolvable from here. Install it, then run this again:\n" +
      "  npm i -g playwright && npx playwright install chromium",
  );
}

async function loadPage(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
  await page.locator("main").waitFor();
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    const height = document.documentElement.scrollHeight;
    for (let y = 0; y < height; y += Math.max(window.innerHeight, 1)) {
      window.scrollTo(0, y);
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
  const lang = await page.locator("html").getAttribute("lang");
  if (lang !== "en") throw new Error(`Expected English content, got html lang ${lang ?? "missing"}.`);
}

async function captureOrigin(browser, phase, origin) {
  const written = [];
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      const requestOrigin = new URL(route.request().url()).origin;
      if (requestOrigin === origin) return route.continue();
      return route.abort();
    });
    try {
      for (const pageSpec of PAGES) {
        const page = await context.newPage();
        await loadPage(page, `${origin}${pageSpec.path}`);
        const filename = `${phase}-${pageSpec.name}-${width}.png`;
        await page.screenshot({
          path: path.join(OUTPUT, filename),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
        written.push(filename);
        await page.close();
      }
    } finally {
      await context.close();
    }
  }
  return written;
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const written = [
      ...(PHASES.includes("before") ? await captureOrigin(browser, "before", BEFORE) : []),
      ...(PHASES.includes("after") ? await captureOrigin(browser, "after", AFTER) : []),
    ];
    process.stdout.write(`Captured ${written.length} site evidence images in ${OUTPUT}.\n`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
