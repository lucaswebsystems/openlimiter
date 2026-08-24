import assert from "node:assert/strict";
import test from "node:test";

const values = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  },
  dispatchEvent() {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type) {
    this.type = type;
  }
};

const {
  CONFIGURED_PROVIDERS_STORAGE_KEY,
  configureProvider,
  isProviderConfigured,
  readConfiguredProviders,
  unconfigureProvider,
} = await import("./configured-providers.js");

test("stores only explicitly supported providers", () => {
  values.clear();
  configureProvider("codex");
  configureProvider("gemini-cli");
  configureProvider("manual");
  assert.deepEqual(readConfiguredProviders(), ["CODEX", "GEMINI_CLI"]);
  assert.equal(isProviderConfigured("CODEX"), true);
  assert.equal(isProviderConfigured("MANUAL"), false);
  assert.equal(values.has(CONFIGURED_PROVIDERS_STORAGE_KEY), true);
});

test("removes a configured provider without affecting the others", () => {
  values.clear();
  configureProvider("CLAUDE");
  configureProvider("CODEX");
  unconfigureProvider("claude");
  assert.deepEqual(readConfiguredProviders(), ["CODEX"]);
});
