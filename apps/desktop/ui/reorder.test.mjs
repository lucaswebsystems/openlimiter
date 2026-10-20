import assert from "node:assert/strict";
import test from "node:test";
import { fakeDocument, leaks, spoken } from "./test-dom.mjs";
import { providerName } from "./names.js";
// readings.js and reorder.js reach the compiled engine, which only exists in the build.
import { byOrder, patchLimits, renderLimits } from "./dist/readings.js";
import { createOrderStore, movedOrder, reorderList } from "./dist/reorder.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const USAGE = { mode: "usage", providers: [], revision: 0 };

/* One provider block as limitsModel draws it, one window at `percent`. */
const block = (code, percent = 10, reset = "1h 5m") => ({
  code, name: providerName(code), age: null,
  windows: [{ key: "FIVE_HOUR", label: "5 hour", usedPercent: percent, observedAt: "2026-10-20T10:00:00.000Z", band: "green",
    value: `${percent}%`, limit: null, unbounded: false, neutral: false, reset, moneyDetail: false }],
});
const codes = (model) => model.map((provider) => provider.code);

/* The order on disk, behind the two commands, as backend.js answers them. */
function memoryOrder(initial = USAGE, { refuse = false } = {}) {
  const disk = { ...initial, providers: [...initial.providers] };
  const writes = [];
  const listeners = [];
  const store = createOrderStore({
    read: async () => ({ ok: true, value: { ...disk, providers: [...disk.providers] } }),
    write: async (input) => {
      writes.push(input);
      if (refuse || input.revision !== disk.revision) return { ok: false, reason: "command_failed", kind: "stale_revision" };
      Object.assign(disk, { mode: input.mode, providers: [...input.providers], revision: disk.revision + 1 });
      return { ok: true, value: { ...disk, providers: [...disk.providers] } };
    },
    listen: (handler) => { listeners.push(handler); return () => {}; },
  });
  const hear = (payload) => listeners.forEach((handler) => handler({ payload }));
  return { store, disk, writes, hear };
}

/**
 * A surface: a list drawn with grips, redrawn whenever its copy of the order
 * changes, a box per block 100 tall and 10 apart, and timers that wait to be
 * run like the next task would.
 */
async function surface(list, { order = USAGE, refuse = false, motion = false } = {}) {
  const doc = fakeDocument(["mount"]);
  const mount = doc.getElementById("mount");
  mount.rect = { top: 0, height: 400 };
  const memory = memoryOrder(order, { refuse });
  const holds = [];
  const timers = [];
  let model = list.map((code, index) => block(code, 60 - index * 10));
  const layout = () => mount.all((node) => node.className === "q-group")
    .forEach((group, index) => { group.rect = { top: index * 110, height: 100 }; });
  const controller = reorderList(doc, mount, {
    store: memory.store,
    render: (shown) => { renderLimits(doc, mount, shown, { grips: true }); layout(); },
    hold: (held) => holds.push(held),
    view: { setTimeout: (callback) => timers.push(callback), matchMedia: () => ({ matches: !motion }) },
  });
  const draw = (next = model) => { model = next; controller.draw(byOrder(model, memory.store.state)); };
  memory.store.subscribe(() => draw());
  await memory.store.load();
  draw();
  return {
    doc, mount, controller, memory, holds, draw,
    tick: () => timers.splice(0).forEach((callback) => callback()),
    order: () => mount.all((node) => node.className === "q-group").map((group) => group.dataset.provider),
    group: (code) => mount.all((node) => node.className === "q-group").find((group) => group.dataset.provider === code),
    grip: (code) => mount.all((node) => node.className === "q-grip").find((grip) => grip.closest(".q-group").dataset.provider === code),
    menu: () => mount.all((node) => node.className === "q-ordermenu")[0] ?? null,
    slot: () => mount.all((node) => node.className === "q-slot")[0] ?? null,
    said: () => mount.all((node) => node.className === "q-live")[0].textContent,
  };
}

const pointer = (target, type, y, x = 0) =>
  target.bubble(type, { button: 0, isPrimary: true, pointerId: 7, clientX: x, clientY: y, preventDefault() {} });
