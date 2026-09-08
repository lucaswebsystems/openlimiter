export const TERMINOLOGY: Set<string>;
export function proseDigest(value: string): string;
export function untranslatedProse(
  locale: string,
  path: string,
  source: string,
  translation: string,
  legacy: Record<string, { digest: string; locales: string[] }>,
): boolean;
