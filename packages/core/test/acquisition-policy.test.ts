import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireMachineLease, freshnessPolicy, leasePolicy, mergeSnapshotCache, retryPolicy, readSnapshotCache, recordAcquisitionAvailability } from "../src/cache.js";
import { claudeUsageRequest, retryAfterSeconds } from "../src/acquire/transport.js";
import { runAcquisition, type AcquisitionSpec } from "../src/acquire/runner.js";
import { readAcquisitionSchedule, writeAcquisitionSchedule } from "../src/acquire/cadence.js";
import { snapshot } from "./helpers.js";

type Vector<T> = { id: string; input: T; expected: unknown };
const vectors = JSON.parse(readFileSync(path.resolve("packages/core/src/contracts/policy-vectors.json"), "utf8")).vectors as {
  retry: Vector<Parameters<typeof retryPolicy>[0]>[];
  lease: Vector<Parameters<typeof leasePolicy>[0]>[];
  freshness: Vector<Parameters<typeof freshnessPolicy>[0]>[];
};

describe("shared production policy vectors", () => {
  for (const vector of vectors.retry) it(vector.id, () => expect(retryPolicy(vector.input)).toEqual(vector.expected));
  for (const vector of vectors.lease) it(vector.id, () => expect(leasePolicy(vector.input)).toEqual(vector.expected));
  for (const vector of vectors.freshness) it(vector.id, () => expect(freshnessPolicy(vector.input)).toEqual(vector.expected));
});

const now = Date.parse("2026-08-07T12:00:00.000Z");
const directory = async () => realpath(await mkdtemp(path.join(tmpdir(), "openlimiter-policy-")));

