export const CONFIGURED_PROVIDERS_STORAGE_KEY =
  "openlimiter-configured-providers-v1";

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
