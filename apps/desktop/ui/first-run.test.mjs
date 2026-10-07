import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CODEX_SIGN_IN_TIMEOUT_MILLISECONDS,
  CODEX_DEVICE_LINK_FALLBACK,
  CONNECT_PROVIDERS,
  FIRST_RUN_STEPS,
  INSTALL_LINES,
  SIGN_IN_WAYS,
  claudeLine,
  createClaudePollConsentGate,
  claudePollView,
  claudeSignals,
  createDetectionLoader,
  codexSentence,
  firstRunCopyStrings,
  initFirstRun,
  launchNotice,
  markStep,
  normalizeDetections,
  persistedToggleValue,
  pressSignInWay,
  rowAction,
  runCodexSignIn,
  signInWay,
} from "./first-run.js";
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
  const account = register("first-run-account");
  const later = register("first-run-later", "button");
  const way = register("first-run-way-status", "p");
  account.append(later, way);
  const setup = register("first-run-setup");
  const heading = register("first-run-title", "h1");
  const providers = register("first-run-providers");
  const status = register("first-run-status", "p");
  const showBars = register("first-run-continue", "button");
  const skip = register("first-run-skip", "button");
  const continueOff = register("first-run-continue-without-claude", "button");
  setup.hidden = true;
  continueOff.hidden = true;
  setup.append(heading, providers, status, showBars, skip, continueOff);

  const consent = register("claude-poll-consent");
  const consentTitle = register("claude-poll-consent-title", "h1");
  const consentNote = register("claude-poll-consent-note", "p");
  const consentEnable = register("claude-poll-consent-enable", "button");
  const consentDecline = register("claude-poll-consent-decline", "button");
  const consentStatus = register("claude-poll-consent-status", "p");
  const consentContinueOff = register("claude-poll-consent-continue-off", "button");
  consent.hidden = true;
  consentContinueOff.hidden = true;
  consent.append(
    consentTitle,
    consentNote,
    consentEnable,
    consentDecline,
    consentStatus,
    consentContinueOff,
  );
  screen.append(account, setup, consent);

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
  return { doc, screen, account, way, setup, status, consent, consentStatus, values, win };
}

function installFirstRunGlobals(harness) {
  globalThis.document = harness.doc;
  globalThis.window = harness.win;
  globalThis.HTMLElement = FakeElement;
}

/* Every dash a keyboard and a word processor can produce, because the rule is
   about what a person reads and not about which key made it. */
const DASH = /[-‐‑‒–—―−]/u;

test("keeps an unconfigured screen to its rows: no paragraph ships visible and nothing points at a tab", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const screen = html.slice(html.indexOf('<main id="home">'), html.indexOf("</main>"));
  assert.doesNotMatch(screen, /Open Connections|id="empty"|Nothing measurable yet/u);
  /*
   * The tools list always has Claude Code, Antigravity and OpenRouter, each
   * with one step, so an empty screen needs no card explaining itself. Every
   * paragraph on it starts empty or hidden and is revealed only by something
   * the window can prove: a refresh status, a failure, a setup line.
   */
  for (const paragraph of screen.matchAll(/<p\b[^>]*>(.*?)<\/p>/gsu)) {
    const [whole, inner] = paragraph;
    assert.ok(/hidden/u.test(whole.slice(0, whole.indexOf(">"))) || inner.trim() === "", "a paragraph ships visible: " + whole);
  }
  assert.match(screen, /id="home-refresh-status" class="q-note" role="status" aria-live="polite"><\/p>/u);
});

