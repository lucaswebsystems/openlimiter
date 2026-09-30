import assert from "node:assert/strict";
import test from "node:test";
import { PENDING_PROVIDER_CODES } from "../../../packages/core/dist/index.js";
import { messyFixtures } from "./messy-fixtures.mjs";
import { fakeDocument } from "./test-dom.mjs";

/*
 * Needs attention through the real routing: the real Connections module, the
 * real backend adapter and the real renderer, with only the native bridge and
 * the document faked. The adapter binds the bridge when it loads, so the fake
 * exists before the modules are imported.
 */
const calls = [];
const opened = [];
globalThis.window = {
  __TAURI__: { core: { invoke: async (command, args) => {
    calls.push([command, args]);
    return command === "list_detected_providers" ? { providers: [] } : null;
  } } },
  open: (...args) => opened.push(args),
  setTimeout: (callback) => callback(),
};
globalThis.document = fakeDocument(["needs-attention", "attention-rows", "attention-count", "connections-count",
  "tab-connections", "connected", "connected-rows", "add-tool", "tool-catalogue"]);
const { attentionRoute, keyProviders, showConnections } = await import("./dist/connections.js");
const { attentionFlags } = await import("./dist/readings.js");

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const fixtures = messyFixtures(NOW);
const attention = attentionFlags(fixtures.projected.flags, fixtures.projected.snapshots);
const rowFor = (provider) => document.getElementById("attention-rows").all((node) => node.dataset.provider === provider && "flagRow" in node.dataset)[0];
const buttonOf = (row) => row.all((node) => node.localName === "button")[0] ?? null;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a provider with its own connect flow here keeps it; every other one signs in in its tool", () => {
  assert.equal(attentionRoute({ provider: "CODEX", fixKind: "sign_in" }), "connect");
  assert.equal(attentionRoute({ provider: "OPENCODE", fixKind: "reconnect" }), "connect");
  assert.equal(attentionRoute({ provider: "ANTIGRAVITY", fixKind: "reconnect" }), "connect");
  for (const provider of ["GROK", "KIMI", "GEMINI_CLI", "CURSOR"]) {
    assert.equal(attentionRoute({ provider, fixKind: "sign_in" }), "rescan", provider);
    assert.equal(attentionRoute({ provider, fixKind: "reconnect" }), "rescan", provider);
  }
  assert.equal(attentionRoute({ provider: "KIMI", fixKind: "open_app" }), "rescan");
  assert.equal(attentionRoute({ provider: "GEMINI_CLI", fixKind: "unsupported" }), "none");
});

test("every key provider switched on shares the one key editor, from its registry entry alone", () => {
  // Only a provider core has switched on too, with the credential kind it reads.
  for (const provider of keyProviders()) {
    assert.equal(PENDING_PROVIDER_CODES.includes(provider.connectorId.toUpperCase()), false, provider.connectorId);
    assert.match(provider.credentialKind, /^[a-z][a-z_]*$/u);
  }
  const spec = (connectorId, access, reader = "implemented", credentialKind = connectorId + "_key") => ({
    directory: { connectorId, label: connectorId.toUpperCase(), access }, support: { reader },
    collection: { readers: [{ credentialKind }] },
  });
  assert.deepEqual(keyProviders({ providers: [
    spec("synthetic", "key"), spec("amp", "automatic"), spec("zai", "key", "absent"), spec("openrouter", "key"),
  ] }), [{ connectorId: "synthetic", name: "SYNTHETIC", credentialKind: "synthetic_key" }]);
});

test("a pending provider has no editor here until its lane switches it on", () => {
  for (const provider of ["SYNTHETIC", "ZAI", "MINIMAX"].filter((code) => PENDING_PROVIDER_CODES.includes(code))) {
    assert.equal(attentionRoute({ provider, fixKind: "sign_in" }), "rescan", provider);
    assert.equal(attentionRoute({ provider, fixKind: "reconnect" }), "rescan", provider);
  }
});

test("Sign in for a tool with no flow here says so and checks again, never opening a web page", async () => {
  showConnections({ attention, connected: [{ code: "CLAUDE", name: "Claude Code", access: "automatic" }] });
  assert.equal(document.getElementById("tool-catalogue").hidden, true, "anything connected folds the catalogue");
  const grok = rowFor("GROK");
  assert.match(grok.textContent, /Sign in to Grok \(xAI\) on this computer, then check again\./u);
  assert.equal(buttonOf(grok).textContent, "Check again");
  calls.length = 0;
  await buttonOf(grok).fire("click");
  await settle();
  assert.ok(calls.some(([command]) => command === "rescan_detected_providers"), "it asks native code to look again");
  assert.deepEqual(opened, [], "no documentation page stands in for a sign in");
  assert.equal(grok.all((node) => node.className === "q-fstatus")[0].textContent, "");
});

test("Reconnect for a provider with an editor here opens it, in the catalogue", async () => {
  const opencode = rowFor("OPENCODE");
  assert.equal(buttonOf(opencode).textContent, "Reconnect");
  calls.length = 0;
  await buttonOf(opencode).fire("click");
  assert.equal(document.getElementById("tool-catalogue").hidden, false, "the editor lives in the catalogue, so it opens");
  assert.equal(document.getElementById("add-tool").getAttribute("aria-expanded"), "true");
  assert.ok(!calls.some(([command]) => command === "rescan_detected_providers"));
  assert.deepEqual(opened, []);
});

test("open app checks again, unsupported offers nothing, a switched off provider is absent", () => {
  assert.equal(buttonOf(rowFor("KIMI")).textContent, "Check again");
  assert.equal(buttonOf(rowFor("GEMINI_CLI")), null);
  assert.equal(rowFor("CURSOR"), undefined);
  assert.equal(document.getElementById("connections-count").textContent, "5");
  assert.ok(!calls.some(([command]) => command === "set_provider_enabled"));
});
