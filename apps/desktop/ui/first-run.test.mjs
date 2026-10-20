import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import * as firstRun from "./first-run.js";
import {
  CODEX_SIGN_IN_TIMEOUT_MILLISECONDS,
  CODEX_DEVICE_LINK_FALLBACK,
  CONNECT_PROVIDERS,
  FIRST_RUN_STEPS,
  claudeLine,
  claudeSignals,
  createDetectionLoader,
  codexSentence,
  firstRunCopyStrings,
  initFirstRun,
  launchNotice,
  markStep,
  normalizeDetections,
  rowAction,
  runCodexSignIn,
} from "./first-run.js";
import { READINGS_COPY } from "./names.js";
import { FakeElement, fakeDocument } from "./test-dom.mjs";

const read = (name) => readFileSync(new URL("./" + name, import.meta.url), "utf8");
const firstRunSection = () => {
  const markup = read("index.html");
  const start = markup.indexOf('<section\n      id="first-run"');
  return markup.slice(start, markup.indexOf("</section>", start));
};
const providerSpec = (code) =>
  CONNECT_PROVIDERS.find((provider) => provider.code === code);

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return;
    await nextTurn();
  }
  assert.fail(message);
}

function firstRunDom(existingInstall = false) {
  const doc = fakeDocument();
  const make = doc.createElement;
  const decorate = (node) => {
    if (!node.classList?.add) {
      Object.defineProperty(node, "classList", {
        value: {
          add: (...names) => {
            const classes = new Set(node.className.split(/\s+/u).filter(Boolean));
            for (const name of names) classes.add(name);
            node.className = [...classes].join(" ");
          },
        },
        writable: true,
        configurable: true
      });
    }
    const matches = (candidate, selector) => {
      if (selector.startsWith("#")) return candidate.id === selector.slice(1);
      if (selector.startsWith(".")) return candidate.className.split(/\s+/u).includes(selector.slice(1));
      return candidate.localName === selector.toLowerCase();
    };
    node.querySelector = (selector) => node.all((candidate) => matches(candidate, selector))[0] ?? null;
    node.querySelectorAll = (selector) => node.all((candidate) => matches(candidate, selector));
    return node;
  };
  doc.createElement = (tag) => decorate(make(tag));
  doc.documentElement = doc.createElement("html");

  const register = (id, tag = "div") => {
    const node = doc.createElement(tag);
    node.id = id;
    node.setAttribute("id", id);
    doc.byId[id] = node;
    return node;
  };
  const screen = register("first-run", "section");
  const setup = register("first-run-setup");
  const heading = register("first-run-title", "h1");
  const providers = register("first-run-providers");
  const absent = register("first-run-absent", "p");
  const status = register("first-run-status", "p");
  const showBars = register("first-run-continue", "button");
  setup.hidden = true;
  setup.append(heading, providers, absent, status, showBars);
  screen.append(setup);

  const values = new Map();
  if (existingInstall) {
    values.set("openlimiter-first-run-complete-v1", "complete");
    values.set("openlimiter-configured-providers-v1", JSON.stringify(["CODEX"]));
  }
  const listeners = {};
  const win = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    addEventListener(name, listener) { (listeners[name] ??= []).push(listener); },
    dispatchEvent(event) {
      for (const listener of listeners[event.type] ?? []) listener(event);
    },
  };
  return { doc, screen, setup, providers, absent, status, values, win };
}

function installFirstRunGlobals(harness) {
  globalThis.document = harness.doc;
  globalThis.window = harness.win;
  globalThis.HTMLElement = FakeElement;
  globalThis.CustomEvent ??= class CustomEvent { constructor(type) { this.type = type; } };
}

/* Everything the screen would put in front of a person, once drawn. */
function screenWords(harness) {
  return harness.screen.all(() => true)
    .flatMap((node) => [node.text, node.getAttribute?.("aria-label"), node.getAttribute?.("title")])
    .filter((value) => typeof value === "string" && value !== "")
    .join("\n");
}

/* Every dash a keyboard and a word processor can produce, because the rule is
   about what a person reads and not about which key made it. */
const DASH = /[-‐‑‒–—―−]/u;

test("keeps an unconfigured screen to its rows: no paragraph ships visible and nothing points at a tab", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  /* A section that ships hidden is revealed whole or not at all, so what is
     inside it is not on the screen yet. */
  const screen = html.slice(html.indexOf('id="tab-panel-usage"'), html.indexOf('id="tab-panel-tools"'))
    .replace(/<section\b[^>]*\bhidden\b[^>]*>[\s\S]*?<\/section>/gu, "");
  assert.doesNotMatch(screen, /Open Connections|id="empty"|Nothing measurable yet/u);
  /*
   * The tools list always has Claude Code, Antigravity and OpenRouter, each
   * with one step, so an empty screen needs no card explaining itself. Every
   * paragraph on it starts empty or hidden and is revealed only by something
   * the window can prove: a refresh status, a failure, a setup line.
   */
  for (const paragraph of screen.matchAll(/<p\b[^>]*>(.*?)<\/p>/gsu)) {
    const [whole, inner] = paragraph;
    assert.ok(/hidden/u.test(whole.slice(0, whole.indexOf(">"))) || whole.includes('data-copy="usageEmpty"') || inner.trim() === "", "a paragraph ships visible: " + whole);
  }
  assert.match(screen, /id="home-refresh-status" class="q-note" role="status" aria-live="polite"><\/p>/u);
});