test("walks account, then connect, then bars, and says so on the screen", () => {
  /* Three steps, in this order, and the step list a person reads has to be
     the same three in the same order. A named list that drifts from the code
     driving it is a progress indicator that lies. */
  assert.deepEqual(FIRST_RUN_STEPS, ["account", "connect", "bars"]);

  const list = firstRunSection();
  const labels = [...list.matchAll(/<li data-step="([a-z]+)"[^>]*>([^<]+)<\/li>/gu)].map(
    (item) => [item[1], item[2]],
  );
  assert.deepEqual(labels, [
    ["account", "Account"],
    ["connect", "Connect"],
    ["bars", "Bars"],
  ]);

  /* And the last step is not a screen: it marks itself and gets out of the
     way, exactly as the window behind it comes up. */
  const source = read("first-run.js");
  assert.match(
    source,
    /markStep\(screen, "bars"\);\s*document\.documentElement\.dataset\.firstRun = "complete";\s*screen\.hidden = true;/u,
  );
  assert.match(source, /function finish\(\) \{[\s\S]*?completeFirstRun\(screen\);\s*options\.onContinue\(\);/u);
});

test("asks for nothing before the machine is read", () => {
  /* The account is step one, and it is still not a wall. Detection is started
     on load, behind no session and no press, so the connect step is populated
     the moment it opens and the Later link reaches a full list rather than a
     spinner. */
  const html = read("index.html");

  assert.equal(html.includes('id="account-gate"'), false);
});

test("step one says the bars are free and what the account is for", () => {
  const step = firstRunSection();
  const account = step.slice(step.indexOf('id="first-run-account"'));

  assert.match(account, /<h1 id="first-run-account-title">Create your account<\/h1>/u);
  const lead = account.match(/class="sign-in-lead"[^>]*>([^<]+)</u)?.[1] ?? "";
  assert.match(lead, /free with no account/u);
  assert.match(lead, /every desktop alert is free with no account/u);
  assert.match(lead, /sync to your phone, with Pro adding phone push, email and more than one account per provider/u);
  /* One sentence, one full stop, at the end of it. */
  assert.equal((lead.match(/\./gu) ?? []).length, 1);
  assert.match(lead, /\.$/u);
});

test("the way past sign in is a quiet Later link, not a second button", () => {
  const step = firstRunSection();
  const source = read("first-run.js");

  assert.match(step, /id="first-run-later" class="sign-in-ghost">Create account later</u);
  /* It says what it does rather than when, and it is a bordered button in its
     own quiet row: a person who does not want an account has to find this
     control, so it has an edge of its own without taking the fill the four
     ways in above it carry. */
  assert.equal(/id="first-run-later"[^>]*class="[^"]*first-run-continue/u.test(step), false);
  assert.equal(/id="first-run-later"[^>]*>Later</u.test(step), false);
  /* And it moves to the tools rather than ending the setup, because a person
     who declines an account still has eight bars waiting for them. */
  assert.match(
    source,
    /#first-run-later"\)\?\.addEventListener\("click", \(\) => \{\s*void showConnect\(\);/u,
  );
});

test("Microsoft is offered by name and sent as azure", async () => {
  /* Supabase knows the provider as azure and a person knows it as Microsoft.
     One string used for both is how a rename ends up sending a value no
     service has ever heard of. */
  const way = signInWay("microsoft");
  assert.deepEqual(way, { id: "microsoft", wire: "azure", label: "Microsoft", mounted: false });

  const sent = [];
  const result = await pressSignInWay(
    { signInWithProvider: async (wire) => { sent.push(wire); return { ok: true }; } },
    "microsoft",
  );
  assert.deepEqual(sent, ["azure"]);
  assert.equal(result.ok, true);

  /* The other three ways in are the ones the window's own sign in body draws,
     so this file makes exactly one button and borrows the rest. */
  assert.deepEqual(
    SIGN_IN_WAYS.filter((entry) => entry.mounted === false).map((entry) => entry.id),
    ["microsoft"],
  );
  assert.deepEqual(SIGN_IN_WAYS.map((entry) => entry.id), [
    "github",
    "google",
    "microsoft",
    "email",
  ]);
  const source = read("first-run.js");
  assert.match(source, /button\.dataset\.wire = way\.wire/u);
  assert.match(source, /"Continue with " \+ way\.label/u);
  /* It goes into the borrowed body's own provider column, so the four ways
     read as one stack rather than three and then a stray. */
  assert.match(source, /mount\.querySelector\("\.sign-in-providers"\) \?\? mount/u);
});

