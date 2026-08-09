import type { ReactNode } from "react";

/**
 * The small shared vocabulary the whole site is built from.
 *
 * Buttons, chips and the GitHub mark live here so the radii, the padding and
 * the colour tokens stay identical on the landing page and inside the docs.
 */

export function GitHubMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} fill-current`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

const buttonBase =
  "focus-ring inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 font-sans text-sm font-medium transition-colors";

const buttonTone = {
  primary: "bg-accent-solid text-on-accent hover:bg-accent-solid-hover",
  secondary:
    "border border-hairline bg-surface text-heading hover:border-hairline-strong hover:bg-raised",
  quiet: "text-body hover:text-heading",
} as const;

export type ButtonTone = keyof typeof buttonTone;

export function ButtonLink({
  href,
  tone = "secondary",
  external = false,
  className = "",
  children,
}: {
  href: string;
  tone?: ButtonTone;
  external?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const externalProps = external
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};
  return (
    <a href={href} {...externalProps} className={`${buttonBase} ${buttonTone[tone]} ${className}`}>
      {children}
    </a>
  );
}

const chipTone = {
  neutral: "border-hairline bg-surface text-body",
  strong: "border-hairline bg-raised text-heading",
  accent: "border-hairline bg-accent-subtle text-accent",
} as const;

export type ChipTone = keyof typeof chipTone;

export function Chip({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: ChipTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-2xs ${chipTone[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Every synthetic visual on this site carries one of these. Nothing on the page
 * is a reading from a real account.
 */
export function DemoDataChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-raised px-2 py-0.5 font-mono text-2xs uppercase tracking-wider text-muted">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-solid" />
      Demo data
    </span>
  );
}

export function SectionHeading({
  id,
  eyebrow,
  title,
  lead,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  lead?: string;
}) {
  return (
    <div className="max-w-2xl">
      {eyebrow !== undefined && (
        <p className="mb-3 font-mono text-2xs uppercase tracking-widest text-muted">{eyebrow}</p>
      )}
      <h2 id={id} className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
        {title}
      </h2>
      {lead !== undefined && (
        <p className="mt-3 font-sans text-sm leading-relaxed text-body">{lead}</p>
      )}
    </div>
  );
}

export function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`border-t border-hairline px-4 py-20 sm:px-6 lg:px-8 ${className}`}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}
