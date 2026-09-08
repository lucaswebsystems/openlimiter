// Match request_policy::provider_interval_seconds. Cache repaint cadence is
// unrelated to the interval at which a provider can supply a new observation.
export const REFRESH_SECONDS = Object.freeze({
  CLAUDE: 900, CODEX: 300, ANTIGRAVITY: 600, GEMINI_CLI: 900,
  GROK: 300, KIMI: 300, OPENROUTER: 300,
});

export function homeSnapshots(snapshots, { detections, connections = [], now, failedProviders = [], failedAt = null } = {}) {
  return snapshots.map((snapshot) => {
    const seconds = REFRESH_SECONDS[snapshot.provider];
    const observed = Date.parse(snapshot.observedAt);
    const expires = Date.parse(snapshot.expiresAt);
    if (!seconds || snapshot.source === "manual_entry" ||
        !Number.isFinite(observed) || !Number.isFinite(expires) || expires < observed) {
      return snapshot;
    }
    const unavailable = (failedProviders.includes(snapshot.provider) &&
      (failedAt === null || observed <= Date.parse(failedAt))) || (snapshot.provider === "ANTIGRAVITY" && detections?.antigravity_running === false) ||
      detections?.providers?.some((entry) => code(entry.provider_id) === snapshot.provider && entry.state === "installed_logged_out") ||
      connections.some((entry) => code(entry.provider) === snapshot.provider &&
        (!snapshot.accountId || entry.id === snapshot.accountId) &&
        ["NEEDS_AUTH", "AUTH_EXPIRED", "ERROR", "DEGRADED"].includes(entry.state));
    return { ...snapshot, expiresAt: new Date(unavailable && Date.parse(now) > observed
      ? observed : observed + seconds * 1000).toISOString() };
  });
}

function code(value) {
  const normalized = String(value ?? "").toUpperCase().replaceAll("-", "_");
  return Object.hasOwn(REFRESH_SECONDS, normalized) || normalized === "OPENCODE"
    ? normalized : null;
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

export function pendingReading(provider, detections, connections, pollEnabled) {
  const detected = detections?.providers?.find((entry) => code(entry.provider_id) === provider);
  const name = { CLAUDE: "Claude Code", CODEX: "Codex", ANTIGRAVITY: "Antigravity",
    GEMINI_CLI: "Gemini CLI", GROK: "Grok", KIMI: "Kimi", OPENROUTER: "OpenRouter", OPENCODE: "OpenCode" }[provider] ?? "this provider";
  if (provider === "ANTIGRAVITY") return "Start Antigravity once and this bar refreshes itself.";
  if (provider === "OPENCODE" || provider === "MANUAL") return "Add a current reading in Connections to refresh this bar.";
  if (provider === "OPENROUTER") return "Check your OpenRouter key in Connections to refresh this bar.";
  if (detected?.state === "installed_logged_out" || connections.some((entry) => code(entry.provider) === provider && ["NEEDS_AUTH", "AUTH_EXPIRED"].includes(entry.state))) {
    return `Sign in with ${name} to refresh this bar.`;
  }
  if (provider === "CLAUDE" && pollEnabled === false) return "Open Claude connection to set up its status line and refresh this bar.";
  return `Open ${name} once and this bar refreshes itself.`;
}

export function needsClaudeHelp(row, pollEnabled) {
  return row.provider === "CLAUDE" && pollEnabled === false &&
    (row.windows.length === 0 || row.windows.every((window) => window.state !== "fresh"));
}

export function homeCard(row, { detections, connections, pollEnabled, createRow, openConnection, snapshots = [], now = new Date().toISOString() }, doc = document) {
  const card = doc.createElement("div");
  card.className = "home-provider-card";
  const live = row.windows.some((window) => window.state === "fresh");
  const rendered = createRow(row);
  card.append(rendered);
  const body = rendered.shadowRoot?.querySelector(".row") ?? card;
  if (!live) {
    if (rendered.shadowRoot) {
      const style = doc.createElement("style");
      style.textContent = ".home-reading-state { margin: 0; font-size: var(--ol-text-caption); line-height: 1.5; color: var(--ol-soft); } .home-reading-state + .home-reading-state { margin-top: var(--ol-space-2); } .home-reading-action { margin-top: var(--ol-space-2); color: var(--ol-heading); background: var(--ol-raised); border: 1px solid var(--ol-hairline); border-radius: var(--ol-radius-md); padding: var(--ol-space-2); font: inherit; cursor: pointer; }" +
        (row.windows.length === 0 ? ".column-label, .windows { display: none; } .identity { border-bottom: 0; }" : "");
      rendered.shadowRoot.append(style);
    }
    const last = snapshots.filter((snapshot) => snapshot.provider === row.provider &&
      (snapshot.accountId ?? null) === row.accountId).map((snapshot) => Date.parse(snapshot.observedAt)).filter(Number.isFinite);
    const age = doc.createElement("p");
    age.className = "home-reading-state";
    const minutes = last.length ? Math.max(0, Math.floor((Date.parse(now) - Math.max(...last)) / 60000)) : null;
    age.textContent = minutes === null ? "No reading yet." : minutes < 1 ? "Last seen just now." :
      minutes < 60 ? `Last seen ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago.` :
      `Last seen ${Math.floor(minutes / 60)} ${minutes < 120 ? "hour" : "hours"} ago.`;
    body.append(age);
    const state = doc.createElement("p");
    state.className = "home-reading-state";
    state.textContent = pendingReading(row.provider, detections, connections, pollEnabled);
    body.append(state);
    if (needsClaudeHelp(row, pollEnabled)) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "home-reading-action";
      button.textContent = "Open Claude connection";
      button.addEventListener("click", () => openConnection("claude"));
      body.append(button);
    }
  }
  return card;
}
