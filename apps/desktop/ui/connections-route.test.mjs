import assert from "node:assert/strict";
import test from "node:test";
import { fakeDocument } from "./test-dom.mjs";

/*
 * A row's step through the real routing: the real connections module and the
 * real backend adapter, with only the native bridge and the document faked.
 * The adapter binds the bridge when it loads, so the fake exists before the
 * modules are imported.
 */
const calls = [];
const opened = [];
let records = [];
let runtimeVersion = "2.1.4";
// Commands the next calls reject, with the failure kind native code sends.
const refusing = new Map();
const storage = new Map();
globalThis.window = {
  __TAURI__: { core: { invoke: async (command, args) => {
    calls.push([command, args]);
    if (refusing.has(command)) throw { kind: refusing.get(command) };
    if (command === "list_detected_providers") return { providers: [] };
    if (command === "repair_codex_connection") return { kind: "cache_committed", connection_id: args.input.connection_id };
    if (command === "list_connections") return records;
    if (command === "terminal_runtime_status") return { version: runtimeVersion, app_version: "2.1.5" };
    if (command === "disabled_providers") return [];
    if (command === "connect_provider") {
      records = [...records, { id: "c-" + String(records.length + 1), provider_id: args.input.provider_id, status: "READY_TO_ENABLE" }];
      return records.at(-1).id;
    }
    if (command === "test_provider") return { kind: "tested", connection_id: args.input.connection_id };
    if (command === "refresh_provider") return { kind: "cache_committed", connection_id: args.input.connection_id };
    if (command === "detect_local_tools") return { claude_settings_present: true, statusline_wired: false };
    if (command === "claude_connect_preflight") return { kind: "ready", cli_path: "openlimiter" };
    return null;
  } } },
  open: (...args) => opened.push(args),
  dispatchEvent: () => true,
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
  setTimeout: (callback) => callback(),
};
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
globalThis.document = fakeDocument(["claude-card", "claude-body", "claude-note", "antigravity-add", "antigravity-body", "antigravity-note", "opencode-add"]);
const { catalogueModel, checkTool, chooseTool, connectTool, initConnections, refreshConnection, saveOpenrouterKey } = await import("./dist/connections.js");

const settle = () => new Promise((resolve) => setImmediate(resolve));
let meters = 0;
initConnections({ onMetersChanged: () => { meters += 1; }, hasFreshLocalClaude: () => false });
await settle();

const commands = () => calls.map(([command]) => command);

test("Connect for Codex imports its own login in one press and proves it reads", async () => {
  calls.length = 0;
  assert.equal(await connectTool("CODEX"), true);
  const connect = calls.find(([command]) => command === "connect_provider")[1].input;
  assert.deepEqual([connect.provider_id, connect.credential_kind, connect.account_alias], ["codex", "codex_session", "default"]);
  assert.ok(commands().includes("test_provider"));
  assert.deepEqual(opened, []);
});

test("Connect for a refused Codex record repairs that record in place, never adding or removing one", async () => {
  records = [{ id: "cx-1", provider_id: "codex", status: "NEEDS_AUTH" }];
  await initConnections({ onMetersChanged: () => { meters += 1; }, hasFreshLocalClaude: () => false });
  await settle();
  try {
    calls.length = 0;
    const before = meters;
    assert.equal(await connectTool("CODEX"), true);
    assert.deepEqual(calls.find(([command]) => command === "repair_codex_connection")[1], { input: { connection_id: "cx-1" } });
    assert.ok(!commands().some((command) => command === "connect_provider" || command === "disconnect_provider"));
    assert.ok(meters > before, "the screen rereads");
    // Another account's login is refused with its own sentence, shown in the row.
    refusing.set("repair_codex_connection", "codex_other_account");
    assert.match(await connectTool("CODEX"), /^This Codex login belongs to another account\./u);
  } finally {
    refusing.clear();
    records = [];
    await initConnections({ onMetersChanged: () => { meters += 1; }, hasFreshLocalClaude: () => false });
    await settle();
  }
});

test("a Connect that did not work says why in its own words", async () => {
  refusing.set("connect_provider", "codex_cli_not_found");
  try {
    assert.match(await connectTool("CODEX"), /^Codex CLI not found\. Put it on PATH, then check again\./u);
  } finally {
    refusing.clear();
  }
});

