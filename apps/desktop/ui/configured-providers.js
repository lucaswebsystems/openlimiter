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

export function homeSelectionControl(provider, onChange, doc = document) {
  const button = doc.createElement("button");
  button.type = "button";
  const paint = () => {
    button.textContent = isProviderConfigured(provider) ? "Remove from Home" : "Add to Home";
  };
  paint();
  button.addEventListener("click", () => {
    if (isProviderConfigured(provider)) unconfigureProvider(provider);
    else configureProvider(provider);
    paint();
    onChange();
  });
  return button;
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
