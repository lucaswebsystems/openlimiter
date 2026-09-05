/**
 * What the sign in says, in each state it can be in.
 *
 * The sheet and the first run card draw one body, and that body has to have
 * a drawn shape and a sentence for every state a sign in can reach: the
 * moment a browser tab is opening, the answer that a provider is switched off
 * on the service, the session arriving, the account waiting on a confirmation
 * email. A bare "error" where a sentence should be is how a person ends up
 * staring at a dialog wondering whether to press the button again.
 *
 * This module imports nothing. That is what lets the whole vocabulary be
 * checked without a window, a webview or the compiled engine anywhere near
 * it, the same way pairing-states.js is checked.
 */

/** The two providers the body offers, in the order it draws them. */
export const SIGN_IN_PROVIDERS = Object.freeze(["github", "google"]);

/** The tones a status line can take. Each one has a shape in surfaces.css. */
export const SIGN_IN_TONES = Object.freeze(["working", "error", "success", "sent"]);

/** How long the success state stays on screen before the body is put away. */
export const SIGNED_IN_DWELL_MILLISECONDS = 900;

/** The provider's own name, spelled the way the provider spells it. */
export function providerName(provider) {
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  return "";
}

/** The provider that is not this one, for a sentence pointing elsewhere. */
export function otherProvider(provider) {
  return provider === "github" ? "google" : "github";
}

/** What the line says while a browser tab is being opened for a provider. */
export function openingSentence(provider) {
  return "Opening " + providerName(provider) + " in your browser.";
}

export const SIGNING_IN = "Signing in.";
export const CREATING_ACCOUNT = "Creating your account.";

/** The session arrived. Names the address when the service returned one. */
export function signedInSentence(email) {
  const address = typeof email === "string" ? email.trim() : "";
  return address === "" ? "Signed in." : "Signed in as " + address + ".";
}

/**
 * The provider is not switched on, on the service side.
 *
 * The exact sentence the product promises for this: it names the provider
 * that refused and the two ways in that are still open, so nobody is left
 * with a dead button and a shrug.
 */
export function providerDisabledSentence(provider) {
  return (
    providerName(provider) +
    " sign in is not switched on yet. Use " +
    providerName(otherProvider(provider)) +
    " or email."
  );
}

const FALLBACK_SENTENCE =
  "Sign in could not be completed. Check your connection and try again.";

function kindOf(result) {
  if (result === null || typeof result !== "object") return null;
  return typeof result.kind === "string" ? result.kind : null;
}

/**
 * The sentence for a failed result, by the broker's own failure kind.
 *
 * The broker answers with a closed set of kinds and backend.js already turns
 * each into a generic sentence with the kind in brackets. That is right for a
 * log line and wrong for a dialog, so the kinds a sign in can actually produce
 * are given their own words here, and only an unknown kind falls through to
 * whatever the broker said.
 */
export function signInFailureSentence(result, provider) {
  switch (kindOf(result)) {
    case "provider_disabled":
      return providerDisabledSentence(provider);
    case "oauth_timeout":
      return "The browser did not come back in time. Try again and finish in the tab that opens.";
    case "oauth_busy":
      return "Another sign in is already open. Finish that one first.";
    case "oauth_rejected":
      return "The sign in answer could not be verified. Try again.";
    case "authentication":
      return provider === undefined || provider === null
        ? "That email and password were not accepted."
        : "That " + providerName(provider) + " sign in was not accepted. Try again.";
    case "invalid_input":
      return "Enter a valid email address and a password of at least 8 characters.";
    case "email_confirmation_required":
      return "Check your email to confirm the account, then sign in.";
    case "network":
      return "The sign in service could not be reached. Check your connection and try again.";
    case "unconfigured":
      return "Sign in is not configured in this build.";
    default: {
      const message = result?.message;
      return typeof message === "string" && message !== "" ? message : FALLBACK_SENTENCE;
    }
  }
}

/**
 * Which shape a failed result is drawn in.
 *
 * A created account waiting on its confirmation email is not an error: the
 * request did exactly what it should and the next step is in an inbox. It is
 * drawn as a sent state, in the accent, and everything else that fails is red.
 */
export function signInFailureTone(result) {
  return kindOf(result) === "email_confirmation_required" ? "sent" : "error";
}
