import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { opaqueAccountId, credentialIdentityMaterial, acquisitionAccountId } from "../src/acquire/identity.js";
import { readCredentialDocument, type AcquisitionProvider } from "../src/acquire/credentials.js";
import { applyCollectionReport } from "../src/collection.js";
import { CLAUDE_FRESHNESS_SECONDS, freshnessPolicy, projectSnapshots, resetPassed, retainSnapshots, RETENTION_MILLISECONDS } from "../src/data-rules.js";
import { CLAUDE_ACQUISITION_INTERVAL_SECONDS } from "../src/acquire/cadence.js";
import { ACQUISITION_TIMEOUT_MILLISECONDS } from "../src/acquire/transport.js";
import { mergeAuthoritativeSnapshotCache, mergeSnapshotCache, mergeAcquiredSnapshots, readSnapshotCache } from "../src/cache.js";
import { buildAdvice } from "../src/policy.js";
import type { ProviderCode, Snapshot } from "../src/types.js";
import { freshness } from "../src/freshness.js";
import { snapshot } from "./helpers.js";

const vectors = JSON.parse(readFileSync(path.resolve("packages/core/src/contracts/identity-vectors.json"), "utf8")) as { provider: ProviderCode; material: string; expected: string }[];
describe("Rust and TS account identity parity", () => {
  for (const row of vectors) it(row.provider + " " + row.material, () => expect(opaqueAccountId(row.provider, row.material)).toBe(row.expected));
});
const now = "2026-09-29T12:00:00.000Z";
const at = Date.parse(now);
/* No reset stated: these rows test freshness and identity, and since hotfix
   2.1.5 a reset that already passed withdraws a reading on its own. */
const measured = (accountId?: string) => snapshot({ observedAt: now, expiresAt: "2026-09-29T12:20:00.000Z", resetAt: null, kind: "quota_percent", ...(accountId ? { accountId } : {}) });

it("hides the unverified legacy Cursor bars from every projected surface", () => {
  const rows = ["AUTO", "API", "INCLUDED"].map((meter) => snapshot({
    provider: "CURSOR",
    meter,
    observedAt: now,
    expiresAt: "2026-09-29T12:20:00.000Z",
  }));
  expect(projectSnapshots(rows, now)).toEqual({ snapshots: [], flags: [] });
});

it("desktop freshness mirrors every provider cadence and CLI keeps its longer cadence", () => {
  for (const provider of ["CLAUDE", "CODEX", "GEMINI_CLI", "ANTIGRAVITY", "GROK", "KIMI", "CURSOR", "OPENROUTER", "OPENCODE"]) {
    /* Claude, from either writer, follows its own five minute cadence (fix 2). */
    const ttlSeconds = provider === "CLAUDE" ? 465 : provider === "GEMINI_CLI" ? 1140 : provider === "ANTIGRAVITY" ? 780 : 420;
    expect(freshnessPolicy({ provider, writer: "desktop", sourceClass: "internal_payload", observedAt: now, now }).ttlSeconds).toBe(ttlSeconds);
    expect(freshnessPolicy({ provider, writer: "cli", sourceClass: "internal_payload", observedAt: now, now }).ttlSeconds).toBe(provider === "CLAUDE" ? 465 : 1140);
  }
});

it("explicit identity wins over hint, access claims, then ID claims", () => {
  const jwt = (claims: object) => "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature";
  expect(credentialIdentityMaterial({ account_id: "explicit" }, {}, jwt({ sub: "access" }), "hint")).toBe("explicit");
  expect(credentialIdentityMaterial({}, {}, jwt({ sub: "access" }), "hint")).toBe("hint");
  expect(credentialIdentityMaterial({ id_token: jwt({ sub: "id" }) }, {}, jwt({ account_id: "access" }))).toBe("access");
  expect(credentialIdentityMaterial({ id_token: jwt({ sub: "id" }) }, {}, "opaque")).toBe("id");
});

