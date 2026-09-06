import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CREATING_ACCOUNT,
  REOPEN_AFTER_MILLISECONDS,
  REOPEN_FAILED,
  REOPEN_LABEL,
  SIGN_IN_PROVIDERS,
  SIGN_IN_TONES,
  SIGNED_IN_DWELL_MILLISECONDS,
  SIGNING_IN,
  openingSentence,
  otherProvider,
  providerDisabledSentence,
  providerName,
  signInFailureSentence,
  signInFailureTone,
  signedInSentence,
} from "./sign-in-states.js";

const html = () => readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = () => readFileSync(new URL("./surfaces.css", import.meta.url), "utf8");
const app = () => readFileSync(new URL("./app.js", import.meta.url), "utf8");

/* The one body, from its opening tag to the sheet's foot. */
function signInBody() {
  const markup = html();
  const start = markup.indexOf('id="sign-in-body"');
  const end = markup.indexOf('class="sign-in-foot"', start);
  assert.ok(start > 0 && end > start, "the sign in body is in the document");
  return markup.slice(start, end);
}

test("names both providers the way they spell themselves, and never Gmail", () => {
  assert.deepEqual([...SIGN_IN_PROVIDERS], ["github", "google"]);
  assert.equal(providerName("github"), "GitHub");
  assert.equal(providerName("google"), "Google");
  assert.equal(providerName("other"), "");
  assert.equal(otherProvider("github"), "google");
  assert.equal(otherProvider("google"), "github");
  assert.equal(html().includes("Gmail"), false);
});

test("the disabled provider sentence is the exact one the product promises", () => {
  assert.equal(
    providerDisabledSentence("google"),
    "Google sign in is not switched on yet. Use GitHub or email.",
  );
  assert.equal(
    providerDisabledSentence("github"),
    "GitHub sign in is not switched on yet. Use Google or email.",
  );
  assert.equal(
    signInFailureSentence({ ok: false, kind: "provider_disabled" }, "google"),
    "Google sign in is not switched on yet. Use GitHub or email.",
  );
});

test("every failure kind a sign in can produce has its own sentence", () => {
  const kinds = [
    "oauth_timeout",
    "oauth_busy",
    "oauth_rejected",
    "authentication",
    "invalid_input",
    "email_confirmation_required",
    "network",
    "unconfigured",
  ];
  const sentences = new Set(kinds.map((kind) => signInFailureSentence({ ok: false, kind })));
  assert.equal(sentences.size, kinds.length, "two kinds share a sentence");
  for (const sentence of [...sentences, REOPEN_FAILED]) {
    assert.match(sentence, /\.$/u, "a sentence ends with a full stop: " + sentence);
    assert.equal(/\(\w+\)$/u.test(sentence), false, "a dialog never shows the kind in brackets");
    assert.equal(/[–—-]/u.test(sentence), false, "no dashes in copy: " + sentence);
  }
  /* A refused password is worded for the form; a refused provider names it. */
  assert.equal(
    signInFailureSentence({ ok: false, kind: "authentication" }),
    "That email and password were not accepted.",
  );
  assert.match(signInFailureSentence({ ok: false, kind: "authentication" }, "github"), /GitHub/u);
});

test("an unknown kind falls back to the broker's words, then to one plain sentence", () => {
  assert.equal(
    signInFailureSentence({ ok: false, kind: "something_new", message: "The broker said so." }),
    "The broker said so.",
  );
  assert.equal(
    signInFailureSentence({ ok: false }),
    "Sign in could not be completed. Check your connection and try again.",
  );
  assert.equal(
    signInFailureSentence(null),
    "Sign in could not be completed. Check your connection and try again.",
  );
});

test("a confirmation email is drawn as sent, everything else that fails as an error", () => {
  assert.equal(signInFailureTone({ ok: false, kind: "email_confirmation_required" }), "sent");
  assert.equal(signInFailureTone({ ok: false, kind: "authentication" }), "error");
  assert.equal(signInFailureTone(null), "error");
});

test("the working and success sentences say what is happening and to whom", () => {
  assert.equal(openingSentence("github"), "Opening GitHub in your browser.");
  assert.equal(openingSentence("google"), "Opening Google in your browser.");
  assert.equal(SIGNING_IN, "Signing in.");
  assert.equal(CREATING_ACCOUNT, "Creating your account.");
  assert.equal(signedInSentence("person@example.com"), "Signed in as person@example.com.");
  assert.equal(signedInSentence(""), "Signed in.");
  assert.equal(signedInSentence(undefined), "Signed in.");
  /* The check and the address stay for twelve hundred milliseconds. */
  assert.equal(SIGNED_IN_DWELL_MILLISECONDS, 1200);
  /* A browser tab gets ten seconds before the link is offered again. */
  assert.equal(REOPEN_AFTER_MILLISECONDS, 10_000);
  assert.equal(REOPEN_LABEL, "Open the link again");
});

