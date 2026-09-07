import { describe, expect, it } from "vitest";
import {
  HUB_POLL_ACTIVE_MILLISECONDS,
  HUB_POLL_IDLE_MILLISECONDS,
  HUB_POLL_RECENT_WRITE_MILLISECONDS,
  hubPollIntervalMilliseconds,
  mostRecentObservedAt,
} from "@/lib/hub-polling";
import type { SyncedProviderUsage } from "@/lib/synced-usage";

const NOW = 1_800_000_000_000;

describe("the background poll's cadence", () => {
  it("is sixty seconds right at the fifteen minute boundary, and five minutes just past it", () => {
    const justInside = new Date(NOW - HUB_POLL_RECENT_WRITE_MILLISECONDS).toISOString();
    const justOutside = new Date(NOW - HUB_POLL_RECENT_WRITE_MILLISECONDS - 1).toISOString();
    expect(hubPollIntervalMilliseconds(justInside, NOW)).toBe(HUB_POLL_ACTIVE_MILLISECONDS);
    expect(hubPollIntervalMilliseconds(justOutside, NOW)).toBe(HUB_POLL_IDLE_MILLISECONDS);
  });

  it("is idle with nothing ever observed, or an unparsable instant", () => {
    expect(hubPollIntervalMilliseconds(null, NOW)).toBe(HUB_POLL_IDLE_MILLISECONDS);
    expect(hubPollIntervalMilliseconds("not a date", NOW)).toBe(HUB_POLL_IDLE_MILLISECONDS);
  });

  it("finds the latest window across every provider, not just the first", () => {
    const providers: SyncedProviderUsage[] = [
      {
        provider: "CLAUDE",
        accountLabel: "work",
        windows: [
          { windowName: "FIVE_HOUR", percentage: 10, resetAt: null, observedAt: new Date(NOW - 10_000).toISOString(), stale: false },
        ],
      },
      {
        provider: "CODEX",
        accountLabel: "work",
        windows: [
          { windowName: "PRIMARY", percentage: 20, resetAt: null, observedAt: new Date(NOW - 1_000).toISOString(), stale: false },
          { windowName: "SECONDARY", percentage: 5, resetAt: null, observedAt: new Date(NOW - 20_000).toISOString(), stale: false },
        ],
      },
    ];
    expect(mostRecentObservedAt(providers)).toBe(new Date(NOW - 1_000).toISOString());
  });

  it("has nothing to report for an account with no synced windows", () => {
    expect(mostRecentObservedAt([])).toBeNull();
    expect(
      mostRecentObservedAt([{ provider: "CLAUDE", accountLabel: "work", windows: [] }]),
    ).toBeNull();
  });
});
