import { describe, expect, it } from "vitest";
import {
  authRedirectUrl,
  devicesOf,
  entitlementOf,
  failureForStatus,
  proAccessState,
  proCanManageBilling,
  proCanUpgrade,
  proCheckoutOutcome,
  proTrialDaysLeft,
  type ProEntitlement,
} from "@/lib/pro";

/**
 * The states the Pro portal draws.
 *
 * The rule these tests exist to hold is that the client reads a plan and never
 * decides one. A trial whose end has passed is not a trial, an active plan
 * whose period has ended is not active, and an entitlement the server has not
 * written yet is not an invitation for the browser to invent one.
 */

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const IN_TEN_DAYS = new Date(NOW + 10 * 86_400_000).toISOString();
const YESTERDAY = new Date(NOW - 86_400_000).toISOString();

function entitlement(overrides: Partial<ProEntitlement> = {}): ProEntitlement {
  return {
    planState: "trialing",
    features: [],
    trialEndsAt: IN_TEN_DAYS,
    offerEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueUntil: null,
    activeDeviceCount: 1,
    deviceCap: 5,
    ...overrides,
  };
}

describe("proAccessState", () => {
  it("is none until the server has written a row", () => {
    expect(proAccessState(null, NOW)).toBe("none");
  });

  it("is a trial while the trial has time left", () => {
    expect(proAccessState(entitlement(), NOW)).toBe("trial");
  });

  it("is expired once a trial has run out, whatever the row still says", () => {
    expect(proAccessState(entitlement({ trialEndsAt: YESTERDAY }), NOW)).toBe("expired");
    expect(proAccessState(entitlement({ trialEndsAt: null }), NOW)).toBe("expired");
  });

  it("is active inside a paid period", () => {
    const paid = entitlement({ planState: "active", currentPeriodEnd: IN_TEN_DAYS });
    expect(proAccessState(paid, NOW)).toBe("active");
  });

  it("is expired once a paid period has ended", () => {
    const lapsed = entitlement({ planState: "active", currentPeriodEnd: YESTERDAY });
    expect(proAccessState(lapsed, NOW)).toBe("expired");
  });

  it("treats a comped plan as active with no period at all", () => {
    expect(proAccessState(entitlement({ planState: "comped" }), NOW)).toBe("active");
  });

  it("is past due only while the grace window is open", () => {
    const inGrace = entitlement({ planState: "past_due", pastDueUntil: IN_TEN_DAYS });
    const lapsed = entitlement({ planState: "past_due", pastDueUntil: YESTERDAY });
    expect(proAccessState(inGrace, NOW)).toBe("pastDue");
    expect(proAccessState(lapsed, NOW)).toBe("expired");
  });

  it("reads every ended state as ended", () => {
    for (const planState of ["canceled", "refunded", "expired", "deleted", "revoked"] as const) {
      expect(proAccessState(entitlement({ planState }), NOW)).toBe("expired");
    }
  });
});

describe("proTrialDaysLeft", () => {
  it("counts a part day as a day, so the last day still reads as one", () => {
    const ends = new Date(NOW + 86_400_000 + 1_000).toISOString();
    expect(proTrialDaysLeft(entitlement({ trialEndsAt: ends }), NOW)).toBe(2);
    expect(proTrialDaysLeft(entitlement({ trialEndsAt: new Date(NOW + 1_000).toISOString() }), NOW))
      .toBe(1);
  });

  it("is null when there is no trial to count", () => {
    expect(proTrialDaysLeft(null, NOW)).toBeNull();
    expect(proTrialDaysLeft(entitlement({ trialEndsAt: null }), NOW)).toBeNull();
    expect(proTrialDaysLeft(entitlement({ trialEndsAt: YESTERDAY }), NOW)).toBeNull();
    expect(proTrialDaysLeft(entitlement({ trialEndsAt: "not a date" }), NOW)).toBeNull();
  });
});

