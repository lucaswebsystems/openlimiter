import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { bindHomeRefresh, paintObserved, freshestObservation } from "./home-refresh.js";

class Element {
  constructor() { this.textContent = ""; this.disabled = false; this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this[name] = listener; }
}

test("Refresh waits for the native read and repaint, advances the observation and ignores duplicate presses", async () => {
  const button = new Element(), status = new Element(), clock = new Element();
  let finish, finishPaint, reads = 0;
  paintObserved(clock, [{ observedAt: "2026-09-08T10:00:00Z" }]);
  const run = bindHomeRefresh({ button, status, readNow() {
    reads++;
    return new Promise((resolve) => { finish = resolve; });
  }, async repaint() {
    await new Promise((resolve) => { finishPaint = resolve; });
    paintObserved(clock, [{ observedAt: "2026-09-08T10:01:00Z" }]);
    return true;
  } });
  const running = button.click();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Refreshing…");
  await run();
  assert.equal(reads, 1);
  assert.equal(clock.attributes.datetime, "2026-09-08T10:00:00.000Z");
  finish({ ok: true, value: { succeeded: true } });
  await new Promise(setImmediate);
  assert.equal(button.disabled, true);
  finishPaint();
  await running;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Refresh");
  assert.equal(clock.attributes.datetime, "2026-09-08T10:01:00.000Z");
  assert.equal(status.textContent, "");
});

test("failed, partial and thrown reads leave a plain sentence and release the button", async () => {
  for (const result of [{ ok: false }, { ok: true, value: { succeeded: false } }, null]) {
    const button = new Element(), status = new Element();
    const run = bindHomeRefresh({ button, status, readNow: async () => {
      if (result === null) throw new Error("fixture");
      return result;
    }, repaint: async () => true });
    await run();
    assert.equal(button.disabled, false);
    assert.match(status.textContent, /could not refresh; try again shortly\./u);
    assert.doesNotMatch(status.textContent, /[-\u2010-\u2015]/u);
  }
});

test("clock uses the freshest actual observation and does not invent a refresh time", () => {
  const clock = new Element();
  const snapshots = [{ observedAt: "2026-09-08T10:00:00Z" }, { observedAt: "invalid" }, { observedAt: "2026-09-08T09:00:00Z" }];
  assert.equal(freshestObservation(snapshots), "2026-09-08T10:00:00.000Z");
  paintObserved(clock, snapshots);
  const before = clock.attributes.datetime;
  paintObserved(clock, snapshots);
  assert.equal(clock.attributes.datetime, before);
  paintObserved(clock, []);
  assert.equal(clock.textContent, "No reading yet");
  assert.equal(clock.attributes.datetime, undefined);
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(read("./app.js"), /await refreshHome\(selectedHomeProviders\)/u);
  assert.match(read("./app.js"), /if \(refreshing\) await refreshing;\s*return refresh\(\);/u);
  assert.match(read("../src-tauri/src/commands.rs"), /run_pass\(&app, Some\(&providers\)\)\.await/u);
  assert.match(read("../src-tauri/src/lib.rs"), /commands::refresh_home/u);
});
