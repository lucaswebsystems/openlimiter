export const CONFIGURED_PROVIDERS_STORAGE_KEY =
  "openlimiter-configured-providers-v1";
export const REMOVED_PROVIDERS_STORAGE_KEY = "openlimiter-removed-providers-v1";

export function readRemovedProviders() {
  try {
    const values = JSON.parse(window.localStorage.getItem(REMOVED_PROVIDERS_STORAGE_KEY) ?? "[]");
    return Array.isArray(values) ? values.map(normalized).filter(Boolean) : [];
  } catch { return []; }
}

export function adoptDetectedProviders(detections) {
  const removed = readRemovedProviders();
  for (const entry of detections?.providers ?? []) {
    const provider = normalized(entry.provider_id);
    if (entry.state === "present" && provider && !removed.includes(provider) && !isProviderConfigured(provider)) {
      configureProvider(provider);
    }
  }
  return readConfiguredProviders();
}

export function homeSelectionControl(provider, onChange, doc = document, persist = async () => ({ ok: true }), name = String(provider).replaceAll("-", " ")) {
  const label = doc.createElement("label");
  label.className = "provider-switch";
  const input = doc.createElement("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.setAttribute("aria-label", name);
  input.dataset.providerSwitch = provider;
  const track = doc.createElement("span");
  track.className = "provider-switch-track";
  track.setAttribute("aria-hidden", "true");
  const note = doc.createElement("span");
  note.className = "provider-switch-note";
  note.setAttribute("role", "status");
  const paint = () => {
    input.checked = isProviderConfigured(provider);
    input.setAttribute("aria-checked", String(input.checked));
  };
  let busy = false;
  paint();
  input.addEventListener("click", (event) => { if (busy) event.preventDefault(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat && !busy) input.click();
    }
  });
  input.addEventListener("change", async () => {
    const enabled = input.checked;
    input.setAttribute("aria-checked", String(enabled));
    busy = true;
    input.setAttribute("aria-disabled", "true");
    note.textContent = "";
    try {
      const result = await persist(provider, enabled);
      if (!result?.ok) throw new Error("save_failed");
      if (enabled) configureProvider(provider);
      else unconfigureProvider(provider);
      paint();
      onChange();
    } catch {
      note.textContent = "Provider settings could not be saved. Try again.";
    } finally {
      paint();
      busy = false;
      input.setAttribute("aria-disabled", "false");
    }
  });
  label.append(input, track, note);
  return label;
}

const ALLOWED = new Set([
  "CLAUDE",
  "OPENROUTER",
  "CODEX",
  "ANTIGRAVITY",
  "GEMINI_CLI",
  "OPENCODE",
  "GROK",
  "KIMI",
]);

function normalized(provider) {
  const code = String(provider ?? "").toUpperCase().replaceAll("-", "_");
  return ALLOWED.has(code) ? code : null;
}

export function readConfiguredProviders() {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(CONFIGURED_PROVIDERS_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(normalized).filter((code) => code !== null))];
  } catch {
    return [];
  }
}

export function isProviderConfigured(provider) {
  const code = normalized(provider);
  return code !== null && readConfiguredProviders().includes(code);
}

export function configureProvider(provider) {
  const code = normalized(provider);
  if (code === null) return readConfiguredProviders();
  const next = [...new Set([...readConfiguredProviders(), code])];
  try {
    window.localStorage.setItem(REMOVED_PROVIDERS_STORAGE_KEY,
      JSON.stringify(readRemovedProviders().filter((entry) => entry !== code)));
    window.localStorage.setItem(
      CONFIGURED_PROVIDERS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    return readConfiguredProviders();
  }
  window.dispatchEvent(new CustomEvent("openlimiter:providers-changed"));
  return next;
}

export function unconfigureProvider(provider) {
  const code = normalized(provider);
  if (code === null) return readConfiguredProviders();
  const next = readConfiguredProviders().filter((entry) => entry !== code);
  try {
    window.localStorage.setItem(REMOVED_PROVIDERS_STORAGE_KEY,
      JSON.stringify([...new Set([...readRemovedProviders(), code])]));
    window.localStorage.setItem(
      CONFIGURED_PROVIDERS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    return readConfiguredProviders();
  }
  window.dispatchEvent(new CustomEvent("openlimiter:providers-changed"));
  return next;
}
