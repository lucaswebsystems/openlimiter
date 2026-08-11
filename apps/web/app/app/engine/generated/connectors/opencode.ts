/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
// This interface is UNOFFICIAL and may break.
import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "../core";
import {
  durationSecondsFromWords,
  instantAfter,
  rawMeter,
  shortExpiry
} from "./shared";

/**
 * The OpenCode usage reader, and the least trustworthy one in the product.
 *
 * OpenCode publishes no usage interface at all. More than twenty candidate
 * routes were probed on 2026-08-03 and the API key opens none of them: the plan
 * percentages exist only inside the HTML of a logged in workspace page, server
 * rendered. So this parser reads a PAGE, not a payload, and that is why its
 * labels say browser-session, authenticated-scrape and automationRisk high, and
 * why they do not improve when a capture lands. They describe the method, not
 * the amount of evidence behind it.
 *
 * The reader used to parse `usage.percent` out of a JSON object, a shape from
 * an early prototype that no OpenCode surface has ever produced.
 *
 * Two things make reading HTML survivable rather than reckless. Windows are
 * matched by their LABEL and never by position, so a reordered page degrades to
 * unknown instead of quietly reporting the monthly figure as the weekly one.
 * And all three labels must be found: a page that has changed enough to lose
 * one of them has changed enough not to be trusted for the other two.
 */

export const opencodeLabels = {
  credentialOrigin: "browser-session",
  dataInterfaceStatus: "authenticated-scrape",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const opencodeHonesty = "UNVERIFIED_AUTHENTICATED_SCRAPE_HIGH_RISK" as const;

export const opencodeInput = {
  kind: "authenticated_page_payload",
  pathTemplate: "{browserSession}/usage",
  readMode: "read_only",
  honesty: opencodeHonesty
} as const;

/**
 * What this reader reads: text, not JSON.
 *
 * The collection pipeline keys on this. A body for this reader is handed over
 * as the raw string it arrived as, because running it through a JSON parser
 * first would turn every real response into a parse failure.
 */
export const opencodeEncoding = "text" as const;

/**
 * Largest page this reader will look at, in characters.
 *
 * The transport already bounds the response at one mebibyte. This is the second
 * bound, on the work done with it, so a page that is within the transport's
 * limit still cannot make the label scan expensive.
 */
export const OPENCODE_MAX_PAGE_CHARS = 1_048_576;

/**
 * The three windows the workspace page renders, and how long each one is.
 *
 * All three are required. Matched by label, in the page's own words.
 */
export const OPENCODE_WINDOWS: readonly {
  readonly label: string;
  readonly seconds: number;
}[] = [
  { label: "Rolling Usage", seconds: 18_000 },
  { label: "Weekly Usage", seconds: 604_800 },
  { label: "Monthly Usage", seconds: 2_592_000 }
];

/**
 * Markup and hydration comments, removed so text can be matched.
 *
 * The page is server rendered by a framework that sprays hydration markers
 * through the text, so it renders "Resets in<!--/--> <!--$-->5 days<!--/-->".
 * Matching against raw HTML silently loses every reset time, which is a missing
 * countdown rather than a wrong number, but missing for an invisible reason is
 * still the worst kind of missing. Verified against the live page 2026-08-03.
 */
const MARKUP = /<!--[\s\S]*?-->|<[^>]*>/gu;

/** A percentage as the page prints it: a whole number and a percent sign. */
const PERCENT = /(\d{1,3})\s*%/u;

/**
 * A countdown as the page prints it.
 *
 * Anchored on the words, and consuming only consecutive number and unit pairs,
 * so it cannot wander into the next window's duration if a label boundary ever
 * moves.
 */
const RESETS_IN = /Resets in\s+((?:\d{1,6}\s*(?:day|hour|minute|second)s?\s*)+)/iu;

function flatten(fragment: string): string {
  return fragment.replace(MARKUP, " ").split(/\s+/u).filter(Boolean).join(" ");
}

interface ParsedWindow {
  percent: number;
  seconds: number;
  resetAt: string | null;
}

/**
 * Every window the page states, or null unless all three are there.
 *
 * Each window's segment runs from its own label to the next label in page
 * order, so a percentage can only ever be read out of the block that belongs to
 * it.
 */
function parseWindows(html: string, now: string): ParsedWindow[] | null {
  const found: { at: number; seconds: number }[] = [];
  for (const window of OPENCODE_WINDOWS) {
    const at = html.indexOf(window.label);
    if (at < 0) return null;
    found.push({ at, seconds: window.seconds });
  }
  found.sort((left, right) => left.at - right.at);
  const windows: ParsedWindow[] = [];
  for (let index = 0; index < found.length; index += 1) {
    const start = found[index]!;
    const next = found[index + 1];
    const end = next === undefined ? html.length : next.at;
    const segment = flatten(html.slice(start.at, end));
    const percentMatch = PERCENT.exec(segment);
    if (percentMatch === null) return null;
    const percent = Number.parseInt(percentMatch[1] ?? "", 10);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
    /* The countdown is optional, because the page omits it on a window that has
       no reset pending. A missing countdown costs the countdown and nothing
       else: the percentage beside it was still rendered by the provider. */
    const resetMatch = RESETS_IN.exec(segment);
    const seconds =
      resetMatch === null ? null : durationSecondsFromWords(resetMatch[1] ?? "");
    windows.push({
      percent,
      seconds: start.seconds,
      resetAt: seconds === null ? null : instantAfter(now, seconds)
    });
  }
  return windows;
}

/**
 * The binding window, as one meter.
 *
 * The highest of the three, because that is the one that will stop the work,
 * and because it is what the reference reader's own bar names.
 */
export function parseOpencodePayload(payload: unknown, now: string): RawMeter[] | null {
  if (typeof payload !== "string") return null;
  if (payload.length === 0 || payload.length > OPENCODE_MAX_PAGE_CHARS) return null;
  const windows = parseWindows(payload, now);
  if (windows === null || windows.length === 0) return null;
  const expiresAt = shortExpiry(now);
  if (expiresAt === null) return null;
  let binding = windows[0]!;
  for (const candidate of windows.slice(1)) {
    if (candidate.percent > binding.percent) binding = candidate;
  }
  return [rawMeter({
    provider: "OPENCODE",
    meter: "PRIMARY",
    value: binding.percent,
    window: { kind: "rolling", durationSeconds: binding.seconds },
    resetAt: binding.resetAt,
    source: "authenticated_page",
    precision: "estimated",
    observedAt: now,
    expiresAt,
    labels: opencodeLabels
  })];
}

export const opencodeConnector: ConnectorContract = {
  id: "opencode",
  displayName: "OpenCode",
  labels: opencodeLabels,
  detect(environment) {
    return environment["OPENCODE_SESSION_PRESENT"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseOpencodePayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
