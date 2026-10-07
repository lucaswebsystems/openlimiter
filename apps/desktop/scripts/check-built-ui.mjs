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
        // What's New opens once over the one screen; dismiss it, then the
        // three tools that always have a row and the agent at work show.
        await page.locator("dialog.whats-new[open]").waitFor({ state: "visible" });
        await page.locator("dialog.whats-new button").click();
        await page.locator("dialog.whats-new").waitFor({ state: "detached" });
        await page.locator("#agents-mount .q-agent").waitFor({ state: "visible" });
        assert.ok(await page.locator("main").isVisible(), "the screen must be visible");
        const rows = await page.locator("#tool-rows [data-provider-card]").evaluateAll((cards) => cards.map((card) => card.dataset.provider));
        for (const code of ["CLAUDE", "ANTIGRAVITY", "OPENROUTER"]) assert.ok(rows.includes(code), `${code} has no row: ${rows.join(", ")}`);
        assert.equal(await page.locator("[role=tab], .tabs").count(), 0, "no tab bar");
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
 * These render the one screen at the window's real widths, 420 and 586, and
 * the edge panel at its real 360 by 480 size, dark and light, from the
 * synthetic 2.0.1 shapes and the four review states in ui/messy-fixtures.mjs,
 * and read the layout back: every visible text box inside its card and clear
 * of every other, no raw code, no "Unknown", no hash, no sideways scroll,
 * exactly one Claude and one Codex row, every tool that cannot be measured on
 * its own row with its one step, and the six key rows. `--shots=<dir>` also
 * writes the 2x screenshots a person reviews.
 */
