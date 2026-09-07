import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entitlementOf } from "@/lib/pro";
import {
  HUB_DEVICE_ID_KEY,
  TRIAL_ALERT_THRESHOLDS,
  TRIAL_END_OFFER,
  browserDeviceId,
  isAllowedCheckoutUrl,
  locksPro,
  offerCountdown,
  offerOpen,
  offersTrial,
  startOfferCheckout,
  startProTrial,
  trialFailureForStatus,
} from "@/lib/pro-trial";

/**
 * The trial and the offer, decided without a network.
 *
 * Two rules are held here and nothing else in this application holds them: a
 * trial has one door and it is `start_trial`, and the offer's clock is the
 * server's `offer_ends_at` rather than anything the browser worked out. So the
 * request shape is asserted key by key, and the countdown is asserted against
 * a fixed instant rather than against the machine's own time.
 */

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const IN_THREE_DAYS = new Date(NOW + 3 * 86_400_000 + 4 * 3_600_000 + 7 * 60_000).toISOString();
const YESTERDAY = new Date(NOW - 86_400_000).toISOString();

/** A client whose one function call answers whatever the test decided. */
function clientAnswering(answer: unknown): {
  client: SupabaseClient;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async () => answer);
  return {
    client: { functions: { invoke } } as unknown as SupabaseClient,
    invoke,
  };
}

function refusal(status: number): unknown {
  return { data: null, error: { context: { status } } };
}

afterEach(() => {
  window.localStorage.clear();
});

describe("the countdown", () => {
  it("breaks the remaining time into days, hours and minutes", () => {
    expect(offerCountdown(IN_THREE_DAYS, NOW)).toMatchObject({ days: 3, hours: 4, minutes: 7 });
  });

  it("is null with no date, an unreadable date, or a date that has passed", () => {
    expect(offerCountdown(null, NOW)).toBeNull();
    expect(offerCountdown("not a date", NOW)).toBeNull();
    expect(offerCountdown(YESTERDAY, NOW)).toBeNull();
  });

  it("closes exactly on the instant, never a minute after it", () => {
    const ends = new Date(NOW + 1000).toISOString();
    expect(offerOpen(ends, NOW)).toBe(true);
    expect(offerOpen(ends, NOW + 1000)).toBe(false);
  });
});

describe("which surfaces a plan draws", () => {
  it("offers a trial only to an account that has no plan at all", () => {
    expect(offersTrial("none")).toBe(true);
    for (const state of ["trial", "active", "pastDue", "expired"]) {
      expect(offersTrial(state)).toBe(false);
    }
  });

  it("locks Pro only once a plan has ended", () => {
    expect(locksPro("expired")).toBe(true);
    for (const state of ["none", "trial", "active", "pastDue"]) {
      expect(locksPro(state)).toBe(false);
    }
  });
});

describe("what a status code means on the trial path", () => {
  it("separates the refusal, the limit and the kill switch", () => {
    expect(trialFailureForStatus(401)).toBe("unauthenticated");
    expect(trialFailureForStatus(409)).toBe("alreadyUsed");
    expect(trialFailureForStatus(429)).toBe("rateLimited");
    expect(trialFailureForStatus(503)).toBe("switchedOff");
    expect(trialFailureForStatus(500)).toBe("unavailable");
    expect(trialFailureForStatus(null)).toBe("unavailable");
  });
});

