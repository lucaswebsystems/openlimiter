/**
 * The documentation map.
 *
 * One typed list drives the sidebar, the previous and next links at the foot of
 * every page, and the sitemap, so a page can never appear in one of those and
 * be missing from another.
 */

export interface DocPage {
  /** Route, always absolute. */
  href: string;
  /** Sidebar label and page heading. */
  title: string;
  /**
   * The title tag, when a search result needs more words than a sidebar label
   * can spare. A short label like "CLI reference" is right in the navigation
   * and far too thin in a result page, so the two are allowed to differ. Left
   * unset, the label is the title.
   */
  metaTitle?: string;
  /** Meta description, and the lead paragraph under the heading. */
  description: string;
}

export interface DocGroup {
  title: string;
  pages: readonly DocPage[];
}

export const docGroups: readonly DocGroup[] = [
  {
    title: "Start here",
    pages: [
      {
        href: "/docs",
        title: "Getting started",
        metaTitle: "Getting started: install and meter your quota",
        description:
          "Install the workspace, run the demo, and wire OpenLimiter into Claude Code in a few minutes.",
      },
      {
        href: "/docs/why-openlimiter",
        title: "Why OpenLimiter",
        description:
          "When you hold several AI coding subscriptions the scarce resource stops being money and becomes quota.",
      },
    ],
  },
  {
    title: "Using it",
    pages: [
      {
        href: "/docs/providers",
        title: "Supported providers",
        description:
          "The six connectors that ship today, what each one reads, and how likely it is to break.",
      },
      {
        href: "/docs/connections",
        title: "Connections",
        metaTitle: "Connections: source chips and the state vocabulary",
        description:
          "What each connection state and source chip actually means, stated honestly, including what Import only does and does not do.",
      },
      {
        href: "/docs/ingestion",
        title: "Ingestion",
        description:
          "The three offline paths that put quota data in front of OpenLimiter, and what each one expects.",
      },
      {
        href: "/docs/agent-context",
        title: "Agent context",
        description:
          "What the Claude Code statusline and prompt hook inject, and the boundary that keeps provider text out.",
      },
      {
        href: "/docs/configuration",
        title: "Configuration",
        description:
          "The state directory, the configuration file, the cache, and the settings Claude Code needs.",
      },
    ],
  },
  {
    title: "Reference",
    pages: [
      {
        href: "/docs/cli",
        title: "CLI reference",
        metaTitle: "CLI reference: commands, flags and exit codes",
        description:
          "Every command the CLI accepts today, with its flags, its output, and its exit codes.",
      },
      {
        href: "/docs/security",
        title: "Security and privacy",
        description:
          "What OpenLimiter guarantees, what it deliberately does not do, and how to report a problem.",
      },
      {
        href: "/docs/roadmap",
        title: "Roadmap",
        description:
          "What is planned and not yet built: mobile applications, encrypted sync, and signed builds with an automatic update channel.",
      },
    ],
  },
];

/** Sidebar order, flattened. Previous and next read from this. */
export const docPages: readonly DocPage[] = docGroups.flatMap((group) => group.pages);

export function findDocPage(href: string): DocPage | undefined {
  return docPages.find((page) => page.href === href);
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