test("walks connect, then bars, and says so on the screen", () => {
  /* Two steps, in this order, and the step list a person reads has to be
     the same two in the same order. A named list that drifts from the code
     driving it is a progress indicator that lies. The account is no longer a
     step: it is offered under the bars once the first one lands. */
  assert.deepEqual(FIRST_RUN_STEPS, ["connect", "bars"]);

  const list = firstRunSection();
  const labels = [...list.matchAll(/<li data-step="([a-z]+)"[^>]*>([^<]+)<\/li>/gu)].map(
    (item) => [item[1], item[2]],
  );
  assert.deepEqual(labels, [
    ["connect", "Connect"],
    ["bars", "Bars"],
  ]);
  assert.doesNotMatch(list, /id="first-run-account"|Create your account|Create account later/u);

  /* And the last step is not a screen: it marks itself and gets out of the
     way, exactly as the window behind it comes up. */
  const source = read("first-run.js");
  assert.match(
    source,
    /markStep\(screen, "bars"\);\s*document\.documentElement\.dataset\.firstRun = "complete";\s*screen\.hidden = true;/u,
  );
  assert.match(source, /function finish\(\) \{[\s\S]*?completeFirstRun\(screen, options\);\s*options\.onContinue\(\);/u);
});

test("asks for nothing before the machine is read", () => {
  const html = read("index.html");
  assert.equal(html.includes('id="account-gate"'), false);
});

test("the first run opens on Connect, lists only the tools on this computer and names the rest in one line", async () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  initFirstRun({
    detectProviders: async () => ({
      ok: true,
      value: {
        providers: [
          { provider_id: "claude", state: "present", accounts: [] },
          { provider_id: "codex", state: "installed_logged_out", accounts: [] },
          ...["gemini_cli", "antigravity", "grok", "kimi", "opencode", "openrouter"]
            .map((provider_id) => ({ provider_id, state: "absent", accounts: [] })),
        ],
      },
    }),
    platform: "Linux",
  });
  /* Connect is on screen at once, saying it checks, with no account first. */
  assert.equal(harness.setup.hidden, false, "the first run did not open on Connect");
  await waitFor(() => harness.providers.children.length > 0, "the detected tools were not drawn");
  assert.deepEqual(
    harness.providers.children.map((row) => row.dataset.provider),
    ["CODEX", "CLAUDE"],
  );
  assert.equal(
    harness.absent.textContent,
    "Not on this computer: Gemini CLI, Antigravity, Grok (xAI), Kimi, OpenCode. Add them later in Connect Tools.",
  );
  assert.equal(harness.status.textContent, "Scan complete.");
  /* Nothing on the screen offers to install a third party tool. */
  assert.doesNotMatch(screenWords(harness), /npm install|Verified on install|Install/u);
});

test("a machine with nothing detected shows no empty list, and a failed scan claims nothing is absent", async () => {
  {
    const harness = firstRunDom(false);
    installFirstRunGlobals(harness);
    initFirstRun({
      detectProviders: async () => ({ ok: true, value: { providers: [] } }),
      platform: "Linux",
    });
    await waitFor(() => harness.status.textContent === "Scan complete.", "the scan did not finish");
    assert.equal(harness.providers.children.length, 0);
    assert.equal(harness.providers.hidden, true, "an empty list was drawn");
    assert.match(harness.absent.textContent, /^Not on this computer: Codex, Claude Code, /u);
    assert.doesNotMatch(harness.absent.textContent, /OpenRouter/u, "a key is not something a computer has");
  }
  {
    const harness = firstRunDom(false);
    installFirstRunGlobals(harness);
    initFirstRun({ detectProviders: async () => ({ ok: false, reason: "unconfigured" }), platform: "Linux" });
    await waitFor(
      () => harness.status.textContent === "Detection could not run. Every bar can be connected later.",
      "the failed scan was not said",
    );
    assert.equal(harness.absent.textContent, "", "a failed scan claimed tools are absent");
    assert.equal(harness.providers.children.length, 0);
  }
});

/* The native inventory before its first scan: no scan time, no providers. */
const UNSCANNED = { version: 1, scanned_at: "", providers: [] };
const scannedWith = (providers) => ({
  version: 1,
  scanned_at: "2026-10-20T12:00:00.000Z",
  providers: [
    ...providers,
    ...["claude", "codex", "gemini_cli", "antigravity", "grok", "kimi", "opencode", "openrouter"]
      .filter((id) => !providers.some((entry) => entry.provider_id === id))
      .map((provider_id) => ({ provider_id, state: "absent", accounts: [] })),
  ],
});

test("an unscanned inventory is not a scan: Connect keeps checking and claims nothing absent", () => {
  const result = normalizeDetections(UNSCANNED);
  assert.equal(result.pending, true);
  assert.equal(result.available, false);
  assert.equal(firstRun.absentLine(result), "");
  assert.ok(result.providers.every((entry) => entry.state === "unavailable"));
  /* A completed scan is a scan, and a payload with no scan time at all is
     the older shape, which always came from a scan. */
  assert.equal(normalizeDetections(scannedWith([])).pending, undefined);
  assert.equal(normalizeDetections({ providers: [] }).available, true);
});

test("Connect fills in when the real scan lands, and not before", async () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  let payload = UNSCANNED;
  let landed = null;
  initFirstRun({
    detectProviders: async () => ({ ok: true, value: payload }),
    onScanUpdate: (handler) => { landed = handler; return () => {}; },
    platform: "Linux",
  });
  await waitFor(() => landed !== null, "Connect never listened for the scan");
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
  assert.equal(harness.status.textContent, "Checking local tools.");
  assert.equal(harness.providers.children.length, 0, "rows were drawn from an unscanned inventory");
  assert.equal(harness.absent.textContent, "", "an unscanned inventory called every tool absent");
  payload = scannedWith([{ provider_id: "codex", state: "present", accounts: [] }]);
  await landed();
  await waitFor(() => harness.providers.children.length === 1, "the landed scan was never drawn");
  assert.equal(harness.status.textContent, "Scan complete.");
  assert.match(harness.absent.textContent, /^Not on this computer: Claude Code, Gemini CLI, /u);
  /* A later scan that changes nothing redraws nothing; one that does, does. */
  const row = harness.providers.children[0];
  await landed();
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
  assert.equal(harness.providers.children[0], row, "an unchanged scan redrew the rows");
  payload = scannedWith([
    { provider_id: "codex", state: "present", accounts: [] },
    { provider_id: "claude", state: "present", accounts: [] },
  ]);
  await landed();
  await waitFor(() => harness.providers.children.length === 2, "a changed scan was never drawn");
});

test("a scan that lands during a Codex sign in waits for the sign in to end", async () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  const waits = [];
  harness.win.setTimeout = (callback) => { waits.push(callback); return waits.length; };
  harness.win.setInterval = () => 1;
  harness.win.clearInterval = () => {};
  let payload = scannedWith([{ provider_id: "codex", state: "installed_logged_out", accounts: [] }]);
  let landed = null;
  initFirstRun({
    detectProviders: async () => ({ ok: true, value: payload }),
    onScanUpdate: (handler) => { landed = handler; return () => {}; },
    codexSignIn: async () => ({ ok: true, value: { sessionId: "one", userCode: "ABCD", verificationUrl: "https://auth.openai.com/device", expiresInSeconds: 180 } }),
    codexSignInPoll: async () => ({ ok: true, value: { kind: "pending" } }),
    codexSignInCancel: async () => ({ ok: true }),
    now: () => 0,
    platform: "Linux",
  });
  await waitFor(() => harness.providers.children.length === 1, "the Codex row was not drawn");
  const codex = harness.providers.children[0];
  await codex.all((node) => node.localName === "button")[0].fire("click");
  await waitFor(() => waits.length === 1, "the sign in did not reach its first wait");
  payload = scannedWith([
    { provider_id: "codex", state: "installed_logged_out", accounts: [] },
    { provider_id: "claude", state: "present", accounts: [] },
  ]);
  await landed();
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
  assert.equal(harness.providers.children[0], codex, "the scan redrew the row in the middle of a sign in");
  assert.equal(codex.all((node) => node.className === "first-run-countdown").length, 1, "the sign in lost its code");
  /* Cancel ends the flow; the scan that waited is drawn now. */
  await codex.all((node) => node.localName === "button" && node.textContent === "Cancel")[0].fire("click");
  waits.shift()();
  await waitFor(() => harness.providers.children.length === 2, "the waiting scan was never drawn");
  /* The redrawn Codex row still says how its sign in ended and offers it again. */
  const after = harness.providers.children.find((row) => row.dataset.provider === "CODEX");
  assert.equal(after.all((node) => node.localName === "button")[0].textContent, "Try again");
  assert.equal(after.all((node) => node.getAttribute("role") === "status")[0].textContent, "Sign in cancelled, and nothing changed.");
});

