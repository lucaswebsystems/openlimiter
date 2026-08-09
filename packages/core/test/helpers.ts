import type { Snapshot } from "../src/index.js";

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    provider: "CLAUDE",
    meter: "FIVE_HOUR",
    value: 42,
    unit: "PERCENT",
    window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt: "2026-01-01T05:00:00.000Z",
    source: "native_payload",
    precision: "exact",
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "native-statusline-payload",
      automationRisk: "low",
      verification: "UNVERIFIED"
    },
    ...overrides
  };
}
