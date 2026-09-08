import { describe, expect, it } from "vitest";
import {
  CODE_CONSUMED_SENTENCE,
  REVOKED_SENTENCE,
  ensureFreshSession,
  isAborted,
  runDeviceLogin
} from "../src/hub-auth.js";
import type { HubReply, HubRequest, HubTransport } from "../src/hub.js";
import { RENEWAL_WINDOW_MILLISECONDS, type HubSession } from "../src/session.js";

const CONFIGURED = { OPENLIMITER_SUPABASE_ANON_KEY: "sb_publishable_test_key" };

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [encode({ alg: "none" }), encode(claims), "signature"].join(".");
}

const START_BODY = JSON.stringify({
  user_code: "ABCD-1234",
  device_code: "device-code-0001",
  verification_url: "https://openlimiter.com/device",
  interval: 1,
  expires_in: 30
});

function approvedBody(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    status: "approved",
    token: jwt({ email: "person@example.com" }),
    expires_at: "2026-09-07T14:00:00.000Z",
    refresh_credential: "r".repeat(32),
    refresh_expires_at: "2026-10-07T12:00:00.000Z",
    device_id: "device-1234",
    ...overrides
  });
}

function scriptedTransport(script: readonly HubReply[]): { transport: HubTransport; sent: HubRequest[] } {
  const sent: HubRequest[] = [];
  let index = 0;
  return {
    sent,
    transport: async (request) => {
      sent.push(request);
      const reply = script[Math.min(index, script.length - 1)];
      index += 1;
      if (reply === undefined) throw new Error("no scripted reply");
      return reply;
    }
  };
}

function noSleep(): (milliseconds: number) => Promise<void> {
  return async () => undefined;
}

describe("runDeviceLogin", () => {
  it("signs in on the happy path: start, one pending poll, then approved", async () => {
    const { transport, sent } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: JSON.stringify({ status: "pending" }) },
      { status: 200, body: approvedBody() }
    ]);
    const emitted: string[] = [];
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: (line) => emitted.push(line),
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("signed_in");
    if (outcome.kind === "signed_in") {
      expect(outcome.session.accountLabel).toBe("person@example.com");
      expect(outcome.session.deviceId).toBe("device-1234");
      expect(outcome.session.refreshCredential).toBe("r".repeat(32));
    }
    expect(emitted).toContain("Enter this code: ABCD-1234");
    expect(emitted).toContain("At: https://openlimiter.com/device");
    expect(sent).toHaveLength(3);
    expect(sent[0]?.endpoint).toBe("cli_login");
  });

  it("opens the browser only when --open was passed", async () => {
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: approvedBody() }
    ]);
    let opened: string | null = null;
    await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: (url) => {
        opened = url;
      },
      open: true
    });
    expect(opened).toBe("https://openlimiter.com/device");
  });

  it("widens the interval on slow_down rather than failing", async () => {
    const { transport, sent } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: JSON.stringify({ status: "slow_down" }) },
      { status: 200, body: approvedBody() }
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("signed_in");
    expect(sent).toHaveLength(3);
  });

  it("ends as denied when the hub says denied", async () => {
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: JSON.stringify({ status: "denied" }) }
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("denied");
  });

  it("ends as expired when the hub says expired", async () => {
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: JSON.stringify({ status: "expired" }) }
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("expired");
  });

  it("ends as expired with the consumed sentence when the hub says the code was already used, and never keeps polling", async () => {
    const { transport, sent } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: JSON.stringify({ status: "consumed" }) }
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("expired");
    if (outcome.kind === "expired") {
      expect(outcome.message).toBe(CODE_CONSUMED_SENTENCE);
    }
    expect(sent).toHaveLength(2);
  });

  it("gives up once the safety ceiling on polls is reached, never spinning forever", async () => {
    const foreverPending: HubReply = { status: 200, body: JSON.stringify({ status: "pending" }) };
    const { transport, sent } = scriptedTransport([
      { status: 200, body: JSON.stringify({ ...JSON.parse(START_BODY), expires_in: 3, interval: 1 }) },
      foreverPending,
      foreverPending,
      foreverPending,
      foreverPending,
      foreverPending,
      foreverPending,
      foreverPending,
      foreverPending,
      foreverPending,
      foreverPending
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("expired");
    /* expires_in 3 over an interval of 1 second is 3 attempts, plus the fixed
       safety margin, and never the full ten pending replies scripted above. */
    expect(sent.length).toBeLessThan(11);
  });

  it("cancels on Ctrl C without ever writing a session", async () => {
    const controller = new AbortController();
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 200, body: JSON.stringify({ status: "pending" }) }
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: async () => {
        controller.abort();
      },
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false,
      interruptSignal: controller.signal
    });
    expect(outcome.kind).toBe("cancelled");
  });

  it("reports not configured when the hub is switched off", async () => {
    const outcome = await runDeviceLogin({
      environment: { OPENLIMITER_SUPABASE_ANON_KEY: "off" },
      transport: async () => ({ status: 200, body: "" }),
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("not_configured");
  });

  it("survives one lost poll and tries again next interval", async () => {
    let attempts = 0;
    const transport: HubTransport = async (request) => {
      if (request.endpoint === "cli_login") {
        const parsed = JSON.parse(request.body) as { action: string };
        if (parsed.action === "start") return { status: 200, body: START_BODY };
        attempts += 1;
        if (attempts === 1) throw new Error("network blip");
        return { status: 200, body: approvedBody() };
      }
      throw new Error("unexpected endpoint");
    };
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("signed_in");
    expect(attempts).toBe(2);
  });

  it.each([400, 408])("fails immediately on terminal poll status %i", async (status) => {
    const { transport, sent } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status, body: "" }
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome).toEqual({
      kind: "error",
      message: "the hub returned status " + status + " while checking sign in"
    });
    expect(sent).toHaveLength(2);
  });

  it("backs off on rate limiting and service unavailability, honoring Retry After", async () => {
    const sleeps: number[] = [];
    const { transport } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 429, body: "", retryAfterSeconds: 7 },
      { status: 503, body: "" },
      { status: 200, body: approvedBody() }
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome.kind).toBe("signed_in");
    expect(sleeps).toEqual([1_000, 7_000, 14_000]);
  });

  it("fails after three retries for another server error", async () => {
    const { transport, sent } = scriptedTransport([
      { status: 200, body: START_BODY },
      { status: 500, body: "" },
      { status: 500, body: "" },
      { status: 500, body: "" },
      { status: 500, body: "" }
    ]);
    const outcome = await runDeviceLogin({
      environment: CONFIGURED,
      transport,
      sleep: noSleep(),
      emit: () => undefined,
      openBrowser: () => undefined,
      open: false
    });
    expect(outcome).toEqual({
      kind: "error",
      message: "the hub returned status 500 while checking sign in"
    });
    expect(sent).toHaveLength(5);
  });
});

