/* Rust owns hover, geometry, full screen state and persistence. No window API
   permissions, remote assets, HTML interpolation or fabricated quota readings. */
export const RAIL_COPY = {
  title: "Usage and agents", loading: "Loading", empty: "No accounts",
  emptyDetail: "No accounts yet. Add an account in Settings.",
  signedOut: "Signed out", unknown: "Unknown", stale: "Stale", unlimited: "Unlimited",
  sessions: "Agent sessions",
  ageUnavailable: "Age unavailable", fresh: "Fresh", used: "used", remaining: "remaining",
  busy: "Working", waiting: "Needs you", done: "Done", idle: "Idle",
  waitingDetail: "Waiting for your input", busyDetail: "Agent is working",
  doneDetail: "Agent finished", idleDetail: "Agent is idle", unknownDetail: "Agent state unknown",
  agentsUnavailable: "Agent activity unavailable", noSessions: "No agent sessions",
  unavailable: "Rail unavailable", keep: "Keep open", hide: "Hide", close: "Close card",
  reset: "Reset", resetUnavailable: "Reset unavailable", resetPending: "Awaiting updated reading",
  ageSeconds: "{count} sec ago", ageMinutes: "{count} min ago", ageHours: "{count} h ago", ageDays: "{count} d ago",
  estimated: "estimated", manual: "manual", cancelled: "Cancelled", failed: "Failed",
};

const MARKS = new Set(["claude", "codex", "antigravity", "openrouter", "gemini", "opencode", "grok", "kimi", "manual"]);
const formatCount = (copy, count) => copy.replace("{count}", String(count));

export function ageLabel(instant, now = Date.now()) {
  const at = Date.parse(instant);
  if (!Number.isFinite(at) || at > now) return RAIL_COPY.ageUnavailable;
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 60) return formatCount(RAIL_COPY.ageSeconds, seconds);
  if (seconds < 3600) return formatCount(RAIL_COPY.ageMinutes, Math.floor(seconds / 60));
  if (seconds < 86400) return formatCount(RAIL_COPY.ageHours, Math.floor(seconds / 3600));
  return formatCount(RAIL_COPY.ageDays, Math.floor(seconds / 86400));
}

export function accountView(row) {
  const signedOut = ["missing_credentials", "expired_credentials"].includes(row.availability);
  const numeric = row.availability === "available" && Number.isFinite(row.value) && row.value >= 0 &&
    (row.kind !== "quota_percent" || row.value <= 100);
  const reading = signedOut ? RAIL_COPY.signedOut : row.availability === "unlimited" ? RAIL_COPY.unlimited : numeric
    ? `${row.value}${row.kind === "quota_percent" ? "%" : ""}` : RAIL_COPY.unknown;
  const percent = numeric && row.kind === "quota_percent";
  const fill = percent ? (row.meaning === "remaining" ? 100 - row.value : row.value) : 0;
  const stale = !signedOut && row.freshness === "stale";
  const band = signedOut || row.availability === "unlimited" ? "none" : row.freshness !== "fresh" ? "stale" : percent && ["green", "yellow", "orange", "red"].includes(row.band) ? row.band : "none";
  const meaning = row.meaning === "remaining" ? RAIL_COPY.remaining : RAIL_COPY.used;
  return { reading, meaning: numeric ? meaning : "", fill, band, stale,
    // SurfaceAccountRow carries no observation timestamp or currency. Never
    // infer age from resetAt, or turn a balance into dollars or a percentage.
    age: stale ? RAIL_COPY.ageUnavailable : "",
    label: `${row.provider}${row.account ? `, ${row.account}` : ""}: ${reading}${numeric ? ` ${meaning}` : ""} (${row.windowLabel})` };
}

export function accountLabel(row) { return accountView(row).label; }

