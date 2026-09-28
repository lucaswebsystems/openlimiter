/* Rust owns hover, geometry, full screen state and persistence. No window API
   permissions, remote assets, HTML interpolation or fabricated quota readings. */
export function accountLabel(row) {
  const reading = row.value === null || !Number.isFinite(row.value)
    ? "Unknown"
    : `${row.value}${row.kind === "quota_percent" ? "%" : ""} ${row.meaning}`;
  return `${row.provider}: ${reading} (${row.windowLabel})`;
}

export function dragOffset(startOffset, startScreen, currentScreen) {
  return Math.min(100000, Math.max(0, startOffset + currentScreen - startScreen));
}

export function startRail(doc, invoke, search = "") {
  const isCard = new URLSearchParams(search).has("card");
  const accounts = doc.querySelector("#accounts");
  const keep = doc.querySelector("#keep");
  const close = doc.querySelector("#close");
  const grip = doc.querySelector("#grip");
  const status = doc.querySelector("#status");
  let snapshot;
  let rowsKey;
  let drag;
  let pendingOffset;
  let moving = false;
  let disposed = false;
  let timer;
  const call = async (command, args = {}) => {
    try { return await invoke(`plugin:rail|${command}`, args); }
    catch (error) { status.textContent = String(error); return undefined; }
  };
  const open = (anchor) => call("rail_card_open", { anchor });
  const update = async () => {
    const next = await call("rail_snapshot");
    if (disposed) return;
    if (next) {
      snapshot = next;
      doc.body.classList.toggle("card", isCard);
      doc.body.classList.toggle("folded", !isCard && !next.window.unfolded);
      keep.setAttribute("aria-pressed", String(next.window.keepOpen));
      close.textContent = isCard ? "Close card" : "Hide";
      const key = JSON.stringify(next.accounts);
      if (rowsKey !== key) {
        rowsKey = key;
        accounts.replaceChildren();
        if (!next.accounts.length) {
          const empty = doc.createElement(isCard ? "p" : "button");
          empty.textContent = isCard ? "No accounts yet. Add an account in Settings." : "No accounts";
          if (!isCard) { empty.className = "tab"; empty.addEventListener("pointerenter", () => open(24)); empty.addEventListener("click", () => open(24)); }
          accounts.append(empty);
        }
        next.accounts.forEach((row) => {
          const element = doc.createElement(isCard ? "p" : "button");
          element.textContent = accountLabel(row);
          if (!isCard) {
            element.className = "tab";
            // #surface is the scroller, so read the tab's on screen position.
            const show = () => open(Math.max(0, Math.min(320, element.getBoundingClientRect().top)));
            element.addEventListener("pointerenter", show);
            element.addEventListener("focus", show);
            element.addEventListener("click", show);
          }
          accounts.append(element);
        });
      }
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

if (typeof document !== "undefined") {
  const dispose = startRail(document, window.__TAURI__.core.invoke, location.search);
  window.addEventListener("pagehide", dispose, { once: true });
}
