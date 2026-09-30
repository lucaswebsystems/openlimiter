import type { ReactNode } from "react";
import { SHELL } from "./ui";
import { reveal } from "@/lib/motion";

/**
 * The shell every page other than the home page renders inside.
 *
 * It is the same SHELL the header, the home page and the footer use, so a
 * reader moving between pages never sees the column jump. The page heading
 * keeps the 48 pixel gap under it that every section heading uses, and the
 * header above already carries the top padding, so this starts flat against it.
 */
export function PageShell({
  title,
  lead,
  quietChrome = false,
  children,
}: {
  title: string;
  lead: string;
  /**
   * For a page that renders the sign in card. The announcement bar and the
   * locale toast stay off it, declared here on the server so neither paints
   * first; the rule reads the attribute in app/globals.css.
   */
  quietChrome?: boolean;
  children: ReactNode;
}) {
  return (
    <main
      id="main"
      className={`${SHELL} page-shell text-center`}
      {...(quietChrome ? { "data-quiet-chrome": "" } : {})}
    >
      {/* Centered at full wrapper width, the same rule the home sections
         follow: the founder's standard for every one column surface. The
         balance keeps the last line from stranding three words. */}
      <header className="mb-section-heading space-y-4 text-center" {...reveal}>
        <h1 className="text-3xl font-medium tracking-tight text-heading md:text-5xl">{title}</h1>
        <p className="mx-auto max-w-[var(--ol-reading-width)] text-lg leading-relaxed text-soft [text-wrap:balance]">
          {lead}
        </p>
      </header>
      {children}
    </main>
  );
}

/** Shared spacing for reading sections and marketing bands. */
export function ShellSections({ children }: { children: ReactNode }) {
  return <div className="shell-sections">{children}</div>;
}

export function SectionBand({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <div className={compact ? "section-band section-band-compact" : "section-band"}>{children}</div>;
}
