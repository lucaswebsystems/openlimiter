import assert from "node:assert/strict";
import test from "node:test";

test("native removals and D1 removals are reconciled before detection and explicit switching persists natively", async () => {
  const previous = globalThis.window;
  const previousEvent = globalThis.CustomEvent;
  const values = new Map([
    ["openlimiter-configured-providers-v1", '["CLAUDE"]'],
    ["openlimiter-removed-providers-v1", '["CODEX"]'],
  ]);
  const disabled = new Set(["claude"]);
  const calls = [];
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  globalThis.window = {
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    dispatchEvent() {},
    __TAURI__: { core: { async invoke(command, args) {
      calls.push([command, args]);
      if (command === "disabled_providers") return [...disabled];
      if (command === "set_provider_enabled") {
        if (args.enabled) disabled.delete(args.provider);
        else disabled.add(args.provider);
        return null;
      }
      if (command === "list_detected_providers") {
        assert.deepEqual([...disabled].sort(), ["claude", "codex"]);
        return { providers: [{ provider_id: "codex", state: "present" }, { provider_id: "grok", state: "present" }] };
      }
      throw new Error("Unexpected command");
    } } },
  };
  try {
    const backend = await import("./backend.js?switch-contract");
    assert.equal((await backend.listDetectedProviders()).ok, true);
    assert.deepEqual(JSON.parse(values.get("openlimiter-configured-providers-v1")), ["GROK"]);
    assert.deepEqual(JSON.parse(values.get("openlimiter-removed-providers-v1")).sort(), ["CLAUDE", "CODEX"]);
    assert.equal((await backend.setProviderEnabled("gemini-cli", false)).ok, true);
    assert.deepEqual(calls.at(-1), ["set_provider_enabled", { provider: "gemini_cli", enabled: false }]);
    assert.equal((await backend.setProviderEnabled("CODEX", true)).ok, true);
    assert.equal(disabled.has("codex"), false);
    assert.equal(calls.filter(([command]) => command === "disabled_providers").length, 1);
  } finally {
    globalThis.window = previous;
    globalThis.CustomEvent = previousEvent;
  }
});