/* A pointer click is a whole gesture; Enter or Space on a button is a click with detail 0. */
const tap = async (target) => {
  await pointer(target, "pointerdown", 0);
  await pointer(target, "pointerup", 0);
  await target.bubble("click", { detail: 1 });
};
const key = (target) => target.bubble("click", { detail: 0 });
const transform = (group) => group.style.props.transform ?? "";

/* --------------------------------------------------------------- the order */

test("most used first is today's sort; My order puts the person's list first and newcomers after, most used first", () => {
  const model = ["CODEX", "CLAUDE", "KIMI", "GROK"].map((code) => block(code));
  assert.deepEqual(codes(byOrder(model, { mode: "usage", providers: ["KIMI", "CLAUDE"], revision: 4 })), ["CODEX", "CLAUDE", "KIMI", "GROK"]);
  assert.deepEqual(codes(byOrder(model, null)), ["CODEX", "CLAUDE", "KIMI", "GROK"]);
  assert.deepEqual(codes(byOrder(model, { mode: "custom", providers: ["KIMI", "ANTIGRAVITY", "CLAUDE"], revision: 4 })),
    ["KIMI", "CLAUDE", "CODEX", "GROK"]);
});

test("a move keeps a listed provider that is not shown in its place and lists a shown newcomer", () => {
  const stored = ["KIMI", "ANTIGRAVITY", "CLAUDE"];
  const shown = ["KIMI", "CLAUDE", "CODEX", "GROK"];
  assert.deepEqual(movedOrder(stored, shown, "GROK", 0), ["GROK", "ANTIGRAVITY", "KIMI", "CLAUDE", "CODEX"]);
  assert.deepEqual(movedOrder(stored, shown, "KIMI", 3), ["CLAUDE", "ANTIGRAVITY", "CODEX", "GROK", "KIMI"]);
  // From most used first, with nothing stored: the shown order with the move.
  assert.deepEqual(movedOrder([], ["CODEX", "CLAUDE"], "CLAUDE", 0), ["CLAUDE", "CODEX"]);
});

test("the store shows a write at once, applies only newer records it hears, and reloads after a refusal", async () => {
  const memory = memoryOrder({ mode: "custom", providers: ["CLAUDE", "CODEX"], revision: 2 });
  const seen = [];
  memory.store.subscribe((state) => seen.push(state.providers.join()));
  await memory.store.load();
  const saving = memory.store.move(["CLAUDE", "CODEX"], "CODEX", 0);
  assert.deepEqual(memory.store.state.providers, ["CODEX", "CLAUDE"], "shown before the write returns");
  assert.equal(await saving, true);
  assert.equal(memory.store.state.revision, 3);
  memory.hear({ mode: "custom", providers: ["CLAUDE", "CODEX"], revision: 1 });
  assert.equal(memory.store.state.revision, 3, "an older record is ignored");
  memory.hear({ mode: "usage", providers: ["CODEX", "CLAUDE"], revision: 5 });
  assert.equal(memory.store.state.mode, "usage", "a newer one from another surface applies");
  // That surface wrote revision 5 on a disk this copy last saw at 3: refused, reloaded.
  Object.assign(memory.disk, { mode: "custom", providers: ["KIMI"], revision: 6 });
  assert.equal(await memory.store.move(["CODEX", "CLAUDE"], "CLAUDE", 0), false);
  assert.deepEqual(memory.store.state, { mode: "custom", providers: ["KIMI"], revision: 6 });
  assert.ok(seen.length >= 4);
});

test("Most used first keeps the list, so My order brings it back", async () => {
  const memory = memoryOrder({ mode: "custom", providers: ["KIMI", "CLAUDE"], revision: 1 });
  await memory.store.load();
  assert.equal(await memory.store.setMode("usage"), true);
  assert.deepEqual(memory.disk, { mode: "usage", providers: ["KIMI", "CLAUDE"], revision: 2 });
  assert.equal(await memory.store.setMode("custom"), true);
  assert.deepEqual(memory.disk, { mode: "custom", providers: ["KIMI", "CLAUDE"], revision: 3 });
  assert.equal(await memory.store.setMode("custom"), true, "choosing the mode it is in writes nothing");
  assert.equal(memory.writes.length, 2);
});

/* ---------------------------------------------------------------- the menu */

