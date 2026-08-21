// This interface is UNOFFICIAL and may break.
import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import {
  durationSecondsFromWords,
  instantAfter,
  rawMeter,
  shortExpiry
} from "./shared.js";

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
 * How far this reader will search for a window's own container, in characters.
 *
 * A bound on WORK, not a boundary. The boundary is structural: see
 * `windowContainer`. A character count alone was tried and it does not close
 * the hole, because "the first percentage within two thousand characters after
 * the label" still reaches a footer when the window's own percentage is absent.
 * That is the difference between bounding how far a reader wanders and
 * bounding where it is allowed to look at all.
 */
export const OPENCODE_MAX_SEGMENT_CHARS = 2_000;

/**
 * Elements that never close, so a scan must not wait for a closing tag.
 *
 * Not exhaustive HTML: exhaustive for what a rendered page puts inside a meter
 * block. An element outside this list that never closes makes the container
 * scan run past its own end, and the scan answers null rather than guessing,
 * which is the direction that costs a reading instead of inventing one.
 */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"
]);

/** One tag as the scanner sees it. */
interface Tag {
  readonly at: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

/** Every tag in a slice of text, in order. Comments are not tags. */
function tagsIn(html: string, from: number, to: number): Tag[] {
  const tags: Tag[] = [];
  const pattern = /<!--[\s\S]*?-->|<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/gu;
  const slice = html.slice(from, to);
  for (const match of slice.matchAll(pattern)) {
    /* A comment matched the first alternative and has no tag name. */
    if (match[2] === undefined) continue;
    const name = match[2].toLowerCase();
    const attributes = match[3] ?? "";
    tags.push({
      at: from + (match.index ?? 0),
      end: from + (match.index ?? 0) + match[0].length,
      name,
      closing: match[1] === "/",
      selfClosing: attributes.trimEnd().endsWith("/") || VOID_ELEMENTS.has(name)
    });
  }
  return tags;
}

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
  readonly meter: "FIVE_HOUR" | "SEVEN_DAY" | "MONTHLY";
  readonly seconds: number;
}[] = [
  { label: "Rolling Usage", meter: "FIVE_HOUR", seconds: 18_000 },
  { label: "Weekly Usage", meter: "SEVEN_DAY", seconds: 604_800 },
  { label: "Monthly Usage", meter: "MONTHLY", seconds: 2_592_000 }
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

/** How many ancestors of a label this reader will consider. */
const MAX_CONTAINER_DEPTH = 6;

/**
 * The element that encloses a position, as a half open range, or null.
 *
 * Found by walking backwards to the nearest element still open at that point,
 * then forwards to its own closing tag. Both walks are bounded, and every
 * failure answers null: an unbalanced page is one this reader declines rather
 * than one it reads approximately.
 */
function enclosingElement(
  html: string,
  at: number
): { readonly openedAt: number; readonly from: number; readonly to: number } | null {
  const searchFrom = Math.max(0, at - OPENCODE_MAX_SEGMENT_CHARS);
  const before = tagsIn(html, searchFrom, at);
  /* Backwards: a closing tag means a sibling element already finished, so the
     next opening tag going left belongs to it and not to us. */
  let pendingCloses = 0;
  let container: Tag | null = null;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const tag = before[index]!;
    if (tag.selfClosing) continue;
    if (tag.closing) {
      pendingCloses += 1;
      continue;
    }
    if (pendingCloses > 0) {
      pendingCloses -= 1;
      continue;
    }
    container = tag;
    break;
  }
  if (container === null) return null;
  /* Forwards from just inside the container to its own close, counting depth so
     a nested element of the same name cannot end the region early. */
  const searchTo = Math.min(html.length, container.end + OPENCODE_MAX_SEGMENT_CHARS);
  let depth = 0;
  for (const tag of tagsIn(html, container.end, searchTo)) {
    if (tag.selfClosing) continue;
    if (!tag.closing) {
      depth += 1;
      continue;
    }
    if (depth === 0) {
      return tag.name === container.name
        ? { openedAt: container.at, from: container.end, to: tag.at }
        /* A closing tag for something else pops above our container, which
           means the page is unbalanced here. Decline it. */
        : null;
    }
    depth -= 1;
  }
  return null;
}

