// Match request_policy::provider_interval_seconds. Cache repaint cadence is
// unrelated to the interval at which a provider can supply a new observation.
export const REFRESH_SECONDS = Object.freeze({
  CLAUDE: 900, CODEX: 300, ANTIGRAVITY: 600, GEMINI_CLI: 900,
  GROK: 300, KIMI: 300, OPENROUTER: 300,
});

export function homeSnapshots(snapshots) {
  return snapshots.map((snapshot) => {
    const seconds = REFRESH_SECONDS[snapshot.provider];
    const observed = Date.parse(snapshot.observedAt);
    const expires = Date.parse(snapshot.expiresAt);
    if (!seconds || snapshot.source === "manual_entry" ||
        !Number.isFinite(observed) || !Number.isFinite(expires) || expires < observed) {
      return snapshot;
    }
    return { ...snapshot, expiresAt: new Date(observed + seconds * 1000).toISOString() };
  });
}

function code(value) {
  const normalized = String(value ?? "").toUpperCase().replaceAll("-", "_");
  return Object.hasOwn(REFRESH_SECONDS, normalized) || normalized === "OPENCODE"
    ? normalized : null;
}

export function homeProviders(configured, detections, connections, snapshots) {
  return [...new Set([
    ...configured,
    ...(detections?.providers ?? [])
      .filter((entry) => entry.state === "present" || entry.state === "installed_logged_out")
      .map((entry) => code(entry.provider_id)),
    ...connections.map((entry) => code(entry.provider)),
    ...snapshots.map((entry) => code(entry.provider)),
  ].filter(Boolean))];
}

export function pendingReading(provider, detections, connections) {
  const detected = detections?.providers?.find((entry) => code(entry.provider_id) === provider);
  if (detected?.state === "installed_logged_out") return "Not signed in with the CLI";
  if (provider === "ANTIGRAVITY" && detections?.antigravity_running === false) {
    return "Antigravity is not running";
  }
  if (detected?.state === "present" || connections.some((entry) => code(entry.provider) === provider)) {
    return "Signed in, first reading pending";
  }
  return "No reading available";
}

export function needsClaudeHelp(row, pollEnabled) {
  return row.provider === "CLAUDE" && pollEnabled === false &&
    (row.windows.length === 0 || row.windows.every((window) => window.state !== "fresh"));
}

export function claudeReadingHelp(openConnection, doc = document) {
  const help = doc.createElement("div");
  help.className = "claude-reading-help";
  const sentence = doc.createElement("p");
  sentence.textContent = "Claude readings arrive from Claude Code's status line or from the poll.";
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "Open Claude connection";
  button.addEventListener("click", () => openConnection("claude"));
  help.append(sentence, button);
  return help;
}

export function homeCard(row, { detections, connections, pollEnabled, createRow, openConnection }, doc = document) {
  const card = doc.createElement("div");
  card.className = "home-provider-card";
  card.append(createRow(row));
  if (row.windows.length === 0) {
    const state = doc.createElement("p");
    state.className = "home-reading-state";
    state.textContent = pendingReading(row.provider, detections, connections);
    card.append(state);
  }
  if (needsClaudeHelp(row, pollEnabled)) card.append(claudeReadingHelp(openConnection, doc));
  return card;
}
