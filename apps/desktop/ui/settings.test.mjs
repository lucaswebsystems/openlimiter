import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as settingsModule from "./settings.js";
import { captionsMarkup, presetMarkup, renderSettings, themeLabel, wireAutostart } from "./settings.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const settings = readFileSync(new URL("./settings.js", import.meta.url), "utf8");
const surfaces = readFileSync(new URL("./surfaces.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../../packages/ui/src/tokens.css", import.meta.url), "utf8");
const webUi = readFileSync(new URL("../../web/components/ui.tsx", import.meta.url), "utf8");
const hero = readFileSync(new URL("../../web/components/hero.tsx", import.meta.url), "utf8");

test("Settings mounts its account hooks; terminal captions are free and Ember is the one Pro preset", () => {
  for (const id of ["menu-account-email", "menu-signed-in", "devices-mount", "pro-mount", "plan-cap-mount", "menu-logout"]) assert.match(html, new RegExp(`id=\"${id}\"`, "u"));
  for (const entitled of [false, true]) {
    const captions = captionsMarkup("tagged", entitled);
    assert.doesNotMatch(captions, /disabled|menu-lock/u, "captions are gated");
    assert.match(captions, /data-caption="tagged" aria-pressed="true">Tagged everywhere</u);
  }
  const free = presetMarkup(false, "graphite");
  for (const id of ["default", "graphite", "meadow"]) {
    assert.match(free, new RegExp(`data-preset="${id}" aria-pressed="(?:true|false)">`, "u"), id);
  }
  /* The one locked tile stays focusable and says what it is. */
  assert.match(free, /data-preset="ember" aria-pressed="false" aria-disabled="true" aria-label="Ember, Pro">/u);
  assert.doesNotMatch(free, /\sdisabled[\s>]/u, "a locked preset cannot be focused");
  assert.equal((free.match(/menu-lock/gu) ?? []).length, 1);
  assert.doesNotMatch(presetMarkup(true, "ember"), /aria-disabled|menu-lock/u);
  const { appliedPreset } = settingsModule;
  assert.equal(typeof appliedPreset, "function", "no rule for which preset applies");
  assert.equal(appliedPreset("graphite", false), "graphite");
  assert.equal(appliedPreset("meadow", false), "meadow");
  assert.equal(appliedPreset("ember", false), "default", "Ember applied without Pro");
  assert.equal(appliedPreset("ember", true), "ember");
  assert.equal(appliedPreset("unknown", true), "default");
  /* Pressing the locked tile shows the plan rather than doing nothing. */
  assert.match(settings, /if \(control\.getAttribute\("aria-disabled"\) === "true"\) \{\s*showPlan\(\);\s*return;/u);
  assert.equal(themeLabel("dark"), "Dark");
  assert.equal(themeLabel("light"), "Light");
});

test("no gate on terminal captions is left: not the window, not the plan read, not Rust", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /setTerminalCaptions\("short"\)|captionsReset/u);
  const rust = readFileSync(new URL("../src-tauri/src/cli_config.rs", import.meta.url), "utf8");
  assert.doesNotMatch(rust, /entitlement_required|theme_preset/u);
  assert.match(readFileSync(new URL("./pro.js", import.meta.url), "utf8"), /\{ key: "theme_preset", label: "Ember theme preset" \}/u);
});

test("the theme is a Light and Dark pair whose names are their labels", async () => {
  const mount = { innerHTML: "", querySelector: () => fakeSwitch() };
  await renderSettings(mount);
  assert.match(mount.innerHTML, /<span class="preset-grid" role="group" aria-label="Theme"><button type="button" class="preset" data-theme-choice="light" aria-pressed="false">Light<\/button><button type="button" class="preset" data-theme-choice="dark" aria-pressed="true">Dark<\/button><\/span>/u);
  assert.doesNotMatch(mount.innerHTML, /id="theme"|Switch between the light and dark theme/u);
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /closest\("\[data-theme-choice\]"\)/u);
  assert.match(app, /setAttribute\("aria-pressed", String\(button\.getAttribute\("data-theme-choice"\) === theme\)\)/u);
});

test("Settings aligns caption tiles and keeps filled controls on the shared brand token", () => {
  assert.match(surfaces, /\.preset \{[^}]*justify-items: center;[^}]*text-align: center;/u);
  assert.match(surfaces, /\.preset \.menu-lock \{\s*position: absolute;/u);
  /* A locked tile is not dimmed: its name is muted, its lock at full contrast. */
  assert.doesNotMatch(surfaces, /\.preset\[(?:aria-)?disabled[^\]]*\][^{]*\{[^}]*opacity/u);
  assert.match(surfaces, /\.preset\[aria-disabled="true"\] \.preset-name \{\s*color: var\(--ol-muted\);/u);
  assert.doesNotMatch(appCss, /#theme\b/u);
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
