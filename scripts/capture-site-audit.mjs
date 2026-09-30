/**
 * Capture every public page of the site for the front end audit.
 *
 *   node scripts/capture-site-audit.mjs
 *
 * OPENLIMITER_SITE overrides the default production site. The script writes
 * only PNG captures and index.json under evidence/site-audit.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./capture-site-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..");
const LAUNCH_ROOT = path.basename(path.dirname(REPOSITORY)) === "wt"
  ? path.resolve(REPOSITORY, "..", "..")
  : REPOSITORY;
const APP_ROOT = path.join(REPOSITORY, "apps", "web", "app");
const BLOG_DATA = path.join(REPOSITORY, "apps", "web", "lib", "blog.ts");
const OUTPUT = path.join(LAUNCH_ROOT, "evidence", "site-audit");
const SITE = (process.env.OPENLIMITER_SITE ?? "https://openlimiter.com").replace(/\/+$/, "");
const SITE_ORIGIN = new URL(SITE).origin;
const WIDTHS = [375, 768, 1440];
const THEMES = ["dark", "light"];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function routePath(segments) {
  const visible = segments
    .filter((segment) => !/^\([^/]+\)$/.test(segment))
    .map((segment) => segment.replace(/^\[locale\]$/, ""));
  return `/${visible.filter(Boolean).join("/")}` || "/";
}

function routeSlug(route) {
  const value = route.replace(/^\/+|\/+$/g, "");
  if (!value) return "home";
  return value
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .join("-") || "home";
}

async function blogSlugs() {
  const source = await readFile(BLOG_DATA, "utf8");
  return [...source.matchAll(/\bslug:\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

async function discoverRoutes() {
  const pageFiles = (await walk(APP_ROOT)).filter((file) => path.basename(file) === "page.tsx");
  const blogPosts = await blogSlugs();
  const routes = [];

  for (const file of pageFiles) {
    const relative = path.relative(APP_ROOT, file).split(path.sep);
    const segments = relative.slice(0, -1);
    const dynamicBlog = segments.includes("[slug]");
    const unsupportedDynamic = segments.filter((segment) => /^\[[^\]]+\]$/.test(segment) && segment !== "[locale]" && segment !== "[slug]");

    if (unsupportedDynamic.length > 0) {
      throw new Error(`Unsupported dynamic public route: ${relative.join("/")}`);
    }

    if (dynamicBlog) {
      if (segments.join("/") !== "blog/[slug]") {
        throw new Error(`Unsupported dynamic public route: ${relative.join("/")}`);
      }
      for (const slug of blogPosts) {
        const route = `/blog/${slug}`;
        routes.push({ path: route, slug: routeSlug(route), locale: "en", source: relative.join("/") });
      }
      continue;
    }

    const route = routePath(segments);
    const localeTree = segments[0] === "[locale]";
    routes.push({
      path: route,
      slug: routeSlug(route),
      locale: "en",
      source: relative.join("/"),
      localized: localeTree,
    });
  }

  const unique = new Map(routes.map((route) => [route.path, route]));
  unique.set("/pt-BR", {
    path: "/pt-BR",
    slug: "pt-BR-home",
    locale: "pt-BR",
    source: "[locale]/page.tsx",
    localized: true,
  });

  return [...unique.values()].sort((left, right) => {
    if (left.path === "/") return -1;
    if (right.path === "/") return 1;
    return left.path.localeCompare(right.path);
  });
}

function dataUrlBytes(value) {
  if (!value.startsWith("data:")) return 0;
  const comma = value.indexOf(",");
  if (comma < 0) return 0;
  const metadata = value.slice(0, comma);
  const payload = value.slice(comma + 1);
  if (/;base64/i.test(metadata)) return Buffer.from(payload, "base64").byteLength;
  return Buffer.byteLength(decodeURIComponent(payload));
}

async function scrollFullPage(page) {
  let y = 0;
  for (;;) {
    const viewport = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    const step = Math.max(viewport.innerHeight, 1);
    const nextY = Math.min(y + step, Math.max(viewport.height - viewport.innerHeight, 0));
    if (nextY === y && y !== 0) break;

    await page.evaluate((next) => window.scrollTo(0, next), nextY);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    y = nextY;

    const afterScroll = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    if (y >= Math.max(afterScroll.height - afterScroll.innerHeight, 0)) break;
  }

  const findings = await page.evaluate(() => {
    const describe = (element) => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : "";
      const classes = typeof element.className === "string"
        ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join("")
        : "";
      return `${tag}${id}${classes}`;
    };
    return [...document.querySelectorAll("*")]
      .filter((element) => getComputedStyle(element).opacity === "0")
      .map((element) => describe(element));
  });

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForLoadState("networkidle");
  return findings;
}

async function loadPage(page, route) {
  const response = await page.goto(new URL(route.path, `${SITE}/`).toString(), { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
  if (!response || !response.ok()) {
    throw new Error(`${route.path} returned ${response?.status() ?? "no response"}`);
  }
  await page.locator("main").waitFor();
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  const language = await page.locator("html").getAttribute("lang");
  if (language !== route.locale) {
    throw new Error(`${route.path} expected html lang ${route.locale}, got ${language ?? "missing"}`);
  }
  return scrollFullPage(page);
}

async function capturePage(context, route, theme, width) {
  const page = await context.newPage();
  const imageResponses = new Map();
  page.on("response", (response) => {
    if (response.request().resourceType() !== "image") return;
    const url = response.url();
    imageResponses.set(url, response.body().then((body) => body.byteLength).catch(() => 0));
  });

  try {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const findings = await loadPage(page, route);
    for (const finding of findings) {
      process.stdout.write(`FINDING route=${route.path} theme=${theme} width=${width} opacity=0 element=${finding}\n`);
    }

    await Promise.all(imageResponses.values());
    const imageEntries = await page.locator("img").evaluateAll((images) => images.map((image) => ({
      url: image.currentSrc || image.src,
    })));
    const performanceBytes = await page.evaluate(() => Object.fromEntries(
      performance.getEntriesByType("resource")
        .filter((entry) => entry.initiatorType === "img")
        .map((entry) => [entry.name, entry.encodedBodySize || entry.transferSize || 0]),
    ));
    const images = new Map();
    for (const { url } of imageEntries) {
      if (!url || images.has(url)) continue;
      const bytes = dataUrlBytes(url) || await imageResponses.get(url) || performanceBytes[url] || 0;
      images.set(url, bytes);
    }
    const imageList = [...images.entries()].map(([url, bytes]) => ({ url, bytes }));
    const largestImage = imageList.reduce((largest, image) => image.bytes > largest.bytes ? image : largest, {
      url: null,
      bytes: 0,
    });
    const filename = `${route.slug}-${theme}-${width}.png`;
    await page.screenshot({
      path: path.join(OUTPUT, filename),
      fullPage: true,
      animations: "disabled",
      caret: "hide",
    });

    return {
      file: filename,
      route: route.path,
      theme,
      width,
      title: await page.title(),
      h1Count: await page.locator("h1").count(),
      imageCount: imageEntries.length,
      totalImageBytes: imageList.reduce((total, image) => total + image.bytes, 0),
      largestImage,
    };
  } finally {
    await page.close();
  }
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  const routes = await discoverRoutes();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const files = [];

  try {
    for (const route of routes) {
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            deviceScaleFactor: 1,
            locale: "en-US",
            colorScheme: theme,
            reducedMotion: "reduce",
            extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
            serviceWorkers: "block",
          });
          await context.route("**/*", (requestRoute) => {
            const requestUrl = new URL(requestRoute.request().url());
            if (requestUrl.origin === SITE_ORIGIN || requestUrl.protocol === "data:" || requestUrl.protocol === "blob:") {
              return requestRoute.continue();
            }
            return requestRoute.abort();
          });
          try {
            files.push(await capturePage(context, route, theme, width));
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  await writeFile(path.join(OUTPUT, "index.json"), `${JSON.stringify({ site: SITE, files }, null, 2)}\n`, "utf8");
  process.stdout.write(`Captured ${files.length} site audit images in ${OUTPUT}.\n`);
  process.stdout.write(`Routes: ${routes.map((route) => route.path).join(", ")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
