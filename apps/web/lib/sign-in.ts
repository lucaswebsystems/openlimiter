/**
 * The decisions a sign in makes, kept away from the network.
 *
 * Two surfaces draw the sign in, the dashboard gate at /app and the Pro
 * portal, and both take the same three ways in: GitHub, Google, or a single
 * use link sent to an email address. What this module owns is everything
 * about those three that can be decided from a status and a body rather than
 * from a live request, so it can be tested without a server and the card
 * itself stays a drawing.
 *
 * THE PROBE
 * ---------
 * A provider the service has not switched on does not fail when the button
 * is pressed. The client builds the authorize address and sends the browser
 * there, and the service answers that address with a 400 and a JSON body
 * saying the provider is not enabled. Left alone, that is the last thing the
 * person sees: a JSON page in place of the product, with no way back. So the
 * address is asked first, with redirects left unfollowed. A switched on
 * provider answers with a redirect, which the probe does not follow and the
 * browser is then sent to. A switched off one answers with the refusal, and
 * the card says so in the product's own words, naming the ways in that are
 * still open. A probe that cannot be made at all decides nothing: the browser
 * is sent on as before, so a network hiccup here can only ever fall back to
 * the old behaviour, never invent a refusal.
 */

export type OAuthProvider = "github" | "google";

/** The two providers the card offers, in the order it draws them. */
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["github", "google"];

/** The provider's own name, spelled the way the provider spells it. */
export function providerName(provider: OAuthProvider): string {
  return provider === "github" ? "GitHub" : "Google";
}

/** The provider that is not this one, for a sentence pointing elsewhere. */
export function otherProvider(provider: OAuthProvider): OAuthProvider {
  return provider === "github" ? "google" : "github";
}

/** What the authorize probe saw: a status and whatever body it could parse. */
export interface ProbeAnswer {
  status: number;
  body: unknown;
}

function refusalText(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  return ["msg", "message", "error_description", "error"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Whether an authorize answer says the provider is switched off.
 *
 * Supabase Auth answers 400 with `error_code: validation_failed` and a message
 * naming the provider as not enabled. Only that exact refusal counts: any
 * other 400, and every other status, is not a claim about the provider.
 */
export function providerSwitchedOff(answer: ProbeAnswer | null): boolean {
  if (answer === null || answer.status !== 400) return false;
  const text = refusalText(answer.body);
  return text.includes("not enabled") || text.includes("unsupported provider");
}

/**
 * Whether a refused link request means email sign in itself is switched off,
 * as opposed to a bad address or a rate limit. The service says so in words
 * rather than a code, so the words are what is read.
 */
export function emailSwitchedOff(message: string | null | undefined): boolean {
  const text = (message ?? "").toLowerCase();
  return (
    text.includes("not enabled") ||
    text.includes("logins are disabled") ||
    text.includes("signups not allowed") ||
    text.includes("signups are disabled")
  );
}

/** Every state the card draws. Each one has a shape and a sentence. */
export type SignInState =
  | { kind: "idle" }
  | { kind: "working"; via: OAuthProvider | "email" }
  | { kind: "sent"; email: string }
  | { kind: "error"; reason: "failed" | "providerOff" | "emailOff"; provider?: OAuthProvider };

export type StartOutcome = { ok: true } | { ok: false; reason: "failed" | "providerOff" };

/** The three things a provider sign in needs from the outside world. */
export interface StartDependencies {
  /** The authorize address the auth client built, or null if it could not. */
  authorizeUrl: () => Promise<string | null>;
  /** One unfollowed request to that address, or null if none could be made. */
  probe: (url: string) => Promise<ProbeAnswer | null>;
  /** Sends the browser there. Called last, and only when nothing refused. */
  navigate: (url: string) => void;
}

/**
 * Start a provider sign in.
 *
 * The order is the whole point: the address is built, then asked, and the
 * browser leaves only if nothing answered with a refusal. A definite refusal
 * that the provider is off becomes the one sentence the card promises for it;
 * any other definite failure becomes the generic one; and no answer at all
 * lets the browser go, because the probe is advisory and the redirect is what
 * has always worked.
 */
export async function startOAuth(
  provider: OAuthProvider,
  deps: StartDependencies,
): Promise<StartOutcome> {
  void provider;
  const url = await deps.authorizeUrl().catch(() => null);
  if (url === null || url === "") return { ok: false, reason: "failed" };
  const answer = await deps.probe(url).catch(() => null);
  if (providerSwitchedOff(answer)) return { ok: false, reason: "providerOff" };
  if (answer !== null && answer.status >= 400) return { ok: false, reason: "failed" };
  deps.navigate(url);
  return { ok: true };
}

/**
 * The probe, the one function here that touches the network.
 *
 * Redirects are left manual on purpose. A switched on provider answers the
 * authorize address with a redirect to itself, and following it from here
 * would fetch a login page nobody asked for; left unfollowed, the browser
 * reports an opaque redirect, which is read as the go ahead it is.
 */
export async function probeAuthorize(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeAnswer | null> {
  try {
    const response = await fetchImpl(url, { redirect: "manual", credentials: "omit" });
    if (response.type === "opaqueredirect") return { status: 302, body: null };
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}
