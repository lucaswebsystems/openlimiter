import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/app/app/dashboard";
import { ONBOARDED_METADATA_KEY, onboardedStorageKey } from "@/lib/onboarding";
import { all, byText, flush, messages, render, type Mounted } from "./render";

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
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
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
