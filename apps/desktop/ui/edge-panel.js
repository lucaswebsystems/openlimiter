/*
 * The edge panel's content. Native code owns hover, placement, focus and the
 * delayed close; this file reads the same projection Home reads and draws it
 * with the same functions, so the two can never tell a different story.
 */
import { limitsModel, officialMark, projectReadings, renderLimits, updatedLabel } from "./readings.js";
import { agentsModel, locateSentence, renderAgents, runningLabel } from "./agents.js";
import { freshestObservation } from "./home-refresh.js";
import { say } from "./names.js";
import { followTheme } from "./edge-tab.js";

/** Bring the main window forward; resolves false when it does not exist. */
export async function openMainWindow(tauri) {
  const main = await tauri?.window?.Window?.getByLabel("main");
  if (!main) return false;
  await main.show();
  await main.unminimize();
  await main.setFocus();
  return true;
}

/**
 * Keep the panel current: limits from read_cache and the manual document,
 * agents from the Rail snapshot, redrawn only when something changed so a
 * focused button survives the poll. Returns the disposer.
 */
export function startPanel(doc, tauri, { schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout,
  now = () => new Date().toISOString(), interval = 2000 } = {}) {
  const invoke = tauri.core.invoke;
  const $ = (id) => doc.getElementById(id);
  const view = {
    updated: $("panel-updated"), agents: $("panel-agents"), agentRows: $("panel-agent-rows"), note: $("panel-note"),
    limits: $("panel-limits"), state: $("panel-state"), stateTitle: $("panel-state-title"), stateDetail: $("panel-state-detail"),
    running: $("panel-running"), runningText: $("panel-running-text"), open: $("panel-open"),
  };
  let stopped = false;
  let pending = false;
  let timer;
  let drawnLimits = "";
  let drawnAgents = "";

  const state = (title, detail = "") => {
    view.state.hidden = title === null;
    view.stateTitle.textContent = title ?? "";
    view.stateDetail.textContent = detail;
  };
  const locate = async (sessionId) => {
    let result;
    try { result = await invoke("plugin:activity|activity_locate", { sessionId }); } catch { result = "unavailable"; }
    if (!stopped) view.note.textContent = locateSentence(result);
  };

  async function refresh() {
    if (stopped || pending) return;
    cancel(timer);
    pending = true;
    const at = now();
    try {
      const [cache, manual, rail] = await Promise.allSettled([
        invoke("read_cache"), invoke("read_manual"), invoke("plugin:rail|rail_snapshot", {}),
      ]);
      if (stopped) return;
      if (cache.status === "rejected") {
        drawnLimits = "";
        view.limits.hidden = true;
        view.updated.textContent = "";
        state(say("unavailable"));
      } else {
        const readings = projectReadings(cache.value, manual.status === "fulfilled" ? manual.value : null, at);
        const model = limitsModel(readings.snapshots, at);
        const key = JSON.stringify(model);
        if (key !== drawnLimits) {
          drawnLimits = key;
          renderLimits(doc, view.limits, model, { compact: true });
        }
        view.limits.hidden = model.length === 0;
        view.updated.textContent = model.length ? updatedLabel(freshestObservation(readings.snapshots), at) : "";
        if (model.length) state(null);
        else state(say("emptyTitle"), say("emptyPanel"));
      }
      const sessions = rail.status === "fulfilled" && Array.isArray(rail.value?.sessions) ? rail.value.sessions : null;
      const agents = agentsModel(sessions, Date.parse(at));
      const key = JSON.stringify(agents);
      if (key !== drawnAgents) {
        drawnAgents = key;
        renderAgents(doc, view.agentRows, agents ?? [], { locate, markFor: officialMark });
      }
      view.agents.hidden = !agents?.length;
      view.runningText.textContent = runningLabel(agents);
      view.running.toggleAttribute("data-live", Boolean(agents?.some((agent) => agent.state === "waiting" || agent.state === "busy")));
    } finally {
      pending = false;
      if (!stopped) timer = schedule(refresh, interval);
    }
  }

  const close = () => void invoke("plugin:rail|rail_card_close", {}).catch(() => {});
  const openApp = async () => {
    try { await openMainWindow(tauri); } catch { /* The tray still opens the window. */ }
    close();
  };
  const escape = (event) => { if (event.key === "Escape") close(); };
  const shown = () => { if (doc.visibilityState !== "hidden") void refresh(); };
  view.open.addEventListener("click", openApp);
  doc.addEventListener("keydown", escape);
  doc.addEventListener("visibilitychange", shown);
  void refresh();
  return () => {
    stopped = true;
    cancel(timer);
    view.open.removeEventListener("click", openApp);
    doc.removeEventListener("keydown", escape);
    doc.removeEventListener("visibilitychange", shown);
  };
}

if (typeof document !== "undefined" && document.body?.dataset.surface === "panel" && globalThis.window?.__TAURI__?.core?.invoke) {
  // macOS draws this window opaque, so the card fills it there.
  if (/Mac/u.test(navigator.platform)) document.documentElement.classList.add("opaque");
  const stopTheme = followTheme(document, window);
  const stop = startPanel(document, window.__TAURI__);
  window.addEventListener("pagehide", () => { stop(); stopTheme(); }, { once: true });
}
