import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/app/app/dashboard";
import { ONBOARDED_METADATA_KEY } from "@/lib/onboarding";
import { all, byText, flush, messages, render, type Mounted } from "./render";

/**
 * Where the Start free trial button appears, and where it does not.
 *
 * The button is the product's one aggressive control, so the thing worth
 * holding is that it is drawn exactly when the account can actually have a
 * trial. A button that is on screen for somebody who is already paying is not
 * a design detail; it is a request the server can only refuse.
 *
 * Everything here is mounted whole, because placement is a decision the hub
 * makes and no leaf component can be asked about it. Nothing reaches a
 * network: the account client is a fake and every hosted call answers from a
 * table this file sets.
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

vi.mock("@/app/app/install", () => ({ InstallControl: () => null }));
vi.mock("@/lib/synced-usage", () => ({
  readSyncedApiSpend: async () => ({ ok: true, sources: [] }),
  readSyncedUsage: async () => ({ ok: false, reason: "signed_out" }),
}));
vi.mock("@/lib/account-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-client")>();
  return { ...actual, createAccountClient: () => fakeClient() };
});

const hub = messages.hub;
const trial = hub.trial;
const pro = hub.pro;

const NOW = Date.now();
const IN_TEN_DAYS = new Date(NOW + 10 * 86_400_000).toISOString();
const YESTERDAY = new Date(NOW - 86_400_000).toISOString();
const OFFER_OPEN = new Date(NOW + 3 * 86_400_000).toISOString();

let entitlementRow: Record<string, unknown> | null = null;
let entitlementFails = false;
let authCallback: ((event: string, session: unknown) => void) | null = null;
let mounted: Mounted | null = null;

/** The signed in account every test here opens with, first run already done. */
const SESSION = {
  user: {
    id: "user-1",
    email: "person@example.com",
    user_metadata: { full_name: "Ada Lovelace", [ONBOARDED_METADATA_KEY]: true },
    app_metadata: { provider: "github" },
  },
};

function fakeClient(): unknown {
  return {
    auth: {
      getSession: async () => ({ data: { session: SESSION } }),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        authCallback = cb;
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      stopAutoRefresh: async () => undefined,
      startAutoRefresh: async () => undefined,
      updateUser: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null }),
    },
    functions: {
      invoke: async (fn: string) => {
        if (fn === "entitlement") {
          if (entitlementFails) {
            return { data: null, error: { context: { status: 500 } } };
          }
          return { data: { entitlement: entitlementRow, devices: [] }, error: null };
        }
        return { data: null, error: { context: { status: 401 } } };
      },
    },
  };
}

