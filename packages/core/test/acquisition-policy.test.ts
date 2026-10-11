import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireMachineLease, freshnessPolicy, leasePolicy, mergeAuthoritativeSnapshotCache, retryPolicy, readSnapshotCache, recordAcquisitionAvailability } from "../src/cache.js";
import { shouldStartRefresh } from "../src/acquire/coordination.js";
import { claudeUsageRequest, retryAfterSeconds } from "../src/acquire/transport.js";
import { runAcquisition, type AcquisitionSpec } from "../src/acquire/runner.js";
import { readAcquisitionSchedule, writeAcquisitionSchedule } from "../src/acquire/cadence.js";
import { credentialRevision } from "../src/acquire/identity.js";

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

/* Hotfix 2.1.5: the refusal names the token that was sent, the same digest the
   desktop records, so a rewrite that keeps the token keeps the refusal. */
it("a rewritten credential file releases its refusal only when the token changed", async () => {
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
    expect(calls).toBe(1);
    await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token-rotated" } }));
    await runAcquisition([spec], { ...options, schedule: result.schedule });
    expect(calls).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/*
 * Hotfix 2.1.5, change B. A refusal names the token actually sent, a 401 that
 * raced a rotation asks once more with the new login, and the shared lease
 * carries the refusal so each process releases a refusal the other recorded.
 */
describe("refusal interoperability", () => {
  const pollVectors = JSON.parse(readFileSync(path.resolve("packages/core/src/contracts/claude-poll-vectors.json"), "utf8")) as {
    revision: { vectors: { id: string; token: string; expected: string }[] };
  };
  const revision = (token: string) => pollVectors.revision.vectors.find((vector) => vector.token === token)!.expected;
  const OLD = "synthetic-old-token";
  const NEW = "synthetic-new-token";
  const reading = { provider: "CLAUDE", meter: "FIVE_HOUR", value: 5, unit: "PERCENT", window: { kind: "rolling", durationSeconds: 18_000 }, resetAt: "2026-08-07T15:00:00.000Z", source: "internal_payload", precision: "exact", observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint", automationRisk: "high", verification: "UNVERIFIED" } } as const;
  const claude: AcquisitionSpec = { provider: "CLAUDE", credentialProvider: "CLAUDE", steps: [({ credential }) => claudeUsageRequest(credential.secret)], parse: () => [reading], disclosure: null };
  const harness = (statuses: number[], rotateOnFirst = false) => {
    let token = OLD;
    const sent: string[] = [];
    return {
      sent,
      rotate: (next: string) => { token = next; },
      readCredential: async () => ({ ok: true as const, credential: { secret: token, accountId: null, expiresAtMilliseconds: null, origin: "vendor_store" as const } }),
      transport: async (request: { headers?: Record<string, string> }) => {
        sent.push((request.headers?.["authorization"] ?? "").replace("Bearer ", ""));
        if (rotateOnFirst && sent.length === 1) token = NEW;
        const status = statuses[sent.length - 1] ?? 200;
        return { status, body: status === 200 ? "{}" : "", retryAfterSeconds: null };
      }
    };
  };
  const leaseFile = (dir: string) => JSON.parse(readFileSync(path.join(dir, "acquisition-claude.json"), "utf8")) as Record<string, unknown>;
  const round = (dir: string, machine: ReturnType<typeof harness>, at: number, schedule = {}) =>
    runAcquisition([claude], { stateDirectory: dir, now: new Date(at).toISOString(), schedule, readCredential: machine.readCredential, transport: machine.transport as never });

  it("the shared revision is the SHA-256 of the token, in both languages", () => {
    for (const vector of pollVectors.revision.vectors) expect(credentialRevision(vector.token)).toBe(vector.expected);
  });

  it("a 401 that raced a rotation asks once more with the new login and records no refusal", async () => {
    const dir = await directory();
    try {
      const machine = harness([401, 200], true);
      const result = await round(dir, machine, now);
      expect(machine.sent).toEqual([OLD, NEW]);
      expect(result.rows[0]?.status).toBe("read");
      expect(result.schedule["CLAUDE"]?.refusalRevision).toBeUndefined();
      expect(leaseFile(dir)["refusalRevision"]).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  for (const retried of [401, 403]) {
    it("a refused retry " + retried + " records the rotated login it sent and keeps its day", async () => {
      const dir = await directory();
      try {
        const machine = harness([401, retried], true);
        const first = await round(dir, machine, now);
        expect(machine.sent).toEqual([OLD, NEW]);
        expect(first.schedule["CLAUDE"]?.refusalRevision).toBe(revision(NEW));
        expect(leaseFile(dir)["refusalRevision"]).toBe(revision(NEW));
        const later = await round(dir, machine, now + 60_000, first.schedule);
        expect(later.rows[0]?.status).toBe("waiting");
        expect(machine.sent).toHaveLength(2);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }

  it("an unchanged refusal keeps its day and a rotation releases it", async () => {
    const dir = await directory();
    try {
      const machine = harness([401, 200]);
      const first = await round(dir, machine, now);
      expect(machine.sent).toEqual([OLD]);
      expect(first.schedule["CLAUDE"]?.refusalRevision).toBe(revision(OLD));
      await round(dir, machine, now + 3_600_000, first.schedule);
      expect(machine.sent).toEqual([OLD]);
      machine.rotate(NEW);
      const rotated = await round(dir, machine, now + 3_600_000, first.schedule);
      expect(machine.sent).toEqual([OLD, NEW]);
      expect(rotated.rows[0]?.status).toBe("read");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("releases a refusal the desktop recorded once the login rotates, and only then", async () => {
    const dir = await directory();
    try {
      const deadline = now + 86_400_000;
      await writeFile(path.join(dir, "acquisition-claude.json"), JSON.stringify({ lastAccount: "claude-account", owner: null, expiresAt: 0, token: "", nextAllowedAt: deadline, attempts: 0, refusalRevision: revision(OLD) }));
      const machine = harness([200]);
      const same = await round(dir, machine, now + 60_000);
      expect(same.rows[0]?.status).toBe("waiting");
      expect(machine.sent).toEqual([]);
      machine.rotate(NEW);
      const rotated = await round(dir, machine, now + 60_000);
      expect(machine.sent).toEqual([NEW]);
      expect(rotated.rows[0]?.status).toBe("read");
      const lease = leaseFile(dir);
      expect(lease["refusalRevision"]).toBeNull();
      expect(lease["nextAllowedAt"]).toBeLessThan(deadline);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps a rate limit deadline through a rotation", async () => {
    const dir = await directory();
    try {
      const deadline = now + 7_200_000;
      await writeFile(path.join(dir, "acquisition-claude.json"), JSON.stringify({ lastAccount: null, owner: null, expiresAt: 0, token: "", nextAllowedAt: deadline, attempts: 1, refusalRevision: null }));
      const machine = harness([200]);
      machine.rotate(NEW);
      const result = await round(dir, machine, now + 60_000);
      expect(result.rows[0]?.status).toBe("waiting");
      expect(machine.sent).toEqual([]);
      expect(leaseFile(dir)["nextAllowedAt"]).toBe(deadline);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("a poll that lost its lease mid request never overwrites its successor", async () => {
    const dir = await directory();
    try {
      const file = path.join(dir, "acquisition-claude.json");
      const successor = { lastAccount: "claude-account", owner: "desktop", expiresAt: now + 120_000, token: "desktop-successor", nextAllowedAt: now + 360_000, attempts: 0, refusalRevision: null };
      const machine = harness([]);
      const transport = async () => {
        /* The request outlived its lease and the desktop took the provider over. */
        await writeFile(file, JSON.stringify(successor));
        return { status: 401, body: "", retryAfterSeconds: null };
      };
      await runAcquisition([claude], { stateDirectory: dir, now: new Date(now).toISOString(), schedule: {}, readCredential: machine.readCredential, transport: transport as never });
      expect(leaseFile(dir)).toEqual(successor);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

/* Hotfix 2.1.5, change C: a successful Claude read is next due at the earlier
   of five minutes and the next reset, in the schedule and the shared lease. */
it("schedules the next Claude read at the next reset when it comes before five minutes", async () => {
  for (const [resetIn, dueIn] of [[120_000, 120_000], [3_600_000, 300_000]] as const) {
    const dir = await directory();
    try {
      const resetAt = new Date(now + resetIn).toISOString();
      const spec: AcquisitionSpec = { provider: "CLAUDE", credentialProvider: "CLAUDE", steps: [({ credential }) => claudeUsageRequest(credential.secret)], disclosure: null,
        parse: () => [{ provider: "CLAUDE", meter: "FIVE_HOUR", value: 5, unit: "PERCENT", window: { kind: "rolling", durationSeconds: 18_000 }, resetAt, source: "internal_payload", precision: "exact", observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint", automationRisk: "high", verification: "UNVERIFIED" } }] };
      const result = await runAcquisition([spec], { stateDirectory: dir, now: new Date(now).toISOString(), schedule: {},
        readCredential: async () => ({ ok: true as const, credential: { secret: "fixture", accountId: null, expiresAtMilliseconds: null, origin: "vendor_store" as const } }),
        transport: async () => ({ status: 200, body: "{}", retryAfterSeconds: null }) });
      expect(result.rows[0]?.status).toBe("read");
      expect(result.schedule["CLAUDE"]?.nextAttemptAt).toBe(new Date(now + dueIn).toISOString());
      expect(JSON.parse(readFileSync(path.join(dir, "acquisition-claude.json"), "utf8")).nextAllowedAt).toBe(now + dueIn);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

/*
 * Hotfix 2.1.5 fix 3. With no desktop row veto for Claude, the shared lease
 * and its persisted deadline alone keep the desktop and this tool from both
 * asking. An hour of a desktop on schedule (a read whenever its sixty second
 * tick finds the deadline passed, then the deadline five minutes and a jitter
 * on) beside a status line rendering every ten seconds, with one detached
 * refresh per two minute window, never puts two Claude reads inside one
 * cadence window.
 */
it("a desktop on schedule and a status line every ten seconds read Claude at most once per cadence window", async () => {
  const dir = await directory();
  try {
    const file = path.join(dir, "acquisition-claude.json");
    const calls: { at: number; by: string }[] = [];
    const weekly = (at: number, writer: "desktop" | "cli") => ({
      provider: "CLAUDE" as const, accountId: "claude-account", meter: "SEVEN_DAY", value: 40, unit: "PERCENT" as const,
      window: { kind: "rolling" as const, durationSeconds: 604_800 }, resetAt: new Date(now + 4 * 86_400_000).toISOString(),
      source: "internal_payload" as const, precision: "exact" as const, observedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + 435_000).toISOString(), writer,
      labels: { credentialOrigin: "official-local-tool" as const, dataInterfaceStatus: "internal-endpoint" as const, automationRisk: "high" as const, verification: "UNVERIFIED" as const },
      provenance: { sourceKind: "remote_api" as const, observedVia: "remote_http" as const }
    });
    // One desktop read, the way request_policy.rs takes and completes the shared lease.
    const desktopTick = async (at: number, jitter: number) => {
      let state = { owner: null as string | null, expiresAt: 0, token: "", nextAllowedAt: 0, attempts: 0, lastAccount: "claude-account", refusalRevision: null as string | null };
      try { state = JSON.parse(readFileSync(file, "utf8")) as typeof state; } catch { /* first read */ }
      if ((state.owner !== null && at < state.expiresAt) || at < state.nextAllowedAt) return;
      calls.push({ at, by: "desktop" });
      await writeFile(file, JSON.stringify({ ...state, owner: null, expiresAt: 0, token: "desktop-" + at, nextAllowedAt: Math.max(state.nextAllowedAt, at + 300_000 + jitter), attempts: 0, refusalRevision: null }));
      await mergeAuthoritativeSnapshotCache([weekly(at, "desktop")], dir, new Date(at).toISOString());
    };
    const spec: AcquisitionSpec = { provider: "CLAUDE", credentialProvider: "CLAUDE", steps: [({ credential }) => claudeUsageRequest(credential.secret)], disclosure: null,
      parse: (_payload, observedAt) => [{ ...weekly(Date.parse(observedAt), "cli") }] };
    let schedule = {};
    const windows = new Set<number>();
    for (let at = now; at <= now + 3_600_000; at += 10_000) {
      if ((at - now) % 60_000 === 0) await desktopTick(at, ((at - now) / 60_000 % 7) * 9_000);
      const cached = await readSnapshotCache(dir);
      const decision = shouldStartRefresh(cached.ok ? cached.snapshots : [], new Date(at).toISOString(), 60, true);
      const window = Math.floor(at / 120_000);
      if (!decision.refresh || windows.has(window)) continue;
      windows.add(window);
      const round = await runAcquisition([spec], { stateDirectory: dir, now: new Date(at).toISOString(), schedule,
        readCredential: async () => ({ ok: true as const, credential: { secret: "fixture", accountId: null, expiresAtMilliseconds: null, origin: "vendor_store" as const } }),
        transport: async () => { calls.push({ at, by: "cli" }); return { status: 200, body: "{}", retryAfterSeconds: null }; } });
      schedule = round.schedule;
      for (const report of round.reports) if (report.ok) await mergeAuthoritativeSnapshotCache(report.snapshots, dir, new Date(at).toISOString());
    }
    const times = calls.map((call) => call.at).sort((left, right) => left - right);
    expect(times.length).toBeGreaterThanOrEqual(8);
    for (let index = 1; index < times.length; index += 1) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(300_000);
    expect(calls.some((call) => call.by === "desktop")).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
