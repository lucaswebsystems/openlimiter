"use client";

import {
  ClaudeMark,
  CodexMark,
  GoogleMark,
  ManualMark,
  OpenCodeMark,
  OpenRouterMark,
} from "@/components/tool-marks";

/**
 * The provider marks the dashboard draws.
 *
 * These are the site's own marks, imported rather than copied, so the row of
 * glyphs on the home page and the tile on a provider card are the same artwork
 * from the same file. That file carries the provenance: the path data is Simple
 * Icons, published under CC0 1.0, reproduced verbatim and drawn in
 * `currentColor`, so nothing is fetched at runtime and no brand colour appears.
 * Where Simple Icons ships no mark, its `InitialMark` lettered tile stands in,
 * which is why Codex is a tile rather than a logo.
 *
 * This module used to hold six geometric stand ins drawn out of lines and
 * circles. They were honest but they were not the product's marks, and having
 * a second set meant the dashboard and the marketing pages could drift. The
 * only mapping left here is which provider code gets which mark.
 */

const MARKS: Record<string, (props: { className?: string }) => React.ReactNode> = {
  CLAUDE: ClaudeMark,
  OPENROUTER: OpenRouterMark,
  /* Simple Icons ships no OpenAI mark, so this is the lettered tile. */
  CODEX: CodexMark,
  /* Antigravity is Google's, and takes the Google mark the catalogue gives it. */
  ANTIGRAVITY: GoogleMark,
  OPENCODE: OpenCodeMark,
  /* Not a company at all: manual entry is a person writing a number down. */
  MANUAL: ManualMark,
};

export function ProviderMark({
  provider,
  className = "h-4 w-4",
}: {
  provider: string;
  className?: string;
}) {
  const Drawn = MARKS[provider];
  if (Drawn === undefined) return null;
  return <Drawn className={className} />;
}
