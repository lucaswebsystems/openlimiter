import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CACHE_ENTRIES,
  applyCollectionReport,
  mergeAcquiredSnapshots,
  mergeAuthoritativeSnapshotCache,
  mergeSnapshots,
  readCacheState,
  writeSnapshotCache,
  type ProviderCode,
  type Snapshot
} from "../src/index.js";
import { snapshot } from "./helpers.js";

const created: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "openlimiter-merge-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("snapshot merge", () => {
  it("replaces one meter and keeps every other meter", () => {
    const existing = [
      snapshot({ meter: "FIVE_HOUR", value: 42 }),
      snapshot({ provider: "MANUAL", meter: "MONTHLY", value: 10 })
    ];
    const merged = mergeSnapshots(existing, [snapshot({ meter: "FIVE_HOUR", value: 61 })]);
    expect(merged).toHaveLength(2);
    expect(merged.find((entry) => entry.meter === "FIVE_HOUR")?.value).toBe(61);
    expect(merged.find((entry) => entry.meter === "MONTHLY")?.value).toBe(10);
  });

  it("orders the result the same way for the same input", () => {
    const first = mergeSnapshots(
      [snapshot({ meter: "SEVEN_DAY" }), snapshot({ meter: "FIVE_HOUR" })],
      []
    );
    const second = mergeSnapshots(
      [snapshot({ meter: "FIVE_HOUR" }), snapshot({ meter: "SEVEN_DAY" })],
      []
    );
    expect(first.map((entry) => entry.meter)).toEqual(second.map((entry) => entry.meter));
  });

  it("stays bounded and keeps the most recently observed rows", () => {
    const existing = Array.from({ length: MAX_CACHE_ENTRIES + 8 }, (_unused, index) =>
      snapshot({
        meter: "METER_" + String(index),
        observedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000)
          .toISOString(),
        expiresAt: new Date(Date.parse("2026-01-01T01:00:00.000Z") + index * 1_000)
          .toISOString()
      }));
    const merged = mergeSnapshots(existing, []);
    expect(merged).toHaveLength(MAX_CACHE_ENTRIES);
    expect(merged.some((entry) => entry.meter === "METER_0")).toBe(false);
    expect(
      merged.some((entry) => entry.meter === "METER_" + String(MAX_CACHE_ENTRIES + 7))
    ).toBe(true);
  });

  it("keeps the Claude statusline behind a current OAuth account", () => {
    const oauth = snapshot({
      accountId: "claude-personal",
      observedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:20:00.000Z",
      source: "internal_payload",
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" }
    });
    const statusline = snapshot({
      observedAt: "2026-01-01T00:10:00.000Z",
      expiresAt: "2026-01-01T00:15:00.000Z",
      provenance: {
        sourceKind: "statusline_payload",
        observedVia: "claude_code_statusline"
      }
    });
    const merged = mergeSnapshots([oauth], [statusline]);
    expect(merged).toEqual([oauth]);
  });

  it("restores the Claude statusline after the OAuth account expires", () => {
    const oauth = snapshot({
      accountId: "claude-personal",
      observedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:20:00.000Z",
      source: "internal_payload",
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" }
    });
    const statusline = snapshot({
      observedAt: "2026-01-01T00:21:00.000Z",
      expiresAt: "2026-01-01T00:26:00.000Z",
      provenance: {
        sourceKind: "statusline_payload",
        observedVia: "claude_code_statusline"
      }
    });
    const merged = mergeSnapshots([oauth], [statusline]);
    expect(merged).toHaveLength(2);
    expect(merged.some((entry) => entry.accountId === undefined)).toBe(true);
  });

  it("does not demote an explicit Claude import", () => {
    const oauth = snapshot({
      accountId: "claude-personal",
      expiresAt: "2026-01-01T00:20:00.000Z",
      source: "internal_payload",
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" }
    });
    const imported = snapshot({
      observedAt: "2026-01-01T00:10:00.000Z",
      provenance: { sourceKind: "explicit_ingest", observedVia: "ingest_command" }
    });
    expect(mergeSnapshots([oauth], [imported])).toHaveLength(2);
  });
});

/*
 * 2.1.6: Claude readings are ordered by certainty first and content second.
 * Every merge that reconciles two rows for one meter keeps the row the shared
 * vectors name, with its marker and its certainty. Rust twin:
 * native_snapshot.rs, every_shared_claude_order_vector.
 */
describe("Claude readings ordered by certainty and content, shared with the desktop", () => {
  interface Side {
    value: number; resetAt: string | null; observedAt: string; availability?: Snapshot["availability"];
    via?: "poll" | "statusline"; certain?: boolean;
  }
  interface Vector { id: string; provider?: ProviderCode; meter?: string; held: Side; incoming: Side; expected: "held" | "incoming" }
  const vectors = (JSON.parse(readFileSync(path.resolve("packages/core/src/contracts/claude-poll-vectors.json"), "utf8")) as {
    order: { vectors: Vector[] };
  }).order.vectors;
  const row = (vector: Vector, side: Side): Snapshot => {
    const meter = vector.meter ?? "FIVE_HOUR";
    return snapshot({
      provider: vector.provider ?? "CLAUDE",
      meter,
      accountId: "vector-account",
      value: side.value,
      resetAt: side.resetAt,
      window: meter === "FIVE_HOUR" ? { kind: "rolling", durationSeconds: 18_000 }
        : meter.startsWith("SEVEN_DAY") ? { kind: "rolling", durationSeconds: 604_800 } : { kind: "unknown" },
      source: "internal_payload",
      observedAt: side.observedAt,
      expiresAt: new Date(Date.parse(side.observedAt) + 465_000).toISOString(),
      labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint", automationRisk: "high", verification: "UNVERIFIED" },
      provenance: side.via === "statusline"
        ? { sourceKind: "statusline_payload", observedVia: "claude_code_statusline" }
        : { sourceKind: "remote_api", observedVia: "remote_http" },
      ...(side.certain === undefined ? {} : { certain: side.certain }),
      ...(side.availability === undefined ? {} : { availability: side.availability })
    });
  };
  const kept = (rows: readonly Snapshot[]) => rows.map(({ value, observedAt, availability, certain }) =>
    ({ value, observedAt, availability: availability ?? null, certain: certain ?? null }));
  for (const vector of vectors) {
    it(vector.id, async () => {
      const held = row(vector, vector.held);
      const incoming = row(vector, vector.incoming);
      const { value, observedAt, availability, certain } = vector[vector.expected];
      const expected = [{ value, observedAt, availability: availability ?? null, certain: certain ?? null }];
      expect(kept(mergeSnapshots([held], [incoming])), "mergeSnapshots").toEqual(expected);
      const report = { ok: true as const, provider: incoming.provider, accountId: "vector-account", observedAt: incoming.observedAt, snapshots: [incoming] };
      expect(kept(applyCollectionReport({ snapshots: [held], suppressions: [] }, report).snapshots), "applyCollectionReport")
        .toEqual(expected);
      const acquired = await temporaryDirectory();
      await writeSnapshotCache([held], acquired);
      await mergeAcquiredSnapshots(report, acquired);
      const state = await readCacheState(acquired);
      expect(kept(state.ok ? state.state.snapshots : []), "mergeAcquiredSnapshots").toEqual(expected);
      const authoritative = await temporaryDirectory();
      await mergeAuthoritativeSnapshotCache([held], authoritative, held.observedAt);
      expect(kept(await mergeAuthoritativeSnapshotCache([incoming], authoritative, incoming.observedAt)), "mergeAuthoritativeSnapshotCache")
        .toEqual(expected);
    });
  }
});
