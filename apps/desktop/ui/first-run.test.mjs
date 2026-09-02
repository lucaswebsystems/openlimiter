import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { launchNotice, normalizeDetections } from "./first-run.js";

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

test("keeps the account gate mandatory before provider setup", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("./first-run.js", import.meta.url), "utf8");

  assert.match(html, /id="account-google"[\s\S]*Continue with Google/u);
  assert.match(html, /id="account-github"[\s\S]*Continue with GitHub/u);
  assert.match(html, /id="account-email-form"[\s\S]*Create account/u);
  assert.equal(/skip|continue without|not now/iu.test(html.slice(
    html.indexOf('id="account-gate"'),
    html.indexOf('id="first-run-setup"'),
  )), false);
  assert.match(
    source,
    /await options\.accountStatus\(\)[\s\S]*signedIn !== true[\s\S]*gate\.hidden = false[\s\S]*setup\.hidden = true/u,
  );
});

test("lets a cached signed in session continue while the backend is offline", () => {
  const source = readFileSync(new URL("./first-run.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

  assert.match(source, /result\.value\?\.signedIn !== true/u);
  assert.equal(source.includes("backendReachable"), false);
  assert.match(app, /status\.signedIn && status\.backendReachable === false/u);
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