test("the first run never asks about, pre checks or saves the Claude direct usage request", async () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  const writes = [];
  let reads = 0;
  let completions = 0;
  initFirstRun({
    detectProviders: async () => ({
      ok: true,
      value: { providers: [{ provider_id: "claude", state: "present", accounts: [] }] },
    }),
    /* Offered the old way in: a missing choice, and a setter that records. */
    claudePollEnabled: async () => {
      reads += 1;
      return { state: "missing", enabled: false };
    },
    setClaudePoll: async (enabled) => {
      writes.push(enabled);
      return { ok: true, value: enabled };
    },
    onContinue: () => { completions += 1; },
    platform: "Linux",
  });
  await waitFor(() => harness.providers.children.length === 1, "the Claude row was not drawn");
  assert.equal(harness.screen.querySelector("#first-run-claude-poll"), null, "a Claude switch is in the first run");
  const boxes = harness.screen.all((node) => node.localName === "input");
  assert.ok(boxes.every((box) => "providerSwitch" in box.dataset), "a control other than a tool switch is drawn");
  const words = screenWords(harness);
  for (const phrase of [READINGS_COPY.showClaudeFable, READINGS_COPY.showClaudeFableNote, "Fable", "usage request", "Anthropic"]) {
    assert.equal(words.includes(phrase), false, "the first run mentions " + phrase);
  }
  await harness.doc.byId["first-run-continue"].fire("click");
  await waitFor(() => completions === 1, "Show my bars did not finish");
  assert.deepEqual(writes, [], "the first run saved a Claude choice");
  assert.equal(reads, 0, "the first run read the Claude choice");
  assert.equal(harness.screen.hidden, true);
});

test("an existing install with no recorded Claude choice is never asked", async () => {
  const harness = firstRunDom(true);
  installFirstRunGlobals(harness);
  headProbe(harness);
  const writes = [];
  let completions = 0;
  initFirstRun({
    claudePollEnabled: async () => ({ state: "missing", enabled: false }),
    setClaudePoll: async (enabled) => {
      writes.push(enabled);
      return { ok: true, value: enabled };
    },
    onContinue: () => { completions += 1; },
    platform: "Linux",
  });
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
  assert.equal(harness.doc.documentElement.dataset.firstRun, "complete", "an interstitial took the window back");
  assert.equal(harness.screen.hidden, true);
  assert.deepEqual(writes, []);
  assert.equal(completions, 0, "nothing was asked, so nothing continued");
});

test("no Claude consent screen, switch or string is left in the first run's files", () => {
  const html = read("index.html");
  const source = read("first-run.js");
  assert.doesNotMatch(html, /claude-poll-consent|Fable|Continue with Claude off|Show your/u);
  assert.doesNotMatch(source, /claudePoll|ClaudePoll|CLAUDE_POLL|setClaudePoll|showClaudeFable/u);
  const readings = JSON.parse(read("readings.en.json"));
  for (const key of ["claudePollConsentTitle", "claudePollNotNow", "claudePollSaveFailed", "claudePollContinueOff"]) {
    assert.equal(key in readings, false, key + " is still in readings.en.json");
    for (const locale of ["en", "de", "es", "ja", "pt-BR"]) {
      const catalog = JSON.parse(read(`../../web/messages/${locale}.json`));
      assert.equal(key in catalog.desktopReadings, false, `${locale} desktopReadings still has ${key}`);
    }
  }
  /* The one click that turned the request on from a Claude row is gone too. */
  assert.doesNotMatch(read("app.js"), /useClaudeSignIn|claude-sign-in\.js|poll: async/u);
});

