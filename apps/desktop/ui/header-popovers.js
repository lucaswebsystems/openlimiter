export function headerPopovers(entries, doc = document, viewport = window) {
  function position() {
    for (const { panel, button } of entries) {
      const bottom = button.getBoundingClientRect().bottom;
      panel.style.setProperty("--header-popover-top", `${Math.max(8, Math.min(bottom + 8, viewport.innerHeight - 96))}px`);
    }
  }
  function close() {
    for (const { panel, button, onClose } of entries) {
      if (panel.hidden) continue;
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      onClose?.();
      button.focus();
    }
  }
  for (const entry of entries) {
    const { panel, button, onOpen } = entry;
    doc.body.append(panel);
    button.addEventListener("click", () => {
      const opening = panel.hidden;
      close();
      if (!opening) return;
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      position();
      onOpen?.();
      (panel.querySelector("button, a, input, [tabindex]") ?? panel).focus();
    });
    panel.setAttribute("tabindex", "-1");
  }
  doc.addEventListener("click", (event) => {
    if (!entries.some(({ panel, button }) => panel.contains(event.target) || button.contains(event.target))) close();
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && entries.some(({ panel }) => !panel.hidden)) {
      event.preventDefault();
      close();
    }
  });
  viewport.addEventListener("resize", position);
  viewport.addEventListener("scroll", position, true);
  return { close };
}
