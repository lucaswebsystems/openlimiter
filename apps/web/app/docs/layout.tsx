import type { ReactNode } from "react";
import { DocsSidebar } from "@/components/docs/sidebar";
import { SHELL } from "@/components/ui";

/**
 * The documentation column renders inside the same SHELL as every other band on
 * the site, so the sidebar's left edge lines up with the wordmark above it and
 * the article's right edge lines up with the last header link.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="bg-canvas">
      <div className={`${SHELL} flex gap-12`}>
        <div className="hidden w-56 flex-none lg:block">
          <DocsSidebar variant="full" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="lg:hidden">
            <DocsSidebar variant="compact" />
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
