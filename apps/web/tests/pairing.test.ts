import { describe, expect, it } from "vitest";
import {
  initialPairState,
  PAIRING_POLL_MAX_MILLISECONDS,
  PAIRING_POLL_MILLISECONDS,
  PAIRING_TTL_SECONDS,
  pairCodeFromFragment,
  pairDeviceMeta,
  pairShouldPoll,
  pairStateAfterClaim,
  pairStateAfterPoll,
  pairStateAfterTimeout,
  pairUserAgentHash,
  type PairState,
} from "@/lib/pairing";

/**
 * The pairing state machine, driven without a network.
 *
 * Every case below is one the phone actually meets: a link with no code, a
 * code already spent, a desktop that says no, a claim that runs out, a
 * delivery that arrives, and a delivery that arrives malformed. The last one
 * matters most: a response that says approved but carries no usable token must
 * not leave a reader on a screen that says they are paired.
 */

const CODE = "ABCD2345";

function waiting(overrides: Partial<PairState> = {}): PairState {
  return {
    phase: "waiting",
    code: CODE,
    claimId: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    expiresAt: null,
    pollInterval: PAIRING_POLL_MILLISECONDS,
    session: null,
    phonePair: null,
    ...overrides,
  };
}

const DELIVERY = {
  status: "approved",
  device_token: "signed.phone.token",
  refresh: {
    after: 1_800,
    expires_at: 3_600,
    grace_until: 7_200,
    action: "refresh",
    endpoint: "entitlement",
  },
  entitlement_summary: { plan_state: "active", features: ["history"], interval: "monthly" },
};

describe("pairCodeFromFragment", () => {
  it("reads a code out of the fragment with or without the hash", () => {
    expect(pairCodeFromFragment(`#code=${CODE}`)).toBe(CODE);
    expect(pairCodeFromFragment(`code=${CODE}`)).toBe(CODE);
  });

  it("uppercases what a keyboard typed", () => {
    expect(pairCodeFromFragment("#code=abcd2345")).toBe(CODE);
  });

  it("refuses anything that is not eight characters of the server alphabet", () => {
    expect(pairCodeFromFragment("#code=ABCD234")).toBeNull();
    expect(pairCodeFromFragment("#code=ABCD23450")).toBeNull();
    /* The alphabet has no zero, no O, no one and no I, on purpose. */
    expect(pairCodeFromFragment("#code=ABCD2340")).toBeNull();
    expect(pairCodeFromFragment("#code=ABCDI345")).toBeNull();
    expect(pairCodeFromFragment("#other=ABCD2345")).toBeNull();
    expect(pairCodeFromFragment("")).toBeNull();
  });
});

describe("initialPairState", () => {
  it("opens on claiming when the fragment carries a code", () => {
    expect(initialPairState(`#code=${CODE}`)).toMatchObject({ phase: "claiming", code: CODE });
  });

  it("opens on noCode when it does not", () => {
    expect(initialPairState("")).toMatchObject({ phase: "noCode", code: null });
  });
});

