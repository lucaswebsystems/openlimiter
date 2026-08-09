import type { ReactNode } from "react";
import { reveal } from "@/lib/motion";

/**
 * The small shared vocabulary the whole site is built from.
 *
 * The metrics here are measured, not chosen. A button is 38 pixels tall with an
 * 8 pixel radius, 16 pixels of horizontal padding and 14 pixel medium text; the
 * primary carries a transparent border purely so it lines up with the ghost,
 * which carries a real one. A card has a 12 pixel radius and a hairline border.
 * Every colour is a token, so both themes follow.
 */

/**
 * The one content column on the site.
 *
 * Every band on every page renders inside this and nothing else: the header,
 * the hero, the product frame, each home page section, the documentation
 * layout and the footer. That is the whole width system, and it is deliberate
 * rather than incidental, so no section can end up narrower than the one above
 * it and no horizontal row can be clipped by a container its siblings do not
 * share. At 1440 it measures 1152 pixels with a 144 pixel gutter each side.
 *
 * A row that is meant to run wider than the text, such as the sliding strip,
 * cancels this padding with FULL_BLEED rather than inventing its own width.
 */
export const SHELL = "mx-auto w-full max-w-7xl px-6 md:px-12 lg:px-16";

/**
 * Cancels exactly the padding SHELL applies, so a child spans the full column
 * and no more. The negative margins mirror SHELL's padding step for step.
 */
export const FULL_BLEED = "-mx-6 md:-mx-12 lg:-mx-16";

/**
 * Breaks out of SHELL entirely and spans the whole viewport, edge to edge.
 * SHELL is a centred max width column, so cancelling its padding still leaves
 * a strip stopping at the column edge on any screen wider than the column,
 * with dead gutters either side. A sliding row wants the viewport, not the
 * column: centre it on the column, then stretch it a full screen wide. The
 * body already clips horizontal overflow, so the breakout cannot cause a
 * sideways scrollbar.
 */
export const VIEWPORT_BLEED = "relative left-1/2 w-screen -translate-x-1/2";

export function GitHubMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} fill-current`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

const buttonBase =
  "lift-sm focus-ring inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium";

const buttonTone = {
  primary: "border-transparent bg-solid text-on-solid hover:bg-solid-hover",
  ghost:
    "border-hairline-strong bg-transparent text-heading hover:border-heading hover:bg-surface",
  quiet: "border-transparent text-muted hover:text-heading",
} as const;

export type ButtonTone = keyof typeof buttonTone;

export function ButtonLink({
  href,
  tone = "ghost",
  external = false,
  className = "",
  label,
  children,
}: {
  href: string;
  tone?: ButtonTone;
  external?: boolean;
  className?: string;
  /** Accessible name, for the icon only buttons that have no text. */
  label?: string;
  children: ReactNode;
}) {
  const externalProps = external ? { target: "_blank", rel: "noopener noreferrer" } : {};
  const naming = label === undefined ? {} : { "aria-label": label, title: label };
  return (
    <a
      href={href}
      {...externalProps}
      {...naming}
      className={`${buttonBase} ${buttonTone[tone]} ${className}`}
    >
      {children}
    </a>
  );
}

/**
 * A square ghost button holding one 20 pixel icon. Same height and radius as
 * the text buttons beside it, 12 pixels of horizontal padding instead of 16.
 */
export function IconButtonLink({
  href,
  label,
  children,
}: {
  href: string;
  /** Always required here: the control carries no visible text. */
  label: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      className="lift-sm focus-ring inline-flex items-center justify-center rounded-lg border border-hairline-strong px-3 py-2 text-heading hover:border-heading hover:bg-surface"
    >
      {children}
    </a>
  );
}

const chipTone = {
  neutral: "border-hairline bg-surface text-muted",
  strong: "border-hairline bg-raised text-heading",
  accent: "border-accent-subtle bg-accent-subtle text-accent",
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
      className={`inline-flex items-center rounded-full border px-2 py-1 text-xs ${chipTone[tone]} ${className}`}
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
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-raised px-2 py-1 font-mono text-2xs uppercase tracking-wider text-muted">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-solid" />
      Demo data
    </span>
  );
}

/**
 * The heading block that opens every section, at the reference's exact rhythm:
 * a 30 pixel medium heading, an optional status chip on the same line, a 16
 * pixel muted lead capped at 512 pixels, and 48 pixels of air underneath.
 */
export function SectionHeading({
  id,
  title,
  lead,
  status,
}: {
  id?: string;
  title: string;
  lead?: string;
  status?: string;
}) {
  return (
    <div className="mb-12 space-y-2" {...reveal}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={id} className="text-3xl font-medium text-heading">
          {title}
        </h2>
        {status !== undefined && <Chip tone="accent">{status}</Chip>}
      </div>
      {lead !== undefined && <p className="max-w-lg text-base text-muted">{lead}</p>}
    </div>
  );
}

/**
 * A plain content card. One radius, one border, one fill, one hover response,
 * used by every grid on the site so nothing drifts.
 */
export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`${CARD} ${className}`} {...reveal}>
      {children}
    </div>
  );
}

/**
 * The card surface as a class, for the places that need the element itself to
 * be a link or a grid child rather than a wrapper.
 */
export const CARD =
  "lift rounded-xl border border-hairline bg-surface px-5 py-4 hover:border-hairline-strong hover:bg-raised";
