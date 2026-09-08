import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TECHNICAL_KEYS_FILE = (() => {
  try {
    return fileURLToPath(new URL("./i18n-technical-keys.json", import.meta.url));
  } catch {
    return join(process.cwd(), "scripts", "i18n-technical-keys.json");
  }
})();
export const TECHNICAL_KEYS = new Set(JSON.parse(readFileSync(TECHNICAL_KEYS_FILE, "utf8")));
const LETTER_DASH_LETTER = /\p{L}-\p{L}/u;

/** Product names are terminology, never a blanket exemption for sentences. */
export const TERMINOLOGY = new Set([
  "OpenLimiter Pro", "Claude Code", "Grok Build", "Gemini CLI", "Antigravity CLI", "Windows MSI",
]);

export function proseDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isTechnicalKey(path) {
  return TECHNICAL_KEYS.has(path);
}

export function hasForbiddenProseDash(value) {
  return typeof value === "string" && (LETTER_DASH_LETTER.test(value) || /[–—]/u.test(value));
}

/** Legacy debt is frozen by locale, key and exact source value. New or edited prose fails. */
export function untranslatedProse(locale, path, source, translation, legacy) {
  if (source !== translation || typeof source !== "string" || !/\s/u.test(source.trim())) return false;
  if (isTechnicalKey(path) || TERMINOLOGY.has(source)) return false;
  const entry = legacy[path];
  return !(entry?.locales.includes(locale) && entry.digest === proseDigest(source));
}