/**
 * The region a window's reading may be read from, or null.
 *
 * This is the fix for the final segment attack, and the reason a character count
 * could not be. A window's figure is not inside the heading that names it: it is
 * a SIBLING of that heading, in a shared block. So the readable region is an
 * ancestor of the label, and the right ancestor is the nearest one that holds a
 * percentage while naming no other window.
 *
 * Both halves of that rule carry weight. Requiring a percentage is what walks
 * past the bare heading element. Refusing a region that names another window is
 * what stops the walk at the meter block instead of continuing up to the page
 * body, which contains every window's figure and would let any of them stand in
 * for any other. When no ancestor satisfies both, there is no region, and a
 * window with no region is refused rather than approximated: that is the case
 * the audit named, a monthly block that rendered no figure and a footer a few
 * characters later that did.
 */
function windowRegion(
  html: string,
  labelAt: number,
  otherLabels: readonly string[]
): string | null {
  let position = labelAt;
  for (let level = 0; level < MAX_CONTAINER_DEPTH; level += 1) {
    const element = enclosingElement(html, position);
    if (element === null) return null;
    const segment = flatten(html.slice(element.from, element.to));
    if (otherLabels.some((label) => segment.includes(label))) return null;
    if (PERCENT.test(segment)) return segment;
    /* No figure at this level, so try the block above it. */
    position = element.openedAt;
  }
  return null;
}

interface ParsedWindow {
  meter: "FIVE_HOUR" | "SEVEN_DAY" | "MONTHLY";
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
  const found: {
    at: number;
    label: string;
    meter: "FIVE_HOUR" | "SEVEN_DAY" | "MONTHLY";
    seconds: number;
  }[] = [];
  for (const window of OPENCODE_WINDOWS) {
    const at = html.indexOf(window.label);
    if (at < 0) return null;
    /* One occurrence only. A page rendering a label twice gives this reader two
       candidate containers and no way to know which is the meter. */
    if (html.indexOf(window.label, at + window.label.length) >= 0) return null;
    found.push({
      at,
      label: window.label,
      meter: window.meter,
      seconds: window.seconds
    });
  }
  found.sort((left, right) => left.at - right.at);
  const windows: ParsedWindow[] = [];
  for (const start of found) {
    /*
     * The readable region is this window's own CONTAINER, and nothing past it.
     *
     * A character count was not enough, and the way it failed is worth stating:
     * "the first percentage within two thousand characters after the label"
     * still reaches a footer whenever the window's own percentage is absent, so
     * a page that stopped rendering one meter would report an unrelated figure
     * as that meter. Outside the container is outside, at any distance.
     */
    const segment = windowRegion(
      html,
      start.at,
      found.filter((entry) => entry.label !== start.label).map((entry) => entry.label)
    );
    if (segment === null) return null;
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
      meter: start.meter,
      percent,
      seconds: start.seconds,
      resetAt: seconds === null ? null : instantAfter(now, seconds)
    });
  }
  return windows;
}

/**
 * Every provider window, including the monthly quota.
 *
 * The shared policy still derives the binding window by choosing the highest
 * percentage. Keeping the three source windows lets every surface state which
 * cadence a number belongs to instead of hiding the monthly value inside one
 * synthetic primary meter.
 */
export function parseOpencodePayload(payload: unknown, now: string): RawMeter[] | null {
  if (typeof payload !== "string") return null;
  if (payload.length === 0 || payload.length > OPENCODE_MAX_PAGE_CHARS) return null;
  const windows = parseWindows(payload, now);
  if (windows === null || windows.length === 0) return null;
  const expiresAt = shortExpiry(now);
  if (expiresAt === null) return null;
  return windows.map((window) =>
    rawMeter({
      provider: "OPENCODE",
      meter: window.meter,
      value: window.percent,
      window: { kind: "rolling", durationSeconds: window.seconds },
      resetAt: window.resetAt,
      source: "authenticated_page",
      precision: "estimated",
      observedAt: now,
      expiresAt,
      labels: opencodeLabels
    })
  );
}

export const opencodeConnector: ConnectorContract = {
  id: "opencode",
  displayName: "OpenCode",
  encoding: "text",
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
