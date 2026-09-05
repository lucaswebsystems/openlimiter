import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PAIRING_PHASES,
  SETTLED_COPY,
  claimHeadline,
  countdownText,
  decidingHeadline,
  isSettled,
  pairingFailureSentence,
} from "./pairing-states.js";

const panelSource = () =>
  readFileSync(new URL("./pairing.js", import.meta.url), "utf8");
const html = () => readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("the phone panel is in the header, beside the bell and the menu", () => {
  const markup = html();
  assert.match(markup, /id="phone-button"[\s\S]*aria-controls="phone-popover"/u);
  assert.match(markup, /id="phone-popover"[\s\S]*id="phone-panel-body"/u);
  assert.match(markup, /aria-label="Pair your phone"/u);
});

test("a signed out person is told to sign in rather than shown a dead button", () => {
  const source = panelSource();
  assert.match(source, /"Sign in to pair your phone"/u);
  /* The signed out branch is the FIRST thing render checks, so no other state
     can be drawn for somebody with no account. */
  assert.match(
    source,
    /panel\.textContent = "";\s*if \(!state\.signedIn\) \{\s*signedOutState\(panel\);/u,
  );
});

test("every phase a pairing can reach has a drawn state", () => {
  const source = panelSource();
  for (const phase of PAIRING_PHASES) {
    if (phase === "pending") {
      assert.match(source, /pendingState\(panel, session\)/u);
      continue;
    }
    if (phase === "claimed") {
      assert.match(source, /claimedState\(panel, session\)/u);
      continue;
    }
    if (phase === "deciding") {
      assert.match(source, /decidingState\(panel, session\)/u);
      continue;
    }
    assert.ok(
      Object.prototype.hasOwnProperty.call(SETTLED_COPY, phase),
      phase + " has no settled copy",
    );
  }
  /* And the two that are not phases at all: nothing yet, and a failure. */
  assert.match(source, /idleState\(panel\)/u);
  assert.match(source, /failureState\(panel, state\.message\)/u);
});

test("a decision in flight has its own state and offers no second press", () => {
  const source = panelSource();
  const deciding = source.slice(
    source.indexOf("function decidingState("),
    source.indexOf("function settledState("),
  );
  assert.match(deciding, /decidingHeadline\(session\.deviceName\)/u);
  assert.match(deciding, /does not need pressing again/u);
  /* Neither button is drawn while the answer is on its way. Pressing Approve
     twice is exactly what the transition in Rust exists to refuse. */
  assert.equal(/phone-approve|phone-deny/u.test(deciding), false);
  assert.equal(decidingHeadline("Lucas iPhone"), "Deciding about Lucas iPhone");
  assert.equal(decidingHeadline(""), "Deciding about the phone");
});

test("the countdown counts down and never goes negative", () => {
  assert.equal(countdownText(120), "120 seconds left");
  assert.equal(countdownText(1), "1 second left");
  assert.equal(countdownText(0), "This code has run out");
  assert.equal(countdownText(-40), "This code has run out");
  assert.equal(countdownText(undefined), "This code has run out");
  assert.equal(countdownText(11.8), "11 seconds left");
});

test("the approval prompt names the phone, or says it has no name", () => {
  assert.equal(claimHeadline("Lucas iPhone"), "Phone wants to pair: Lucas iPhone");
  assert.equal(claimHeadline(""), "Phone wants to pair: an unnamed phone");
  assert.equal(claimHeadline(null), "Phone wants to pair: an unnamed phone");
});

test("denied and expired are told apart, because they are different facts", () => {
  assert.notEqual(SETTLED_COPY.denied.sentence, SETTLED_COPY.expired.sentence);
  assert.equal(SETTLED_COPY.denied.title, "Not paired");
  assert.equal(SETTLED_COPY.expired.title, "That code ran out");
  assert.equal(SETTLED_COPY.approved.title, "Paired");
  assert.equal(SETTLED_COPY.delivered.title, "Paired");
});

test("a settled pairing stops the poll instead of asking about a spent code", () => {
  assert.equal(isSettled("approved"), true);
  assert.equal(isSettled("delivered"), true);
  assert.equal(isSettled("denied"), true);
  assert.equal(isSettled("expired"), true);
  assert.equal(isSettled("pending"), false);
  assert.equal(isSettled("claimed"), false);
  assert.match(panelSource(), /if \(isSettled\(session\.phase\)\) stopPolling\(\);/u);
});

test("no failure ever reaches a person as a raw code", () => {
  assert.equal(
    pairingFailureSentence({ reason: "backend_absent" }),
    "This build has no pairing backend, so nothing was started.",
  );
  assert.equal(
    pairingFailureSentence({ kind: "device_cap_reached" }),
    "This account already has five devices. Revoke one below, then pair again.",
  );
  assert.equal(
    pairingFailureSentence({ kind: "entitlement_required" }),
    "Pairing needs an active Pro entitlement on this device.",
  );
  assert.equal(
    pairingFailureSentence({ kind: "no_session" }),
    "Sign in again to pair a phone. Nothing was sent.",
  );
  assert.equal(
    pairingFailureSentence({ kind: "network", message: "The service could not be reached." }),
    "The service could not be reached.",
  );
  assert.equal(
    pairingFailureSentence(null),
    "The pairing service could not be reached.",
  );
});

test("closing the panel stops the poll and opening it resumes one", () => {
  const source = panelSource();
  assert.match(source, /export function pairingPanelClosed\(\) \{\s*stopPolling\(\);/u);
  assert.match(source, /export function pairingPanelOpened\(\)/u);
  /* A finished pairing is never polled again on reopen. */
  assert.match(source, /!isSettled\(state\.session\.phase\) &&\s*state\.timer === null/u);
});

test("the device list offers a revoke on every device but this one", () => {
  const source = panelSource();
  assert.match(source, /device\.current === true[\s\S]*"This device"/u);
  assert.match(source, /data-device-revoke/u);
  assert.match(source, /await deviceRevoke\(String\(device\.id \?\? ""\)\)/u);
});

test("no copy in the pairing surface carries a dash of any kind", () => {
  const strings = [
    ...Object.values(SETTLED_COPY).flatMap((entry) => [entry.title, entry.sentence]),
    countdownText(90),
    countdownText(0),
    claimHeadline("Lucas iPhone"),
    decidingHeadline("Lucas iPhone"),
    decidingHeadline(null),
    pairingFailureSentence({ reason: "backend_absent" }),
    pairingFailureSentence({ kind: "device_cap_reached" }),
    pairingFailureSentence({ kind: "entitlement_required" }),
    pairingFailureSentence({ kind: "no_session" }),
    pairingFailureSentence(null),
  ];
  for (const sentence of strings) {
    assert.equal(
      /[-‐-―]/u.test(sentence),
      false,
      "a dash reached product copy: " + sentence,
    );
  }
});