it("credential parsing stamps the Rust identity for every file based acquisition provider", () => {
  const account_id = "fixture-account-a";
  const documents: Partial<Record<AcquisitionProvider, unknown>> = {
    CLAUDE: { claudeAiOauth: { accessToken: "fixture", accountUuid: account_id } },
    CODEX: { tokens: { access_token: "fixture", account_id } },
    GEMINI_CLI: { access_token: "fixture", account_id },
    GROK: { auth: { key: "fixture", user_id: account_id } },
    KIMI: { oauth: { access_token: "fixture", account_id } },
    OPENROUTER: { credentials: { api_key: "fixture", account_id } }
  };
  for (const [provider, document] of Object.entries(documents)) {
    const parsed = readCredentialDocument(provider as AcquisitionProvider, document, at);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(acquisitionAccountId(provider as ProviderCode, parsed.credential)).toBe(vectors.find(row => row.provider === provider && row.material === account_id)?.expected);
  }
  for (const [provider, claims] of [["CODEX", { chatgpt_account_id: account_id }], ["GROK", { sub: account_id }]] as const) {
    const token = "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature";
    const parsed = readCredentialDocument(provider, { access_token: token }, at);
    expect(parsed.ok && parsed.credential.accountId).toBe(account_id);
    if (parsed.ok) expect(acquisitionAccountId(provider, parsed.credential)).toBe(vectors.find(row => row.provider === provider && row.material === account_id)?.expected);
  }
});

it("two simultaneous accounts stay distinct and anonymous rows do not merge", () => {
  const a = acquisitionAccountId("CLAUDE", { secret: "fixture", accountId: "a" });
  const b = acquisitionAccountId("CLAUDE", { secret: "fixture", accountId: "b" });
  const rows = [measured(a), measured(b), measured()];
  const projection = projectSnapshots(rows, now, new Map([["CLAUDE", new Set([a, b])]]));
  expect(projection.snapshots.map(row => row.accountId)).toEqual([a, b]);
  expect(projection.flags[0]?.reason).toBe("account_not_connected");
  const state = applyCollectionReport({ snapshots: rows, suppressions: [] }, { provider: "CLAUDE", accountId: b, observedAt: now, ok: true, snapshots: [measured(b)] });
  expect(state.snapshots).toHaveLength(3);
});

it("a delayed observation after switching cannot become the active account", () => {
  const old = measured("claude-old");
  const current = measured("claude-current");
  const state = applyCollectionReport({ snapshots: [current], suppressions: [] }, { provider: "CLAUDE", accountId: "claude-old", ok: true, observedAt: now, snapshots: [old] });
  expect(projectSnapshots(state.snapshots, now, new Map([["CLAUDE", new Set(["claude-current"])]] )).snapshots.map(row => row.accountId)).toEqual(["claude-current"]);
});

for (const [source, interval] of [["native_payload", 60], ["internal_payload", 900], ["documented_api", 900]] as const) {
  it(source + " tolerates jitter and latency, expires after sleep or failure, recovers on a new observation", () => {
    const policy = (milliseconds: number, observedAt = now) => freshnessPolicy({ sourceClass: source, observedAt, now: new Date(milliseconds).toISOString() }).availability;
    expect(policy(at + interval * 1200 + 59_999)).toBe("fresh");
    expect(policy(at + interval * 1200 + 60_000)).toBe("stale");
    expect(policy(at + 86_400_000)).toBe("stale");
    expect(policy(at + 86_400_000, new Date(at + 86_400_000).toISOString())).toBe("fresh");
    expect(policy(at - 1)).toBe("unavailable");
  });
}

it("measured zero survives while placeholders, stale rows and availability become specific flags", () => {
  const row = measured("fixture");
  const projected = projectSnapshots([{ ...row, value: 0 }, { ...row, availability: "expired_credentials" }, { ...row, window: { kind: "unknown" } }, { ...row, observedAt: "2026-09-01T00:00:00.000Z" }], now);
  expect(projected.snapshots).toHaveLength(1);
  expect(projected.flags.map(flag => flag.fixKind)).toEqual(["open_app", "unsupported", "open_app"]);
});

it("a quiet Antigravity card stays, stale with its age, for seven days instead of vanishing", () => {
  // The founder's case: the status line wrote yesterday and Antigravity CLI is closed.
  const row = snapshot({
    provider: "ANTIGRAVITY", accountId: "antigravity-account", observedAt: now, expiresAt: "2026-09-29T12:13:00.000Z", resetAt: null,
    provenance: { sourceKind: "statusline_payload", observedVia: "antigravity_cli_statusline" }
  });
  const dayLater = new Date(at + 86_400_000).toISOString();
  const shown = projectSnapshots([row], dayLater);
  expect(shown.flags).toEqual([]);
  expect(shown.snapshots.map(held => [held.value, freshness(held.observedAt, held.expiresAt, dayLater)])).toEqual([[row.value, "stale"]]);
  expect(projectSnapshots([row], new Date(at + RETENTION_MILLISECONDS).toISOString()).snapshots).toHaveLength(1);
  const gone = projectSnapshots([row], new Date(at + RETENTION_MILLISECONDS + 1).toISOString());
  expect(gone.snapshots).toEqual([]);
  expect(gone.flags.map(flag => flag.reason)).toEqual(["stale"]);
});

