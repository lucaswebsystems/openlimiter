import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initWhatsNew, WHATS_NEW_STORAGE_KEY, whatsNewForVersion as selectRelease } from "./whats-new.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../package.json"));
const WHATS_NEW_EN = JSON.parse(read("./whats-new.en.json"));
const whatsNewForVersion = (version) => selectRelease(version, WHATS_NEW_EN);

/* What each recent release says, word for word; the current version is one of them. */
const NOTES = {
  "2.1.0": [
    { key: "claude", text: "Claude now shows one number per bar, with the Claude bucket allowlist, clear status line captions and the Pro captions preset. Setup upgrades the runtime when needed." },
    { key: "desktop", text: "The desktop opens faster, its buttons work, and Codex setup can be found and repaired when needed. Usage, Connect Tools and Settings now share a responsive window." },
    { key: "phone", text: "The phone app can install to the Home Screen, follow its light or dark theme, keep the last bars when offline and show the Pro tab. OpenRouter now accepts a management key." },
    { key: "status", text: "The terminal line keeps the new captions, including 5h, 7d, fable7d, cx7d and ag5h. Money cells such as or $ keep their amounts." },
  ],
  "2.0.4": [
    { key: "codex", text: "Codex limits now use OpenAI's documented source. Your Codex sign in stays on your device." },
    { key: "claude", text: "Claude now shows Current session, Weekly, all models, Weekly, Fable and extra usage. Fable and extra usage are on after one notice, with switches in Settings and the terminal." },
    { key: "providers", text: "Antigravity can refresh from its CLI. OpenRouter, Grok, Moonshot, Kimi, OpenCode and Gemini now label their limits more clearly." },
    { key: "sync", text: "Unreadable readings never sync, and stale bars are flat grey." },
  ],
  "2.0.3": [
    { key: "screen", text: "Every tool and API key now fits on one screen." },
    { key: "tools", text: "Claude Code stays visible while idle. Antigravity shows again with a clear open button." },
    { key: "money", text: "Each API key shows its own amount. DeepSeek is included, and the terminal can show all six money cells." },
    { key: "pro", text: "Sign in works again, and Pro now unlocks trials, period end days, comps, devices and reconnects." },
    { key: "setup", text: "Terminal setup recovers after host edits. Phone setup includes install help and code entry." },
  ],
  "2.0.2": [
    { key: "edge", text: "One small tab on the left edge of your screen replaces the Rail. Hover it to see your limits and agents. On Linux Wayland the tray takes its place." },
    { key: "home", text: "Home shows the account you are signed in with now, one card per tool. Anything that cannot be measured waits on Connections with one fix." },
    { key: "statusline", text: "The terminal status line leaves out the folder and any provider that cannot be measured right now." },
  ],
  "2.0.1": [
    { key: "startup", text: "Fixes a freeze at startup on Windows." },
  ],
};

test("the current desktop version has a complete What's New entry", () => {
  const entry = whatsNewForVersion(manifest.version);
  assert.ok(entry, `Missing What's New for ${manifest.version}`);
  assert.equal(entry.versionLabel, `Version ${manifest.version}`);
  assert.ok(entry.heading.trim());
  assert.ok(entry.dismiss.trim());
  assert.deepEqual(entry.items, NOTES[manifest.version]);
});

test("the current notes stay short and earlier releases remain available", () => {
  for (const [version, items] of Object.entries(NOTES)) {
    const entry = whatsNewForVersion(version);
    assert.deepEqual(entry.items, items, version);
    for (const text of [entry.heading, ...items.map(({ text }) => text)]) {
      assert.ok(text.trim());
      assert.doesNotMatch(text, /[-\u2010-\u2015]/u);
    }
  }
  assert.equal(WHATS_NEW_EN.releases["2.1.0"].heading, "One number per bar");
  assert.equal(NOTES["2.1.0"].length, 4);
});

test("the 2.0.0 release notes remain available", () => {
  const entry = whatsNewForVersion("2.0.0");
  assert.deepEqual(entry.items.map(({ key }) => key), [
    "rail", "activity", "statusline", "cursor", "retry", "sessions", "spend",
  ]);
  assert.match(WHATS_NEW_EN.releases["2.0.0"].cursor, /Experimental/u);
});