test("the grip is a named button; click opens its menu with impossible moves disabled; a move keeps focus and is announced", async () => {
  const s = await surface(["CLAUDE", "CODEX", "KIMI"]);
  const claude = s.grip("CLAUDE");
  assert.equal(claude.localName, "button");
  assert.equal(claude.getAttribute("aria-label"), "Reorder Claude Code");
  assert.equal(claude.getAttribute("aria-haspopup"), "menu");
  await key(claude);
  const items = s.menu().children;
  assert.equal(s.menu().getAttribute("role"), "menu");
  assert.deepEqual(items.map((item) => [item.textContent, item.disabled, item.getAttribute("role")]), [
    ["Move up", true, "menuitem"], ["Move down", false, "menuitem"], ["Move to top", true, "menuitem"], ["Move to bottom", false, "menuitem"],
  ]);
  assert.equal(claude.getAttribute("aria-expanded"), "true");
  assert.equal(s.doc.activeElement, items[1], "focus goes to the first move it can make");
  assert.deepEqual(s.holds, [true]);
  await key(items[1]);
  await flush();
  assert.deepEqual(s.order(), ["CODEX", "CLAUDE", "KIMI"]);
  assert.equal(s.doc.activeElement, claude, "focus stays on the grip that moved");
  assert.equal(s.grip("CLAUDE"), claude, "the same grip, never a new node");
  assert.equal(claude.getAttribute("aria-expanded"), "false");
  assert.equal(s.menu(), null);
  assert.deepEqual(s.holds, [true, false]);
  assert.equal(s.said(), "Claude Code moved to position 2 of 3");
  assert.deepEqual(s.memory.writes, [{ revision: 0, mode: "custom", providers: ["CODEX", "CLAUDE", "KIMI"] }]);
  assert.equal(s.memory.store.state.mode, "custom", "the first move makes the order the person's own");
  // The last block can only go up; Move to top takes it there.
  await tap(s.grip("KIMI"));
  assert.deepEqual(s.menu().children.map((item) => item.disabled), [false, true, false, true]);
  await s.menu().children[2].bubble("click", { detail: 1 });
  await flush();
  assert.deepEqual(s.order(), ["KIMI", "CODEX", "CLAUDE"]);
  assert.equal(s.said(), "Kimi moved to position 1 of 3");
  assert.deepEqual(leaks(spoken(s.mount)), []);
});

test("arrow keys, Home and End move through the enabled items; Escape closes the menu back onto its grip", async () => {
  const s = await surface(["CLAUDE", "CODEX", "KIMI"]);
  const codex = s.grip("CODEX");
  await key(codex);
  const [up, down, top, bottom] = s.menu().children;
  assert.equal(s.doc.activeElement, up);
  const press = (name) => s.doc.activeElement.bubble("keydown", { key: name, preventDefault() {} });
  await press("ArrowDown");
  assert.equal(s.doc.activeElement, down);
  await press("End");
  assert.equal(s.doc.activeElement, bottom);
  await press("ArrowDown");
  assert.equal(s.doc.activeElement, up, "it wraps");
  await press("ArrowUp");
  assert.equal(s.doc.activeElement, bottom);
  await press("Home");
  assert.equal(s.doc.activeElement, up);
  assert.ok(top);
  assert.equal(s.controller.escape(), true);
  assert.equal(s.menu(), null);
  assert.equal(s.doc.activeElement, codex);
  assert.equal(s.controller.escape(), false, "a second Escape is not the list's");
  assert.deepEqual(s.memory.writes, []);
  assert.deepEqual(s.holds, [true, false]);
});

test("a refused save puts the previous order back and says so", async () => {
  const s = await surface(["CLAUDE", "CODEX", "KIMI"], { refuse: true });
  await tap(s.grip("CODEX"));
  const moving = s.menu().children[0].bubble("click", { detail: 1 });
  assert.deepEqual(s.order(), ["CODEX", "CLAUDE", "KIMI"], "the block moves at once");
  await moving;
  await flush();
  await flush();
  assert.deepEqual(s.order(), ["CLAUDE", "CODEX", "KIMI"], "and goes back when the save is refused");
  assert.equal(s.said(), "The order could not be saved, so nothing changed.");
  assert.equal(s.memory.store.state.mode, "usage");
});

