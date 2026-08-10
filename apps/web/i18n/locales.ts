/**
 * The five languages this site is published in, and the facts about each one
 * that are not prose.
 *
 * A locale's name, its flag and its Open Graph code are data rather than copy:
 * they are written in the language itself and are identical in every catalog,
 * so putting them in `messages/*.json` would mean five files agreeing to say
 * "Deutsch" five times. The catalogs hold sentences. This file holds the table.
 *
 * `en` is the default and is never prefixed. The other four sit behind their own
 * segment, spelled exactly as it appears in the URL, `pt-BR` included: the
 * region is capitalised because that is the case BCP 47 writes it in and the
 * case the `hreflang` attribute is read in.
 */

export const LOCALES = ["en", "pt-BR", "es", "de", "ja"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string | undefined | null): value is Locale {
  return value !== undefined && value !== null && (LOCALES as readonly string[]).includes(value);
}

export interface LocaleFace {
  /** The name of the language, written in that language. */
  name: string;
  /** The flag in front of that name in the switcher. */
  flag: string;
  /** What goes in `og:locale`, which wants an underscore and a region. */
  ogLocale: string;
}

export const LOCALE_FACES: Record<Locale, LocaleFace> = {
  en: { name: "English", flag: "🇺🇸", ogLocale: "en_US" },
  "pt-BR": { name: "Português", flag: "🇧🇷", ogLocale: "pt_BR" },
  es: { name: "Español", flag: "🇪🇸", ogLocale: "es_ES" },
  de: { name: "Deutsch", flag: "🇩🇪", ogLocale: "de_DE" },
  ja: { name: "日本語", flag: "🇯🇵", ogLocale: "ja_JP" },
};

/**
 * Which locale a browser language tag lands on.
 *
 * The middleware negotiates Accept-Language against this rather than against
 * the locale list, because a header says `pt-PT` or `es-419` or `de-AT` far
 * more often than it says one of our five codes exactly. Everything Portuguese
 * lands on Brazilian Portuguese because that is the only Portuguese there is
 * here, and the same reasoning covers the other three.
 *
 * Nothing in here redirects anybody. It only decides which language the offer
 * banner is written in. See middleware.ts.
 */
const BASE_LANGUAGE_TO_LOCALE: Record<string, Locale> = {
  en: "en",
  pt: "pt-BR",
  es: "es",
  de: "de",
  ja: "ja",
};

/**
 * The locale a request prefers, or null when it prefers nothing we publish.
 *
 * Reads Accept-Language in the order the browser sent it, honouring the quality
 * values, and returns the first entry that maps to one of our languages. A
 * header naming a language we do not have is not an error and not a fallback: it
 * is a visitor who gets the site in English with no banner, which is decision 3.
 */
export function negotiateLocale(header: string | null): Locale | null {
  if (header === null || header.trim() === "") return null;

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim())
        .filter((parameter) => parameter.startsWith("q="))
        .map((parameter) => Number.parseFloat(parameter.slice(2)))
        .find((value) => Number.isFinite(value));
      return { tag: tag.trim().toLowerCase(), quality: quality ?? 1 };
    })
    .filter((entry) => entry.tag !== "" && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const entry of ranked) {
    if (entry.tag === "*") continue;
    const base = entry.tag.split("-")[0];
    const match = BASE_LANGUAGE_TO_LOCALE[base];
    if (match !== undefined) return match;
  }

  return null;
}
