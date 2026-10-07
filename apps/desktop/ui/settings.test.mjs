import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const settings = readFileSync(new URL("./settings.js", import.meta.url), "utf8");

test("Settings keeps the account hooks and the Pro caption preset", () => {
  for (const id of ["menu-account-email", "menu-signed-in", "devices-mount", "pro-mount", "plan-cap-mount", "menu-logout"]) assert.match(html, new RegExp(`id=\"${id}\"`, "u"));
  assert.match(settings, /Terminal captions/u);
  assert.match(settings, /data-caption/u);
  assert.match(settings, /theme_preset/u);
});
