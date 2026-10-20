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
  /* A capture can ask for a fresh install, no readings or a detected set. */
  const desk = window.__desk ?? {};
  if (desk.theme) localStorage.setItem("openlimiter-theme", desk.theme);
  if (!desk.fresh) {
    localStorage.setItem("openlimiter-first-run-complete-v1", "complete");
    localStorage.setItem("openlimiter-configured-providers-v1", JSON.stringify(desk.configured ?? ["CLAUDE"]));
  }
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
    // An amount row: its value must not push the panel's countdown column out.
    { ...snapshot("OPENROUTER", "ACCOUNT_BALANCE", 12.54, "openrouter-fixture"), unit: "CREDITS" },
  ];
  const session = { sessionId: "synthetic-session", agent: "claude_code", state: "busy", confidence: "explicit", firstObservedAt: now, observedAt: now, elapsedSeconds: 0, computer: "local" };
  /* Start at sign in (2.1.6): the OS state, every write, every first run report. */
  window.__autostart = { enabled: false, writes: [], reports: 0 };
  const account = { provider: "claude", account: null, headlineMeterId: "quota", kind: "quota_percent", value: 42, meaning: "used", windowLabel: "Session", resetAt: null, freshness: "fresh", availability: "available", band: "green", precision: "exact", fidelityMarker: null, sessions: { busy: 1, waiting: 0, done: 0, idle: 0, unknown: 0 } };
  window.__TAURI__ = {
    core: { invoke: async (name, args) => {
      if (name === "autostart_status") return window.__autostart.enabled;
      if (name === "set_autostart") {
        window.__autostart.writes.push(args?.enabled);
        window.__autostart.enabled = args?.enabled === true;
        return window.__autostart.enabled;
      }
      if (name === "autostart_first_run_complete") {
        window.__autostart.reports += 1;
        return window.__autostart.enabled;
      }
      if (name === "read_cache") return JSON.stringify({ version: 2, snapshots: desk.noReadings ? [] : snapshots, suppressions: [] });
      if (name === "read_manual") return "";
      if (name === "state_directory") return "the demo fixtures";
      if (name === "account_status") return { signedIn: false, syncEnabled: false, backendReachable: false };
      if (name === "notification_settings") return { enabled: false };
      if (name === "terminal_captions") return { captions: "short" };
      if (name === "pro_status") {
        return desk.pro
          ? { state: "active", plan_state: "active", features: ["theme_preset"], theme_preset: true }
          : { entitled: false };
      }
      if (name === "plugin:activity|activity_sessions") return [session];
      if (name === "plugin:activity|activity_notification_preferences") return { sound: "silent", local: { enabled: false, quietHours: null, mutedProviders: [] } };
      if (name === "plugin:rail|rail_snapshot") return { accounts: [account], sessions: [session], window: { available: true, visible: true, unfolded: true, keepOpen: false, offset: 120, cardOpen: true, cardAnchor: null } };
      if (name === "api_spend_status") return { version: 1, localDisplayIsFree: true, sources: [], samples: [] };
      if (name === "detect_local_tools") return { providers: [{ provider_id: "claude", state: "present" }, { provider_id: "antigravity", state: "present" }] };
      if (name === "claude_connect_preflight") return { kind: "ready", cli_path: "openlimiter" };
      if (name === "claude_poll_enabled") return false;
      if (name === "terminal_runtime_status") return { version: "2.0.3", app_version: "2.1.0" };
      if (name === "list_detected_providers") {
        if (desk.unscanned) return { version: 1, scanned_at: "", providers: [] };
        return { providers: desk.detected ?? [] };
      }
      if (name === "codex_device_login_start") return { sessionId: "capture-session", userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device", expiresInSeconds: 150 };
      if (name === "codex_device_login_status") return { kind: "pending" };
      if (name === "codex_device_login_cancel") return null;
      if (["list_connections", "disabled_providers", "notification_events"].includes(name)) return [];
      return null;
    } },
    event: { listen: async (name, handler) => {
      (window.__listeners ??= {})[name] = [...(window.__listeners[name] ?? []), handler];
      return () => {};
    } },
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
    await page.locator("#first-run-continue").click();
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
    const rowBox = await page.locator('#tab-panel-tools [data-provider-card][data-provider="ANTIGRAVITY"]').boundingBox();
    if (!setupBox || setupBox.top < -1 || setupBox.bottom > height + 1) throw new Error("Antigravity setup is not in the viewport");
    if (!rowBox || setupBox.top < rowBox.bottom - 1) throw new Error("Antigravity setup is not under its row");
    const setupGeometry = await setup.evaluate((panel) => {
      const intersects = (left, right) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
      const panelBox = panel.getBoundingClientRect();
      const closeBox = panel.querySelector("[data-setup-close]").getBoundingClientRect();
      const commandBoxes = [...panel.querySelectorAll(".q-command-box")];
      return {
        closeIntersections: commandBoxes.filter((box) => intersects(closeBox, box.getBoundingClientRect())).length,
        copyEdgeGaps: commandBoxes.map((box) => panelBox.right - box.querySelector("button").getBoundingClientRect().right),
      };
    });
    if (setupGeometry.closeIntersections !== 0) throw new Error("Antigravity close button intersects a command box");
    if (setupGeometry.copyEdgeGaps.some((gap) => gap < 8)) throw new Error("Antigravity Copy button is less than 8 px from the panel edge");
  }
  if (id === "usage") {
    /* The stub's terminal runtime 2.0.3 is older than this build, and the
       command names this build, never the 2.1.0 the stamp read reports. */
    const update = page.locator('#tab-panel-usage [data-provider-card][data-provider="CLAUDE"] .q-runtime-notice pre');
    if (await update.textContent() !== `npx -y openlimiter@${config.version} terminal install claude`) throw new Error("the Usage tab's Claude card does not offer the runtime update");
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

/* The sign in sheet is a native modal: Tab never leaves it, the window behind
   it cannot be reached, Escape closes it, and focus returns to its opener. */
async function inspectSheet(page, shots, suffix) {
  const findings = [];
  const opener = page.locator("#account-offer-sign-in");
  await opener.focus();
  await page.keyboard.press("Enter");
  const sheet = page.locator("#sign-in");
  await sheet.waitFor({ state: "visible" });
  if (!await sheet.evaluate((node) => node.matches(":modal"))) findings.push("the sign in sheet is not modal");
  if (shots) await page.screenshot({ path: path.join(shots, `signin-sheet-520x720${suffix}.png`) });
  for (let press = 0; press < 14; press += 1) {
    await page.keyboard.press(press % 5 === 4 ? "Shift+Tab" : "Tab");
    if (!await page.evaluate(() => document.querySelector("#sign-in").contains(document.activeElement))) {
      findings.push("Tab left the sign in sheet");
      break;
    }
  }
  /* The window behind is inert: a point over a tab hits the sheet, and the
     tab cannot take focus even when asked. */
  const reachable = await page.evaluate(() => {
    const tab = document.querySelector("#tab-tools");
    const box = tab.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    tab.focus();
    return !document.querySelector("#sign-in").contains(hit) || document.activeElement === tab;
  });
  if (reachable) findings.push("the window behind the sheet can still be reached");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  if (!await opener.evaluate((node) => document.activeElement === node)) findings.push("focus did not return to the control that opened the sheet");
  return findings;
}

/* The start at sign in switch renders in Settings, reads the OS state, and
   writes both directions through the stub; the completed first run in the
   stub's storage was reported at launch. */
async function inspectAutostart(page) {
  await page.locator("#tab-settings").click();
  const control = page.locator("#autostart");
  await control.waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector("#autostart")?.disabled === false);
  const findings = [];
  if (await control.isChecked()) findings.push("the start at sign in switch is on while the OS says off");
  for (const expected of [true, false]) {
    await control.click();
    await page.waitForFunction((want) => {
      const input = document.querySelector("#autostart");
      return input.checked === want && !input.disabled && window.__autostart.enabled === want;
    }, expected);
  }
  const seen = await page.evaluate(() => ({
    writes: window.__autostart.writes,
    reports: window.__autostart.reports,
    label: document.querySelector('label[for="autostart"]')?.textContent,
    note: document.querySelector("#autostart-note")?.textContent,
    describedBy: document.querySelector("#autostart")?.getAttribute("aria-describedby"),
  }));
  if (JSON.stringify(seen.writes) !== "[true,false]") findings.push(`autostart writes were ${JSON.stringify(seen.writes)}`);
  if (seen.reports < 1) findings.push("the completed first run was not reported to Rust");
  if (seen.label !== "Start OpenLimiter when you sign in") findings.push("the start at sign in label is missing");
  if (seen.note !== "Keeps your bars current after a restart.") findings.push("the start at sign in note is missing");
  if (seen.describedBy !== "autostart-note") findings.push("the switch is not described by its note");
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
    const compactLabelsFit = await page.evaluate(() => {
      for (const label of document.querySelectorAll(".q-compact .q-lbl")) {
        const range = document.createRange();
        const lines = new Set();
        range.selectNodeContents(label);
        for (const rect of range.getClientRects()) lines.add(Math.round(rect.top));
        if (lines.size > 2) return false;
      }
      return true;
    });
    assert.equal(compactLabelsFit, true, "edge panel compact labels wrap past two lines at 360 by 480");
    /* The panel card clips its own overflow, so a page level scroll test cannot
       see a countdown pushed past its border; measure each cell instead. */
    const cellsInside = await page.evaluate(() => {
      const outside = [];
      for (const list of document.querySelectorAll(".q-compact")) {
        const edge = list.getBoundingClientRect().right + 1;
        for (const cell of list.querySelectorAll(".q-val, .q-rst, .q-colhead > *")) {
          const range = document.createRange();
          range.selectNodeContents(cell);
          const right = Math.max(0, ...[...range.getClientRects()].map((rect) => rect.right));
          if (right > edge) outside.push(cell.textContent.trim() || cell.className);
        }
      }
      return outside;
    });
    assert.deepEqual(cellsInside, [], "edge panel cells run past the panel edge at 360 by 480");
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
    if (width === 520 && height === 800) {
      const findings = await inspectAutostart(page);
      if (findings.length) throw new Error(`FAIL start at sign in ${width}x${height}: ${findings.join(", ")}`);
      process.stdout.write(`PASS start at sign in switch ${width}x${height}\n`);
    }
    await context.close();
  }

  /* A fresh install at the native window height: Connect lists only what the
     machine has, asks nothing about Claude, keeps Show my bars on screen, and
     ends on the bars with the account offered under them and no What's New. */
  const absent = ["gemini_cli", "grok", "kimi", "opencode", "openrouter"].map((provider_id) => ({ provider_id, state: "absent", accounts: [] }));
  for (const [width, theme] of [[380, "dark"], [520, "dark"], [900, "dark"], [520, "light"]]) {
    const height = 720;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await context.addInitScript(({ detected, theme }) => { window.__desk = { fresh: true, detected, theme }; }, { theme, detected: [
      { provider_id: "claude", state: "present", accounts: [] },
      { provider_id: "codex", state: "installed_logged_out", accounts: [] },
      { provider_id: "gemini_cli", state: "installed_logged_out", accounts: [] },
      { provider_id: "antigravity", state: "present", accounts: [] },
      ...absent.filter((entry) => entry.provider_id !== "gemini_cli"),
    ] });
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`${origin}/index.html`);
    await page.waitForLoadState("networkidle");
    const screen = page.locator("#first-run");
    await screen.waitFor({ state: "visible" });
    await page.locator("#first-run-status", { hasText: "Scan complete." }).waitFor();
    const findings = [];
    const exit = await page.locator("#first-run-continue").boundingBox();
    if (!exit || exit.y < 0 || exit.y + exit.height > height + 1) findings.push(`Show my bars is off screen at ${width}x${height}`);
    const rows = await page.locator("#first-run-providers .first-run-row").evaluateAll((nodes) => nodes.map((node) => node.dataset.provider));
    if (rows.join() !== "CODEX,CLAUDE,GEMINI_CLI,ANTIGRAVITY") findings.push(`first run rows are ${rows.join()}`);
    const words = await screen.innerText();
    if (/Fable|usage request|Anthropic|npm install|Create your account|Skip|stays local/u.test(words)) findings.push("the first run asks about Claude, an account or an install, or says something untrue");
    if (await page.locator("#first-run input:not([data-provider-switch])").count()) findings.push("a control other than a tool switch is in the first run");
    if (await page.locator("#first-run button:visible").evaluateAll((nodes) => nodes.filter((node) => node.id !== "first-run-continue" && !node.closest(".first-run-action")).length)) {
      findings.push("the first run has a second way out");
    }
    const suffix = theme === "dark" ? "" : `-${theme}`;
    if (shots) await page.screenshot({ path: path.join(shots, `firstrun-${width}x${height}${suffix}.png`) });
    /* The Codex device code counts down under itself, and Cancel ends the
       flow with Try again on the row. */
    const codex = page.locator('#first-run-providers [data-provider="CODEX"]');
    await codex.locator("button", { hasText: "Sign in" }).click();
    await codex.locator(".first-run-countdown", { hasText: /^Code expires in 2:(?:30|29|28)$/u }).waitFor();
    if (await codex.locator(".first-run-countdown").evaluate((node) => node.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="timer"]') !== null)) {
      findings.push("the countdown ticks inside a live region");
    }
    if (await codex.locator('[role="status"]').textContent() !== "Open this page and enter the code.") findings.push("the row did not say a code is waiting");
    if (shots) await page.screenshot({ path: path.join(shots, `firstrun-codex-${width}x${height}${suffix}.png`) });
    await codex.locator("button", { hasText: "Cancel" }).click();
    await codex.locator("button", { hasText: "Try again" }).waitFor();
    if (await codex.locator(".first-run-countdown").count()) findings.push("the countdown outlived its flow");
    const exitAfter = await page.locator("#first-run-continue").boundingBox();
    if (!exitAfter || exitAfter.y + exitAfter.height > height + 1) findings.push("Show my bars left the screen during a sign in");
    await page.locator("#first-run-continue").click();
    await screen.waitFor({ state: "hidden" });
    await page.locator("#account-offer").waitFor({ state: "visible" });
    if (await page.locator("dialog.whats-new[open]").count()) findings.push("What's New opened over a fresh install");
    findings.push(...await inspectFit(page));
    assert.deepEqual(errors, [], `first run ${width}x${height} browser errors`);
    if (shots) await page.screenshot({ path: path.join(shots, `after-firstrun-${width}x${height}${suffix}.png`), fullPage: true });
    if (width === 520) findings.push(...await inspectSheet(page, shots, suffix));
    if (findings.length) throw new Error(`FAIL first run ${width}x${height}: ${findings.join(", ")}`);
    process.stdout.write(`PASS first run ${width}x${height}\n`);
    await context.close();
  }

  /* A window opened before Rust's first scan: Connect keeps checking and
     calls nothing absent, then fills in when the scan event arrives. */
  {
    const [width, height] = [520, 720];
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await context.addInitScript(() => { window.__desk = { fresh: true, unscanned: true }; });
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/index.html`);
    await page.waitForLoadState("networkidle");
    await page.locator("#first-run").waitFor({ state: "visible" });
    const findings = [];
    if (await page.locator("#first-run-status").innerText() !== "Checking local tools.") findings.push("an unscanned inventory did not keep checking");
    if (await page.locator("#first-run-providers .first-run-row").count()) findings.push("rows were drawn from an unscanned inventory");
    if (await page.locator("#first-run-absent").innerText() !== "") findings.push("an unscanned inventory called tools absent");
    if (shots) await page.screenshot({ path: path.join(shots, `firstrun-checking-${width}x${height}.png`) });
    await page.evaluate(() => {
      window.__desk.unscanned = false;
      window.__desk.detected = [{ provider_id: "codex", state: "present", accounts: [] }];
      for (const handler of window.__listeners?.["collector-updated"] ?? []) handler({ payload: null });
    });
    await page.locator("#first-run-status", { hasText: "Scan complete." }).waitFor();
    const rows = await page.locator("#first-run-providers .first-run-row").evaluateAll((nodes) => nodes.map((node) => node.dataset.provider));
    if (rows.join() !== "CODEX") findings.push(`the landed scan drew ${rows.join()}`);
    assert.deepEqual(errors, [], "unscanned first run browser errors");
    if (findings.length) throw new Error(`FAIL unscanned first run: ${findings.join(", ")}`);
    process.stdout.write(`PASS first run waits for the scan ${width}x${height}\n`);
    await context.close();
  }

  /* The four presets, each applied for real, in both themes: Product, then
     Graphite and Meadow (free) and Ember (Pro, here entitled). */
  const accents = {
    dark: { default: "#2f81f7", graphite: "#c3ccd8", meadow: "#3fb950", ember: "#ffa657" },
    light: { default: "#2f81f7", graphite: "#46566b", meadow: "#1a7f37", ember: "#bc4c00" },
  };
  for (const theme of ["dark", "light"]) {
    const [width, height] = [520, 800];
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await context.addInitScript((chosen) => { window.__desk = { pro: true, theme: chosen }; }, theme);
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/index.html`);
    await page.waitForLoadState("networkidle");
    await dismissModal(page);
    await page.locator("#tab-settings").click();
    const findings = [];
    for (const preset of ["default", "graphite", "meadow", "ember"]) {
      const tile = page.locator(`button[data-preset="${preset}"]`);
      await tile.click();
      await page.waitForFunction((id) => document.documentElement.getAttribute("data-preset") === id, preset);
      await page.locator(`button[data-preset="${preset}"][aria-pressed="true"]`).waitFor();
      const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ol-accent").trim().toLowerCase());
      if (accent !== accents[theme][preset] && !(preset === "default" && accent === "var(--ol-brand)")) {
        const resolved = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.color = "var(--ol-accent)";
          document.body.append(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        });
        findings.push(`${preset} ${theme} accent is ${accent} (${resolved})`);
      }
      if (shots) await page.screenshot({ path: path.join(shots, `preset-${preset}-${theme}-${width}x${height}.png`), fullPage: true });
    }
    assert.deepEqual(errors, [], `presets ${theme} browser errors`);
    if (findings.length) throw new Error(`FAIL presets ${theme}: ${findings.join(", ")}`);
    process.stdout.write(`PASS four presets ${theme}\n`);
    await context.close();
  }

  /* Without Pro, Ember stays locked: a press shows the plan and changes nothing. */
  {
    const context = await browser.newContext({ viewport: { width: 520, height: 800 }, serviceWorkers: "block" });
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    await page.goto(`${origin}/index.html`);
    await page.waitForLoadState("networkidle");
    await dismissModal(page);
    await page.locator("#tab-settings").click();
    await page.locator('button[data-preset="meadow"]').click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-preset") === "meadow");
    /* Locked, it still takes focus and a key press, and shows the plan. */
    await page.locator('button[data-preset="ember"]').focus();
    if (!await page.locator('button[data-preset="ember"]').evaluate((node) => document.activeElement === node)) {
      throw new Error("FAIL locked Ember cannot take focus");
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    if (await page.evaluate(() => document.documentElement.getAttribute("data-preset")) !== "meadow") {
      throw new Error("FAIL locked Ember changed the preset without Pro");
    }
    process.stdout.write("PASS Ember stays locked without Pro\n");
    await context.close();
  }

  /* Tools that are set up but have not read yet wait on Usage with no button,
     and a signed out one keeps its row there with its action. */
  for (const width of [380, 520, 900]) {
    const height = 800;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await context.addInitScript(() => {
      window.__desk = {
        noReadings: true,
        configured: ["CLAUDE", "CODEX"],
        detected: [
          { provider_id: "codex", state: "present", accounts: [] },
          { provider_id: "gemini_cli", state: "installed_logged_out", accounts: [] },
        ],
      };
    });
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`${origin}/index.html`);
    await page.waitForLoadState("networkidle");
    await dismissModal(page);
    const usage = page.locator("#usage-rows");
    await usage.locator('[data-provider-card][data-provider="CODEX"]', { hasText: "Waiting for first reading" }).waitFor();
    const findings = [];
    if (await page.locator("#usage-empty").isVisible()) findings.push("Usage says No bars yet over connected tools");
    const gemini = usage.locator('[data-provider-card][data-provider="GEMINI_CLI"]');
    if (!(await gemini.innerText()).includes("Signed out") || await gemini.locator("button", { hasText: "Sign in again" }).count() !== 1) {
      findings.push("the signed out tool has no row with its action on Usage");
    }
    if (await usage.locator('[data-provider-card][data-provider="CODEX"] button').count()) findings.push("a waiting row offers a button");
    findings.push(...await inspectFit(page));
    assert.deepEqual(errors, [], `waiting ${width}x${height} browser errors`);
    if (shots) await page.screenshot({ path: path.join(shots, `usage-waiting-${width}x${height}.png`), fullPage: true });
    if (findings.length) throw new Error(`FAIL waiting ${width}x${height}: ${findings.join(", ")}`);
    process.stdout.write(`PASS waiting rows ${width}x${height}\n`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
