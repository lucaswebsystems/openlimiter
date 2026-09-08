export const TERMINOLOGY: Set<string>;
export const TECHNICAL_KEYS: Set<string>;
export function proseDigest(value: string): string;
export function isTechnicalKey(path: string): boolean;
export function hasForbiddenProseDash(value: unknown): boolean;
export function untranslatedProse(
  locale: string,
  path: string,
  source: string,
  translation: string,
  legacy: Record<string, { digest: string; locales: string[] }>,
): boolean;