it("takes over an expired desktop lease and rejects duplicate owners", async () => {
  const dir = await directory();
  try {
    const file = path.join(dir, "acquisition-claude.json");
    await writeFile(file, JSON.stringify({ owner: "desktop", expiresAt: now + 1, token: "desktop-instance", nextAllowedAt: 0, attempts: 2 }));
    expect(await acquireMachineLease("CLAUDE", dir, now)).toBeNull();
    const lease = await acquireMachineLease("CLAUDE", dir, now + 1);
    expect(lease).not.toBeNull();
    expect(await acquireMachineLease("CLAUDE", dir, now + 1)).toBeNull();
    await lease!.complete(now + 900_000, 3);
    await lease!.release();
    expect(await acquireMachineLease("CLAUDE", dir, now + 60_000)).toBeNull();
    const restarted = await acquireMachineLease("CLAUDE", dir, now + 900_000);
    expect(restarted?.attempts).toBe(3);
    await restarted!.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("an old holder cannot release or complete a successor", async () => {
  const dir = await directory();
  try {
    const old = await acquireMachineLease("CODEX", dir, now);
    const successor = await acquireMachineLease("CODEX", dir, now + 60_000);
    expect(successor).not.toBeNull();
    await old!.release();
    await expect(old!.complete(now, 0)).rejects.toThrow();
    expect(await successor!.stillOwned(now + 60_000)).toBe(true);
    await successor!.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("does not send an expired injected credential and persists availability", async () => {
  const dir = await directory();
  let calls = 0;
  const spec: AcquisitionSpec = { provider: "CLAUDE", credentialProvider: "CLAUDE", steps: [({ credential }) => claudeUsageRequest(credential.secret)], parse: () => [], disclosure: null };
  try {
    const result = await runAcquisition([spec], {
      stateDirectory: dir, now: new Date(now).toISOString(), schedule: {},
      readCredential: async () => ({ ok: true, credential: { secret: "expired", accountId: null, expiresAtMilliseconds: now, origin: "vendor_store" } }),
      transport: async () => { calls++; throw new Error("must not send"); }
    });
    expect(calls).toBe(0);
    expect(result.rows[0]?.availability).toBe("expired_credentials");
    const cached = await readSnapshotCache(dir);
    expect(cached.ok && cached.snapshots[0]?.availability).toBe("expired_credentials");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("parses an HTTP date and retains a blocked reading's observation time on restore", async () => {
  expect(retryAfterSeconds("Sat, 15 Aug 2026 12:00:00 GMT", now)).toBe(8 * 86400);
  const dir = await directory();
  try {
    const observed = new Date(now).toISOString();
    const retry = new Date(now + 8 * 86400_000).toISOString();
    await recordAcquisitionAvailability("CLAUDE", "rate_limited", observed, retry, dir);
    const cached = await readSnapshotCache(dir);
    expect(cached.ok && cached.snapshots[0]?.observedAt).toBe(observed);
    expect(cached.ok && cached.snapshots[0]?.retryAt).toBe(retry);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("clears stale numbers only for the unavailable Codex account", async () => {
  const dir = await directory();
  const observed = new Date(now).toISOString();
  try {
    await mergeSnapshotCache([
      snapshot({ provider: "CODEX", accountId: "codex-failing", meter: "PRIMARY", value: 73, resetAt: new Date(now + 3600_000).toISOString(), observedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 300_000).toISOString() }),
      snapshot({ provider: "CODEX", accountId: "codex-healthy", meter: "PRIMARY", value: 41, observedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 300_000).toISOString() })
    ], dir, now);
    await recordAcquisitionAvailability("CODEX", "network_failure", observed, undefined, dir, "codex-failing");
    const cached = await readSnapshotCache(dir);
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    const failing = cached.snapshots.find(row => row.accountId === "codex-failing");
    const healthy = cached.snapshots.find(row => row.accountId === "codex-healthy");
    expect(failing).toMatchObject({ value: 0, window: { kind: "unknown" }, resetAt: null, availability: "network_failure" });
    expect(healthy).toMatchObject({ value: 41 });
    expect(healthy?.availability).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("restarts with the persisted exponential retry count and never polls before its deadline", async () => {
  const dir = await directory();
  let current = now;
  let calls = 0;
  const spec: AcquisitionSpec = { provider: "CLAUDE", credentialProvider: "CLAUDE", steps: [({ credential }) => claudeUsageRequest(credential.secret)], parse: () => [], disclosure: null };
  try {
    for (const seconds of [60, 120, 240, 480, 900, 900]) {
      const options = {
        stateDirectory: dir, now: new Date(current).toISOString(), schedule: {},
        readCredential: async () => ({ ok: true as const, credential: { secret: "valid-fixture-token", accountId: null, expiresAtMilliseconds: null, origin: "vendor_store" as const } }),
        transport: async () => { calls++; return { status: 429, body: "", retryAfterSeconds: 0 }; }
      };
      const result = await runAcquisition([spec], options);
      expect(result.rows[0]?.retryAt).toBe(new Date(current + seconds * 1000).toISOString());
      const count = calls;
      await runAcquisition([spec], { ...options, now: new Date(current + seconds * 1000 - 1).toISOString() });
      expect(calls).toBe(count);
      current += seconds * 1000;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("serializes simultaneous contenders and shared Code Assist aliases", async () => {
  const dir = await directory();
  try {
    const contenders = await Promise.all([acquireMachineLease("ANTIGRAVITY", dir, now), acquireMachineLease("GEMINI_CLI", dir, now)]);
    expect(contenders.filter(Boolean)).toHaveLength(1);
    await Promise.all(contenders.map((lease) => lease?.release()));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("caps a persisted rate limit at seven days and keeps the provider rate limited until then", async () => {
  const dir = await directory();
  let calls = 0;
  const spec: AcquisitionSpec = { provider: "CLAUDE", credentialProvider: "CLAUDE", steps: [({ credential }) => claudeUsageRequest(credential.secret)], parse: () => [], disclosure: null };
  const options = { stateDirectory: dir, now: new Date(now).toISOString(), schedule: {},
    readCredential: async () => ({ ok: true as const, credential: { secret: "fixture", accountId: null, expiresAtMilliseconds: null, origin: "vendor_store" as const } }),
    transport: async () => { calls++; return { status: 429, body: "", retryAfterSeconds: 999999 }; } };
  try {
    const result = await runAcquisition([spec], options);
    const deadline = now + 7 * 86400_000;
    expect(result.rows[0]?.retryAt).toBe(new Date(deadline).toISOString());
    await runAcquisition([spec], { ...options, now: new Date(deadline - 1).toISOString() });
    expect(calls).toBe(1);
    const cached = await readSnapshotCache(dir);
    expect(cached.ok && cached.snapshots[0]?.availability).toBe("rate_limited");
    expect(cached.ok && cached.snapshots[0]?.retryAt).toBe(new Date(deadline).toISOString());
    await runAcquisition([spec], { ...options, now: new Date(deadline).toISOString() });
    expect(calls).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const refusal of [401, 403, "not_signed_in"] as const) {
  it(`refusal ${refusal} waits a day across restart, or resumes on a credential change`, async () => {
    const dir = await directory();
    let calls = 0;
    let token = "first-fixture";
    const spec: AcquisitionSpec = { provider: "CLAUDE", credentialProvider: "CLAUDE", steps: [({ credential }) => {
      if (refusal === "not_signed_in") { calls++; return { stop: "unauthorized" }; }
      return claudeUsageRequest(credential.secret);
    }], parse: () => [], disclosure: null };
    const options = { stateDirectory: dir, now: new Date(now).toISOString(), schedule: {},
      readCredential: async () => ({ ok: true as const, credential: { secret: token, accountId: null, expiresAtMilliseconds: null, origin: "vendor_store" as const } }),
      transport: async () => { calls++; return { status: refusal as number, body: "", retryAfterSeconds: 999999 }; } };
    try {
      const first = await runAcquisition([spec], options);
      expect(first.rows[0]?.nextAttemptAt).toBe(new Date(now + 86400_000).toISOString());
      const availability = refusal === 403 ? "access_denied" : "expired_credentials";
      expect(first.rows[0]?.availability).toBe(availability);
      await writeAcquisitionSchedule(first.schedule, dir);
      const schedule = await readAcquisitionSchedule(dir);
      const cached = await readSnapshotCache(dir);
      expect(cached.ok && cached.snapshots[0]?.availability).toBe(availability);
      await runAcquisition([spec], { ...options, schedule, now: new Date(now + 86399_000).toISOString() });
      expect(calls).toBe(1);
      token = "changed-fixture";
      const changed = await runAcquisition([spec], { ...options, schedule, now: new Date(now + 86399_000).toISOString() });
      expect(calls).toBe(2);
      await runAcquisition([spec], { ...options, schedule: changed.schedule, now: new Date(now + 86399_000 + 86400_000).toISOString() });
      expect(calls).toBe(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

it("a changed credential file modification time releases only its refusal deadline", async () => {
  const dir = await directory();
  let calls = 0;
  try {
    const folder = path.join(dir, ".claude");
    await mkdir(folder);
    const file = path.join(folder, ".credentials.json");
    await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token" } }));
    const spec: AcquisitionSpec = { provider: "CLAUDE", credentialProvider: "CLAUDE", steps: [({ credential }) => claudeUsageRequest(credential.secret)], parse: () => [], disclosure: null };
    const options = { stateDirectory: dir, now: new Date(now).toISOString(), schedule: {}, lookup: { homeDirectory: dir, environment: {}, platform: "linux" as const },
      transport: async () => { calls++; return { status: 401, body: "", retryAfterSeconds: null }; } };
    const result = await runAcquisition([spec], options);
    await runAcquisition([spec], { ...options, schedule: result.schedule });
    expect(calls).toBe(1);
    await utimes(file, new Date(now), new Date(now));
    await runAcquisition([spec], { ...options, schedule: result.schedule });
    expect(calls).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("Codex login metadata change lets Check again collect after an auth failure", async () => {
  const dir = await directory();
  let revision = "auth-metadata-before-login";
  let calls = 0;
  const accountId = "codex-verified-account";
  const spec: AcquisitionSpec = {
    provider: "CODEX",
    credentialProvider: "CODEX",
    accountIdFor: credential => credential.verifiedAccountId ?? null,
    steps: [({ credential }) => claudeUsageRequest(credential.secret)],
    parse: () => [snapshot({ provider: "CODEX", accountId, meter: "PRIMARY", value: 23 })],
    disclosure: null
  };
  const options = {
    stateDirectory: dir,
    now: new Date(now).toISOString(),
    schedule: {},
    readCredential: async () => ({ ok: true as const, credential: { secret: "app-server", accountId: null, verifiedAccountId: accountId, credentialRevision: revision, expiresAtMilliseconds: null, origin: "vendor_store" as const } }),
    transport: async () => { calls++; return revision.endsWith("before-login") ? { status: 401, body: "", retryAfterSeconds: null } : { status: 200, body: "{}", retryAfterSeconds: null }; }
  };
  try {
    const failed = await runAcquisition([spec], options);
    expect(failed.rows[0]?.availability).toBe("missing_credentials");
    await runAcquisition([spec], { ...options, schedule: failed.schedule, now: new Date(now + 1_000).toISOString() });
    expect(calls).toBe(1);
    revision = "auth-metadata-after-login";
    const collected = await runAcquisition([spec], { ...options, schedule: failed.schedule, now: new Date(now + 1_000).toISOString() });
    expect(calls).toBe(2);
    expect(collected.reports[0]).toEqual(expect.objectContaining({
      ok: true,
      snapshots: [expect.objectContaining({ accountId, meter: "PRIMARY", value: 23 })]
    }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
