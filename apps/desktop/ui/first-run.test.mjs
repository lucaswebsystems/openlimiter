import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FIRST_RUN_STEPS, launchNotice, normalizeDetections } from "./first-run.js";

test("keeps an unconfigured Home to one line pointing at Configuration", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const start = html.indexOf('<section id="panel-meters"');
  const end = html.indexOf("</section>", start);
  const panel = html.slice(start, end);

  assert.equal((panel.match(/class="empty-line/g) ?? []).length, 1);
  assert.match(panel, />No providers configured\. Open Configuration\.<\/button>/u);

  /*
   * Home carries the live meter, the stale strip and the failure alerts now,
   * and each of those is prose. The guarantee this test exists for is not
   * "Home has no paragraph", it is "an unconfigured Home is one line", so
   * every paragraph on the panel has to start hidden and be revealed only by
   * something the window can actually prove. A paragraph that ships visible
   * would be back to explaining an empty screen at someone.
   */
  for (const paragraph of panel.matchAll(/<p[^>]*>/gu)) {
    const tag = paragraph[0];
    const container = panel.slice(0, paragraph.index);
    const openedBlock = container.lastIndexOf("<div");
    const openedHidden =
      openedBlock >= 0 && /hidden/u.test(panel.slice(openedBlock, panel.indexOf(">", openedBlock)));
    assert.ok(
      /hidden/u.test(tag) || openedHidden,
      "a Home paragraph ships visible: " + tag,
    );
  }
});

test("reaches the providers before it ever mentions an account", () => {
  /* The wall is gone. It used to be the first thing a person met: no meter,
     no detection, nothing at all until they signed in, on a product whose
     whole promise is reading what is already on their own machine. Detection
     runs first now and the account is the last step. */
  const source = readFileSync(new URL("./first-run.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

  assert.deepEqual(FIRST_RUN_STEPS, ["agents", "account", "ready"]);
  assert.equal(html.includes('id="account-gate"'), false);
  assert.match(source, /await showSetup\(\)/u);
  /* Nothing gates showSetup on a session: the load path runs it whatever the
     account status came back as. */
  assert.match(
    source,
    /const result = await options\.accountStatus\(\)[\s\S]*await showSetup\(\)/u,
  );
  assert.equal(/gate\.hidden = false/u.test(source), false);
});

test("offers the account once, with the promised copy and a plain not now", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("./first-run.js", import.meta.url), "utf8");
  const start = html.indexOf('id="first-run-account"');
  const step = html.slice(start, html.indexOf("</section>", start));

  assert.match(step, /Sign in to see this on your phone and to unlock Pro/u);
  assert.match(step, /id="first-run-not-now"[^>]*>Not now</u);
  /* The step hosts the window's one sign in body, so the provider buttons and
     their marks are right here rather than behind a second dialog. */
  assert.match(step, /id="first-run-sign-in-mount"/u);
  assert.match(source, /options\.mountSignIn\(mount\)/u);
  /* Not now finishes first run outright rather than looping back, and the
     body goes back to the sheet on the way out. */
  assert.match(source, /#first-run-not-now"\)\?\.addEventListener\("click", finish\)/u);
  assert.match(source, /function finish\(\) \{[\s\S]*?options\.unmountSignIn\(\);[\s\S]*?completeFirstRun\(screen\)/u);
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

test("the account menu hides the switch and the log out while signed out", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /elements\.menuSignIn\.hidden = signedIn/u);
  assert.match(app, /elements\.menuSignedIn\.hidden = !signedIn/u);
  assert.match(app, /elements\.menuLogout\.hidden = !signedIn/u);
});

test("the toggle says that signing in is what turns sync on", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /Signing in turns this on\. Only percentages leave this device\./u);
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
  /* The unsigned universal app and dmg exist. A first run screen telling a
     person on macOS that there is no download, while they are running the
     download, is the one sentence on this screen that cannot be true. */
  const source = readFileSync(new URL("./first-run.js", import.meta.url), "utf8");
  assert.equal(source.includes("coming soon"), false);
  assert.equal(source.includes("No public download"), false);
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
