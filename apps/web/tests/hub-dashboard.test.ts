import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/app/app/dashboard";
import { ONBOARDED_METADATA_KEY, onboardedStorageKey } from "@/lib/onboarding";
import { all, byText, flush, messages, render, type Mounted } from "./render";
import * as cloudMeter from "@/lib/cloud-meter";

/**
 * The hub itself, mounted whole.
 *
 * The screens are tested one by one next door. What can only be seen from here
 * is what the hub decides: which view a session lands on, what a first run
 * writes when it ends, and what happens to the client underneath when the
 * session switch moves. Every one of those is a bug that no leaf component can
 * show, because no leaf component owns any of it.
 *
 * Nothing here reaches a network. The account client is a fake that counts
 * what was asked of it, and the synced read is a promise this file resolves by
 * hand, which is the only way to look at the screen while a read is still in
 * flight.
 */

vi.mock("@/i18n/navigation", async () => {
  const { createElement: element } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      element("a", { href, ...rest }, children as never),
    redirect: () => undefined,
    usePathname: () => "/app",
    useRouter: () => ({ push: () => undefined, replace: () => undefined }),
    getPathname: ({ href }: { href: string }) => href,
  };
});

vi.mock("next-intl", async () => {
  const catalog = (await import("../messages/en.json")).default as Record<string, unknown>;
  return {
    useLocale: () => "en",
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
      const path = `${namespace}.${key}`.split(".");
      let node: unknown = catalog;
      for (const step of path) {
        node =
          node === null || typeof node !== "object"
            ? undefined
            : (node as Record<string, unknown>)[step];
      }
      if (typeof node !== "string") throw new Error(`missing message: ${path.join(".")}`);
      return node.replace(/\{(\w+)\}/gu, (whole, name: string) =>
        values?.[name] === undefined ? whole : String(values[name]),
      );
    },
  };
});

/* Two widgets that only talk to browser interfaces this document does not
   have. Neither decides anything the hub is tested on here. */
vi.mock("@/app/app/notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("@/app/app/install", () => ({ InstallControl: () => null }));

vi.mock("@/lib/synced-usage", () => ({
  readSyncedApiSpend: () => currentSpend(),
  readSyncedUsage: () => currentRead(),
}));

vi.mock("@/lib/account-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-client")>();
  return {
    ...actual,
    createAccountClient: (keep: boolean) => makeClient(keep),
    /* Wrapped rather than replaced, so the order of the handover is visible:
       the move has to be the last thing that happens, after the old client has
       been silenced in both directions. */
    applyKeepSignedIn: (keep: boolean) => {
      order.push("move");
      return moveSucceeds ? actual.applyKeepSignedIn(keep) : false;
    },
  };
});

interface FakeClient {
  keep: boolean;
  stops: number;
  starts: number;
  listens: number;
  unsubscribes: number;
  updates: Record<string, unknown>[];
  auth: Record<string, unknown>;
}

let built: FakeClient[] = [];
let order: string[] = [];
let moveSucceeds = true;
let currentSession: unknown = null;
let updateUserFails = false;
let currentRead: () => Promise<unknown> = async () => ({ ok: false, reason: "signed_out" });
let currentSpend: () => Promise<unknown> = async () => ({ ok: true, sources: [] });

/** A declaration rather than an expression: the module mock above calls it. */
function makeClient(keep: boolean): unknown {
  const client: FakeClient = {
    keep,
    stops: 0,
    starts: 0,
    listens: 0,
    unsubscribes: 0,
    updates: [],
    auth: {},
  };
  client.auth = {
    getSession: async () => ({ data: { session: currentSession } }),
    onAuthStateChange: () => {
      client.listens += 1;
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              client.unsubscribes += 1;
              order.push("unsubscribe");
            },
          },
        },
      };
    },
    stopAutoRefresh: async () => {
      client.stops += 1;
      order.push("stop");
    },
    startAutoRefresh: async () => {
      client.starts += 1;
      order.push("start");
    },
    updateUser: async (data: Record<string, unknown>) => {
      client.updates.push(data);
      if (updateUserFails) throw new Error("offline");
      return { data: {}, error: null };
    },
    signOut: async () => ({ error: null }),
    signInWithOAuth: async () => ({ data: { url: null }, error: null }),
    signInWithOtp: async () => ({ data: {}, error: null }),
  };
  built.push(client);
  return client;
}

function signedIn(metadata: Record<string, unknown> = {}): unknown {
  return {
    user: {
      id: "user-1",
      email: "person@example.com",
      user_metadata: { full_name: "Ada Lovelace", ...metadata },
      app_metadata: { provider: "github" },
    },
  };
}

const hub = messages.hub;
let mounted: Mounted | null = null;

