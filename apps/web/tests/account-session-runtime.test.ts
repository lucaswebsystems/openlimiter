import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAccountSessionRuntime, type AccountSessionRuntime } from "@/lib/session-runtime";

const fixture = vi.hoisted(() => ({
  create: vi.fn(), usage: vi.fn(), spend: vi.fn(), cloud: vi.fn(), plan: vi.fn(),
  move: vi.fn(), stop: vi.fn(), resume: vi.fn(),
}));
vi.mock("@/lib/account-client", async (original) => ({
  ...await original<typeof import("@/lib/account-client")>(),
  createAccountClient: fixture.create, applyKeepSignedIn: fixture.move,
  stopAccountClient: fixture.stop, resumeAccountClient: fixture.resume,
}));
vi.mock("@/lib/synced-usage", () => ({ readSyncedUsage: fixture.usage, readSyncedApiSpend: fixture.spend }));
vi.mock("@/lib/cloud-meter", () => ({ listCloudKeys: fixture.cloud }));
vi.mock("@/lib/pro", async (original) => ({ ...await original<typeof import("@/lib/pro")>(), readProAccount: fixture.plan }));

const account = (id: string) => ({ user: { id } }) as Session;
const drain = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
let runtime: AccountSessionRuntime;
let auth: (event: AuthChangeEvent, session: Session | null) => void;
let initial: Session | null;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  initial = account("first");
  fixture.create.mockImplementation(() => ({ auth: {
    getSession: async () => ({ data: { session: initial } }),
    onAuthStateChange: (listener: typeof auth) => { auth = listener; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
    signOut: async () => ({ error: null }),
  } }) as unknown as SupabaseClient);
  fixture.usage.mockResolvedValue({ ok: true, providers: [] });
  fixture.spend.mockResolvedValue({ ok: true, sources: [] });
  fixture.cloud.mockResolvedValue({ ok: true, value: [] });
  fixture.plan.mockResolvedValue({ ok: true, value: { entitlement: null } });
  fixture.stop.mockResolvedValue(undefined);
  fixture.resume.mockResolvedValue(undefined);
  fixture.move.mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  runtime = createAccountSessionRuntime();
});
afterEach(() => { runtime.stop(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("coalesces account reads and rejects every old result synchronously on account switch", async () => {
  let finish!: (result: unknown) => void;
  fixture.usage.mockResolvedValueOnce({ ok: false, reason: "signed_out" })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  runtime.start();
  await drain();
  const pending = runtime.refresh();
  expect(runtime.refresh()).toBe(pending);
  expect(fixture.usage).toHaveBeenCalledTimes(2);
  auth("SIGNED_IN", account("second"));
  expect(runtime.current().syncedUsage).toBeNull();
  finish({ ok: true, providers: [{ secret: "first account" }] });
  await pending;
  await drain();
  expect(runtime.current().session?.user.id).toBe("second");
  expect(runtime.current().syncedUsage).toEqual({ ok: true, providers: [] });
});

it("logout clears published results before the network answers and ignores old discovery", async () => {
  let discover!: (value: unknown) => void;
  fixture.create.mockImplementationOnce(() => ({ auth: {
    getSession: () => new Promise((resolve) => { discover = resolve; }),
    onAuthStateChange: (listener: typeof auth) => { auth = listener; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
    signOut: async () => ({ error: null }),
  } }) as unknown as SupabaseClient);
  runtime.start();
  await runtime.logout();
  discover({ data: { session: account("first") } });
  await drain();
  expect(runtime.current().session).toBeNull();
  expect(runtime.current().syncedUsage).toBeNull();
  auth("TOKEN_REFRESHED", account("first"));
  expect(runtime.current().session).toBeNull();
  auth("SIGNED_IN", account("second"));
  expect(runtime.current().session?.user.id).toBe("second");
});

it("serializes storage handovers and does not replace a client after stop", async () => {
  let stopped!: () => void;
  runtime.start();
  await drain();
  fixture.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { stopped = resolve; }));
  const pending = runtime.changeKeepSignedIn(false);
  expect(runtime.changeKeepSignedIn(false)).toBe(pending);
  runtime.stop();
  stopped();
  expect(await pending).toBe(false);
  expect(fixture.move).not.toHaveBeenCalled();
  expect(fixture.create).toHaveBeenCalledTimes(1);
});

it("invalidates quota reads when sync is disabled", async () => {
  let finish!: (result: unknown) => void;
  fixture.usage.mockResolvedValueOnce({ ok: false, reason: "signed_out" })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  runtime.start();
  await drain();
  runtime.setSyncEnabled(false);
  finish({ ok: true, providers: [{ secret: "old" }] });
  await drain();
  expect(runtime.current().syncedUsage).toEqual({ ok: false, reason: "signed_out" });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fixture.usage).toHaveBeenCalledTimes(2);
});

it("rejects a previous account entitlement even when its response arrives last", async () => {
  let finish!: (result: unknown) => void;
  runtime.start();
  await drain();
  fixture.plan.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = runtime.refreshEntitlement();
  auth("SIGNED_IN", account("second"));
  await runtime.refreshEntitlement();
  finish({ ok: true, value: { entitlement: { plan_state: "active" } } });
  await pending;
  expect(runtime.current().entitlement).toBeNull();
});

it("keeps the new account refreshing if it changes during storage handover", async () => {
  let stopped!: () => void;
  runtime.start();
  await drain();
  fixture.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { stopped = resolve; }));
  const pending = runtime.changeKeepSignedIn(false);
  auth("SIGNED_IN", account("second"));
  stopped();
  expect(await pending).toBe(false);
  expect(fixture.resume).toHaveBeenCalledTimes(1);
  expect(runtime.current().session?.user.id).toBe("second");
  expect(fixture.move).not.toHaveBeenCalled();
});
