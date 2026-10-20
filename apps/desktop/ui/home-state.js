import { providerCode } from "./names.js";

/*
 * Which providers Home refreshes and reports to the tray.
 *
 * What Home draws is decided elsewhere, once: projectReadings in readings.js
 * keeps only displayable rows, and the one freshness policy lives in the data
 * rules. This list only answers which providers a person has in play.
 */
const KNOWN = new Set(["CLAUDE", "CODEX", "ANTIGRAVITY", "GEMINI_CLI", "GROK", "KIMI", "OPENROUTER", "OPENCODE", "CURSOR"]);

function code(value) {
  const normalized = providerCode(value);
  return KNOWN.has(normalized) ? normalized : null;
}

export function homeProviders(configured, detections, connections, snapshots, removed = []) {
  return [...new Set([
    ...configured,
    ...(detections?.providers ?? [])
      .filter((entry) => entry.state === "present")
      .map((entry) => code(entry.provider_id)),
    ...connections.map((entry) => code(entry.provider)),
    ...snapshots.map((entry) => code(entry.provider)),
  ].filter((provider) => provider && !removed.includes(provider)))];
}

/**
 * Whether the account card shows under the bars.
 *
 * Only a fresh install is offered it (its first run marks the offer pending),
 * only once a bar is drawn, only after the account has answered, and never to
 * a person who is signed in. Not now, or a sign in, settles it for good.
 */
export function accountOfferShown({ offer, accountKnown, signedIn, hasBars }) {
  return offer === "pending" && accountKnown === true && signedIn !== true && hasBars === true;
}