/* ---------------------------------------------------------------- the drag */

test("a press under 4 px is a click; a drag lifts the block, slides the others, marks the slot, and drops into place", async () => {
  const s = await surface(["CLAUDE", "CODEX", "KIMI"]);
  const grip = s.grip("CLAUDE");
  await pointer(grip, "pointerdown", 50);
  assert.equal(grip.captured, 7, "the grip holds the pointer");
  await pointer(grip, "pointermove", 53, 2);
  await pointer(grip, "pointerup", 53, 2);
  assert.equal(s.mount.dataset.reordering, undefined, "under 4 px is not a drag");
  assert.equal(grip.captured, null);
  await grip.bubble("click", { detail: 1 });
  assert.ok(s.menu(), "so its click opens the menu");
  s.controller.escape();

  await pointer(grip, "pointerdown", 50);
  await pointer(grip, "pointermove", 54);
  assert.equal(s.mount.dataset.reordering, "", "4 px starts the drag");
  assert.equal(s.group("CLAUDE").dataset.dragging, "");
  assert.equal(s.slot().style.props.top, "0px");
  assert.equal(s.slot().getAttribute("aria-hidden"), "true");
  // Past Codex's middle (160): Codex slides up into Claude's place.
  await pointer(grip, "pointermove", 165);
  assert.equal(transform(s.group("CLAUDE")), "translateY(115px)");
  assert.equal(transform(s.group("CODEX")), "translateY(-110px)");
  assert.equal(transform(s.group("KIMI")), "");
  assert.equal(s.slot().style.props.top, "110px", "the slot marks where it will land");
  assert.deepEqual(s.order(), ["CLAUDE", "CODEX", "KIMI"], "nothing moves in the document before the drop");
  // Back above Codex's middle: Codex returns.
  await pointer(grip, "pointermove", 100);
  assert.equal(transform(s.group("CODEX")), "");
  assert.equal(s.slot().style.props.top, "0px");
  await pointer(grip, "pointermove", 280);
  assert.equal(transform(s.group("KIMI")), "translateY(-110px)");
  assert.equal(s.slot().style.props.top, "220px");
  await pointer(grip, "pointerup", 280);
  await flush();
  assert.deepEqual(s.order(), ["CODEX", "KIMI", "CLAUDE"]);
  assert.equal(s.slot(), null);
  assert.equal(s.mount.dataset.reordering, undefined);
  assert.ok(["CLAUDE", "CODEX", "KIMI"].every((code) => transform(s.group(code)) === ""));
  assert.deepEqual(s.memory.writes, [{ revision: 0, mode: "custom", providers: ["CODEX", "KIMI", "CLAUDE"] }]);
  assert.equal(s.said(), "Claude Code moved to position 3 of 3");
  // The click a completed drag ends with does not open the menu; the next click does.
  await grip.bubble("click", { detail: 1 });
  assert.equal(s.menu(), null);
  await tap(grip);
  assert.ok(s.menu());
  s.controller.escape();
  // A drag cancelled while the button is still down swallows its click too,
  // however late it comes, but never Enter or Space.
  await pointer(grip, "pointerdown", 50);
  await pointer(grip, "pointermove", 70);
  s.controller.escape();
  await pointer(grip, "pointerup", 70);
  await grip.bubble("click", { detail: 1 });
  assert.equal(s.menu(), null);
  await pointer(grip, "pointerdown", 50);
  await pointer(grip, "pointermove", 70);
  s.controller.escape();
  await key(grip);
  assert.ok(s.menu(), "a keyboard click is never a drag's");
});

