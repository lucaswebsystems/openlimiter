import { describe, expect, it } from "vitest";
import {
  applyCollectionReport,
  buildAdvice,
  collectionIdentity,
  readSuppressions,
  snapshotBelongsTo,
  visibleSnapshots,
  MAX_CACHE_SUPPRESSIONS,
  type CacheState,
  type CacheSuppression,
  type CollectionReport
} from "../src/index.js";
import { snapshot } from "./helpers.js";

/**
 * The drift contract.
 *
 * The claim these tests exist to hold: a provider whose interface changed goes
 * unknown IMMEDIATELY and EVERYWHERE, and a provider that merely had a bad
 * minute keeps the reading it already had. Getting those two the wrong way
 * round is the difference between a meter that is honest and a meter that is
 * confidently wrong, so both directions are tested rather than one.
 */

const NOW = "2026-01-01T00:10:00.000Z";
const EARLIER = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:20:00.000Z";

function empty(): CacheState {
  return { snapshots: [], suppressions: [] };
}

function codexRow(overrides: Parameters<typeof snapshot>[0] = {}) {
  return snapshot({
    provider: "CODEX",
    meter: "PRIMARY",
    observedAt: EARLIER,
    expiresAt: LATER,
    ...overrides
  });
}

function successReport(
  snapshots: readonly ReturnType<typeof snapshot>[],
  observedAt = NOW,
  accountId?: string
): CollectionReport {
  return {
    ok: true,
    provider: "CODEX",
    observedAt,
    snapshots,
    ...(accountId === undefined ? {} : { accountId })
  };
}

function failureReport(
  reason: Extract<CollectionReport, { ok: false }>["reason"],
  observedAt = NOW,
  accountId?: string
): CollectionReport {
  return {
    ok: false,
    provider: "CODEX",
    observedAt,
    reason,
    ...(accountId === undefined ? {} : { accountId })
  };
}

describe("collection identity", () => {
  it("keeps an absent account distinct from an account called default", () => {
    expect(collectionIdentity("CODEX")).not.toBe(collectionIdentity("CODEX", "default"));
  });

  it("matches a row on provider and account together", () => {
    const row = codexRow({ accountId: "work" });
    expect(snapshotBelongsTo(row, "CODEX", "work")).toBe(true);
    expect(snapshotBelongsTo(row, "CODEX", "personal")).toBe(false);
    expect(snapshotBelongsTo(row, "CODEX")).toBe(false);
    expect(snapshotBelongsTo(row, "OPENROUTER", "work")).toBe(false);
  });

  it("matches a row with no account only against a report with no account", () => {
    const row = codexRow();
    expect(snapshotBelongsTo(row, "CODEX")).toBe(true);
    expect(snapshotBelongsTo(row, "CODEX", "work")).toBe(false);
  });
});

