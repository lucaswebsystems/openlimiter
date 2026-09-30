import { providerCode } from "./names.js";

/*
 * Which providers Home refreshes and reports to the tray.
 *
 * What Home draws is decided elsewhere, once: projectReadings in readings.js
 * keeps only displayable rows, and the one freshness policy lives in the data
 * rules. This list only answers which providers a person has in play.
 */
const KNOWN = new Set([
  "CLAUDE", "CODEX", "ANTIGRAVITY", "GEMINI_CLI", "GROK", "KIMI", "OPENROUTER", "OPENCODE", "CURSOR",
  /* The 2.1 providers join when they are switched on. Each lane adds its codes
     below its own line. */
  // 2.1 lane P1a
  // 2.1 lane P1b
  // 2.1 lane P1c
]);

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
