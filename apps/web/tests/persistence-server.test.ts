import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PhonePair } from "@/lib/phone-session";

// The runner supplies only credentials minted by its disposable local stack.
// Time compression ages stored timestamps, never signs or fabricates a token.
// These tests supplement, rather than replace, the seven real day device soak.
const enabled = process.env.OL_PERSISTENCE_PROOF === "disposable-local";
const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const service = process.env.OL_PROOF_SERVICE_KEY ?? "";
const container = process.env.OL_PROOF_DB_CONTAINER ?? "";
const nativeFetch = globalThis.fetch;
const clients: SupabaseClient[] = [];
const users: string[] = [];
const HOUR = 3600;
let phone: typeof import("@/lib/phone-session");
let account: typeof import("@/lib/account-client");
let device: typeof import("@/lib/pro-device");
let routes: {
  renew: typeof import("@/app/app/pair/api/renew/route").POST;
  read: typeof import("@/app/app/pair/api/read/route").POST;
  session: typeof import("@/app/app/pair/api/session/route");
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message); // Never put credentials into assertion output.
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function sql(query: string): string {
  check(enabled && /^[a-f0-9]{12,64}$/.test(container), "Disposable database attestation required");
  try {
    return execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1"],
      { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { throw new Error("Disposable persistence SQL failed"); }
}
async function admin(path: string, body?: unknown, method = "POST") {
  const response = await nativeFetch(`${base}/auth/v1/${path}`, {
    method, headers: { apikey: service, authorization: `Bearer ${service}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  check(response.ok, `Disposable Auth request failed (${response.status})`);
  return response.json();
}
async function user() {
  const email = `persistence-${randomUUID()}@example.invalid`;
  const password = randomUUID() + randomUUID();
  const created = await admin("admin/users", { email, password, email_confirm: true });
  check(typeof created.id === "string", "Auth must create a disposable user");
  users.push(created.id);
  sql(`insert into public.entitlements(user_id,product,status,source)
    values (${literal(created.id)},'openlimiter_pro','comped','comp');
    insert into public.entitlement_features(user_id,product,feature)
    select ${literal(created.id)},'openlimiter_pro',unnest(enum_range(null::public.entitlement_feature_v1));
    insert into public.usage_current(user_id,account_id,provider,meter,window_id,event_id,usage_percent,observed_at)
    values (${literal(created.id)},'default','CLAUDE','FIVE_HOUR','FIVE_HOUR',gen_random_uuid(),42,now());`);
  return { id: created.id as string, email, password };
}
async function paired() {
  const owner = await user();
  const desktop = randomUUID();
  const created = JSON.parse(sql(`set role service_role;
    select public.register_device_grant_v2(${literal(owner.id)},${literal(desktop)},'Proof desktop',null);
    select public.pair_device_v1('create',${literal(owner.id)},${literal(desktop)},null,null,'{}',repeat('a',64));`).split("\n").at(-1)!);
  check(typeof created.code === "string", "Server must create a pairing code");
  const claimed = await device.claimPairingCode(created.code, { name: "Proof phone", platform: "ios", user_agent_hash: "a".repeat(64) });
  check(claimed.status === 200, "Real pairing claim must succeed");
  const claimId = (claimed.body as { claim_id: string }).claim_id;
  const approved = JSON.parse(sql(`set role service_role;
    select public.pair_device_v1('approve',${literal(owner.id)},${literal(desktop)},${literal(created.code)},null,'{}',repeat('a',64));`));
  check(approved.status === "approved", "Database must approve the claimed phone");
  const delivered = await device.pollPairingClaim(claimId);
  const pair = phone.phonePairOf(delivered.body);
  check(delivered.status === 200 && pair, "Real server must deliver a signed phone pair");
  const deviceId = sql(`select phone_device_id from public.pairing_codes where claim_id=${literal(claimId)};`);
  return { owner, pair, deviceId };
}

// Only the browser to Next hop is in process. Every hosted request goes to the
// real Edge Function, GoTrue and Postgres, with no mocked server responses.
function browser(initial?: PhonePair) {
  const jar = new Map<string, { value: string; expires: number }>();
  if (initial) {
    jar.set(phone.PHONE_TOKEN_COOKIE, { value: initial.token, expires: initial.expiresAt });
    jar.set(phone.PHONE_REFRESH_COOKIE, { value: initial.refreshCredential, expires: initial.refreshExpiresAt });
  }
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (!path.startsWith("/app/pair/api/")) {
      check(new URL(path).origin === new URL(base).origin, "Proof refuses nonlocal network requests");
      return nativeFetch(input, init);
    }
    const now = Date.now() / 1000;
    const cookie = [...jar].filter(([, entry]) => entry.expires > now)
      .map(([name, entry]) => `${name}=${entry.value}`).join("; ");
    const request = new NextRequest(`https://proof.invalid${path}`, {
      ...init, signal: init?.signal ?? undefined, headers: { cookie, "content-type": "application/json" },
    });
    const response = path.endsWith("renew") ? await routes.renew(request)
      : path.endsWith("read") ? await routes.read(request)
      : init?.method === "DELETE" ? await routes.session.DELETE() : await routes.session.POST(request);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    for (const entry of response.cookies.getAll()) {
      jar.set(entry.name, { value: entry.value, expires: now + (entry.maxAge ?? 0) });
    }
    return response;
  });
  return jar;
}

describe.skipIf(!enabled)(enabled ? "disposable Supabase persistence proof" : "PERSISTENCE_PROOF_NOT_CONFIGURED: run node scripts/persistence-proof.mjs --pro-dir <Pro checkout>", () => {
  beforeAll(async () => {
    check(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "Proof requires loopback Supabase");
    check(service && /^[a-f0-9]{12,64}$/.test(container), "Proof requires disposable credentials and database");
    phone = await import("@/lib/phone-session");
    account = await import("@/lib/account-client");
    device = await import("@/lib/pro-device");
    routes = { renew: (await import("@/app/app/pair/api/renew/route")).POST,
      read: (await import("@/app/app/pair/api/read/route")).POST,
      session: await import("@/app/app/pair/api/session/route") };
    sql("update public.feature_kill_switches set enabled=true where feature in ('sync_current','history','token_issue');");
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.auth.stopAutoRefresh();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    for (const id of users.splice(0)) await admin(`admin/users/${id}`, undefined, "DELETE");
  });

  it("rotates a real phone refresh credential and rejects its replay after server grace", async () => {
    const { pair, deviceId } = await paired();
    const renewed = await phone.renewPhonePair(pair);
    check(renewed.kind === "renewed", "Real refresh must renew");
    expect(renewed.pair.refreshCredential !== pair.refreshCredential).toBe(true);
    expect(renewed.pair.refreshExpiresAt - Date.now() / 1000).toBeGreaterThan(29 * 86400);
    sql(`update public.device_grants set phone_prev_refresh_expires_at=now()-interval '1 second' where device_id=${literal(deviceId)};`);
    expect((await device.renewPhoneCredential(pair.refreshCredential)).status).toBe(401);
    expect((await phone.readPhoneBars(renewed.pair)).kind).toBe("fresh");
  }, 60_000);

  it("refuses a genuinely expired refresh row through the real browser recovery path", async () => {
    const { pair, deviceId } = await paired();
    sql(`update public.device_grants set phone_refresh_expires_at=now()-interval '1 second' where device_id=${literal(deviceId)};`);
    browser(pair);
    phone.writePhonePairMeta({ label: "Proof", expiresAt: Date.now() / 1000 - 1 });
    expect(await phone.readCurrentPhoneBars()).toEqual({ kind: "unpaired" });
  }, 60_000);

  it("stops reading immediately after real server revocation", async () => {
    const { pair, deviceId, owner } = await paired();
    browser(pair);
    phone.writePhonePairMeta({ label: "Proof", expiresAt: pair.expiresAt });
    expect((await phone.readCurrentPhoneBars()).kind).toBe("fresh");
    sql(`set role service_role; select public.revoke_device_grant_v2(${literal(owner.id)},${literal(deviceId)});`);
    expect((await phone.readCurrentPhoneBars()).kind).toBe("unpaired");
  }, 60_000);

  it("reopens after 25 hours of stored age and renews with a real surviving refresh credential", async () => {
    const { pair, deviceId } = await paired();
    sql(`update public.entitlement_token_issues set issued_at=issued_at-interval '25 hours',
      expires_at=expires_at-interval '25 hours' where device_id=${literal(deviceId)};
      update public.device_grants set phone_refresh_expires_at=phone_refresh_expires_at-interval '25 hours'
      where device_id=${literal(deviceId)};`);
    const jar = browser({ ...pair, expiresAt: pair.expiresAt - 25 * HOUR, refreshExpiresAt: pair.refreshExpiresAt - 25 * HOUR });
    phone.writePhonePairMeta({ label: "Proof", expiresAt: pair.expiresAt - 25 * HOUR });
    const outcome = await phone.readCurrentPhoneBars();
    expect(outcome.kind).toBe("fresh");
    check(outcome.kind === "fresh", "Reopened phone must read quota");
    expect((outcome.body as { rows: Array<{ percent: number }> }).rows[0]?.percent).toBe(42);
    expect(jar.get(phone.PHONE_REFRESH_COOKIE)?.value !== pair.refreshCredential).toBe(true);
    expect(jar.get(phone.PHONE_TOKEN_COOKIE)!.expires).toBeGreaterThan(Date.now() / 1000 + 23 * HOUR);
  }, 60_000);

  it("keeps the account for seven days of stored age with 168 real GoTrue renewals and a reopen", async () => {
    const owner = await user();
    const client = account.createAccountClient(true)!;
    clients.push(client);
    const signedIn = await client.auth.signInWithPassword({ email: owner.email, password: owner.password });
    check(!signedIn.error && signedIn.data.session, "Real account sign in must succeed");
    await client.auth.stopAutoRefresh();
    const key = account.authStorageKey()!;
    let previous = signedIn.data.session.refresh_token;
    for (let hour = 1; hour <= 168; hour++) {
      sql(`update auth.sessions set created_at=created_at-interval '1 hour',
        updated_at=updated_at-interval '1 hour', refreshed_at=refreshed_at-interval '1 hour'
        where user_id=${literal(owner.id)};
        update auth.refresh_tokens set created_at=created_at-interval '1 hour', updated_at=updated_at-interval '1 hour'
        where user_id=${literal(owner.id)};`);
      const stored = JSON.parse(localStorage.getItem(key)!);
      // Expire only the client's scheduling metadata. Both tokens stay server issued.
      stored.expires_at = Math.floor(Date.now() / 1000) - 1;
      localStorage.setItem(key, JSON.stringify(stored));
      const current = await client.auth.getSession();
      check(!current.error && current.data.session, `Real renewal ${hour} must succeed`);
      check(current.data.session.refresh_token !== previous, `Real renewal ${hour} must rotate`);
      previous = current.data.session.refresh_token;
      expect((await client.auth.getUser()).data.user?.id).toBe(owner.id);
    }
    expect(Number(sql(`select extract(epoch from (now()-created_at)) from auth.sessions where user_id=${literal(owner.id)};`))).toBeGreaterThanOrEqual(7 * 86400);
    const reopened = account.createAccountClient(true)!;
    clients.push(reopened);
    expect((await reopened.auth.getSession()).data.session?.user.id).toBe(owner.id);
    expect((await reopened.auth.getUser()).data.user?.id).toBe(owner.id);
  }, 300_000);
});