function node(doc, tag, className, text) {
  const element = doc.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function tab(doc, isCard, open, label) {
  const element = node(doc, isCard ? "section" : "button", "tab");
  element.setAttribute("aria-label", label);
  element.setAttribute("title", label);
  if (!isCard) {
    element.type = "button";
    const show = () => open(Math.max(0, Math.min(320, element.getBoundingClientRect().top)));
    for (const event of ["pointerenter", "focus", "click"]) element.addEventListener(event, show);
  }
  return element;
}

function messageTab(doc, isCard, open, title, detail = title) {
  const element = tab(doc, isCard, open, detail);
  element.setAttribute("data-band", "none");
  const body = node(doc, "span", "t-body");
  body.append(node(doc, "span", "t-num", title));
  element.append(body, node(doc, "p", "detail", detail), node(doc, "span", "t-edge"));
  return element;
}

export function renderAccounts(doc, mount, rows, isCard, open, now = Date.now()) {
  mount.replaceChildren();
  if (!rows.length) mount.append(messageTab(doc, isCard, open, RAIL_COPY.empty, RAIL_COPY.emptyDetail));
  for (const row of rows) {
    const view = accountView(row);
    const element = tab(doc, isCard, open, view.label);
    element.setAttribute("data-band", view.band);
    element.setAttribute("data-p", row.provider);
    const body = node(doc, "span", "t-body");
    const provider = row.provider === "gemini-cli" ? "gemini" : row.provider;
    if (MARKS.has(provider)) {
      const multicolor = ["antigravity", "gemini"].includes(provider);
      const mark = node(doc, multicolor ? "img" : "span", `t-mark mark-${provider}`);
      if (multicolor) { mark.src = `marks/${provider}.svg`; mark.alt = row.provider; }
      else { mark.setAttribute("role", "img"); mark.setAttribute("aria-label", row.provider); }
      body.append(mark);
    } else body.append(node(doc, "span", "t-cap", row.provider));
    body.append(node(doc, "span", "t-num", view.reading), node(doc, "span", "t-cap", view.meaning));
    if (view.stale) body.append(node(doc, "span", "t-age", RAIL_COPY.stale));
    const edge = node(doc, "span", "t-edge");
    edge.setAttribute("aria-hidden", "true");
    edge.style.setProperty("--meter", `${view.fill}%`);
    edge.append(node(doc, "span", "fill"));
    const reset = Date.parse(row.resetAt);
    const resetText = !Number.isFinite(reset) ? RAIL_COPY.resetUnavailable : reset <= now ? RAIL_COPY.resetPending
      : `${RAIL_COPY.reset}: ${new Date(reset).toLocaleString()}`;
    const detail = [view.label, view.stale ? `${RAIL_COPY.stale}. ${view.age}` : row.freshness === "fresh" ? RAIL_COPY.fresh : RAIL_COPY.unknown,
      row.fidelityMarker ? RAIL_COPY[row.fidelityMarker] ?? RAIL_COPY.unknown : "", resetText].filter(Boolean).join(". ");
    element.append(body, edge, node(doc, "p", "detail", detail));
    mount.append(element);
  }
}

export function renderSessions(doc, mount, sessions, isCard, open, now = Date.now()) {
  mount.replaceChildren();
  if (sessions === null) {
    mount.append(messageTab(doc, isCard, open, RAIL_COPY.unknown, RAIL_COPY.agentsUnavailable));
    return;
  }
  if (!sessions.length && isCard) mount.append(node(doc, "p", "sess-detail", RAIL_COPY.noSessions));
  // Sanitized activity records have no account identity. Keep them separate
  // from quota tabs rather than assigning a session to an arbitrary account.
  for (const session of sessions) {
    const state = ["busy", "waiting", "done", "idle"].includes(session.state) ? session.state : "unknown";
    const outcome = ["cancelled", "failed"].includes(session.outcome) ? RAIL_COPY[session.outcome] : "";
    const title = outcome || RAIL_COPY[state];
    const detail = [session.agent, session.userProjectLabel, outcome || RAIL_COPY[`${state}Detail`],
      ageLabel(session.observedAt, now)].filter(Boolean).join(". ");
    const element = tab(doc, isCard, open, detail);
    element.setAttribute("data-agent", state);
    element.setAttribute("data-band", "none");
    const body = node(doc, "span", "t-body");
    const glyph = node(doc, "span", "agent-glyph", state === "done" ? (outcome ? "!" : "✓") : state === "waiting" ? "?" : state === "unknown" ? "?" : "");
    glyph.setAttribute("aria-hidden", "true");
    if (state === "busy") for (let i = 0; i < 3; i++) glyph.append(node(doc, "i", ""));
    body.append(glyph, node(doc, "span", "t-num", title), node(doc, "span", "t-cap", session.agent));
    element.append(body, node(doc, "p", "sess-detail", detail));
    mount.append(element);
  }
}

export function dragOffset(startOffset, startScreen, currentScreen) {
  return Math.min(100000, Math.max(0, startOffset + currentScreen - startScreen));
}

export function startRail(doc, invoke, search = "") {
  const isCard = new URLSearchParams(search).has("card");
  const accounts = doc.querySelector("#accounts");
  const sessions = doc.querySelector("#sessions");
  const keep = doc.querySelector("#keep");
  const close = doc.querySelector("#close");
  const grip = doc.querySelector("#grip");
  const status = doc.querySelector("#status");
  let snapshot;
  let rowsKey;
  let sessionsKey;
  let cardOpen = false;
  let drag;
  let pendingOffset;
  let moving = false;
  let disposed = false;
  let timer;
  const call = async (command, args = {}) => {
    try { return await invoke(`plugin:rail|${command}`, args); }
    catch { status.textContent = RAIL_COPY.unavailable; return undefined; }
  };
  const open = (anchor) => call("rail_card_open", { anchor });
  doc.body.classList.toggle("card", isCard);
  doc.body.classList.toggle("folded", !isCard);
  accounts.append(messageTab(doc, isCard, open, RAIL_COPY.loading));
  const activity = async () => {
    try { return await invoke("plugin:activity|activity_sessions", {}); }
    catch { return null; }
  };
  const update = async () => {
    const [next, records] = await Promise.all([call("rail_snapshot"), activity()]);
    if (disposed) return;
    if (next) {
      snapshot = next;
      status.textContent = "";
      doc.body.classList.toggle("card", isCard);
      doc.body.classList.toggle("folded", !isCard && !next.window.unfolded);
      keep.setAttribute("aria-pressed", String(next.window.keepOpen));
      close.textContent = isCard ? RAIL_COPY.close : RAIL_COPY.hide;
      if (isCard && next.window.cardOpen && !cardOpen) {
        doc.body.classList.remove("morphing");
        void doc.body.offsetWidth;
        doc.body.classList.add("morphing");
      }
      cardOpen = next.window.cardOpen;
      const key = JSON.stringify([next.accounts, next.accounts.map(row => Date.parse(row.resetAt) <= Date.now())]);
      if (rowsKey !== key) {
        rowsKey = key;
        renderAccounts(doc, accounts, next.accounts, isCard, open);
      }
    } else {
      rowsKey = undefined;
      accounts.replaceChildren(messageTab(doc, isCard, open, RAIL_COPY.unavailable));
    }
    const key = JSON.stringify([records, Math.floor(Date.now() / 60000)]);
    if (sessionsKey !== key) {
      sessionsKey = key;
      renderSessions(doc, sessions, Array.isArray(records) ? records : null, isCard, open);
    }
    timer = setTimeout(update, 250);
  };
  keep.addEventListener("click", () => call("rail_set_keep_open", { keepOpen: !snapshot?.window.keepOpen }));
  close.addEventListener("click", () => call(isCard ? "rail_card_close" : "rail_set_visible", isCard ? {} : { visible: false }));
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); void call("rail_card_close"); }
  });
  const flushMove = async () => {
    if (moving) return;
    moving = true;
    while (pendingOffset !== undefined) {
      const offset = pendingOffset;
      pendingOffset = undefined;
      await call("rail_move_offset", { offset });
    }
    moving = false;
  };
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !snapshot) return;
    drag = { screen: event.screenY, offset: snapshot.window.offset };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", (event) => {
    if (!drag) return;
    pendingOffset = dragOffset(drag.offset, drag.screen, event.screenY);
    void flushMove();
  });
  const finishDrag = () => { drag = undefined; };
  grip.addEventListener("pointerup", finishDrag);
  grip.addEventListener("pointercancel", finishDrag);
  grip.addEventListener("lostpointercapture", finishDrag);
  grip.addEventListener("keydown", (event) => {
    if (!snapshot || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    pendingOffset = dragOffset(snapshot.window.offset, 0, event.key === "ArrowUp" ? -10 : 10);
    void flushMove();
  });
  void update();
  return () => { disposed = true; clearTimeout(timer); };
}

export function startRailTheme(doc, win) {
  const theme = win.matchMedia("(prefers-color-scheme: light)");
  const applyTheme = () => {
    let saved;
    try { saved = win.localStorage.getItem("openlimiter-theme"); } catch { /* Use the system preference. */ }
    doc.documentElement.dataset.theme = ["light", "dark"].includes(saved) ? saved : theme.matches ? "light" : "dark";
  };
  applyTheme();
  theme.addEventListener("change", applyTheme);
  win.addEventListener("storage", applyTheme);
  return () => { theme.removeEventListener("change", applyTheme); win.removeEventListener("storage", applyTheme); };
}

if (typeof document !== "undefined") {
  const stopTheme = startRailTheme(document, window);
  const dispose = startRail(document, window.__TAURI__.core.invoke, location.search);
  window.addEventListener("pagehide", () => { dispose(); stopTheme(); }, { once: true });
}