test("every tone has a drawn shape in the stylesheet", () => {
  const sheet = css();
  for (const tone of SIGN_IN_TONES) {
    const selector = ".sign-in-status[data-tone=\"" + tone + "\"]";
    assert.ok(sheet.includes(selector), "no shape for the " + tone + " tone");
  }
  /* The spinner is the one moving part and it stops under reduced motion. */
  assert.match(
    sheet,
    /prefers-reduced-motion: reduce[\s\S]*sign-in-status-mark[\s\S]*animation: none/u,
  );
});

test("the body leads with both provider marks, GitHub first, at twenty pixels", () => {
  const body = signInBody();
  const github = body.indexOf('id="account-github"');
  const google = body.indexOf('id="account-google"');
  assert.ok(github > 0 && google > github, "GitHub is offered first");
  /* The GitHub mark is the file's own path, inlined, on currentColor. */
  const file = readFileSync(new URL("./marks/github-mark.svg", import.meta.url), "utf8");
  const path = file.match(/ d="([^"]+)"/u)?.[1];
  assert.ok(path !== undefined, "the mark file carries a path");
  assert.ok(body.includes('d="' + path + '"'), "the inline GitHub mark matches marks/github-mark.svg");
  assert.match(body.slice(github, google), /fill="currentColor"/u);
  /* The Google G is the official four colour file, unmodified, as an image. */
  assert.match(body.slice(google), /<img[^>]*src="\.\/marks\/google-g\.svg"[^>]*alt=""/u);
  assert.match(body, />Continue with GitHub</u);
  assert.match(body, />Continue with Google</u);
  assert.match(css(), /\.sign-in-mark \{[^}]*width: 1\.25rem/u);
  /* The ghost's edge is the boundary token, which clears 3:1 where the strong
     hairline did not. */
  assert.match(css(), /button\.sign-in-provider \{[^}]*border-color: var\(--ol-control-border\)/u);
});

test("a provider's answer lands right under the provider buttons, the form's under the form", () => {
  const body = signInBody();
  const google = body.indexOf('id="account-google"');
  const status = body.indexOf('id="sign-in-status"');
  const divider = body.indexOf('class="sign-in-divider"');
  const form = body.indexOf('id="account-email-form"');
  const emailStatus = body.indexOf('id="sign-in-email-status"');
  const formEnd = body.indexOf("</form>");
  assert.ok(google < status && status < divider, "the provider row sits between the buttons and the rule");
  assert.ok(form < emailStatus && emailStatus < formEnd, "the form's row sits inside the form");
  const source = app();
  assert.match(source, /setSignInStatus\("working", working, slot\)/u);
  assert.match(source, /signInFailureTone\(result\), signInFailureSentence\(result, provider\), slot\)/u);
  assert.match(source, /const slot = provider === null \? "email" : "provider"/u);
});

test("the email form waits behind a link and opens from that link alone", () => {
  const body = signInBody();
  assert.match(
    body,
    /id="account-email-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="account-email-form"/u,
  );
  assert.match(body, /<form id="account-email-form"[^>]*hidden/u);
  assert.equal((html().match(/id="account-password"/gu) ?? []).length, 1);
  assert.match(body, /id="account-email-create"[^>]*>Create account</u);
  /* The desktop has no way to receive a browser link, so it does not offer one. */
  assert.equal(body.includes("account-magic-link"), false);
  assert.equal(body.includes("Email me a link"), false);
  /* Nothing but the person's own link opens the form: not a failure, not a
     provider's answer, nothing. */
  const source = app();
  assert.equal((source.match(/showEmailForm\(true\)/gu) ?? []).length, 1);
  assert.match(source, /signInToggle\?\.addEventListener\("click", \(\) => showEmailForm\(true\)\)/u);
  /* The link is underlined on the strong hairline. */
  assert.match(
    css(),
    /button\.sign-in-link \{[^}]*text-decoration: underline;[^}]*text-decoration-color: var\(--hairline-strong\)/u,
  );
});

