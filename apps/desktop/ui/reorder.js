/*
 * Moving provider blocks, in the window's Usage list and in the edge panel.
 *
 * The order lives in Rust (provider_order.rs): most used first, or a person's
 * own list, with a revision. Each surface keeps a copy (createOrderStore),
 * shows a move at once and writes the new list from the revision it saw; a
 * refused or failed write reloads the record, so the block goes back, and the
 * live region says so. Rust tells every surface after each write.
 *
 * reorderList drives one list. A grip over each block's mark starts a pointer
 * drag after 4 px (pointer events with capture, no HTML drag and drop, so
 * scrolling and every other control keep working), and a click, Enter or
 * Space on it opens a small menu, Move up, Move down, Move to top, Move to
 * bottom, which is also the keyboard path. While a block is dragged or its
 * menu is open, a redraw changes values in place and holds every structural
 * change (a block added, removed or moved elsewhere) until it ends.
 */
import { providerName, say } from "./names.js";

/** Sent by Rust to every surface after the order was written. */
export const ORDER_CHANGED_EVENT = "provider-order-changed";

const USAGE = Object.freeze({ mode: "usage", providers: Object.freeze([]), revision: 0 });

/* A press becomes a drag after this many pixels, so a click never drags. */
const DRAG_THRESHOLD = 4;
/* Near the top or bottom of what is visible the list scrolls under a drag,
   faster the closer the pointer, at most this many pixels a frame. */
const EDGE = 40;
const EDGE_SPEED = 12;
/* As long as the slide in quiet.css, plus a frame. */
const SETTLE_MS = 170;

function validOrder(value) {
  return value !== null && typeof value === "object" && (value.mode === "usage" || value.mode === "custom") &&
    Array.isArray(value.providers) && value.providers.every((code) => typeof code === "string") &&
    Number.isSafeInteger(value.revision) && value.revision >= 0;
}

const same = (left, right) => left.mode === right.mode && left.revision === right.revision &&
  left.providers.length === right.providers.length && left.providers.every((code, index) => code === right.providers[index]);

/**
 * A person's own order (Settings, My order): the providers their list names
 * first, in its order, then the ones it does not name yet, most used first.
 * Most used first is limitsModel's own sort, unchanged.
 */
export function byOrder(model, order) {
  if (order?.mode !== "custom" || !Array.isArray(order.providers)) return model;
  const rank = new Map(order.providers.map((code, index) => [code, index]));
  const at = (provider) => rank.get(provider.code) ?? rank.size;
  return [...model].sort((left, right) => at(left) - at(right));
}

/**
 * Show `groups` in this order as the mount's blocks. The block holding focus
 * or being dragged is never taken out of the document (that would drop the
 * focus or the pointer): the others move around it. Anything else the list
 * holds (the column headings, a drag's slot) stays where it is.
 */
export function arrange(doc, mount, groups) {
  for (const child of [...mount.children]) {
    if (child.classList.contains("q-group") && !groups.includes(child)) child.remove();
  }
  const placed = [...mount.children].filter((child) => groups.includes(child));
  if (placed.length === groups.length && placed.every((child, index) => child === groups[index])) return;
  const pinned = placed.find((group) => group.contains(doc.activeElement) || "dragging" in group.dataset);
  if (!pinned) {
    for (const group of groups) mount.append(group);
    return;
  }
  const at = groups.indexOf(pinned);
  for (const group of groups.slice(0, at)) mount.insertBefore(group, pinned);
  for (const group of groups.slice(at + 1)) mount.append(group);
}

/**
 * The stored list after `code` moves to position `to` among the codes a
 * surface shows. A provider the list names but the surface does not show
 * keeps its place; a shown provider the list does not name yet joins after.
 */
export function movedOrder(stored, shown, code, to) {
  const next = shown.filter((entry) => entry !== code);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, code);
  const visible = new Set(shown);
  return [...stored.map((entry) => (visible.has(entry) ? next.shift() : entry)), ...next];
}

/**
 * A surface's copy of the order. `read()` and `write(input)` answer
 * { ok, value } like backend.js; `listen(handler)` hears Rust's change event.
 */