it("extra usage past its cap is still a reading, never a placeholder", () => {
  // Claude's extra usage has no billing cadence; $25 spent of a $20 cap is real.
  const spend = { ...measured("fixture"), meter: "EXTRA_USAGE", window: { kind: "unknown" as const }, kind: "spend" as const,
    value: 100, usedAmount: 25, limitAmount: 20, currency: "USD" as const };
  expect(projectSnapshots([spend], now).snapshots).toHaveLength(1);
});

it("projects only the poll owned Claude weeklies", () => {
  const poll = snapshot({
    meter: "SEVEN_DAY",
    value: 13,
    observedAt: now,
    // The Claude horizon, 465 seconds (hotfix 2.1.5).
    expiresAt: "2026-09-29T12:07:45.000Z",
    resetAt: "2026-10-06T12:00:00.000Z",
    window: { kind: "rolling", durationSeconds: 604_800 },
    source: "internal_payload",
    provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
  });
  const payload = { ...poll, value: 67, provenance: { sourceKind: "statusline_payload" as const, observedVia: "claude_code_statusline" as const } };
  const unknown = { ...poll, meter: "SEVEN_DAY_IGUANA_NECKTIE" };
  expect(projectSnapshots([payload, unknown, poll], now).snapshots).toEqual([poll]);
});

