import proFeatures from "./pro-features.json";

/**
 * The one Pro list as a phrase inside a sentence, in the reader's language.
 *
 * The announcement, the /pro lead and the plan sentences name what Pro adds
 * through this, each feature in its `proFeatures.inline` words, so the Ember
 * preset is named everywhere and a feature added to lib/pro-features.json
 * reaches every sentence that lists them. English is joined the Commonwealth
 * way, with no comma before the last item.
 */
export function proFeaturePhrase(inline: (id: string) => string, locale: string): string {
  return new Intl.ListFormat(locale === "en" ? "en-GB" : locale, { type: "conjunction" }).format(
    proFeatures.features.map(({ id }) => inline(id)),
  );
}