describe("pairStateAfterClaim", () => {
  const claiming = initialPairState(`#code=${CODE}`);

  it("moves to waiting and keeps the claim and the expiry", () => {
    const next = pairStateAfterClaim(
      claiming,
      { claim_id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", expires_at: 1_800 },
      200,
    );
    expect(next.phase).toBe("waiting");
    expect(next.claimId).toBe("8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f");
    expect(next.expiresAt).toBe(1_800);
    expect(next.code).toBe(CODE);
  });

  it("accepts an expiry stated as an instant", () => {
    const next = pairStateAfterClaim(
      claiming,
      {
        claim_id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
        expires_at: "2026-09-04T12:02:00.000Z",
      },
      200,
    );
    expect(next.expiresAt).toBe(Math.floor(Date.parse("2026-09-04T12:02:00.000Z") / 1_000));
  });

  it("treats a spent or unknown code as expired rather than as an error", () => {
    expect(pairStateAfterClaim(claiming, { error: "conflict" }, 409).phase).toBe("expired");
    expect(pairStateAfterClaim(claiming, { error: "gone" }, 404).phase).toBe("expired");
  });

  it("treats a rate limit and a dead service as an error", () => {
    expect(pairStateAfterClaim(claiming, { error: "rate_limited" }, 429).phase).toBe("error");
    expect(pairStateAfterClaim(claiming, null, 0).phase).toBe("error");
  });

  it("refuses a 200 that carries no usable claim", () => {
    expect(pairStateAfterClaim(claiming, { claim_id: "not-a-uuid" }, 200).phase).toBe("error");
    expect(pairStateAfterClaim(claiming, {}, 200).phase).toBe("error");
  });
});

describe("pairStateAfterPoll", () => {
  it("keeps waiting while nobody has pressed anything", () => {
    const current = waiting();
    expect(pairStateAfterPoll(current, { status: "pending" }, 200)).toBe(current);
    expect(pairStateAfterPoll(current, { status: "claimed" }, 200)).toBe(current);
  });

  it("answers a rate limit by backing off rather than by failing", () => {
    const current = waiting({ expiresAt: 1_800 });
    const next = pairStateAfterPoll(current, { error: "rate_limited" }, 429);
    expect(next.phase).toBe("waiting");
    /* A NEW object, or the timer that was refused keeps its old interval. */
    expect(next).not.toBe(current);
    expect(next.pollInterval).toBe(PAIRING_POLL_MILLISECONDS * 2);
    expect(next.expiresAt).toBe(1_800);
    expect(next.claimId).toBe(current.claimId);
  });

  it("doubles the gap on every refusal and stops at the ceiling", () => {
    let current = waiting();
    const gaps: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      current = pairStateAfterPoll(current, { error: "rate_limited" }, 429);
      gaps.push(current.pollInterval);
    }
    expect(gaps).toEqual([4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(PAIRING_POLL_MAX_MILLISECONDS).toBe(15_000);
  });

  it("leaves the interval alone while a poll is merely waiting", () => {
    const current = waiting();
    expect(pairStateAfterPoll(current, { status: "pending" }, 200).pollInterval).toBe(
      PAIRING_POLL_MILLISECONDS,
    );
  });

  it("reads a denial and an expiry", () => {
    expect(pairStateAfterPoll(waiting(), { status: "denied" }, 200).phase).toBe("denied");
    expect(pairStateAfterPoll(waiting(), { status: "expired" }, 200).phase).toBe("expired");
  });

  it("treats an already delivered claim as expired, because pairing again is the fix", () => {
    expect(pairStateAfterPoll(waiting(), { status: "delivered" }, 200).phase).toBe("expired");
  });

  it("stores the session on the one delivery", () => {
    const next = pairStateAfterPoll(waiting(), DELIVERY, 200);
    expect(next.phase).toBe("approved");
    expect(next.session).toMatchObject({
      token: "signed.phone.token",
      refreshAfter: 1_800,
      expiresAt: 3_600,
      graceUntil: 7_200,
      planState: "active",
      interval: "monthly",
    });
  });

  it("refuses an approval with no token in it", () => {
    const next = pairStateAfterPoll(waiting(), { ...DELIVERY, device_token: "" }, 200);
    expect(next.phase).toBe("error");
    expect(next.session).toBeNull();
  });

  it("refuses an approval with no refresh material", () => {
    const next = pairStateAfterPoll(waiting(), { status: "approved", device_token: "x" }, 200);
    expect(next.phase).toBe("error");
  });

  it("calls an unknown status an error rather than guessing", () => {
    expect(pairStateAfterPoll(waiting(), { status: "something" }, 200).phase).toBe("error");
  });
});

describe("pairShouldPoll", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");

  it("polls while the claim is still inside its window", () => {
    expect(pairShouldPoll(waiting({ expiresAt: now / 1_000 + 30 }), now)).toBe(true);
  });

  it("polls when the server named no expiry", () => {
    expect(pairShouldPoll(waiting(), now)).toBe(true);
  });

  it("stops once the window has passed", () => {
    expect(pairShouldPoll(waiting({ expiresAt: now / 1_000 - 1 }), now)).toBe(false);
  });

  it("never polls outside the waiting phase", () => {
    expect(pairShouldPoll(waiting({ phase: "denied" }), now)).toBe(false);
    expect(pairShouldPoll(waiting({ claimId: null }), now)).toBe(false);
  });

  it("expires a claim that ran out of time", () => {
    expect(pairStateAfterTimeout(waiting()).phase).toBe("expired");
    const denied = waiting({ phase: "denied" });
    expect(pairStateAfterTimeout(denied)).toBe(denied);
  });

  it("keeps the window the contract states", () => {
    expect(PAIRING_TTL_SECONDS).toBe(120);
  });
});

describe("pairDeviceMeta", () => {
  it("builds a name a person will recognise on the desktop", () => {
    expect(pairDeviceMeta({ platform: "Android", brand: "Chrome", mobile: true })).toEqual({
      name: "Chrome on Android",
      platform: "Android",
    });
  });

  it("falls back to the platform and the kind when no brand is offered", () => {
    expect(pairDeviceMeta({ platform: "iOS", mobile: true })).toEqual({
      name: "iOS phone",
      platform: "iOS",
    });
    expect(pairDeviceMeta({ platform: "macOS" })).toEqual({
      name: "macOS browser",
      platform: "macOS",
    });
  });

  it("never sends an empty name or a control character", () => {
    const meta = pairDeviceMeta({ platform: "", brand: "\u0000\u0007" });
    expect(meta.name).toBe("Web browser");
    expect(meta.platform).toBe("Web");
  });

  it("stays inside the lengths the server accepts", () => {
    const meta = pairDeviceMeta({ platform: "P".repeat(80), brand: "B".repeat(200) });
    expect(meta.platform.length).toBeLessThanOrEqual(40);
    expect([...meta.name].length).toBeLessThanOrEqual(80);
  });
});

describe("pairUserAgentHash", () => {
  it("produces the lowercase hex digest the server pattern requires", async () => {
    const hash = await pairUserAgentHash("Mozilla/5.0");
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await pairUserAgentHash("Mozilla/5.0")).toBe(hash);
    expect(await pairUserAgentHash("Mozilla/5.1")).not.toBe(hash);
  });
});
