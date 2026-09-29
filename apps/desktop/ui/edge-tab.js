/* Native code owns hover, Escape, placement and focus. Both windows consume
   the same local snapshot; this placeholder never displays account identifiers. */
export const EDGE_COPY = Object.freeze({
  title: "OpenLimiter", panelTitle: "Usage and agents", loading: "Loading",
  accounts: "Accounts with readings", sessions: "Agent sessions", attention: "Needs attention",
  placeholder: "Your usage panel will appear here.",
  ready: "Current local activity", unavailable: "Local activity is unavailable.",
});

export function edgeSummary(snapshot) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  // Availability, pressure and waiting are the flags in the current Rail DTO.
  // D1 owns that DTO; no second data policy or account identity inference here.
  const attention = accounts.filter(row => row && (
    (typeof row.availability === "string" && !["available", "unlimited"].includes(row.availability)) ||
    ["orange", "red"].includes(row.band) || row.sessions?.waiting > 0
  )).length + sessions.filter(row => row?.state === "waiting" || row?.outcome === "failed").length;
  return {
    accounts: accounts.filter(row => row?.availability === "available" && Number.isFinite(row.value)).length,
    sessions: sessions.length,
    attention,
  };
}

export function renderEdge(doc, snapshot) {
  const summary = edgeSummary(snapshot);
  const badge = doc.querySelector("#attention");
  if (badge) badge.hidden = summary.attention === 0;
  for (const [id, value] of [["accounts", summary.accounts], ["sessions", summary.sessions], ["attention-count", summary.attention]]) {
    const element = doc.querySelector(`#${id}`);
    if (element) element.textContent = String(value);
  }
  const status = doc.querySelector("#status");
  if (status) status.textContent = EDGE_COPY.ready;
}

export function startEdge(doc, invoke, schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout) {
  let stopped = false;
  let pending = false;
  let timer;
  async function refresh() {
    if (stopped || pending) return;
    cancel(timer);
    pending = true;
    try {
      const snapshot = await invoke("plugin:rail|rail_snapshot", {});
      if (!stopped) renderEdge(doc, snapshot);
    } catch {
      const status = doc.querySelector("#status");
      if (!stopped && status) status.textContent = EDGE_COPY.unavailable;
    } finally {
      pending = false;
      if (!stopped) timer = schedule(refresh, 1000);
    }
  }
  const escape = event => {
    if (event.key === "Escape") void invoke("plugin:rail|rail_card_close", {}).catch(() => {});
  };
  const shown = () => { if (doc.visibilityState !== "hidden") void refresh(); };
  doc.addEventListener("keydown", escape);
  doc.addEventListener("visibilitychange", shown);
  void refresh();
  return () => {
    stopped = true;
    cancel(timer);
    doc.removeEventListener("keydown", escape);
    doc.removeEventListener("visibilitychange", shown);
  };
}

if (typeof document !== "undefined" && globalThis.window?.__TAURI__?.core?.invoke) {
  const stop = startEdge(document, window.__TAURI__.core.invoke);
  window.addEventListener("pagehide", stop, { once: true });
}
