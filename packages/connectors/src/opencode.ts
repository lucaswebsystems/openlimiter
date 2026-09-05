// This interface is UNOFFICIAL and may break.
import { connectionStatus } from "@openlimiter/core";
import type {
  ConnectionStatus,
  ConnectionTool,
  ConnectorContract,
  ConnectorLabels,
  ConnectorMaturity,
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

/**
 * BETA, and stated rather than implied.
 *
 * Every other reader in this package reads an interface: documented, private,
 * or declared in a vendor's own client source, but an interface. This one reads
 * a page that was designed for a person's eyes, whose wording nobody promised
 * and which has already been renamed once underneath it. That is a different
 * class of thing, and a surface that shows it beside the others has to be able
 * to say so.
 */
export const opencodeMaturity = "beta" as const satisfies ConnectorMaturity;

export const opencodeInput = {
  kind: "authenticated_page_payload",
  pathTemplate: "{browserSession}/usage",
  readMode: "read_only",
  honesty: opencodeHonesty,
  maturity: opencodeMaturity
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

export type OpencodeMeter = "FIVE_HOUR" | "SEVEN_DAY" | "MONTHLY";

/**
 * The cadences the workspace page renders, and how each one is recognised.
 *
 * This used to be three exact phrases, all three required, and the page renamed
 * them. Three exact strings is the most brittle possible way to read a document
 * whose wording nobody promised us, and the failure was total: one renamed
 * heading and the whole reader went dark on a page still rendering all three
 * figures.
 *
 * So a cadence is now recognised by the WORD that names it, case insensitively,
 * with the wordings seen so far and the obvious neighbours of each. Structure
 * still does the real work: a match only produces a reading if it sits in a
 * container that holds a percentage and names no other cadence, which is the
 * guard that stops a heading from borrowing the figure beside it.
 */
export const OPENCODE_WINDOWS: readonly {
  readonly meter: OpencodeMeter;
  readonly seconds: number;
  /** Every wording this cadence has been seen under, matched case blind. */
  readonly pattern: RegExp;
}[] = [
  {
    meter: "FIVE_HOUR",
    seconds: 18_000,
    pattern: /\b(?:rolling|session|5[\s-]*hour|five[\s-]*hour)\b/giu
  },
  {
    meter: "SEVEN_DAY",
    seconds: 604_800,
    pattern: /\b(?:weekly|week|7[\s-]*day|seven[\s-]*day)\b/giu
  },
  {
    meter: "MONTHLY",
    seconds: 2_592_000,
    pattern: /\b(?:monthly|month|30[\s-]*day|thirty[\s-]*day)\b/giu
  }
];

/**
 * What a logged out workspace page says instead of a meter.
 *
 * Read only to tell a person WHICH thing went wrong. A page this reader cannot
 * read is either a layout change or a session that ended, and those need
 * different sentences: one is ours to fix and the other is one click.
 */
const SIGNED_OUT = /\b(?:sign[\s-]?in|sign[\s-]?up|log[\s-]?in|create an account)\b/iu;

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

/**
 * A percentage as the page prints it.
 *
 * The decimal part is optional because the page has printed both "92%" and
 * "92.4%", and a reader that only knows whole numbers reads the second as 92
 * or as nothing at all depending on where the match lands. The number pattern
 * is what this reader trusts; the wording around it is not.
 */
const PERCENT = /(\d{1,3}(?:\.\d{1,2})?)\s*%/u;

/**
 * A countdown as the page prints it.
 *
 * Anchored on the verb rather than one exact phrase, because "Resets in",
 * "Renews in" and "Refreshes in" all name the same thing and the page has used
 * more than one. It still consumes only consecutive number and unit pairs, so
 * it cannot wander into the next window's duration if a boundary ever moves.
 */
const RESETS_IN =
  /\b(?:resets?|renews?|refreshes|refresh)\b(?:\s+in)?[:\s]\s*((?:\d{1,6}\s*(?:day|hour|minute|second)s?\s*)+)/iu;

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
  otherLabels: readonly RegExp[]
): string | null {
  let position = labelAt;
  for (let level = 0; level < MAX_CONTAINER_DEPTH; level += 1) {
    const element = enclosingElement(html, position);
    if (element === null) return null;
    const segment = flatten(html.slice(element.from, element.to));
    if (otherLabels.some((pattern) => matches(pattern, segment))) return null;
    if (PERCENT.test(segment)) return segment;
    /* No figure at this level, so try the block above it. */
    position = element.openedAt;
  }
  return null;
}

interface ParsedWindow {
  meter: OpencodeMeter;
  percent: number;
  seconds: number;
  resetAt: string | null;
}

/**
 * Whether a position sits inside a tag rather than in text a person reads.
 *
 * A cadence word in `class="monthly-card"` is markup, not a heading, and
 * treating it as one would put a label in a place the reader then has to
 * resolve a container for. Cheap and exact enough: the last angle bracket
 * before the position decides.
 */
function insideTag(html: string, at: number): boolean {
  return html.lastIndexOf("<", at) > html.lastIndexOf(">", at);
}

/** Whether a pattern matches, without carrying lastIndex between calls. */
function matches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

interface LabelHit {
  readonly at: number;
  readonly meter: OpencodeMeter;
  readonly seconds: number;
  readonly others: readonly RegExp[];
}

/**
 * Where each cadence is named on the page, when it is named exactly once.
 *
 * A cadence named nowhere is a window this page is not rendering. A cadence
 * named twice is two candidate containers and no way to know which one is the
 * meter, so it is ambiguous. Both cost that cadence and nothing else: losing
 * one bar is a smaller failure than drawing a bar with somebody else's number
 * in it, and losing all three because one heading was renamed, which is what
 * this reader used to do, is the largest failure of the three.
 */
function findLabels(html: string): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const window of OPENCODE_WINDOWS) {
    window.pattern.lastIndex = 0;
    const positions: number[] = [];
    for (const match of html.matchAll(window.pattern)) {
      const at = match.index ?? -1;
      if (at < 0 || insideTag(html, at)) continue;
      positions.push(at);
      /* Two is already ambiguous, so there is no reason to scan a large page
         looking for a third. */
      if (positions.length > 1) break;
    }
    if (positions.length !== 1) continue;
    hits.push({
      at: positions[0] ?? 0,
      meter: window.meter,
      seconds: window.seconds,
      others: OPENCODE_WINDOWS
        .filter((other) => other.meter !== window.meter)
        .map((other) => other.pattern)
    });
  }
  return hits.sort((left, right) => left.at - right.at);
}

