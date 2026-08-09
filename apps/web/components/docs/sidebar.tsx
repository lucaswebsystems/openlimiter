"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docGroups } from "@/lib/docs";

function GroupList({ pathname }: { pathname: string }) {
  return (
    <div className="space-y-7">
      {docGroups.map((group) => (
        <div key={group.title}>
          <p className="mb-2.5 font-mono text-2xs uppercase tracking-widest text-muted">
            {group.title}
          </p>
          <ul className="space-y-0.5">
            {group.pages.map((page) => {
              const active = pathname === page.href;
              return (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    aria-current={active ? "page" : undefined}
                    className={`focus-ring block rounded-md px-3 py-1.5 font-sans text-sm transition-colors ${
                      active
                        ? "bg-accent-subtle font-medium text-accent"
                        : "text-body hover:bg-surface hover:text-heading"
                    }`}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * The persistent documentation navigation.
 *
 * The full variant sticks beside the content from the large breakpoint up. The
 * compact variant takes over below it as a native disclosure, which keeps the
 * keyboard and screen reader behaviour the browser already provides. Only one
 * of the two is ever in the tree, so there is a single navigation landmark.
 */
export function DocsSidebar({ variant }: { variant: "full" | "compact" }) {
  const pathname = usePathname();

  if (variant === "compact") {
    return (
      <details className="mb-8 rounded-xl border border-hairline bg-surface">
        <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 font-sans text-sm font-medium text-heading">
          Documentation menu
        </summary>
        <nav aria-label="Documentation" className="border-t border-hairline px-2 py-4">
          <GroupList pathname={pathname} />
        </nav>
      </details>
    );
  }

  return (
    <nav
      aria-label="Documentation"
      className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-10"
    >
      <GroupList pathname={pathname} />
    </nav>
  );
}
