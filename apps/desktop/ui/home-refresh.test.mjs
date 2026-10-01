import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { bindHomeRefresh, freshestObservation } from "./home-refresh.js";

class Element {
  constructor() { this.textContent = ""; this.disabled = false; this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this[name] = listener; }
}

test("Refresh waits for the native read and repaint, keeps its icon and ignores duplicate presses", async () => {
  const button = new Element(), status = new Element();
  let finish, finishPaint, reads = 0, painted = 0;
  const run = bindHomeRefresh({ button, status, readNow() {
    reads++;
    return new Promise((resolve) => { finish = resolve; });
  }, async repaint() {
    await new Promise((resolve) => { finishPaint = resolve; });
    painted += 1;
    return true;
  } });
  const running = button.click();
  assert.equal(button.disabled, true);
  assert.equal(button.attributes["aria-busy"], "true");
  assert.equal(button.textContent, "", "an icon button never trades its icon for words");
  await run();
  assert.equal(reads, 1);
  assert.equal(painted, 0);
  finish({ ok: true, value: { succeeded: true } });
  await new Promise(setImmediate);
  assert.equal(button.disabled, true);
  finishPaint();
  await running;
  assert.equal(button.disabled, false);
  assert.equal(button.attributes["aria-busy"], "false");
  assert.equal(painted, 1, "the repaint lands once the native read answered");
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
    assert.doesNotMatch(status.textContent, /[-‐-―]/u);
  }
});

test("a sentence a failed read already wrote is not replaced by the generic one", async () => {
  const button = new Element(), status = new Element();
  const run = bindHomeRefresh({ button, status, readNow: async () => ({ ok: true }), repaint: async () => {
    status.textContent = "The saved readings could not be read just now, so only readings that are still fresh are shown.";
    return false;
  } });
  await run();
  assert.equal(status.textContent, "The saved readings could not be read just now, so only readings that are still fresh are shown.");
});

test("the freshest actual observation is never invented, and Refresh sits in the header", () => {
  const snapshots = [{ observedAt: "2026-09-08T10:00:00Z" }, { observedAt: "invalid" }, { observedAt: "2026-09-08T09:00:00Z" }];
  assert.equal(freshestObservation(snapshots), "2026-09-08T10:00:00.000Z");
  assert.equal(freshestObservation([]), null);
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(read("./app.js"), /return refreshHome\(selectedHomeProviders\)/u);
  assert.match(read("./app.js"), /if \(refreshing\) await refreshing;\s*return refresh\(\);/u);
  const html = read("./index.html");
  const header = html.slice(html.indexOf('<header class="strip">'), html.indexOf("</header>"));
  assert.match(header, /id="home-refresh" class="icon" aria-label="Refresh"/u);
  /* A stale reading says its age on its own row; the screen keeps no clock. */
  assert.doesNotMatch(html, /id="home-observed"/u);
  assert.match(read("../src-tauri/src/commands.rs"), /run_pass\(&app, Some\(&providers\)\)\.await/u);
  assert.match(read("../src-tauri/src/lib.rs"), /commands::refresh_home/u);
});
