import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { opaqueAccountId, credentialIdentityMaterial, acquisitionAccountId } from "../src/acquire/identity.js";
import { readCredentialDocument, type AcquisitionProvider } from "../src/acquire/credentials.js";
import { applyCollectionReport } from "../src/collection.js";
import { freshnessPolicy, projectSnapshots, retainSnapshots, RETENTION_MILLISECONDS } from "../src/data-rules.js";
import { mergeSnapshotCache, mergeAcquiredSnapshots, readSnapshotCache } from "../src/cache.js";
import type { ProviderCode, Snapshot } from "../src/types.js";
import { freshness } from "../src/freshness.js";
import { snapshot } from "./helpers.js";

const vectors = JSON.parse(readFileSync(path.resolve("packages/core/src/contracts/identity-vectors.json"), "utf8")) as { provider: ProviderCode; material: string; expected: string }[];
describe("Rust and TS account identity parity", () => {
  for (const row of vectors) it(row.provider + " " + row.material, () => expect(opaqueAccountId(row.provider, row.material)).toBe(row.expected));
});
const now = "2026-09-29T12:00:00.000Z";
const at = Date.parse(now);
const measured = (accountId?: string) => snapshot({ observedAt: now, expiresAt: "2026-09-29T12:20:00.000Z", kind: "quota_percent", ...(accountId ? { accountId } : {}) });

it("desktop freshness mirrors every provider cadence and CLI keeps its longer cadence", () => {
  for (const provider of ["CLAUDE", "CODEX", "GEMINI_CLI", "ANTIGRAVITY", "GROK", "KIMI", "CURSOR", "OPENROUTER", "OPENCODE"]) {
    const ttlSeconds = ["CLAUDE", "GEMINI_CLI"].includes(provider) ? 1140 : provider === "ANTIGRAVITY" ? 780 : 420;
    expect(freshnessPolicy({ provider, writer: "desktop", sourceClass: "internal_payload", observedAt: now, now }).ttlSeconds).toBe(ttlSeconds);
    expect(freshnessPolicy({ provider, writer: "cli", sourceClass: "internal_payload", observedAt: now, now }).ttlSeconds).toBe(1140);
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
    ANTIGRAVITY: { token: { access_token: "fixture", account_id } },
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

it("extra usage past its cap is still a reading, never a placeholder", () => {
  // Claude's extra usage has no billing cadence; $25 spent of a $20 cap is real.
  const spend = { ...measured("fixture"), meter: "EXTRA_USAGE", window: { kind: "unknown" as const }, kind: "spend" as const,
    value: 100, usedAmount: 25, limitAmount: 20, currency: "USD" as const };
  expect(projectSnapshots([spend], now).snapshots).toHaveLength(1);
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

  it("only Claude status line rows are held: every other source keeps its own expiry", () => {
    const others = [
      anonymous({ provider: "CODEX" }),
      statusline({ provenance: { sourceKind: "remote_api", observedVia: "local_event" }, source: "internal_payload" }),
      anonymous({ provider: "ANTIGRAVITY", provenance: { sourceKind: "statusline_payload", observedVia: "local_command" } })
    ];
    const projection = projectSnapshots(others, later(45), active);
    expect(projection.snapshots).toEqual([]);
    expect(projection.flags.map(flag => flag.reason)).toEqual(["stale", "stale", "stale"]);
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