async function checkMessyViews(browser, origin) {
  const { messyFixtures, emptyFixtures, tallFixtures, screenFixtures } = await import(new URL("../ui/messy-fixtures.mjs", import.meta.url).href);
  const { version } = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const shotsArgument = process.argv.find(argument => argument.startsWith("--shots="));
  const shots = shotsArgument ? path.resolve(shotsArgument.slice("--shots=".length)) : null;
  if (shots) await mkdir(shots, { recursive: true });
  const failures = [];
  const hidden = ["Kimi", "Antigravity"];
  const open = async (theme, viewport, entry, { set = "projected", agents = false, clock = false, cardOpen, mac = false, screen = null } = {}) => {
    const fixtures = screen !== null ? screenFixtures(Date.now())[screen]
      : set === "tall" ? tallFixtures(Date.now()) : set === "empty" ? emptyFixtures() : messyFixtures(Date.now());
    const payload = screen !== null ? fixtures.cache : set === "raw" ? fixtures.raw : fixtures.projected;
    const context = await browser.newContext({ viewport, deviceScaleFactor: shots ? 2 : 1, colorScheme: theme, serviceWorkers: "block" });
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    if (clock) await context.clock.install({ time: new Date() });
    if (mac) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
    await context.addInitScript(installFixtureStub, { payload, sessions: agents || screen !== null ? fixtures.sessions : [], theme, version, cardOpen,
      screen: screen === null ? null : fixtures, /* First run counts as done once a tool is chosen; OpenRouter always has a row anyway. */
      configured: screen === null ? ["CLAUDE", "CODEX", "OPENROUTER"] : ["OPENROUTER"] });
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
    .map(provider => `${label}: ${counted[provider] ?? 0} ${provider === "CLAUDE" ? "Claude" : "Codex"} rows, expected exactly one`);
  const settle = page => page.waitForFunction(() => document.fonts.status === "loaded").then(() => page.waitForTimeout(350));
  // What the projected messy set must read as, card by card, tightest first.
  const readings = [
    ["CODEX", "Codex", [["Weekly", "70%"]]],
    ["CLAUDE", "Claude Code", [["Current session", "6%"], ["Weekly, all models", "46%"], ["Weekly, Fable", "31%"]]],
    ["OPENROUTER", "OpenRouter", [["Account balance", "$37.50"]]],
  ];
  // Each tool that cannot be measured, on its own row: its one step, or its note.
  const steps = { KIMI: "Check again", ANTIGRAVITY: "Set up status line", GROK: "Sign in again", OPENCODE: "Connect", GEMINI_CLI: "note:Not measurable yet" };
  const stateSteps = {
    empty: { CLAUDE: "Connect", ANTIGRAVITY: "Set up status line", OPENROUTER: "Connect" },
    waiting: { CLAUDE: "note:Waiting for Claude Code", ANTIGRAVITY: "Set up status line", OPENROUTER: "Connect" },
    money: {},
    errors: { CLAUDE: "Check again", ANTIGRAVITY: "Set up status line", OPENROUTER: "Connect", GROK: "Sign in again", GEMINI_CLI: "note:Not measurable yet", KIMI: "Check again" },
  };
  const emptyKeys = Object.fromEntries(["openrouter", "openai", "anthropic", "xai", "moonshot", "deepseek"].map((provider) => [provider, ["Save", "Get key"]]));
  const stateKeys = {
    empty: emptyKeys,
    waiting: emptyKeys,
    money: {
      openrouter: ["OpenRouter Key saved"], openai: ["$84.17", "spent this month", "USD"], anthropic: ["$212.40", "last month"],
      xai: ["$9.03", "Incomplete"], moonshot: ["$41.50", "balance"], deepseek: ["$18.20", "balance"],
    },
    errors: {
      openrouter: ["Key not accepted, paste a new one"], openai: ["Project key won't work, use an Admin key", "Get key"],
      anthropic: ["$57.80", "Unavailable"], xai: ["Checking key"], moonshot: ["$0.62", "Too low for API calls"], deepseek: ["Reported in CNY"],
    },
  };
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

      await page.locator('#tool-rows [data-provider="ANTIGRAVITY"] button:not(.q-more)').click();
      await settle(page);
      const antigravityInView = await page.evaluate(() => {
        const panel = document.getElementById("antigravity-add");
        if (!panel) return "panel not found";
        if (panel.hidden || getComputedStyle(panel).display === "none") return "panel is hidden";
        const rect = panel.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return "panel has zero dimensions";
        if (document.activeElement !== panel && !panel.contains(document.activeElement)) return "panel does not have focus";
        return rect.top >= 0 && rect.bottom <= window.innerHeight ? true : "panel is not within the viewport";
      });
      if (antigravityInView !== true) errors.push(antigravityInView);
      record("Antigravity setup scroll", errors);
    } finally { await context.close(); }
  }

  for (const theme of ["dark", "light"]) {
    // The projected cache is what the webview receives; the raw one is what
    // 2.0.1 received, and it must not break the one row per tool rule. Both
    // real window widths, 420 and 586.
    for (const width of [420, 586]) {
      for (const [set, agents] of [["projected", false], ["raw", false], ["projected", true]]) {
        const payloadName = `${set} cache${agents ? ", agents at work" : ""}`;
        const { context, page, errors } = await open(theme, { width, height: 800 }, "index.html", { set, agents });
        try {
          await page.waitForSelector("#tool-rows [data-provider-card]", { timeout: 5000 }).catch(() => {});
          if (agents) await page.waitForSelector("#agents-mount .q-agent", { timeout: 3000 }).catch(() => {});
          await settle(page);
          const home = await page.evaluate(inspectView, { scope: "#home", cards: "[data-provider-card], [data-key-row]", forbidden: [] });
          const shown = set === "projected" ? await page.evaluate(inspectReadings, { scope: "#tool-rows", expected: readings }) : [];
          const expectedSteps = set === "raw" ? Object.fromEntries(Object.entries(steps).filter(([provider]) => provider !== "GROK")) : steps;
          const stepped = await page.evaluate(inspectSteps, { scope: "#tool-rows", steps: expectedSteps, absent: ["CURSOR"] });
          const keys = await page.evaluate(inspectKeys);
          const fit = await page.evaluate(inspectFit);
          // The header runs the full width on the page's own background, never an inset box.
          const band = await page.evaluate(() => {
            const strip = document.querySelector("body > .strip");
            const box = strip.getBoundingClientRect();
            const full = document.documentElement.clientWidth;
            const paint = getComputedStyle(strip).backgroundColor;
            return [
              ...(Math.abs(box.left) > 0.5 || Math.abs(box.right - full) > 0.5 ? [`the header spans ${box.left} to ${box.right} of ${full}`] : []),
              ...(paint === "rgba(0, 0, 0, 0)" ? [] : [`the header paints its own background ${paint}`]),
            ];
          });
          const agentSection = await page.evaluate(() => document.getElementById("agents-section").hidden);
          const sectionFinding = agentSection === agents ? [`the agents section is ${agentSection ? "hidden" : "shown"} with ${agents ? "" : "no "}sessions`] : [];
          record(`Home ${width}x800 ${theme}, ${payloadName}`, [...home.findings, ...shown, ...stepped, ...keys, ...fit, ...band, ...sectionFinding, ...cards("Home", home.cards), ...errors]);
          if (agents || set !== "projected") continue;
          // Add a tool opens the catalogue inline, below the last row.
          await page.locator("#add-tool").click();
          await settle(page);
          const catalogue = await page.evaluate(() => {
            const list = document.getElementById("tool-catalogue");
            const rows = [...list.querySelectorAll("[data-provider-card]")];
            return [
              ...(list.checkVisibility() ? [] : ["Add a tool did not open the catalogue"]),
              ...(document.getElementById("add-tool").getAttribute("aria-expanded") === "true" ? [] : ["Add a tool is not marked expanded"]),
              ...(rows.length ? [] : ["the catalogue is empty"]),
              ...rows.filter((row) => row.querySelectorAll("button[data-action]").length !== 1).map((row) => `${row.dataset.provider} in the catalogue has no single step`),
            ];
          });
          const catalogueView = await page.evaluate(inspectView, { scope: "#tool-catalogue", cards: "[data-provider-card]", forbidden: [] });
          record(`Add a tool ${width} ${theme}`, [...catalogue, ...catalogueView.findings, ...errors]);
          // The menu holds the plan, the settings and the links, in short labels.
          await page.locator("#menu-button").click();
          await page.waitForSelector("#pro-plan", { timeout: 3000 }).catch(() => {});
          await settle(page);
          const menu = await page.evaluate(inspectView, { scope: "#app-menu", cards: ".menu-line, .menu-checks, .plan-card, .menu-actions, .menu-links", forbidden: [] });
          const reach = await page.evaluate(() => [
            ...(document.querySelector("#app-menu #pro-plan #pro-upgrade-monthly") ? [] : ["the menu has no plan card with Checkout"]),
            ...(document.querySelector("#app-menu #alerts-enabled") ? [] : ["the menu has no Alerts switch"]),
            ...(document.querySelector("#app-menu #claude-poll") ? [] : ["the menu has no Claude direct poll switch"]),
            ...(document.querySelectorAll("#app-menu .menu-switches input[role=switch]").length >= 9 ? [] : ["the menu lacks the provider switches"]),
            ...([...document.querySelectorAll("#app-menu .menu-links a")].map((link) => link.textContent).join() === "Privacy,Terms,Docs" ? [] : ["the menu lacks Privacy and Terms"]),
          ]);
          record(`Menu ${width} ${theme}`, [...menu.findings, ...reach, ...errors]);
          if (shots && width === 420) await page.screenshot({ path: path.join(shots, `menu-${width}-${theme}.png`) });
        } finally { await context.close(); }
      }
      // The four review states, read back and, with --shots, photographed.
      for (const state of ["empty", "waiting", "money", "errors"]) {
        const { context, page, errors } = await open(theme, { width, height: 800 }, "index.html", { screen: state });
        try {
          await page.waitForSelector("#tool-rows [data-provider-card]", { timeout: 5000 }).catch(() => {});
          if (state === "money") await page.waitForSelector("#agents-mount .q-agent", { timeout: 3000 }).catch(() => {});
          await settle(page);
          const view = await page.evaluate(inspectView, { scope: "#home", cards: "[data-provider-card], [data-key-row]", forbidden: [] });
          const stepped = await page.evaluate(inspectSteps, { scope: "#tool-rows", steps: stateSteps[state], absent: [] });
          const words = await page.evaluate(inspectKeyWords, { expected: stateKeys[state] });
          const fit = await page.evaluate(inspectFit);
          record(`State ${state} ${width} ${theme}`, [...view.findings, ...stepped, ...words, ...fit, ...errors]);
          if (shots) await page.screenshot({ path: path.join(shots, `${state}-${width}-${theme}.png`), fullPage: true });
        } finally { await context.close(); }
      }
    }
    // A failed read keeps only what is still fresh of what was on screen, by
    // the one freshness policy, and says why; it never freezes old numbers,
    // and the tools that always have a row keep it, with their step.
    {
      const { context, page, errors } = await open(theme, { width: 586, height: 800 }, "index.html", { clock: true });
      try {
        await page.waitForSelector("#tool-rows .q-row", { timeout: 5000 }).catch(() => {});
        const measured = () => page.evaluate(() => [...document.querySelectorAll("#tool-rows [data-provider-card]")].filter((card) => card.querySelector(".q-row")).length);
        const before = await measured();
        await page.evaluate(() => { window.__failCache = true; });
        // The next poll fails while everything drawn is still fresh: it all stays, and the status says why.
        await page.clock.fastForward("00:31");
        await page.waitForTimeout(400);
        const held = { cards: await measured(), status: await page.evaluate(() => document.getElementById("home-refresh-status")?.textContent ?? "") };
        const sentence = "The saved readings could not be read just now, so only readings that are still fresh are shown.";
        const kept = [
          ...(held.cards === before ? [] : [`a failed read left ${held.cards} of ${before} still fresh tools`]),
          ...(held.status === sentence ? [] : [`after a failed read the status says "${held.status}"`]),
        ];
        await page.clock.fastForward("25:00");
        await page.waitForTimeout(400);
        const findings = await page.evaluate((expected) => {
          const out = [];
          const status = document.getElementById("home-refresh-status")?.textContent ?? "";
          const cards = [...document.querySelectorAll("#tool-rows [data-provider-card]")];
          if (cards.some((card) => card.querySelector(".q-row"))) out.push("expired bars are still drawn after a failed read");
          for (const code of ["CLAUDE", "ANTIGRAVITY", "OPENROUTER"]) {
            if (!cards.some((card) => card.dataset.provider === code)) out.push(`${code} lost its row after the readings expired`);
          }
          if (status !== expected) out.push(`the status says "${status}"`);
          if (document.getElementById("failures")?.textContent.includes("Manual")) out.push("the failure names Manual");
          return out;
        }, sentence);
        record(`Home ${theme}, cache read fails, then the readings expire`, [...(before ? [] : ["no bars were drawn before the read failed"]), ...kept, ...findings, ...errors]);
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
    // macOS draws the panel opaque with the card stretched to the window. The
    // report must still follow the content down as well as up: sized to a
    // tall report, a panel whose content shrinks reports less, and grows back.
    if (theme === "dark") {
      const { context, page, errors } = await open(theme, { width: 360, height: 480 }, "edge-panel.html", { set: "tall", agents: true, mac: true });
      try {
        const findings = [];
        const latest = () => page.evaluate(() => window.__heights.at(-1));
        const sizeTo = async height => {
          const sized = Math.min(Math.max(height, PANEL_MIN), PANEL_MAX);
          await page.setViewportSize({ width: 360, height: sized });
          await settle(page);
          return sized;
        };
        // The panel polls every two seconds while open, so a change shows within one poll.
        const nextReport = (test, before) => page.waitForFunction(([kind, value]) =>
          kind === "less" ? window.__heights.at(-1) < value : window.__heights.at(-1) > value, [test, before], { timeout: 6000 }).catch(() => {});
        await settle(page);
        if (!(await page.evaluate(() => document.documentElement.classList.contains("opaque")))) findings.push("the macOS opaque layout did not apply");
        const tall = await latest();
        const frame = await sizeTo(tall);
        await page.evaluate(short => { window.__cache = short; window.__sessions = []; }, messyFixtures(Date.now()).projected);
        await nextReport("less", frame);
        const short = await latest();
        // Below the window it was sized to: the content needs less, not the window's height again.
        if (!(short < frame)) findings.push(`sized to ${frame}, the panel reported ${short} after its content shrank`);
        await sizeTo(short);
        const fit = await page.evaluate(() => {
          const scroll = document.getElementById("panel-scroll");
          const content = document.getElementById("panel-content") ?? scroll;
          return { overflow: scroll.scrollHeight - scroll.clientHeight, blank: scroll.clientHeight - content.offsetHeight,
            again: window.__heights.at(-1) };
        });
        if (fit.overflow > 1) findings.push(`sized to its shrunken report ${short}, the panel clips ${fit.overflow} pixels`);
        if (fit.blank > 1) findings.push(`sized to its shrunken report ${short}, the panel leaves ${fit.blank} blank pixels below its content`);
        if (fit.again !== short) findings.push(`the panel reported ${fit.again} after being sized to ${short}`);
        await page.evaluate(() => { window.__cache = null; window.__sessions = null; });
        await nextReport("more", short);
        const grown = await latest();
        if (!(grown > short)) findings.push(`sized to ${short}, the panel reported ${grown} after its content grew back`);
        record(`Edge panel ${theme}, macOS opaque layout, shrinks and grows with its content (${tall}, ${short}, ${grown})`, [...findings, ...errors]);
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
function installFixtureStub({ payload, sessions, theme, version, cardOpen = true, screen = null, configured = [] }) {
  window.__heights = [];
  localStorage.setItem("openlimiter-first-run-complete-v1", "complete");
  localStorage.setItem("openlimiter-configured-providers-v1", JSON.stringify(configured));
  localStorage.setItem("openlimiter-theme", theme);
  localStorage.setItem("openlimiter-whats-new-seen", version);
  const records = sessions.map(session => ({ ...session,
    firstObservedAt: new Date(Date.now() - session.elapsedSeconds * 1000).toISOString() }));
  window.__TAURI__ = {
    core: { invoke: async (name, args) => {
      if (name === "plugin:rail|rail_card_height") { window.__heights.push(args.height); return null; }
      if (name === "read_cache") {
        // What Tauri hands the window for an Err(String): a rejection carrying the sentence.
        if (window.__failCache) return Promise.reject("The saved readings could not be read.");
        return JSON.stringify(window.__cache ?? payload);
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
      if (name === "plugin:rail|rail_snapshot") return { accounts: [], flags: payload.flags ?? [], sessions: window.__sessions ?? sessions,
        window: { available: true, visible: true, unfolded: true, keepOpen: false, offset: 0, cardOpen, cardAnchor: null } };
      if (name === "list_connections") return screen?.connections ?? [];
      if (["disabled_providers", "notification_events"].includes(name)) return [];
      if (name === "list_detected_providers") return screen?.detections ?? { providers: [] };
      if (name === "api_spend_status") return screen?.spend ?? { version: 1, localDisplayIsFree: true, sources: [], samples: [] };
      if (name === "detect_local_tools") return screen?.claude ?? { claude_settings_present: true, statusline_wired: true };
      if (name === "claude_connect_preflight") return screen?.preflight ?? { kind: "ready", cli_path: "openlimiter" };
      if (name === "claude_poll_enabled") return false;
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
    const provider = card.dataset.provider ?? card.dataset.keyRow ?? card.querySelector("[data-provider]")?.dataset.provider ?? "none";
    counted[provider] = (counted[provider] ?? 0) + 1;
  }
  return { findings, cards: counted };
}

/* Runs in the page. Each tool without a reading has one row with its one
   step: a visible, enabled button with the right words, or a muted note
   ("note:" in `steps`) and no button. A tool in `absent` has no row. */
function inspectSteps({ scope, steps, absent }) {
  const root = document.querySelector(scope);
  const findings = [];
  const shown = element => element !== null && element.checkVisibility() && element.getClientRects().length > 0;
  const rowsFor = provider => [...(root?.querySelectorAll(`[data-provider-card][data-provider="${provider}"]`) ?? [])].filter(shown);
  for (const [provider, expected] of Object.entries(steps)) {
    const rows = rowsFor(provider);
    if (rows.length !== 1) { findings.push(`${provider}: ${rows.length} rows, expected one`); continue; }
    const buttons = [...rows[0].querySelectorAll("button[data-action]")];
    const note = rows[0].querySelector(".q-tnote");
    if (expected.startsWith("note:")) {
      if (buttons.length) findings.push(`${provider}: offers "${buttons[0].textContent.trim()}" where a note is expected`);
      if (!shown(note) || note.textContent.trim() !== expected.slice(5)) findings.push(`${provider}: note "${note?.textContent.trim()}", expected "${expected.slice(5)}"`);
    } else if (buttons.length !== 1 || !shown(buttons[0])) {
      findings.push(`${provider}: ${buttons.length} visible steps, expected one`);
    } else {
      if (buttons[0].disabled) findings.push(`${provider}: its step is disabled`);
      if (buttons[0].textContent.trim() !== expected) findings.push(`${provider}: its step says "${buttons[0].textContent.trim()}", expected "${expected}"`);
    }
    if (rows[0].querySelector(".q-row")) findings.push(`${provider}: a step row also draws a bar`);
  }
  for (const provider of absent) if (rowsFor(provider).length) findings.push(`${provider}: has a row although it is switched off`);
  // Rows with a step or a note are one line each, all the same height.
  const heights = [...(root?.querySelectorAll("[data-provider-card]") ?? [])].filter(shown)
    .filter((card) => !card.querySelector(".q-row")).map((card) => card.clientHeight);
  if (new Set(heights).size > 1) findings.push(`rows without a reading differ in height: ${heights.join(", ")}`);
  return findings;
}

/* Runs in the page. Six key rows, OpenRouter first, and one consent line
   above the first Save while any row has one. */
function inspectKeys() {
  const findings = [];
  const rows = [...document.querySelectorAll("#key-rows [data-key-row]")].map((row) => row.dataset.keyRow);
  const order = ["openrouter", "openai", "anthropic", "xai", "moonshot", "deepseek"];
  if (rows.join() !== order.join()) findings.push(`key rows read ${rows.join(", ")}`);
  const consent = document.getElementById("key-consent");
  const firstSave = document.querySelector('#key-rows [data-key-action="save"]');
  if (firstSave && (!consent || !consent.checkVisibility())) findings.push("no consent line above the first Save");
  if (consent && firstSave && consent.getBoundingClientRect().bottom > firstSave.getBoundingClientRect().top) findings.push("the consent line is not above the first Save");
  return findings;
}

/* Runs in the page. Each key row says what it should, by provider. */
function inspectKeyWords({ expected }) {
  const findings = [];
  for (const [provider, words] of Object.entries(expected)) {
    const row = document.querySelector(`#key-rows [data-key-row="${provider}"]`);
    if (!row) { findings.push(`${provider}: no key row`); continue; }
    const text = row.innerText.replace(/\s+/gu, " ");
    for (const word of words) if (!text.includes(word)) findings.push(`${provider}: "${word}" missing from "${text.trim()}"`);
  }
  if (expected.anthropic?.includes("last month") && document.querySelector('#key-rows [data-key-row="anthropic"]')?.innerText.includes("this month")) {
    findings.push("last month's amount is labelled this month");
  }
  return findings;
}

/* Runs in the page. Nothing scrolls sideways and no control wraps its label. */
function inspectFit() {
  const findings = [];
  const page = document.documentElement;
  if (page.scrollWidth > page.clientWidth + 1) findings.push(`the page scrolls sideways: ${page.scrollWidth} in ${page.clientWidth}`);
  for (const button of document.querySelectorAll("#home button.q-btn, #home a.q-klink")) {
    if (!button.checkVisibility()) continue;
    const lines = [...button.getClientRects()].length;
    const height = button.getBoundingClientRect().height;
    if (lines > 1 || height > 40) findings.push(`"${button.textContent.trim()}" wraps`);
  }
  return findings;
}

/* Runs in the page. Reads the cards back in order: each provider's name, and
   each visible line's label and value. */
function inspectReadings({ scope, expected }) {
  const root = document.querySelector(scope);
  const findings = [];
  const shown = element => element !== null && element.checkVisibility() && element.getClientRects().length > 0;
  /* Measured tools only: a row with a step instead of bars is not a reading. */
  const cards = [...(root?.querySelectorAll("[data-provider-card]") ?? [])].filter(shown).filter(card => card.querySelector(".q-row"));
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
