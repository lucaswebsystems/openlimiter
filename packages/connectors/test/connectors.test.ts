import { freshness, normalizeMeters, type RawMeter } from "@openlimiter/core";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_NOW,
  antigravityConnector,
  antigravityFixture,
  claudeConnector,
  claudeFixture,
  codexConnector,
  codexFixture,
  connectors,
  hostileFixture,
  manualConnector,
  manualFixture,
  opencodeConnector,
  opencodeFixture,
  openrouterConnector,
  openrouterFixture,
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseManualPayload,
  parseOpencodePayload,
  parseOpenrouterPayload
} from "../src/index.js";

type Parser = (payload: unknown, now: string) => RawMeter[] | null;

const cases: readonly {
  name: string;
  parser: Parser;
  fixture: unknown;
  provider: string;
  huge: unknown;
}[] = [
  {
    name: "claude",
    parser: parseClaudePayload,
    fixture: claudeFixture,
    provider: "CLAUDE",
    huge: {
      rate_limits: {
        five_hour: {
          utilization: 9e300,
          resets_at: "2026-01-01T05:00:00.000Z"
        }
      }
    }
  },
  {
    name: "openrouter",
    parser: parseOpenrouterPayload,
    fixture: openrouterFixture,
    provider: "OPENROUTER",
    huge: { data: { total_credits: 9e300, total_usage: 1 } }
  },
  {
    name: "codex",
    parser: parseCodexPayload,
    fixture: codexFixture,
    provider: "CODEX",
    huge: {
      rate_limits: {
        primary_window: {
          used_percent: 9e300,
          reset_at: "2026-01-01T05:00:00.000Z"
        }
      }
    }
  },
  {
    name: "antigravity",
    parser: parseAntigravityPayload,
    fixture: antigravityFixture,
    provider: "ANTIGRAVITY",
    huge: {
      quota: {
        used_percent: 9e300,
        reset_at: "2026-01-02T00:00:00.000Z"
      }
    }
  },
  {
    name: "opencode",
    parser: parseOpencodePayload,
    fixture: opencodeFixture,
    provider: "OPENCODE",
    huge: {
      usage: {
        percent: 9e300,
        reset_at: "2026-01-02T00:00:00.000Z"
      }
    }
  },
  {
    name: "manual",
    parser: parseManualPayload,
    fixture: manualFixture,
    provider: "MANUAL",
    huge: {
      meters: [{
        name: "MONTHLY",
        used_percent: 9e300,
        reset_at: "2026-02-01T00:00:00.000Z"
      }]
    }
  }
];

describe.each(cases)("$name parser", ({ parser, fixture, provider, huge }) => {
  it("maps a synthetic fixture to bounded meters", () => {
    const parsed = parser(fixture, FIXTURE_NOW);
    expect(parsed === null).toBe(false);
    expect(parsed?.every((meter) => meter.provider === provider)).toBe(true);
    expect(normalizeMeters(parsed ?? [])).toHaveLength(parsed?.length ?? 0);
  });

  it("fails closed for missing and malformed shapes", () => {
    expect(parser(undefined, FIXTURE_NOW)).toBeNull();
    expect(parser({}, FIXTURE_NOW)).toBeNull();
    expect(parser({ data: "malformed" }, FIXTURE_NOW)).toBeNull();
  });

  it("fails closed for huge numbers and hostile values", () => {
    expect(parser(huge, FIXTURE_NOW)).toBeNull();
    expect(parser(hostileFixture, FIXTURE_NOW)).toBeNull();
    expect(parser({ value: "Ω".repeat(500), message: hostileFixture.message }, FIXTURE_NOW))
      .toBeNull();
  });

  it("produces snapshots that expire to stale", () => {
    const parsed = parser(fixture, FIXTURE_NOW);
    const normalized = normalizeMeters(parsed ?? []);
    expect(normalized.length).toBeGreaterThan(0);
    expect(
      normalized.every((meter) =>
        freshness(meter.observedAt, meter.expiresAt, "2027-01-01T00:00:00.000Z") === "stale"
      )
    ).toBe(true);
  });

  it("does not carry hostile extra strings", () => {
    const root = typeof fixture === "object" && fixture !== null
      ? { ...fixture, ...hostileFixture }
      : fixture;
    const parsed = parser(root, FIXTURE_NOW);
    expect(parsed === null).toBe(false);
    expect(JSON.stringify(parsed).includes(hostileFixture.message)).toBe(false);
    expect(JSON.stringify(parsed).includes("Ω")).toBe(false);
  });
});

describe("connector contracts", () => {
  it("ships six unverified connectors", () => {
    expect(connectors).toHaveLength(6);
    expect(connectors.every((connector) => connector.labels.verification === "UNVERIFIED"))
      .toBe(true);
  });

  it("detects using only explicit environment markers", () => {
    expect(claudeConnector.detect({ CLAUDE_CODE_STATUSLINE: "1" })).toBe(true);
    expect(openrouterConnector.detect({
      OPENLIMITER_OPENROUTER_CREDENTIAL: "available"
    })).toBe(true);
    expect(codexConnector.detect({ CODEX_USAGE_PAYLOAD: "1" })).toBe(true);
    expect(antigravityConnector.detect({ ANTIGRAVITY_USAGE_PAYLOAD: "1" })).toBe(true);
    expect(opencodeConnector.detect({ OPENCODE_SESSION_PRESENT: "1" })).toBe(true);
    expect(manualConnector.detect({})).toBe(true);
    expect(connectors.slice(0, 5).every((connector) => !connector.detect({}))).toBe(true);
  });

  it("returns unknown for missing input", async () => {
    for (const connector of connectors) {
      await expect(connector.read({
        now: FIXTURE_NOW,
        environment: {}
      })).resolves.toEqual({ ok: false, reason: "unknown" });
    }
  });

  it("rejects expired provider windows", () => {
    expect(
      parseClaudePayload(claudeFixture, "2027-01-01T00:00:00.000Z")
    ).toBeNull();
    expect(
      parseCodexPayload(codexFixture, "2027-01-01T00:00:00.000Z")
    ).toBeNull();
    expect(
      parseAntigravityPayload(antigravityFixture, "2027-01-01T00:00:00.000Z")
    ).toBeNull();
    expect(
      parseOpencodePayload(opencodeFixture, "2027-01-01T00:00:00.000Z")
    ).toBeNull();
    expect(
      parseManualPayload(manualFixture, "2027-01-01T00:00:00.000Z")
    ).toBeNull();
  });

  it("rejects unicode manual meter names", () => {
    expect(parseManualPayload({
      meters: [{
        name: "ΜONTHLY",
        used_percent: 10,
        reset_at: "2026-02-01T00:00:00.000Z"
      }]
    }, FIXTURE_NOW)).toBeNull();
  });
});