it("all cache writers prune old accounts at seven days and preserve the boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "d1-cache-"));
  try {
    const old = { ...measured("old"), observedAt: new Date(at - RETENTION_MILLISECONDS - 1).toISOString() };
    const boundary = { ...measured("boundary"), observedAt: new Date(at - RETENTION_MILLISECONDS).toISOString() };
    expect(retainSnapshots([old, boundary], at)).toEqual([boundary]);
    const initial = await mergeSnapshotCache([old, boundary], root, at - RETENTION_MILLISECONDS);
    expect(initial.merged).toHaveLength(2);
    const report = { provider: "CLAUDE" as const, accountId: "current", observedAt: now, ok: true as const, snapshots: [measured("current")] };
    expect(applyCollectionReport({ snapshots: [old, boundary], suppressions: [] }, report).snapshots).toHaveLength(2);
    await mergeAcquiredSnapshots(report, root);
    const read = await readSnapshotCache(root);
    expect(read.ok && read.snapshots.some(row => row.accountId === "old")).toBe(false);
    const final = await mergeSnapshotCache([], root, at + RETENTION_MILLISECONDS + 1);
    expect(final.merged).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe("Claude status line rows: freshness is not visibility", () => {
  const account = opaqueAccountId("CLAUDE", "fixture-a");
  const active = new Map([["CLAUDE", new Set([account])]]);
  const resetAt = "2026-09-29T14:00:00.000Z";
  const statusline = (overrides: Partial<Snapshot> = {}): Snapshot => snapshot({
    provider: "CLAUDE", meter: "FIVE_HOUR", value: 37, source: "native_payload", observedAt: now,
    expiresAt: "2026-09-29T12:01:00.000Z", resetAt, accountId: account,
    provenance: { sourceKind: "statusline_payload", observedVia: "claude_code_statusline" }, ...overrides
  });
  const anonymous = (overrides: Partial<Snapshot> = {}): Snapshot => { const { accountId: _, ...row } = statusline(overrides); return row; };
  const later = (minutes: number) => new Date(at + minutes * 60_000).toISOString();

  it("an idle Claude Code keeps its last reading, marked stale by its age, until that window resets", () => {
    const projection = projectSnapshots([statusline()], later(45), active);
    expect(projection.flags).toEqual([]);
    expect(projection.snapshots.map(row => row.value)).toEqual([37]);
    const [held] = projection.snapshots;
    expect(held && freshness(held.observedAt, held.expiresAt, later(45))).toBe("stale");
    expect(held?.expiresAt).toBe(new Date(at + 132_000).toISOString());
  });

  it("after the reset it waits for Claude Code and never invents a zero", () => {
    const projection = projectSnapshots([statusline()], later(121), active);
    expect(projection.snapshots).toEqual([]);
    expect(projection.flags).toEqual([{ provider: "CLAUDE", accountId: account, reason: "awaiting_statusline", fixKind: "open_app" }]);
    const unknownReset = projectSnapshots([statusline({ resetAt: null })], later(5), active);
    expect(unknownReset.snapshots).toEqual([]);
    expect(unknownReset.flags[0]?.reason).toBe("awaiting_statusline");
  });

  it("every other source is held stale past its window, until the cache lets go of it at seven days", () => {
    /* Their windows reset later than these checks, so only freshness and
       retention are under test here (a reset that passed is its own rule). */
    const laterReset = "2026-10-29T12:00:00.000Z";
    const others = [
      anonymous({ provider: "CODEX", resetAt: laterReset }),
      statusline({ provenance: { sourceKind: "remote_api", observedVia: "local_event" }, source: "internal_payload", resetAt: laterReset }),
      anonymous({ provider: "ANTIGRAVITY", provenance: { sourceKind: "statusline_payload", observedVia: "local_command" }, resetAt: laterReset })
    ];
    const held = projectSnapshots(others, later(121), active);
    expect(held.flags).toEqual([]);
    expect(held.snapshots.map(row => freshness(row.observedAt, row.expiresAt, later(121)))).toEqual(["stale", "stale", "stale"]);
    const gone = projectSnapshots(others, new Date(at + RETENTION_MILLISECONDS + 1).toISOString(), active);
    expect(gone.snapshots).toEqual([]);
    expect(gone.flags.map(flag => flag.reason)).toEqual(["stale", "stale", "stale"]);
  });

  it("an anonymous Claude status line row is never shown and asks to sign in again", () => {
    const projection = projectSnapshots([anonymous()], now, active);
    expect(projection.snapshots).toEqual([]);
    expect(projection.flags).toEqual([{ provider: "CLAUDE", reason: "account_unresolved", fixKind: "sign_in" }]);
    expect(projectSnapshots([statusline({ accountId: opaqueAccountId("CLAUDE", "fixture-b") })], now, active).flags[0]?.reason)
      .toBe("account_not_connected");
  });

  it("Free reads one account and Pro selection reads both, with no anonymous row on either", () => {
    const b = opaqueAccountId("CLAUDE", "fixture-b");
    const rows = [statusline(), statusline({ accountId: b }), anonymous()];
    const free = projectSnapshots(rows, now, active);
    expect(free.snapshots.map(row => row.accountId)).toEqual([account]);
    const pro = projectSnapshots(rows, now, new Map([["CLAUDE", new Set([account, b])]]));
    expect(pro.snapshots.map(row => row.accountId)).toEqual([account, b]);
    expect(pro.flags.map(flag => flag.reason)).toEqual(["account_unresolved"]);
  });
});

/*
 * Hotfix 2.1.5, change D. A reading from before its window reset no longer
 * describes the window, so no surface shows it, fresh or stale, even when the
 * next read fails. Nothing is invented in its place, and storage still keeps
 * it for seven days from its observation. Rust twin: data_rules.rs.
 */
describe("a reading from before its reset is never shown", () => {
  const resetAt = "2026-09-29T14:00:00.000Z";
  const weekly = (overrides: Partial<Snapshot> = {}): Snapshot => snapshot({
    provider: "CLAUDE", meter: "SEVEN_DAY", value: 75, observedAt: "2026-09-29T13:59:00.000Z",
    expiresAt: "2026-09-29T14:18:00.000Z", resetAt, window: { kind: "rolling", durationSeconds: 604_800 },
    source: "internal_payload", provenance: { sourceKind: "remote_api", observedVia: "remote_http" }, ...overrides
  });

  it("shows the reading just before its reset", () => {
    expect(resetPassed(weekly(), "2026-09-29T13:59:59.999Z")).toBe(false);
    expect(projectSnapshots([weekly()], "2026-09-29T13:59:59.999Z").snapshots.map((row) => row.value)).toEqual([75]);
  });

  it("withdraws it exactly at the reset and after, inventing nothing in its place", () => {
    for (const at of [resetAt, "2026-09-29T14:00:00.001Z", "2026-10-02T00:00:00.000Z"]) {
      expect(resetPassed(weekly(), at)).toBe(true);
      const projected = projectSnapshots([weekly()], at);
      expect(projected.snapshots).toEqual([]);
      expect(projected.flags).toEqual([{ provider: "CLAUDE", reason: "stale", fixKind: "open_app" }]);
    }
  });

  it("keeps an unknown reset and a stale reading whose reset is still ahead", () => {
    expect(resetPassed(weekly({ resetAt: null }), "2026-10-02T00:00:00.000Z")).toBe(false);
    const quiet = weekly({ observedAt: "2026-09-29T10:00:00.000Z", expiresAt: "2026-09-29T10:19:00.000Z" });
    const held = projectSnapshots([quiet], "2026-09-29T13:59:00.000Z");
    expect(held.snapshots.map((row) => [row.value, freshness(row.observedAt, row.expiresAt, "2026-09-29T13:59:00.000Z")]))
      .toEqual([[75, "stale"]]);
  });

  it("a Claude status line reading past its reset waits for Claude Code even while fresh", () => {
    const payload = snapshot({
      provider: "CLAUDE", meter: "FIVE_HOUR", value: 37, source: "native_payload", observedAt: "2026-09-29T13:59:30.000Z",
      expiresAt: "2026-09-29T14:00:30.000Z", resetAt,
      provenance: { sourceKind: "statusline_payload", observedVia: "claude_code_statusline" }
    });
    expect(projectSnapshots([payload], "2026-09-29T13:59:59.000Z").snapshots).toHaveLength(1);
    expect(projectSnapshots([payload], "2026-09-29T14:00:10.000Z").flags.map((flag) => flag.reason)).toEqual(["awaiting_statusline"]);
  });

  it("a poll that fails after the reset leaves the reading stored for seven days and never on screen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "d-reset-"));
    try {
      await mergeAuthoritativeSnapshotCache([weekly()], root, "2026-09-29T13:59:00.000Z");
      const after = "2026-09-29T14:05:00.000Z";
      const stored = await readSnapshotCache(root);
      expect(stored.ok && stored.snapshots.map((row) => row.value)).toEqual([75]);
      expect(retainSnapshots(stored.ok ? stored.snapshots : [], Date.parse(after))).toHaveLength(1);
      expect(projectSnapshots(stored.ok ? stored.snapshots : [], after).snapshots).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("never lets a reading whose window reset drive advice, even while fresh", () => {
    const fresh = weekly({ value: 99, observedAt: "2026-09-29T13:59:30.000Z" });
    expect(buildAdvice([fresh], "2026-09-29T13:59:59.000Z", ["CLAUDE"]).reason).toBe("NEAR_CAP");
    expect(buildAdvice([fresh], "2026-09-29T14:00:10.000Z", ["CLAUDE"])).toMatchObject({ reason: "UNKNOWN", providers: [] });
  });
});

/*
 * Hotfix 2.1.5 fix 2. A Claude poll reading is fresh for its own cadence plus
 * the worst healthy delay, from either writer; every other horizon stays.
 * Rust twin: data_rules.rs, every_shared_claude_freshness_vector.
 */
describe("the Claude freshness horizon shared with the desktop", () => {
  const pollVectors = JSON.parse(readFileSync(path.resolve("packages/core/src/contracts/claude-poll-vectors.json"), "utf8")) as {
    freshness: { vectors: { id: string; provider: string; writer: string; sourceClass: string; observedAt: string; now: string; expected: unknown }[] };
  };
  for (const vector of pollVectors.freshness.vectors) {
    it(vector.id, () => {
      expect(freshnessPolicy({
        sourceClass: vector.sourceClass, observedAt: vector.observedAt, now: vector.now, provider: vector.provider,
        ...(vector.writer === "" ? {} : { writer: vector.writer })
      })).toEqual(vector.expected);
    });
  }

  it("is the cadence, the widest jitter, one late tick, two whole requests and a margin", () => {
    expect(CLAUDE_FRESHNESS_SECONDS).toBe(CLAUDE_ACQUISITION_INTERVAL_SECONDS + CLAUDE_ACQUISITION_INTERVAL_SECONDS / 5 + 60 +
      2 * ACQUISITION_TIMEOUT_MILLISECONDS / 1_000 + 15);
  });
});
