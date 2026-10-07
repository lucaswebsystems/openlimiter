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
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Content-Security-Policy": csp });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});

function installCaptureStub() {
  localStorage.setItem("openlimiter-first-run-complete-v1", "complete");
  localStorage.setItem("openlimiter-configured-providers-v1", JSON.stringify(["CLAUDE"]));
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  const labels = { credentialOrigin: "official-local-tool", dataInterfaceStatus: "documented-api", automationRisk: "low", verification: "UNVERIFIED" };
  const snapshot = (provider, meter, value, accountId) => ({
    provider, meter, value, unit: "PERCENT", window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(), source: "documented_api", precision: "exact",
    observedAt: now, expiresAt: expires, labels, accountId,
  });
  const snapshots = [
    snapshot("CLAUDE", "FIVE_HOUR", 42, "claude-fixture"),
    snapshot("CODEX", "PRIMARY", 68, "codex-fixture"),
    snapshot("ANTIGRAVITY", "FIVE_HOUR", 84, "antigravity-fixture"),
    snapshot("OPENROUTER", "KEY_LIMIT", 32, "openrouter-fixture"),
  ];
  const session = { sessionId: "synthetic-session", agent: "claude_code", state: "busy", confidence: "explicit", firstObservedAt: now, observedAt: now, elapsedSeconds: 0, computer: "local" };
  const account = { provider: "claude", account: null, headlineMeterId: "quota", kind: "quota_percent", value: 42, meaning: "used", windowLabel: "Session", resetAt: null, freshness: "fresh", availability: "available", band: "green", precision: "exact", fidelityMarker: null, sessions: { busy: 1, waiting: 0, done: 0, idle: 0, unknown: 0 } };
  window.__TAURI__ = {
    core: { invoke: async name => {
      if (name === "read_cache") return JSON.stringify({ version: 2, snapshots, suppressions: [] });
      if (name === "read_manual") return "";
      if (name === "state_directory") return "the demo fixtures";
      if (name === "account_status") return { signedIn: false, syncEnabled: false, backendReachable: false };
      if (name === "notification_settings") return { enabled: false };
      if (name === "terminal_captions") return { captions: "short" };
      if (name === "pro_status") return { entitled: false };
      if (name === "plugin:activity|activity_sessions") return [session];
      if (name === "plugin:activity|activity_notification_preferences") return { sound: "silent", local: { enabled: false, quietHours: null, mutedProviders: [] } };
      if (name === "plugin:rail|rail_snapshot") return { accounts: [account], sessions: [session], window: { available: true, visible: true, unfolded: true, keepOpen: false, offset: 120, cardOpen: true, cardAnchor: null } };
      if (name === "api_spend_status") return { version: 1, localDisplayIsFree: true, sources: [], samples: [] };
      if (name === "detect_local_tools") return { providers: [{ provider_id: "claude", state: "present" }, { provider_id: "antigravity", state: "present" }] };
      if (name === "claude_connect_preflight") return { kind: "ready", cli_path: "openlimiter" };
      if (name === "claude_poll_enabled") return false;
      if (name === "list_detected_providers") return { providers: [] };
      if (["list_connections", "disabled_providers", "notification_events"].includes(name)) return [];
      return null;
    } },
    event: { listen: async () => () => {} },
  };
}

function inspectFit(page) {
  return page.evaluate(() => {
    function wraps(control) {
      const range = document.createRange();
      const lines = new Set();
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.textContent.trim()) continue;
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) lines.add(Math.round(rect.top));
      }
      return lines.size > 1;
    }
    const findings = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) findings.push("the page scrolls sideways");
    for (const button of document.querySelectorAll("main button:not(.preset):not(.q-more), main a")) {
      if (!button.checkVisibility()) continue;
      if (wraps(button)) findings.push(`control wraps: ${button.textContent.trim()}`);
    }
    for (const element of document.querySelectorAll("main .q-card, main .q-group, main .q-row")) {
      if (!element.checkVisibility()) continue;
      const box = element.getBoundingClientRect();
      if (box.left < -1 || box.right > innerWidth + 1) findings.push(`content clips: ${element.className}`);
    }
    for (const panel of document.querySelectorAll("main > [role=tabpanel]")) {
      if (panel.hidden) continue;
      const box = panel.getBoundingClientRect();
      if (box.width <= 0 || box.left < -1 || box.right > innerWidth + 1) findings.push(`panel clips: ${panel.id}`);
      if (panel.scrollWidth > innerWidth + 1) findings.push(`panel overflows: ${panel.id}`);
    }
    const visible = [...document.querySelectorAll("main .q-group, main button, main input")]
      .filter(element => element.checkVisibility());
    for (let index = 0; index < visible.length; index += 1) {
      const left = visible[index];
      const a = left.getBoundingClientRect();
      for (const right of visible.slice(index + 1)) {
        if (left.contains(right) || right.contains(left)) continue;
        const b = right.getBoundingClientRect();
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          findings.push(`controls overlap: ${left.className} and ${right.className}`);
        }
      }
    }
    return findings;
  });
}

async function dismissModal(page) {
  const firstRun = page.locator("#first-run");
  if (await firstRun.isVisible()) {
    await page.locator("#first-run-later").click();
    await firstRun.waitFor({ state: "hidden" });
  }
  /* What's New is a native dialog, not a role=dialog surface, and it opens
     once per version over Home; close it through its own button like the
     capture script does, or every tab click waits on the overlay. */
  const whatsNew = page.locator("dialog.whats-new[open]");
  if (await whatsNew.count()) {
    await whatsNew.locator("button").click();
    await whatsNew.waitFor({ state: "detached" });
  }
  if (await page.locator("[role=dialog][aria-modal=true]:visible").count()) return ["a modal remains visible"];
  if (await page.locator("dialog[open]").count()) return ["a dialog remains open"];
  return [];
}

