import { readFile } from "node:fs/promises";
import path from "node:path";
import { INTL_LOCALE_TAG, type Locale } from "@/i18n/locales";

/**
 * The changelog page is rendered from the repository's own CHANGELOG.md.
 *
 * There is no second copy of this text on the site and no hand written summary
 * of it. The file at the root of the repository is the single source, so a
 * release note cannot say one thing in the repository and another on the web.
 *
 * The parser below understands exactly the shape that file uses, which is Keep
 * a Changelog: `## [version] (date)` for a release and `### Group` for the
 * headings under it. Anything it does not recognise is carried through as a
 * paragraph rather than dropped, so no line of the real file can go missing.
 *
 * NOTHING HERE IS TRANSLATED, AND THAT IS THE POINT
 * -------------------------------------------------
 * Every version number, group heading and note this returns is a quotation from
 * one file in the repository, so it reaches the page in the language it was
 * written in. The page's own chrome, its heading, its lead, its empty state and
 * its closing note, comes from the `changelog` catalog instead.
 *
 * The one word this file contributes itself is the fallback heading below, for
 * bullets that appear under a release before any `### Group` does. It stays a
 * literal because it is rendered in the same list as the headings quoted from
 * the file, and a translated heading standing among untranslated ones would read
 * as a bug rather than as a courtesy.
 */

export interface ChangelogEntry {
  heading: string;
  items: readonly string[];
}

export interface ChangelogRelease {
  version: string;
  date: string | null;
  entries: readonly ChangelogEntry[];
}

/* The root file when this runs inside the monorepo, and the build time copy
   scripts/pull-changelog.mjs makes when it does not: the deploy uploads only
   this directory, so without the copy the page rendered empty in production. */
const CHANGELOG_PATHS = [
  path.join(process.cwd(), "..", "..", "CHANGELOG.md"),
  path.join(process.cwd(), "CHANGELOG.md"),
];

const RELEASE_PATTERN = /^##\s+\[?([^\]\s]+)\]?(?:\s+\((\d{4}-\d{2}-\d{2})\))?/;

export async function readChangelog(): Promise<readonly ChangelogRelease[]> {
  let source: string | null = null;
  for (const candidate of CHANGELOG_PATHS) {
    try {
      source = await readFile(candidate, "utf8");
      break;
    } catch {
      /* Try the next location. */
    }
  }
  if (source === null) {
    /* A checkout without the file anywhere still renders a page, empty and
       honest, rather than failing the build. */
    return [];
  }

  const releases: ChangelogRelease[] = [];
  let release: { version: string; date: string | null; entries: ChangelogEntry[] } | null = null;
  let entry: { heading: string; items: string[] } | null = null;

  const closeEntry = () => {
    if (release !== null && entry !== null) release.entries.push(entry);
    entry = null;
  };
  const closeRelease = () => {
    closeEntry();
    if (release !== null) releases.push(release);
    release = null;
  };

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const releaseMatch = RELEASE_PATTERN.exec(line);
    if (line.startsWith("## ") && releaseMatch !== null) {
      closeRelease();
      release = { version: releaseMatch[1], date: releaseMatch[2] ?? null, entries: [] };
      continue;
    }

    if (line.startsWith("### ")) {
      closeEntry();
      entry = { heading: line.slice(4).trim(), items: [] };
      continue;
    }

    if (release === null) continue;

    const text = line.startsWith("- ") ? line.slice(2).trim() : line;
    if (entry === null) entry = { heading: "Notes", items: [] };
    entry.items.push(text);
  }

  closeRelease();
  return releases;
}

/** Long form date, so the page never prints a bare numeric string. */
export function formatReleaseDate(date: string | null, locale: Locale): string | null {
  if (date === null) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  /* A release date is one of the few things on the page that a language changes
     the shape of rather than the words of, so it is formatted per locale rather
     than translated. The `en` row of the tag map is `en-GB`, which is what this
     function always passed: 10 August 2026 is the English the site already
     shipped, and `en` on its own would have silently reordered it. */
  return parsed.toLocaleDateString(INTL_LOCALE_TAG[locale], {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
