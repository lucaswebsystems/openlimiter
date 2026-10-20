import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entitlementOf } from "@/lib/pro";
import {
  HUB_DEVICE_ID_KEY,
  browserDeviceId,
  isAllowedCheckoutUrl,
  locksPro,
  offersTrial,
  startProTrial,
  trialFailureForStatus,
} from "@/lib/pro-trial";

/**
 * The trial, decided without a network.
 *
 * One rule is held here and nothing else in this application holds it: a
 * trial has one door and it is `start_trial`. So the request shape is asserted
 * key by key. There is no first year offer to count down any more; a plan that
 * ends is offered the two locked prices.
 */

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const IN_THREE_DAYS = new Date(NOW + 3 * 86_400_000 + 4 * 3_600_000 + 7 * 60_000).toISOString();

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
  it("lets the server apply the recommended profile", async () => {
    const { client, invoke } = clientAnswering({
      data: { entitlement: { plan_state: "trialing", trial_ends_at: IN_THREE_DAYS } },
      error: null,
    });

    const result = await startProTrial(client);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe("pro-service");
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      body: {
        action: "start_trial",
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.value?.planState).toBe("trialing");
  });

  it("carries a push subscription with this browser's stable device id, only when the browser granted one", async () => {
    const withPush = clientAnswering({ data: { entitlement: null }, error: null });
    await startProTrial(withPush.client, {
      push: { endpoint: "https://push.example/1" },
    });
    const body = withPush.invoke.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    const preferences = body.body.preferences as { push: Record<string, unknown> };
    expect(preferences.push.endpoint).toBe("https://push.example/1");
    expect(preferences.push.device_id).toBe(browserDeviceId());

    const withoutPush = clientAnswering({ data: { entitlement: null }, error: null });
    await startProTrial(withoutPush.client);
    const plain = withoutPush.invoke.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    expect(plain.body).toEqual({ action: "start_trial" });
  });

  it("reads a 200 body carrying trial_already_used as the refusal it is, never a success", async () => {
    const { client } = clientAnswering({
      data: { error: "trial_already_used", entitlement: { plan_state: "trialing" } },
      error: null,
    });
    expect(await startProTrial(client)).toEqual({
      ok: false,
      reason: "alreadyUsed",
    });
  });

  it("reads a refused trial as already used rather than as a fault", async () => {
    const { client } = clientAnswering(refusal(409));
    expect(await startProTrial(client)).toEqual({
      ok: false,
      reason: "alreadyUsed",
    });
  });

  it("reads the kill switch as a state that will pass", async () => {
    const { client } = clientAnswering(refusal(503));
    expect(await startProTrial(client)).toEqual({
      ok: false,
      reason: "switchedOff",
    });
  });

  it("succeeds even when the answer carries no readable entitlement", async () => {
    const { client } = clientAnswering({ data: { entitlement: { nonsense: true } }, error: null });
    expect(await startProTrial(client)).toEqual({
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

describe("the checkout address", () => {
  it("accepts only https URLs on checkout.stripe.com", () => {
    expect(isAllowedCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_123")).toBe(true);
    expect(isAllowedCheckoutUrl("http://checkout.stripe.com/pay")).toBe(false);
    expect(isAllowedCheckoutUrl("https://attacker.example/session")).toBe(false);
    expect(isAllowedCheckoutUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedCheckoutUrl("")).toBe(false);
    expect(isAllowedCheckoutUrl(null)).toBe(false);
  });
});

describe("the entitlement the trial contract returns", () => {
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
