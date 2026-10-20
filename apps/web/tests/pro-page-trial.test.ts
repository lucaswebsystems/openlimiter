import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProPortal } from "@/components/pro-portal";
import { proFeaturePhrase } from "@/lib/pro-feature-list";
import { all, byText, flush, messages, render, type Mounted } from "./render";

/**
 * The Pro page's half of the trial, the plans and the way back from checkout.
 *
 * Three things are held here. The page offers the trial and never starts one:
 * its button is a way to the wizard, which is the single caller of
 * `start_trial` in this application. A plan that has ended is shown what
 * stopped and the two locked prices, never a discounted first year. And a
 * return from Stripe is said in words, the success as well as the cancel.
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
  /* The page hands the portal the one Pro list as a phrase; so does this. */
  const inline = (messages.proFeatures as unknown as { inline: Record<string, string> }).inline;
  const view = render(createElement(ProPortal, { locale: "en", features: proFeaturePhrase((id) => inline[id], "en") }));
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

describe("an ended plan on the Pro page", () => {
  it("names what stopped and offers both plans, never a first year offer, even inside the old window", async () => {
    entitlementRow = {
      plan_state: "expired",
      trial_ends_at: YESTERDAY,
      offer_ends_at: OFFER_OPEN,
    };
    const view = await open();
    const lines = all(view.container, "li").map((node) => node.textContent?.trim());
    expect(lines).toContain(portal.lost.alerts.replace("{count}", "4"));
    expect(lines).toContain(portal.lost.multiAccount.replace("{count}", "2"));
    expect(lines).toContain(portal.lost.hostedContext.replace("{status}", portal.lost.on));
    /* The phone is free, so a paired phone is never listed as something that stopped. */
    expect(view.container.textContent).not.toContain("Phone paired");
    expect(view.container.textContent).toContain(portal.restore);
    expect(view.container.textContent).not.toContain("USD 40");
    expect(view.container.textContent).toContain(portal.upgrade.title);
    expect(byText(view.container, "button", portal.upgrade.monthly.replace("{price}", "$5"))).not.toBeNull();
    expect(byText(view.container, "button", portal.upgrade.yearly.replace("{price}", "$50"))).not.toBeNull();
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

  it("asks create-checkout for the plan pressed and never for an offer", async () => {
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
    press(byText(view.container, "button", portal.upgrade.monthly.replace("{price}", "$5")));
    await flush(3);
    expect(invoked.find((call) => call.fn === "create-checkout")?.options).toEqual({
      body: { interval: "month" },
    });
    expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/offer");
  });
});

/*
 * The way back from Stripe.
 *
 * Checkout returns to /pro with `checkout=success` or `checkout=cancel`. Both
 * used to be read and only the cancel was ever drawn. Then the success was
 * drawn as a payment Stripe had confirmed, which nothing had checked: anyone
 * can open that address (Astra finding 2). The success return now says Pro
 * turns on within a few minutes once Stripe confirms the payment, the page
 * keeps reading the account, and only an account read that shows Pro on turns
 * the notice into the confirmed one.
 */
describe("the return from checkout", () => {
  function returnFrom(outcome: string) {
    const replaceState = vi.spyOn(window.history, "replaceState");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        assign: vi.fn(),
        href: `https://openlimiter.com/pro?checkout=${outcome}`,
        pathname: "/pro",
        search: `?checkout=${outcome}`,
        hash: "",
      },
    });
    return replaceState;
  }

  it("says Pro turns on once Stripe confirms, and claims no payment the account read has not shown", async () => {
    entitlementRow = { plan_state: "trialing", trial_ends_at: IN_TEN_DAYS };
    const replaceState = returnFrom("success");
    const view = await open();
    expect(view.container.textContent).not.toMatch(/Payment received|Stripe confirmed/u);
    expect(view.container.textContent).toContain(portal.checkout.pending.title);
    expect(view.container.textContent).toContain(portal.checkout.pending.body);
    /* The parameter leaves the address, so a reload does not say it twice. */
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pro");
    press(byText(view.container, "button", portal.checkout.dismiss));
    expect(view.container.textContent).not.toContain(portal.checkout.pending.title);
  });

  it("turns into the confirmed notice once a later account read shows Pro on", async () => {
    vi.useFakeTimers();
    try {
      entitlementRow = { plan_state: "trialing", trial_ends_at: IN_TEN_DAYS };
      returnFrom("success");
      const view = await open();
      expect(view.container.textContent).not.toMatch(/Payment received|Stripe confirmed/u);
      entitlementRow = { plan_state: "active", current_period_end: IN_TEN_DAYS, features: ["alerts", "history"] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      await flush(4);
      expect(view.container.textContent).toContain(portal.checkout.confirmed.title);
      expect(view.container.textContent).not.toContain(portal.checkout.pending.title);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says Pro is on at once when the account already shows it, claiming no payment", async () => {
    entitlementRow = { plan_state: "active", current_period_end: IN_TEN_DAYS, features: ["alerts", "history"] };
    returnFrom("success");
    const view = await open();
    expect(view.container.textContent).toContain(portal.checkout.confirmed.title);
    expect(view.container.textContent).toContain(portal.checkout.confirmed.body);
    /* The active plan's sentence reads the one Pro list, Ember included. */
    expect(view.container.textContent).toContain((messages.proFeatures as unknown as { inline: Record<string, string> }).inline.ember);
  });

  /* Astra round 2: a complimentary account reads as active, and it never paid.
     The confirmed notice says Pro is on and claims no payment at all; nothing
     here has verified one. */
  it("never claims a payment for a complimentary account opening a success return", async () => {
    entitlementRow = { plan_state: "comped", features: ["alerts", "history"] };
    returnFrom("success");
    const view = await open();
    const dismiss = byText(view.container, "button", portal.checkout.dismiss);
    const notice = dismiss?.closest(".rounded-2xl");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).not.toMatch(/\b(pay|paid|payment)/iu);
    expect(view.container.textContent).not.toMatch(/Payment received|Stripe confirmed/u);
    /* Nor anywhere else on the page: billing speaks of a card, invoices and a
       period "you already paid for", none of which a complimentary plan has. */
    expect(view.container.textContent).not.toMatch(/\bpaid\b/u);
    expect(byText(view.container, "button", portal.billing.manage)).toBeNull();
  });

  it("still says a cancelled checkout charged nothing", async () => {
    returnFrom("cancel");
    const view = await open();
    expect(view.container.textContent).toContain(portal.checkout.cancel.title);
    expect(view.container.textContent).not.toMatch(/Payment received|Stripe confirmed/u);
  });
});
