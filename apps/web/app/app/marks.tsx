import type { ReactNode } from "react";

/**
 * The six provider marks the dashboard draws.
 *
 * Every one is geometry written here, out of lines and circles, painted in
 * `currentColor` so it follows the theme like any other glyph. Not one is a
 * third party logo file and not one is fetched from anywhere. The marketing
 * pages carry their own copy of five of these; this file is the product
 * surface's own, and it adds the sixth, which is the manual provider and has
 * no company behind it to have a logo at all.
 */

function Mark({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Claude: an eight ray burst. */
function ClaudeMark() {
  return (
    <Mark>
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
    </Mark>
  );
}

/** Codex: a hexagon with the seam of a cube inside it. */
function CodexMark() {
  return (
    <Mark>
      <path d="M12 2.6 20.1 7.3v9.4L12 21.4 3.9 16.7V7.3z" />
      <path d="m8 9.4 4 2.3 4-2.3M12 11.7v4.6" />
    </Mark>
  );
}

/** Antigravity: a chevron lifting off a baseline. */
function AntigravityMark() {
  return (
    <Mark>
      <path d="M4 20h16" />
      <path d="M12 4 4.5 15h15z" />
    </Mark>
  );
}

/** OpenCode: a pair of brackets around a caret. */
function OpenCodeMark() {
  return (
    <Mark>
      <path d="M8.5 4H5.5a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 5.5 20h3" />
      <path d="M15.5 4h3A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-3" />
      <path d="m10.5 9.5 2.5 2.5-2.5 2.5" />
    </Mark>
  );
}

/** OpenRouter: three inputs converging on one node. */
function OpenRouterMark() {
  return (
    <Mark>
      <circle cx="18" cy="12" r="2.5" />
      <path d="M3 6h4l3.5 6H15.5M3 18h4l3.5-6" />
      <path d="M3 12h4" />
    </Mark>
  );
}

/** Manual: a sheet with a written line on it. */
function ManualMark() {
  return (
    <Mark>
      <path d="M5.5 3.5h9L19 8v12.5H5.5z" />
      <path d="M14 3.5V8h5" />
      <path d="M8.5 13h7M8.5 16.5h4.5" />
    </Mark>
  );
}

const MARKS: Record<string, () => ReactNode> = {
  CLAUDE: ClaudeMark,
  OPENROUTER: OpenRouterMark,
  CODEX: CodexMark,
  ANTIGRAVITY: AntigravityMark,
  OPENCODE: OpenCodeMark,
  MANUAL: ManualMark,
};

export function ProviderMark({ provider }: { provider: string }) {
  const Drawn = MARKS[provider];
  if (Drawn === undefined) return null;
  return <Drawn />;
}
