import { createHash } from "node:crypto";

/** Product names are terminology, never a blanket exemption for sentences. */
export const TERMINOLOGY = new Set([
  "OpenLimiter Pro", "Claude Code", "Grok Build", "Gemini CLI", "Antigravity CLI", "Windows MSI",
]);

export function proseDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Legacy debt is frozen by locale, key and exact source value. New or edited prose fails. */
export function untranslatedProse(locale, path, source, translation, legacy) {
  if (source !== translation || typeof source !== "string" || !/\s/u.test(source.trim())) return false;
  if (TERMINOLOGY.has(source)) return false;
  const entry = legacy[path];
  return !(entry?.locales.includes(locale) && entry.digest === proseDigest(source));
}
