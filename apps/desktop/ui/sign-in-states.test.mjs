import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CREATING_ACCOUNT,
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
  for (const sentence of sentences) {
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
  assert.ok(SIGNED_IN_DWELL_MILLISECONDS > 0 && SIGNED_IN_DWELL_MILLISECONDS < 3000);
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
});

test("the email form waits behind a quiet link and keeps one password field", () => {
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
});

test("the status line is a live region with a shape per tone, and Not now is honest", () => {
  const markup = html();
  assert.match(markup, /id="sign-in-status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(markup, /id="sign-in-close"[^>]*>Not now</u);
  assert.match(markup, /Every meter in this window keeps running without an account\./u);
  const source = app();
  /* The four states, in the order a sign in meets them: working, then either
     a failure worded for the button that was pressed, or the session. */
  assert.match(source, /accountOauth\(provider\), provider, openingSentence\(provider\)/u);
  assert.match(source, /setSignInStatus\("working", working\)/u);
  assert.match(source, /signInFailureTone\(result\), signInFailureSentence\(result, provider\)/u);
  assert.match(source, /setSignInStatus\("success", signedInSentence\(/u);
  /* The success state has its moment before the body is put away. */
  assert.match(source, /window\.setTimeout\([\s\S]*?openlimiter:signed-in[\s\S]*?SIGNED_IN_DWELL_MILLISECONDS\)/u);
  /* Escape and the backdrop put the sheet away like Not now does, and a late
     result is still applied to the window rather than dropped. */
  assert.match(source, /event\.key !== "Escape"[\s\S]*?closeSignIn\(\)/u);
  assert.match(source, /event\.target === elements\.signIn\) closeSignIn\(\)/u);
  assert.match(source, /applyAccountState\(result\.value\);[\s\S]*?if \(signInIsInSheet\(\)\) closeSignIn\(\)/u);
});

test("the first run account step hosts the same body rather than a second copy", () => {
  const markup = html();
  const source = readFileSync(new URL("./first-run.js", import.meta.url), "utf8");
  assert.equal((markup.match(/id="sign-in-body"/gu) ?? []).length, 1);
  assert.match(markup, /id="first-run-sign-in-mount"/u);
  assert.match(source, /options\.mountSignIn\(mount\)/u);
  assert.match(source, /options\.unmountSignIn\(\)/u);
  assert.match(app(), /mountSignIn,\s*unmountSignIn,/u);
});
