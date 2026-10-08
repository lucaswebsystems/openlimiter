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
const copied = [];
let records = [];
// This build's version, the one Settings shows and every pinned command names.
const { version: BUILD } = await import("./dist/whats-new-data.js");
const OLDER = "1.0.0";
const NEWER = "99.0.0";
const CLAUDE_COMMANDS = [`npx -y openlimiter@${BUILD} terminal install claude`, `npx -y openlimiter@${BUILD} hooks install claude`];
let runtimeVersion = OLDER;
let preflight = { kind: "ready", cli_path: "openlimiter" };
// Commands the next calls reject, with the failure kind native code sends.
const refusing = new Map();
const storage = new Map();
globalThis.window = {
  navigator: { clipboard: { writeText: async (value) => { copied.push(value); } } },
  __TAURI__: { core: { invoke: async (command, args) => {
    calls.push([command, args]);
    if (refusing.has(command)) throw { kind: refusing.get(command) };
    if (command === "list_detected_providers") return { providers: [] };
    if (command === "repair_codex_connection") return { kind: "cache_committed", connection_id: args.input.connection_id };
    if (command === "list_connections") return records;
    // The stamp read's own app version, which no command may name.
    if (command === "terminal_runtime_status") return { version: runtimeVersion, app_version: "9.9.9" };
    if (command === "disabled_providers") return [];
    if (command === "connect_provider") {
      records = [...records, { id: "c-" + String(records.length + 1), provider_id: args.input.provider_id, status: "READY_TO_ENABLE" }];
      return records.at(-1).id;
    }
    if (command === "test_provider") return { kind: "tested", connection_id: args.input.connection_id };
    if (command === "refresh_provider") return { kind: "cache_committed", connection_id: args.input.connection_id };
    if (command === "detect_local_tools") return { claude_settings_present: true, statusline_wired: false };
    if (command === "claude_connect_preflight") return preflight;
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
const { catalogueModel, checkTool, chooseTool, claudeRuntimeNotice, connectTool, initConnections, refreshConnection, saveOpenrouterKey } = await import("./dist/connections.js");

const settle = () => new Promise((resolve) => setImmediate(resolve));
let meters = 0;
initConnections({ onMetersChanged: () => { meters += 1; }, hasFreshLocalClaude: () => false });
await settle();

const commands = () => calls.map(([command]) => command);
const shownCommands = (node) => node.all((child) => child.classList?.contains("q-command-box"))
  .map((box) => box.all((child) => child.localName === "pre")[0].textContent);
// Press every Copy in a panel; each must copy exactly the command beside it.
async function copiedCommands(node) {
  copied.length = 0;
  for (const box of node.all((child) => child.classList?.contains("q-command-box"))) {
    await box.all((child) => child.localName === "button")[0].fire("click");
    assert.equal(copied.at(-1), box.all((child) => child.localName === "pre")[0].textContent);
  }
  return [...copied];
}

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
  const antigravityBody = document.getElementById("antigravity-body");
  assert.ok(antigravityBody.textContent.includes(`Installed terminal runtime ${OLDER}.`));
  assert.deepEqual(await copiedCommands(antigravityBody), [`npx -y openlimiter@${BUILD} terminal install antigravity`]);
  assert.equal(calls.some(([command, input]) => command === "connect_provider" && input?.input?.provider_id === "antigravity"), false);
  // Claude Code's setup shows what wires both the status line and the prompt hook:
  // the two pinned commands in order, each with its own Copy, then Verify.
  await connectTool("CLAUDE");
  const body = document.getElementById("claude-body");
  assert.match(body.textContent, /Run these two commands in order, then Verify\./u);
  assert.doesNotMatch(body.textContent, /openlimiter (?:statusline|hook)|npm install|will be replaced/u);
  assert.deepEqual(body.all((node) => node.localName === "button").map((button) => button.textContent), ["Copy", "Copy", "Verify"]);
  assert.deepEqual(await copiedCommands(body), CLAUDE_COMMANDS);
  // Without a global command or a runtime the panel offers the same two, never a bare one.
  preflight = { kind: "cli_missing" };
  try {
    await connectTool("CLAUDE");
    assert.match(body.textContent, /Install the OpenLimiter command first\./u);
    assert.doesNotMatch(body.textContent, /npm install/u);
    assert.deepEqual(shownCommands(body), CLAUDE_COMMANDS);
  } finally {
    preflight = { kind: "ready", cli_path: "openlimiter" };
    await connectTool("CLAUDE");
  }
  const runtimeReads = calls.filter(([command]) => command === "terminal_runtime_status").length;
  runtimeVersion = NEWER;
  await body.all((node) => node.localName === "button" && node.textContent === "Verify")[0].fire("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([command]) => command === "terminal_runtime_status").length, runtimeReads + 1);
  assert.ok(document.getElementById("claude-body").textContent.includes(`Installed terminal runtime ${NEWER}.`));
  assert.match(document.getElementById("claude-body").textContent, /newer than OpenLimiter/u);
  runtimeVersion = OLDER;
});

test("a status line of the person's own is named as replaced, above the commands", async () => {
  const warning = "Your own status line will be replaced. The installer keeps a backup of it.";
  const body = document.getElementById("claude-body");
  for (const kind of ["guided_manual", "cli_missing"]) {
    preflight = { kind, foreign_status_line: true };
    try {
      await connectTool("CLAUDE");
      const order = body.children.map((node) => node.className === "q-command-box" ? "command" : node.textContent);
      assert.deepEqual(order.slice(order.indexOf(warning), order.indexOf(warning) + 3), [warning, "command", "command"], kind);
    } finally {
      preflight = { kind: "ready", cli_path: "openlimiter" };
      await connectTool("CLAUDE");
    }
  }
  assert.ok(!body.textContent.includes(warning), "no warning without a status line of the person's own");
});

test("every pinned command names this build even when the runtime stamp cannot be read", async () => {
  refusing.set("terminal_runtime_status", "config_refused");
  try {
    await initConnections({ onMetersChanged: () => { meters += 1; }, hasFreshLocalClaude: () => false });
    await settle();
    await connectTool("ANTIGRAVITY");
    assert.deepEqual(shownCommands(document.getElementById("antigravity-body")), [`npx -y openlimiter@${BUILD} terminal install antigravity`]);
    await connectTool("CLAUDE");
    assert.deepEqual(shownCommands(document.getElementById("claude-body")), CLAUDE_COMMANDS);
  } finally {
    refusing.clear();
    await initConnections({ onMetersChanged: () => { meters += 1; }, hasFreshLocalClaude: () => false });
    await settle();
  }
});

test("the Usage tab's Claude card asks for the runtime update only while the runtime is older than the app", async () => {
  const noticeWith = async (version) => {
    runtimeVersion = version;
    await initConnections({ onMetersChanged: () => { meters += 1; }, hasFreshLocalClaude: () => false });
    await settle();
    return claudeRuntimeNotice();
  };
  try {
    const older = await noticeWith(OLDER);
    assert.match(older.textContent, /^Weekly limits need your terminal status line updated\./u);
    assert.deepEqual(await copiedCommands(older), [`npx -y openlimiter@${BUILD} terminal install claude`]);
    assert.equal(await noticeWith(BUILD), null, "the same version shows nothing");
    assert.equal(await noticeWith(null), null, "no runtime installed shows nothing");
    assert.equal(await noticeWith(NEWER), null, "a newer runtime shows nothing");
  } finally {
    runtimeVersion = OLDER;
  }
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
