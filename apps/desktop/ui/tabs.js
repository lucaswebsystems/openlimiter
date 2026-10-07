const TAB_KEY = "openlimiter-tab";

function safeStored(storage) {
  try {
    return storage?.getItem(TAB_KEY) ?? null;
  } catch {
    return null;
  }
}

export function tabSwitcher({ tabs, panels, storage = globalThis.localStorage, onSelect = () => {} }) {
  const tabList = Array.from(tabs ?? []);
  const panelList = Array.from(panels ?? []);
  const indexOf = (tab) => Math.max(0, tabList.indexOf(tab));
  const select = (tab, persist = true) => {
    const chosen = tabList.includes(tab) ? tab : tabList[0];
    for (const candidate of tabList) {
      const active = candidate === chosen;
      candidate.setAttribute("aria-selected", String(active));
      candidate.tabIndex = active ? 0 : -1;
    }
    for (const panel of panelList) {
      panel.hidden = panel.getAttribute("aria-labelledby") !== chosen.id;
    }
    if (persist) {
      try { storage?.setItem(TAB_KEY, chosen.id.replace(/^tab-/u, "")); } catch { /* Usage remains available. */ }
    }
    onSelect(chosen.id, chosen);
  };
  const move = (tab, delta) => {
    const index = indexOf(tab);
    return tabList[(index + delta + tabList.length) % tabList.length];
  };
  for (const tab of tabList) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = move(tab, 1);
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = move(tab, -1);
      if (event.key === "Home") next = tabList[0];
      if (event.key === "End") next = tabList.at(-1);
      if (!next) return;
      event.preventDefault();
      select(next);
      next.focus();
    });
  }
  const stored = safeStored(storage);
  const initial = tabList.find((tab) => tab.id === `tab-${stored}`) ?? tabList[0];
  select(initial, false);
  return { select: (tab) => select(tab), current: () => tabList.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabList[0] };
}
