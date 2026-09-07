import { deviceSessionOf, type DeviceSession } from "./device-session";
import { phonePairOf, type PhonePair } from "./phone-session";

/**
 * Phone pairing, as a state machine with no side effects in it.
 *
 * The flow itself is five moves: read the code out of the fragment, claim it,
 * poll until the desktop answers, then either hold a token or say why not.
 * Every transition below is a pure function of the previous state and one
 * server response, so the whole thing can be driven in a test without a
 * network, a browser or a clock.
 *
 * WHY THE CODE LIVES IN THE FRAGMENT
 * ----------------------------------
 * `https://openlimiter.com/app/pair#code=XXXXXXXX` never sends the part after
 * the hash to a server, so the code cannot appear in an access log, a referrer
 * or a proxy trace on its way here. It is read in the browser, sent once in a
 * request body, and burned by the server on first use.
 */

/** The unambiguous alphabet the server mints codes from. No 0, O, 1 or I. */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** How long a code lives, so the page can stop polling when the server would. */
export const PAIRING_TTL_SECONDS = 120;

/** How often the phone asks the server whether the desktop has answered. */
export const PAIRING_POLL_MILLISECONDS = 2_000;

/**
 * The slowest the phone will ever ask.
 *
 * A refused poll is the server saying it has had enough for now, so asking
 * again at the same rate is how a rate limit becomes a loop that never
 * recovers. Each refusal doubles the gap up to this ceiling, and the ceiling
 * exists because a pairing code only lives two minutes: waiting longer than
 * this would spend the whole window not asking.
 */
export const PAIRING_POLL_MAX_MILLISECONDS = 15_000;

export type PairPhase =
  | "reading"
  | "noCode"
  | "claiming"
  | "waiting"
  | "approved"
  | "denied"
  | "expired"
  | "error";

export interface PairState {
  phase: PairPhase;
  /** The eight character code, shown as text under the instruction. */
  code: string | null;
  /** The claim the server issued, which every poll carries. */
  claimId: string | null;
  /** Unix seconds. When the claim stops being pollable. */
  expiresAt: number | null;
  /** How long to wait before the next poll. Doubles on every refusal. */
  pollInterval: number;
  /** Present only once the desktop approved and the delivery arrived. */
  session: DeviceSession | null;
  /**
   * The read token and refresh credential, present only when the approving
   * poll carried the new credential pair shape. The page keeps the phone on
   * this route when it arrives rather than handing over to /app.
   */
  phonePair: PhonePair | null;
}

function state(partial: Partial<PairState>, previous?: PairState): PairState {
  return {
    phase: "reading",
    code: null,
    claimId: null,
    expiresAt: null,
    pollInterval: PAIRING_POLL_MILLISECONDS,
    session: null,
    phonePair: null,
    ...previous,
    ...partial,
  };
}

/**
 * The code in a URL fragment, or null.
 *
 * Accepts the fragment with or without its leading hash, and ignores anything
 * else that happens to be in it. A code that is not exactly eight characters of
 * the server's alphabet is not a code.
 */
export function pairCodeFromFragment(fragment: string): string | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const value = new URLSearchParams(raw).get("code");
  if (value === null) return null;
  const code = value.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** The state a freshly opened page starts in. */
export function initialPairState(fragment: string): PairState {
  const code = pairCodeFromFragment(fragment);
  return code === null ? state({ phase: "noCode" }) : state({ phase: "claiming", code });
}

function payload(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function seconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1_000);
  }
  return null;
}

/**
 * What a claim response means.
 *
 * A claim either produces a claim identifier to poll, or it does not, and the
 * only two failures worth telling apart are a code that is spent or stale,
 * which the reader fixes by scanning again, and everything else.
 */
export function pairStateAfterClaim(
  previous: PairState,
  response: unknown,
  status: number,
): PairState {
  const row = payload(response);
  const claimId = typeof row?.claim_id === "string" ? row.claim_id : "";
  if (status === 200 && UUID_PATTERN.test(claimId)) {
    return state(
      { phase: "waiting", claimId, expiresAt: seconds(row?.expires_at) },
      previous,
    );
  }
  if (status === 409 || status === 410 || status === 404) {
    return state({ phase: "expired" }, previous);
  }
  return state({ phase: "error" }, previous);
}

