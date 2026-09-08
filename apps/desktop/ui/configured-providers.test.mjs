import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

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
  adoptDetectedProviders,
  readRemovedProviders,
  homeSelectionControl,
} = await import("./configured-providers.js");
const { homeProviders } = await import("./home-state.js");

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

test("detection adds signed in providers to Home and a removal survives repeated scans and stored readings", () => {
  values.clear();
  const detection = { providers: [{ provider_id: "codex", state: "present" }, { provider_id: "grok", state: "installed_logged_out" }] };
  adoptDetectedProviders(detection);
  assert.deepEqual(readConfiguredProviders(), ["CODEX"]);
  assert.deepEqual(homeProviders(readConfiguredProviders(), detection, [], [], readRemovedProviders()), ["CODEX"]);
  const button = { addEventListener(type, listener) { this[type] = listener; } };
  let changed = 0;
  homeSelectionControl("CODEX", () => changed++, { createElement: () => button });
  assert.equal(button.textContent, "Remove from Home");
  button.click();
  for (let scan = 0; scan < 3; scan++) {
    adoptDetectedProviders(JSON.parse(JSON.stringify(detection)));
    assert.deepEqual(readConfiguredProviders(), []);
    assert.deepEqual(homeProviders([], detection, [{ provider: "CODEX" }], [{ provider: "CODEX" }], readRemovedProviders()), []);
  }
  assert.equal(button.textContent, "Add to Home");
  button.click();
  assert.deepEqual(readRemovedProviders(), []);
  assert.deepEqual(readConfiguredProviders(), ["CODEX"]);
  assert.equal(changed, 2);
  const catalogue = readFileSync(new URL("./connections.js", import.meta.url), "utf8");
  assert.match(catalogue, /rowData.stateLabel = selected \? "Added to Home" : "Removed from Home";\s*rowData.actionLabel = null;/u);
  assert.match(catalogue, /homeSelectionControl\(rowData.connectorId/u);
});