/**
 * Every window this page states, or null when it states none this reader can
 * believe.
 *
 * Each window's figure is read out of its own CONTAINER and nowhere else, so a
 * percentage can only ever be attributed to the block that rendered it. A
 * window whose container cannot be resolved, or holds no percentage, or holds
 * an impossible one, is dropped alone: the page is a rendered document rather
 * than a contract, and one block changing shape is not a reason to discard the
 * blocks that did not.
 */
function parseWindows(html: string, now: string): ParsedWindow[] | null {
  const windows: ParsedWindow[] = [];
  for (const hit of findLabels(html)) {
    const segment = windowRegion(html, hit.at, hit.others);
    if (segment === null) continue;
    const percentMatch = PERCENT.exec(segment);
    if (percentMatch === null) continue;
    const percent = Number.parseFloat(percentMatch[1] ?? "");
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    /* The countdown is optional, because the page omits it on a window that has
       no reset pending. A missing countdown costs the countdown and nothing
       else: the percentage beside it was still rendered by the provider. */
    const resetMatch = RESETS_IN.exec(segment);
    const seconds =
      resetMatch === null ? null : durationSecondsFromWords(resetMatch[1] ?? "");
    windows.push({
      meter: hit.meter,
      percent,
      seconds: hit.seconds,
      resetAt: seconds === null ? null : instantAfter(now, seconds)
    });
  }
  return windows.length === 0 ? null : windows;
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
  /*
   * Fail soft, and mean it. This is the only reader in the package pointed at a
   * rendered document rather than an interface, so it is the only one where an
   * unforeseen shape can reach code that was not written for it. A thrown error
   * here would take down whatever was collecting, which would turn one changed
   * page into a broken product, so the whole scan answers null instead and the
   * connection below says what a person should do about it.
   */
  let windows: ParsedWindow[] | null = null;
  try {
    windows = parseWindows(payload, now);
  } catch {
    return null;
  }
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

/** The local application that owns this browser session. */
export const OPENCODE_TOOL: ConnectionTool = "OpenCode";

/**
 * The connection this reader reports, which is not the generic one.
 *
 * A page it cannot read has two very different causes, and they need two
 * different sentences. A logged out workspace renders a sign in form, and the
 * fix is one click in a window the person already has open. Anything else is a
 * layout this build no longer understands, which is ours to fix, and the honest
 * instruction is to reconnect and tell us if it keeps happening. Neither one
 * throws, and neither one is silence.
 */
export function opencodeConnection(parsed: boolean, payload: unknown): ConnectionStatus {
  /*
   * The signed out marker is read BEFORE the parse result, and the order is the
   * whole point. A page asking somebody to sign in is a page whose numbers are
   * leftovers, and this reader can still find a percentage in leftovers, so
   * asking "did it parse" first reports a live looking meter behind an account
   * nobody is signed into. That is the exact claim this product exists to stop.
   */
  if (typeof payload === "string" && SIGNED_OUT.test(payload)) {
    return connectionStatus("AUTH_EXPIRED", "token_expired", OPENCODE_TOOL);
  }
  if (parsed) return connectionStatus("CONNECTED", null, OPENCODE_TOOL);
  /* Nothing arrived at all, which is a session that has not been opened yet
     rather than a fault. Anything that DID arrive and could not be read is a
     fault, whatever type it turned out to be. */
  if (payload === undefined || payload === null) {
    return connectionStatus("DETECTED", "tool_not_running", OPENCODE_TOOL);
  }
  return connectionStatus("ERROR", "shape_mismatch", OPENCODE_TOOL);
}

export const opencodeConnector: ConnectorContract = {
  id: "opencode",
  displayName: "OpenCode",
  encoding: "text",
  maturity: opencodeMaturity,
  labels: opencodeLabels,
  detect(environment) {
    return environment["OPENCODE_SESSION_PRESENT"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseOpencodePayload(context.payload, context.now);
    const connection = opencodeConnection(meters !== null, context.payload);
    return meters === null
      ? { ok: false, reason: "unknown", connection }
      : { ok: true, meters, connection };
  }
};
