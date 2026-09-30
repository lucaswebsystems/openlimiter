import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkImportGraph } from "./import-graph.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(desktop, "ui", "dist");
const config = JSON.parse(await readFile(path.join(desktop, "src-tauri", "tauri.conf.json"), "utf8"));
const csp = config.app.security.csp;
assert.equal(typeof csp, "string");
checkImportGraph(dist, ["index.html", "tray.html", "edge-tab.html", "edge-panel.html"]);

// The capture script resolves Playwright locally or from a global installation.
// Also accept the existing web dev dependency without adding desktop packages.
function loadPlaywright() {
  const roots = [import.meta.url, new URL("../../web/package.json", import.meta.url)];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules", "index.js"));
  for (const root of roots) {
    const require = createRequire(root);
    for (const name of ["playwright", "playwright-core"]) {
      try { return require(name); } catch { /* Try the next installed copy. */ }
    }
  }
  throw new Error("Playwright is unavailable. Use the existing capture or web development installation.");
}

const { chromium } = loadPlaywright();
// Resolve the installed binary before replacing every writable profile location.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const temporary = await mkdtemp(path.join(tmpdir(), "openlimiter-built-ui-"));
const profileKeys = ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMP", "TEMP", "TMPDIR"];
for (const key of new Set([...profileKeys, ...Object.keys(process.env).filter(key => key.startsWith("XDG_"))])) {
  process.env[key] = path.join(temporary, key.toLowerCase());
  await mkdir(process.env[key], { recursive: true });
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    const file = path.resolve(dist, `.${pathname}`);
    const relative = path.relative(dist, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": csp });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});

// Same core.invoke and event.listen bridge as scripts/capture-screenshots.mjs,
// extended with synthetic activity and edge tab snapshot replies. No native IPC is available.
function installCaptureStub() {
  localStorage.setItem("openlimiter-first-run-complete-v1", "complete");
  localStorage.setItem("openlimiter-configured-providers-v1", JSON.stringify(["CLAUDE"]));
  const now = new Date().toISOString();
  const session = { sessionId: "synthetic-session", agent: "claude_code", state: "busy", confidence: "explicit",
    firstObservedAt: now, observedAt: now, elapsedSeconds: 0, computer: "local" };
  const account = { provider: "claude", account: null, headlineMeterId: "quota", kind: "quota_percent",
    value: 42, meaning: "used", windowLabel: "Session", resetAt: null, freshness: "fresh",
    availability: "available", band: "green", precision: "exact", fidelityMarker: null,
    sessions: { busy: 1, waiting: 0, done: 0, idle: 0, unknown: 0 } };
  window.__TAURI__ = {
    core: { invoke: async name => {
      if (name === "read_cache") return JSON.stringify({ version: 2, snapshots: [], suppressions: [] });
      if (name === "read_manual") return "";
      if (name === "state_directory") return "the demo fixtures";
      if (name === "account_status") return { signedIn: false, syncEnabled: false, backendReachable: false };
      if (name === "notification_settings") return { enabled: false };
      if (name === "plugin:activity|activity_sessions") return [session];
      if (name === "plugin:activity|activity_notification_preferences") return {
        sound: "silent", local: { enabled: false, quietHours: null, mutedProviders: [] },
      };
      if (name === "plugin:rail|rail_snapshot") return { accounts: [account], sessions: [session],
        window: { available: true, visible: true, unfolded: true, keepOpen: false, offset: 120, cardOpen: true, cardAnchor: null } };
      if (["list_connections", "list_detected_providers", "disabled_providers", "notification_events"].includes(name)) return [];
      return null;
    } },
    event: { listen: async () => () => {} },
  };
}

let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath, env: process.env });
  process.stdout.write(`Chromium ${browser.version()}, exact desktop CSP\n`);
  for (const entry of ["index.html", "tray.html", "edge-tab.html", "edge-panel.html"]) {
    const context = await browser.newContext({ viewport: { width: 720, height: 800 }, serviceWorkers: "block" });
    const errors = [];
    await context.route("**/*", async route => {
      if (new URL(route.request().url()).origin === origin) await route.continue();
      else { errors.push(`External request: ${route.request().url()}`); await route.abort(); }
    });
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    try {
      const response = await page.goto(`${origin}/${entry}`);
      assert.equal(response.headers()["content-security-policy"], csp);
      if (entry === "index.html") {
        // What's New opens once over the landing tab. With no stubbed
        // connection the app lands on Connections, so dismiss and open Home.
        await page.locator("dialog.whats-new[open]").waitFor({ state: "visible" });
        await page.locator("dialog.whats-new button").click();
        await page.locator("dialog.whats-new").waitFor({ state: "detached" });
        await page.getByRole("tab", { name: "Home" }).click();
        await page.locator("#agents-mount .q-agent").waitFor({ state: "visible" });
        assert.ok(await page.locator("main").isVisible(), "Home must be visible");
      } else if (entry === "tray.html") {
        // The tray reaches its empty state only after start() loaded every
        // module it imports (1.3.3 shipped it importing a deleted file).
        await page.locator("#tray-empty").waitFor({ state: "visible" });
      } else {
        // The edge tab and its panel only need to load every module cleanly
        // under the exact CSP; their content is covered by the UI tests.
        await page.waitForLoadState("networkidle");
      }
      await page.waitForLoadState("networkidle");
      assert.deepEqual(errors, [], `${entry} browser errors`);
      process.stdout.write(`PASS ${entry}: rendered without browser errors\n`);
    } catch (error) {
      throw new Error(`${entry}: ${error.message}\n${errors.join("\n")}`, { cause: error });
    } finally { await context.close(); }
  }
  await checkMessyViews(browser, origin);
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}

