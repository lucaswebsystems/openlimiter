import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneSessionRuntime, createSessionRuntime, observeAccountSession } from "@/lib/session-runtime";
import { accountReturnDestination, authStorageKey, clearPrivateSessionState, createAccountClient } from "@/lib/account-client";
import { endPhoneSession, establishPhoneSession, PHONE_LAST_BARS_KEY, PHONE_PAIRING_GENERATION_KEY, PHONE_PAIR_META_KEY, PHONE_REFRESH_COOKIE, PHONE_TOKEN_COOKIE, readCurrentPhoneBars, readPhonePairMeta, requestPhoneRead, requestPhoneRenewal, writePhonePairMeta } from "@/lib/phone-session";
import { POST as renewPost } from "@/app/app/pair/api/renew/route";
import { POST as readPost } from "@/app/app/pair/api/read/route";

vi.mock("@/lib/pro", async (original) => ({
  ...await original<typeof import("@/lib/pro")>(),
  SUPABASE_URL: "https://persistence.test",
  SUPABASE_ANON_KEY: "test-anon",
}));

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const active: Array<{ stop(): void }> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  active.splice(0).forEach((runtime) => runtime.stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const drain = async () => { for (let n = 0; n < 30; n += 1) await Promise.resolve(); };

describe("the shared visible session lifecycle", () => {
  it.each(["logout", "account switch", "new pairing"])("invalidates the recovery read during %s", async (action) => {
    writePhonePairMeta({ label: "Phone", expiresAt: NOW / 1000 + 86_400 });
    let finish!: (response: Response) => void;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (init?.method === "DELETE" || String(input).endsWith("session")) return json({ ok: true });
      if (String(input).endsWith("renew")) return json({ expires_at: NOW / 1000 + 86_400 });
      if (++reads === 1) return json({ error: "no_pair" }, 401);
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    const pending = readCurrentPhoneBars();
    await drain();
    expect(reads).toBe(2);
    if (action === "account switch") clearPrivateSessionState({ user: { id: "next" } } as Session);
    else await endPhoneSession();
    if (action === "new pairing") {
      expect(await establishPhoneSession({ token: "new", expiresAt: NOW / 1000 + 86_400,
        refreshCredential: "new-refresh", refreshExpiresAt: NOW / 1000 + 30 * 86_400 }, "Next")).toBe(true);
    }
    finish(json({ body: { privateQuota: 42 } }));
    expect(await pending).toEqual({ kind: action === "new pairing" ? "superseded" : "unpaired" });
  });

  it("invalidates a direct read even when shared storage refuses logout", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => init?.method === "DELETE"
      ? json({ ok: true }) : new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = requestPhoneRead();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("refused"); });
    await endPhoneSession();
    finish(json({ body: { privateQuota: 42 } }));
    expect(await pending).toEqual({ kind: "unpaired" });
  });

  it("never restores metadata from a renewal completed after a new pairing", async () => {
    writePhonePairMeta({ label: "Old", expiresAt: NOW / 1000 });
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input) => String(input).endsWith("renew")
      ? new Promise<Response>((resolve) => { finish = resolve; }) : json({ ok: true })));
    const pending = requestPhoneRenewal();
    await drain();
    await endPhoneSession();
    await establishPhoneSession({ token: "new", expiresAt: NOW / 1000 + 86_400,
      refreshCredential: "new-refresh", refreshExpiresAt: NOW / 1000 + 30 * 86_400 }, "Next");
    finish(json({ expires_at: NOW / 1000 + 100 }));
    expect(await pending).toEqual({ kind: "superseded" });
    expect(JSON.parse(localStorage.getItem(PHONE_PAIR_META_KEY)!)).toEqual({ label: "Next", expiresAt: NOW / 1000 + 86_400 });
  });

  it("discards an old no_pair read after replacement without deleting the new session", async () => {
    writePhonePairMeta({ label: "Old", expiresAt: NOW / 1_000 + 86_400 });
    let finishRead!: (response: Response) => void;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const path = String(input);
      calls.push(init?.method === "DELETE" ? "delete" : path);
      if (path.endsWith("read")) return new Promise<Response>((resolve) => { finishRead = resolve; });
      return json({ ok: true });
    }));
    const runtime = createPhoneSessionRuntime();
    active.push(runtime);
    runtime.start();
    await drain();
    expect(await establishPhoneSession({ token: "new", expiresAt: NOW / 1_000 + 86_400,
      refreshCredential: "new-refresh", refreshExpiresAt: NOW / 1_000 + 30 * 86_400 }, "New")).toBe(true);
    finishRead(json({ error: "no_pair" }, 401));
    await drain();
    expect(runtime.current()).toEqual({ kind: "superseded" });
    expect(calls).not.toContain("delete");
    expect(readPhonePairMeta()).toEqual({ label: "New", expiresAt: NOW / 1_000 + 86_400 });
  });

  it("discards an old no_pair read while its replacement is still pending", async () => {
    writePhonePairMeta({ label: "Old", expiresAt: NOW / 1_000 + 86_400 });
    let finishRead!: (response: Response) => void;
    let finishSession!: (response: Response) => void;
    let deletes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const path = String(input);
      if (init?.method === "DELETE") { deletes += 1; return json({ ok: true }); }
      if (path.endsWith("read")) return new Promise<Response>((resolve) => { finishRead = resolve; });
      if (path.endsWith("session")) return new Promise<Response>((resolve) => { finishSession = resolve; });
      return json({ ok: true });
    }));
    const runtime = createPhoneSessionRuntime();
    active.push(runtime);
    runtime.start();
    await drain();
    await endPhoneSession();
    const replacement = establishPhoneSession({ token: "new", expiresAt: NOW / 1_000 + 86_400,
      refreshCredential: "new-refresh", refreshExpiresAt: NOW / 1_000 + 30 * 86_400 }, "New");
    await drain();
    finishRead(json({ error: "no_pair" }, 401));
    await drain();
    expect(runtime.current()).toEqual({ kind: "superseded" });
    expect(deletes).toBe(1);
    finishSession(json({ ok: true }));
    await expect(replacement).resolves.toBe(true);
  });

  it("suspends a read while replacement is pending and reads only after commit", async () => {
    writePhonePairMeta({ label: "Old", expiresAt: NOW / 1_000 + 86_400 });
    let finishSession!: (response: Response) => void;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const path = String(input);
      if (path.endsWith("session")) return new Promise<Response>((resolve) => { finishSession = resolve; });
      if (path.endsWith("read")) { reads += 1; return json({ body: { rows: [] } }); }
      return json({ ok: true });
    }));
    const replacement = establishPhoneSession({ token: "new", expiresAt: NOW / 1_000 + 86_400,
      refreshCredential: "new-refresh", refreshExpiresAt: NOW / 1_000 + 30 * 86_400 }, "New");
    await drain();
    await expect(requestPhoneRead()).resolves.toEqual({ kind: "superseded" });
    expect(reads).toBe(0);
    finishSession(json({ ok: true }));
    await expect(replacement).resolves.toBe(true);
    await expect(requestPhoneRead()).resolves.toEqual({ kind: "fresh", body: { rows: [] } });
    expect(reads).toBe(1);
  });

  it("recovers an abandoned same tab replacement and verifies cookies before restoring state", async () => {
    vi.resetModules();
    const first = await import("@/lib/phone-session");
    first.writePhonePairMeta({ label: "Old", expiresAt: NOW / 1_000 + 86_400 });
    let sessionCalls = 0;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const path = String(input);
      if (path.endsWith("session")) {
        sessionCalls += 1;
        return new Promise<Response>(() => undefined);
      }
      reads += 1;
      return json({ body: { rows: [] } });
    }));
    void first.establishPhoneSession({ token: "new", expiresAt: NOW / 1_000 + 86_400,
      refreshCredential: "new-refresh", refreshExpiresAt: NOW / 1_000 + 30 * 86_400 }, "New");
    await drain();
    const marker = JSON.parse(localStorage.getItem("openlimiter-phone-pairing-pending") ?? "null");
    expect(marker).toMatchObject({ replacement: expect.any(String), owner: expect.any(String) });
    expect(marker.expiresAt).toBe(NOW + 15_000);

    vi.resetModules();
    const recovered = await import("@/lib/phone-session");
    await expect(recovered.requestPhoneRead("Recovered")).resolves.toEqual({ kind: "fresh", body: { rows: [] } });
    expect(sessionCalls).toBe(1);
    expect(reads).toBe(1);
    expect(recovered.readPhonePairMeta()?.label).toBe("Recovered");
    expect(localStorage.getItem("openlimiter-phone-pairing-pending")).toBeNull();
  });

  it("expires an abandoned replacement from a closed tab before resuming reads", async () => {
    writePhonePairMeta({ label: "Uncertain", expiresAt: NOW / 1_000 + 86_400 });
    localStorage.setItem("openlimiter-phone-pairing-pending", JSON.stringify({
      owner: "closed-tab",
      replacement: "abandoned",
      expiresAt: NOW - 1,
    }));
    const fetcher = vi.fn(async () => json({ body: { rows: [] } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestPhoneRead("Recovered")).resolves.toEqual({ kind: "fresh", body: { rows: [] } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(readPhonePairMeta()?.label).toBe("Recovered");
    expect(localStorage.getItem("openlimiter-phone-pairing-pending")).toBeNull();
  });

  it("keeps the first successful read paired when a legacy marker has no revision", async () => {
    localStorage.setItem(PHONE_PAIR_META_KEY, JSON.stringify({ label: "Legacy", expiresAt: NOW / 1_000 + 86_400 }));
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ body: { rows: [] } }));
    vi.stubGlobal("fetch", fetcher);
    const runtime = createPhoneSessionRuntime();
    active.push(runtime);
    runtime.start();
    await drain();
    expect(runtime.current()).toEqual({ kind: "fresh", body: { rows: [] } });
    expect(localStorage.getItem(PHONE_PAIR_META_KEY)).not.toBeNull();
    expect(localStorage.getItem(PHONE_PAIRING_GENERATION_KEY)).not.toBeNull();
    expect(localStorage.getItem(PHONE_LAST_BARS_KEY)).not.toBeNull();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("restores verified metadata and generation before caching a cookie recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ body: { rows: [] } })));
    await expect(requestPhoneRead("Recovered phone")).resolves.toEqual({ kind: "fresh", body: { rows: [] } });
    expect(readPhonePairMeta()?.label).toBe("Recovered phone");
    const generation = localStorage.getItem(PHONE_PAIRING_GENERATION_KEY);
    expect(generation).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(PHONE_LAST_BARS_KEY) ?? "null")?.pairingGeneration).toBe(generation);
  });

  it("reads every 60 seconds, pauses hidden, and refreshes on visibility and network recovery", async () => {
    const read = vi.fn(async () => "fresh");
    const runtime = createSessionRuntime({ read });
    active.push(runtime);
    const subscriber = vi.fn();
    const unsubscribe = runtime.subscribe(subscriber);
    runtime.start();
    await drain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(read).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await drain();
    window.dispatchEvent(new Event("online"));
    await drain();
    expect(read).toHaveBeenCalledTimes(4);
    expect(runtime.current()).toBe("fresh");
    unsubscribe();
    runtime.stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(subscriber).toHaveBeenCalledTimes(4);
  });

  it("never overlaps reads and discards a response after stop", async () => {
    let finish!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const runtime = createSessionRuntime({ read });
    active.push(runtime);
    runtime.start();
    await drain();
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    runtime.stop();
    finish("old account");
    await drain();
    expect(runtime.current()).toBeUndefined();
  });

  it("reopens after 25 hours and renews before reading without an access cookie", async () => {
    writePhonePairMeta({ label: "Phone", expiresAt: (NOW + 24 * HOUR) / 1000 });
    vi.setSystemTime(NOW + 25 * HOUR);
    const paths: string[] = [];
    // The browser has lost the 24 hour access cookie but retains the refresh cookie.
    let cookies = `${PHONE_REFRESH_COOKIE}=refresh-after-close`;
    const upstream: Array<{ body: string; cache: RequestCache | undefined }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("https://persistence.test")) {
        upstream.push({ body: String(init?.body), cache: init?.cache });
        if (String(init?.body).includes("phone_renew")) {
          return json({ token: "renewed-read", expires_at: Date.now() / 1000 + 86_400,
            refresh_credential: "rotated-refresh", refresh_expires_at: Date.now() / 1000 + 72 * 3600 });
        }
        return json({ quota: 42 });
      }
      paths.push(path);
      expect(init?.credentials).toBe("same-origin");
      const request = new NextRequest(`https://app.test${path}`, { method: "POST", headers: { cookie: cookies } });
      const response = path.endsWith("renew") ? await renewPost(request) : await readPost(request);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      if (path.endsWith("renew")) {
        expect(response.cookies.get(PHONE_REFRESH_COOKIE)?.maxAge).toBe(72 * 3600);
        cookies = `${PHONE_TOKEN_COOKIE}=${response.cookies.get(PHONE_TOKEN_COOKIE)?.value}; ${PHONE_REFRESH_COOKIE}=${response.cookies.get(PHONE_REFRESH_COOKIE)?.value}`;
      }
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = createPhoneSessionRuntime();
    active.push(runtime);
    runtime.start();
    await runtime.refresh();
    expect(upstream[0]?.body).toContain("refresh-after-close");
    expect(upstream.every((call) => call.cache === "no-store")).toBe(true);
    expect(paths).toEqual(["/app/pair/api/renew", "/app/pair/api/read"]);
    expect(runtime.current()).toEqual({ kind: "fresh", body: { quota: 42 } });
  });

  it("drops the snapshot and stops immediately when the phone is revoked", async () => {
    writePhonePairMeta({ label: "Phone", expiresAt: (NOW + 24 * HOUR) / 1000 });
    let revoked = false;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      if (init?.method === "DELETE") return json({ ok: true });
      reads += 1;
      return revoked ? json({ error: "revoked" }, 403) : json({ body: { quota: 42 } });
    }));
    const runtime = createPhoneSessionRuntime();
    active.push(runtime);
    runtime.start();
    await drain();
    revoked = true;
    window.dispatchEvent(new Event("online"));
    await drain();
    expect(runtime.current()).toEqual({ kind: "revoked" });
    expect(localStorage.getItem(PHONE_PAIR_META_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(reads).toBe(2);
    expect(await readCurrentPhoneBars()).toEqual({ kind: "unpaired" });
  });

  it("coalesces renewals in one tab, including forced recovery", async () => {
    writePhonePairMeta({ label: "Phone", expiresAt: NOW / 1000 });
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const first = requestPhoneRenewal();
    const second = requestPhoneRenewal(true);
    await drain();
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(json({ expires_at: NOW / 1000 + 86_400 }));
    expect(await first).toEqual(await second);
  });

  it("serializes two independent tabs through shared storage without Web Locks", async () => {
    vi.resetModules();
    const other = await import("@/lib/phone-session");
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    writePhonePairMeta({ label: "Phone", expiresAt: NOW / 1000 });
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const first = requestPhoneRenewal();
    const second = other.requestPhoneRenewal();
    await drain();
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(json({ expires_at: NOW / 1000 + 86_400 }));
    await first;
    await vi.advanceTimersByTimeAsync(50);
    expect(await second).toEqual({ kind: "skipped", expiresAt: NOW / 1000 + 86_400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("account persistence and isolation", () => {
  it.each([null, { user: { id: "new" } } as Session])("clears private state on logout or switch (%s)", async (next) => {
    const key = authStorageKey()!;
    for (const store of [localStorage, sessionStorage]) {
      store.setItem(key, JSON.stringify({ user: { id: "old" } }));
      store.setItem(`${key}-code-verifier`, "private");
      store.setItem("openlimiter-app-live", "private snapshot");
      store.setItem("openlimiter-device-session", "legacy token");
      store.setItem("openlimiter-phone-pair-meta", "private marker");
      store.setItem("unrelated", "keep");
    }
    if (next) localStorage.setItem(key, JSON.stringify(next));
    const fetcher = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    clearPrivateSessionState(next);
    await drain();
    expect(localStorage.getItem(key)).toBe(next ? JSON.stringify(next) : null);
    expect(sessionStorage.getItem(key)).toBeNull();
    for (const store of [localStorage, sessionStorage]) {
      expect(store.getItem("openlimiter-app-live")).toBeNull();
      expect(store.getItem("openlimiter-device-session")).toBeNull();
      expect(store.getItem(PHONE_PAIR_META_KEY)).toBeNull();
      expect(store.getItem(`${key}-code-verifier`)).toBeNull();
      expect(store.getItem("unrelated")).toBe("keep");
    }
    expect(fetcher).toHaveBeenCalledWith("/app/pair/api/session", expect.objectContaining({ method: "DELETE", cache: "no-store" }));
    expect(await readCurrentPhoneBars()).toEqual({ kind: "unpaired" });
  });

  it("does not let initial session discovery resurrect an account after logout", async () => {
    let callback!: (event: "SIGNED_OUT", session: null) => void;
    let resolve!: (value: unknown) => void;
    const client = { auth: {
      getSession: () => new Promise((done) => { resolve = done; }),
      onAuthStateChange: (listener: typeof callback) => { callback = listener; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
    } } as unknown as SupabaseClient;
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true })));
    const listener = vi.fn();
    const subscription = observeAccountSession(client, listener);
    callback("SIGNED_OUT", null);
    resolve({ data: { session: { user: { id: "old" } } } });
    await drain();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("SIGNED_OUT", null);
    subscription.unsubscribe();
  });

  it.each(["/app/cli?code=ABCD2345", "/app/pair", "/app?trial=1"])("restores %s through the real OAuth client", async (destination) => {
    window.history.replaceState(null, "", destination);
    const client = createAccountClient(true)!;
    const answer = await client.auth.signInWithOAuth({ provider: "github", options: { redirectTo: `${window.location.origin}/app`, skipBrowserRedirect: true } });
    expect(new URL(answer.data.url!).searchParams.get("redirect_to")).toBe(window.location.origin + destination);
    await client.auth.stopAutoRefresh();
  });

  it("never restores an external target or sends a pairing secret to the auth server", () => {
    expect(accountReturnDestination("https://app.test/app/pair#code=ABCD2345")).toBe("/app/pair");
    expect(accountReturnDestination("https://app.test/app?returnTo=https://evil.test")).toBe("/app");
  });

  it("keeps a CLI code supplied by pending intent after it has left the address bar", async () => {
    window.history.replaceState(null, "", "/app/cli");
    const client = createAccountClient(true)!;
    const answer = await client.auth.signInWithOAuth({ provider: "github", options: {
      redirectTo: `${window.location.origin}/app/cli?code=ABCD2345`, skipBrowserRedirect: true,
    } });
    expect(new URL(answer.data.url!).searchParams.get("redirect_to")).toBe(`${window.location.origin}/app/cli?code=ABCD2345`);
    await client.auth.stopAutoRefresh();
  });

  it("keeps an actual Supabase account client signed in through seven days of expiry and rotation", async () => {
    let generation = 0;
    const user = { id: "account", aud: "authenticated", role: "authenticated", email: "test@example.test" };
    const session = () => ({
      access_token: `header.${btoa(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`,
      refresh_token: `refresh-${generation}`, token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user,
    });
    localStorage.setItem(authStorageKey()!, JSON.stringify(session()));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.cache).toBe("no-store");
      if (String(input).includes("/token")) {
        expect(JSON.parse(String(init?.body)).refresh_token).toBe(`refresh-${generation}`);
        generation += 1;
        return json(session());
      }
      return json(user);
    });
    vi.stubGlobal("fetch", fetcher);
    const client = createAccountClient(true)!;
    await client.auth.getSession();
    const runtime = createSessionRuntime({ read: async () => (await client.auth.getSession()).data.session });
    active.push(runtime);
    runtime.start();
    await vi.advanceTimersByTimeAsync(7 * 24 * HOUR);
    expect(runtime.current()?.user.id).toBe("account");
    expect(generation).toBeGreaterThanOrEqual(168);
    expect(JSON.parse(localStorage.getItem(authStorageKey()!)!).refresh_token).toBe(`refresh-${generation}`);
    await client.auth.stopAutoRefresh();
  });
});