describe("applying a collection report", () => {
  it("replaces the rows of one identity and leaves every other provider alone", () => {
    const other = snapshot({ provider: "OPENROUTER", meter: "CREDITS" });
    const before: CacheState = {
      snapshots: [codexRow({ value: 10 }), other],
      suppressions: []
    };
    const after = applyCollectionReport(
      before,
      successReport([codexRow({ value: 90, observedAt: NOW })])
    );
    const codex = after.snapshots.filter((row) => row.provider === "CODEX");
    expect(codex).toHaveLength(1);
    expect(codex[0]?.value).toBe(90);
    expect(after.snapshots).toContainEqual(other);
  });

  it("drops a meter a successful run stopped reporting", () => {
    /* A run that comes back with fewer meters than last time must not leave the
       missing one behind looking fresh: it was not observed this run. */
    const before: CacheState = {
      snapshots: [codexRow({ meter: "PRIMARY" }), codexRow({ meter: "SECONDARY" })],
      suppressions: []
    };
    const after = applyCollectionReport(
      before,
      successReport([codexRow({ meter: "PRIMARY", observedAt: NOW })])
    );
    expect(after.snapshots.map((row) => row.meter)).toEqual(["PRIMARY"]);
  });

  it("removes the rows and records a suppression on drift", () => {
    const before: CacheState = { snapshots: [codexRow()], suppressions: [] };
    const after = applyCollectionReport(before, failureReport("drift"));
    expect(after.snapshots).toHaveLength(0);
    expect(after.suppressions).toEqual([
      { provider: "CODEX", reason: "drift", suppressedAt: NOW }
    ]);
  });

  it("replaces an earlier suppression rather than accumulating them", () => {
    const first = applyCollectionReport(
      { snapshots: [codexRow()], suppressions: [] },
      failureReport("drift", NOW)
    );
    const second = applyCollectionReport(first, failureReport("drift", LATER));
    expect(second.suppressions).toHaveLength(1);
    expect(second.suppressions[0]?.suppressedAt).toBe(LATER);
  });

  it("keeps one suppression per account of the same provider", () => {
    let state = applyCollectionReport(empty(), failureReport("drift", NOW, "work"));
    state = applyCollectionReport(state, failureReport("drift", NOW, "personal"));
    expect(state.suppressions).toHaveLength(2);
  });

  it("preserves the prior row through every failure that is not drift", () => {
    /* A dropped packet says nothing about whether the reading we hold is still
       true, so it must not throw it away: the freshness rule ages it out. */
    for (const reason of [
      "network",
      "authentication",
      "rate_limited",
      "remote_error",
      "local_io"
    ] as const) {
      const before: CacheState = { snapshots: [codexRow()], suppressions: [] };
      const after = applyCollectionReport(before, failureReport(reason));
      expect(after).toEqual(before);
    }
  });

  it("clears the suppression when a later run parses again", () => {
    const drifted = applyCollectionReport(
      { snapshots: [codexRow()], suppressions: [] },
      failureReport("drift", NOW)
    );
    expect(drifted.suppressions).toHaveLength(1);
    const recovered = applyCollectionReport(
      drifted,
      successReport([codexRow({ value: 33, observedAt: LATER })], LATER)
    );
    expect(recovered.suppressions).toHaveLength(0);
    expect(visibleSnapshots(recovered).map((row) => row.value)).toEqual([33]);
  });

  it("ignores a report whose instant cannot be read", () => {
    const before: CacheState = { snapshots: [codexRow()], suppressions: [] };
    expect(applyCollectionReport(before, failureReport("drift", "not a date"))).toEqual(
      before
    );
    expect(
      applyCollectionReport(before, successReport([codexRow()], "not a date"))
    ).toEqual(before);
  });

  it("bounds the suppression list", () => {
    let state = empty();
    for (let index = 0; index < MAX_CACHE_SUPPRESSIONS + 10; index += 1) {
      state = applyCollectionReport(state, {
        ok: false,
        provider: "CODEX",
        accountId: "a" + String(index),
        observedAt: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
        reason: "drift"
      });
    }
    expect(state.suppressions.length).toBe(MAX_CACHE_SUPPRESSIONS);
  });
});

describe("what a read may see", () => {
  it("hides a row observed before the suppression that covers it", () => {
    const state: CacheState = {
      snapshots: [codexRow({ observedAt: EARLIER })],
      suppressions: [{ provider: "CODEX", reason: "drift", suppressedAt: NOW }]
    };
    expect(visibleSnapshots(state)).toHaveLength(0);
  });

  it("hides a row observed in the same instant as the suppression", () => {
    /* Not newer means not shown. A row observed in the same millisecond as the
       drift is the very row the drift was about. */
    const state: CacheState = {
      snapshots: [codexRow({ observedAt: NOW })],
      suppressions: [{ provider: "CODEX", reason: "drift", suppressedAt: NOW }]
    };
    expect(visibleSnapshots(state)).toHaveLength(0);
  });

  it("shows a row observed strictly after the suppression", () => {
    const state: CacheState = {
      snapshots: [codexRow({ observedAt: LATER })],
      suppressions: [{ provider: "CODEX", reason: "drift", suppressedAt: NOW }]
    };
    expect(visibleSnapshots(state)).toHaveLength(1);
  });

  it("hides a row whose own observation cannot be read", () => {
    const state: CacheState = {
      snapshots: [codexRow({ observedAt: "not a date" })],
      suppressions: [{ provider: "CODEX", reason: "drift", suppressedAt: NOW }]
    };
    expect(visibleSnapshots(state)).toHaveLength(0);
  });

  it("suppresses one account without touching another", () => {
    const state: CacheState = {
      snapshots: [
        codexRow({ accountId: "work", observedAt: EARLIER }),
        codexRow({ accountId: "personal", observedAt: EARLIER })
      ],
      suppressions: [
        { provider: "CODEX", accountId: "work", reason: "drift", suppressedAt: NOW }
      ]
    };
    expect(visibleSnapshots(state).map((row) => row.accountId)).toEqual(["personal"]);
  });

  it("suppresses one provider without touching another", () => {
    const state: CacheState = {
      snapshots: [
        codexRow({ observedAt: EARLIER }),
        snapshot({ provider: "OPENROUTER", meter: "CREDITS", observedAt: EARLIER })
      ],
      suppressions: [{ provider: "CODEX", reason: "drift", suppressedAt: NOW }]
    };
    expect(visibleSnapshots(state).map((row) => row.provider)).toEqual(["OPENROUTER"]);
  });
});