test("in flight, the pressed control keeps its fill and carries the spinner", () => {
  const sheet = css();
  assert.match(sheet, /\.sign-in-body button\[data-working="true"\] \{[^}]*opacity: 1/u);
  assert.match(sheet, /\.sign-in-body button\[data-working="true"\]::after \{[^}]*animation: sign-in-spin/u);
  /* Everything else steps back to seventy percent rather than greying out. */
  assert.match(
    sheet,
    /\.sign-in-body\[aria-busy="true"\] button:disabled:not\(\[data-working="true"\]\)[^{]*\{[^}]*opacity: 0\.7/u,
  );
  const source = app();
  assert.match(source, /accountOauth\(provider\), provider, openingSentence\(provider\), pressed\)/u);
  assert.match(source, /signInPressed\?\.setAttribute\("data-working", "true"\)/u);
  /* After ten seconds the link is offered again, only while the attempt waits. */
  assert.match(html(), /id="account-oauth-reopen"[^>]*hidden>Open the link again</u);
  assert.match(source, /if \(signInBusy\) offerReopen\(true\);[\s\S]*?\}, REOPEN_AFTER_MILLISECONDS\)/u);
  assert.match(source, /const result = await action\(\);\s*stopReopenTimer\(\);/u);
  assert.match(source, /accountOauthReopen\(\)/u);
});

test("the arrival is one check and the address, with nothing live underneath", () => {
  const body = signInBody();
  assert.match(body, /class="sign-in-success"[^>]*aria-hidden="true"[^>]*hidden/u);
  assert.match(body, /class="sign-in-success-mark">✓</u);
  assert.match(body, /id="sign-in-success-text"/u);
  const sheet = css();
  assert.match(
    sheet,
    /\.sign-in-body\[data-state="signed-in"\] > :not\(\.sign-in-success\):not\(\.sign-in-status\) \{\s*display: none/u,
  );
  const source = app();
  assert.match(source, /showSignedIn\(signedInSentence\(result\.value\.email\)\)/u);
  assert.match(source, /dataset\.state = "signed-in"/u);
  /* The sentence is announced from the toneless row, which keeps its place. */
  assert.match(source, /function showSignedIn\(sentence\) \{[\s\S]*?setSignInStatus\(null, ""\);[\s\S]*?signInStatusText\.textContent = sentence/u);
  /* The check has its moment before the body is put away. */
  assert.match(source, /window\.setTimeout\([\s\S]*?openlimiter:signed-in[\s\S]*?SIGNED_IN_DWELL_MILLISECONDS\)/u);
  assert.match(source, /applyAccountState\(result\.value\);[\s\S]*?if \(signInIsInSheet\(\)\) closeSignIn\(\)/u);
});

test("the foot is a bordered Not now beside the honest sentence, at caption size", () => {
  const markup = html();
  assert.match(markup, /id="sign-in-status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(markup, /id="sign-in-close" class="sign-in-ghost">Not now</u);
  assert.match(markup, /id="first-run-not-now" class="sign-in-ghost">Not now</u);
  assert.match(markup, /Every meter in this window keeps running without an account\./u);
  const sheet = css();
  assert.match(sheet, /button\.sign-in-ghost \{[^}]*border-color: var\(--ol-control-border\)/u);
  assert.match(sheet, /\.sign-in-foot-note \{[^}]*font-size: var\(--ol-text-caption\)/u);
  /* Escape and the backdrop put the sheet away like Not now does. */
  const source = app();
  assert.match(source, /event\.key !== "Escape"[\s\S]*?closeSignIn\(\)/u);
  assert.match(source, /event\.target === elements\.signIn\) closeSignIn\(\)/u);
});

test("the first run account step wears the same centred head and hosts the same body", () => {
  const markup = html();
  const source = readFileSync(new URL("./first-run.js", import.meta.url), "utf8");
  assert.equal((markup.match(/id="sign-in-body"/gu) ?? []).length, 1);
  const start = markup.indexOf('id="first-run-account"');
  const step = markup.slice(start, markup.indexOf("</section>", start));
  assert.match(step, /class="sign-in-head"[\s\S]*?class="sign-in-lockup"[\s\S]*?id="first-run-account-title"[\s\S]*?class="sign-in-lead"/u);
  /* One lead sentence: a single full stop, at the end. */
  const lead = step.match(/class="sign-in-lead">([^<]+)</u)?.[1] ?? "";
  assert.equal((lead.match(/\./gu) ?? []).length, 1);
  assert.match(lead, /\.$/u);
  assert.match(step, /id="first-run-sign-in-mount"/u);
  assert.match(source, /options\.mountSignIn\(mount\)/u);
  assert.match(source, /options\.unmountSignIn\(\)/u);
  assert.match(source, /screen\.dataset\.step = "account"/u);
  assert.match(css(), /\.first-run\[data-step="account"\] \.first-run-lockup \{\s*display: none/u);
  assert.match(app(), /mountSignIn,\s*unmountSignIn,/u);
});
