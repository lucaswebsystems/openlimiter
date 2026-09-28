import { agentText } from "./agents.en.js";

export const AGENT_NAMES = Object.freeze({ claude_code: "Claude", codex: "Codex", muse: "Muse", cursor: "Cursor", gemini_cli: "Gemini CLI", kimi: "Kimi", grok: "Grok", antigravity: "Antigravity" });
const PROVIDERS = { claude_code: "CLAUDE", codex: "CODEX", muse: "MUSE", cursor: "CURSOR", gemini_cli: "GEMINI_CLI", kimi: "KIMI", grok: "GROK", antigravity: "ANTIGRAVITY" };
const SHAPES = { busy: "◔", waiting: "!", done: "✓", idle: "○", unknown: "?" };

export function agentRow(record, now = Date.now(), t = agentText) {
  const state = Object.hasOwn(SHAPES, record.state) ? record.state : "unknown";
  const start = Date.parse(record.firstObservedAt);
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const time = seconds < 3600 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const outcome = ["cancelled", "failed"].includes(record.outcome) ? ` (${t(`agents.outcome.${record.outcome}`)})` : "";
  return { sessionId: record.sessionId, name: Object.hasOwn(AGENT_NAMES, record.agent) ? AGENT_NAMES[record.agent] : t("agents.agent.unknown"), state,
    shape: SHAPES[state], label: t(`agents.state.${state}`) + outcome, computer: t("agents.computer"),
    elapsed: Number.isFinite(start) ? t("agents.elapsed", { time }) : t("agents.elapsedUnknown") };
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

// The host owner calls this once for #agents-mount and calls the disposer on teardown.
export function mountAgents(host, { client = activityClient(), t = agentText, now = Date.now, interval = 1000 } = {}) {
  const doc = host.ownerDocument;
  const node = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const section = node("section", undefined, "agents-panel");
  const title = node("h2", t("agents.title"));
  const list = node("ul", undefined, "agents-list");
  const message = node("p"); message.setAttribute("role", "status");
  const settings = node("details", undefined, "agents-preferences");
  settings.append(node("summary", t("agents.alerts")));
  section.append(title, list, message, settings); host.replaceChildren(section);
  let disposed = false, timer, busy = false;
  const rows = new Map();

  async function refresh() {
    if (disposed || busy) return;
    busy = true;
    try {
      const records = await client.sessions();
      if (disposed) return;
      if (!Array.isArray(records)) throw new Error("invalid activity records");
      const seen = new Set();
      for (const record of records) {
        if (!record || typeof record.sessionId !== "string") continue;
        const model = agentRow(record, now(), t); seen.add(model.sessionId);
        let row = rows.get(model.sessionId);
        if (!row) {
          const li = node("li", undefined, "agents-row");
          const mark = node("span", undefined, "agents-mark"); mark.setAttribute("aria-hidden", "true");
          const name = node("strong"); const state = node("span", undefined, "agents-state");
          const elapsed = node("span"); const computer = node("span");
          const button = node("button", t("agents.locate")); button.type = "button";
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              const result = await client.locate(model.sessionId);
              const known = ["focused", "flashed", "unavailable", "not_supported_yet"].includes(result) ? result : "unavailable";
              if (!disposed) message.textContent = t(`agents.locate.${known}`);
            } catch { if (!disposed) message.textContent = t("agents.locate.unavailable"); }
            finally { button.disabled = false; }
          });
          li.append(mark, name, state, elapsed, computer, button);
          row = { li, mark, name, state, elapsed, computer }; rows.set(model.sessionId, row); list.append(li);
        }
        row.li.dataset.state = model.state;
        row.mark.textContent = model.name.slice(0, 2);
        row.name.textContent = model.name;
        row.state.textContent = `${model.shape} ${model.label}`;
        row.elapsed.textContent = model.elapsed; row.computer.textContent = model.computer;
      }
      for (const [id, row] of rows) if (!seen.has(id)) { row.li.remove(); rows.delete(id); }
      if (!rows.size) message.textContent = t("agents.empty");
      else if ([t("agents.empty"), t("agents.unavailable")].includes(message.textContent)) message.textContent = "";
    } catch {
      if (!disposed) { list.replaceChildren(); rows.clear(); message.textContent = t("agents.unavailable"); }
    } finally {
      busy = false;
      if (!disposed) timer = setTimeout(refresh, interval);
    }
  }

  async function preferences() {
    try {
      const saved = await client.preferences(); if (disposed) return;
      const form = node("form");
      const field = (key, type, value) => {
        const label = node("label", t(key)); const input = node("input"); input.type = type;
        if (type === "checkbox") input.checked = value; else input.value = value;
        label.append(input); form.append(label); return input;
      };
      const enabled = field("agents.enabled", "checkbox", saved.local.enabled);
      const soundLabel = node("label", t("agents.sound")); const sound = node("select");
      for (const value of ["default", "silent"]) { const option = node("option", t(`agents.sound.${value}`)); option.value = value; sound.append(option); }
      sound.value = saved.sound; soundLabel.append(sound); form.append(soundLabel);
      const quiet = field("agents.quiet", "checkbox", saved.local.quietHours !== null);
      const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      const start = field("agents.quietStart", "time", clock(saved.local.quietHours?.startMinute ?? 1320)); start.required = true;
      const end = field("agents.quietEnd", "time", clock(saved.local.quietHours?.endMinute ?? 420)); end.required = true;
      const mutes = Object.entries(PROVIDERS).map(([agent, provider]) => {
        const label = node("label", t("agents.mute", { agent: AGENT_NAMES[agent] })); const input = node("input");
        input.type = "checkbox"; input.checked = saved.local.mutedProviders.includes(provider); label.append(input); form.append(label);
        return { input, provider };
      });
      const submit = node("button", t("agents.save")); submit.type = "submit"; form.append(submit); settings.append(form);
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); submit.disabled = true;
        const minutes = (input) => input.value.split(":").reduce((h, m) => h * 60 + Number(m), 0);
        const preferences = { local: { ...saved.local, enabled: enabled.checked, mutedProviders: mutes.filter(({ input }) => input.checked).map(({ provider }) => provider),
          quietHours: quiet.checked ? { startMinute: minutes(start), endMinute: minutes(end), utcOffsetMinutes: -new Date(now()).getTimezoneOffset() } : null }, sound: sound.value };
        try { await client.savePreferences(preferences); if (!disposed) message.textContent = t("agents.saved"); }
        catch { if (!disposed) message.textContent = t("agents.saveError"); }
        finally { submit.disabled = false; }
      });
    } catch { if (!disposed) settings.append(node("p", t("agents.preferencesUnavailable"))); }
  }
  void refresh(); void preferences();
  return () => { disposed = true; clearTimeout(timer); host.replaceChildren(); };
}
