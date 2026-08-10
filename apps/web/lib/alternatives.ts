/**
 * Honest comparison data.
 *
 * Every claim on these pages was read off the project's own repository, README
 * or store listing in August 2026, and the source is linked beside it. Where a
 * fact could not be confirmed it says so rather than guessing, and where a name
 * is contested on GitHub the exact repository is named so a reader does not
 * land on a different project.
 *
 * The rule for the `strength` entry is that it must be something the tool
 * genuinely does better than OpenLimiter, written plainly. The rule for
 * `difference` is that it describes scope, not quality: these are good tools
 * solving overlapping problems, and several of them are more mature than this
 * one. Nothing here is written to make OpenLimiter look better than it is.
 * Those two rules govern the translated sentences exactly as they governed the
 * literals that used to sit in this file.
 *
 * STRUCTURE HERE, WORDS IN THE CATALOG
 * ------------------------------------
 * The site is published in five languages, so what stays below is the part that
 * is the same in all five: the slug, which is the route segment and the order
 * the previous and next links read in, and the url of the project itself. Every
 * sentence moved to `alternatives.entries.<slug>` in the catalogs, keyed by that
 * same slug:
 *
 *   `summary`     one line for the index card and the page's own lead
 *   `what`        two plain sentences on what it does
 *   `platform`    where it runs
 *   `licence`     the licence, or the fact that none is stated
 *   `coverage`    which providers or tools it covers, as its own docs list them
 *   `source`      local files, a provider API, or both
 *   `strength`    a real strength, not a concession
 *   `difference`  a scope difference, written without claiming superiority
 *   `caveat`      any ambiguity a reader needs before they go looking
 *
 * A tool with nothing ambiguous about it has no `caveat` key, and the page asks
 * the catalog whether one exists rather than reading a flag from here.
 *
 * The line about when and how all of this was checked went with them, to
 * `alternatives.note`. Every honest comparison needs that line, and both pages
 * that carry it are translated.
 *
 * The name stays a literal. Every one of these is the project's own name, which
 * is the same word in all five languages, so putting it in the catalogs would
 * mean five files agreeing to spell OpenUsage the same way.
 */

export interface Alternative {
  /** Route segment, and the catalog key: `alternatives.entries.<slug>`. */
  slug: string;
  /** The project's own name, a proper noun in every language. */
  name: string;
  /** The exact project, because three of these names are contested. */
  url: string;
}

export const alternatives: readonly Alternative[] = [
  {
    slug: "ccusage",
    name: "ccusage",
    url: "https://github.com/ryoppippi/ccusage",
  },
  {
    slug: "openusage",
    name: "OpenUsage",
    url: "https://github.com/robinebers/openusage",
  },
  {
    slug: "claudebar",
    name: "ClaudeBar",
    url: "https://github.com/tddworks/ClaudeBar",
  },
  {
    slug: "codexbar",
    name: "CodexBar",
    url: "https://github.com/steipete/CodexBar",
  },
  {
    slug: "usagemaster",
    name: "UsageMaster",
    url: "https://apps.apple.com/us/app/usagemaster-ai-usage-tracker/id6772029068?mt=12",
  },
];

export function findAlternative(slug: string): Alternative | undefined {
  return alternatives.find((entry) => entry.slug === slug);
}
