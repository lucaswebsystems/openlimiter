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
  children,
}: {
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className={`${SHELL} pb-6 md:pb-20`}>
      <header className="mb-12 space-y-4" {...reveal}>
        <h1 className="text-3xl font-medium tracking-tight text-heading md:text-5xl">{title}</h1>
        <p className="max-w-2xl text-lg leading-relaxed text-soft">{lead}</p>
      </header>
      {children}
    </main>
  );
}

/** A section inside a shell, at the same 96 pixel rhythm the home page uses. */
export function ShellSections({ children }: { children: ReactNode }) {
  return <div className="space-y-24">{children}</div>;
}
