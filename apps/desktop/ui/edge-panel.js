/*
 * The edge panel's content. Native code owns hover, placement, focus and the
 * delayed close; this file reads the same projection Home reads and draws it
 * with the same functions, so the two can never tell a different story.
 *
 * Native code also sizes the window. After each draw the panel reports the
 * height its content needs, and native clamps that between a minimum and 90%
 * of the screen, so the panel scrolls only past the clamp. It is told when it
 * is shown or hidden, and polls only while it is seen.
 */
import { holdReadings, limitsModel, officialMark, projectReadings, renderLimits, updatedLabel } from "./readings.js";
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

/** Sent by native code whenever the panel is shown (true) or hidden (false). */
export const PANEL_SHOWN_EVENT = "edge-panel-shown";

/**
 * The height the panel's content needs, in CSS pixels: the card's own head and
 * foot (the card as drawn minus the scroller's visible part), plus the content
 * the scroller holds, plus the inset around the card (none where the card
 * fills the window). The content is measured on its own wrapper, never on the
 * scroller: where the card is stretched to the window (macOS) the scroller is
 * as tall as the window whatever it holds, and the panel could never shrink.
 */
export function naturalHeight(card, scroll, content) {
  return Math.ceil(2 * card.offsetTop + card.offsetHeight - scroll.clientHeight + content.offsetHeight);
}

/**
 * Keep the panel current: limits from read_cache and the manual document,
 * agents from the Rail snapshot, redrawn only when something changed so a
 * focused button survives the poll. It draws once at start, so the first open
 * already has its size, then polls only while shown. Returns the disposer.
 */
export function startPanel(doc, tauri, { schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout,
  now = () => new Date().toISOString(), interval = 2000 } = {}) {
  const invoke = tauri.core.invoke;
  const $ = (id) => doc.getElementById(id);
  const view = {
    card: $("panel-card"), scroll: $("panel-scroll"), content: $("panel-content"),
    updated: $("panel-updated"), agents: $("panel-agents"), agentRows: $("panel-agent-rows"), note: $("panel-note"),
    limits: $("panel-limits"), state: $("panel-state"), stateTitle: $("panel-state-title"), stateDetail: $("panel-state-detail"),
    running: $("panel-running"), runningText: $("panel-running-text"), open: $("panel-open"),
  };
  let stopped = false;
  let pending = false;
  let timer;
  let drawnLimits = "";
  let drawnAgents = "";
  let reported = 0;
  // The rows last drawn, so a failed read keeps what is still fresh of them.
  let held = [];
  // Without an event channel the panel cannot know it is hidden, so it keeps
  // polling rather than going stale.
  const listen = tauri.event?.listen;
  let shown = typeof listen !== "function";
  let unlisten = null;

  const reportHeight = () => {
    const height = naturalHeight(view.card, view.scroll, view.content);
    if (!Number.isFinite(height) || height <= 0 || height === reported) return;
    reported = height;
    void Promise.resolve(invoke("plugin:rail|rail_card_height", { height })).catch(() => {});
  };

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
      /* A failed read (native code rejects a cache it cannot read or parse)
         keeps what is still fresh of the rows already drawn, by the one
         freshness policy, exactly as Home does; only nothing left to show
         reads as unavailable. */
      held = cache.status === "rejected"
        ? holdReadings(held, at)
        : projectReadings(cache.value, manual.status === "fulfilled" ? manual.value : null, at).snapshots;
      const model = limitsModel(held, at);
      const limitsKey = JSON.stringify(model);
      if (limitsKey !== drawnLimits) {
        drawnLimits = limitsKey;
        renderLimits(doc, view.limits, model, { compact: true });
      }
      view.limits.hidden = model.length === 0;
      view.updated.textContent = model.length ? updatedLabel(freshestObservation(held), at) : "";
      if (model.length) state(null);
      else if (cache.status === "rejected") state(say("unavailable"));
      else state(say("emptyTitle"), say("emptyPanel"));
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
      reportHeight();
    } finally {
      pending = false;
      if (!stopped && shown) timer = schedule(refresh, interval);
    }
  }

  const close = () => void invoke("plugin:rail|rail_card_close", {}).catch(() => {});
  const openApp = async () => {
    try { await openMainWindow(tauri); } catch { /* The tray still opens the window. */ }
    close();
  };
  const escape = (event) => { if (event.key === "Escape") close(); };
  // Shown: read now and keep reading. Hidden: stop until the next open.
  let heard = false;
  const onShown = (event) => {
    heard = true;
    shown = event?.payload === true;
    cancel(timer);
    if (shown) void refresh();
  };
  view.open.addEventListener("click", openApp);
  doc.addEventListener("keydown", escape);
  if (!shown) {
    Promise.resolve(listen(PANEL_SHOWN_EVENT, onShown)).then(async (stop) => {
      if (stopped) return stop?.();
      unlisten = stop;
      /* A panel already open when the listener arrived missed its shown
         event: the snapshot says whether it is open. An event heard since is
         newer than the snapshot, so it wins. */
      const rail = await Promise.resolve(invoke("plugin:rail|rail_snapshot", {})).catch(() => null);
      if (!stopped && !heard && rail?.window?.cardOpen === true) onShown({ payload: true });
    }).catch(() => { shown = true; void refresh(); });
  }
  void refresh();
  return () => {
    stopped = true;
    cancel(timer);
    unlisten?.();
    view.open.removeEventListener("click", openApp);
    doc.removeEventListener("keydown", escape);
  };
}

if (typeof document !== "undefined" && document.body?.dataset.surface === "panel" && globalThis.window?.__TAURI__?.core?.invoke) {
  // macOS draws this window opaque, so the card fills it there.
  if (/Mac/u.test(navigator.platform)) document.documentElement.classList.add("opaque");
  const stopTheme = followTheme(document, window);
  const stop = startPanel(document, window.__TAURI__);
  window.addEventListener("pagehide", () => { stop(); stopTheme(); }, { once: true });
}