describe("the actual service worker cache boundary", () => {
  it("installs the real shells, fails a broken asset, activates an update, and hydrates offline", async () => {
    const source = readFileSync("public/sw.js", "utf8");
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const entries = new Map<string, Response>();
    let currentCache = "";
    let offline = false;
    const skipWaiting = vi.fn();
    const claim = vi.fn();
    const remove = vi.fn(async () => true);
    const cache = {
      put: vi.fn(async (key: string | Request, response: Response) => {
        const path = typeof key === "string" ? key : new URL(key.url).pathname;
        entries.set(path, response.clone());
      }),
    };
    const caches = {
      open: vi.fn(async (name: string) => { currentCache = name; return cache; }),
      keys: vi.fn(async () => ["openlimiter-app-private-v1-old", currentCache, "unrelated"]),
      delete: remove,
      match: vi.fn(async (key: string | Request) => {
        const path = typeof key === "string" ? key : new URL(key.url).pathname;
        return entries.get(path)?.clone();
      }),
    };
    const fetcher = vi.fn(async (input: string | Request) => {
      if (offline) throw new Error("offline");
      const path = typeof input === "string" ? input : new URL(input.url).pathname;
      if (path === "/app" || path === "/app/pair") {
        return new Response('<main id="app">waiting</main><script src="/_next/static/app-shell.js"></script>', {
          headers: { "cache-control": "public, max-age=60" },
        });
      }
      return new Response('document.querySelector("#app").textContent = "hydrated offline";', {
        headers: { "cache-control": "public, max-age=31536000" },
      });
    });
    runInNewContext(source, {
      self: {
        location: { href: "https://app.test/sw.js?build=next", origin: "https://app.test" },
        addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler),
        skipWaiting,
        clients: { claim, matchAll: vi.fn(), openWindow: vi.fn() },
        registration: { showNotification: vi.fn() },
      },
      URL, Response, caches, fetch: fetcher,
    });
    let installed: Promise<void> | undefined;
    handlers.get("install")!({ waitUntil: (promise: Promise<void>) => { installed = promise; } });
    await installed;
    expect(entries.has("/app")).toBe(true);
    expect(entries.has("/app/pair")).toBe(true);
    expect(entries.has("/_next/static/app-shell.js")).toBe(true);
    expect(skipWaiting).toHaveBeenCalledOnce();

    let activated: Promise<void> | undefined;
    handlers.get("activate")!({ waitUntil: (promise: Promise<void>) => { activated = promise; } });
    await activated;
    expect(remove).toHaveBeenCalledWith("openlimiter-app-private-v1-old");
    expect(remove).not.toHaveBeenCalledWith("unrelated");
    expect(claim).toHaveBeenCalledOnce();

    offline = true;
    let navigation: Promise<Response> | undefined;
    handlers.get("fetch")!({
      request: { url: "https://app.test/app/pair?capture=1", method: "GET", mode: "navigate", headers: new Headers(), cache: "default" },
      respondWith: (response: Promise<Response>) => { navigation = response; },
    });
    const offlineHtml = await (await navigation)?.text() ?? "";
    expect(offlineHtml).toContain("app-shell.js");
    let asset: Promise<Response> | undefined;
    handlers.get("fetch")!({
      request: new Request("https://app.test/_next/static/app-shell.js"),
      respondWith: (response: Promise<Response>) => { asset = response; },
    });
    const script = await (await asset)?.text() ?? "";
    const shell = document.createElement("div");
    shell.innerHTML = offlineHtml;
    runInNewContext(script, { document: { querySelector: (selector: string) => shell.querySelector(selector) } });
    expect(shell.querySelector("#app")?.textContent).toBe("hydrated offline");

    const brokenHandlers = new Map<string, (event: Record<string, unknown>) => void>();
    runInNewContext(source, {
      self: {
        location: { href: "https://app.test/sw.js?build=broken", origin: "https://app.test" },
        addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => brokenHandlers.set(name, handler),
        skipWaiting: vi.fn(), clients: { claim: vi.fn() },
      },
      URL, Response,
      caches: { open: async () => cache },
      fetch: async (input: string) => input.includes("monochrome")
        ? new Response("missing", { status: 500 })
        : fetcher(input),
    });
    offline = false;
    let broken: Promise<void> | undefined;
    brokenHandlers.get("install")!({ waitUntil: (promise: Promise<void>) => { broken = promise; } });
    await expect(broken).rejects.toThrow("Application asset is not public");
  });

  it("never writes an authenticated API response or navigation to any cache", async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const put = vi.fn();
    const caches = { open: vi.fn(async () => ({ put })), match: vi.fn() };
    const fetcher = vi.fn(async () => new Response("private quota", { headers: { "cache-control": "private, no-store" } }));
    runInNewContext(readFileSync("public/sw.js", "utf8"), {
      self: { location: { href: "https://app.test/sw.js", origin: "https://app.test" }, addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler) },
      URL, Response, caches, fetch: fetcher,
    });
    for (const path of ["/app/pair/api/read", "/app/pair/api/renew", "/app/private", "/_next/static/private.js"]) {
      const respondWith = vi.fn();
      handlers.get("fetch")!({ request: new Request(`https://app.test${path}`, { headers: { authorization: "Bearer test" } }), respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
    let navigation: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: { url: "https://app.test/app", method: "GET", mode: "navigate", headers: new Headers() }, respondWith: (response: Promise<Response>) => { navigation = response; } });
    await navigation;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
  });

  it("falls back to the route specific shell, including a trial query", async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const pair = new Response("pair");
    const hub = new Response("hub");
    const match = vi.fn(async (key: string) => key === "/app/pair" ? pair.clone() : hub.clone());
    runInNewContext(readFileSync("public/sw.js", "utf8"), {
      self: { location: { href: "https://app.test/sw.js", origin: "https://app.test" }, addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler) },
      URL, Response, caches: { match }, fetch: vi.fn(async () => { throw new Error("offline"); }),
    });
    for (const [path, shell, text] of [
      ["/app/pair?capture=1", "/app/pair", "pair"],
      ["/app?trial=1", "/app", "hub"],
    ] as const) {
      let response: Promise<Response> | undefined;
      handlers.get("fetch")!({
        request: { url: `https://app.test${path}`, method: "GET", mode: "navigate", headers: new Headers(), cache: "default" },
        respondWith: (next: Promise<Response>) => { response = next; },
      });
      expect(await (await response)?.text()).toBe(text);
      expect(match).toHaveBeenLastCalledWith(shell);
    }
  });
});