test("Show my bars is the only way out, alone in one sticky footer", () => {
  const step = firstRunSection();
  const buttons = [...step.matchAll(/<button\b[^>]*\bid="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(buttons, ["first-run-continue"]);
  assert.match(
    step,
    /<div class="first-run-footer">\s*<button type="button" id="first-run-continue" class="first-run-continue">\s*Show my bars\s*<\/button>\s*<\/div>/u,
  );
  /* Each login goes to its own provider, so "provider access stays local" was
     untrue, and the intro already says where logins go. */
  assert.doesNotMatch(step, /stays local|first-run-helper|Sync can be turned off/u);
  assert.match(step, /aria-describedby="first-run-intro"/u);
  const css = read("app.css");
  const footer = css.match(/\.first-run-footer \{([^}]*)\}/u)?.[1] ?? "";
  assert.match(footer, /position: sticky;/u);
  assert.match(footer, /bottom: 0;/u);
  assert.match(footer, /border-top: 1px solid var\(--ol-hairline\);/u);
  /* The primary keeps its contrast on hover: white on the mark blue's hover. */
  assert.match(css, /button\.first-run-continue:hover \{\s*border-color: var\(--ol-primary-hover\);\s*background: var\(--ol-primary-hover\);/u);
  assert.doesNotMatch(css, /first-run-continue:hover,\s*#empty-connect:hover \{\s*border-color: var\(--ol-accent-solid-hover\)/u);
});

test("finishing a fresh first run marks the account offer the bars will carry", async () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  initFirstRun({ detectProviders: async () => ({ ok: true, value: { providers: [] } }), platform: "Linux" });
  assert.equal(harness.values.get(firstRun.ACCOUNT_OFFER_STORAGE_KEY), undefined, "offered before the bars");
  await harness.doc.byId["first-run-continue"].fire("click");
  assert.equal(firstRun.ACCOUNT_OFFER_STORAGE_KEY, "openlimiter-account-offer-v1");
  assert.equal(harness.values.get(firstRun.ACCOUNT_OFFER_STORAGE_KEY), "pending");
  /* A person who already settled the offer is never asked again. */
  const again = firstRunDom(false);
  again.values.set(firstRun.ACCOUNT_OFFER_STORAGE_KEY, "dismissed");
  installFirstRunGlobals(again);
  initFirstRun({ detectProviders: async () => ({ ok: true, value: { providers: [] } }), platform: "Linux" });
  await again.doc.byId["first-run-continue"].fire("click");
  assert.equal(again.values.get(firstRun.ACCOUNT_OFFER_STORAGE_KEY), "dismissed");
});

test("an install that finished a first run before is never offered the account on its way back", async () => {
  /* Every tool was removed, so Connect shows again; the install is not fresh,
     and it already met the account where earlier versions offered it. */
  const returning = firstRunDom(false);
  returning.values.set("openlimiter-first-run-complete-v1", "complete");
  returning.values.set("openlimiter-configured-providers-v1", "[]");
  installFirstRunGlobals(returning);
  initFirstRun({ detectProviders: async () => ({ ok: true, value: { providers: [] } }), platform: "Linux" });
  assert.equal(returning.setup.hidden, false, "Connect did not show again");
  await returning.doc.byId["first-run-continue"].fire("click");
  assert.equal(returning.screen.hidden, true);
  assert.equal(returning.values.get(firstRun.ACCOUNT_OFFER_STORAGE_KEY), undefined, "a returning install was offered the account");
});

test("Microsoft is offered by name in the one sign in body and sent as azure", () => {
  /* Supabase knows the provider as azure and a person knows it as Microsoft.
     The first run no longer draws its own button: the one body every sign in
     goes through offers all three providers. */
  const html = read("index.html");
  const body = html.slice(html.indexOf('id="sign-in-body"'), html.indexOf('class="sign-in-divider"'));
  assert.match(body, /id="account-microsoft" class="sign-in-provider"[\s\S]*?<span>Continue with Microsoft<\/span>/u);
  assert.ok(body.indexOf('id="account-google"') < body.indexOf('id="account-microsoft"'));
  assert.match(body.slice(body.indexOf('id="account-microsoft"')), /fill="currentColor"/u);
  assert.equal((html.match(/id="account-microsoft"/gu) ?? []).length, 1);
  const app = read("app.js");
  assert.match(app, /signInMicrosoft\?\.addEventListener\("click", \(\) => void continueWith\("azure"\)\)/u);
  assert.match(app, /azure: elements\.signInMicrosoft/u);
  const backend = read("backend.js");
  assert.match(backend, /OAUTH_PROVIDERS = Object\.freeze\(\["google", "github", "azure"\]\)/u);
  const states = read("sign-in-states.js");
  assert.match(states, /provider === "azure"\) return "Microsoft"/u);
  assert.equal(read("first-run.js").includes("first-run-microsoft"), false);
});

test("an unwired option degrades instead of throwing", () => {
  /* Half of these commands are still landing on the Rust side. A window that
     throws on a missing command is a window with no first run at all. */
  const source = read("first-run.js");
  for (const name of [
    "codexSignIn",
    "codexSignInPoll",
    "codexSignInCancel",
    "detectProviders",
    "markFor",
    "onContinue",
    "autostartFirstRun",
  ]) {
    assert.match(
      source,
      new RegExp("const DEFAULT_OPTIONS = Object\\.freeze\\(\\{[\\s\\S]*?" + name + ":", "u"),
      name + " has no safe default",
    );
  }
});

test("a detected login is the default and it spawns nothing", () => {
  for (const code of ["CODEX", "GEMINI_CLI", "ANTIGRAVITY", "OPENCODE", "GROK", "KIMI"]) {
    assert.deepEqual(rowAction(providerSpec(code), { state: "present" }, {}), {
      kind: "current",
      label: "Use my current login",
    });
  }
  /* Nothing in that path opens a browser, a console or a device flow: it
     changes the shared persisted switch without replacing the focused control. */
  const source = read("first-run.js");
  assert.match(
    source,
    /homeSelectionControl\(provider.code, \(\) => \{\}, document, options.setProviderEnabled, provider.name\)/u,
  );
});

test("a Codex quota failure remains visible on the connect row", () => {
  assert.deepEqual(
    rowAction(
      providerSpec("CODEX"),
      { state: "present" },
      {},
      { kind: "failed", reason: "Quota collection failed. OpenLimiter will try again soon." },
    ),
    {
      kind: "note",
      note: "Quota collection failed. OpenLimiter will try again soon.",
    },
  );
  assert.deepEqual(
    rowAction(providerSpec("CODEX"), { state: "present" }, {}, { kind: "ready" }),
    { kind: "current", label: "Use my current login" },
  );
});

test("Codex is the only sign in button in this release", () => {
  assert.deepEqual(rowAction(providerSpec("CODEX"), { state: "logged_out" }, {}), {
    kind: "signin",
    label: "Sign in",
  });
  for (const code of ["CLAUDE", "GEMINI_CLI", "ANTIGRAVITY", "GROK", "KIMI", "OPENCODE", "OPENROUTER"]) {
    for (const state of ["present", "logged_out", "absent", "unavailable"]) {
      assert.notEqual(
        rowAction(providerSpec(code), { state }, {}).kind,
        "signin",
        code + " offered a sign in button in " + state,
      );
    }
  }
  assert.equal(
    CONNECT_PROVIDERS.filter((provider) => provider.deviceSignIn === true).length,
    1,
  );
});

test("a signed out tool says where to sign in, Grok and Kimi included", () => {
  /* A row is drawn only for a tool on this computer, so a signed out Grok or
     Kimi says what to do rather than a phrase about installs. */
  for (const code of ["GEMINI_CLI", "ANTIGRAVITY", "GROK", "KIMI", "OPENCODE"]) {
    assert.deepEqual(rowAction(providerSpec(code), { state: "logged_out" }, {}), {
      kind: "note",
      note: "Sign in inside the CLI, then reopen OpenLimiter.",
    });
  }
  assert.equal(CONNECT_PROVIDERS.some((provider) => "install" in provider), false);
});

test("the Gemini sentence is the promised one, on both rows that share it", () => {
  const sentence = "Reads the login the Gemini CLI stored, may break when Google changes it";
  assert.equal(providerSpec("GEMINI_CLI").line, sentence);
  assert.equal(providerSpec("ANTIGRAVITY").line, sentence);
});

test("Claude is read, never signed into, and its row says which of three shapes the machine is in", () => {
  assert.equal(providerSpec("CLAUDE").neverSignIn, true);
  assert.equal(
    claudeLine(claudeSignals({ providers: [{ provider_id: "claude", statusline_wired: true }] })),
    "Reading the status line Claude Code already writes.",
  );
  assert.equal(
    claudeLine(claudeSignals({ providers: [{ provider_id: "claude", foreign_status_line: true }] })),
    "Your own status line is already set, and OpenLimiter can wrap it.",
  );
  assert.equal(
    claudeLine(claudeSignals({ providers: [{ provider_id: "claude", wrappable_status_line: true }] })),
    "Your own status line is already set, and OpenLimiter can wrap it.",
  );
  assert.equal(
    claudeLine(claudeSignals(null)),
    "Reads Claude Code on this machine, and never asks you to sign in.",
  );
});

test("a completed first run tells Rust, at its end and on every later launch", async () => {
  {
    const harness = firstRunDom(false);
    installFirstRunGlobals(harness);
    let reports = 0;
    initFirstRun({
      detectProviders: async () => ({ ok: true, value: { providers: [] } }),
      autostartFirstRun: async () => {
        reports += 1;
        return { ok: true, value: true };
      },
      platform: "Linux",
    });
    await waitFor(() => harness.setup.hidden === false, "Connect did not appear");
    assert.equal(reports, 0, "reported before the first run was complete");
    await harness.doc.byId["first-run-continue"].fire("click");
    await waitFor(() => reports === 1, "the end of the first run was not reported");
    assert.equal(harness.screen.hidden, true);
  }
  {
    const harness = firstRunDom(true);
    installFirstRunGlobals(harness);
    let reports = 0;
    initFirstRun({
      detectProviders: async () => new Promise(() => {}),
      autostartFirstRun: async () => {
        reports += 1;
        throw new Error("the report fails quietly");
      },
      platform: "Linux",
    });
    await waitFor(() => reports === 1, "a completed install did not report at launch");
    assert.equal(harness.screen.hidden, true);
  }
});

test("entering Connect moves focus and announces the completed scan", () => {
  const html = read("index.html");
  assert.match(html, /id="first-run-title" tabindex="-1"/u);
  assert.match(
    html,
    /id="first-run-status" class="first-run-status" role="status" aria-live="polite" aria-atomic="true"/u,
  );
  assert.match(firstRunSection(), /aria-labelledby="first-run-title"/u);
});

test("marking Connect updates the step state in the rendered list", () => {
  const attributes = new Map([
    ["connect", new Map()],
    ["bars", new Map()],
  ]);
  const items = [...attributes].map(([step, values]) => ({
    getAttribute: (name) => (name === "data-step" ? step : null),
    setAttribute: (name, value) => values.set(name, value),
    removeAttribute: (name) => values.delete(name),
  }));
  const root = {
    querySelector: () => ({
      hidden: true,
      querySelectorAll: () => items,
    }),
  };

  markStep(root, "connect");
  assert.equal(attributes.get("connect").get("data-state"), "current");
  assert.equal(attributes.get("connect").get("aria-current"), "step");
  assert.equal(attributes.get("bars").get("data-state"), "todo");
  markStep(root, "bars");
  assert.equal(attributes.get("connect").get("data-state"), "done");
  assert.equal(attributes.get("bars").get("aria-current"), "step");
});

test("overlapping forced scans serialize and commit only the latest generation", async () => {
  let calls = 0;
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const detect = async () => {
    calls += 1;
    if (calls === 1) return first;
    return {
      ok: true,
      value: {
        providers: [{ provider_id: "codex", state: "present", accounts: [] }],
      },
    };
  };
  const loader = createDetectionLoader(detect);
  const older = loader.load(true);
  const newer = loader.load(true);
  await Promise.resolve();
  assert.equal(calls, 1);

  releaseFirst({
    ok: true,
    value: {
      providers: [{ provider_id: "codex", state: "absent", accounts: [] }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);

  const [oldResult, newResult] = await Promise.all([older, newer]);
  assert.equal(loader.isCurrent(oldResult), false);
  assert.equal(loader.isCurrent(newResult), true);
  assert.equal(
    loader.committed().result.providers.find((entry) => entry.code === "CODEX")?.state,
    "present",
  );
});

test("the Codex device flow finishes inside our own window", async () => {
  const seen = [];
  let started = null;
  let polls = 0;
  const outcome = await runCodexSignIn({
    start: async () => {
      seen.push("start");
      return {
        ok: true,
        value: {
          sessionId: "session one",
          userCode: "ABCD1234",
          verificationUrl: "https://auth.openai.com/device",
        },
      };
    },
    poll: async (sessionId) => {
      seen.push("poll " + sessionId);
      polls += 1;
      return { ok: true, value: { kind: polls < 3 ? "pending" : "complete" } };
    },
    cancel: async (sessionId) => {
      seen.push("cancel " + sessionId);
      return { ok: true };
    },
    onStarted: (value) => {
      started = value;
    },
    wait: async () => {},
    now: () => 0,
  });

  assert.equal(outcome.kind, "complete");
  assert.equal(outcome.sentence, "Codex is connected.");
  /* The code and the page are handed to the window, never to a console. */
  assert.equal(started.userCode, "ABCD1234");
  assert.equal(started.verificationUrl, "https://auth.openai.com/device");
  assert.equal(seen.filter((entry) => entry.startsWith("cancel")).length, 0);
  assert.equal(polls, 3);
});

test("a foreign Codex device URL is never shown", async () => {
  const outcome = await runCodexSignIn({
    start: async () => ({ ok: false, kind: "untrusted_url" }),
    poll: async () => ({ ok: true, value: { kind: "complete" } }),
    cancel: async () => ({ ok: true }),
    wait: async () => {},
    now: () => 0,
  });
  assert.equal(outcome.sentence, CODEX_DEVICE_LINK_FALLBACK);
});

test("the Codex device flow can be cancelled, and the backend is told", async () => {
  const cancelled = [];
  let stop = false;
  const outcome = await runCodexSignIn({
    start: async () => ({ ok: true, value: { sessionId: "session one", userCode: "A", verificationUrl: "https://example.invalid" } }),
    poll: async () => {
      stop = true;
      return { ok: true, value: { kind: "pending" } };
    },
    cancel: async (sessionId) => {
      cancelled.push(sessionId);
      return { ok: true };
    },
    cancelled: () => stop,
    wait: async () => {},
    now: () => 0,
  });

  assert.equal(outcome.kind, "cancelled");
  assert.equal(outcome.sentence, "Sign in cancelled, and nothing changed.");
  assert.deepEqual(cancelled, ["session one"]);
});

test("the Codex device flow stops at three minutes", async () => {
  assert.equal(CODEX_SIGN_IN_TIMEOUT_MILLISECONDS, 180_000);
  const cancelled = [];
  let clock = 0;
  const outcome = await runCodexSignIn({
    start: async () => ({ ok: true, value: { sessionId: "session one", userCode: "A", verificationUrl: "https://example.invalid" } }),
    poll: async () => {
      clock += 60_000;
      return { ok: true, value: { kind: "pending" } };
    },
    cancel: async (sessionId) => {
      cancelled.push(sessionId);
      return { ok: true };
    },
    wait: async () => {},
    now: () => clock,
  });

  assert.equal(outcome.kind, "timed_out");
  assert.equal(outcome.sentence, "The sign in ran out of time, and nothing changed.");
  assert.deepEqual(cancelled, ["session one"]);
});

test("the Codex flow counts down from the lifetime Rust reports, not a fresh three minutes", async () => {
  /* Rust started its deadline before the code was printed, so by the time
     the start answers, part of the lifetime is gone. */
  let clock = 0;
  let polls = 0;
  let started = null;
  const outcome = await runCodexSignIn({
    start: async () => ({ ok: true, value: { sessionId: "one", userCode: "A", verificationUrl: "https://example.invalid", expiresInSeconds: 150 } }),
    poll: async () => {
      polls += 1;
      clock += 50_000;
      return { ok: true, value: { kind: "pending" } };
    },
    cancel: async () => ({ ok: true }),
    onStarted: (value) => { started = value; },
    wait: async () => {},
    now: () => clock,
  });
  assert.equal(started.endsAt, 150_000, "the window did not take the remaining lifetime");
  assert.equal(outcome.kind, "timed_out");
  assert.equal(polls, 3, "the flow ran past the lifetime Rust reported");
  /* A start that states no lifetime keeps the three minutes it always had. */
  let fallback = null;
  await runCodexSignIn({
    start: async () => ({ ok: true, value: { sessionId: "two", userCode: "A", verificationUrl: "https://example.invalid" } }),
    poll: async () => ({ ok: true, value: { kind: "complete" } }),
    cancel: async () => ({ ok: true }),
    onStarted: (value) => { fallback = value; },
    wait: async () => {},
    now: () => 1_000,
  });
  assert.equal(fallback.endsAt, 1_000 + CODEX_SIGN_IN_TIMEOUT_MILLISECONDS);
});

test("the Codex code counts down in minutes and seconds, never below zero", () => {
  const { codexCountdown } = firstRun;
  assert.equal(typeof codexCountdown, "function", "no countdown for the Codex code");
  assert.equal(codexCountdown(CODEX_SIGN_IN_TIMEOUT_MILLISECONDS), "Code expires in 3:00");
  assert.equal(codexCountdown(179_001), "Code expires in 3:00", "a part second rounds up");
  assert.equal(codexCountdown(65_000), "Code expires in 1:05");
  assert.equal(codexCountdown(9_000), "Code expires in 0:09");
  assert.equal(codexCountdown(0), "Code expires in 0:00");
  assert.equal(codexCountdown(-5_000), "Code expires in 0:00");
});

/* The nearest element that would make a screen reader speak its changes. */
function liveAncestor(node) {
  for (let at = node; at !== null && at !== undefined; at = at.parent) {
    const role = at.getAttribute?.("role");
    if (role === "status" || role === "alert" || role === "log" || role === "timer") return at;
    if (at.getAttribute?.("aria-live") !== null && at.getAttribute?.("aria-live") !== undefined && at.getAttribute("aria-live") !== "off") return at;
  }
  return null;
}

test("a Codex sign in that runs out of time counts down quietly, says what happened, then offers Try again", async () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  let clock = 0;
  const timers = new Map();
  let nextTimer = 0;
  harness.win.setInterval = (callback) => { nextTimer += 1; timers.set(nextTimer, callback); return nextTimer; };
  harness.win.clearInterval = (id) => { timers.delete(id); };
  harness.win.setTimeout = (callback) => { callback(); return 0; };
  let starts = 0;
  let cancels = 0;
  let firstCountdown = null;
  let saidAtStart = null;
  initFirstRun({
    detectProviders: async () => ({
      ok: true,
      value: { providers: [{ provider_id: "codex", state: "installed_logged_out", accounts: [] }] },
    }),
    codexSignIn: async () => {
      starts += 1;
      return { ok: true, value: { sessionId: "one", userCode: "ABCD", verificationUrl: "https://auth.openai.com/device", expiresInSeconds: 150 } };
    },
    codexSignInPoll: async () => {
      const ticking = harness.providers.children[0].all((node) => node.className === "first-run-countdown")[0];
      if (ticking !== undefined && firstCountdown === null) firstCountdown = { text: ticking.textContent, live: liveAncestor(ticking) };
      saidAtStart ??= harness.providers.children[0].all((node) => node.getAttribute("role") === "status")[0]?.textContent;
      /* Two minutes and fifty seconds pass before the next answer. */
      clock += 170_000;
      for (const tick of timers.values()) tick();
      return { ok: true, value: { kind: "pending" } };
    },
    codexSignInCancel: async () => { cancels += 1; return { ok: true }; },
    now: () => clock,
    platform: "Linux",
  });
  /* The list is not a live region: rows are announced by the scan status. */
  assert.equal(harness.providers.getAttribute("aria-live"), null);
  assert.doesNotMatch(read("index.html"), /id="first-run-providers"[^>]*aria-live/u);
  await waitFor(() => harness.providers.children.length === 1, "the Codex row was not drawn");
  const row = harness.providers.children[0];
  const button = row.all((node) => node.localName === "button")[0];
  assert.equal(button.textContent, "Sign in");
  const live = row.all((node) => node.getAttribute("role") === "status")[0];
  assert.ok(live, "the row has no place to say what happened");
  await button.fire("click");
  await waitFor(() => firstCountdown !== null, "no countdown was drawn");
  /* It starts from what Rust said was left, two and a half minutes, and
     the row says once that a code is waiting to be entered. */
  assert.equal(firstCountdown.text, "Code expires in 2:30");
  assert.equal(firstCountdown.live, null, "the ticking time sits inside a live region");
  assert.equal(saidAtStart, "Open this page and enter the code.");
  await waitFor(() => button.disabled === false, "the flow did not end");
  assert.equal(cancels, 1, "the expired flow was not cancelled on the backend");
  assert.equal(live.textContent, "The sign in ran out of time, and nothing changed.");
  assert.equal(row.all((node) => node.className === "first-run-countdown").length, 0, "the countdown outlived its flow");
  assert.equal(button.textContent, "Try again");
  assert.match(button.getAttribute("aria-label"), /^Try again/u);
  assert.equal(timers.size, 0, "the countdown kept ticking after the flow ended");
  await button.fire("click");
  await waitFor(() => starts === 2, "Try again did not start a new sign in");
  assert.equal(row.all((node) => node.getAttribute("role") === "status")[0], live, "Try again replaced the place the row speaks from");
});

test("a flow that never starts leaves the row exactly as it was", async () => {
  const cancelled = [];
  const outcome = await runCodexSignIn({
    start: async () => ({ ok: false, reason: "unconfigured" }),
    poll: async () => ({ ok: true, value: { kind: "complete" } }),
    cancel: async (sessionId) => {
      cancelled.push(sessionId);
      return { ok: true };
    },
    wait: async () => {},
    now: () => 0,
  });

  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.sentence, "The sign in did not complete, and nothing changed.");
  assert.deepEqual(cancelled, []);
});

test("every terminal answer the backend can give has a sentence", () => {
  for (const kind of ["complete", "cancelled", "timed_out", "failed"]) {
    assert.notEqual(codexSentence(kind), "");
  }
});

test("no string this screen shows a person contains a dash", () => {
  for (const value of firstRunCopyStrings()) {
    assert.equal(typeof value, "string");
    assert.equal(
      DASH.test(value),
      false,
      "a dash reached the screen: " + value,
    );
  }
});

test("no string literal in the module carries a dash into prose", () => {
  /*
   * The sweep, and the only things it lets through. Prose has spaces and
   * identifiers do not, so any literal with both a space and a dash is prose
   * unless it is a fragment of markup or SVG path geometry. Everything else is
   * a sentence and a sentence never gets a dash here.
   */
  let source = read("first-run.js").replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = [...source.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu)].map(
    (match) => match[0].slice(1, -1),
  );
  assert.ok(literals.length > 60);
  for (const value of literals) {
    if (!value.includes(" ") || !DASH.test(value)) continue;
    const markup = value.includes("<") || value.includes(">");
    const geometry = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/u.test(value);
    assert.ok(
      markup || geometry || value.startsWith("http"),
      "a dash reached a string literal: " + value,
    );
  }
});

test("no dash reaches the first run markup either", () => {
  const text = firstRunSection()
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<[^>]*>/gu, " ");
  assert.equal(DASH.test(text), false, "a dash reached the markup: " + text.trim());
  /* And the words are actually in there, so a passing sweep cannot be a
     sweep over an empty string. */
  assert.match(text, /Connect your tools/u);
  assert.match(text, /Show my bars/u);
});