describe("starting the trial", () => {
  it("sends one call carrying the staged thresholds, sorted, with the reset", async () => {
    const { client, invoke } = clientAnswering({
      data: { entitlement: { plan_state: "trialing", trial_ends_at: IN_THREE_DAYS } },
      error: null,
    });

    const result = await startProTrial(client, {
      alerts: { thresholds: [90, 60], reset: true },
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe("pro-service");
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      body: {
        action: "start_trial",
        preferences: { alerts: { thresholds: [60, 90], reset: true } },
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.value?.planState).toBe("trialing");
  });

  it("carries a push subscription with this browser's stable device id, only when the browser granted one", async () => {
    const withPush = clientAnswering({ data: { entitlement: null }, error: null });
    await startProTrial(withPush.client, {
      alerts: { thresholds: [...TRIAL_ALERT_THRESHOLDS], reset: false },
      push: { endpoint: "https://push.example/1" },
    });
    const body = withPush.invoke.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    const preferences = body.body.preferences as { alerts: unknown; push: Record<string, unknown> };
    expect(preferences.alerts).toEqual({ thresholds: [60, 80, 90], reset: false });
    expect(preferences.push.endpoint).toBe("https://push.example/1");
    expect(preferences.push.device_id).toBe(browserDeviceId());

    const withoutPush = clientAnswering({ data: { entitlement: null }, error: null });
    await startProTrial(withoutPush.client, { alerts: { thresholds: [60], reset: false } });
    const plain = withoutPush.invoke.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    expect(Object.keys(plain.body.preferences as object)).toEqual(["alerts"]);
  });

  it("reads a 200 body carrying trial_already_used as the refusal it is, never a success", async () => {
    const { client } = clientAnswering({
      data: { error: "trial_already_used", entitlement: { plan_state: "trialing" } },
      error: null,
    });
    expect(await startProTrial(client, { alerts: { thresholds: [60], reset: true } })).toEqual({
      ok: false,
      reason: "alreadyUsed",
    });
  });

  it("reads a refused trial as already used rather than as a fault", async () => {
    const { client } = clientAnswering(refusal(409));
    expect(await startProTrial(client, { alerts: { thresholds: [60], reset: true } })).toEqual({
      ok: false,
      reason: "alreadyUsed",
    });
  });

  it("reads the kill switch as a state that will pass", async () => {
    const { client } = clientAnswering(refusal(503));
    expect(await startProTrial(client, { alerts: { thresholds: [60], reset: true } })).toEqual({
      ok: false,
      reason: "switchedOff",
    });
  });

  it("succeeds even when the answer carries no readable entitlement", async () => {
    const { client } = clientAnswering({ data: { entitlement: { nonsense: true } }, error: null });
    expect(await startProTrial(client, { alerts: { thresholds: [], reset: false } })).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("this browser's stable device id", () => {
  it("generates one once and reads the same value back on every later call", () => {
    window.localStorage.clear();
    const first = browserDeviceId();
    expect(first.length).toBeGreaterThan(0);
    expect(browserDeviceId()).toBe(first);
    expect(window.localStorage.getItem(HUB_DEVICE_ID_KEY)).toBe(first);
  });

  it("makes a fresh id once local storage no longer carries one", () => {
    window.localStorage.clear();
    const first = browserDeviceId();
    window.localStorage.clear();
    const second = browserDeviceId();
    expect(second).not.toBe(first);
  });
});

describe("the discounted year", () => {
  it("asks for the year interval and names the offer", async () => {
    const { client, invoke } = clientAnswering({
      data: { url: "https://checkout.stripe.com/session" },
      error: null,
    });
    const result = await startOfferCheckout(client);
    expect(invoke.mock.calls[0]?.[0]).toBe("create-checkout");
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      body: { interval: "year", offer: TRIAL_END_OFFER },
    });
    expect(result).toEqual({ ok: true, value: "https://checkout.stripe.com/session" });
  });

  it("has no url to follow when the window is closed", async () => {
    const { client } = clientAnswering(refusal(409));
    expect(await startOfferCheckout(client)).toEqual({ ok: false, reason: "alreadyUsed" });
  });

  it("says the switch is off rather than blaming the service", async () => {
    const { client } = clientAnswering(refusal(503));
    expect(await startOfferCheckout(client)).toEqual({ ok: false, reason: "switchedOff" });
  });

  it("refuses an answer with no address in it", async () => {
    const { client } = clientAnswering({ data: { url: "" }, error: null });
    expect(await startOfferCheckout(client)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("accepts only https URLs on checkout.stripe.com", async () => {
    expect(isAllowedCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_123")).toBe(true);
    expect(isAllowedCheckoutUrl("http://checkout.stripe.com/pay")).toBe(false);
    expect(isAllowedCheckoutUrl("https://attacker.example/session")).toBe(false);
    expect(isAllowedCheckoutUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedCheckoutUrl("")).toBe(false);
    expect(isAllowedCheckoutUrl(null)).toBe(false);

    const { client } = clientAnswering({
      data: { url: "javascript:alert(1)" },
      error: null,
    });
    expect(await startOfferCheckout(client)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the entitlement the trial contract returns", () => {
  it("reads the offer window the server put on it", () => {
    const parsed = entitlementOf({
      plan_state: "expired",
      trial_ends_at: YESTERDAY,
      offer_ends_at: IN_THREE_DAYS,
    });
    expect(parsed?.offerEndsAt).toBe(IN_THREE_DAYS);
  });

  it("reads the contract's own spelling of the plan", () => {
    expect(entitlementOf({ status: "trialing", trial_ends_at: IN_THREE_DAYS })?.planState).toBe(
      "trialing",
    );
    expect(entitlementOf({ status: "expired" })?.planState).toBe("expired");
  });

  it("treats a status of none as no row at all, which is what it is", () => {
    expect(entitlementOf({ status: "none" })).toBeNull();
  });
});