beforeEach(() => {
  entitlementRow = null;
  entitlementFails = false;
  authCallback = null;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/app");
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function open(): Promise<Mounted> {
  const view = render(createElement(Dashboard, { lockup: null }));
  mounted = view;
  await flush(4);
  return view;
}

function press(node: Element | null): void {
  expect(node).not.toBeNull();
  mounted?.run(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Every Start free trial control on the screen, wherever it is drawn. */
function starters(view: Mounted): Element[] {
  return all(view.container, "button").filter(
    (node) => node.textContent?.trim() === trial.start,
  );
}

describe("the header", () => {
  it("carries the button for an account that has never had a plan", async () => {
    const view = await open();
    expect(starters(view).length).toBeGreaterThan(0);
    /* Beside the logo, on its own row at phone width, not lumped in with the
       icon group: see pieces.tsx HeaderStrip's `accent` prop. */
    expect(view.container.querySelector(".ol-commandbar-brand-row")?.textContent).toContain(
      trial.start,
    );
  });

  it("drops it the moment a trial exists", async () => {
    entitlementRow = { plan_state: "trialing", trial_ends_at: IN_TEN_DAYS };
    const view = await open();
    expect(view.container.querySelector(".ol-commandbar-actions")?.textContent).not.toContain(
      trial.start,
    );
  });

  it("drops it for a paid plan and for one that has ended", async () => {
    entitlementRow = { plan_state: "active", current_period_end: IN_TEN_DAYS };
    let view = await open();
    expect(starters(view).length).toBe(0);
    view.unmount();

    entitlementRow = { plan_state: "expired", trial_ends_at: YESTERDAY };
    view = await open();
    expect(starters(view).length).toBe(0);
  });

  it("keeps the trialing entitlement and does not show the button if a refresh fails", async () => {
    entitlementRow = { plan_state: "trialing", trial_ends_at: IN_TEN_DAYS };
    const view = await open();
    expect(view.container.querySelector(".ol-commandbar-actions")?.textContent).not.toContain(
      trial.start,
    );

    /* A subsequent background refresh fails */
    entitlementFails = true;
    await view.run(async () => {
      authCallback?.("TOKEN_REFRESHED", SESSION);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await flush(3);

    /* The previous entitlement is kept on failure, so the button is still not shown */
    expect(view.container.querySelector(".ol-commandbar-actions")?.textContent).not.toContain(
      trial.start,
    );
    expect(starters(view).length).toBe(0);
  });
});

describe("the locked Pro surfaces under the bars", () => {
  it("names all four and offers the trial when there is no plan", async () => {
    const view = await open();
    const lines = all(view.container, ".ol-lock-list li").map((node) => node.textContent?.trim());
    expect(lines).toEqual([
      pro.feature.alerts,
      pro.feature.history,
      pro.feature.phone,
      pro.feature.multiAccount,
    ]);
  });

  it("says what stopped, with the countdown, inside the offer window", async () => {
    entitlementRow = {
      plan_state: "expired",
      trial_ends_at: YESTERDAY,
      offer_ends_at: OFFER_OPEN,
    };
    const view = await open();
    expect(view.container.textContent).toContain(pro.lost.alerts);
    expect(view.container.querySelector(".ol-lock-countdown")).not.toBeNull();
    expect(view.container.textContent).toContain(pro.offer.price);
  });

  it("shows the ordinary prices once the offer window has passed", async () => {
    entitlementRow = {
      plan_state: "expired",
      trial_ends_at: YESTERDAY,
      offer_ends_at: YESTERDAY,
    };
    const view = await open();
    expect(view.container.querySelector(".ol-lock-countdown")).toBeNull();
    expect(view.container.textContent).toContain("$50 a year.");
    expect(byText(view.container, "button", pro.prices.take)).not.toBeNull();
  });

  it("is not on the screen at all for a running trial", async () => {
    entitlementRow = { plan_state: "trialing", trial_ends_at: IN_TEN_DAYS };
    const view = await open();
    expect(view.container.querySelector(".ol-lock")).toBeNull();
  });
});

describe("the alerts gate", () => {
  it("carries the same button, because alerts are where people meet the gate", async () => {
    const view = await open();
    press(
      all(view.container, "button").find(
        (node) => node.getAttribute("aria-label") === "Open alerts",
      ) ?? null,
    );
    await flush();
    expect(view.container.querySelector(".ol-notification-popover")?.textContent).toContain(
      trial.start,
    );
  });
});

describe("the deep link the tray opens", () => {
  it("lands straight in the wizard and takes the parameter out of the address", async () => {
    window.history.replaceState(null, "", "/app?trial=1");
    const view = await open();
    expect(view.container.textContent).toContain(trial.alerts.title);
    expect(window.location.search).toBe("");
  });

  it("opens the ordinary hub without it", async () => {
    const view = await open();
    expect(view.container.textContent).not.toContain(trial.alerts.title);
    expect(view.container.textContent).toContain(hub.empty.line);
  });

  it("reaches the wizard from the header button as well", async () => {
    const view = await open();
    press(starters(view)[0] ?? null);
    await flush();
    expect(view.container.textContent).toContain(trial.alerts.title);
  });
});
