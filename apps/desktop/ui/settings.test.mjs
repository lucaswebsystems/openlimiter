import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { captionsMarkup, presetMarkup, themeLabel } from "./settings.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const settings = readFileSync(new URL("./settings.js", import.meta.url), "utf8");

test("Settings mounts its account hooks and gates captions by the feature entitlement", () => {
  for (const id of ["menu-account-email", "menu-signed-in", "devices-mount", "pro-mount", "plan-cap-mount", "menu-logout"]) assert.match(html, new RegExp(`id=\"${id}\"`, "u"));
  const free = captionsMarkup("tagged", false);
  assert.match(free, /data-caption="tagged"[^>]* disabled/u);
  assert.match(free, /Locked/u);
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
