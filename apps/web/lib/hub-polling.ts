import type { SyncedProviderUsage } from "./synced-usage";

/**
 * How often the hub asks for fresh synced usage on its own, with no click.
 *
 * A device that just wrote is a device somebody is actively using, so the
 * gap is short enough that a second screen (the phone, another tab) catches
 * up quickly. Nothing has written recently is the common case for a tab left
 * open on a desk, and polling it every minute would just be load with nothing
 * to show for it, so the gap widens to five minutes. Both numbers are a
 * background floor: a manual Sync, a window focus, or a sign in still refresh
 * immediately regardless of this cadence.
 */
export const HUB_POLL_ACTIVE_MILLISECONDS = 60_000;
export const HUB_POLL_IDLE_MILLISECONDS = 5 * 60_000;

/** How recently a device has to have written to count as "active" above. */
export const HUB_POLL_RECENT_WRITE_MILLISECONDS = 15 * 60_000;

/** The most recent observation across every window of every synced provider. */
export function mostRecentObservedAt(
  providers: readonly SyncedProviderUsage[],
): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const provider of providers) {
    for (const window of provider.windows) {
      const parsed = Date.parse(window.observedAt);
      if (Number.isFinite(parsed) && parsed > latestMs) {
        latestMs = parsed;
        latest = window.observedAt;
      }
    }
  }
  return latest;
}

/** The gap until the next automatic poll, given the most recent write seen. */
export function hubPollIntervalMilliseconds(
  mostRecentWrite: string | null,
  now: number = Date.now(),
): number {
  if (mostRecentWrite === null) return HUB_POLL_IDLE_MILLISECONDS;
  const observed = Date.parse(mostRecentWrite);
  if (!Number.isFinite(observed)) return HUB_POLL_IDLE_MILLISECONDS;
  return now - observed <= HUB_POLL_RECENT_WRITE_MILLISECONDS
    ? HUB_POLL_ACTIVE_MILLISECONDS
    : HUB_POLL_IDLE_MILLISECONDS;
}