describe("reading a suppression list back", () => {
  it("reads an absent list as none, because that is what it is", () => {
    expect(readSuppressions(undefined)).toEqual({ ok: true, suppressions: [] });
    expect(readSuppressions(null)).toEqual({ ok: true, suppressions: [] });
  });

  it("reads a well formed list", () => {
    const entry: CacheSuppression = {
      provider: "CODEX",
      accountId: "work",
      reason: "drift",
      suppressedAt: NOW
    };
    expect(readSuppressions([entry])).toEqual({ ok: true, suppressions: [entry] });
  });

  it("refuses every malformed shape whole rather than salvaging part of it", () => {
    /* Salvaging would silently un suppress whichever entries failed to parse,
       which is the one outcome a suppression list must never produce. */
    const hostile: unknown[] = [
      "not an array",
      42,
      {},
      [null],
      [[]],
      [{ provider: "EVILCORP", reason: "drift", suppressedAt: NOW }],
      [{ provider: "CODEX", reason: "network", suppressedAt: NOW }],
      [{ provider: "CODEX", reason: "drift" }],
      [{ provider: "CODEX", reason: "drift", suppressedAt: "not a date" }],
      [{ provider: "CODEX", reason: "drift", suppressedAt: 12345 }],
      [{ provider: "CODEX", accountId: "Work", reason: "drift", suppressedAt: NOW }],
      [{ provider: "CODEX", accountId: "../evil", reason: "drift", suppressedAt: NOW }],
      [{ provider: "CODEX", accountId: 7, reason: "drift", suppressedAt: NOW }]
    ];
    for (const value of hostile) {
      expect(readSuppressions(value)).toEqual({ ok: false });
    }
  });

  it("refuses a list over its bound", () => {
    const many = Array.from({ length: MAX_CACHE_SUPPRESSIONS + 1 }, (_, index) => ({
      provider: "CODEX",
      accountId: "a" + String(index),
      reason: "drift",
      suppressedAt: NOW
    }));
    expect(readSuppressions(many)).toEqual({ ok: false });
  });
});

describe("advice never sees a suppressed row", () => {
  it("reports a drifted provider unknown while its neighbour still reads", () => {
    const rows = [
      codexRow({ value: 5, observedAt: EARLIER, expiresAt: LATER }),
      snapshot({
        provider: "OPENROUTER",
        meter: "CREDITS",
        value: 40,
        observedAt: EARLIER,
        expiresAt: LATER
      })
    ];
    const before = buildAdvice(rows, NOW, ["CODEX", "OPENROUTER"]);
    /* Codex is the lowest reading, so before the drift it is the recommendation.
       That is exactly why suppressing it has to work: the wrong answer here is
       not a missing row, it is an agent being sent to a provider whose meter we
       can no longer read. */
    expect(before.recommendation).toEqual({
      code: "PREFER",
      provider: "CODEX",
      reason: "LOWEST_USAGE"
    });

    const state = applyCollectionReport(
      { snapshots: rows, suppressions: [] },
      failureReport("drift", NOW)
    );
    const after = buildAdvice(visibleSnapshots(state), NOW, ["CODEX", "OPENROUTER"]);
    expect(after.unknownProviders).toContain("CODEX");
    expect(after.providers.map((entry) => entry.provider)).toEqual(["OPENROUTER"]);
    expect(after.recommendation).toEqual({
      code: "PREFER",
      provider: "OPENROUTER",
      reason: "LOWEST_USAGE"
    });
  });

  it("restores the provider once a later run parses again", () => {
    const drifted = applyCollectionReport(
      { snapshots: [codexRow({ value: 5 })], suppressions: [] },
      failureReport("drift", NOW)
    );
    expect(buildAdvice(visibleSnapshots(drifted), NOW, ["CODEX"]).reason).toBe("UNKNOWN");

    const recovered = applyCollectionReport(
      drifted,
      successReport(
        [
          codexRow({
            value: 5,
            observedAt: LATER,
            expiresAt: "2026-01-01T00:30:00.000Z"
          })
        ],
        LATER
      )
    );
    const advice = buildAdvice(visibleSnapshots(recovered), LATER, ["CODEX"]);
    expect(advice.reason).toBe("HEALTHY");
    expect(advice.providers).toHaveLength(1);
  });
});
