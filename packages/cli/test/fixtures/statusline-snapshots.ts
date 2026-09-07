import type { Snapshot } from "@openlimiter/core";

/**
 * One fixed reading per provider, shared by every statusline golden test.
 *
 * The values and reset times are picked so every band in the colour scale (a
 * green, two yellows either side of the meter class boundary, an orange and a
 * red) appears at least once, and so the four reset time shapes (minutes,
 * hours, hours and minutes, days) each appear at least once. Nothing here
 * reads the clock: every test that imports this fixture renders it against
 * `GOLDEN_NOW` below, so a render captured today reproduces byte for byte on
 * any machine, at any time.
 */
export const GOLDEN_NOW = "2026-01-01T00:00:00.000Z";
const GOLDEN_EXPIRES = "2026-01-01T00:01:00.000Z";

function reading(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    provider: "CLAUDE",
    meter: "FIVE_HOUR",
    value: 42,
    unit: "PERCENT",
    window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt: null,
    source: "native_payload",
    precision: "exact",
    observedAt: GOLDEN_NOW,
    expiresAt: GOLDEN_EXPIRES,
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "native-statusline-payload",
      automationRisk: "low",
      verification: "UNVERIFIED"
    },
    ...overrides
  };
}

export const GOLDEN_SNAPSHOTS: readonly Snapshot[] = [
  reading({
    provider: "CLAUDE",
    meter: "FIVE_HOUR",
    value: 42,
    resetAt: "2026-01-01T05:00:00.000Z"
  }),
  reading({
    provider: "CLAUDE",
    meter: "SEVEN_DAY",
    value: 64,
    window: { kind: "rolling", durationSeconds: 604_800 },
    resetAt: "2026-01-08T00:00:00.000Z"
  }),
  reading({
    provider: "CODEX",
    meter: "FIVE_HOUR",
    value: 51,
    resetAt: "2026-01-01T05:00:00.000Z"
  }),
  reading({
    provider: "ANTIGRAVITY",
    meter: "FIVE_HOUR",
    value: 28,
    resetAt: "2026-01-01T05:00:00.000Z"
  }),
  reading({
    provider: "GEMINI_CLI",
    meter: "GEMINI_3_PRO",
    value: 45,
    window: { kind: "fixed" },
    resetAt: "2026-01-01T05:00:00.000Z"
  }),
  reading({
    provider: "OPENCODE",
    meter: "FIVE_HOUR",
    value: 92,
    resetAt: "2026-01-01T05:00:00.000Z"
  }),
  reading({
    provider: "GROK",
    meter: "WEEKLY",
    value: 42.5,
    window: { kind: "rolling", durationSeconds: 604_800 },
    resetAt: "2026-01-08T00:00:00.000Z"
  }),
  /*
   * A real Grok Build reading with no window vocabulary word at all (an on
   * demand spend meter, `window: { kind: "fixed" }`, no recognised meter
   * name). Lower than the weekly reading above, so it never changes which
   * cell a "worst" render picks for Grok; it exists to exercise the short
   * tag fallback (statusline.ts, `barStyleCells`) when this is the host's
   * own provider AND its window carries no code.
   */
  reading({
    provider: "GROK",
    meter: "ON_DEMAND_MONTHLY",
    value: 6,
    window: { kind: "fixed" },
    resetAt: null
  }),
  reading({
    provider: "KIMI",
    meter: "FIVE_HOUR",
    value: 69.5,
    window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt: "2026-01-01T05:00:00.000Z"
  }),
  reading({
    provider: "MANUAL",
    meter: "MONTHLY",
    value: 35,
    window: { kind: "fixed" },
    resetAt: "2026-02-01T00:00:00.000Z"
  }),
  reading({
    provider: "OPENROUTER",
    meter: "CREDITS",
    value: 62.35,
    window: { kind: "lifetime" },
    resetAt: null
  })
];