export function createOrderStore({ read, write, listen = null }) {
  let state = USAGE;
  let saving = 0;
  const watchers = new Set();
  const tried = new Set();
  const set = (next) => {
    if (same(state, next)) return;
    state = next;
    for (const watcher of watchers) watcher(state);
  };
  const load = async () => {
    const result = await read();
    if (result?.ok && validOrder(result.value)) set(result.value);
    return state;
  };
  /* A whole record from the revision this copy holds, shown at once. A
     refusal (another surface wrote first) or a failure reloads the record on
     disk, which puts the previous order back. */
  const save = async (mode, providers) => {
    const before = state;
    saving += 1;
    set({ mode, providers, revision: before.revision });
    try {
      const result = await write({ revision: before.revision, mode, providers });
      if (result?.ok && validOrder(result.value)) {
        if (result.value.revision >= state.revision) set(result.value);
        return true;
      }
      await load();
      if (state.revision === before.revision) set(before);
      return false;
    } finally {
      saving -= 1;
    }
  };
  let unlisten = null;
  if (typeof listen === "function") {
    Promise.resolve(listen((event) => {
      const next = event?.payload;
      if (validOrder(next) && next.revision > state.revision) set(next);
    })).then((stop) => { unlisten = stop; }).catch(() => {});
  }
  return {
    get state() { return state; },
    load,
    subscribe(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    /* The first move by any path makes the order the person's own. */
    move: (shown, code, to) => save("custom", movedOrder(state.providers, shown, code, to)),
    /* Most used first keeps the list, so My order brings it back. */
    setMode: (mode) => (mode === state.mode ? Promise.resolve(true) : save(mode, [...state.providers])),
    /* In a person's own order a provider seen for the first time joins at
       the bottom, once: one revision checked write. */
    adopt(shown) {
      if (state.mode !== "custom" || saving > 0) return Promise.resolve(false);
      const fresh = shown.filter((code) => !state.providers.includes(code) && !tried.has(code));
      if (fresh.length === 0) return Promise.resolve(false);
      for (const code of fresh) tried.add(code);
      return save("custom", [...state.providers, ...fresh]);
    },
    dispose() {
      unlisten?.();
      watchers.clear();
    },
  };
}

let menus = 0;

/**
 * One reorderable list. `render(model)` draws with grips (renderLimits with
 * `grips: true`); the surface calls `draw(model)` instead, sends Escape to
 * `escape()` (true when it ended something) and calls `cancel()` when it hides.
 * `hold(held)` keeps the edge panel open through an interaction; `scroller`
 * is what scrolls the list, the document when null.
 */
export function reorderList(doc, mount, { store, render, hold = () => {}, scroller = null, view = globalThis } = {}) {
  let drawn = [];
  let latest = null;
  let press = null;
  let drag = null;
  let menu = null;
  let suppressClick = false;

  const live = doc.createElement("p");
  live.className = "q-live";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  (doc.body ?? mount).append(live);
  const announce = (text) => {
    live.textContent = "";
    live.textContent = text;
  };

  const groups = () => [...mount.querySelectorAll(".q-group")];
  const shown = () => groups().map((group) => group.dataset.provider);
  const reduced = () => view.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const scrolling = () => scroller ?? doc.scrollingElement ?? null;
  const scrollTop = () => scrolling()?.scrollTop ?? 0;
  const edges = () => {
    if (scroller) return scroller.getBoundingClientRect();
    /* The window's sticky chrome is its root's scroll padding. */
    const root = doc.documentElement ? view.getComputedStyle?.(doc.documentElement) : null;
    return { top: parseFloat(root?.scrollPaddingTop) || 0, bottom: view.innerHeight ?? 0 };
  };

  function draw(model) {
    const active = drag ?? menu ?? press;
    if (active === null) {
      render(model);
      drawn = model;
      void store.adopt(model.map((provider) => provider.code));
      return;
    }
    latest = model;
    if (!model.some((provider) => provider.code === active.code)) {
      const name = providerName(active.code);
      cancel();
      announce(say("reorderGone", { name }));
      return;
    }
    /* Values change in place; blocks stay where they are until it ends. */
    const fresh = new Map(model.map((provider) => [provider.code, provider]));
    render(drawn.map((provider) => fresh.get(provider.code) ?? provider));
  }

  /* What arrived during the interaction, in the order as it is now. */
  function settle() {
    if (latest === null || drag || menu || press) return;
    const model = byOrder(latest, store.state);
    latest = null;
    draw(model);
  }

  /* Show the blocks in `codes` order now; the focused or dragged one stays put. */
  function place(codes) {
    const byCode = new Map(groups().map((group) => [group.dataset.provider, group]));
    const models = new Map(drawn.map((provider) => [provider.code, provider]));
    arrange(doc, mount, codes.map((code) => byCode.get(code)).filter(Boolean));
    drawn = codes.map((code) => models.get(code)).filter(Boolean);
  }

  async function commit(code, to, before) {
    const name = providerName(code);
    const saved = await store.move(before, code, to);
    announce(saved ? say("movedTo", { name, position: to + 1, count: before.length }) : say("orderNotSaved"));
  }

  /* ------------------------------------------------------------ the menu */

  /* Opened by Enter or Space, focus goes to the first move it can make; a
     pointer click leaves focus where it was, as a menu button does. */
  function openMenu(grip, byKeyboard) {
    closeMenu();
    const group = grip.closest(".q-group");
    const code = group.dataset.provider;
    const codes = shown();
    const index = codes.indexOf(code);
    const last = codes.length - 1;
    const element = doc.createElement("div");
    element.className = "q-ordermenu";
    element.id = `q-order-menu-${++menus}`;
    element.setAttribute("role", "menu");
    element.setAttribute("aria-label", grip.getAttribute("aria-label") ?? "");
    for (const [move, key, disabled] of [
      ["up", "moveUp", index <= 0], ["down", "moveDown", index >= last],
      ["top", "moveTop", index <= 0], ["bottom", "moveBottom", index >= last],
    ]) {
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "q-orderitem";
      item.setAttribute("role", "menuitem");
      item.dataset.move = move;
      item.textContent = say(key);
      item.disabled = disabled;
      element.append(item);
    }
    grip.closest(".q-prov").append(element);
    grip.setAttribute("aria-expanded", "true");
    grip.setAttribute("aria-controls", element.id);
    menu = { grip, group, code, element };
    hold(true);
    /* It opens downward unless that runs past what is visible. */
    const box = element.getBoundingClientRect();
    if (box.bottom > edges().bottom && box.top - box.height > edges().top) element.dataset.up = "";
    if (byKeyboard) [...element.children].find((item) => !item.disabled)?.focus();
  }

  function closeMenu(focus = false) {
    if (menu === null) return;
    const { grip, element } = menu;
    menu = null;
    if (focus) grip.focus();
    element.remove();
    grip.setAttribute("aria-expanded", "false");
    grip.removeAttribute("aria-controls");
    hold(false);
    settle();
  }

  function choose(move) {
    const { grip, code } = menu;
    closeMenu(true);
    const before = shown();
    const from = before.indexOf(code);
    const to = { up: from - 1, down: from + 1, top: 0, bottom: before.length - 1 }[move];
    if (from < 0 || to === undefined || to < 0 || to >= before.length || to === from) return;
    const after = before.filter((entry) => entry !== code);
    after.splice(to, 0, code);
    place(after);
    grip.scrollIntoView?.({ block: "nearest" });
    void commit(code, to, before);
  }

  /* ------------------------------------------------------------ the drag */

  function release() {
    const { grip, pointerId } = press;
    press = null;
    if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
    settle();
  }

  function begin(clientY) {
    const { grip, group, code, pointerId, y } = press;
    press = null;
    closeMenu();
    const offset = scrollTop();
    const items = groups().map((node) => {
      const box = node.getBoundingClientRect();
      return { group: node, code: node.dataset.provider, top: box.top + offset, height: box.height };
    });
    const from = items.findIndex((item) => item.group === group);
    if (from < 0) return;
    const gap = items.length > 1 ? Math.max(0, items[1].top - items[0].top - items[0].height) : 0;
    const area = mount.getBoundingClientRect();
    const box = group.getBoundingClientRect();
    const origin = area.top + offset;
    const slot = doc.createElement("div");
    slot.className = "q-slot";
    slot.setAttribute("aria-hidden", "true");
    slot.style.setProperty("top", `${items[from].top - origin}px`);
    slot.style.setProperty("left", `${box.left - area.left}px`);
    slot.style.setProperty("width", `${box.width}px`);
    slot.style.setProperty("height", `${items[from].height}px`);
    mount.append(slot);
    mount.dataset.reordering = "";
    group.dataset.dragging = "";
    /* This gesture ends in no click on the grip, however the drag ends. */
    suppressClick = true;
    drag = { grip, group, code, pointerId, y, clientY: y, scroll: offset, items, from, to: from, gap, origin, slot, frame: null };
    hold(true);
    follow(clientY);
    edgeScroll();
  }

  /* The block follows the pointer up and down; the others slide aside. */
  function follow(clientY) {
    drag.clientY = clientY;
    const { items, from, gap } = drag;
    const dragged = items[from];
    const dy = clientY - drag.y + scrollTop() - drag.scroll;
    const center = dragged.top + dragged.height / 2 + dy;
    const to = items.filter((item, index) => index !== from && item.top + item.height / 2 < center).length;
    dragged.group.style.setProperty("transform", `translateY(${dy}px)`);
    if (to === drag.to) return;
    drag.to = to;
    const shift = dragged.height + gap;
    items.forEach((item, index) => {
      if (index === from) return;
      const offset = index > from && index <= to ? -shift : index < from && index >= to ? shift : 0;
      item.group.style.setProperty("transform", offset ? `translateY(${offset}px)` : "");
    });
    const landing = to > from ? items[to].top + items[to].height - dragged.height : items[to].top;
    drag.slot.style.setProperty("top", `${landing - drag.origin}px`);
  }

  function edgeScroll() {
    if (drag === null || typeof view.requestAnimationFrame !== "function") return;
    drag.frame = view.requestAnimationFrame(() => {
      if (drag === null) return;
      const { top, bottom } = edges();
      const y = drag.clientY;
      const near = y < top + EDGE ? -Math.min(1, (top + EDGE - y) / EDGE)
        : y > bottom - EDGE ? Math.min(1, (y - bottom + EDGE) / EDGE) : 0;
      const target = scrolling();
      if (near !== 0 && target) {
        target.scrollTop += Math.round(near * EDGE_SPEED) || Math.sign(near);
        follow(y);
      }
      edgeScroll();
    });
  }

  /* Drop (commit) or cancel: every block slides from where it shows to its place. */
  function finish(commitIt) {
    const { grip, group, code, pointerId, items, from, to, slot, frame } = drag;
    drag = null;
    if (frame !== null) view.cancelAnimationFrame?.(frame);
    const before = items.map((item) => item.code);
    const after = before.filter((entry) => entry !== code);
    after.splice(to, 0, code);
    const moved = commitIt && to !== from;
    const shownAt = new Map(items.map((item) => [item.group, item.group.getBoundingClientRect().top]));
    delete mount.dataset.reordering;
    delete group.dataset.dragging;
    slot.remove();
    for (const item of items) item.group.style.setProperty("transform", "");
    if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
    if (moved) place(after);
    slide(shownAt);
    hold(false);
    if (moved) void commit(code, to, before);
    settle();
  }

  function slide(shownAt) {
    if (reduced()) return;
    const moving = [];
    for (const [group, top] of shownAt) {
      const delta = Math.round(top - group.getBoundingClientRect().top);
      if (!delta) continue;
      group.style.setProperty("transform", `translateY(${delta}px)`);
      moving.push(group);
    }
    if (moving.length === 0) return;
    void mount.offsetHeight;
    for (const group of moving) {
      group.dataset.settling = "";
      group.style.setProperty("transform", "");
    }
    view.setTimeout?.(() => { for (const group of moving) delete group.dataset.settling; }, SETTLE_MS);
  }

  /* --------------------------------------------------------- the events */

  mount.addEventListener("pointerdown", (event) => {
    /* A new press is a new gesture: an old drag's click is long gone. */
    if (!drag && !press) suppressClick = false;
    const grip = event.target?.closest?.(".q-grip");
    if (!grip || event.button !== 0 || event.isPrimary === false || drag || press) return;
    /* No text selection under a drag; the click still arrives. */
    event.preventDefault?.();
    const group = grip.closest(".q-group");
    press = { grip, group, code: group.dataset.provider, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    grip.setPointerCapture?.(event.pointerId);
  });
  mount.addEventListener("pointermove", (event) => {
    if (drag && event.pointerId === drag.pointerId) follow(event.clientY);
    else if (press && event.pointerId === press.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_THRESHOLD) begin(event.clientY);
  });
  mount.addEventListener("pointerup", (event) => {
    if (drag && event.pointerId === drag.pointerId) finish(true);
    else if (press && event.pointerId === press.pointerId) release();
  });
  for (const name of ["pointercancel", "lostpointercapture"]) {
    mount.addEventListener(name, (event) => {
      if (drag && event.pointerId === drag.pointerId) finish(false);
      else if (press && event.pointerId === press.pointerId) release();
    });
  }
  mount.addEventListener("click", (event) => {
    const grip = event.target?.closest?.(".q-grip");
    if (grip) {
      /* The click a drag ends with opens nothing; Enter or Space (detail 0) always does. */
      const dragged = suppressClick && event.detail !== 0;
      suppressClick = false;
      if (dragged) {
        event.preventDefault?.();
        return;
      }
      if (menu?.grip === grip) closeMenu(true);
      else openMenu(grip, event.detail === 0);
      return;
    }
    const item = event.target?.closest?.(".q-orderitem");
    if (item && menu && !item.disabled) choose(item.dataset.move);
  });
  /* Arrow keys, Home and End move through the menu; Tab leaves it from its grip. */
  mount.addEventListener("keydown", (event) => {
    if (menu === null || !menu.element.contains(event.target)) return;
    const items = [...menu.element.children].filter((item) => !item.disabled);
    const at = items.indexOf(event.target);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next !== undefined && items.length) {
      event.preventDefault?.();
      items[(next + items.length) % items.length].focus();
    } else if (event.key === "Tab") {
      closeMenu(true);
    }
  });
  const outside = (event) => {
    if (menu && !menu.element.contains(event.target) && !menu.grip.contains(event.target)) closeMenu();
  };
  const hidden = () => {
    if (doc.visibilityState === "hidden") cancel();
  };
  const blurred = () => cancel();
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("visibilitychange", hidden);
  view.addEventListener?.("blur", blurred);

  /* End whatever is under way, moving nothing. */
  function cancel() {
    if (drag) finish(false);
    if (press) release();
    closeMenu();
  }

  /* Escape ends a drag or closes the menu; false when there was neither. */
  function escape() {
    if (drag) finish(false);
    else if (menu) closeMenu(true);
    else return false;
    return true;
  }

  return {
    draw,
    escape,
    cancel,
    busy: () => drag !== null || menu !== null || press !== null,
    dispose() {
      cancel();
      live.remove();
      doc.removeEventListener("pointerdown", outside);
      doc.removeEventListener("visibilitychange", hidden);
      view.removeEventListener?.("blur", blurred);
    },
  };
}

/* ------------------------------------------------------------ Settings */

/** Settings, Appearance: the order every list and the tray menu follow. */
export function orderSettingMarkup() {
  return '<div class="menu-presets provider-order"><span id="order-label">' + say("order") + "</span>" +
    '<span class="preset-grid" role="group" aria-labelledby="order-label">' +
    '<button type="button" class="preset" data-order-mode="usage" aria-pressed="false">' + say("orderUsage") + "</button>" +
    '<button type="button" class="preset" data-order-mode="custom" aria-pressed="false">' + say("orderCustom") + "</button>" +
    '</span></div><p id="order-status" class="menu-note" role="status"></p>';
}

/** Wire the two buttons; the returned function repaints them from the store. */
export function wireOrderSetting(container, store) {
  const buttons = [...container.querySelectorAll("[data-order-mode]")];
  const status = container.querySelector("#order-status");
  const paint = () => {
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.orderMode === store.state.mode));
  };
  for (const button of buttons) {
    button.addEventListener("click", async () => {
      if (status) status.textContent = "";
      const saved = await store.setMode(button.dataset.orderMode);
      paint();
      if (!saved && status) status.textContent = say("orderNotSaved");
    });
  }
  paint();
  return paint;
}
