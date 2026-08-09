import type { ReactNode } from "react";

/**
 * The shell every page other than the home page renders inside.
 *
 * It reproduces the reference's content column exactly: 1024 pixels wide, 80
 * pixels of padding from the medium breakpoint up, 24 below it, and the same 48
 * pixel gap under the page heading that every section heading uses. The header
 * is already above it, and already carries the top padding, so this starts flat
 * against it.
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
    <main id="main" className="mx-auto max-w-5xl px-6 pb-6 md:px-20 md:pb-20">
      <header className="mb-12 space-y-4">
        <h1 className="text-3xl font-medium tracking-tight text-heading md:text-5xl">{title}</h1>
        <p className="max-w-lg text-lg leading-relaxed text-soft">{lead}</p>
      </header>
      {children}
    </main>
  );
}

/** A section inside a shell, at the same 96 pixel rhythm the home page uses. */
export function ShellSections({ children }: { children: ReactNode }) {
  return <div className="space-y-24">{children}</div>;
}
