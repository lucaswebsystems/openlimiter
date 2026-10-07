import { describe, expect, it } from "vitest";
import { parseOpenrouterPayload } from "../app/app/engine/generated/connectors/openrouter";
import type { Snapshot } from "../app/app/engine/generated/core/types";
import { dashboardView } from "../app/app/engine";

describe("generated OpenRouter mirror", () => {
  it("keeps the finite threshold at exactly ninety percent", () => {
    const parsed = parseOpenrouterPayload({
      data: { limit: 0.07, limit_remaining: 0.007, limit_reset: null, usage: 0 }
    }, "2026-08-07T12:00:00.000Z");
    expect(parsed?.[0]?.value).toBe(90);
  });
});

describe("generated engine cache projection", () => {
  it("does not redraw a cached Claude weekly payload row", () => {
    const now = "2026-08-07T12:00:00.000Z";
    const rows: Snapshot[] = [
      {
        provider: "CLAUDE",
        meter: "FIVE_HOUR",
        value: 42,
        unit: "PERCENT",
        window: { kind: "rolling", durationSeconds: 18_000 },
        resetAt: "2026-08-07T16:00:00.000Z",
        source: "native_payload",
        precision: "exact",
        observedAt: "2026-08-07T12:00:00.000Z",
        expiresAt: "2026-08-07T16:00:00.000Z",
        labels: {
          credentialOrigin: "official-local-tool",
          dataInterfaceStatus: "native-statusline-payload",
          automationRisk: "low",
          verification: "UNVERIFIED"
        }
      },
      {
        provider: "CLAUDE",
        meter: "SEVEN_DAY",
        value: 67,
        unit: "PERCENT",
        window: { kind: "rolling", durationSeconds: 604_800 },
        resetAt: "2026-08-11T12:00:00.000Z",
        source: "native_payload",
        precision: "exact",
        observedAt: "2026-08-07T12:00:00.000Z",
        expiresAt: "2026-08-11T12:00:00.000Z",
        labels: {
          credentialOrigin: "official-local-tool",
          dataInterfaceStatus: "native-statusline-payload",
          automationRisk: "low",
          verification: "UNVERIFIED"
        },
        provenance: {
          sourceKind: "statusline_payload",
          observedVia: "claude_code_statusline"
        }
      }
    ];
    const claude = dashboardView(rows, now).providers.find((provider) => provider.provider === "CLAUDE");
    expect(claude?.meters.map((meter) => meter.meter)).toEqual(["FIVE_HOUR"]);
  });
});
