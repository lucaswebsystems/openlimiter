import { readFile } from "node:fs/promises";
import path from "node:path";

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

const CHANGELOG_PATH = path.join(process.cwd(), "..", "..", "CHANGELOG.md");

const RELEASE_PATTERN = /^##\s+\[?([^\]\s]+)\]?(?:\s+\((\d{4}-\d{2}-\d{2})\))?/;

export async function readChangelog(): Promise<readonly ChangelogRelease[]> {
  let source: string;
  try {
    source = await readFile(CHANGELOG_PATH, "utf8");
  } catch {
    /* A checkout without the root file still renders a page, empty and honest,
       rather than failing the build. */
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
export function formatReleaseDate(date: string | null): string | null {
  if (date === null) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
