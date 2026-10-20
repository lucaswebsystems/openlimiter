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

function installCaptureStub({ providers = 0 } = {}) {
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
  /* The edge panel's fit is proved with three, six and nine providers. */
  const pool = [
    ["CLAUDE", [["FIVE_HOUR", 42]]], ["CODEX", [["PRIMARY", 68], ["SEVEN_DAY", 40]]], ["ANTIGRAVITY", [["FIVE_HOUR", 84]]],
    ["OPENROUTER", [["KEY_LIMIT", 32]]], ["KIMI", [["FIVE_HOUR", 22], ["WEEKLY", 47]]], ["OPENCODE", [["FIVE_HOUR", 35], ["WEEKLY", 18]]],
    ["GROK", [["WEEKLY", 9]]], ["CURSOR", [["MONTHLY", 27]]], ["MANUAL", [["MONTHLY", 61]]],
  ];
  const snapshots = providers > 0
    ? pool.slice(0, providers).flatMap(([provider, meters]) =>
      meters.map(([meter, value]) => snapshot(provider, meter, value, `${provider.toLowerCase()}-fixture`)))
    : [
      snapshot("CLAUDE", "FIVE_HOUR", 42, "claude-fixture"),
      snapshot("CODEX", "PRIMARY", 68, "codex-fixture"),
      snapshot("ANTIGRAVITY", "FIVE_HOUR", 84, "antigravity-fixture"),
      snapshot("OPENROUTER", "KEY_LIMIT", 32, "openrouter-fixture"),
      // An amount row: its value must not push the panel's countdown column out.
      { ...snapshot("OPENROUTER", "ACCOUNT_BALANCE", 12.54, "openrouter-fixture"), unit: "CREDITS" },
    ];
  /* The provider order store and what the surfaces told native code, in order;
     events a check sends as native code would, and writes it makes fail. */
  window.__order = { mode: "usage", providers: [], revision: 0 };
  window.__calls = [];
  window.__listeners = {};
  window.__emit = (name, payload) => (window.__listeners[name] ?? []).forEach((handler) => handler({ payload }));
  window.__failOrderWrites = 0;
  const session = { sessionId: "synthetic-session", agent: "claude_code", state: "busy", confidence: "explicit", firstObservedAt: now, observedAt: now, elapsedSeconds: 0, computer: "local" };
  /* Start at sign in (2.1.6): the OS state, every write, every first run report. */
  window.__autostart = { enabled: false, writes: [], reports: 0 };
  const account = { provider: "claude", account: null, headlineMeterId: "quota", kind: "quota_percent", value: 42, meaning: "used", windowLabel: "Session", resetAt: null, freshness: "fresh", availability: "available", band: "green", precision: "exact", fidelityMarker: null, sessions: { busy: 1, waiting: 0, done: 0, idle: 0, unknown: 0 } };
  window.__TAURI__ = {
    core: { invoke: async (name, args) => {
      if (["set_tray_status", "set_provider_order", "plugin:rail|rail_card_height", "plugin:rail|rail_card_hold"].includes(name)) {
        window.__calls.push([name, args]);
      }
      if (name === "provider_order") return window.__order;
      if (name === "set_provider_order") {
        if (window.__failOrderWrites > 0) {
          window.__failOrderWrites -= 1;
          throw { kind: "storage" };
        }
        if (args.input.revision !== window.__order.revision) throw { kind: "stale_revision" };
        window.__order = { mode: args.input.mode, providers: args.input.providers, revision: window.__order.revision + 1 };
        return window.__order;
      }
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

/* A provider's mark shows in every state of its block (2.1.8): never hidden,
   never under its grip or anything else, the grip beside it inside the list,
   and neither the mark nor the name moved from `at`, where they stood at rest. */
function inspectMark(page, list, index, state, at = null) {
  return page.evaluate(({ list, index, state, at }) => {
    const group = document.querySelectorAll(`${list} > .q-group`)[index];
    const code = group.dataset.provider;
    const mark = group.querySelector(".q-prov .q-mark");
    const name = group.querySelector(".q-prov .q-pname").getBoundingClientRect();
    const box = mark.getBoundingClientRect();
    const grip = group.querySelector(".q-grip").getBoundingClientRect();
    const area = group.parentElement.getBoundingClientRect();
    const findings = [];
    const style = getComputedStyle(mark);
    let opacity = 1;
    for (let node = mark; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    if (style.display === "none" || style.visibility !== "visible" || opacity !== 1 || !box.width || !box.height) {
      findings.push(`${state}: ${code}'s mark is hidden (display ${style.display}, visibility ${style.visibility}, opacity ${opacity})`);
    }
    if (Math.min(box.right, grip.right) > Math.max(box.left, grip.left) && Math.min(box.bottom, grip.bottom) > Math.max(box.top, grip.top)) {
      findings.push(`${state}: ${code}'s grip lies over its mark`);
    }
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || !mark.contains(hit)) findings.push(`${state}: ${code}'s mark is covered by ${hit?.getAttribute("class") ?? "nothing"}`);
    if (grip.left < area.left - 0.5 || grip.right > area.right + 0.5) findings.push(`${state}: ${code}'s grip runs past its list`);
    const place = { mark: [box.left, box.top], name: [name.left, name.top] };
    const moved = at && [...place.mark, ...place.name].some((value, i) => Math.abs(value - [...at.mark, ...at.name][i]) > 0.01);
    if (moved) findings.push(`${state}: ${code}'s mark or name moved from ${JSON.stringify(at)} to ${JSON.stringify(place)}`);
    return { findings, place };
  }, { list, index, state, at });
}

/* The grip's keyboard focus with the pointer away: a key press first, so the
   ring is the keyboard's. */
async function focusGrip(page, grip, away) {
  await page.mouse.move(away.x, away.y);
  await page.keyboard.press("Shift");
  await grip.focus();
  await page.waitForTimeout(250);
  return grip.evaluate((node) => node.matches(":focus-visible") && getComputedStyle(node).opacity === "1");
}

/* Reordering the Usage list: the grip shows on hover at 24 by 24 at least, a
   3 px move is no drag, a drag lifts the block, slides the next one aside and
   marks the slot, the drop writes My order and the tray is repainted after
   it, the click a drop ends with opens nothing, the grip's menu moves a block
   by keyboard and keeps focus on its grip, and Settings switches the order to
   most used first and back. At rest, on hover, on keyboard focus, mid drag and
   with the menu open the block's mark shows beside its grip. */
async function inspectReorder(page, width, height, shots) {
  const findings = [];
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}-${width}x${height}.png`) }); };
  const order = () => page.evaluate(() => [...document.querySelectorAll("#usage-rows > .q-group")].map((group) => group.dataset.provider));
  await page.locator("#tab-usage").click();
  const groups = page.locator("#usage-rows > .q-group");
  const before = await order();
  // At rest: the pointer away and nothing focused, then hover, then keyboard focus.
  const away = { x: 2, y: 2 };
  await page.mouse.move(away.x, away.y);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(250);
  const rest = await inspectMark(page, "#usage-rows", 0, "at rest");
  findings.push(...rest.findings);
  await groups.nth(0).hover();
  await page.waitForTimeout(250);
  const grip = groups.nth(0).locator(".q-grip");
  if (await grip.evaluate((node) => getComputedStyle(node).opacity) !== "1") findings.push("the grip does not show on hover");
  const box = await grip.boundingBox();
  if (!box || box.width < 24 || box.height < 24) findings.push("the grip is under 24 by 24");
  findings.push(...(await inspectMark(page, "#usage-rows", 0, "on hover", rest.place)).findings);
  await shot("usage-hover");
  if (!await focusGrip(page, grip, away)) findings.push("the grip does not show with its ring on keyboard focus");
  findings.push(...(await inspectMark(page, "#usage-rows", 0, "on keyboard focus", rest.place)).findings);
  await shot("usage-focus");
  await grip.evaluate((node) => node.blur());
  await groups.nth(0).hover();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const second = await groups.nth(1).boundingBox();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 3);
  if (await page.locator("#usage-rows[data-reordering]").count()) findings.push("a 3 px move started a drag");
  await page.mouse.move(start.x, second.y + second.height * 0.8, { steps: 12 });
  await page.waitForTimeout(250);
  const mid = await page.evaluate(() => ({
    lifted: document.querySelector("#usage-rows > .q-group[data-dragging]")?.dataset.provider ?? null,
    slot: document.querySelector("#usage-rows > .q-slot") !== null,
    slid: getComputedStyle(document.querySelectorAll("#usage-rows > .q-group")[1]).transform,
  }));
  if (mid.lifted !== before[0]) findings.push("the dragged block is not lifted");
  if (!mid.slot) findings.push("no slot marks where the block lands");
  if (mid.slid === "none") findings.push("the next block did not slide aside");
  findings.push(...(await inspectMark(page, "#usage-rows", 0, "mid drag")).findings);
  await shot("usage-drag");
  await page.mouse.up();
  await page.waitForTimeout(500);
  const dropped = [before[1], before[0], ...before.slice(2)];
  if ((await order()).join() !== dropped.join()) findings.push(`the drop shows ${(await order()).join()}`);
  const after = await page.evaluate(() => ({ order: window.__order, calls: window.__calls.map(([name]) => name) }));
  if (after.order.mode !== "custom" || after.order.providers.join() !== dropped.join()) findings.push(`stored ${JSON.stringify(after.order)}`);
  if (after.calls.lastIndexOf("set_tray_status") < after.calls.indexOf("set_provider_order")) findings.push("the tray was not repainted after the move");
  if (await page.locator("#usage-rows .q-ordermenu").count()) findings.push("the drop's click opened the menu");
  await shot("usage-dropped");
  // The keyboard path: Enter on the first grip, End, Enter moves it to the bottom.
  const moving = dropped[0];
  await groups.nth(0).locator(".q-grip").focus();
  const shut = await inspectMark(page, "#usage-rows", 0, "focused before its menu");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const items = await page.evaluate(() => [...document.querySelectorAll("#usage-rows .q-ordermenu [role=menuitem]")]
    .map((item) => `${item.textContent}${item.disabled ? " (disabled)" : ""}`));
  if (items.join() !== "Move up (disabled),Move down,Move to top (disabled),Move to bottom") findings.push(`menu ${items.join()}`);
  findings.push(...shut.findings, ...(await inspectMark(page, "#usage-rows", 0, "with its menu open", shut.place)).findings);
  await shot("usage-menu");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const bottom = [...dropped.slice(1), moving];
  if ((await order()).join() !== bottom.join()) findings.push(`Move to bottom shows ${(await order()).join()}`);
  const kept = await page.evaluate(() => ({
    focus: document.activeElement?.classList.contains("q-grip") ? document.activeElement.closest(".q-group").dataset.provider : null,
    ring: document.activeElement?.matches(":focus-visible") ?? false,
    said: document.querySelector(".q-live")?.textContent ?? "",
  }));
  if (kept.focus !== moving || !kept.ring) findings.push("focus left the moved grip or shows no ring");
  if (!kept.said.endsWith(`moved to position ${bottom.length} of ${bottom.length}`)) findings.push(`announced "${kept.said}"`);
  await shot("usage-moved");
  await page.keyboard.press("Escape");
  // Settings: most used first keeps the list, so My order brings it back.
  await page.locator("#tab-settings").click();
  const pressed = () => page.evaluate(() => [...document.querySelectorAll("[data-order-mode]")]
    .map((button) => `${button.textContent}:${button.getAttribute("aria-pressed")}`).join());
  if (await pressed() !== "Most used first:false,My order:true") findings.push(`Order shows ${await pressed()}`);
  // The tab fades in: shoot it settled, with the Order choice in view.
  await page.locator("#tab-panel-settings").evaluate((panel) =>
    Promise.all(panel.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  await page.locator('[data-order-mode="usage"]').scrollIntoViewIfNeeded();
  await shot("settings-order");
  await page.locator('[data-order-mode="usage"]').click();
  await page.waitForTimeout(500);
  await page.locator("#tab-usage").click();
  if ((await order()).join() !== before.join()) findings.push(`most used first shows ${(await order()).join()}`);
  await page.locator("#tab-settings").click();
  await page.locator('[data-order-mode="custom"]').click();
  await page.waitForTimeout(500);
  await page.locator("#tab-usage").click();
  if ((await order()).join() !== bottom.join()) findings.push(`My order came back as ${(await order()).join()}`);
  const said = () => page.evaluate(() => document.querySelector(".q-live")?.textContent ?? "");
  const dragFirstOverSecond = async (during = async () => {}) => {
    await groups.nth(0).hover();
    const from = await groups.nth(0).locator(".q-grip").boundingBox();
    const over = await groups.nth(1).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, over.y + over.height * 0.8, { steps: 10 });
    await during();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  // A save that fails puts the list back from the order on disk, and says so.
  const standing = await order();
  await page.evaluate(() => { window.__failOrderWrites = 1; });
  await dragFirstOverSecond();
  if ((await order()).join() !== standing.join()) findings.push(`a failed save left ${(await order()).join()} on screen`);
  if (await said() !== "The order could not be saved, so nothing changed.") findings.push(`a failed save said "${await said()}"`);
  // The edge panel writes its own order during a drag: the drop is refused, theirs stands and shows.
  const theirs = [...standing].reverse();
  await dragFirstOverSecond(async () => {
    await page.evaluate((providers) => {
      window.__order = { mode: "custom", providers, revision: window.__order.revision + 1 };
      window.__emit("provider-order-changed", window.__order);
    }, theirs);
    await page.waitForTimeout(300);
  });
  const stood = await page.evaluate(() => window.__order.providers.join());
  if (stood !== theirs.join()) findings.push(`the panel's order was overwritten with ${stood}`);
  if ((await order()).join() !== theirs.join()) findings.push(`after the refused drop the list shows ${(await order()).join()}`);
  if (await said() !== "The order was changed elsewhere, so your move was not saved.") findings.push(`a refused drop said "${await said()}"`);
  await shot("usage-refused-drop");
  return findings;
}

/* The grip's menu stays whole on screen wherever its block sits: under the
   grip, over it, or scrolled into view, in a short window and in a panel that
   scrolls or fits. */
async function inspectMenuFit(browser, origin, shots) {
  const findings = [];
  const open = async (page, list, index, area) => {
    const grip = page.locator(`${list} > .q-group`).nth(index).locator(".q-grip");
    await grip.click();
    await page.waitForTimeout(60);
    const fit = await page.evaluate(({ list, area }) => {
      const menu = document.querySelector(`${list} .q-ordermenu`)?.getBoundingClientRect();
      const box = area === "window"
        ? { top: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0, bottom: innerHeight }
        : document.querySelector(area).getBoundingClientRect();
      return menu ? { top: menu.top - box.top, bottom: box.bottom - menu.bottom } : null;
    }, { list, area });
    return fit;
  };
  // A window too short for its list, a block at a time near each edge.
  {
    const context = await browser.newContext({ viewport: { width: 520, height: 340 }, serviceWorkers: "block" });
    await context.addInitScript(installCaptureStub);
    const page = await context.newPage();
    await page.goto(`${origin}/index.html`);
    await page.waitForLoadState("networkidle");
    findings.push(...await dismissModal(page));
    const count = await page.locator("#usage-rows > .q-group").count();
    for (let index = 0; index < count; index++) {
      for (const edge of ["top", "bottom"]) {
        await page.evaluate(({ index, edge }) => {
          const head = document.querySelectorAll("#usage-rows > .q-group")[index].querySelector(".q-prov").getBoundingClientRect();
          const top = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
          window.scrollBy(0, edge === "top" ? head.top - top - 2 : head.bottom - innerHeight + 2);
        }, { index, edge });
        const fit = await open(page, "#usage-rows", index, "window");
        if (!fit || fit.top < -0.5 || fit.bottom < -0.5) findings.push(`window block ${index} near the ${edge}: menu ${JSON.stringify(fit)}`);
        if (index === count - 1 && edge === "bottom" && shots) await page.screenshot({ path: path.join(shots, "usage-menu-edge-520x340.png") });
        await page.keyboard.press("Escape");
      }
    }
    await context.close();
  }
  // A panel that scrolls (nine providers, 768 tall) and one that fits (two providers).
  for (const [providers, height] of [[9, 768], [2, 300]]) {
    const context = await browser.newContext({ viewport: { width: 360, height }, serviceWorkers: "block" });
    await context.addInitScript(installCaptureStub, { providers });
    const page = await context.newPage();
    await page.goto(`${origin}/edge-panel.html`);
    await page.waitForLoadState("networkidle");
    const count = await page.locator("#panel-limits > .q-group").count();
    for (let index = 0; index < count; index++) {
      for (const edge of ["top", "bottom"]) {
        await page.evaluate(({ index, edge }) => {
          const scroll = document.querySelector("#panel-scroll");
          const area = scroll.getBoundingClientRect();
          const head = document.querySelectorAll("#panel-limits > .q-group")[index].querySelector(".q-prov").getBoundingClientRect();
          scroll.scrollTop += edge === "top" ? head.top - area.top - 2 : head.bottom - area.bottom + 2;
        }, { index, edge });
        const fit = await open(page, "#panel-limits", index, "#panel-scroll");
        if (!fit || fit.top < -0.5 || fit.bottom < -0.5) findings.push(`panel of ${providers}, block ${index} near the ${edge}: menu ${JSON.stringify(fit)}`);
        if (providers === 2 && index === count - 1 && edge === "bottom" && shots) await page.screenshot({ path: path.join(shots, "panel-menu-edge.png") });
        await page.locator(`#panel-limits > .q-group`).nth(index).locator(".q-grip").click();
      }
    }
    await context.close();
  }
  return findings;
}

/* A drag held at the bottom of a window too short for its list scrolls the
   page under it, below the sticky header. */
async function inspectWindowEdgeScroll(browser, origin, shots) {
  const context = await browser.newContext({ viewport: { width: 520, height: 480 }, serviceWorkers: "block" });
  await context.addInitScript(installCaptureStub);
  const page = await context.newPage();
  await page.goto(`${origin}/index.html`);
  await page.waitForLoadState("networkidle");
  const findings = await dismissModal(page);
  const first = page.locator("#usage-rows > .q-group").first();
  await first.hover();
  const grip = await first.locator(".q-grip").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, 480 - 8, { steps: 12 });
  await page.waitForTimeout(600);
  if (await page.evaluate(() => document.scrollingElement.scrollTop) <= 0) findings.push("a drag at the bottom edge does not scroll the window");
  if (shots) await page.screenshot({ path: path.join(shots, "usage-edge-drag-520x480.png") });
  await page.mouse.up();
  await context.close();
  return findings;
}

/* The edge panel on one work area: native code gives it the height it asks
   for up to the whole work area, so it scrolls only when it is taller. */
async function inspectPanelFit(browser, origin, providers, work, shots) {
  const context = await browser.newContext({ viewport: { width: 360, height: 480 }, serviceWorkers: "block" });
  await context.addInitScript(installCaptureStub, { providers });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/edge-panel.html`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  const asked = () => page.evaluate(() => window.__calls.filter(([name]) => name === "plugin:rail|rail_card_height").at(-1)?.[1].height ?? 0);
  const findings = [];
  const shown = await page.locator("#panel-limits > .q-group").count();
  if (shown !== providers) findings.push(`${shown} blocks for ${providers} providers`);
  const wanted = await asked();
  const height = Math.min(Math.max(wanted, 160), work);
  await page.setViewportSize({ width: 360, height });
  await page.waitForTimeout(200);
  const fit = await page.evaluate(() => {
    const scroll = document.querySelector("#panel-scroll");
    const card = document.querySelector("#panel-card").getBoundingClientRect();
    // Unrounded, so a fraction of a pixel that could become a scrollbar shows too.
    const over = document.querySelector("#panel-content").getBoundingClientRect().height - scroll.getBoundingClientRect().height;
    return { overflow: scroll.scrollHeight - scroll.clientHeight, over, bottom: card.bottom };
  });
  if (wanted <= work && (fit.overflow > 0 || fit.over > 0.01)) findings.push(`overruns ${fit.over.toFixed(3)} px with room on the screen`);
  if (wanted > work && fit.overflow <= 0) findings.push("taller than the work area yet nothing scrolls");
  if (fit.bottom > height + 0.5) findings.push("the card runs past the window");
  if (await asked() !== wanted) findings.push(`asked ${wanted}, then ${await asked()} once sized`);
  if (shots) await page.screenshot({ path: path.join(shots, `panel-${providers}-providers-${work}-tall.png`) });
  if (wanted > work) {
    // A drag held near the bottom of a list that scrolls scrolls it.
    const first = page.locator("#panel-limits > .q-group").first();
    await first.hover();
    const grip = await first.locator(".q-grip").boundingBox();
    const area = await page.locator("#panel-scroll").boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, area.y + area.height - 8, { steps: 12 });
    await page.waitForTimeout(600);
    if (await page.evaluate(() => document.querySelector("#panel-scroll").scrollTop) <= 0) findings.push("a drag at the bottom edge does not scroll the list");
    if (shots) await page.screenshot({ path: path.join(shots, `panel-${providers}-providers-${work}-tall-edge-drag.png`) });
    await page.mouse.up();
  }
  if (errors.length) findings.push(...errors);
  await context.close();
  return { findings, wanted, height, overflow: fit.overflow };
}

/* The edge panel mid drag and with the grip's menu open: it holds itself open
   for both and lets go when each ends, and every state keeps the marks. */
async function inspectPanelReorder(browser, origin, shots) {
  const context = await browser.newContext({ viewport: { width: 360, height: 700 }, serviceWorkers: "block" });
  await context.addInitScript(installCaptureStub, { providers: 6 });
  const page = await context.newPage();
  await page.goto(`${origin}/edge-panel.html`);
  await page.waitForLoadState("networkidle");
  const holds = () => page.evaluate(() => window.__calls.filter(([name]) => name === "plugin:rail|rail_card_hold").map(([, args]) => args.held).join());
  const findings = [];
  const groups = page.locator("#panel-limits > .q-group");
  const before = await page.evaluate(() => [...document.querySelectorAll("#panel-limits > .q-group")].map((group) => group.dataset.provider));
  // The marks at rest, on hover and on keyboard focus (the panel itself takes no focus; its style is the window's).
  const away = { x: 180, y: 8 };
  await page.mouse.move(away.x, away.y);
  await page.waitForTimeout(250);
  const rest = await inspectMark(page, "#panel-limits", 0, "panel at rest");
  findings.push(...rest.findings);
  await groups.nth(0).hover();
  await page.waitForTimeout(250);
  findings.push(...(await inspectMark(page, "#panel-limits", 0, "panel on hover", rest.place)).findings);
  if (shots) await page.screenshot({ path: path.join(shots, "panel-hover.png") });
  if (!await focusGrip(page, groups.nth(0).locator(".q-grip"), away)) findings.push("the panel grip does not show with its ring on keyboard focus");
  findings.push(...(await inspectMark(page, "#panel-limits", 0, "panel on keyboard focus", rest.place)).findings);
  await page.evaluate(() => document.activeElement?.blur());
  await groups.nth(0).hover();
  const box = await groups.nth(0).locator(".q-grip").boundingBox();
  const third = await groups.nth(2).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, third.y + third.height * 0.8, { steps: 12 });
  await page.waitForTimeout(250);
  if (await holds() !== "true") findings.push(`holds during the drag: ${await holds()}`);
  findings.push(...(await inspectMark(page, "#panel-limits", 0, "panel mid drag")).findings);
  if (shots) await page.screenshot({ path: path.join(shots, "panel-drag.png") });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => [...document.querySelectorAll("#panel-limits > .q-group")].map((group) => group.dataset.provider));
  const expected = [before[1], before[2], before[0], ...before.slice(3)];
  if (after.join() !== expected.join()) findings.push(`the panel drop shows ${after.join()}`);
  const shut = await inspectMark(page, "#panel-limits", 1, "panel before its menu");
  await groups.nth(1).locator(".q-grip").click();
  await page.waitForTimeout(150);
  if (await holds() !== "true,false,true") findings.push(`holds with the menu: ${await holds()}`);
  findings.push(...shut.findings, ...(await inspectMark(page, "#panel-limits", 1, "panel with its menu open", shut.place)).findings);
  if (shots) await page.screenshot({ path: path.join(shots, "panel-menu.png") });
  await page.locator("#panel-limits .q-ordermenu [role=menuitem]").first().click();
  await page.waitForTimeout(300);
  if (await holds() !== "true,false,true,false") findings.push(`holds after the menu: ${await holds()}`);
  await context.close();
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
  for (const work of [1080, 768]) {
    for (const providers of [3, 6, 9]) {
      const fit = await inspectPanelFit(browser, origin, providers, work, shots);
      if (fit.findings.length) throw new Error(`FAIL edge panel, ${providers} providers on ${work}: ${fit.findings.join(", ")}`);
      process.stdout.write(`PASS edge panel, ${providers} providers on a ${work} px work area: asks ${fit.wanted}, ` +
        `shown ${fit.height}, ${fit.overflow > 0 ? `scrolls ${fit.overflow}` : "no scroll"}\n`);
    }
  }
  {
    const findings = await inspectPanelReorder(browser, origin, shots);
    if (findings.length) throw new Error(`FAIL edge panel reorder: ${findings.join(", ")}`);
    process.stdout.write("PASS edge panel drag and menu hold the panel and let go\n");
  }
  {
    const findings = await inspectWindowEdgeScroll(browser, origin, shots);
    if (findings.length) throw new Error(`FAIL window edge scroll: ${findings.join(", ")}`);
    process.stdout.write("PASS a drag at the window's bottom edge scrolls the page\n");
  }
  {
    const findings = await inspectMenuFit(browser, origin, shots);
    if (findings.length) throw new Error(`FAIL reorder menu fit: ${findings.join("; ")}`);
    process.stdout.write("PASS the reorder menu stays whole near every edge, window and panel\n");
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
    if ([380, 520, 900].includes(width) && height === 800) {
      const findings = await inspectReorder(page, width, height, shots);
      assert.deepEqual(errors, [], `${width}x${height} browser errors while reordering`);
      if (findings.length) throw new Error(`FAIL reorder ${width}x${height}: ${findings.join(", ")}`);
      process.stdout.write(`PASS reorder by drag, menu and Settings ${width}x${height}\n`);
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
    /* No action on a waiting row; its grip is the one every Usage block carries. */
    if (await usage.locator('[data-provider-card][data-provider="CODEX"] button:not(.q-grip)').count()) findings.push("a waiting row offers a button");
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
