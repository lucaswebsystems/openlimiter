import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authStorageKey, KEEP_SIGNED_IN_KEY } from "@/lib/account-client";
import { createAccountSessionRuntime, type AccountSessionRuntime } from "@/lib/session-runtime";
import { requestPhoneRead } from "@/lib/phone-session";

const reads = vi.hoisted(() => ({ usage: vi.fn() }));
vi.mock("@/lib/pro", async (original) => ({
  ...await original<typeof import("@/lib/pro")>(),
  SUPABASE_URL: "https://revocation.test", SUPABASE_ANON_KEY: "synthetic-anon",
  readProAccount: vi.fn(async () => ({ ok: true, value: { entitlement: null } })),
}));
vi.mock("@/lib/synced-usage", () => ({
  readSyncedUsage: reads.usage,
  readSyncedApiSpend: vi.fn(async () => ({ ok: true, sources: [] })),
}));
vi.mock("@/lib/cloud-meter", () => ({ listCloudKeys: vi.fn(async () => ({ ok: true, value: [] })) }));

const drain = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
const session = (id: string) => ({
  access_token: `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }))}.synthetic`,
  refresh_token: `synthetic-refresh-${id}`, token_type: "bearer", expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id, aud: "authenticated", role: "authenticated", email: `${id}@example.invalid` },
});
let runtime: AccountSessionRuntime;
let client: SupabaseClient;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  reads.usage.mockResolvedValue({ ok: true, providers: [] });
});
afterEach(async () => {
  runtime?.stop();
  await client?.auth.stopAutoRefresh();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([true, false].flatMap((keep) => ["logout", "switch"].flatMap((action) =>
  ["success", "server failure", "network failure"].map((outcome) => ({ keep, action, outcome })),
)))("revokes once before erasing private storage: $action, $outcome, keep=$keep", async ({ keep, action, outcome }) => {
  const key = authStorageKey()!;
  const departing = session("departing");
  const next = session("next");
  const selected = keep ? localStorage : sessionStorage;
  localStorage.setItem(KEEP_SIGNED_IN_KEY, String(keep));
  for (const store of [localStorage, sessionStorage]) {
    store.setItem(key, JSON.stringify(departing));
    store.setItem(`${key}-code-verifier`, "synthetic-verifier");
    store.setItem("openlimiter-app-live", "[]");
    store.setItem("openlimiter-private-key", "synthetic-private-key");
  }
  let finishRevocation!: () => void;
  let finishPhone!: (response: Response) => void;
  let revocations = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/v1/logout")) {
      revocations += 1;
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${departing.access_token}`);
      expect(selected.getItem(key)).not.toBeNull();
      expect(selected.getItem("openlimiter-private-key")).toBe("synthetic-private-key");
      return new Promise<Response>((resolve, reject) => {
        finishRevocation = () => outcome === "network failure" ? reject(new TypeError("Synthetic offline"))
          : resolve(new Response(outcome === "success" ? null : '{"message":"Synthetic unavailable"}',
            { status: outcome === "success" ? 204 : 503 }));
      });
    }
    if (url.includes("/auth/v1/token")) return new Response(JSON.stringify(next));
    if (url === "/app/pair/api/read") return new Promise<Response>((resolve) => { finishPhone = resolve; });
    if (url === "/app/pair/api/session") return new Response("{}");
    throw new Error(`Unexpected synthetic request: ${url}`);
  }));
  // createAccountSessionRuntime constructs the installed, unmocked Supabase SDK.
  runtime = createAccountSessionRuntime();
  runtime.start();
  client = runtime.current().client!;
  await client.auth.getSession();
  await drain();
  expect(runtime.current().session?.user.id).toBe("departing");
  let finishRead!: (value: unknown) => void;
  reads.usage.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
    .mockImplementation(() => new Promise(() => {}));
  const pendingRead = runtime.refresh();
  const pendingPhone = requestPhoneRead();
  let logout: Promise<void> | undefined;
  if (action === "logout") logout = runtime.logout();
  else await client.auth.signInWithPassword({ email: "next@example.invalid", password: "synthetic-password" });
  await drain();
  expect(revocations).toBe(1);
  expect(runtime.current().syncedUsage).toBeNull();
  expect(runtime.current().live).toEqual([]);
  expect(runtime.current().session?.user.id ?? null).toBe(action === "logout" ? null : "next");
  finishPhone(new Response('{"body":{"privateQuota":42}}'));
  expect(await pendingPhone).toEqual({ kind: "unpaired" });
  // Wake events must not read the departing snapshots while revocation waits.
  const storedRead = vi.spyOn(Storage.prototype, "getItem");
  await runtime.refresh();
  expect(storedRead).not.toHaveBeenCalledWith("openlimiter-app-live");
  expect(runtime.current().syncedUsage).toBeNull();
  storedRead.mockRestore();
  finishRevocation();
  await logout;
  await drain();
  for (const store of [localStorage, sessionStorage]) {
    expect(store.getItem(key)).toBe(action === "switch" && store === selected ? JSON.stringify(next) : null);
    expect(store.getItem(`${key}-code-verifier`)).toBeNull();
    expect(store.getItem("openlimiter-app-live")).toBeNull();
    expect(store.getItem("openlimiter-private-key")).toBeNull();
  }
  finishRead({ ok: true, providers: [{ secret: "departing quota" }] });
  await pendingRead;
  expect(runtime.current().syncedUsage).toBeNull();
  expect((await client.auth.getSession()).data.session?.user.id ?? null).toBe(action === "logout" ? null : "next");
  expect(revocations).toBe(1);
});