describe("isAborted", () => {
  it("is false with no signal and true once aborted", () => {
    expect(isAborted(undefined)).toBe(false);
    const controller = new AbortController();
    expect(isAborted(controller.signal)).toBe(false);
    controller.abort();
    expect(isAborted(controller.signal)).toBe(true);
  });
});

function baseSession(overrides: Partial<HubSession> = {}): HubSession {
  return {
    version: 1,
    token: "t".repeat(32),
    expiresAt: "2026-09-07T13:00:00.000Z",
    refreshCredential: "r".repeat(32),
    refreshExpiresAt: "2026-10-07T12:00:00.000Z",
    deviceId: "device-1234",
    accountLabel: "person@example.com",
    ...overrides
  };
}

describe("ensureFreshSession", () => {
  it("uses the session as it stands when well inside the renewal window", async () => {
    const value = baseSession();
    const outcome = await ensureFreshSession(
      value,
      "2026-09-07T10:00:00.000Z",
      CONFIGURED,
      async () => {
        throw new Error("must not renew");
      }
    );
    expect(outcome).toEqual({ kind: "fresh", session: value });
  });

  it("renews and rotates the credential exactly at the boundary", async () => {
    const value = baseSession();
    const boundary = new Date(
      Date.parse(value.expiresAt) - RENEWAL_WINDOW_MILLISECONDS
    ).toISOString();
    const outcome = await ensureFreshSession(value, boundary, CONFIGURED, async () => ({
      status: 200,
      body: JSON.stringify({
        token: "new-token".repeat(4),
        expires_at: "2026-09-08T13:00:00.000Z",
        refresh_credential: "new-refresh".repeat(3),
        refresh_expires_at: "2026-11-07T12:00:00.000Z"
      })
    }));
    expect(outcome.kind).toBe("renewed");
    if (outcome.kind === "renewed") {
      expect(outcome.session.token).toBe("new-token".repeat(4));
      expect(outcome.session.refreshCredential).toBe("new-refresh".repeat(3));
      expect(outcome.session.deviceId).toBe(value.deviceId);
    }
  });

  it("clears the way for a fresh sign in on a 401, and never on an ordinary failure", async () => {
    const expired = baseSession({ expiresAt: "2020-01-01T00:00:00.000Z" });
    const revoked = await ensureFreshSession(expired, "2026-09-07T10:00:00.000Z", CONFIGURED, async () => ({
      status: 401,
      body: ""
    }));
    expect(revoked.kind).toBe("revoked");

    const networkFailure = await ensureFreshSession(
      expired,
      "2026-09-07T10:00:00.000Z",
      CONFIGURED,
      async () => ({ status: 500, body: "" })
    );
    expect(networkFailure.kind).toBe("error");

    const unreachable = await ensureFreshSession(
      expired,
      "2026-09-07T10:00:00.000Z",
      CONFIGURED,
      async () => {
        throw new Error("offline");
      }
    );
    expect(unreachable.kind).toBe("error");
  });

  it("names the exact sentence a revoked session prints", () => {
    expect(REVOKED_SENTENCE).toBe("Signed out on the hub, run openlimiter login");
  });
});