test("Connect for Claude Code, Antigravity and OpenCode opens that tool's setup under the list, one at a time", async () => {
  for (const [code, id] of [["CLAUDE", "claude-card"], ["ANTIGRAVITY", "antigravity-add"], ["OPENCODE", "opencode-add"]]) {
    assert.equal(await connectTool(code), true, code);
    for (const other of ["claude-card", "antigravity-add", "opencode-add"]) {
      assert.equal(document.getElementById(other).hidden, other !== id, `${code} ${other}`);
    }
  }
  await connectTool("ANTIGRAVITY");
  assert.match(document.getElementById("antigravity-body").textContent, /openlimiter terminal install antigravity/u);
  assert.match(document.getElementById("antigravity-body").textContent, /Installed terminal runtime 2\.1\.4\./u);
  assert.equal(calls.some(([command, input]) => command === "connect_provider" && input?.input?.provider_id === "antigravity"), false);
  // Claude Code's setup reads the preflight and shows the block with Copy and Verify.
  await connectTool("CLAUDE");
  const body = document.getElementById("claude-body");
  assert.match(body.textContent, /Add this to your Claude Code settings, then Verify\./u);
  assert.match(body.textContent, /"command": "openlimiter statusline"/u);
  assert.match(body.textContent, /npx -y openlimiter terminal install claude/u);
  assert.deepEqual(body.all((node) => node.localName === "button").map((button) => button.textContent), ["Copy", "Verify"]);
  const runtimeReads = calls.filter(([command]) => command === "terminal_runtime_status").length;
  runtimeVersion = "2.1.6";
  await body.all((node) => node.localName === "button" && node.textContent === "Verify")[0].fire("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([command]) => command === "terminal_runtime_status").length, runtimeReads + 1);
  assert.match(document.getElementById("claude-body").textContent, /Installed terminal runtime 2\.1\.6\./u);
  assert.match(document.getElementById("claude-body").textContent, /newer than OpenLimiter/u);
});

test("Check again for a tool whose sign in lives in the tool scans and reads once, never opening a web page", async () => {
  calls.length = 0;
  const before = meters;
  await checkTool("GROK");
  assert.ok(commands().includes("rescan_detected_providers"), "it asks native code to look again");
  assert.deepEqual(calls.find(([command]) => command === "refresh_home")[1], { providers: ["grok"] });
  assert.ok(!commands().includes("refresh_provider"), "nothing stored, nothing to refresh");
  assert.ok(meters > before, "the screen rereads");
  assert.deepEqual(opened, []);
});

test("Check again for a tool with a stored connection reads that connection now", async () => {
  records = [{ id: "or-1", provider_id: "openrouter", status: "CONNECTED" }];
  await initConnections({ onMetersChanged: () => {}, hasFreshLocalClaude: () => false });
  await settle();
  calls.length = 0;
  assert.equal(await checkTool("OPENROUTER"), true);
  assert.deepEqual(calls.find(([command]) => command === "refresh_provider")[1], { input: { connection_id: "or-1" } });
});

test("an OpenRouter key row's refresh reads its own connection and no other account", async () => {
  records = [
    { id: "or-a", provider_id: "openrouter", status: "CONNECTED" },
    { id: "or-b", provider_id: "openrouter", status: "CONNECTED" },
  ];
  await initConnections({ onMetersChanged: () => {}, hasFreshLocalClaude: () => false });
  await settle();
  calls.length = 0;
  assert.deepEqual(await refreshConnection("or-b"), { ok: true });
  assert.deepEqual(calls.filter(([command]) => command === "refresh_provider").map(([, args]) => args.input.connection_id), ["or-b"]);
});

test("OpenRouter's key is its quota connection, never an API spend source", async () => {
  records = [];
  calls.length = 0;
  assert.deepEqual(await saveOpenrouterKey("sk-or-example"), { ok: true });
  const connect = calls.find(([command]) => command === "connect_provider")[1].input;
  assert.deepEqual([connect.provider_id, connect.credential_kind, connect.secret], ["openrouter", "openrouter_inference_key", "sk-or-example"]);
  assert.ok(!commands().some((command) => command.startsWith("api_spend")));
});

test("the catalogue holds every tool not in play with its row's step; choosing a switched off one turns it back on", async () => {
  const model = catalogueModel(["CLAUDE", "ANTIGRAVITY", "OPENROUTER"]);
  assert.deepEqual(model.map((tool) => [tool.code, tool.action.label]), [
    ["CODEX", "Connect"], ["GEMINI_CLI", "Check again"], ["GROK", "Check again"],
    ["KIMI", "Check again"], ["OPENCODE", "Connect"], ["CURSOR", "Check again"],
  ]);
  assert.ok(model.every((tool) => tool.windows.length === 0));
  storage.set("openlimiter-removed-providers-v1", JSON.stringify(["KIMI"]));
  calls.length = 0;
  await chooseTool("KIMI", "check");
  assert.deepEqual(calls.findLast(([command]) => command === "set_provider_enabled")[1], { provider: "kimi", enabled: true });
  assert.ok(JSON.parse(storage.get("openlimiter-configured-providers-v1")).includes("KIMI"));
  assert.ok(commands().includes("rescan_detected_providers"));
});
