import type { ReactNode } from "react";
import { DocsSidebar } from "@/components/docs/sidebar";

/**
 * The documentation column sits inside the same 1024 pixel measure the header
 * uses, so the sidebar's left edge lines up with the wordmark above it and the
 * article's right edge lines up with the last header link.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="bg-canvas">
      <div className="mx-auto flex max-w-7xl gap-12 px-6 md:px-32">
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