/**
 * What a poll response means.
 *
 * `pending` and `claimed` both mean keep waiting: the desktop has the prompt on
 * screen and nobody has pressed anything. `delivered` means this claim already
 * handed its token to someone, which for a reader who lost the response is the
 * same instruction as an expired code: pair again.
 */
export function pairStateAfterPoll(
  previous: PairState,
  response: unknown,
  status: number,
): PairState {
  if (status === 429) return pairStateAfterRefusal(previous);
  if (status !== 200) {
    return state({ phase: status === 409 || status === 404 ? "expired" : "error" }, previous);
  }
  const row = payload(response);
  const value = typeof row?.status === "string" ? row.status : "";
  if (value === "pending" || value === "claimed") return previous;
  if (value === "denied") return state({ phase: "denied" }, previous);
  if (value === "expired" || value === "delivered") return state({ phase: "expired" }, previous);
  if (value === "approved") {
    /* The new contract first: a read token and the one time refresh
       credential beside it. The legacy delivery, a device session alone,
       still counts, so a desktop and a server one version apart pair. */
    const pair = phonePairOf(row);
    if (pair !== null) return state({ phase: "approved", phonePair: pair }, previous);
    const session = deviceSessionOf(row);
    return session === null
      ? state({ phase: "error" }, previous)
      : state({ phase: "approved", session }, previous);
  }
  return state({ phase: "error" }, previous);
}

/**
 * A refused poll, as a slower one.
 *
 * It returns a NEW state on purpose. Returning the previous object was correct
 * about the phase and wrong about everything else: nothing re-rendered, so the
 * timer that was refused kept its old interval and kept asking at exactly the
 * rate the server had just declined. The deadline is untouched, because being
 * rate limited does not buy a claim more time.
 */
export function pairStateAfterRefusal(previous: PairState): PairState {
  return state(
    {
      pollInterval: Math.min(previous.pollInterval * 2, PAIRING_POLL_MAX_MILLISECONDS),
    },
    previous,
  );
}

/** Whether the page should still be asking. */
export function pairShouldPoll(current: PairState, now: number = Date.now()): boolean {
  if (current.phase !== "waiting" || current.claimId === null) return false;
  return current.expiresAt === null || current.expiresAt * 1_000 > now;
}

/** The state a claim that ran out of time lands in. */
export function pairStateAfterTimeout(previous: PairState): PairState {
  return previous.phase === "waiting" ? state({ phase: "expired" }, previous) : previous;
}

/* --------------------------------------------------------------- device meta */

export interface PairDeviceMeta {
  name: string;
  platform: string;
}

const NAME_LIMIT = 80;
const PLATFORM_LIMIT = 40;

function clean(value: string, limit: number): string {
  const stripped = [...value.normalize("NFC")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .slice(0, limit)
    .join("")
    .trim();
  return stripped;
}

/**
 * A name and a platform for the device that is scanning, from what the browser
 * already tells every page it opens.
 *
 * Nothing is fingerprinted and nothing is measured: this is the browser's own
 * platform string and its own brand list, trimmed to what the server accepts,
 * so a person approving on the desktop reads something they recognise.
 */
export function pairDeviceMeta(input: {
  platform?: string;
  brand?: string;
  mobile?: boolean;
}): PairDeviceMeta {
  const platform = clean(input.platform ?? "", PLATFORM_LIMIT) || "Web";
  const brand = clean(input.brand ?? "", NAME_LIMIT);
  const kind = input.mobile === true ? "phone" : "browser";
  const name = clean(
    brand === "" ? `${platform} ${kind}` : `${brand} on ${platform}`,
    NAME_LIMIT,
  );
  return { name: name === "" ? "Paired browser" : name, platform };
}

/** The user agent, as the lowercase hex sha256 digest the server requires. */
export async function pairUserAgentHash(userAgent: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userAgent));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
