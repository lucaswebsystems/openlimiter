import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProLockCard, StartTrialButton, TrialWizard } from "@/app/app/trial";
import type { ProEntitlement, ProPlanState } from "@/lib/pro";
import { all, byText, flush, messages, render, type Mounted } from "./render";

/**
 * The trial wizard and the lock card, mounted for real.
 *
 * What is asserted is what a reader would check by looking: that one button
 * starts the trial, push refusal is soft, the server's expired summary is
 * rendered with its own numbers, and a trialing account never draws the lock.
 *
 * Every sentence is compared against the shipped English catalog rather than
 * against a copy written here, so a wording change moves the test with the
 * product and a missing key fails loudly instead of rendering a key path.
 */

let currentLocale = "en";

vi.mock("next-intl", async () => {
  const catalog = (await import("../messages/en.json")).default as Record<string, unknown>;
  return {
    useLocale: () => currentLocale,
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

/* The browser push interfaces jsdom does not have. Each test says what this
   browser answered; nothing here reaches a push service. */
let pushAnswer: unknown = { state: "unsupported" };
vi.mock("@/lib/pro-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pro-notifications")>();
  return { ...actual, subscribeBrowserPush: async () => pushAnswer };
});

const trial = messages.hub.trial;
const pro = messages.hub.pro;

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const IN_THIRTY_DAYS = new Date(NOW + 30 * 86_400_000).toISOString();
const YESTERDAY = new Date(NOW - 86_400_000).toISOString();
/* Two days, six hours and thirty minutes of offer left. */
const OFFER_OPEN = new Date(NOW + 2 * 86_400_000 + 6 * 3_600_000 + 30 * 60_000).toISOString();

let mounted: Mounted | null = null;
let answers: unknown[] = [];
let invoke: ReturnType<typeof vi.fn>;
let expiredSummary: unknown = {
  data: {
    alert_count: 4,
    phone_paired: true,
    additional_account_count: 2,
    hosted_context_enabled: true,
  },
  error: null,
};

function client(): SupabaseClient {
  invoke = vi.fn(async (_fn: string, options: { body?: Record<string, unknown> }) => {
    if (options.body?.action === "read_expired_pro_summary") return expiredSummary;
    return answers.shift() ?? { data: {}, error: null };
  });
  return { functions: { invoke } } as unknown as SupabaseClient;
}

function entitlement(overrides: Partial<ProEntitlement> = {}): ProEntitlement {
  return {
    planState: "expired" as ProPlanState,
    features: [],
    trialEndsAt: YESTERDAY,
    offerEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueUntil: null,
    activeDeviceCount: 0,
    deviceCap: 5,
    ...overrides,
  };
}

function press(node: Element | null): void {
  expect(node).not.toBeNull();
  mounted?.run(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function switches(view: Mounted): HTMLElement[] {
  return all<HTMLElement>(view.container, '[role="switch"]');
}

beforeEach(() => {
  answers = [];
  pushAnswer = { state: "unsupported" };
  expiredSummary = {
    data: {
      alert_count: 4,
      phone_paired: true,
      additional_account_count: 2,
      hosted_context_enabled: true,
    },
    error: null,
  };
  currentLocale = "en";
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function openWizard(): Mounted {
  const started = vi.fn();
  const closed = vi.fn();
  const view = render(
    createElement(TrialWizard, { client: client(), onStarted: started, onClose: closed }),
  );
  mounted = view;
  return view;
}

describe("the one button wizard", () => {
  it("shows one start control and one optional push permission", () => {
    const view = openWizard();
    expect(view.container.textContent).toContain(trial.title);
    expect(view.container.textContent).toContain(trial.profile);
    expect(view.container.textContent).toContain(trial.push.optional);
    expect(switches(view)).toHaveLength(0);
    expect(all(view.container, "button").filter((node) => node.textContent?.trim() === trial.start))
      .toHaveLength(1);
  });

  it("makes one call however many times the button is pressed", async () => {
    answers = [
      new Promise((resolve) =>
        setTimeout(() => resolve({ data: { entitlement: null }, error: null }), 0),
      ),
    ];
    const view = openWizard();
    const start = byText(view.container, "button", trial.start);
    press(start);
    press(start);
    press(start);
    await flush(4);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("starts when push is declined and returns the completed state", async () => {
    answers = [
      {
        data: { entitlement: { plan_state: "trialing", trial_ends_at: IN_THIRTY_DAYS } },
        error: null,
      },
    ];
    const view = openWizard();
    pushAnswer = { state: "denied" };
    press(byText(view.container, "button", trial.start));
    await flush(3);
    expect(view.container.textContent).toContain(trial.done.title);
    expect(view.container.textContent).toContain(trial.done.lead);
    expect(view.container.textContent).not.toContain(trial.alerts.title);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ body: { action: "start_trial" } });
  });

  it("sends the granted push subscription without threshold choices", async () => {
    pushAnswer = { state: "granted", subscription: { endpoint: "https://push.example/1" } };
    answers = [
      {
        data: { entitlement: null },
        error: null,
      },
    ];
    const view = openWizard();
    press(byText(view.container, "button", trial.start));
    await flush(3);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      body: {
        action: "start_trial",
        preferences: { push: { endpoint: "https://push.example/1" } },
      },
    });
    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty("body.preferences.alerts");
  });

  it("says the account has had its trial when the server refuses it", async () => {
    answers = [{ data: null, error: { context: { status: 409 } } }];
    const view = openWizard();
    press(byText(view.container, "button", trial.start));
    await flush(3);
    expect(view.container.textContent).toContain(trial.error.alreadyUsed);
    expect(view.container.textContent).not.toContain(trial.done.title);
  });

  it("says the same when the refusal arrives as a 200 body rather than a 409", async () => {
    answers = [
      {
        data: { error: "trial_already_used", entitlement: { plan_state: "trialing" } },
        error: null,
      },
    ];
    const view = openWizard();
    press(byText(view.container, "button", trial.start));
    await flush(3);
    expect(view.container.textContent).toContain(trial.error.alreadyUsed);
    expect(view.container.textContent).not.toContain(trial.done.title);
  });

  it("says the switch is off rather than blaming the service on a 503", async () => {
    answers = [{ data: null, error: { context: { status: 503 } } }];
    const view = openWizard();
    press(byText(view.container, "button", trial.start));
    await flush(3);
    expect(view.container.textContent).toContain(trial.error.switchedOff);
    expect(byText(view.container, "button", trial.error.retry)).not.toBeNull();
  });
});

describe("the lock card", () => {
  function lock(row: ProEntitlement | null): Mounted {
    const view = render(
      createElement(ProLockCard, {
        client: client(),
        entitlement: row,
        onStartTrial: () => undefined,
        now: NOW,
      }),
    );
    mounted = view;
    return view;
  }

  it("offers the trial, and nothing else, to an account with no plan", () => {
    const view = lock(null);
    expect(view.container.textContent).toContain(pro.locked.title);
    expect(view.container.textContent).toContain(pro.feature.alerts);
    expect(byText(view.container, "button", trial.start)).not.toBeNull();
    expect(view.container.textContent).not.toContain(pro.offer.take);
  });

  it("draws nothing at all while a trial is running and does not read the summary", async () => {
    const view = lock(entitlement({ planState: "trialing", trialEndsAt: IN_THIRTY_DAYS }));
    await flush(3);
    expect(view.container.textContent).toBe("");
    expect(invoke.mock.calls.some((call) => call[1]?.body?.action === "read_expired_pro_summary"))
      .toBe(false);
  });

  it("draws nothing at all for a paid plan", () => {
    const view = lock(
      entitlement({ planState: "active", currentPeriodEnd: IN_THIRTY_DAYS, trialEndsAt: null }),
    );
    expect(view.container.textContent).toBe("");
  });

  it("reads and names the exact services that stopped", async () => {
    const view = lock(entitlement());
    await flush(3);
    expect(view.container.textContent).toContain(pro.expired.title);
    const lines = all(view.container, ".ol-lock-list li").map((node) => node.textContent?.trim());
    expect(lines).toEqual([
      pro.lost.alerts.replace("{count}", "4"),
      pro.lost.phone.replace("{status}", pro.lost.paired),
      pro.lost.multiAccount.replace("{count}", "2"),
      pro.lost.hostedContext.replace("{status}", pro.lost.on),
    ]);
    expect(view.container.textContent).toContain(pro.restore);
    expect(invoke.mock.calls.some((call) => call[1]?.body?.action === "read_expired_pro_summary"))
      .toBe(true);
  });

  it("renders the empty expired profile without inventing features", async () => {
    expiredSummary = {
      data: {
        alert_count: 0,
        phone_paired: false,
        additional_account_count: 0,
        hosted_context_enabled: false,
      },
      error: null,
    };
    const view = lock(entitlement());
    await flush(3);
    expect(view.container.textContent).toContain(pro.lost.noAlerts);
    expect(view.container.textContent).not.toContain(pro.lost.alerts.replace("{count}", "0"));
    expect(view.container.textContent).toContain(
      pro.lost.phone.replace("{status}", pro.lost.notPaired),
    );
    expect(view.container.textContent).toContain(pro.lost.multiAccount.replace("{count}", "0"));
    expect(view.container.textContent).toContain(
      pro.lost.hostedContext.replace("{status}", pro.lost.off),
    );
  });

  it("carries the countdown and the discounted year inside the window", () => {
    const view = lock(entitlement({ offerEndsAt: OFFER_OPEN }));
    expect(view.container.querySelector(".ol-lock-countdown")?.textContent).toBe("2d 6h 30m");
    expect(view.container.textContent).toContain(pro.offer.price);
    expect(byText(view.container, "button", pro.offer.take)).not.toBeNull();
  });

  it("falls back to the ordinary prices once the window has passed", () => {
    const view = lock(entitlement({ offerEndsAt: YESTERDAY }));
    expect(view.container.querySelector(".ol-lock-countdown")).toBeNull();
    expect(view.container.textContent).toContain("$50 a year.");
    expect(byText(view.container, "button", pro.prices.take)).not.toBeNull();
  });

  it("hatches the horizon behind a plan that has ended", () => {
    const view = lock(entitlement());
    expect(view.container.textContent).toContain(pro.expired.title);
    expect(view.container.textContent).toContain(pro.expired.lead);
    mounted?.unmount();
    const offering = lock(null);
    expect(offering.container.textContent).toContain(pro.locked.title);
    expect(offering.container.textContent).toContain(pro.locked.lead);
  });

  it("asks for the discounted session and follows it to Stripe", async () => {
    answers = [{ data: { url: "https://checkout.stripe.com/discounted" }, error: null }];
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "https://openlimiter.com/app", search: "" },
    });
    const view = lock(entitlement({ offerEndsAt: OFFER_OPEN }));
    press(byText(view.container, "button", pro.offer.take));
    await flush(3);
    const checkoutCall = invoke.mock.calls.find(
      (call) => call[1]?.body?.interval === "year",
    );
    expect(checkoutCall?.[1]).toEqual({
      body: { interval: "year", offer: "trial_end_annual" },
    });
    expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/discounted");
  });

  it("refuses a checkout url that is not on checkout.stripe.com", async () => {
    answers = [{ data: { url: "https://attacker.example/session" }, error: null }];
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "https://openlimiter.com/app", search: "" },
    });
    const view = lock(entitlement({ offerEndsAt: OFFER_OPEN }));
    press(byText(view.container, "button", pro.offer.take));
    await flush(3);
    expect(assign).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain(pro.error);
  });

  it("resyncs the countdown on visibilitychange when the tab becomes visible", async () => {
    const ends = new Date(Date.now() + 5000).toISOString();
    const view = render(
      createElement(ProLockCard, {
        client: client(),
        entitlement: entitlement({ offerEndsAt: ends }),
        onStartTrial: () => undefined,
      }),
    );
    mounted = view;
    expect(view.container.querySelector(".ol-lock-countdown")).not.toBeNull();

    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    try {
      await view.run(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(view.container.querySelector(".ol-lock-countdown")).toBeNull();
      expect(view.container.textContent).toContain("$50 a year.");
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("the button itself", () => {
  it("writes the promise out in full, and folds it into the title when compact", () => {
    const full = render(createElement(StartTrialButton, { onStart: () => undefined }));
    mounted = full;
    expect(full.container.textContent).toContain(trial.free);
    full.unmount();

    const compact = render(
      createElement(StartTrialButton, { onStart: () => undefined, compact: true }),
    );
    mounted = compact;
    expect(compact.container.textContent).toContain(trial.free);
    expect(compact.container.querySelector("button")?.getAttribute("title")).toBe(trial.free);
  });
});
