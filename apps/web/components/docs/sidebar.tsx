"use client";

import { SiteLink } from "@/components/site-link";
import { usePathname } from "@/i18n/navigation";

/**
 * The persistent documentation navigation.
 *
 * The full variant sticks beside the content from the large breakpoint up. The
 * compact variant takes over below it as a native disclosure, which keeps the
 * keyboard and screen reader behaviour the browser already provides. Only one of
 * the two is ever in the tree, so there is a single navigation landmark.
 *
 * WHY THE LABELS ARRIVE AS PROPS
 * ------------------------------
 * This is the one piece of the documentation that has to hydrate, because
 * highlighting the current page means knowing which page that is. It could read
 * the catalog itself, but the `docs` namespace holds every page's meta
 * description and lead as well as its label, and shipping all of it to the
 * browser so a list can bold one row would put the whole documentation's prose
 * into the HTML of every documentation page. The layout reads the catalog on the
 * server and sends down eleven labels.
 *
 * `usePathname` is next-intl's, and it has to be: Next's own would report
 * `/pt-BR/docs/cli`, which matches none of the routes in the map, and the
 * current page would never be marked on any translated page.
 */

export interface SidebarGroup {
  id: string;
  label: string;
  pages: readonly { href: string; label: string }[];
}

function GroupList({ groups, pathname }: { groups: readonly SidebarGroup[]; pathname: string }) {
  return (
    <div className="space-y-7">
      {groups.map((group) => (
        <div key={group.id}>
          <p className="mb-2.5 font-mono text-2xs uppercase tracking-widest text-muted">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.pages.map((page) => {
              const active = pathname === page.href;
              return (
                <li key={page.href}>
                  <SiteLink
                    href={page.href}
                    aria-current={active ? "page" : undefined}
                    className={`focus-ring block rounded-md px-3 py-1.5 font-sans text-sm transition-colors ${
                      active
                        ? "bg-accent-subtle font-medium text-accent"
                        : "text-body hover:bg-surface hover:text-heading"
                    }`}
                  >
                    {page.label}
                  </SiteLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function DocsSidebar({
  variant,
  groups,
  navLabel,
  menuLabel,
}: {
  variant: "full" | "compact";
  groups: readonly SidebarGroup[];
  navLabel: string;
  menuLabel: string;
}) {
  const pathname = usePathname();

  if (variant === "compact") {
    return (
      <details className="mb-8 rounded-xl border border-hairline bg-surface">
        <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 font-sans text-sm font-medium text-heading">
          {menuLabel}
        </summary>
        <nav aria-label={navLabel} className="border-t border-hairline px-2 py-4">
          <GroupList groups={groups} pathname={pathname} />
        </nav>
      </details>
    );
  }

  return (
    <nav
      aria-label={navLabel}
      className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-10"
    >
      <GroupList groups={groups} pathname={pathname} />
    </nav>
  );
}
