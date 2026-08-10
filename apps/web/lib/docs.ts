/**
 * The documentation map.
 *
 * One typed list drives the sidebar, the previous and next links at the foot of
 * every page, and the sitemap, so a page can never appear in one of those and
 * be missing from another.
 *
 * STRUCTURE HERE, WORDS IN THE CATALOG
 * ------------------------------------
 * This list used to carry each page's title and description as literals. The
 * documentation is published in five languages now, so what stays here is the
 * part that is the same in all five: the order, the grouping and the route.
 * Every string moved to `docs.groups.*` and `docs.pages.*` in the catalogs,
 * keyed by the identifiers below.
 *
 * The identifier is the last segment of the route, which is what makes the
 * catalog readable beside the sidebar it draws: `docs.pages.cli.title` is the
 * CLI page's label, and the front page of the documentation is `index`. It is
 * written out rather than derived, so renaming a route cannot silently orphan a
 * translated string in four other files.
 */

export interface DocPage {
  /** Catalog key. `docs.pages.<id>` holds this page's words. */
  id: string;
  /** Route, always absolute, always the unprefixed English spelling. */
  href: string;
}

export interface DocGroup {
  /** Catalog key. `docs.groups.<id>` is the heading over this group. */
  id: string;
  pages: readonly DocPage[];
}

export const docGroups: readonly DocGroup[] = [
  {
    id: "start",
    pages: [
      {
        id: "index",
        href: "/docs",
      },
      {
        id: "why-openlimiter",
        href: "/docs/why-openlimiter",
      },
    ],
  },
  {
    id: "using",
    pages: [
      {
        id: "providers",
        href: "/docs/providers",
      },
      {
        id: "connections",
        href: "/docs/connections",
      },
      {
        id: "ingestion",
        href: "/docs/ingestion",
      },
      {
        id: "agent-context",
        href: "/docs/agent-context",
      },
      {
        id: "configuration",
        href: "/docs/configuration",
      },
    ],
  },
  {
    id: "reference",
    pages: [
      {
        id: "cli",
        href: "/docs/cli",
      },
      {
        id: "security",
        href: "/docs/security",
      },
      {
        id: "roadmap",
        href: "/docs/roadmap",
      },
    ],
  },
];

/** Sidebar order, flattened. Previous and next read from this. */
export const docPages: readonly DocPage[] = docGroups.flatMap((group) => group.pages);

export function findDocPage(href: string): DocPage | undefined {
  return docPages.find((page) => page.href === href);
}

/** The same lookup from the other end, for a page that knows what it is. */
export function findDocPageById(id: string): DocPage | undefined {
  return docPages.find((page) => page.id === id);
}

export function docNeighbours(href: string): {
  previous: DocPage | null;
  next: DocPage | null;
} {
  const index = docPages.findIndex((page) => page.href === href);
  if (index < 0) return { previous: null, next: null };
  return {
    previous: index > 0 ? docPages[index - 1] : null,
    next: index < docPages.length - 1 ? docPages[index + 1] : null,
  };
}
