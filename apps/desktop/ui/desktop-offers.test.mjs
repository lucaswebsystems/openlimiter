import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const offer = "Start Pro free for 30 days";
const assurance = "No credit card needed";

test("every trial offer keeps its duration and card assurance together without dashes", () => {
  const html = read("./index.html");
  const firstRun = html.slice(html.indexOf('id="first-run-account"'), html.indexOf('id="first-run-setup"'));
  for (const source of [firstRun, read("./settings.js")]) {
    const block = source.match(/<div class="trial-offer">(.*?)<\/div>/su)?.[1];
    assert.ok(block);
    const text = block.replace(/<[^>]+>/gu, " ");
    assert.ok(text.includes(offer));
    assert.ok(text.includes(assurance));
    assert.doesNotMatch(text, /[-\u2010-\u2015]/u);
  }
  const tray = read("../src-tauri/src/tray.rs");
  assert.ok(tray.includes(`const TRIAL_LABEL: &str = "${offer} (${assurance})";`));
  assert.match(tray, /"trial",\s*TRIAL_LABEL,\s*true,/u);
  for (const source of [html, read("./first-run.js"), read("./settings.js"), read("./pro.js"), tray]) {
    assert.doesNotMatch(source, /Start free trial|start a Pro trial/u);
  }
  // Paid Checkout and existing trial status are distinct from a trial offer.
  assert.match(read("./pro.js"), /await proCheckoutUrl\(plan\)/u);
});

test("the unchanged trademark notice belongs only to Settings About, never the shared footer or Home", () => {
  const html = read("./index.html");
  const stack = [];
  let noticeParents;
  for (const match of html.matchAll(/<\/?section\b[^>]*>|<details id="trademark-note">/gu)) {
    if (match[0].startsWith("</")) stack.pop();
    else if (match[0].startsWith("<section")) stack.push(match[0]);
    else noticeParents = [...stack];
  }
  assert.ok(noticeParents.some((tag) => tag.includes('id="panel-settings"')));
  assert.ok(noticeParents.some((tag) => tag.includes('aria-labelledby="about-title"')));
  assert.match(html, /<h2 id="about-title">About<\/h2>/u);
  assert.equal((html.match(/id="trademark-note"/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /<footer>/u);
  const notice = html.match(/<details id="trademark-note">[\s\S]*?<p>([\s\S]*?)<\/p>/u)[1].replace(/\s+/gu, " ").trim();
  assert.equal(notice, "Product names, logos, brands, and other trademarks featured or referred to within OpenLimiter are the property of their respective trademark holders. These trademark holders are not affiliated with OpenLimiter, our products, or our website. They do not sponsor or endorse OpenLimiter. Use of them does not imply any affiliation with or endorsement by them.");
});

test("first run retains exactly one clearly labelled account bypass", () => {
  const html = read("./index.html");
  assert.equal((html.match(/>Create account later<\/button>/gu) ?? []).length, 1);
  assert.match(read("./first-run.js"), /#first-run-later"\)\?\.addEventListener\("click", \(\) => \{\s*void showConnect\(\);/u);
});

test("switch styles expose a real track, moving knob and keyboard focus using product colours", () => {
  const css = read("./surfaces.css");
  const switches = css.slice(css.indexOf(".provider-switch {"), css.indexOf("#trademark-note {"));
  assert.match(switches, /input:checked \+ .provider-switch-track::before\s*\{\s*transform: translateX/u);
  assert.match(switches, /input:focus-visible \+ .provider-switch-track\s*\{\s*outline: 2px solid var\(--ol-accent\)/u);
  assert.match(switches, /prefers-reduced-motion: reduce/u);
  assert.doesNotMatch(switches, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
  const layout = read("./app.css");
  assert.match(layout, /\.catalogue-row > \.provider-switch \{\s*grid-column: 2;\s*grid-row: 1;/u);
  assert.match(layout, /\.catalogue-action \{\s*grid-column: 2;\s*grid-row: 2 \/ span 2;/u);
});