test("Escape, a lost pointer capture, a cancelled pointer and hiding cancel a drag: the block returns and nothing is written", async () => {
  const s = await surface(["CLAUDE", "CODEX", "KIMI"]);
  const grip = s.grip("CLAUDE");
  const drag = async () => {
    await pointer(grip, "pointerdown", 50);
    await pointer(grip, "pointermove", 280);
    assert.equal(transform(s.group("KIMI")), "translateY(-110px)");
  };
  const returned = (why) => {
    assert.deepEqual(s.order(), ["CLAUDE", "CODEX", "KIMI"], why);
    assert.ok(["CLAUDE", "CODEX", "KIMI"].every((code) => transform(s.group(code)) === ""), why);
    assert.equal(s.slot(), null, why);
    assert.equal(s.mount.dataset.reordering, undefined, why);
  };
  await drag();
  assert.equal(s.controller.escape(), true);
  returned("Escape");
  await drag();
  await pointer(grip, "lostpointercapture", 280);
  returned("capture loss");
  await drag();
  await pointer(grip, "pointercancel", 280);
  returned("pointer cancel");
  await drag();
  s.doc.visibilityState = "hidden";
  await s.doc.fire("visibilitychange");
  returned("the window hid");
  s.doc.visibilityState = "visible";
  await drag();
  s.controller.cancel();
  returned("the panel hid");
  await flush();
  assert.deepEqual(s.memory.writes, [], "a cancelled drag never writes");
  assert.equal(s.memory.store.state.mode, "usage", "and never switches to My order");
  // A drop where it started is no move either.
  await pointer(grip, "pointerdown", 50);
  await pointer(grip, "pointermove", 60);
  await pointer(grip, "pointerup", 60);
  await flush();
  assert.deepEqual(s.memory.writes, []);
});

test("the hold is taken when a drag starts or the menu opens and released on every end", async () => {
  const s = await surface(["CLAUDE", "CODEX"]);
  const grip = s.grip("CLAUDE");
  const drag = async () => { await pointer(grip, "pointerdown", 50); await pointer(grip, "pointermove", 60); };
  const ends = [
    async () => { await drag(); await pointer(grip, "pointerup", 60); },
    async () => { await drag(); s.controller.escape(); },
    async () => { await drag(); await pointer(grip, "lostpointercapture", 60); },
    async () => { await drag(); s.controller.cancel(); },
    async () => { await tap(grip); s.controller.escape(); },
    async () => { await tap(grip); await tap(grip); },
    async () => { await tap(grip); await s.doc.fire("pointerdown", { target: s.doc.createElement("div") }); },
    async () => { await tap(grip); s.controller.cancel(); },
    async () => { await tap(grip); await s.menu().children.find((item) => !item.disabled).bubble("click", { detail: 1 }); },
  ];
  for (const [index, end] of ends.entries()) {
    const before = s.holds.length;
    await end();
    await flush();
    assert.deepEqual(s.holds.slice(before), [true, false], `end ${index}`);
  }
});

test("a live update during a drag keeps the dragged node, changes values in place and waits to move anything", async () => {
  const s = await surface(["CLAUDE", "CODEX", "KIMI"]);
  const dragged = s.group("CLAUDE");
  const grip = s.grip("CLAUDE");
  await pointer(grip, "pointerdown", 50);
  await pointer(grip, "pointermove", 165);
  // A poll lands: Claude's number moves, Grok appears, the usage order changes.
  s.draw([block("KIMI", 90), block("CLAUDE", 77), block("CODEX", 20), block("GROK", 5)]);
  assert.equal(s.group("CLAUDE"), dragged, "the dragged block is the same node");
  assert.equal(s.grip("CLAUDE"), grip, "and so is its grip");
  assert.equal(grip.captured, 7, "which still holds the pointer");
  assert.match(dragged.textContent, /77%/u, "its values changed in place");
  assert.deepEqual(s.order(), ["CLAUDE", "CODEX", "KIMI"], "nothing added, removed or moved");
  assert.equal(transform(dragged), "translateY(115px)");
  assert.ok(s.slot(), "the slot is still there");
  await pointer(grip, "pointermove", 280);
  assert.equal(transform(s.group("KIMI")), "translateY(-110px)", "the drag goes on");
  await pointer(grip, "pointerup", 280);
  await flush();
  // The drop is My order: the moved list, then the newcomer once the drag ended.
  assert.deepEqual(s.order(), ["CODEX", "KIMI", "CLAUDE", "GROK"]);
  assert.deepEqual(s.memory.writes[0].providers, ["CODEX", "KIMI", "CLAUDE"]);
});