test("keeps one sign in form, reachable from the header account menu", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");

  /* One password field in the document, not two. A second copy is a second
     place for a bug to live and the one that stops being fixed. */
  assert.equal((html.match(/id="account-password"/gu) ?? []).length, 1);
  assert.equal((html.match(/id="account-email-form"/gu) ?? []).length, 1);
  assert.match(html, /id="menu-sign-in"/u);
  assert.match(app, /elements\.menuSignInButton\?\.addEventListener\("click", openSignIn\)/u);
  /* The first run no longer borrows the body: nothing lends it out. */
  assert.doesNotMatch(app, /function mountSignIn\(/u);
});

test("the account menu hides the switch and the log out while signed out", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /elements\.menuSignIn\.hidden = signedIn/u);
  assert.match(app, /elements\.menuSignedIn\.hidden = !signedIn/u);
  assert.match(app, /elements\.menuLogout\.hidden = !signedIn/u);
});

test("the menu's sync switch says what it syncs, in one short label", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /<label class="menu-line"><span>Sync usage percentages<\/span><span class="provider-switch"><input id="menu-sync" type="checkbox" role="switch" checked \/>/u);
});

test("lets a cached signed in session continue while the backend is offline", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

  assert.match(app, /signedIn && status\.backendReachable === false/u);
  assert.match(html, /Offline\. Local collection is still running\./u);
});

