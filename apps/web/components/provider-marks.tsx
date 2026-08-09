/**
 * Provider marks.
 *
 * Every one of these is drawn here, from scratch, out of circles, lines and
 * polygons. Not one is a third party logo file and not one is hotlinked: they
 * are simple geometric stand ins that read at 24 pixels, painted in
 * `currentColor` so they follow the theme like any other glyph. If a provider
 * ever supplies artwork under a licence that allows it, this is the one file
 * that changes.
 */

import type { ReactNode } from "react";

function Mark({ children, title }: { children: ReactNode; title: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      {children}
    </svg>
  );
}

/** Claude: an eight ray burst. */
export function ClaudeMark() {
  return (
    <Mark title="Claude">
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
    </Mark>
  );
}

/** OpenAI Codex: a hexagon with the seam of a cube inside it. */
export function CodexMark() {
  return (
    <Mark title="OpenAI Codex">
      <path d="M12 2.6 20.1 7.3v9.4L12 21.4 3.9 16.7V7.3z" />
      <path d="m8 9.4 4 2.3 4-2.3M12 11.7v4.6" />
    </Mark>
  );
}

/** Google Antigravity: a chevron lifting off a baseline. */
export function AntigravityMark() {
  return (
    <Mark title="Google Antigravity">
      <path d="M4 20h16" />
      <path d="M12 4 4.5 15h15z" />
    </Mark>
  );
}

/** OpenCode: a pair of brackets around a caret. */
export function OpenCodeMark() {
  return (
    <Mark title="OpenCode">
      <path d="M8.5 4H5.5a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 5.5 20h3" />
      <path d="M15.5 4h3A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-3" />
      <path d="m10.5 9.5 2.5 2.5-2.5 2.5" />
    </Mark>
  );
}

/** OpenRouter: three inputs converging on one node. */
export function OpenRouterMark() {
  return (
    <Mark title="OpenRouter">
      <circle cx="18" cy="12" r="2.5" />
      <path d="M3 6h4l3.5 6H15.5M3 18h4l3.5-6" />
      <path d="M3 12h4" />
    </Mark>
  );
}

/** The five marks, in the order the hero row shows them. */
export const providerMarks = [
  { name: "Claude", Mark: ClaudeMark },
  { name: "OpenAI Codex", Mark: CodexMark },
  { name: "Google Antigravity", Mark: AntigravityMark },
  { name: "OpenCode", Mark: OpenCodeMark },
  { name: "OpenRouter", Mark: OpenRouterMark },
] as const;