/*
 * The checks that would have caught 2.0.1.
 *
 * 2.0.1 passed this script because it rendered an empty cache at 720 pixels.
 * These render Home at the real 520 by 800 window and the edge panel at its
 * real 360 by 480 size, dark and light, from the synthetic 2.0.1 shapes in
 * ui/messy-fixtures.mjs, and read the layout back: every visible text box
 * inside its card and clear of every other, no raw code, no "Unknown", no
 * hash, exactly one Claude and one Codex card, and the providers that cannot
 * be measured only on Connections, each with its fix. `--shots=<dir>` also
 * writes the 2x screenshots a person reviews.
 */
async function checkMessyViews(browser, origin) {
  const { messyFixtures, emptyFixtures, tallFixtures } = await import(new URL("../ui/messy-fixtures.mjs", import.meta.url).href);
  const { version } = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const shotsArgument = process.argv.find(argument => argument.startsWith("--shots="));
  const shots = shotsArgument ? path.resolve(shotsArgument.slice("--shots=".length)) : null;
  if (shots) await mkdir(shots, { recursive: true });
  const failures = [];
  const hidden = ["Kimi", "Antigravity"];
  const open = async (theme, viewport, entry, { set = "projected", agents = false, clock = false, cardOpen } = {}) => {
    const fixtures = set === "tall" ? tallFixtures(Date.now()) : set === "empty" ? emptyFixtures() : messyFixtures(Date.now());
    const payload = set === "raw" ? fixtures.raw : fixtures.projected;
    const context = await browser.newContext({ viewport, deviceScaleFactor: shots ? 2 : 1, colorScheme: theme, serviceWorkers: "block" });
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    if (clock) await context.clock.install({ time: new Date() });
    await context.addInitScript(installFixtureStub, { payload, sessions: agents ? fixtures.sessions : [], theme, version, cardOpen });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/${entry}`);
    await page.waitForLoadState("networkidle");
    return { context, page, errors };
  };
  const record = (label, findings) => {
    const unique = [...new Set(findings)];
    if (unique.length) failures.push(`${label}\n  ${unique.join("\n  ")}`);
    process.stdout.write(`${unique.length ? "FAIL" : "PASS"} ${label}${unique.length ? `: ${unique.length} findings` : ""}\n`);
  };
  const cards = (label, counted) => ["CLAUDE", "CODEX"].filter(provider => counted[provider] !== 1)
    .map(provider => `${label}: ${counted[provider] ?? 0} ${provider === "CLAUDE" ? "Claude" : "Codex"} cards, expected exactly one`);
  const settle = page => page.waitForFunction(() => document.fonts.status === "loaded").then(() => page.waitForTimeout(350));
  // What the projected messy set must read as, card by card, tightest first.
  const readings = [
    ["CODEX", "Codex", [["Weekly", "70%"]]],
    ["CLAUDE", "Claude Code", [["Weekly", "46%"], ["Fable weekly", "31%"], ["5 hour", "6%"]]],
    ["OPENROUTER", "OpenRouter", [["Credits", "$12.50"]]],
  ];
  // Each unmeasurable provider's fix: the button text, or null for a sentence only.
  const fixes = { KIMI: "Check again", ANTIGRAVITY: "Check again", GROK: "Check again", OPENCODE: "Reconnect", GEMINI_CLI: null };
  const connected = ["CLAUDE", "CODEX", "OPENROUTER"];
  const PANEL_MIN = 160;
  const PANEL_MAX = Math.floor(1040 * 0.9);

  // The overlap reader is checked too: an icon drawn over a label that sits
  // directly in the same button is an overlap, whatever contains what.
  {
    const { context, page, errors } = await open("dark", { width: 520, height: 800 }, "index.html", { set: "empty" });
    try {
      await page.evaluate(() => {
        const button = document.createElement("button");
        button.id = "overlap-canary";
        Object.assign(button.style, { position: "relative", padding: "8px 12px" });
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("width", "16");
        icon.setAttribute("height", "16");
        Object.assign(icon.style, { position: "absolute", left: "10px", top: "8px" });
        button.append(icon, "Check again");
        document.body.prepend(button);
      });
      const canary = await page.evaluate(inspectView, { scope: "#overlap-canary", cards: "button", forbidden: [] });
      const caught = canary.findings.some(finding => finding.startsWith("overlap:"));
      record("Overlap reader finds an icon drawn over its own button's label", [...(caught ? [] : ["it was not found"]), ...errors]);
    } finally { await context.close(); }
  }

  for (const theme of ["dark", "light"]) {
    // The projected cache is what the webview receives; the raw one is what
    // 2.0.1 received, and it must not break the one card per provider rule.
    for (const [set, agents] of [["projected", false], ["raw", false], ["projected", true]]) {
      const payloadName = `${set} cache${agents ? ", agents at work" : ""}`;
      const { context, page, errors } = await open(theme, { width: 520, height: 800 }, "index.html", { set, agents });
      try {
        await page.locator("#tab-meters").click();
        await page.waitForSelector("[data-provider-card], .home-provider-card", { timeout: 5000 }).catch(() => {});
        if (agents) await page.waitForSelector("#agents-mount .q-agent", { timeout: 3000 }).catch(() => {});
        await settle(page);
        const home = await page.evaluate(inspectView, { scope: "#panel-meters", cards: "[data-provider-card], .home-provider-card", forbidden: hidden });
        const shown = set === "projected" ? await page.evaluate(inspectReadings, { scope: "#panel-meters", expected: readings }) : [];
        // The header runs the full width on the page's own background, never an inset box.
        const band = await page.evaluate(() => {
          const strip = document.querySelector("body > .strip");
          const box = strip.getBoundingClientRect();
          const width = document.documentElement.clientWidth;
          const paint = getComputedStyle(strip).backgroundColor;
          return [
            ...(Math.abs(box.left) > 0.5 || Math.abs(box.right - width) > 0.5 ? [`the header spans ${box.left} to ${box.right} of ${width}`] : []),
            ...(paint === "rgba(0, 0, 0, 0)" ? [] : [`the header paints its own background ${paint}`]),
          ];
        });
        record(`Home 520x800 ${theme}, ${payloadName}`, [...home.findings, ...shown, ...band, ...cards("Home", home.cards), ...errors]);
        if (shots && set === "projected") await page.screenshot({ path: path.join(shots, `home-520${agents ? "-agents" : ""}-${theme}.png`), fullPage: true });
        if (agents) continue;
        await page.locator("#tab-connections").click();
        await page.waitForSelector("[data-flag-row]", { timeout: 3000 }).catch(() => {});
        await settle(page);
        const expectedFixes = set === "raw" ? Object.fromEntries(Object.entries(fixes).filter(([provider]) => provider !== "GROK")) : fixes;
        const flags = await page.evaluate(inspectFlags, { scope: "#panel-connections", fixes: expectedFixes, absent: ["CURSOR", "CLAUDE", "CODEX"] });
        const listed = await page.evaluate(inspectConnections, { scope: "#panel-connections", connected, catalogueOpen: false });
        const words = await page.evaluate(inspectView, { scope: "#panel-connections", cards: "[data-flag-row], [data-connected-row]", forbidden: [] });
        if (shots && set === "projected") await page.screenshot({ path: path.join(shots, `connections-${theme}.png`), fullPage: true });
        // Add a tool opens the whole catalogue, switches and accounts included.
        // (A missing button is already a finding above; there is nothing to press.)
        const add = page.locator("#add-tool");
        const pressed = await add.isVisible() && await add.click().then(() => true);
        const opened = !pressed ? [] : await page.evaluate(() => {
          const shown = element => element !== null && element.checkVisibility() && element.getClientRects().length > 0;
          return [
            ...(shown(document.querySelector("#provider-catalogue")) ? [] : ["Add a tool did not show the provider catalogue"]),
            ...(shown(document.querySelector("#plan-cap")) ? [] : ["Add a tool did not show the accounts card"]),
            ...(document.querySelector("#add-tool").getAttribute("aria-expanded") === "true" ? [] : ["Add a tool is not marked expanded"]),
          ];
        });
        record(`Connections ${theme}, ${payloadName}`, [...flags, ...listed, ...words.findings, ...opened, ...errors]);
      } finally { await context.close(); }
    }
    // Nothing connected yet: the catalogue is the page, with no Add a tool.
    {
      const { context, page, errors } = await open(theme, { width: 520, height: 800 }, "index.html", { set: "empty" });
      try {
        await page.locator("#tab-connections").click();
        await settle(page);
        const listed = await page.evaluate(inspectConnections, { scope: "#panel-connections", connected: [], catalogueOpen: true });
        const words = await page.evaluate(inspectView, { scope: "#panel-connections", cards: "[data-flag-row], [data-connected-row]", forbidden: [] });
        record(`Connections ${theme}, nothing connected yet`, [...listed, ...words.findings, ...errors]);
        if (shots && theme === "dark") await page.screenshot({ path: path.join(shots, `connections-empty-${theme}.png`), fullPage: true });
      } finally { await context.close(); }
    }
    // A failed read keeps only what is still fresh of what was on screen, by
    // the one freshness policy, and says why; it never freezes old numbers.
    {
      const { context, page, errors } = await open(theme, { width: 520, height: 800 }, "index.html", { clock: true });
      try {
        await page.locator("#tab-meters").click();
        await page.waitForSelector("[data-provider-card], .home-provider-card", { timeout: 5000 }).catch(() => {});
        const before = await page.locator("[data-provider-card], .home-provider-card").count();
        await page.evaluate(() => { window.__failCache = true; });
        await page.clock.fastForward("25:00");
        await page.waitForTimeout(400);
        const findings = await page.evaluate(() => {
          const out = [];
          const status = document.getElementById("home-refresh-status")?.textContent ?? "";
          if (document.querySelectorAll("[data-provider-card], .home-provider-card").length) out.push("expired cards are still drawn after a failed read");
          if (document.getElementById("empty")?.hidden !== false) out.push("the empty card is not shown after every reading expired");
          if (status !== "The saved readings could not be read just now, so only readings that are still fresh are shown.") {
            out.push(`the status says "${status}"`);
          }
          if (document.getElementById("failures")?.textContent.includes("Manual")) out.push("the failure names Manual");
          return out;
        });
        record(`Home ${theme}, cache read fails after the readings expire`, [...(before ? [] : ["no cards were drawn before the read failed"]), ...findings, ...errors]);
      } finally { await context.close(); }
    }
    // The panel reports the height its content needs and is sized to it (native
    // clamps between 160 and 90% of a 1040 pixel work area); it scrolls only
    // past that clamp.
    for (const [set, agents] of [["projected", false], ["projected", true], ...(theme === "dark" ? [["tall", true]] : [])]) {
      const { context, page, errors } = await open(theme, { width: 360, height: 480 }, "edge-panel.html", { set, agents });
      try {
        await page.waitForSelector("[data-provider-card]", { timeout: 3000 }).catch(() => {});
        await settle(page);
        const heights = await page.evaluate(() => window.__heights ?? []);
        const reported = heights.at(-1);
        const sized = Math.min(Math.max(reported ?? 480, PANEL_MIN), PANEL_MAX);
        await page.setViewportSize({ width: 360, height: sized });
        await settle(page);
        const fit = await page.evaluate(() => {
          const scroll = document.getElementById("panel-scroll") ?? document.querySelector(".p-scroll") ?? document.scrollingElement;
          return { overflow: scroll.scrollHeight - scroll.clientHeight, again: (window.__heights ?? []).at(-1) };
        });
        const findings = [];
        if (!Number.isFinite(reported)) findings.push("the panel never reported its height");
        if (set === "tall") {
          if (!(reported > PANEL_MAX)) findings.push(`a tall panel reported ${reported}, expected more than the clamp ${PANEL_MAX}`);
          if (fit.overflow <= 0) findings.push("a tall panel does not scroll past the clamp");
        } else if (fit.overflow > 1) {
          findings.push(`the panel sized to its reported ${reported} still clips ${fit.overflow} pixels`);
        }
        if (fit.again !== reported) findings.push(`the panel reported ${fit.again} after being sized to ${reported}`);
        const panel = await page.evaluate(inspectView, { scope: "body", cards: "[data-provider-card]", forbidden: set === "tall" ? [] : hidden });
        const shown = set === "projected" ? await page.evaluate(inspectReadings, { scope: "#panel-limits", expected: readings }) : [];
        const label = `Edge panel 360x${sized} ${theme}${set === "tall" ? ", tall" : agents ? ", agents example" : ""}`;
        record(label, [...findings, ...panel.findings, ...shown, ...(set === "tall" ? [] : cards("Panel", panel.cards)), ...errors]);
        // The panel window is transparent around its card, so the shot is too.
        if (shots) {
          const name = set === "tall" ? "panel-tall" : `panel${agents ? "-agents" : ""}`;
          await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`), omitBackground: true });
        }
      } finally { await context.close(); }
    }
    // The collapsed tab at its real 24 by 44, magnified for review, with and
    // without its pill (an agent waiting is what lights it here).
    for (const agents of shots ? [false, true] : []) {
      const context = await browser.newContext({ viewport: { width: 24, height: 44 }, deviceScaleFactor: 8, colorScheme: theme });
      await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(installFixtureStub, { payload: messyFixtures(Date.now()).projected,
        sessions: agents ? messyFixtures(Date.now()).sessions : [], theme, version, cardOpen: false });
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/edge-tab.html`);
        await page.waitForLoadState("networkidle");
        await settle(page);
        await page.screenshot({ path: path.join(shots, `tab${agents ? "-attention" : ""}-${theme}.png`), omitBackground: true });
      } finally { await context.close(); }
    }
  }
  if (failures.length) throw new Error(`The messy fixture views failed:\n${failures.join("\n")}`);
}

/* Runs in the page before any script: the same bridge shape as the stub above,
   answering with one messy fixture set. */
function installFixtureStub({ payload, sessions, theme, version, cardOpen = true }) {
  window.__heights = [];
  localStorage.setItem("openlimiter-first-run-complete-v1", "complete");
  localStorage.setItem("openlimiter-configured-providers-v1", JSON.stringify(["CLAUDE", "CODEX", "OPENROUTER"]));
  localStorage.setItem("openlimiter-theme", theme);
  localStorage.setItem("openlimiter-whats-new-seen", version);
  const records = sessions.map(session => ({ ...session,
    firstObservedAt: new Date(Date.now() - session.elapsedSeconds * 1000).toISOString() }));
  window.__TAURI__ = {
    core: { invoke: async (name, args) => {
      if (name === "plugin:rail|rail_card_height") { window.__heights.push(args.height); return null; }
      if (name === "read_cache") {
        if (window.__failCache) throw new Error("fixture cache read failure");
        return JSON.stringify(payload);
      }
      if (name === "connection_flags") return payload.flags ?? [];
      if (name === "read_manual") return "";
      if (name === "state_directory") return "the demo fixtures";
      if (name === "account_status") return { signedIn: false, syncEnabled: false, backendReachable: false };
      if (name === "notification_settings") return { enabled: false };
      if (name === "plugin:activity|activity_sessions") return records;
      if (name === "plugin:activity|activity_notification_preferences") return {
        sound: "silent", local: { enabled: false, quietHours: null, mutedProviders: [] },
      };
      if (name === "plugin:rail|rail_snapshot") return { accounts: [], flags: payload.flags ?? [], sessions,
        window: { available: true, visible: true, unfolded: true, keepOpen: false, offset: 0, cardOpen, cardAnchor: null } };
      if (["list_connections", "disabled_providers", "notification_events"].includes(name)) return [];
      if (name === "list_detected_providers") return { providers: [] };
      return null;
    } },
    event: { listen: async () => () => {} },
  };
}

/* Runs in the page. Reads one view back through open shadow roots. */
function inspectView({ scope, cards, forbidden }) {
  const root = document.querySelector(scope);
  if (!root) return { findings: [`${scope} is missing`], cards: {} };
  const findings = [];
  const words = new Set(["API", "CLI", "USD", "CNY"]);
  const excerpt = text => `"${text.trim().replace(/\s+/gu, " ").slice(0, 60)}"`;
  const checkWords = (text, where) => {
    for (const match of text.matchAll(/\b[A-Z]{3,}(?:_[A-Z0-9]+)*\b/gu)) {
      if (!words.has(match[0])) findings.push(`raw code ${match[0]} in ${where} ${excerpt(text)}`);
    }
    if (/\bunknown\b/iu.test(text)) findings.push(`"Unknown" in ${where} ${excerpt(text)}`);
    if (/[0-9a-f]{12,}/iu.test(text)) findings.push(`hex id in ${where} ${excerpt(text)}`);
    if (/[-‐-―−﹘﹣－]/u.test(text)) findings.push(`dash in ${where} ${excerpt(text)}`);
    for (const word of forbidden) if (text.includes(word)) findings.push(`${word} shown in ${where}`);
  };
  const up = element => element.parentElement ?? element.getRootNode().host ?? null;
  // Also false inside a closed details element, whose content keeps a box.
  const shown = element => element.checkVisibility({ visibilityProperty: true }) && element.getClientRects().length > 0;
  const leaves = [];
  const boxes = [];
  const visit = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const element = child.parentElement;
        if (!child.nodeValue.trim() || !element || ["STYLE", "SCRIPT", "TEMPLATE"].includes(element.tagName) || !shown(element)) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        const style = getComputedStyle(element);
        // Line boxes, not glyph boxes, so a tall face never overlaps its own
        // neighbouring line.
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0.5 && rect.height > 0.5).map(rect => {
          if (rect.height <= line) return rect;
          const top = rect.top + (rect.height - line) / 2;
          return { left: rect.left, right: rect.right, top, bottom: top + line };
        });
        if (!rects.length) continue;
        checkWords(child.nodeValue, "text");
        leaves.push({ text: child.nodeValue.trim().slice(0, 40), rects, element });
        rects.forEach(rect => boxes.push({ rect, label: excerpt(child.nodeValue), element, text: true }));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (shown(child)) {
          for (const name of ["aria-label", "title", "alt", "aria-valuetext"]) {
            const value = child.getAttribute(name);
            if (value) checkWords(value, `${name} of <${child.localName}>`);
          }
          if ((child.localName === "svg" && !child.parentElement?.closest("svg")) || child.localName === "img" ||
              child.getAttribute("role") === "progressbar") {
            boxes.push({ rect: child.getBoundingClientRect(), label: `<${child.localName} ${child.getAttribute("class") ?? ""}>`, element: child });
          }
        }
        if (child.shadowRoot) visit(child.shadowRoot);
        visit(child);
      }
    }
  };
  visit(root);
  const cardOf = element => {
    for (let at = element; at; at = up(at)) if (at.matches?.(cards)) return at;
    return null;
  };
  // Half a pixel across, a pixel and a half down: a line box centred on the
  // glyph box can sit that far from a box sized by line height.
  const outside = (rect, box) => rect.left < box.left - 0.5 || rect.right > box.right + 0.5 ||
    rect.top < box.top - 1.5 || rect.bottom > box.bottom + 1.5;
  for (const leaf of leaves) {
    const card = cardOf(leaf.element);
    if (card && leaf.rects.some(rect => outside(rect, card.getBoundingClientRect()))) {
      findings.push(`text outside its card: "${leaf.text}"`);
    }
    for (let at = leaf.element; at && at !== root; at = up(at)) {
      const style = getComputedStyle(at);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      // A scroller shows the rest on scroll; anything else hides it for good.
      if (/auto|scroll/u.test(style.overflowX + style.overflowY)) break;
      if (leaf.rects.some(rect => outside(rect, at.getBoundingClientRect()))) findings.push(`text clipped: "${leaf.text}"`);
      break;
    }
    const style = getComputedStyle(leaf.element);
    if (style.textOverflow === "ellipsis" && leaf.element.scrollWidth > leaf.element.clientWidth + 1) {
      findings.push(`text truncated: "${leaf.text}"`);
    }
  }
  // What a box shows once every clipping ancestor, scrollers included, has
  // cut it: content scrolled out of view cannot overlap anything on screen.
  const onScreen = (rect, element) => {
    let { left, right, top, bottom } = rect;
    for (let at = element; at && at !== document.documentElement; at = up(at)) {
      const style = getComputedStyle(at);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const box = at.getBoundingClientRect();
      left = Math.max(left, box.left); right = Math.min(right, box.right);
      top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
    }
    return { left, right, top, bottom };
  };
  const shownBoxes = boxes.map(box => ({ ...box, rect: onScreen(box.rect, box.element) }))
    .filter(box => box.rect.right - box.rect.left > 0.5 && box.rect.bottom - box.rect.top > 0.5);
  for (let a = 0; a < shownBoxes.length; a++) {
    for (let b = a + 1; b < shownBoxes.length; b++) {
      if (!shownBoxes[a].text && !shownBoxes[b].text &&
          (shownBoxes[a].element.contains(shownBoxes[b].element) || shownBoxes[b].element.contains(shownBoxes[a].element))) continue;
      if (shownBoxes[a].text && shownBoxes[b].text && shownBoxes[a].element === shownBoxes[b].element) continue;
      const first = shownBoxes[a].rect;
      const second = shownBoxes[b].rect;
      const width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
      const height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
      if (width > 1.5 && height > 3) findings.push(`overlap: ${shownBoxes[a].label} and ${shownBoxes[b].label}`);
    }
  }
  // Two limit labels must never read as one: a label that wraps keeps clear of
  // the label on the next line down.
  const labels = [...root.querySelectorAll(".q-lbl")].filter(shown)
    .map(label => ({ text: label.textContent.trim(), rect: label.getBoundingClientRect() })).sort((a, b) => a.rect.top - b.rect.top);
  for (let at = 1; at < labels.length; at++) {
    const [above, below] = [labels[at - 1], labels[at]];
    const gap = below.rect.top - above.rect.bottom;
    if (gap >= 0 && gap < 4 && below.rect.left < above.rect.right && above.rect.left < below.rect.right) {
      findings.push(`labels run together: "${above.text}" and "${below.text}" are ${gap.toFixed(1)} pixels apart`);
    }
  }
  const counted = {};
  for (const card of root.querySelectorAll(cards)) {
    if (!shown(card)) continue;
    const provider = card.dataset.provider ?? card.querySelector("[data-provider]")?.dataset.provider ?? "none";
    counted[provider] = (counted[provider] ?? 0) + 1;
  }
  return { findings, cards: counted };
}

/* Runs in the page. Each unmeasurable provider has one Needs attention row
   with its fix: a visible, enabled button with the right words, or, when
   nothing here can fix it, the sentence that says so. A switched off or
   measured provider has no row at all. */
function inspectFlags({ scope, fixes, absent }) {
  const root = document.querySelector(scope);
  const findings = [];
  const shown = element => element !== null && element.checkVisibility() && element.getClientRects().length > 0 &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const rowsFor = provider => [...(root?.querySelectorAll(`[data-flag-row][data-provider="${provider}"]`) ?? [])].filter(shown);
  for (const [provider, text] of Object.entries(fixes)) {
    const rows = rowsFor(provider);
    if (rows.length !== 1) { findings.push(`${provider}: ${rows.length} Needs attention rows on Connections, expected one`); continue; }
    const button = rows[0].querySelector("button[data-fix]");
    if (text === null) {
      if (button) findings.push(`${provider}: offers "${button.textContent.trim()}" where nothing here can fix it`);
      if (!shown(rows[0].querySelector("[data-fix]"))) findings.push(`${provider}: no sentence says it cannot be measured`);
    } else if (!shown(button)) {
      findings.push(`${provider}: its fix is not a visible control`);
    } else {
      if (button.disabled) findings.push(`${provider}: its fix is disabled`);
      if (button.textContent.trim() !== text) findings.push(`${provider}: its fix says "${button.textContent.trim()}", expected "${text}"`);
    }
  }
  for (const provider of absent) if (rowsFor(provider).length) findings.push(`${provider}: flagged although it should not be`);
  const count = document.getElementById("connections-count")?.textContent;
  if (count !== String(Object.keys(fixes).length)) findings.push(`the Connections tab counts ${count}, expected ${Object.keys(fixes).length}`);
  return findings;
}

/* Runs in the page. Reads the cards back in order: each provider's name, and
   each visible line's label and value. */
function inspectReadings({ scope, expected }) {
  const root = document.querySelector(scope);
  const findings = [];
  const shown = element => element !== null && element.checkVisibility() && element.getClientRects().length > 0;
  const cards = [...(root?.querySelectorAll("[data-provider-card]") ?? [])].filter(shown);
  const order = cards.map(card => card.dataset.provider).join(", ");
  const want = expected.map(([code]) => code).join(", ");
  if (order !== want) findings.push(`cards read ${order}, expected ${want}`);
  for (const [code, name, rows] of expected) {
    const card = cards.find(entry => entry.dataset.provider === code);
    if (!card) { findings.push(`${name}: no card`); continue; }
    const title = card.querySelector(".q-pname")?.textContent.trim();
    if (title !== name) findings.push(`${code}: named "${title}", expected "${name}"`);
    const lines = [...card.querySelectorAll(".q-row")].filter(shown);
    if (lines.length !== rows.length) findings.push(`${name}: ${lines.length} lines, expected ${rows.length}`);
    rows.forEach(([label, value], index) => {
      const line = lines[index];
      const got = [line?.querySelector(".q-lbl"), line?.querySelector(".q-val")];
      if (!got.every(shown)) { findings.push(`${name} line ${index + 1}: its label or value is not visible`); return; }
      const [text, reading] = got.map(element => element.textContent.trim());
      if (text !== label || !reading.startsWith(value)) findings.push(`${name} line ${index + 1}: "${text}" "${reading}", expected "${label}" "${value}"`);
    });
  }
  return findings;
}

/* Runs in the page. Connected lists exactly the connected providers with a
   green Connected; Add a tool shows while anything is connected and folds the
   catalogue away; nothing connected shows the catalogue itself. No sentence
   may claim nothing is connected while something is. */
function inspectConnections({ scope, connected, catalogueOpen }) {
  const root = document.querySelector(scope);
  const findings = [];
  const shown = element => element !== null && element.checkVisibility() && element.getClientRects().length > 0;
  const rows = [...(root?.querySelectorAll("[data-connected-row]") ?? [])].filter(shown);
  const listed = rows.map(row => row.dataset.provider).sort().join(", ");
  if (listed !== [...connected].sort().join(", ")) findings.push(`Connected lists ${listed || "nothing"}, expected ${connected.join(", ") || "nothing"}`);
  for (const row of rows) {
    const status = row.querySelector(".q-ok");
    if (!shown(status) || status.textContent.trim() !== "Connected") findings.push(`${row.dataset.provider}: no visible Connected status`);
  }
  const add = document.getElementById("add-tool");
  if (connected.length && (!shown(add) || add.disabled || add.textContent.trim() !== "Add a tool")) findings.push("no visible, enabled Add a tool");
  if (!connected.length && shown(add)) findings.push("Add a tool shows while nothing is connected");
  if (shown(document.getElementById("tool-catalogue")) !== catalogueOpen) {
    findings.push(`the catalogue is ${catalogueOpen ? "folded" : "open"}, expected ${catalogueOpen ? "open" : "folded"}`);
  }
  if (connected.length && /\bno (connections|account|accounts|providers?|tools?)\b[^.]*\b(yet|exist|connected)\b/iu.test(root?.innerText ?? "")) {
    findings.push("a sentence says nothing is connected while providers are connected");
  }
  return findings;
}
