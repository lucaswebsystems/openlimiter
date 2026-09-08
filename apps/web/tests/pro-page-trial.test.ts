import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProPortal } from "@/components/pro-portal";
import { all, byText, flush, messages, render, type Mounted } from "./render";

/**
 * The Pro page's half of the trial and the offer.
 *
 * Two things are held here. The page offers the trial and never starts one:
 * its button is a way to the wizard, which is the single caller of
 * `start_trial` in this application. And a plan that has ended is shown what
 * stopped and, while the window is open, the discounted year with the same
 * countdown the hub draws, from the same server instant.
 */

vi.mock("@/i18n/navigation", async () => {
  const { createElement: element } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      element("a", { href, ...rest }, children as never),
    redirect: () => undefined,
    usePathname: () => "/pro",
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

/* This deployment has a hosted address, as far as this page is concerned. The
   client underneath it is a fake, so nothing here reaches one. */
vi.mock("@/lib/pro", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pro")>();
  return { ...actual, proConfigurationReady: true };
});

vi.mock("@/lib/account-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-client")>();
  return { ...actual, createAccountClient: () => fakeClient() };
});

const portal = messages.proPortal;

const NOW = Date.now();
const IN_TEN_DAYS = new Date(NOW + 10 * 86_400_000).toISOString();
const YESTERDAY = new Date(NOW - 86_400_000).toISOString();
const OFFER_OPEN = new Date(NOW + 4 * 86_400_000).toISOString();

let entitlementRow: Record<string, unknown> | null = null;
let expiredSummary: unknown = {
  data: {
    alert_count: 4,
    phone_paired: true,
    additional_account_count: 2,
    hosted_context_enabled: true,
  },
  error: null,
};
let checkoutUrl = "https://checkout.stripe.com/offer";
let invoked: { fn: string; options: { body: unknown } }[] = [];
let mounted: Mounted | null = null;

const SESSION = { user: { id: "user-1", email: "person@example.com" } };

function fakeClient(): unknown {
  return {
    auth: {
      getSession: async () => ({ data: { session: SESSION } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      stopAutoRefresh: async () => undefined,
      startAutoRefresh: async () => undefined,
      signOut: async () => ({ error: null }),
    },
    functions: {
      invoke: async (fn: string, options: { body: unknown }) => {
        invoked.push({ fn, options });
        if (fn === "entitlement") {
          return { data: { entitlement: entitlementRow, devices: [] }, error: null };
        }
        if ((options.body as Record<string, unknown>).action === "read_expired_pro_summary") {
          return expiredSummary;
        }
        if (fn === "create-checkout") return { data: { url: checkoutUrl }, error: null };
        return { data: null, error: { context: { status: 500 } } };
      },
    },
  };
}

beforeEach(() => {
  entitlementRow = null;
  expiredSummary = {
    data: {
      alert_count: 4,
      phone_paired: true,
      additional_account_count: 2,
      hosted_context_enabled: true,
    },
    error: null,
  };
  invoked = [];
  checkoutUrl = "https://checkout.stripe.com/offer";
  window.localStorage.clear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function open(): Promise<Mounted> {
  const view = render(createElement(ProPortal, { locale: "en" }));
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

describe("the trial on the Pro page", () => {
  it("offers it to an account with no plan, with the promise written out", async () => {
    const view = await open();
    expect(view.container.textContent).toContain(portal.trial.title);
    expect(view.container.textContent).toContain(portal.trial.free);
    expect(byText(view.container, "button", portal.trial.start)).not.toBeNull();
  });

  it("sends the reader to the wizard rather than starting anything here", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "https://openlimiter.com/pro", pathname: "/pro", search: "" },
    });
    const view = await open();
    press(byText(view.container, "button", portal.trial.start));
    await flush();
    expect(assign).toHaveBeenCalledWith("/app?trial=1");
    expect(invoked.filter((call) => call.fn !== "entitlement")).toEqual([]);
  });

  it("offers no trial once one exists", async () => {
    entitlementRow = { plan_state: "trialing", trial_ends_at: IN_TEN_DAYS };
    const view = await open();
    expect(byText(view.container, "button", portal.trial.start)).toBeNull();
  });
});

describe("the offer on the Pro page", () => {
  it("names what stopped and counts the window down", async () => {
    entitlementRow = {
      plan_state: "expired",
      trial_ends_at: YESTERDAY,
      offer_ends_at: OFFER_OPEN,
    };
    const view = await open();
    const lines = all(view.container, "li").map((node) => node.textContent?.trim());
    expect(lines).toContain(portal.lost.alerts.replace("{count}", "4"));
    expect(lines).toContain(portal.lost.phone.replace("{status}", portal.lost.paired));
    expect(lines).toContain(portal.lost.multiAccount.replace("{count}", "2"));
    expect(lines).toContain(portal.lost.hostedContext.replace("{status}", portal.lost.on));
    expect(view.container.textContent).toContain(portal.restore);
    expect(view.container.textContent).toContain(portal.offer.price);
    expect(byText(view.container, "button", portal.offer.take)).not.toBeNull();
    /* One price on the screen, not two: the ordinary upgrade panel steps aside
       while the discounted one is live. */
    expect(view.container.textContent).not.toContain(portal.upgrade.title);
  });

  it("names the empty expired profile from the server response", async () => {
    entitlementRow = {
      plan_state: "expired",
      trial_ends_at: YESTERDAY,
      offer_ends_at: null,
    };
    expiredSummary = {
      data: {
        alert_count: 0,
        phone_paired: false,
        additional_account_count: 0,
        hosted_context_enabled: false,
      },
      error: null,
    };
    const view = await open();
    expect(view.container.textContent).toContain(portal.lost.noAlerts);
    expect(view.container.textContent).not.toContain(portal.lost.alerts.replace("{count}", "0"));
    expect(view.container.textContent).toContain(
      portal.lost.phone.replace("{status}", portal.lost.notPaired),
    );
    expect(view.container.textContent).toContain(portal.lost.multiAccount.replace("{count}", "0"));
    expect(view.container.textContent).toContain(
      portal.lost.hostedContext.replace("{status}", portal.lost.off),
    );
  });

  it("does not ask for an expired summary during a live trial", async () => {
    entitlementRow = { plan_state: "trialing", trial_ends_at: IN_TEN_DAYS };
    const view = await open();
    expect(invoked.some((call) => (call.options.body as Record<string, unknown>).action === "read_expired_pro_summary"))
      .toBe(false);
    expect(view.container.textContent).not.toContain(portal.restore);
  });

  it("asks create-checkout for the named offer and follows the session", async () => {
    entitlementRow = {
      plan_state: "expired",
      trial_ends_at: YESTERDAY,
      offer_ends_at: OFFER_OPEN,
    };
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "https://openlimiter.com/pro", pathname: "/pro", search: "" },
    });
    const view = await open();
    press(byText(view.container, "button", portal.offer.take));
    await flush(3);
    expect(invoked.find((call) => call.fn === "create-checkout")?.options).toEqual({
      body: {
        interval: "year",
        offer: "trial_end_annual",
      },
    });
    expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/offer");
  });

  it("falls back to the ordinary prices once the window has closed", async () => {
    entitlementRow = {
      plan_state: "expired",
      trial_ends_at: YESTERDAY,
      offer_ends_at: YESTERDAY,
    };
    const view = await open();
    expect(byText(view.container, "button", portal.offer.take)).toBeNull();
    expect(view.container.textContent).toContain(portal.upgrade.title);
  });
});