beforeEach(() => {
  built = [];
  order = [];
  moveSucceeds = true;
  currentSession = null;
  updateUserFails = false;
  currentRead = async () => ({ ok: false, reason: "signed_out" });
  currentSpend = async () => ({ ok: true, sources: [] });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

async function open(): Promise<Mounted> {
  const view = render(createElement(Dashboard, { lockup: null }));
  mounted = view;
  await flush(3);
  return view;
}

const heading = (view: Mounted) => view.container.querySelector("h2")?.textContent ?? null;
const gear = (view: Mounted) =>
  all(view.container, "button").find(
    (node) => node.getAttribute("aria-label") === hub.configuration,
  ) ?? null;

function press(node: Element | null): void {
  expect(node).not.toBeNull();
  mounted?.run(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("which view a session lands on", () => {
  it("20: renders desktop spend with provider, account, currency and UTC reporting period", async () => {
    currentSession = signedIn({ [ONBOARDED_METADATA_KEY]: true });
    currentRead = async () => ({ ok: true, providers: [] });
    const spend = vi.fn(async () => ({ ok: true, sources: [{ provider: "OPENROUTER", accountLabel: "personal", currency: "JPY", amountMinor: 1250, periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", observedAt: new Date().toISOString() }] }));
    currentSpend = spend;
    const view = await open();
    await flush(4);
    expect(spend).toHaveBeenCalled();
    expect(view.container.textContent).toContain("Desktop sync: OPENROUTER, personal");
    expect(view.container.textContent).toContain(new Intl.NumberFormat(undefined, { style: "currency", currency: "JPY" }).format(1250));
    expect(view.container.textContent).toContain(new Date("2026-09-01T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC" }));
    expect(view.container.textContent).toContain(new Date("2026-10-01T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC" }));
  });
  it("19 and 20: loads both spend sources with quota on initial read, polling, focus and manual sync", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-08T12:00:00Z") });
    currentSession = signedIn({ [ONBOARDED_METADATA_KEY]: true });
    const quota = vi.fn(async () => ({ ok: true, providers: [] }));
    currentRead = quota;
    let minor = 1234;
    const spend = vi.fn(async () => ({ ok: true, sources: [{ provider: "OPENROUTER", accountLabel: "work", currency: "USD", amountMinor: minor, periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", observedAt: "2026-09-08T12:00:00Z" }] }));
    currentSpend = spend;
    const cloud = vi.spyOn(cloudMeter, "listCloudKeys").mockImplementation(async () => ({ ok: true, value: [{ id: "cloud", provider: "xai", label: "Cloud account", lastStatus: "ok", amount: minor / 100, currency: "USD", observedAt: "2026-09-08T12:00:00Z" }] }));
    const view = await open();
    await flush(6);
    expect(view.container.textContent).toContain("Desktop sync: OPENROUTER, work");
    expect(view.container.textContent).toContain(new Date("2026-09-01T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC" }));
    expect(view.container.textContent).toContain(new Date("2026-10-01T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC" }));
    expect(view.container.textContent).toContain("Cloud account");
    const currency = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
    expect(view.container.textContent).toContain(currency(12.34));
    const count = quota.mock.calls.length;
    minor = 4567;
    await view.run(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    await flush(4);
    expect(quota.mock.calls.length).toBeGreaterThan(count);
    expect(spend.mock.calls.length).toBe(quota.mock.calls.length);
    expect(cloud.mock.calls.length).toBe(quota.mock.calls.length);
    expect(view.container.textContent).toContain(currency(45.67));
    minor = 8901;
    await view.run(async () => { window.dispatchEvent(new Event("focus")); });
    await flush(4);
    expect(view.container.textContent).toContain(currency(89.01));
    minor = 2345;
    press(view.container.querySelector('button[aria-label="Sync"]'));
    await view.run(async () => { await vi.advanceTimersByTimeAsync(250); });
    await flush(4);
    expect(view.container.textContent).toContain(currency(23.45));
  });
  it("opens the first run for an account that has never been here", async () => {
    currentSession = signedIn();
    const view = await open();
    expect(heading(view)).toBe(hub.onboarding.profile.title);
  });

  it("opens the bars for an account whose profile says the run is done", async () => {
    currentSession = signedIn({ [ONBOARDED_METADATA_KEY]: true });
    const view = await open();
    expect(view.container.textContent).toContain(hub.empty.line);
    expect(heading(view)).not.toBe(hub.onboarding.profile.title);
  });

  it("opens the bars for an account this browser has already run through", async () => {
    window.localStorage.setItem(onboardedStorageKey("user-1"), "true");
    currentSession = signedIn();
    const view = await open();
    expect(view.container.textContent).toContain(hub.empty.line);
  });

  it("offers no way into configuration until the first run is over", async () => {
    currentSession = signedIn();
    const view = await open();
    expect(gear(view)).toBeNull();

    press(byText(view.container, "button", hub.onboarding.profile.later));
    await flush();
    expect(gear(view)).not.toBeNull();
  });
});

describe("what the first run writes when it ends", () => {
  it("records the run on this browser and on the account, from the Later link", async () => {
    currentSession = signedIn();
    const view = await open();

    press(byText(view.container, "button", hub.onboarding.profile.later));
    await flush();

    expect(window.localStorage.getItem(onboardedStorageKey("user-1"))).toBe("true");
    expect(built[0]?.updates.at(-1)).toMatchObject({
      data: { [ONBOARDED_METADATA_KEY]: true },
    });
    expect(view.container.textContent).toContain(hub.empty.line);
  });

  it("still finishes when the profile write fails, and does not run again", async () => {
    updateUserFails = true;
    currentSession = signedIn();
    const view = await open();

    press(byText(view.container, "button", hub.onboarding.profile.later));
    await flush();

    /* The account write is the durable half and it lost. The browser half is
       what stops the flow reappearing in front of the same person. */
    expect(window.localStorage.getItem(onboardedStorageKey("user-1"))).toBe("true");
    expect(view.container.textContent).toContain(hub.empty.line);
  });
});

describe("a read that never answers", () => {
  it("releases the working state when the first read fails", async () => {
    currentRead = () => Promise.reject(new Error("offline"));
    currentSession = signedIn({ [ONBOARDED_METADATA_KEY]: true });
    const view = await open();

    /* A read that threw is still an answer. Without one the skeleton would be
       the last thing this account ever sees. */
    expect(view.container.querySelector(".ol-row-skeleton")).toBeNull();
    expect(view.container.textContent).toContain(hub.empty.line);
  });
});

describe("a read that has not answered yet", () => {
  it("holds the skeleton rather than flashing an empty account", async () => {
    let answer: (value: unknown) => void = () => undefined;
    currentRead = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    currentSession = signedIn({ [ONBOARDED_METADATA_KEY]: true });
    const view = await open();

    expect(view.container.textContent).not.toContain(hub.empty.line);
    expect(view.container.querySelector(".ol-row-skeleton")).not.toBeNull();

    view.run(() => {
      answer({ ok: false, reason: "signed_out" });
    });
    await flush();
    expect(view.container.textContent).toContain(hub.empty.line);
  });
});

describe("moving the session switch", () => {
  it("stops the old client before building the one that replaces it", async () => {
    currentSession = null;
    const view = await open();

    const toggle = view.container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(built).toHaveLength(1);

    press(toggle);
    await flush(3);

    /* One client refreshing, never two: the first is stopped and its listener
       dropped before a single key is touched. */
    expect(order.slice(0, 3)).toEqual(["stop", "unsubscribe", "move"]);
    expect(built[0]?.stops).toBe(1);
    expect(built[0]?.starts).toBe(0);
    expect(built[0]?.unsubscribes).toBeGreaterThanOrEqual(1);
    expect(built).toHaveLength(2);
    expect(built[1]?.keep).toBe(false);
    expect(window.localStorage.getItem("openlimiter-keep-signed-in")).toBe("false");
    expect(
      view.container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("puts the old client back and says so when the move is refused", async () => {
    moveSucceeds = false;
    currentSession = null;
    const view = await open();
    const listensBefore = built[0]?.listens ?? 0;

    press(view.container.querySelector('[role="switch"]'));
    await flush(3);

    /* Nothing was replaced, so the client that is still in charge has to be
       refreshing and listening again, exactly as it was a moment earlier. */
    expect(built).toHaveLength(1);
    expect(built[0]?.starts).toBe(1);
    expect(built[0]?.listens).toBe(listensBefore + 1);
    expect(window.localStorage.getItem("openlimiter-keep-signed-in")).toBeNull();
    expect(
      view.container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(view.container.textContent).toContain(messages.signIn.keepSignedInFailed);
  });
});

describe("the background poll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls again after the idle interval, and not while the tab is hidden", async () => {
    vi.useFakeTimers();
    let calls = 0;
    currentRead = async () => {
      calls += 1;
      return { ok: true, providers: [] };
    };
    currentSession = signedIn({ [ONBOARDED_METADATA_KEY]: true });
    const view = render(createElement(Dashboard, { lockup: null }));
    mounted = view;
    await view.run(async () => {
      await flush(3);
    });
    const afterMount = calls;
    expect(afterMount).toBeGreaterThan(0);

    /* Hidden: the pending timer is cancelled outright, so five minutes of
       fake time pass with no second call. */
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await view.run(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    });
    expect(calls).toBe(afterMount);

    /* Visible again: one immediate poll, which is what resumes the cadence. */
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await view.run(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await view.run(async () => {
      await flush(3);
    });
    expect(calls).toBeGreaterThan(afterMount);
  });
});
