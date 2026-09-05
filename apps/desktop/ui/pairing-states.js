/**
 * What the phone panel says, in each of the states a pairing can be in.
 *
 * The copy lives apart from the panel on purpose. A pairing has eight states
 * and every one of them has to have a drawn shape and a sentence a person can
 * act on: a bare "pending" where a state should be is how somebody ends up
 * staring at a countdown wondering whether anything is happening. Keeping the
 * table here means the states can be read, reviewed and tested as a set,
 * rather than found one at a time inside the function that draws them.
 *
 * This module imports nothing. That is what lets the whole vocabulary be
 * checked without a window, a webview or the compiled engine anywhere near it.
 */

/** The phases the desktop can be shown, in the order a pairing meets them. */
export const PAIRING_PHASES = Object.freeze([
  "pending",
  "claimed",
  "approved",
  "delivered",
  "denied",
  "expired",
]);

/** Phases that cannot change again, so the panel stops asking about them. */
export const SETTLED_PHASES = Object.freeze([
  "approved",
  "delivered",
  "denied",
  "expired",
]);

export function isSettled(phase) {
  return SETTLED_PHASES.includes(phase);
}

/** The seconds a code has left, said the way a person counts them. */
export function countdownText(secondsRemaining) {
  const seconds = Math.max(0, Math.floor(Number(secondsRemaining) || 0));
  if (seconds === 0) return "This code has run out";
  if (seconds === 1) return "1 second left";
  return String(seconds) + " seconds left";
}

/** "Phone wants to pair: <name>", with a name for a phone that gave none. */
export function claimHeadline(deviceName) {
  const name =
    typeof deviceName === "string" && deviceName !== "" ? deviceName : "an unnamed phone";
  return "Phone wants to pair: " + name;
}

/**
 * The four endings, each with its own title, tone and next step.
 *
 * Denied and expired are different facts and are said differently: one is a
 * decision somebody made, the other is a clock running out, and telling them
 * apart is the difference between "did I do that" and "try again".
 */
export const SETTLED_COPY = Object.freeze({
  approved: {
    title: "Paired",
    tone: "ok",
    sentence:
      "The phone has a read only view of these meters. Revoke it below whenever you want it gone.",
  },
  delivered: {
    title: "Paired",
    tone: "ok",
    sentence: "The phone picked up its access. It is in the device list below.",
  },
  denied: {
    title: "Not paired",
    tone: "critical",
    sentence:
      "That phone was turned away and the code is spent. Show a new one to try again.",
  },
  expired: {
    title: "That code ran out",
    tone: "watch",
    sentence: "A code lasts two minutes. Show a new one and scan it a little sooner.",
  },
});

/**
 * The one sentence a failure is allowed to be.
 *
 * The backend hands back a typed kind and a sentence for it. Pairing adds the
 * three cases that are about this feature rather than about the transport, and
 * everything else keeps the words the boundary already chose. Nothing here
 * ever renders a raw code at a person.
 */
export function pairingFailureSentence(result) {
  if (result?.reason === "backend_absent") {
    return "This build has no pairing backend, so nothing was started.";
  }
  if (result?.kind === "no_session") {
    return "Sign in again to pair a phone. Nothing was sent.";
  }
  if (result?.kind === "entitlement_required") {
    return "Pairing needs an active Pro entitlement on this device.";
  }
  if (result?.kind === "device_cap_reached") {
    return "This account already has five devices. Revoke one below, then pair again.";
  }
  return result?.message ?? "The pairing service could not be reached.";
}
