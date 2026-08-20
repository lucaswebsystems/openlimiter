import assert from "node:assert/strict";
import test from "node:test";

import { launchNotice, normalizeDetections } from "./first-run.js";

test("shows the two SmartScreen actions for an unsigned Windows release", () => {
  assert.deepEqual(launchNotice("Win32"), {
    title: "Unsigned Windows build",
    detail: "SmartScreen: choose More info, then Run anyway.",
  });
});

test("keeps an unsigned macOS release unavailable", () => {
  assert.deepEqual(launchNotice("MacIntel"), {
    title: "macOS release coming soon",
    detail: "No public download is available yet.",
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
  assert.equal(result.providers.length, 9);
  assert.equal(result.providers.every((entry) => entry.state === "unavailable"), true);
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
  assert.equal(result.providers.length, 9);
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
  assert.equal(result.providers.length, 9);
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
