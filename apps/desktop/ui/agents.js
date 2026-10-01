import { agentText } from "./agents.en.js";
import { agentName, agentProvider, duration, say } from "./names.js";

const STATE_KEYS = Object.freeze({ waiting: "stateWaiting", busy: "stateBusy", done: "stateDone", failed: "stateFailed" });
const STATE_ORDER = Object.keys(STATE_KEYS);

/* Constant artwork, one shape per state so colour never answers alone. */
const STATE_ICONS = Object.freeze({
  waiting: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.6 4.6a2.4 2.4 0 0 1 2.4-2.4h6a2.4 2.4 0 0 1 2.4 2.4v4.2a2.4 2.4 0 0 1-2.4 2.4H7.2L4.4 13.6v-2.4h.6A2.4 2.4 0 0 1 2.6 8.8Z" fill="currentColor"/><circle cx="5.6" cy="6.7" r=".9" class="q-dot"/><circle cx="8" cy="6.7" r=".9" class="q-dot"/><circle cx="10.4" cy="6.7" r=".9" class="q-dot"/></svg>',
  busy: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.5" y="7" width="2.4" height="6" rx="1.2" fill="currentColor"/><rect x="6.8" y="3" width="2.4" height="10" rx="1.2" fill="currentColor"/><rect x="11.1" y="5.5" width="2.4" height="7.5" rx="1.2" fill="currentColor"/></svg>',
  done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2"/><path d="m5.3 8.2 1.9 1.9 3.6-3.9"/></svg>',
  failed: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.9v3.5"/><circle cx="8" cy="11" r=".6" fill="currentColor" stroke="none"/></svg>',
});

/**
 * The agents worth a line: needs you, busy, done or failed, in that order.
 * Idle sessions and states this build cannot name are left out rather than
 * shown as unknown. Takes activity records (Home) or the sanitized Rail
 * sessions (the edge panel); null means activity itself is unavailable.
 */
export function agentsModel(sessions, now = Date.now()) {
  if (!Array.isArray(sessions)) return null;
  return sessions.flatMap((session) => {
    if (!session || typeof session.sessionId !== "string") return [];
    const state = session.outcome === "failed" ? "failed" : session.outcome === "cancelled" ? "done" : session.state;
    if (!Object.hasOwn(STATE_KEYS, state)) return [];
    const seconds = Number.isSafeInteger(session.elapsedSeconds) ? session.elapsedSeconds
      : Math.floor((now - Date.parse(session.firstObservedAt)) / 1000);
    return [{
      id: session.sessionId,
      name: agentName(session.agent) ?? say("agentName"),
      provider: agentProvider(session.agent),
      state,
      label: say(STATE_KEYS[state]),
      time: Number.isFinite(seconds) && seconds >= 0 ? duration(seconds) : "",
    }];
  }).sort((left, right) => STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state));
}

/** "2 agents running": the ones busy or waiting for a reply. */
export function runningLabel(agents) {
  if (agents === null) return say("agentsUnavailable");
  const running = agents.filter((agent) => agent.state === "waiting" || agent.state === "busy").length;
  return running === 0 ? say("runningNone") : running === 1 ? say("runningOne") : say("runningMany", { count: running });
}

function node(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function art(doc, className, markup) {
  const element = node(doc, "span", className);
  element.setAttribute("aria-hidden", "true");
  element.innerHTML = markup;
  return element;
}

/**
 * One line per agent, drawn the same on Home and in the edge panel. `markFor`
 * returns a provider's official mark; a waiting agent offers Show app when
 * `locate` is given.
 */
export function renderAgents(doc, mount, agents, { locate, markFor = () => "" } = {}) {
  mount.replaceChildren(...agents.map((agent) => {
    const row = node(doc, "div", "q-agent");
    row.dataset.state = agent.state;
    const mark = art(doc, "q-mark", markFor(agent.provider));
    mark.dataset.provider = agent.provider;
    const info = node(doc, "div", "q-ainfo");
    const state = node(doc, "span", "q-state");
    state.append(art(doc, "q-sico", STATE_ICONS[agent.state]), node(doc, "b", "", agent.label));
    if (agent.time) state.append(node(doc, "span", "q-atime", agent.time));
    info.append(node(doc, "span", "q-aname", agent.name), state);
    row.append(mark, info);
    if (agent.state === "waiting" && locate) {
      const button = node(doc, "button", "q-show", say("showApp"));
      button.type = "button";
      button.addEventListener("click", () => locate(agent.id));
      row.append(button);
    }
    return row;
  }));
}

export function activityClient(invoke = globalThis.__TAURI__?.core?.invoke) {
  const call = (command, args) => typeof invoke === "function" ? invoke(`plugin:activity|${command}`, args) : Promise.reject(new Error("activity unavailable"));
  return {
    sessions: () => call("activity_sessions"),
    locate: (sessionId) => call("activity_locate", { sessionId }),
    preferences: () => call("activity_notification_preferences"),
    savePreferences: (preferences) => call("activity_set_notification_preferences", { preferences }),
  };
}

/** What Show app answered, as a sentence for the status line. */
export function locateSentence(result) {
  const known = ["focused", "flashed", "unavailable", "not_supported_yet"].includes(result) ? result : "unavailable";
  return agentText(`agents.locate.${known}`);
}

/*
 * The host owner calls this once for #agents-mount and calls the disposer on
 * teardown. Home shows the section only while a session exists, so there is
 * no empty card: `onCount` hears how many agents are listed after every read,
 * zero when activity is unavailable.
 */
export function mountAgents(host, { client = activityClient(), t = agentText, now = Date.now, interval = 1000, markFor = () => "", onCount = () => {} } = {}) {
  const doc = host.ownerDocument;
  const card = node(doc, "div", "q-card q-agents");
  const list = node(doc, "div", "q-agent-list");
  list.setAttribute("role", "list");
  const message = node(doc, "p", "q-note");
  message.setAttribute("role", "status");
  card.append(list);
  host.replaceChildren(card, message);
  let disposed = false, timer, busy = false, drawn = "";
  const locate = async (sessionId) => {
    try {
      const result = await client.locate(sessionId);
      if (!disposed) message.textContent = locateSentence(result);
    } catch { if (!disposed) message.textContent = t("agents.locate.unavailable"); }
  };

  async function refresh() {
    if (disposed || busy) return;
    busy = true;
    try {
      const records = await client.sessions();
      if (disposed) return;
      if (!Array.isArray(records)) throw new Error("invalid activity records");
      const agents = agentsModel(records, now());
      // Redraw only when a line changed, so Show app keeps focus between polls.
      const key = JSON.stringify(agents);
      if (key !== drawn) {
        drawn = key;
        renderAgents(doc, list, agents, { locate, markFor });
      }
      onCount(agents.length);
    } catch {
      if (!disposed) {
        drawn = "";
        list.replaceChildren();
        onCount(0);
      }
    } finally {
      busy = false;
      if (!disposed) timer = setTimeout(refresh, interval);
    }
  }
  void refresh();
  return () => { disposed = true; clearTimeout(timer); host.replaceChildren(); };
}
