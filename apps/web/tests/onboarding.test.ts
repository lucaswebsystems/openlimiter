import { describe, expect, it } from "vitest";
import {
  CONNECT_COMMAND,
  ONBOARDED_METADATA_KEY,
  ONBOARDING_STEPS,
  VIEW_AFTER_ONBOARDING,
  browserOnboarded,
  hasOnboarded,
  nextStep,
  onboardedStorageKey,
  openingView,
  profileEmail,
  profileName,
  profileProviderName,
  rememberOnboarded,
  type AccountProfile,
} from "@/lib/onboarding";

/**
 * The first visit, and every visit after it.
 *
 * Two rules are held here. The flow happens once per account, whichever of its
 * two records answers first, and everything the first screen shows about a
 * person comes from what the provider actually sent rather than from anything
 * invented on their behalf.
 */

function store(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const GITHUB: AccountProfile = {
  id: "user-1",
  email: "person@example.com",
  user_metadata: { full_name: "Ada Lovelace" },
  app_metadata: { provider: "github" },
};

describe("what the first screen opens with", () => {
  it("takes the name the provider sent", () => {
    expect(profileName(GITHUB)).toBe("Ada Lovelace");
    expect(profileName({ id: "u", user_metadata: { name: "Grace" } })).toBe("Grace");
    expect(profileName({ id: "u", user_metadata: { preferred_username: "grace" } })).toBe("grace");
    expect(profileName({ id: "u", user_metadata: { user_name: "grace" } })).toBe("grace");
  });

  it("falls back to the reader's own address and never invents a name", () => {
    expect(profileName({ id: "u", email: "grace@example.com" })).toBe("grace");
    expect(profileName({ id: "u" })).toBe("");
    expect(profileName({ id: "u", user_metadata: { full_name: "   " }, email: null })).toBe("");
    expect(profileName(null)).toBe("");
  });

  it("shows the address exactly as it arrived, and nothing when none did", () => {
    expect(profileEmail(GITHUB)).toBe("person@example.com");
    expect(profileEmail({ id: "u" })).toBe("");
    expect(profileEmail(null)).toBe("");
  });

  it("names the provider the way the provider names itself", () => {
    expect(profileProviderName(GITHUB)).toBe("GitHub");
    expect(profileProviderName({ id: "u", app_metadata: { provider: "google" } })).toBe("Google");
    /* The service says azure. The reader saw a Microsoft page. */
    expect(profileProviderName({ id: "u", app_metadata: { provider: "azure" } })).toBe("Microsoft");
    /* A link is not a provider with a name worth showing. */
    expect(profileProviderName({ id: "u", app_metadata: { provider: "email" } })).toBeNull();
    expect(profileProviderName({ id: "u" })).toBeNull();
  });
});

describe("whether the flow has already happened", () => {
  it("takes the account's own record as an answer", () => {
    const done: AccountProfile = {
      ...GITHUB,
      user_metadata: { ...GITHUB.user_metadata, [ONBOARDED_METADATA_KEY]: true },
    };
    expect(hasOnboarded(done, store())).toBe(true);
  });

  it("takes this browser's record as an answer too", () => {
    const local = store({ [onboardedStorageKey("user-1")]: "true" });
    expect(browserOnboarded("user-1", local)).toBe(true);
    expect(hasOnboarded(GITHUB, local)).toBe(true);
    /* One account's record says nothing about another's. */
    expect(browserOnboarded("user-2", local)).toBe(false);
  });

  it("is a first visit when neither record says otherwise", () => {
    expect(hasOnboarded(GITHUB, store())).toBe(false);
    expect(hasOnboarded(GITHUB, null)).toBe(false);
    expect(hasOnboarded(null, store())).toBe(false);
  });

  it("records the answer against the account it belongs to", () => {
    const local = store();
    rememberOnboarded("user-1", local);
    expect(local.map.get(onboardedStorageKey("user-1"))).toBe("true");
    expect(hasOnboarded(GITHUB, local)).toBe(true);
    expect(() => rememberOnboarded("user-1", null)).not.toThrow();
  });
});

describe("the view the hub opens on", () => {
  it("is the flow on a first visit and the bars on every later one", () => {
    expect(openingView(false)).toBe("onboarding");
    expect(openingView(true)).toBe("bars");
  });

  it("sends the Later link and the last step to the same place", () => {
    expect(VIEW_AFTER_ONBOARDING).toBe("bars");
  });

  it("runs its three screens in order and then stops", () => {
    expect([...ONBOARDING_STEPS]).toEqual(["profile", "connect", "bars"]);
    expect(nextStep("profile")).toBe("connect");
    expect(nextStep("connect")).toBe("bars");
    expect(nextStep("bars")).toBeNull();
  });

  it("hands the terminal one command and keeps it out of the catalogs", () => {
    expect(CONNECT_COMMAND).toBe("npx openlimiter");
  });
});
