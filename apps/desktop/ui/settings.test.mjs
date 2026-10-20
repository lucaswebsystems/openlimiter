import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DOWNLOAD_URL, captionsMarkup, presetMarkup, renderSettings, themeLabel, updateView, wireAutostart } from "./settings.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const settings = readFileSync(new URL("./settings.js", import.meta.url), "utf8");
const surfaces = readFileSync(new URL("./surfaces.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../../packages/ui/src/tokens.css", import.meta.url), "utf8");
const webUi = readFileSync(new URL("../../web/components/ui.tsx", import.meta.url), "utf8");
const hero = readFileSync(new URL("../../web/components/hero.tsx", import.meta.url), "utf8");

test("Settings mounts its account hooks and gates captions by the feature entitlement", () => {
  for (const id of ["menu-account-email", "menu-signed-in", "devices-mount", "pro-mount", "plan-cap-mount", "menu-logout"]) assert.match(html, new RegExp(`id=\"${id}\"`, "u"));
  const free = captionsMarkup("tagged", false);
  assert.match(free, /data-caption="tagged"[^>]* disabled/u);
  assert.match(free, /<span class="menu-lock" aria-hidden="true"><svg/u);
  const pro = captionsMarkup("tagged", true);
  assert.doesNotMatch(pro, /data-caption="tagged"[^>]* disabled/u);
  assert.match(pro, /aria-pressed="true"/u);
  const freePresets = presetMarkup(false, "graphite");
  assert.match(freePresets, /data-preset="default"(?![^>]* disabled)/u);
  assert.match(freePresets, /data-preset="graphite"[^>]* disabled/u);
  assert.match(settings, /theme_preset/u);
  assert.equal(themeLabel("dark"), "Dark");
  assert.equal(themeLabel("light"), "Light");
});

test("Settings aligns caption tiles and keeps filled controls on the shared brand token", () => {
  assert.match(surfaces, /\.preset \{[^}]*justify-items: center;[^}]*text-align: center;/u);
  assert.match(surfaces, /\.preset \.menu-lock \{\s*position: absolute;/u);
  assert.doesNotMatch(surfaces, /\.preset\[disabled\] \{[^}]*opacity/u);
  assert.match(appCss, /#settings-appearance #theme \{\s*padding-right: 0;/u);
  assert.doesNotMatch(appCss, /\.app-menu #theme/u);
  assert.match(tokens, /:root \{[\s\S]*?--ol-primary-fill: #0866FF;[\s\S]*?--ol-on-primary-fill: #ffffff;/u);
  assert.match(tokens, /:root\[data-theme="light"\] \{[\s\S]*?--ol-primary-fill: #0866FF;[\s\S]*?--ol-on-primary-fill: #ffffff;/u);
  assert.doesNotMatch(webUi, /ol-primary-fill/u);
  assert.doesNotMatch(hero, /ol-primary-fill/u);
});

function fakeSwitch() {
  return {
    checked: false,
    disabled: true,
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
  };
}

test("the start at sign in switch shows the OS state and writes it both ways", async () => {
  let os = false;
  const writes = [];
  const control = fakeSwitch();
  await wireAutostart(control, {
    autostartStatus: async () => ({ ok: true, value: os }),
    setAutostart: async (enabled) => {
      writes.push(enabled);
      os = enabled;
      return { ok: true, value: os };
    },
  });
  assert.equal(control.checked, false);
  assert.equal(control.disabled, false);
  for (const next of [true, false]) {
    control.checked = next;
    await control.handlers.change();
    assert.equal(control.checked, next);
    assert.equal(control.disabled, false);
  }
  assert.deepEqual(writes, [true, false]);
});

test("a refused write shows what the OS kept, and a missing backend leaves the switch disabled", async () => {
  const control = fakeSwitch();
  await wireAutostart(control, {
    autostartStatus: async () => ({ ok: true, value: true }),
    setAutostart: async () => ({ ok: false, reason: "command_failed" }),
  });
  control.checked = false;
  await control.handlers.change();
  assert.equal(control.checked, true);
  const absent = fakeSwitch();
  await wireAutostart(absent, {
    autostartStatus: async () => ({ ok: false, reason: "backend_absent" }),
    setAutostart: async () => assert.fail("nothing is written without a backend"),
  });
  assert.equal(absent.disabled, true);
  assert.equal(absent.handlers.change, undefined);
});

test("Settings shows the start at sign in switch with its note", async () => {
  const mount = { innerHTML: "", querySelector: () => fakeSwitch() };
  await renderSettings(mount);
  assert.match(mount.innerHTML, /<label for="autostart">Start OpenLimiter when you sign in<\/label>/u);
  assert.match(mount.innerHTML, /id="autostart"[^>]* disabled aria-describedby="autostart-note"/u);
  assert.match(mount.innerHTML, /<p id="autostart-note" class="menu-note">Keeps your bars current after a restart\.<\/p>/u);
});

test("a release the manifest has no installer for links to the download page (macOS, 2.1.7)", () => {
  const out = "Version 2.1.7 is out. Download it from openlimiter.com.";
  assert.equal(DOWNLOAD_URL, "https://openlimiter.com/download");
  assert.deepEqual(updateView({ version: "2.1.7", currentVersion: "2.1.6", manual: true }), {
    menu: out, banner: out, href: DOWNLOAD_URL,
  });
  assert.deepEqual(updateView({ version: "2.1.7", currentVersion: "2.1.6", manual: false }), {
    menu: "Install OpenLimiter 2.1.7", banner: "OpenLimiter 2.1.7 is ready. Install now.", href: null,
  });
  assert.deepEqual(updateView(null), { menu: "OpenLimiter is current", banner: null, href: null });
});
