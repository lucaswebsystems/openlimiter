/**
 * What the hub opens on, and what it remembers about a reader.
 *
 * Every decision here is a pure function over a profile and a store, so the
 * three onboarding screens and the view the hub lands on can be tested without
 * a browser, a server or a session.
 *
 * THE FLAG LIVES IN TWO PLACES, ON PURPOSE
 * ----------------------------------------
 * Onboarding is a first visit, not a first browser. The truth is therefore the
 * account's own profile, which the auth service already keeps per user and
 * which follows somebody to their next machine. But a profile write needs a
 * network, and the reader is standing in front of the screen now, so the same
 * answer is written into this browser as well and either one is enough to say
 * the flow is done. The failure that matters is showing the flow twice; two
 * places that both say yes cannot produce it, and a browser that answers yes
 * while the profile write is still in flight is exactly the behaviour wanted.
 */

/** The key the profile carries, under the account's own metadata. */
export const ONBOARDED_METADATA_KEY = "openlimiter_onboarded";

/** The command a terminal reader runs. A literal, so it is never translated. */
export const CONNECT_COMMAND = "npx openlimiter";

/** Where this browser records that an account has been through the flow. */
export function onboardedStorageKey(userId: string): string {
  return `openlimiter-onboarded-${userId}`;
}

/** The bit of an account the flow reads. Exactly the auth user's own shape. */
export interface AccountProfile {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
}

/** The smallest store this module needs, so a test can hand it a plain object. */
export interface FlagStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The name the first screen opens with.
 *
 * Providers do not agree on what a display name is called, so the four spellings
 * that actually arrive are read in turn, and the address is the last resort:
 * the part before the at sign is a poor name but it is the reader's own word,
 * which beats an empty field. Nothing here invents a name.
 */
export function profileName(profile: AccountProfile | null): string {
  if (profile === null) return "";
  const meta = profile.user_metadata ?? {};
  const named =
    textOf(meta.full_name) ??
    textOf(meta.name) ??
    textOf(meta.preferred_username) ??
    textOf(meta.user_name);
  if (named !== null) return named;
  const email = textOf(profile.email);
  if (email === null) return "";
  const local = email.split("@")[0] ?? "";
  return local;
}

/** The address the first screen shows, which the reader cannot edit. */
export function profileEmail(profile: AccountProfile | null): string {
  return textOf(profile?.email) ?? "";
}

/**
 * Which provider the account signed in with, spelled the way it is spelled.
 *
 * The auth service records `azure` for Microsoft and `email` for a link, and
 * both of those are its words rather than the product's, so they are turned
 * into the name on the page the reader actually saw.
 */
export function profileProviderName(profile: AccountProfile | null): string | null {
  const provider = textOf(profile?.app_metadata?.provider);
  if (provider === null) return null;
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  if (provider === "azure") return "Microsoft";
  return null;
}

/** Whether the profile itself says the flow is done. */
export function profileOnboarded(profile: AccountProfile | null): boolean {
  return profile?.user_metadata?.[ONBOARDED_METADATA_KEY] === true;
}

/** Whether this browser says the flow is done for this account. */
export function browserOnboarded(userId: string, store: FlagStore | null): boolean {
  if (store === null) return false;
  try {
    return store.getItem(onboardedStorageKey(userId)) === "true";
  } catch {
    return false;
  }
}

/** Either place saying yes is enough. See the note at the top of the file. */
export function hasOnboarded(profile: AccountProfile | null, store: FlagStore | null): boolean {
  if (profile === null) return false;
  return profileOnboarded(profile) || browserOnboarded(profile.id, store);
}

/** Record the answer in this browser, whatever the profile write does next. */
export function rememberOnboarded(userId: string, store: FlagStore | null): void {
  if (store === null) return;
  try {
    store.setItem(onboardedStorageKey(userId), "true");
  } catch {
    /* The flow still finished; the profile write is the durable half. */
  }
}

/** The four things the hub can be showing. */
export type HubView = "onboarding" | "bars" | "connect" | "configuration";

/**
 * What a signed in reader lands on.
 *
 * First visit is the flow. Every later visit is the bars, whether or not
 * anything has synced yet, because an empty bar screen that says how to fill
 * itself is the product and a configuration screen is a settings page.
 */
export function openingView(onboarded: boolean): HubView {
  return onboarded ? "bars" : "onboarding";
}

/** Where the Later link and the last step both go. There is only one answer. */
export const VIEW_AFTER_ONBOARDING: HubView = "bars";

/** The three screens, in the order they are drawn. */
export const ONBOARDING_STEPS = ["profile", "connect", "bars"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The step after this one, or null when the flow is finished. */
export function nextStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[index + 1] ?? null;
}