describe("which controls a state offers", () => {
  it("offers checkout before and after access, never during", () => {
    expect(proCanUpgrade("none")).toBe(true);
    expect(proCanUpgrade("trial")).toBe(true);
    expect(proCanUpgrade("expired")).toBe(true);
    expect(proCanUpgrade("active")).toBe(false);
    expect(proCanUpgrade("pastDue")).toBe(false);
  });

  it("offers the billing portal only where a customer exists", () => {
    expect(proCanManageBilling("active")).toBe(true);
    expect(proCanManageBilling("pastDue")).toBe(true);
    expect(proCanManageBilling("trial")).toBe(false);
    expect(proCanManageBilling("none")).toBe(false);
    expect(proCanManageBilling("expired")).toBe(false);
  });
});

describe("proCheckoutOutcome", () => {
  it("reads the two outcomes Stripe returns with", () => {
    expect(proCheckoutOutcome("?checkout=success")).toBe("success");
    expect(proCheckoutOutcome("?checkout=cancel")).toBe("cancel");
  });

  it("ignores anything else", () => {
    expect(proCheckoutOutcome("?checkout=maybe")).toBeNull();
    expect(proCheckoutOutcome("?other=success")).toBeNull();
    expect(proCheckoutOutcome("")).toBeNull();
  });
});

describe("entitlementOf", () => {
  it("reads the entitlement function's own shape", () => {
    const parsed = entitlementOf({
      plan_state: "active",
      features: ["alerts", "history", "not_a_feature"],
      trial_ends_at: null,
      current_period_end: IN_TEN_DAYS,
      cancel_at_period_end: true,
      past_due_until: null,
      active_device_count: 3,
      device_cap: 5,
    });
    expect(parsed).toMatchObject({
      planState: "active",
      features: ["alerts", "history"],
      currentPeriodEnd: IN_TEN_DAYS,
      cancelAtPeriodEnd: true,
      activeDeviceCount: 3,
      deviceCap: 5,
    });
  });

  it("is null when there is no row or the state is not one the server publishes", () => {
    expect(entitlementOf(null)).toBeNull();
    expect(entitlementOf({ plan_state: "vip" })).toBeNull();
    expect(entitlementOf({})).toBeNull();
  });

  it("falls back to the contract's device cap rather than to zero", () => {
    expect(entitlementOf({ plan_state: "active" })?.deviceCap).toBe(5);
  });
});

describe("devicesOf", () => {
  it("keeps every row that names a device and drops the rest", () => {
    const devices = devicesOf([
      {
        device_id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
        label: "Studio desktop",
        created_at: YESTERDAY,
        last_seen_at: null,
        is_current: true,
        revoked: false,
      },
      { label: "no identifier" },
      null,
    ]);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      label: "Studio desktop",
      isCurrent: true,
      revoked: false,
      lastSeenAt: null,
    });
  });

  it("labels a row that has no label with its identifier rather than with nothing", () => {
    const devices = devicesOf([{ device_id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f" }]);
    expect(devices[0].label).toBe("8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f");
  });

  it("returns nothing for anything that is not a list", () => {
    expect(devicesOf(null)).toEqual([]);
    expect(devicesOf({})).toEqual([]);
  });
});

describe("authRedirectUrl", () => {
  it("returns the page, with no query and no fragment on it", () => {
    window.history.replaceState(null, "", "/pro?checkout=success#code=ABCD2345");
    expect(authRedirectUrl()).toBe(`${window.location.origin}/pro`);
  });

  it("does not carry a fragment somebody put in the link", () => {
    /* Cutting at the question mark used to leave this attached, which handed
       the identity provider an address a crafted link had chosen. */
    window.history.replaceState(null, "", "/pro#https://elsewhere.example");
    expect(authRedirectUrl()).toBe(`${window.location.origin}/pro`);
    expect(authRedirectUrl()).not.toContain("#");
    expect(authRedirectUrl()).not.toContain("elsewhere");
  });
});

describe("failureForStatus", () => {
  it("separates the reasons the portal draws differently", () => {
    expect(failureForStatus(401)).toBe("unauthenticated");
    expect(failureForStatus(409)).toBe("alreadySubscribed");
    expect(failureForStatus(429)).toBe("rateLimited");
    expect(failureForStatus(503)).toBe("unavailable");
    expect(failureForStatus(null)).toBe("unavailable");
  });
});