function fixture({ seen, ready = true, storageFails = false, showFails = false } = {}) {
  const stored = new Map(seen ? [[WHATS_NEW_STORAGE_KEY, seen]] : []);
  let callback;
  let disconnected = false;
  class Element {
    children = [];
    listeners = {};
    attributes = {};
    constructor(tag) { this.tag = tag; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    showModal() {
      if (showFails) throw new Error("Cannot show dialog");
      this.open = true;
    }
    close() { this.open = false; this.listeners.close(); }
    remove() { this.removed = true; }
  }
  const doc = {
    documentElement: { dataset: { firstRun: ready ? "complete" : "pending" } },
    body: new Element("body"),
    createElement: (tag) => new Element(tag),
  };
  const options = {
    document: doc,
    storage: () => {
      if (storageFails) throw new Error("Storage refused");
      return { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
    },
    load: async () => ({ version: manifest.version, catalog: WHATS_NEW_EN }),
    observe: (fn) => {
      callback = fn;
      return { observe() {}, disconnect() { disconnected = true; } };
    },
  };
  return { doc, stored, options, notify: () => callback(), disconnected: () => disconnected };
}

test("an upgrade from 1.3.x with no release marker shows all notes once", async () => {
  const f = fixture();
  await initWhatsNew(f.options);
  const [dialog] = f.doc.body.children;
  assert.equal(dialog.open, true);
  assert.equal(dialog.attributes["aria-labelledby"], dialog.children[0].id);
  assert.equal(dialog.children[1].textContent, `Version ${manifest.version}`);
  assert.deepEqual(dialog.children[3].children.map((node) => node.textContent),
    whatsNewForVersion(manifest.version).items.map(({ text }) => text));
  assert.equal(f.stored.get(WHATS_NEW_STORAGE_KEY), manifest.version);
  dialog.children[4].listeners.click();
  assert.equal(dialog.removed, true);
  await initWhatsNew(f.options);
  assert.equal(f.doc.body.children.length, 1, "a restart does not repeat this release");
  assert.equal(f.disconnected(), true);
});

test("a previous release marker is advanced only after onboarding completes", async () => {
  const f = fixture({ seen: "2.0.0", ready: false });
  await initWhatsNew(f.options);
  assert.equal(f.doc.body.children.length, 0);
  assert.equal(f.stored.get(WHATS_NEW_STORAGE_KEY), "2.0.0");
  f.doc.documentElement.dataset.firstRun = "complete";
  f.notify();
  f.notify();
  assert.equal(f.doc.body.children.length, 1);
  assert.equal(f.stored.get(WHATS_NEW_STORAGE_KEY), manifest.version);
});

test("a seen release and a release without notes do not create a dialog", async () => {
  const seen = fixture({ seen: manifest.version });
  await initWhatsNew(seen.options);
  assert.equal(seen.doc.body.children.length, 0);
  const unknown = fixture();
  await initWhatsNew({ ...unknown.options, load: async () => ({ version: "999.0.0", catalog: WHATS_NEW_EN }) });
  assert.equal(unknown.doc.body.children.length, 0);
});

test("storage refusal does not block notes or repeat them in the same session", async () => {
  const f = fixture({ storageFails: true });
  await initWhatsNew(f.options);
  f.notify();
  assert.equal(f.doc.body.children.length, 1);
  assert.equal(f.doc.body.children[0].open, true);
});

test("a dialog that fails to open is never marked seen", async () => {
  const f = fixture({ showFails: true });
  await assert.rejects(initWhatsNew(f.options), /Cannot show dialog/);
  assert.equal(f.stored.has(WHATS_NEW_STORAGE_KEY), false);
  assert.equal(f.doc.body.children[0].removed, true);
});

test("the desktop entry point and assembler ship the release dialog and its catalog", () => {
  assert.match(read("./app.js"), /import \{ initWhatsNew(?:, openWhatsNew)? \} from "\.\/whats-new\.js"/);
  assert.match(read("./app.js"), /initWhatsNew\(\)/);
  assert.match(read("./index.html"), /href="\.\/whats-new\.css"/);
  const build = read("../scripts/build-ui.mjs");
  for (const file of ["whats-new.js", "whats-new.css", "whats-new.en.json", "whats-new-data.js"]) {
    assert.ok(build.includes(`"${file}"`), file);
  }
  assert.match(build, /Object\.hasOwn\(whatsNew\.releases, version\)/);
});

test("all desktop release manifests agree with the What's New version", () => {
  assert.equal(JSON.parse(read("../src-tauri/tauri.conf.json")).version, manifest.version);
  const crate = read("../src-tauri/Cargo.toml");
  assert.equal(crate.match(/^version = "([^"]+)"/mu)?.[1], manifest.version);
  const lock = read("../src-tauri/Cargo.lock");
  assert.equal(lock.match(/name = "openlimiter-desktop"\r?\nversion = "([^"]+)"/u)?.[1], manifest.version);
});

test("an unknown release never displays another version's What's New", () => {
  assert.equal(whatsNewForVersion("999.0.0"), null);
  assert.equal(whatsNewForVersion("constructor"), null);
});

test("workspace packages and client identities share the desktop release version", () => {
  for (const name of ["core", "connectors", "adapters", "cli", "ui"]) {
    const pkg = JSON.parse(read(`../../../packages/${name}/package.json`));
    assert.equal(pkg.version, manifest.version, name);
    for (const [dependency, range] of Object.entries(pkg.dependencies ?? {})) {
      if (dependency.startsWith("@openlimiter/")) {
        assert.ok(["workspace:*", `workspace:${manifest.version}`, manifest.version].includes(range), dependency);
      }
    }
  }
  for (const [path, constant] of [
    ["../../../packages/core/src/acquire/identity.ts", "ACQUISITION_CLIENT_VERSION"],
    ["../../../packages/cli/src/hub-sync.ts", "SYNC_CLIENT_VERSION"],
    ["../../web/lib/site.ts", "CURRENT_VERSION"],
  ]) {
    assert.ok(read(path).includes(`${constant} = "${manifest.version}"`), constant);
  }
});