function inspectChrome(page) {
  return page.evaluate(() => {
    window.scrollTo(0, 400);
    const chrome = document.querySelector(".chrome");
    const selected = document.querySelector("[role=tab][aria-selected=true]");
    const findings = [];
    if (!chrome || Math.abs(chrome.getBoundingClientRect().top) > 1) findings.push("chrome is not sticky at the viewport top");
    if (!selected || selected.getBoundingClientRect().bottom < 0 || selected.getBoundingClientRect().top > innerHeight) findings.push("active tab is not on screen");
    if (document.querySelectorAll("[role=tab]").length !== 3) findings.push("expected three tabs");
    return findings;
  });
}

function inspectView(page, id) {
  const required = {
    usage: ["#usage-rows", "#spend-rows", "#agents-mount"],
    tools: ["#tool-rows", "#key-rows", "#tool-catalogue"],
    settings: ["#settings-appearance", "#settings-alerts", "#pro-mount"],
  }[id];
  return page.evaluate(({ panelId, selectors }) => {
    const panel = document.querySelector(panelId);
    const findings = [];
    if (panel && !panel.hidden) {
      for (const selector of selectors) if (!panel.querySelector(selector)) findings.push(`${panelId} is missing ${selector}`);
    }
    return findings;
  }, { panelId: `#tab-panel-${id}`, selectors: required });
}

async function inspectTab(page, id, width, height, shots) {
  const panel = `#tab-panel-${id}`;
  await page.locator(`#tab-${id}`).click();
  await page.waitForTimeout(30);
  if (id === "tools") {
    const antigravity = page.locator('#tab-panel-tools [data-provider="ANTIGRAVITY"] [data-action="connect"]');
    await antigravity.click();
    const setup = page.locator("#antigravity-add");
    await setup.waitFor({ state: "visible" });
    await setup.scrollIntoViewIfNeeded();
    const setupBox = await setup.boundingBox();
    const rowBox = await page.locator('#tab-panel-tools [data-provider="ANTIGRAVITY"]').boundingBox();
    if (!setupBox || setupBox.top < -1 || setupBox.bottom > height + 1) throw new Error("Antigravity setup is not in the viewport");
    if (!rowBox || setupBox.top < rowBox.bottom - 1) throw new Error("Antigravity setup is not under its row");
  }
  const findings = await page.evaluate(({ panelId, tabId }) => {
    const panel = document.querySelector(panelId);
    const tabs = [...document.querySelectorAll("[role=tab]")];
    return [
      ...(panel && !panel.hidden ? [] : [`${panelId} is hidden`]),
      ...(tabs.filter(tab => tab.getAttribute("aria-selected") === "true").map(tab => tab.id).join() === `tab-${tabId}` ? [] : [`tab-${tabId} is not selected`]),
      ...(document.querySelectorAll(`${panelId} [role=tabpanel]`).length ? [`${panelId} contains a nested panel`] : []),
      ...(panelId === "#tab-panel-tools" && !document.querySelector("#antigravity-add") ? ["Antigravity setup is missing"] : []),
    ];
  }, { panelId: panel, tabId: id });
  findings.push(...await inspectView(page, id));
  findings.push(...await inspectFit(page));
  if (shots) await page.screenshot({ path: path.join(shots, `${id}-${width}x${height}.png`), fullPage: true });
  return findings;
}

let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath, env: process.env });
  process.stdout.write(`Chromium ${browser.version()}, exact desktop CSP\n`);
  const shotsArgument = process.argv.find(argument => argument.startsWith("--shots="));
  const shots = shotsArgument ? path.resolve(shotsArgument.slice("--shots=".length)) : null;
  if (shots) await mkdir(shots, { recursive: true });

  for (const entry of ["tray.html", "edge-tab.html", "edge-panel.html"]) {
    const context = await browser.newContext({ viewport: { width: 720, height: 800 }, serviceWorkers: "block" });
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const response = await page.goto(`${origin}/${entry}`);
    assert.equal(response.headers()["content-security-policy"], csp);
    await page.waitForLoadState("networkidle");
    assert.deepEqual(errors, [], `${entry} browser errors`);
    process.stdout.write(`PASS ${entry}: rendered with no browser errors\n`);
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 360, height: 480 }, serviceWorkers: "block" });
    const errors = [];
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/edge-panel.html`);
    await page.waitForLoadState("networkidle");
    const panelFit = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    assert.equal(panelFit, true, "edge panel clips at 360 by 480");
    assert.deepEqual(errors, [], "edge panel browser errors at 360 by 480");
    await context.close();
  }

  const widths = [380, 420, 520, 586, 900, 1400];
  for (const [width, height] of [...widths.map(width => [width, 800]), [520, 480]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    const errors = [];
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`${origin}/index.html`);
    await page.waitForLoadState("networkidle");
    await page.locator(".chrome").waitFor({ state: "visible" });
    const modalFindings = await dismissModal(page);
    if (modalFindings.length) throw new Error(`FAIL modal ${width}x${height}: ${modalFindings.join(", ")}`);
    const chromeFindings = await inspectChrome(page);
    assert.deepEqual(errors, [], `${width}x${height} browser errors`);
    if (chromeFindings.length) throw new Error(`FAIL chrome ${width}x${height}: ${chromeFindings.join(", ")}`);
    for (const id of ["usage", "tools", "settings"]) {
      const findings = await inspectTab(page, id, width, height, shots);
      if (findings.length) throw new Error(`FAIL ${id} ${width}x${height}: ${findings.join(", ")}`);
      process.stdout.write(`PASS ${id} ${width}x${height}\n`);
    }
    await context.close();
  }
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
