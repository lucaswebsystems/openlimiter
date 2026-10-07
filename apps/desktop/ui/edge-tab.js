/* Native code owns hover, Escape, placement and focus. The tab shows the mark
   and, when something needs a look now, one small pill; it never displays an
   account identifier. */
import { say } from "./names.js";

/** A saved theme wins; otherwise the tab and panel follow the system, as the desktop around them does. */
export function followTheme(doc, win) {
  const system = win.matchMedia("(prefers-color-scheme: light)");
  const apply = () => {
    let saved;
    try { saved = win.localStorage.getItem("openlimiter-theme"); } catch { /* Use the system preference. */ }
    doc.documentElement.dataset.theme = ["light", "dark"].includes(saved) ? saved : system.matches ? "light" : "dark";
  };
  apply();
  system.addEventListener("change", apply);
  win.addEventListener("storage", apply);
  return () => { system.removeEventListener("change", apply); win.removeEventListener("storage", apply); };
}

export function edgeSummary(snapshot) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  // A limit at 80 percent or more, or an agent waiting or failed: something to
  // look at now. Connections flags wait for the Connections tab.
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
  const tab = doc.querySelector(".edge-tab");
  tab?.classList.toggle("open", snapshot?.window?.cardOpen === true);
  tab?.setAttribute("aria-label", summary.attention ? `OpenLimiter, ${say("attentionTitle")}` : "OpenLimiter");
}

export function startEdge(doc, invoke, schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout) {
  let stopped = false;
  let pending = false;
  let timer;
  async function refresh() {
    if (stopped || pending) return;
    cancel(timer);
    pending = true;
    let interval = 1000;
    try {
      const snapshot = await invoke("plugin:rail|rail_snapshot", {});
      if (!stopped) renderEdge(doc, snapshot);
      if (snapshot && snapshot.window && snapshot.window.visible === false) {
        interval = 10000;
      }
    } catch {
      // Keep the last state; the next poll tries again.
    } finally {
      pending = false;
      if (!stopped) timer = schedule(refresh, interval);
    }
  }
  const shown = () => { if (doc.visibilityState !== "hidden") void refresh(); };
  doc.addEventListener("visibilitychange", shown);
  void refresh();
  return () => {
    stopped = true;
    cancel(timer);
    doc.removeEventListener("visibilitychange", shown);
  };
}

if (typeof document !== "undefined" && document.body?.dataset.surface === "tab" && globalThis.window?.__TAURI__?.core?.invoke) {
  if (/Mac/u.test(navigator.platform)) document.documentElement.classList.add("opaque");
  const stopTheme = followTheme(document, window);
  const stop = startEdge(document, window.__TAURI__.core.invoke);
  window.addEventListener("pagehide", () => { stop(); stopTheme(); }, { once: true });
}
