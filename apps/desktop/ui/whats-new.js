import { FIRST_RUN_STORAGE_KEY } from "./first-run.js";

export const WHATS_NEW_STORAGE_KEY = "openlimiter-whats-new-seen";

export function whatsNewForVersion(version, catalog) {
  if (!Object.hasOwn(catalog.releases, version)) return null;
  const release = catalog.releases[version];
  const { heading, ...items } = release;
  return {
    title: catalog.title,
    versionLabel: catalog.versionLabel.replace("{version}", version),
    heading,
    dismiss: catalog.dismiss,
    items: Object.entries(items).map(([key, text]) => ({ key, text })),
  };
}

/**
 * Wait for the existing onboarding flow before taking focus.
 *
 * Release notes are for an upgrade. An install whose first run has never
 * finished is a fresh one, and its first bars are not covered by a list of
 * what changed since a version it never ran: when its first run ends, this
 * release is marked seen and nothing opens.
 */
export async function initWhatsNew({
  document: doc = document,
  storage = () => window.localStorage,
  // A local script module works with the desktop's restricted connect policy.
  load = () => import("./whats-new-data.js"),
  observe = (callback) => new MutationObserver(callback),
} = {}) {
  let fresh = false;
  try {
    fresh = storage().getItem(FIRST_RUN_STORAGE_KEY) !== "complete";
  } catch {
    // Unreadable storage cannot prove a fresh install, so it shows the notes.
  }
  const { version, catalog } = await load();
  const entry = whatsNewForVersion(version, catalog);
  if (!entry) return;
  let shown = false;
  const watcher = observe(show);
  function show() {
    if (shown || doc.documentElement.dataset.firstRun !== "complete") return;
    if (fresh) {
      watcher.disconnect();
      try {
        storage().setItem(WHATS_NEW_STORAGE_KEY, version);
      } catch {
        // Storage refused: nothing is remembered, and nothing was shown.
      }
      return;
    }
    try {
      if (storage().getItem(WHATS_NEW_STORAGE_KEY) === version) {
        watcher.disconnect();
        return;
      }
    } catch {
      // A refused storage write must not block the rest of the desktop.
    }
    const dialog = doc.createElement("dialog");
    dialog.className = "whats-new";
    dialog.setAttribute("aria-labelledby", "whats-new-title");
    const node = (tag, text) => {
      const element = doc.createElement(tag);
      element.textContent = text;
      return element;
    };
    const title = node("h2", entry.title);
    title.id = "whats-new-title";
    title.tabIndex = -1;
    title.autofocus = true;
    const list = doc.createElement("ul");
    for (const { text } of entry.items) list.append(node("li", text));
    const dismiss = node("button", entry.dismiss);
    dismiss.type = "button";
    dismiss.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove());
    dialog.append(title, node("p", entry.versionLabel), node("h3", entry.heading), list, dismiss);
    doc.body.append(dialog);
    try {
      dialog.showModal();
    } catch (error) {
      dialog.remove();
      watcher.disconnect();
      throw error;
    }
    shown = true;
    watcher.disconnect();
    try {
      storage().setItem(WHATS_NEW_STORAGE_KEY, version);
    } catch {
      // Keep the session usable even when persistence is unavailable.
    }
  }
  watcher.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-first-run"] });
  show();
}

export async function openWhatsNew({ document: doc = document, load = () => import("./whats-new-data.js") } = {}) {
  const { version, catalog } = await load();
  const entry = whatsNewForVersion(version, catalog);
  if (!entry) return null;
  const node = (tag, text) => {
    const element = doc.createElement(tag);
    element.textContent = text;
    return element;
  };
  const dialog = doc.createElement("dialog");
  dialog.className = "whats-new";
  dialog.setAttribute("aria-labelledby", "whats-new-title");
  const title = node("h2", entry.title);
  title.id = "whats-new-title";
  title.tabIndex = -1;
  const list = doc.createElement("ul");
  for (const { text } of entry.items) list.append(node("li", text));
  const dismiss = node("button", entry.dismiss);
  dismiss.type = "button";
  dismiss.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(title, node("p", entry.versionLabel), node("h3", entry.heading), list, dismiss);
  doc.body.append(dialog);
  dialog.showModal?.();
  title.focus?.();
  return dialog;
}
