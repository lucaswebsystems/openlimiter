import catalog from "./agents.en.json" with { type: "json" };

export const AGENTS_EN = Object.freeze(catalog);

export function agentText(key, values = {}) {
  return (AGENTS_EN[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => values[name] ?? "");
}
