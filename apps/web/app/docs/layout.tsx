import type { ReactNode } from "react";
import { DocsSidebar } from "@/components/docs/sidebar";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="bg-canvas">
      <div className="mx-auto flex max-w-7xl gap-12 px-4 pt-10 sm:px-6 lg:px-8">
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
