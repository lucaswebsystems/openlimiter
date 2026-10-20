import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as settingsModule from "./settings.js";
import { DOWNLOAD_URL, captionsMarkup, presetMarkup, renderSettings, themeLabel, updateView, wireAutostart, wireUpdates } from "./settings.js";

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

/* ------------------------------------------------------- the four presets */

const themeCss = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function block(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return null;
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map((match) => [match[1], match[2].trim()]));
}

function hex(value) {
  const text = String(value ?? "").trim();
  if (!/^#[0-9a-fA-F]{6}$/u.test(text)) throw new Error(`not a six digit colour: ${text}`);
  return [1, 3, 5].map((at) => Number.parseInt(text.slice(at, at + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(left, right) {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/* color-mix(in srgb, X 88%, black), the hover the quiet buttons draw. */
const darkened = (rgb) => rgb.map((channel) => Math.round(channel * 0.88));

const base = {
  dark: block(tokens, ":root"),
  light: block(tokens, ':root[data-theme="light"]'),
};

test("Graphite, Meadow and Ember are real token overrides, readable in light and dark", () => {
  for (const preset of ["graphite", "meadow", "ember"]) {
    for (const theme of ["dark", "light"]) {
      const selector = theme === "dark"
        ? `:root[data-preset="${preset}"]:not([data-theme="light"])`
        : `:root[data-preset="${preset}"][data-theme="light"]`;
      const own = block(themeCss, selector);
      assert.ok(own, `no ${preset} ${theme} override in theme.css`);
      const token = (name) => own[name] ?? base[theme][name];
      const label = `${preset} ${theme}`;
      const canvas = hex(token("--ol-canvas"));
      const surface = hex(token("--ol-surface"));
      /* A filled primary keeps a readable label, at rest and on hover. */
      assert.ok(contrast(hex(token("--ol-on-primary")), hex(token("--ol-primary"))) >= 4.5, `${label} primary`);
      assert.ok(contrast(hex(token("--ol-on-primary")), hex(token("--ol-primary-hover"))) >= 4.5, `${label} primary hover`);
      assert.ok(contrast(hex(token("--ol-on-primary-fill")), hex(token("--ol-primary-fill"))) >= 4.5, `${label} primary fill`);
      assert.ok(contrast(hex(token("--ol-on-primary-fill")), darkened(hex(token("--ol-primary-fill")))) >= 4.5, `${label} quiet primary hover`);
      /* The accent and its text tints read as text on the window and its cards. */
      for (const name of ["--ol-accent", "--ol-accent-hover", "--ol-accent-solid-hover"]) {
        assert.ok(contrast(hex(token(name)), surface) >= 4.5, `${label} ${name} on the surface`);
        assert.ok(contrast(hex(token(name)), canvas) >= 4.5, `${label} ${name} on the canvas`);
      }
      /* A switch knob against its lit track, and the focus ring on the canvas. */
      assert.ok(contrast(hex(token("--ol-on-accent")), hex(token("--ol-accent"))) >= 3, `${label} switch knob`);
      /* Each tile shows the colours its preset applies, in this theme. */
      const swatches = block(themeCss, theme === "dark" ? ":root" : ':root[data-theme="light"]');
      assert.equal(swatches[`--ol-preset-${preset}-canvas`], token("--ol-canvas"), `${label} canvas swatch`);
      assert.equal(swatches[`--ol-preset-${preset}-surface`], token("--ol-surface"), `${label} surface swatch`);
      assert.equal(swatches[`--ol-preset-${preset}-accent`], token("--ol-accent"), `${label} accent swatch`);
    }
  }
  /* Product's swatches are the token sheet's own values, so they cannot drift. */
  for (const theme of ["dark", "light"]) {
    const swatches = block(themeCss, theme === "dark" ? ":root" : ':root[data-theme="light"]');
    assert.equal(swatches["--ol-preset-product-canvas"], base[theme]["--ol-canvas"]);
    assert.equal(swatches["--ol-preset-product-surface"], base[theme]["--ol-surface"]);
    assert.equal(swatches["--ol-preset-product-accent"], base[theme]["--ol-brand"]);
  }
  const settingsSource = readFileSync(new URL("./settings.js", import.meta.url), "utf8");
  for (const id of ["product", "graphite", "meadow", "ember"]) {
    assert.match(settingsSource, new RegExp(`swatches: \\["var\\(--ol-preset-${id}-canvas\\)", "var\\(--ol-preset-${id}-surface\\)", "var\\(--ol-preset-${id}-accent\\)"\\]`, "u"), id);
  }
});

test("a free preset applies before the first paint; Ember waits for the plan", async () => {
  const { default: vm } = await import("node:vm");
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  const painted = (stored) => {
    const values = new Map(Object.entries(stored));
    const attributes = {};
    vm.runInNewContext(script, {
      window: { localStorage: { getItem: (key) => values.get(key) ?? null } },
      document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } },
    });
    return attributes["data-preset"];
  };
  assert.equal(painted({ "openlimiter-theme-preset": "graphite" }), "graphite");
  assert.equal(painted({ "openlimiter-theme-preset": "meadow" }), "meadow");
  assert.equal(painted({ "openlimiter-theme-preset": "ember" }), undefined, "Ember painted before the plan was read");
  assert.equal(painted({}), undefined);
});

test("no gate on terminal captions is left: not the window, not the plan read, not Rust", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /setTerminalCaptions\("short"\)|captionsReset/u);
  const rust = readFileSync(new URL("../src-tauri/src/cli_config.rs", import.meta.url), "utf8");
  assert.doesNotMatch(rust, /entitlement_required|theme_preset/u);
  /* The one shared Pro list names Ember as the Pro preset. */
  const shared = JSON.parse(readFileSync(new URL("../../web/lib/pro-features.json", import.meta.url), "utf8")).features;
  assert.ok(shared.some((feature) => feature.entitlement === "theme_preset" && feature.label === "The Ember theme preset"));
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

function updateControls(update) {
  const control = () => {
    const handlers = {};
    return { textContent: "", hidden: true, disabled: false, handlers, addEventListener: (type, handler) => { handlers[type] = handler; } };
  };
  const calls = [];
  const api = {
    checkForUpdate: async () => { calls.push("check"); return { ok: true, value: update }; },
    installUpdate: async () => { calls.push("install"); return { ok: true, value: null }; },
    openDownloadPage: async () => { calls.push("download"); return { ok: true, value: null }; },
  };
  const menu = control();
  const banner = control();
  return { menu, banner, calls, run: wireUpdates({ menu, banner }, api) };
}

test("both update controls open the download page through the native action for a release with no installer here (Astra finding 2)", async () => {
  const controls = updateControls({ version: "2.1.7", currentVersion: "2.1.6", manual: true });
  await controls.run(true);
  assert.equal(controls.banner.hidden, false);
  assert.equal(controls.banner.textContent, "Version 2.1.7 is out. Download it from openlimiter.com.");
  assert.equal(controls.menu.textContent, "Version 2.1.7 is out. Download it from openlimiter.com.");
  controls.banner.handlers.click();
  controls.menu.handlers.click();
  assert.deepEqual(controls.calls, ["check", "download", "download"]);
});

test("an installable release keeps the banner's install and the menu's fresh check", async () => {
  const controls = updateControls({ version: "2.1.7", currentVersion: "2.1.6", manual: false });
  await controls.run(true);
  assert.equal(controls.banner.textContent, "OpenLimiter 2.1.7 is ready. Install now.");
  controls.banner.handlers.click();
  assert.equal(controls.banner.textContent, "Installing update");
  controls.menu.handlers.click();
  assert.deepEqual(controls.calls, ["check", "install", "check"]);
});