test("the window reads the account once at launch, without the first run", () => {
  const app = read("app.js");
  assert.match(app, /void accountStatus\(\)\.then\(/u);
  assert.doesNotMatch(app, /initFirstRun\(\{[\s\S]*?accountStatus,[\s\S]*?\}\);/u);
});

test("shows the two SmartScreen actions for an unsigned Windows release", () => {
  assert.deepEqual(launchNotice("Win32"), {
    title: "Unsigned Windows build",
    detail: "SmartScreen: choose More info, then Run anyway.",
  });
});

test("names the Open Anyway path macOS 15 still offers for the unsigned release", () => {
  /* macOS 15 removed Open from the control click menu for an app it has not
     verified; System Settings is the one way through that is left. */
  const notice = launchNotice("MacIntel");
  assert.deepEqual(notice, {
    title: "macOS preview build",
    detail:
      "Gatekeeper: open OpenLimiter from Applications and choose Done, then in System Settings, Privacy & Security, choose Open Anyway.",
  });
  assert.doesNotMatch(notice.detail, /control click/iu);
});

test("no longer claims a macOS release is coming", () => {
  assert.doesNotMatch(launchNotice("MacIntel").detail, /coming|soon|future/iu);
});

test("does not add a launch warning on Linux", () => {
  assert.equal(launchNotice("Linux x86_64"), null);
});

test("normalizes every Lane 1 state and keeps only account counts", () => {
  const result = normalizeDetections({
    providers: [
      {
        provider_id: "codex",
        state: "present",
        accounts: [
          { account_id: "private one", auth_state: "ready" },
          { account_id: "private two", auth_state: "stale", recovery: "reopen_cli" },
        ],
      },
      { provider_id: "claude", state: "installed_logged_out", accounts: [] },
    ],
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.providers.find((entry) => entry.code === "CODEX"), {
    code: "CODEX",
    state: "present",
    accountCount: 2,
    recovery: null,
  });
  assert.deepEqual(result.providers.find((entry) => entry.code === "CLAUDE"), {
    code: "CLAUDE",
    state: "logged_out",
    accountCount: 0,
    recovery: "sign_in_to_cli",
  });
  assert.equal(JSON.stringify(result).includes("private one"), false);
});

test("accepts the legacy Claude detection until Lane 1 lands", () => {
  const result = normalizeDetections({
    claude_settings_present: true,
    statusline_wired: false,
    hook_wired: false,
  });
  assert.equal(result.available, true);
  assert.equal(
    result.providers.find((entry) => entry.code === "CLAUDE")?.state,
    "present",
  );
  assert.equal(
    result.providers.find((entry) => entry.code === "CODEX")?.state,
    "absent",
  );
});

test("stale detected accounts name the CLI recovery without exposing identity", () => {
  const result = normalizeDetections({
    providers: [
      {
        provider_id: "claude",
        state: "present",
        accounts: [
          {
            account_id: "private account",
            auth_state: "stale",
            recovery: "reopen_cli",
          },
        ],
      },
    ],
  });
  assert.deepEqual(result.providers.find((entry) => entry.code === "CLAUDE"), {
    code: "CLAUDE",
    state: "logged_out",
    accountCount: 1,
    recovery: "reopen_cli",
  });
  assert.equal(JSON.stringify(result).includes("private account"), false);
});

test("an unavailable backend never becomes a false absent claim", () => {
  const result = normalizeDetections(null);
  assert.equal(result.available, false);
  assert.equal(result.providers.length, 8);
  assert.equal(result.providers.every((entry) => entry.state === "unavailable"), true);
  assert.equal(result.providers.some((entry) => entry.code === "MANUAL"), false);
});

test("a successful empty scan is a coherent fresh machine state", () => {
  const result = normalizeDetections({
    providers: [
      "claude",
      "codex",
      "grok",
      "kimi",
      "antigravity",
      "gemini_cli",
      "opencode",
      "openrouter",
    ].map((provider_id) => ({ provider_id, state: "absent", accounts: [] })),
  });
  assert.equal(result.available, true);
  assert.equal(result.providers.length, 8);
  assert.equal(result.providers.every((entry) => entry.state === "absent"), true);
});

test("normalizes the detected Gemini CLI provider without losing its separator", () => {
  const result = normalizeDetections({
    providers: [
      {
        provider_id: "gemini_cli",
        state: "present",
        accounts: [{ account_id: "private account", auth_state: "ready" }],
      },
    ],
  });
  assert.deepEqual(result.providers.find((entry) => entry.code === "GEMINI_CLI"), {
    code: "GEMINI_CLI",
    state: "present",
    accountCount: 1,
    recovery: null,
  });
  assert.equal(JSON.stringify(result).includes("private account"), false);
});

test("unknown providers never enter the first run rows", () => {
  const result = normalizeDetections({
    providers: [{ provider_id: "other", state: "present", accounts: [] }],
  });
  assert.equal(result.providers.length, 8);
  assert.equal(result.providers.some((entry) => entry.code === "OTHER"), false);
});

test("accepts the future detector aliases for Grok and Kimi", () => {
  const result = normalizeDetections({
    providers: [
      { provider_id: "xai", state: "present", accounts: [] },
      { provider_id: "moonshot", state: "present", accounts: [] },
    ],
  });

  assert.equal(result.providers.find((entry) => entry.code === "GROK")?.state, "present");
  assert.equal(result.providers.find((entry) => entry.code === "KIMI")?.state, "present");
});

test("colours and radii on the connect rows come from tokens", () => {
  /* The one rule that keeps a window one window. A literal here is a colour
     no theme and no token sheet can reach. */
  const css = read("app.css");
  const start = css.indexOf("/* ----------------------------------------------- the two step first run */");
  assert.ok(start > 0);
  const block = css.slice(start);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/u.test(block), false);
  assert.equal(/rgb\(|hsl\(/u.test(block), false);
  for (const radius of block.matchAll(/border-radius: ([^;]+);/gu)) {
    assert.match(radius[1], /var\(--ol-radius-/u);
  }
});

/* The head script of index.html itself, run as the page runs it before any
   module loads, against this harness's storage and root element. A data
   attribute it sets lands in `dataset`, as it does in a browser. */
function headProbe(harness) {
  const html = read("index.html");
  const start = html.indexOf("<script>") + "<script>".length;
  const script = html.slice(start, html.indexOf("</script>", start));
  const root = harness.doc.documentElement;
  const documentElement = {
    setAttribute(name, value) {
      const data = /^data-(.+)$/u.exec(name);
      if (data === null) root.setAttribute(name, value);
      else root.dataset[data[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = String(value);
    },
  };
  vm.runInNewContext(script, { window: harness.win, document: { documentElement } });
}

const never = () => new Promise(() => {});

test("the head script paints Home only for a finished install with tools", () => {
  const painted = (values) => {
    const harness = firstRunDom(false);
    for (const [key, value] of Object.entries(values)) harness.values.set(key, value);
    headProbe(harness);
    return harness.doc.documentElement.dataset.firstRun;
  };
  const done = "openlimiter-first-run-complete-v1";
  const tools = "openlimiter-configured-providers-v1";
  assert.equal(painted({ [done]: "complete", [tools]: '["CODEX"]' }), "complete");
  assert.equal(painted({}), "pending", "a new install");
  assert.equal(painted({ [done]: "complete" }), "pending", "finished, but no tools were ever kept");
  assert.equal(painted({ [done]: "complete", [tools]: "[]" }), "pending", "every tool removed");
  assert.equal(painted({ [tools]: '["CODEX"]' }), "pending", "tools, first run never finished");
  assert.equal(painted({ [done]: "complete", [tools]: "{" }), "pending", "unreadable tools");
  assert.equal(painted({ [done]: "complete", [tools]: '{"length":1}' }), "pending", "not a list");
  const refused = firstRunDom(false);
  refused.win.localStorage.getItem = () => { throw new Error("storage refused"); };
  headProbe(refused);
  assert.equal(refused.doc.documentElement.dataset.firstRun, "pending", "storage refused");
});

test("a new person sees Connect at once, checking, while detection stalls", () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  headProbe(harness);
  initFirstRun({ detectProviders: never, platform: "Linux" });
  assert.equal(harness.doc.documentElement.dataset.firstRun, "pending");
  assert.equal(harness.setup.hidden, false, "a new person was left on a blank screen");
});

test("a returning person whose tools were all removed is asked again, never left on a blank screen", () => {
  const returning = firstRunDom(false);
  returning.values.set("openlimiter-first-run-complete-v1", "complete");
  returning.values.set("openlimiter-configured-providers-v1", "[]");
  installFirstRunGlobals(returning);
  headProbe(returning);
  initFirstRun({ detectProviders: never, platform: "Linux" });
  assert.equal(returning.doc.documentElement.dataset.firstRun, "pending");
  assert.equal(returning.setup.hidden, false, "a returning person was left on a blank screen");
});

test("a finished first run gets out of the way at once", async () => {
  const harness = firstRunDom(true);
  installFirstRunGlobals(harness);
  headProbe(harness);
  let completions = 0;
  initFirstRun({ detectProviders: never, onContinue: () => { completions += 1; }, platform: "Linux" });
  assert.equal(harness.doc.documentElement.dataset.firstRun, "complete", "the head probe was overwritten");
  await waitFor(() => harness.screen.hidden === true, "first run did not get out of the way");
  assert.equal(completions, 0, "nothing was asked, so nothing continued");
});

test("storage that refuses every read still opens the first run on Connect", () => {
  const harness = firstRunDom(false);
  harness.win.localStorage.getItem = () => { throw new Error("storage refused"); };
  installFirstRunGlobals(harness);
  initFirstRun({ detectProviders: never, platform: "Linux" });
  assert.equal(harness.setup.hidden, false);
  assert.equal(harness.doc.documentElement.dataset.firstRun, "pending");
});