test("every way in finishes through the one handler that announces it", () => {
  /*
   * The defect this exists for: Microsoft is the only button this file draws,
   * and it used to call the service directly. The session arrived, and then
   * nothing applied the account state, nothing drew the arrival and nothing
   * dispatched openlimiter:signed-in, so a successful Microsoft sign in left
   * first run sitting on step one forever while the person was signed in.
   *
   * There is one handler and it is the thing that announces the arrival, so
   * the guarantee is stated as: exactly one place dispatches that event, and
   * every provider reaches it through the same function.
   */
  const app = read("app.js");
  const dispatches = app.match(/dispatchEvent\(new CustomEvent\("openlimiter:signed-in"\)\)/gu);
  assert.equal(dispatches?.length, 1, "the arrival is announced in more than one place");
  /* That one dispatch is inside runSignIn, which is what applies the account
     state and draws the success. */
  assert.match(
    app,
    /async function runSignIn\([\s\S]*?applyAccountState\(result\.value\)[\s\S]*?openlimiter:signed-in/u,
  );
  /* The mounted buttons and the drawn one all arrive through continueWith,
     which is the only caller of runSignIn for a provider. */
  assert.match(app, /function continueWith\(provider, pressed = null\)[\s\S]*?return runSignIn\(/u);
  assert.match(app, /signInGithub\?\.addEventListener\("click", \(\) => void continueWith\("github"\)\)/u);
  assert.match(app, /signInGoogle\?\.addEventListener\("click", \(\) => void continueWith\("google"\)\)/u);
  assert.match(app, /signInWithProvider: \(wire, pressed\) => continueWith\(wire, pressed\)/u);
  /* Nothing calls the service behind that handler's back. */
  assert.doesNotMatch(app, /signInWithProvider: \(wire\) => accountOauth\(wire\)/u);

  /* And the wire value the drawn button sends is one the service knows. */
  const backend = read("backend.js");
  assert.match(backend, /OAUTH_PROVIDERS = Object\.freeze\(\["google", "github", "azure"\]\)/u);
  const states = read("sign-in-states.js");
  assert.match(states, /provider === "azure"\) return "Microsoft"/u);
});

test("the drawn button hands its own element to the shared handler", async () => {
  /* The busy state has to land on the control somebody actually pressed, and
     that control is not in the shared body, so it travels with the call. */
  const seen = [];
  const result = await pressSignInWay(
    {
      signInWithProvider: async (wire, pressed) => {
        seen.push([wire, pressed]);
        return { ok: true, displayed: true };
      },
    },
    "microsoft",
    "the-button",
  );
  assert.deepEqual(seen, [["azure", "the-button"]]);
  assert.equal(result.ok, true);

  /* A refusal the shared handler already wrote is not written twice. */
  const source = read("first-run.js");
  assert.match(source, /if \(result\?\.displayed === true\) return;/u);
  assert.match(source, /pressSignInWay\(options, way\.id, button\)/u);
});

test("an unwired option degrades instead of throwing", async () => {
  /* Half of these commands are still landing on the Rust side. A window that
     throws on a missing command is a window with no first run at all. */
  const source = read("first-run.js");
  for (const name of [
    "signInWithProvider",
    "codexSignIn",
    "codexSignInPoll",
    "codexSignInCancel",
    "claudePollEnabled",
    "setClaudePoll",
    "copyText",
    "mountSignIn",
    "unmountSignIn",
    "detectProviders",
    "accountStatus",
    "markFor",
    "isSignedIn",
    "onContinue",
  ]) {
    assert.match(
      source,
      new RegExp("const DEFAULT_OPTIONS = Object\\.freeze\\(\\{[\\s\\S]*?" + name + ":", "u"),
      name + " has no safe default",
    );
  }
  /* And an unwired provider sign in says so rather than failing silently. */
  const result = await pressSignInWay({ signInWithProvider: async () => ({ ok: false, reason: "unconfigured" }) }, "microsoft");
  assert.deepEqual(result, { ok: false, reason: "unconfigured" });
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

test("a missing command line tool names the line that installs it", () => {
  assert.deepEqual(rowAction(providerSpec("CODEX"), { state: "absent" }, {}), {
    kind: "install",
    label: "Install",
    command: "npm install -g @openai/codex",
    hint: "Run this in your terminal.",
  });
  assert.equal(
    rowAction(providerSpec("GEMINI_CLI"), { state: "absent" }, {}).command,
    "npm install -g @google/gemini-cli",
  );
  /* Antigravity is downloaded rather than installed from a terminal, so its
     line is the page and the hint says which of the two to do with it. */
  assert.deepEqual(rowAction(providerSpec("ANTIGRAVITY"), { state: "absent" }, {}), {
    kind: "install",
    label: "Install",
    command: "https://antigravity.google/download",
    hint: "Open this in your browser.",
  });
  /* And it is shown, ready to copy, rather than hidden behind the press. */
  const source = read("first-run.js");
  assert.match(source, /disclosure\.hidden = false;\s*const hint = element\("p", "first-run-hint"/u);
});

test("Grok and Kimi say what is true instead of offering an untested button", () => {
  /* Neither command line tool exists on this machine, so neither flow has
     ever been run against the real thing. A button that has never been run is
     worse than a sentence saying it is checked at install time. */
  for (const code of ["GROK", "KIMI"]) {
    for (const state of ["logged_out", "absent", "unavailable"]) {
      assert.deepEqual(rowAction(providerSpec(code), { state }, {}), {
        kind: "note",
        note: "Verified on install",
      });
    }
  }
});

test("the Gemini sentence is the promised one, on both rows that share it", () => {
  const sentence = "Reads the login the Gemini CLI stored, may break when Google changes it";
  assert.equal(providerSpec("GEMINI_CLI").line, sentence);
  assert.equal(providerSpec("ANTIGRAVITY").line, sentence);
});

test("Claude is read, never signed into, and a new install discloses its on default", () => {
  assert.equal(providerSpec("CLAUDE").neverSignIn, true);

  /* The three shapes the detection already reports, each with its own line. */
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

  assert.equal(persistedToggleValue(true, false, { ok: false }), true);
  assert.equal(persistedToggleValue(true, false, { ok: true, value: false }), false);
  assert.deepEqual(claudePollView({ state: "missing", enabled: false }, false), {
    enabled: true,
    needsAcknowledgement: false,
    needsRecording: true,
  });
  assert.deepEqual(claudePollView({ state: "missing", enabled: false }, true), {
    enabled: false,
    needsAcknowledgement: true,
    needsRecording: false,
  });
  assert.deepEqual(claudePollView({ state: "invalid", enabled: false }, true), {
    enabled: false,
    needsAcknowledgement: false,
    needsRecording: false,
  });
});

test("fresh setup waits for detection and offers a safe exit when saving from either finish control fails", async (t) => {
  for (const controlId of ["first-run-continue", "first-run-skip"]) {
    await t.test(controlId, async () => {
      const harness = firstRunDom(false);
      installFirstRunGlobals(harness);
      let releaseDetection;
      const detection = new Promise((resolve) => { releaseDetection = resolve; });
      let releaseSave;
      const saving = new Promise((resolve) => { releaseSave = resolve; });
      const writes = [];
      let detections = 0;
      let completions = 0;

      initFirstRun({
        accountStatus: async () => ({ ok: true, value: null }),
        isSignedIn: () => true,
        claudePollEnabled: async () => ({ state: "missing", enabled: false }),
        detectProviders: async () => {
          detections += 1;
          return detection;
        },
        setClaudePoll: async (enabled) => {
          writes.push(enabled);
          return saving;
        },
        onContinue: () => { completions += 1; },
        platform: "Linux",
      });

      await waitFor(() => detections === 1, "provider detection did not start");
      assert.equal(harness.setup.hidden, true, "Connect appeared before detection finished");
      releaseDetection({ ok: true, value: { providers: [] } });
      await waitFor(() => harness.setup.hidden === false, "Connect did not appear after detection");
      const poll = harness.screen.querySelector("#first-run-claude-poll");
      assert.equal(poll?.checked, true, "the disclosed fresh default was not on");

      await harness.doc.byId[controlId].fire("click");
      await waitFor(() => writes.length === 1, "the disclosed choice was not sent for persistence");
      assert.equal(completions, 0, "onboarding completed while persistence was pending");
      releaseSave({ ok: false });
      await waitFor(
        () => harness.doc.byId["first-run-continue-without-claude"].hidden === false,
        "the safe exit did not appear after persistence failed",
      );
      assert.equal(harness.status.textContent, "The choice could not be saved, so Claude usage stays off.");
      assert.equal(completions, 0);

      await harness.doc.byId["first-run-continue-without-claude"].fire("click");
      await waitFor(() => completions === 1, "the explicit safe exit did not complete onboarding");
      assert.deepEqual(writes, [true], "the safe exit made another durable consent write");
      assert.equal(harness.screen.hidden, true);
    });
  }
});

test("existing install acknowledgement offers the same safe exit after either choice fails", async (t) => {
  for (const [controlId, requested] of [
    ["claude-poll-consent-enable", true],
    ["claude-poll-consent-decline", false],
  ]) {
    await t.test(controlId, async () => {
      const harness = firstRunDom(true);
      installFirstRunGlobals(harness);
      let releaseSave;
      const saving = new Promise((resolve) => { releaseSave = resolve; });
      const writes = [];
      let detections = 0;
      let completions = 0;

      initFirstRun({
        accountStatus: async () => ({ ok: true, value: null }),
        claudePollEnabled: async () => ({ state: "missing", enabled: false }),
        detectProviders: async () => {
          detections += 1;
          return new Promise(() => {});
        },
        setClaudePoll: async (enabled) => {
          writes.push(enabled);
          return saving;
        },
        onContinue: () => { completions += 1; },
        platform: "Linux",
      });

      await waitFor(() => harness.consent.hidden === false, "the acknowledgement did not appear");
      assert.equal(detections, 0, "acknowledgement waited for provider detection");
      await harness.doc.byId[controlId].fire("click");
      await waitFor(() => writes.length === 1, "the acknowledgement choice was not sent");
      assert.equal(completions, 0, "onboarding completed while persistence was pending");
      releaseSave({ ok: false });
      await waitFor(
        () => harness.doc.byId["claude-poll-consent-continue-off"].hidden === false,
        "the acknowledgement safe exit did not appear",
      );
      assert.deepEqual(writes, [requested]);
      assert.equal(
        harness.consentStatus.textContent,
        "The choice could not be saved, so Claude usage stays off.",
      );

      await harness.doc.byId["claude-poll-consent-continue-off"].fire("click");
      await waitFor(() => completions === 1, "the acknowledgement safe exit did not finish");
      assert.deepEqual(writes, [requested], "the safe exit recorded durable consent");
      assert.equal(harness.screen.hidden, true);
    });
  }
});

test("a fresh first run cannot poll until its disclosure is shown and recorded", async () => {
  let releaseSetting;
  const setting = new Promise((resolve) => { releaseSetting = resolve; });
  const writes = [];
  let polls = 0;
  const gate = createClaudePollConsentGate({
    load: () => setting,
    save: async (enabled) => {
      writes.push(enabled);
      if (enabled) polls += 1;
      return { ok: true, value: enabled };
    },
  });

  const loading = gate.load();
  assert.equal(await gate.beforeFinish(), false, "Continue completed while the setting was loading");
  assert.deepEqual(writes, []);
  assert.equal(polls, 0);

  releaseSetting({ state: "missing", enabled: false });
  await loading;
  assert.deepEqual(gate.begin(false), {
    enabled: true,
    needsAcknowledgement: false,
    needsRecording: true,
  });
  assert.equal(await gate.beforeFinish(), false, "Continue completed before disclosure");
  assert.deepEqual(await gate.set(true), { ok: false });
  assert.deepEqual(writes, []);
  assert.equal(polls, 0);

  assert.equal(gate.disclose(), true);
  assert.equal(await gate.beforeFinish(), true);
  assert.deepEqual(writes, [true]);
  assert.equal(polls, 1, "the simulated collector ran before durable consent");
});

test("Continue waits for an explicit off save and never follows it with on", async () => {
  let releaseOff;
  const offSaved = new Promise((resolve) => { releaseOff = resolve; });
  const writes = [];
  const gate = createClaudePollConsentGate({
    load: async () => ({ state: "missing", enabled: false }),
    save: async (enabled) => {
      writes.push(enabled);
      if (!enabled && writes.length === 1) return offSaved;
      return { ok: true, value: enabled };
    },
  });
  await gate.load();
  gate.begin(false);
  gate.disclose();

  const turnOff = gate.set(false);
  const finish = gate.beforeFinish();
  await Promise.resolve();
  assert.deepEqual(writes, [false]);
  releaseOff({ ok: true, value: false });
  assert.deepEqual(await Promise.all([turnOff, finish]), [
    { ok: true, value: false },
    true,
  ]);
  assert.deepEqual(writes, [false]);
  assert.equal(gate.snapshot().enabled, false);
});

test("an existing install can record on only through its acknowledgement", async () => {
  const writes = [];
  const gate = createClaudePollConsentGate({
    load: async () => ({ state: "missing", enabled: false }),
    save: async (enabled) => {
      writes.push(enabled);
      return { ok: true, value: enabled };
    },
  });
  await gate.load();
  assert.equal(gate.begin(true).needsAcknowledgement, true);
  assert.deepEqual(await gate.set(true), { ok: false });
  assert.equal(await gate.beforeFinish(), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(await gate.acknowledge(false), { ok: true, value: false });
  assert.equal(await gate.beforeFinish(), true);
  assert.deepEqual(writes, [false]);

  const restarted = createClaudePollConsentGate({
    load: async () => ({ state: "disabled", enabled: false }),
    save: async (enabled) => {
      writes.push(enabled);
      return { ok: true, value: enabled };
    },
  });
  await restarted.load();
  assert.deepEqual(restarted.begin(true), {
    enabled: false,
    needsAcknowledgement: false,
    needsRecording: false,
  });
  assert.equal(await restarted.beforeFinish(), true);
  assert.deepEqual(writes, [false]);
});

test("entering Connect moves focus and announces the completed scan", () => {
  const html = read("index.html");
  assert.match(html, /id="first-run-title" tabindex="-1"/u);
  assert.match(
    html,
    /id="first-run-status" class="first-run-status" role="status" aria-live="polite" aria-atomic="true"/u,
  );
});

test("marking Connect updates the step state in the rendered list", () => {
  const attributes = new Map([
    ["account", new Map()],
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
  assert.equal(attributes.get("account").get("data-state"), "done");
  assert.equal(attributes.get("connect").get("data-state"), "current");
  assert.equal(attributes.get("connect").get("aria-current"), "step");
  assert.equal(attributes.get("bars").get("data-state"), "todo");
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

test("a successful Claude poll toggle updates the value used by the next redraw", () => {
  let cached = false;
  assert.equal(
    persistedToggleValue(false, true, { ok: true, value: true }, (value) => {
      cached = value;
    }),
    true,
  );
  assert.equal(cached, true);
  assert.equal(
    persistedToggleValue(true, false, { ok: false }, (value) => {
      cached = value;
    }),
    true,
  );
  assert.equal(cached, true);
});

test("Claude poll cache changes only after an acknowledged matching save", () => {
  for (const requested of [true, false]) {
    for (const result of [false, undefined, { ok: false }, { ok: true, value: !requested }]) {
      let calls = 0;
      assert.equal(
        persistedToggleValue(!requested, requested, result, () => { calls += 1; }),
        !requested,
      );
      assert.equal(calls, 0);
    }
    for (const result of [true, { ok: true, value: requested }]) {
      const saved = [];
      assert.equal(
        persistedToggleValue(!requested, requested, result, (value) => saved.push(value)),
        requested,
      );
      assert.deepEqual(saved, [requested]);
    }
  }
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
   * The sweep, and the only three things it lets through. Prose has spaces
   * and identifiers do not, so any literal with both a space and a dash is
   * prose unless it is one of: a fragment of markup, a line a person copies
   * verbatim into a terminal or a browser, or SVG path geometry. Everything
   * else is a sentence and a sentence never gets a dash here.
   */
  let source = read("first-run.js").replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = [...source.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu)].map(
    (match) => match[0].slice(1, -1),
  );
  assert.ok(literals.length > 100);
  const allowed = new Set(INSTALL_LINES);
  for (const value of literals) {
    if (!value.includes(" ") || !DASH.test(value)) continue;
    const markup = value.includes("<") || value.includes(">");
    const geometry = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/u.test(value);
    assert.ok(
      markup || geometry || allowed.has(value) || value.startsWith("http"),
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
  assert.match(text, /Create your account/u);
  assert.match(text, /Connect your tools/u);
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
  /* The first run step borrows the sheet's body rather than raising the sheet. */
  assert.match(app, /mountSignIn,\s*unmountSignIn,/u);
  /* Signing in is announced, so first run can finish without owning a form. */
  assert.match(app, /openlimiter:signed-in/u);
});

test("a session arriving moves the setup on rather than ending it", () => {
  /* The account is step one now. Somebody who signs in has two steps left,
     so the arrival takes them to the tools instead of closing the screen on
     a machine nothing has been read from yet. */
  const source = read("first-run.js");
  assert.match(
    source,
    /openlimiter:signed-in[\s\S]*?if \(screen\.dataset\.step !== "account"\) return;\s*void showConnect\(\);/u,
  );
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

test("shows the two SmartScreen actions for an unsigned Windows release", () => {
  assert.deepEqual(launchNotice("Win32"), {
    title: "Unsigned Windows build",
    detail: "SmartScreen: choose More info, then Run anyway.",
  });
});

test("names the Gatekeeper gesture for the unsigned macOS release", () => {
  assert.deepEqual(launchNotice("MacIntel"), {
    title: "Unsigned macOS build",
    detail:
      "Gatekeeper: control click OpenLimiter in Applications, choose Open, then Open again.",
  });
});

test("no longer claims a macOS release is coming", () => {
  /* The unsigned universal app and dmg exist, so the journey names the
     Gatekeeper action rather than a download that does not exist. */
  assert.deepEqual(launchNotice("MacIntel"), {
    title: "Unsigned macOS build",
    detail:
      "Gatekeeper: control click OpenLimiter in Applications, choose Open, then Open again.",
  });
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
  const start = css.indexOf("/* --------------------------------------------- the three step first run */");
  assert.ok(start > 0);
  const block = css.slice(start);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/u.test(block), false);
  assert.equal(/rgb\(|hsl\(/u.test(block), false);
  for (const radius of block.matchAll(/border-radius: ([^;]+);/gu)) {
    assert.match(radius[1], /var\(--ol-radius-/u);
  }
});

/* What the head probe in index.html decides before any script runs. */
function headProbe(harness) {
  const configured = JSON.parse(harness.values.get("openlimiter-configured-providers-v1") ?? "[]");
  harness.doc.documentElement.dataset.firstRun =
    harness.values.get("openlimiter-first-run-complete-v1") === "complete" && configured.length > 0
      ? "complete"
      : "pending";
}

const never = () => new Promise(() => {});

test("a finished first run stays painted while the account answer never comes", async () => {
  const harness = firstRunDom(true);
  installFirstRunGlobals(harness);
  headProbe(harness);
  let completions = 0;
  initFirstRun({
    accountStatus: never,
    claudePollEnabled: async () => ({ state: "enabled", enabled: true }),
    onContinue: () => { completions += 1; },
    platform: "Linux",
  });
  assert.equal(harness.doc.documentElement.dataset.firstRun, "complete", "the head probe was overwritten");
  assert.equal(harness.screen.dataset.step, undefined, "no step was asked of a finished install");
  await waitFor(() => harness.screen.hidden === true, "first run did not get out of the way");
  assert.equal(harness.doc.documentElement.dataset.firstRun, "complete");
  assert.equal(completions, 0, "nothing was asked, so nothing continued");
});

test("a new person sees the account step at once, checking, while the account request stalls", () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  headProbe(harness);
  initFirstRun({
    accountStatus: never,
    claudePollEnabled: never,
    detectProviders: never,
    platform: "Linux",
  });
  assert.equal(harness.doc.documentElement.dataset.firstRun, "pending");
  assert.equal(harness.screen.dataset.step, "account");
  assert.equal(harness.account.hidden, false);
  assert.equal(harness.way.textContent, "Checking your sign in...");
});

test("the one time Claude consent shows pending over Home, then completes", async () => {
  const harness = firstRunDom(true);
  installFirstRunGlobals(harness);
  headProbe(harness);
  initFirstRun({
    accountStatus: never,
    claudePollEnabled: async () => ({ state: "missing", enabled: false }),
    setClaudePoll: async (enabled) => ({ ok: true, value: enabled }),
    platform: "Linux",
  });
  assert.equal(harness.doc.documentElement.dataset.firstRun, "complete", "Home paints first");
  await waitFor(() => harness.consent.hidden === false, "the consent did not appear");
  assert.equal(harness.doc.documentElement.dataset.firstRun, "pending", "the consent was hidden behind Home");
  assert.equal(harness.screen.hidden, false);
  await harness.doc.byId["claude-poll-consent-decline"].fire("click");
  await waitFor(() => harness.screen.hidden === true, "the consent did not finish");
  assert.equal(harness.doc.documentElement.dataset.firstRun, "complete");
});

test("a late signed out answer never sends a person back to Account after Create account later", async () => {
  const harness = firstRunDom(false);
  installFirstRunGlobals(harness);
  headProbe(harness);
  let answer;
  initFirstRun({
    accountStatus: () => new Promise((resolve) => { answer = resolve; }),
    isSignedIn: () => false,
    claudePollEnabled: async () => ({ state: "missing", enabled: false }),
    detectProviders: async () => ({ ok: true, value: { providers: [] } }),
    platform: "Linux",
  });
  assert.equal(harness.screen.dataset.step, "account");
  await harness.doc.byId["first-run-later"].fire("click");
  await waitFor(() => harness.screen.dataset.step === "connect", "Create account later did not move on");
  answer({ ok: true, value: null });
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
  assert.equal(harness.screen.dataset.step, "connect", "the late answer restarted onboarding");
  assert.equal(harness.account.hidden, true);
});

test("a signed in answer moves the account step still showing on to Connect", async () => {
  const signedIn = firstRunDom(false);
  installFirstRunGlobals(signedIn);
  headProbe(signedIn);
  let answer;
  let session = false;
  initFirstRun({
    accountStatus: () => new Promise((resolve) => { answer = resolve; }),
    isSignedIn: () => session,
    claudePollEnabled: async () => ({ state: "missing", enabled: false }),
    detectProviders: async () => ({ ok: true, value: { providers: [] } }),
    platform: "Linux",
  });
  assert.equal(signedIn.way.textContent, "Checking your sign in...");
  session = true;
  answer({ ok: true, value: null });
  await waitFor(() => signedIn.screen.dataset.step === "connect", "a signed in answer did not move on");
  assert.equal(signedIn.way.textContent, "", "the checking line cleared");
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
});

test("a returning person whose tools were all removed is asked again, never left on a blank screen", async () => {
  const returning = firstRunDom(false);
  returning.values.set("openlimiter-first-run-complete-v1", "complete");
  installFirstRunGlobals(returning);
  headProbe(returning);
  initFirstRun({
    accountStatus: async () => ({ ok: true, value: null }),
    claudePollEnabled: async () => ({ state: "enabled", enabled: true }),
    detectProviders: async () => ({ ok: true, value: { providers: [] } }),
    platform: "Linux",
  });
  await waitFor(() => returning.screen.dataset.step === "account", "a returning person was left on a blank screen");
  assert.equal(returning.doc.documentElement.dataset.firstRun, "pending");
});
