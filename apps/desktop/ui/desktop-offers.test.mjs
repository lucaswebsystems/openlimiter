import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const offer = "Start Pro free for 30 days";
const assurance = "No credit card needed";

test("every trial offer keeps its duration and card assurance together without dashes", () => {
  const html = read("./index.html");
  /* The first run asks for nothing, so no trial banner rides on it. */
  assert.doesNotMatch(html, /class="trial-offer"/u);
  /* The menu's trial control keeps the duration and its assurance together. */
  assert.match(read("./settings.js"), /start: "Start your free 30 day Pro trial",\s*free: "No card needed",/u);
  assert.match(read("./settings.js"), /TRIAL_EN\.start[\s\S]*?TRIAL_EN\.free/u);
  const tray = read("../src-tauri/src/tray.rs");
  assert.ok(tray.includes(`const TRIAL_LABEL: &str = "${offer} (${assurance})";`));
  assert.match(tray, /"trial",\s*TRIAL_LABEL,\s*true,/u);
  for (const source of [html, read("./first-run.js"), read("./settings.js"), read("./pro.js"), tray]) {
    assert.doesNotMatch(source, /Start free trial|start a Pro trial/u);
  }
  // Paid Checkout and existing trial status are distinct from a trial offer.
  assert.match(read("./pro.js"), /await proCheckoutUrl\(plan\)/u);
});

test("the unchanged trademark notice belongs only to the menu, beside the links, never a footer or the screen", () => {
  const html = read("./index.html");
  const at = html.indexOf('<details id="trademark-note">');
  const settings = html.slice(html.indexOf('id="tab-panel-settings"'), html.indexOf('id="phone-popover"'));
  assert.ok(settings.includes('<details id="trademark-note">'), "in Settings");
  const links = html.slice(html.indexOf('<nav class="menu-links"'), at);
  assert.match(links, /href="https:\/\/openlimiter\.com\/en\/privacy"[^>]*>Privacy</u);
  assert.match(links, /href="https:\/\/openlimiter\.com\/en\/terms"[^>]*>Terms</u);
  assert.equal((html.match(/id="trademark-note"/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /<footer>/u);
  const notice = html.match(/<details id="trademark-note">[\s\S]*?<p>([\s\S]*?)<\/p>/u)[1].replace(/\s+/gu, " ").trim();
  assert.equal(notice, "Product names, logos, brands, and other trademarks featured or referred to within OpenLimiter are the property of their respective trademark holders. These trademark holders are not affiliated with OpenLimiter, our products, or our website. They do not sponsor or endorse OpenLimiter. Use of them does not imply any affiliation with or endorsement by them.");
});

test("the account is offered under the bars, with Sign in and a Not now that sticks", () => {
  const html = read("./index.html");
  const usage = html.slice(html.indexOf('id="tab-panel-usage"'), html.indexOf('id="tab-panel-tools"'));
  const card = usage.match(/<section id="account-offer"[^>]*>([\s\S]*?)<\/section>/u);
  assert.ok(card, "no account offer under the bars");
  assert.match(card[0], /^<section id="account-offer"[^>]*\bhidden\b/u);
  assert.ok(usage.indexOf('id="usage-rows"') < usage.indexOf('id="account-offer"'), "the offer is not under the bars");
  assert.match(card[1], /<h2 id="account-offer-title">See your bars on your phone<\/h2>/u);
  assert.match(card[1], /data-i18n="alerts\.signInLead">Every bar and every desktop alert is free with no account/u);
  assert.match(card[1], /<button type="button" id="account-offer-sign-in" class="q-btn q-btn-primary">Sign in<\/button>/u);
  assert.match(card[1], /<button type="button" id="account-offer-dismiss" class="q-btn q-btn-ghost">Not now<\/button>/u);
  assert.doesNotMatch(card[1].replace(/<[^>]+>/gu, " "), /[-‐-―]/u);
  const app = read("./app.js");
  assert.match(app, /accountOfferSignIn\?\.addEventListener\("click", openSignIn\)/u);
  assert.match(app, /accountOfferDismiss\?\.addEventListener\("click", \(\) => \{\s*settleAccountOffer\("dismissed"\);/u);
  assert.match(app, /window\.localStorage\.setItem\(ACCOUNT_OFFER_STORAGE_KEY, value\)/u);
  assert.match(app, /if \(signedIn\) settleAccountOffer\("done"\);/u);
  assert.match(app, /accountOfferShown\(\{/u);
});

test("switch styles expose a real track, moving knob and keyboard focus using product colours", () => {
  const css = read("./surfaces.css");
  const switches = css.slice(css.indexOf(".provider-switch {"));
  assert.match(switches, /input:checked \+ .provider-switch-track::before\s*\{\s*transform: translateX/u);
  assert.match(switches, /input:focus-visible \+ .provider-switch-track\s*\{\s*outline: 2px solid var\(--ol-accent\)/u);
  assert.match(switches, /prefers-reduced-motion: reduce/u);
  assert.doesNotMatch(switches, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
  const layout = read("./app.css");
  assert.doesNotMatch(layout, /@media\s*\([^)]*699px/u);
});