test("the provider being dragged or whose menu is open disappearing cancels it, and says so", async () => {
  const s = await surface(["CLAUDE", "CODEX", "KIMI"]);
  const grip = s.grip("CLAUDE");
  await pointer(grip, "pointerdown", 50);
  await pointer(grip, "pointermove", 165);
  s.draw([block("CODEX"), block("KIMI")]);
  assert.equal(s.mount.dataset.reordering, undefined);
  assert.deepEqual(s.order(), ["CODEX", "KIMI"]);
  assert.equal(s.said(), "Claude Code is no longer shown, so the move was cancelled.");
  assert.equal(s.holds.at(-1), false);
  s.draw([block("CODEX"), block("KIMI"), block("CLAUDE")]);
  await tap(s.grip("KIMI"));
  s.draw([block("CODEX"), block("CLAUDE")]);
  assert.equal(s.menu(), null);
  assert.equal(s.said(), "Kimi is no longer shown, so the move was cancelled.");
  assert.equal(s.holds.at(-1), false);
  await flush();
  assert.deepEqual(s.memory.writes, []);
});

test("in My order a provider seen for the first time joins at the bottom once, by one revision checked write", async () => {
  const s = await surface(["CLAUDE", "CODEX", "KIMI"], { order: { mode: "custom", providers: ["KIMI", "CLAUDE"], revision: 3 } });
  assert.deepEqual(s.order(), ["KIMI", "CLAUDE", "CODEX"], "the newcomer shows after the list");
  await flush();
  assert.deepEqual(s.memory.writes, [{ revision: 3, mode: "custom", providers: ["KIMI", "CLAUDE", "CODEX"] }]);
  s.draw();
  s.draw();
  await flush();
  assert.equal(s.memory.writes.length, 1, "appended once");
  // A listed provider that is not shown is skipped but kept.
  s.draw([block("KIMI"), block("CODEX")]);
  await flush();
  assert.deepEqual(s.order(), ["KIMI", "CODEX"]);
  assert.deepEqual(s.memory.disk.providers, ["KIMI", "CLAUDE", "CODEX"]);
  // Most used first appends nothing.
  const usage = await surface(["CLAUDE", "CODEX"]);
  await flush();
  assert.deepEqual(usage.memory.writes, []);
  // A refused append is not retried in a loop.
  const refused = await surface(["CLAUDE", "GROK"], { order: { mode: "custom", providers: ["CLAUDE"], revision: 1 }, refuse: true });
  await flush();
  refused.draw();
  await flush();
  assert.equal(refused.memory.writes.length, 1);
  assert.deepEqual(refused.order(), ["CLAUDE", "GROK"]);
});

/* --------------------------------------------------------- kept by code */

test("a reorderable list keeps its blocks by provider code, never moves the focused one, and patches by code", () => {
  const doc = fakeDocument(["mount"]);
  const mount = doc.getElementById("mount");
  renderLimits(doc, mount, [block("CLAUDE", 10, "1h"), block("CODEX", 20, "2h")], { grips: true });
  const [claude, codex] = mount.children;
  const grip = claude.all((node) => node.className === "q-grip")[0];
  grip.focus();
  renderLimits(doc, mount, [block("CODEX", 25, "2h"), block("CLAUDE", 15, "1h")], { grips: true });
  assert.deepEqual(mount.children, [codex, claude], "the same nodes, in the new order");
  assert.equal(doc.activeElement, grip, "the focused grip was never taken out of the document");
  assert.equal(claude.all((node) => node.className === "q-grip")[0], grip);
  assert.match(claude.textContent, /15%/u);
  patchLimits(mount, [block("CLAUDE", 15, "9m"), block("CODEX", 25, "8m")]);
  const countdown = (group) => group.all((node) => node.className === "q-rst")[0].textContent;
  assert.equal(countdown(claude), "Resets in 9m", "by code, whatever the order on screen");
  assert.equal(countdown(codex), "Resets in 8m");
  // Without grips a list still draws fresh nodes, as before.
  const plain = doc.createElement("div");
  renderLimits(doc, plain, [block("CLAUDE")]);
  const first = plain.children[0];
  renderLimits(doc, plain, [block("CLAUDE")]);
  assert.notEqual(plain.children[0], first);
  assert.equal(plain.all((node) => node.className === "q-grip").length, 0);
});
