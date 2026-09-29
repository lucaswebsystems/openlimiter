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
checkImportGraph(dist, ["index.html", "rail.html", "tray.html"]);

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
// extended with synthetic activity and Rail replies. No native IPC is available.
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
  for (const entry of ["index.html", "rail.html", "rail.html?card", "tray.html"]) {
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
        await page.locator("#agents-mount .agents-row").waitFor({ state: "visible" });
        assert.ok(await page.locator("main").isVisible(), "Home must be visible");
      } else if (entry === "tray.html") {
        // The tray reaches its empty state only after start() loaded every
        // module it imports (1.3.3 shipped it importing a deleted file).
        await page.locator("#tray-empty").waitFor({ state: "visible" });
      } else {
        await page.locator('#accounts [data-p="claude"]').waitFor({ state: "visible" });
        await page.locator('#sessions [data-agent="busy"]').waitFor({ state: "visible" });
        assert.equal(await page.locator('#accounts [data-p="claude"]').getAttribute("aria-label"), "Claude Code: 42% used (Session)");
      }
      await page.waitForLoadState("networkidle");
      assert.deepEqual(errors, [], `${entry} browser errors`);
      process.stdout.write(`PASS ${entry}: rendered without browser errors\n`);
    } catch (error) {
      throw new Error(`${entry}: ${error.message}\n${errors.join("\n")}`, { cause: error });
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
