/*
 * The edge panel's content. Native code owns hover, placement, focus and the
 * delayed close; this file reads the same projection Home reads and draws it
 * with the same functions, so the two can never tell a different story.
 *
 * Native code also sizes the window. Whenever its content changes size the
 * panel reports the height it needs, and native gives it that height up to
 * the whole work area, so the panel scrolls only on a screen too short for
 * it. It is told when it is shown or hidden, and polls only while it is seen.
 *
 * Its blocks follow the provider order every surface shares, and move by
 * their grips (reorder.js). The panel never takes focus, so it gets the
 * pointer drag and the grip's menu; while either is under way it holds itself
 * open, and a native Escape ends the drag or the menu before the panel.
 */
import { holdReadings, limitsKey, limitsModel, officialMark, patchLimits, projectReadings, renderLimits, updatedLabel } from "./readings.js";
import { createOrderStore, ORDER_CHANGED_EVENT, reorderList } from "./reorder.js";
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
/** Sent by native code when it ends the panel's hold: an Escape while held,
    or the pointer away from an open menu. */
export const PANEL_RELEASE_EVENT = "edge-panel-release";
export const COLLECTOR_UPDATED_EVENT = "collector-updated";

/**
 * The height the panel's content needs, in CSS pixels: the card's own head and
 * foot (the card as drawn minus the scroller's visible part), plus the content
 * the scroller holds, plus the inset around the card (none where the card
 * fills the window). The content is measured on its own wrapper, never on the
 * scroller: where the card is stretched to the window (macOS) the scroller is
 * as tall as the window whatever it holds, and the panel could never shrink.
 * Boxes are measured unrounded and the sum rounded up once: rounded heights
 * can come out a fraction short, and a fraction short is a scrollbar.
 */
export function naturalHeight(card, scroll, content) {
  const height = (element) => element.getBoundingClientRect().height;
  return Math.ceil(2 * card.offsetTop + height(card) - height(scroll) + height(content));
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
  // Asked again while a read was under way: one more read when it ends.
  let again = false;
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
  // Rows that change size after a draw (a font arriving, a line wrapping) report too.
  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => reportHeight()) : null;
  resized?.observe(view.content);

  /* The order, through the same two commands and event as the window. */
  const settled = (promise) => Promise.resolve(promise).then((value) => ({ ok: true, value }), () => ({ ok: false }));
  const order = createOrderStore({
    read: () => settled(invoke("provider_order")),
    write: (input) => settled(invoke("set_provider_order", { input })),
    listen: typeof listen === "function" ? (handler) => listen(ORDER_CHANGED_EVENT, handler) : null,
  });
  const list = reorderList(doc, view.limits, {
    store: order,
    render: (model) => renderLimits(doc, view.limits, model, { compact: true, grips: true }),
    hold: (held, kind) => void Promise.resolve(invoke("plugin:rail|rail_card_hold", { held, menu: kind === "menu" })).catch(() => {}),
    scroller: view.scroll,
  });

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
    if (stopped) return;
    if (pending) {
      again = true;
      return;
    }
    cancel(timer);
    pending = true;
    again = false;
    const at = now();
    try {
      const [cache, manual, rail, poll] = await Promise.allSettled([
        invoke("read_cache"), invoke("read_manual"), invoke("plugin:rail|rail_snapshot", {}), invoke("claude_poll_enabled"),
      ]);
      if (stopped) return;
      /* A failed read (native code rejects a cache it cannot read or parse)
         keeps what is still fresh of the rows already drawn, by the one
         freshness policy and the Claude request switch as it stands now,
         exactly as Home does; only nothing left to show reads as
         unavailable. */
      held = cache.status === "rejected"
        ? holdReadings(held, at, poll.status === "fulfilled" && poll.value?.enabled === true)
        : projectReadings(cache.value, manual.status === "fulfilled" ? manual.value : null, at).snapshots;
      const model = limitsModel(held, at, order.state);
      // With the order's generation: a save that did not land redraws from the order on disk.
      const key = limitsKey(model) + "@" + order.generation;
      if (key !== drawnLimits) {
        drawnLimits = key;
        list.draw(model);
      } else {
        patchLimits(view.limits, model, { compact: true });
      }
      view.limits.hidden = model.length === 0;
      view.updated.textContent = model.length ? updatedLabel(freshestObservation(held), at) : "";
      if (model.length) state(null);
      else if (cache.status === "rejected") state(say("unavailable"));
      else state(say("emptyTitle"), say("emptyPanel"));
      const sessions = rail.status === "fulfilled" && Array.isArray(rail.value?.sessions) ? rail.value.sessions : null;
      const agents = agentsModel(sessions, Date.parse(at));
      const agentKey = JSON.stringify(agents);
      if (agentKey !== drawnAgents) {
        drawnAgents = agentKey;
        renderAgents(doc, view.agentRows, agents ?? [], { locate, markFor: officialMark });
      }
      view.agents.hidden = !agents?.length;
      view.runningText.textContent = runningLabel(agents);
      view.running.toggleAttribute("data-live", Boolean(agents?.some((agent) => agent.state === "waiting" || agent.state === "busy")));
      reportHeight();
    } finally {
      pending = false;
      if (!stopped && again) void refresh();
      else if (!stopped && shown) timer = schedule(refresh, interval);
    }
  }

  const close = () => void invoke("plugin:rail|rail_card_close", {}).catch(() => {});
  const openApp = async () => {
    try { await openMainWindow(tauri); } catch { /* The tray still opens the window. */ }
    close();
  };
  // A drag or the reorder menu takes Escape first; only then is it the panel's.
  const escape = (event) => { if (event.key === "Escape" && !list.escape()) close(); };
  // Shown: read now and keep reading. Hidden: stop until the next open.
  let heard = false;
  const onShown = (event) => {
    heard = true;
    shown = event?.payload === true;
    cancel(timer);
    if (shown) void refresh();
    else list.cancel();
  };
  view.open.addEventListener("click", openApp);
  doc.addEventListener("keydown", escape);
  const unlisteners = [];
  const hear = (name, handler) => {
    if (typeof listen !== "function") return;
    Promise.resolve(listen(name, handler)).then((stop) => {
      if (stopped) return stop?.();
      unlisteners.push(stop);
    }).catch(() => {});
  };
  /* Every collector pass, and the startup rescan, reads again, shown or not,
     so a hidden panel never opens on a projection made before detection. */
  hear(COLLECTOR_UPDATED_EVENT, () => void refresh());
  hear(PANEL_RELEASE_EVENT, () => list.cancel());
  // An order written here, in the window or in Settings: draw it.
  const unsubscribe = order.subscribe(() => void refresh());
  void order.load();

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
    unlisteners.forEach((stop) => stop?.());
    unsubscribe();
    list.dispose();
    order.dispose();
    resized?.disconnect();
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
