import { freshness, normalizeMeters, type RawMeter } from "@openlimiter/core";
import { describe, expect, it } from "vitest";
import providerSpecs from "../../../provider_specs/provider-specs.json" with { type: "json" };
import {
  FIXTURE_NOW,
  MANUAL_FILE_MARKER,
  MANUAL_FILE_NAME,
  antigravityConnector,
  antigravityFixture,
  claudeConnector,
  claudeFixture,
  codexConnector,
  codexFixture,
  connectors,
  hostileFixture,
  grokConnector,
  grokFixture,
  kimiConnector,
  kimiFixture,
  manualConnector,
  manualFixture,
  opencodeConnector,
  opencodeFixture,
  openrouterConnector,
  openrouterFixture,
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseGrokPayload,
  parseKimiPayload,
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
    fixture: claudeFixture(FIXTURE_NOW),
    provider: "CLAUDE",
    huge: {
      rate_limits: {
        five_hour: {
          used_percentage: 9e300,
          resets_at: 1_767_243_600
        }
      }
    }
  },
  {
    name: "openrouter",
    parser: parseOpenrouterPayload,
    fixture: openrouterFixture(),
    provider: "OPENROUTER",
    huge: { data: { total_credits: 9e300, total_usage: 1 } }
  },
  {
    name: "codex",
    parser: parseCodexPayload,
    fixture: codexFixture(FIXTURE_NOW),
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
    fixture: antigravityFixture(FIXTURE_NOW),
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
    fixture: opencodeFixture(FIXTURE_NOW),
    provider: "OPENCODE",
    huge: {
      usage: {
        percent: 9e300,
        reset_at: "2026-01-02T00:00:00.000Z"
      }
    }
  },
  {
    name: "grok",
    parser: parseGrokPayload,
    fixture: grokFixture(FIXTURE_NOW),
    provider: "GROK",
    huge: { config: { creditUsagePercent: 9e300 } }
  },
  {
    name: "kimi",
    parser: parseKimiPayload,
    fixture: kimiFixture(FIXTURE_NOW),
    provider: "KIMI",
    huge: { usage: { used: 9e300, limit: 9e300, resetTime: "never" } }
  },
  {
    name: "manual",
    parser: parseManualPayload,
    fixture: manualFixture(FIXTURE_NOW),
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
  it("ships eight unverified connectors", () => {
    expect(connectors).toHaveLength(8);
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
    expect(grokConnector.detect({ GROK_USAGE_PAYLOAD: "1" })).toBe(true);
    expect(kimiConnector.detect({ KIMI_USAGE_PAYLOAD: "1" })).toBe(true);
    expect(manualConnector.detect({ [MANUAL_FILE_MARKER]: "available" })).toBe(true);
    expect(connectors.every((connector) => !connector.detect({}))).toBe(true);
  });

  it("reports the manual connector as undetected without a manual document", () => {
    expect(manualConnector.detect({})).toBe(false);
    expect(manualConnector.detect({ [MANUAL_FILE_MARKER]: "missing" })).toBe(false);
    expect(MANUAL_FILE_NAME).toBe("manual.json");
  });

  it("carries exactly the honesty labels the registry publishes", () => {
    /* Two sources for four words a person reads to decide whether to trust a
       number, so they are pinned to each other. The registry is what every
       surface renders; the connector is what stamps each row. A drift between
       them is a card describing one thing and a meter describing another. */
    const registry = providerSpecs as {
      providers: readonly {
        id: string;
        honesty: {
          connectorId: string;
          credentialOrigin: string;
          dataInterfaceStatus: string;
          automationRisk: string;
          verification: string;
        } | null;
      }[];
    };
    /*
     * Built by hand rather than from a Map constructor, because a Map silently
     * keeps the last of two entries with the same key. Two specs claiming one
     * connector id would therefore have compared cleanly against whichever
     * happened to compile second, which is the drift this test exists to catch.
     */
    const described = new Map<string, NonNullable<typeof registry.providers[0]["honesty"]>>();
    for (const entry of registry.providers) {
      if (entry.honesty === null) continue;
      const connectorId = entry.honesty.connectorId;
      expect(
        described.has(connectorId),
        "two specs claim connector_id " + connectorId
      ).toBe(false);
      described.set(connectorId, entry.honesty);
    }
    for (const connector of connectors) {
      const stated = described.get(connector.id);
      expect(stated, "no registry entry describes " + connector.id).toBeDefined();
      expect({
        credentialOrigin: stated?.credentialOrigin,
        dataInterfaceStatus: stated?.dataInterfaceStatus,
        automationRisk: stated?.automationRisk,
        verification: stated?.verification
      }).toEqual(connector.labels);
    }
    /* And nothing in the registry describes a connector that does not exist. */
    for (const connectorId of described.keys()) {
      expect(connectors.some((connector) => connector.id === connectorId)).toBe(true);
    }
  });

  it("declares what its payload is, and only OpenCode reads text", () => {
    /* Every payload boundary in the product asks a connector this rather than
       assuming JSON. Assuming it made the OpenCode reader unreachable from the
       ingest command entirely, because a logged in HTML page is not JSON. */
    for (const connector of connectors) {
      const expected = connector.id === "opencode" ? "text" : "json";
      expect(connector.encoding).toBe(expected);
    }
  });

  it("returns unknown for missing input", async () => {
    for (const connector of connectors) {
      await expect(connector.read({
        now: FIXTURE_NOW,
        environment: {}
      })).resolves.toEqual({ ok: false, reason: "unknown" });
    }
  });

  it("rejects expired provider windows, for every source that states an instant", () => {
    const later = "2027-01-01T00:00:00.000Z";
    expect(parseClaudePayload(claudeFixture(FIXTURE_NOW), later)).toBeNull();
    expect(parseCodexPayload(codexFixture(FIXTURE_NOW), later)).toBeNull();
    expect(parseAntigravityPayload(antigravityFixture(FIXTURE_NOW), later)).toBeNull();
    expect(parseGrokPayload(grokFixture(FIXTURE_NOW), later)).toBeNull();
    expect(parseKimiPayload(kimiFixture(FIXTURE_NOW), later)).toBeNull();
    expect(parseManualPayload(manualFixture(FIXTURE_NOW), later)).toBeNull();
  });

  it("cannot expire an OpenCode page by its reset, and expires it by age instead", () => {
    /* OpenCode is the one source that states a COUNTDOWN rather than an
       instant: its page prints "Resets in 20 hours", so a page read a year
       late still yields a reset twenty hours from whenever it was read. The
       reset therefore cannot detect staleness for this provider, and pretending
       otherwise would be the wrong kind of confidence.
       What does detect it is the snapshot's own expiry, which every source
       carries and which is stamped from the reading clock. This states both
       halves so the gap is documented rather than discovered. */
    const later = "2027-01-01T00:00:00.000Z";
    const meters = parseOpencodePayload(opencodeFixture(FIXTURE_NOW), later);
    expect(meters).toHaveLength(3);
    const reading = meters?.[0];
    expect(Date.parse(String(reading?.resetAt))).toBeGreaterThan(Date.parse(later));
    /* Read at the clock it was observed at, it is fresh; a minute later it is
       stale, whatever its countdown says. */
    expect(freshness(String(reading?.observedAt), String(reading?.expiresAt), later))
      .toBe("fresh");
    const stale = new Date(Date.parse(later) + 120_000).toISOString();
    expect(freshness(String(reading?.observedAt), String(reading?.expiresAt), stale))
      .toBe("stale");
  });

  it("keeps every fixture valid against the real clock", () => {
    const now = new Date().toISOString();
    expect(parseClaudePayload(claudeFixture(now), now)).toHaveLength(2);
    expect(parseCodexPayload(codexFixture(now), now)).toHaveLength(1);
    expect(parseAntigravityPayload(antigravityFixture(now), now)).toHaveLength(1);
    expect(parseOpencodePayload(opencodeFixture(now), now)).toHaveLength(3);
    expect(parseGrokPayload(grokFixture(now), now)).toHaveLength(2);
    expect(parseKimiPayload(kimiFixture(now), now)).toHaveLength(2);
    expect(parseManualPayload(manualFixture(now), now)).toHaveLength(1);
    expect(parseOpenrouterPayload(openrouterFixture(), now)).toHaveLength(1);
  });

  it("keeps the readable window when the other window is unusable", () => {
    const payload = claudeFixture(FIXTURE_NOW) as {
      rate_limits: { five_hour: { resets_at: number } };
    };
    /* An epoch in 2020, long past the fixture clock. */
    payload.rate_limits.five_hour.resets_at = 1_577_836_800;
    const parsed = parseClaudePayload(payload, FIXTURE_NOW);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.meter).toBe("SEVEN_DAY");
  });

  it("drops one unusable manual row and keeps the rest", () => {
    const parsed = parseManualPayload({
      meters: [
        { name: "MONTHLY", used_percent: 35, reset_at: "2026-02-01T00:00:00.000Z" },
        { name: "not a meter", used_percent: 10, reset_at: "2026-02-01T00:00:00.000Z" },
        { name: "WEEKLY", used_percent: 900, reset_at: "2026-02-01T00:00:00.000Z" },
        { name: "DAILY", used_percent: 5, reset_at: "2026-02-01T00:00:00.000Z" }
      ]
    }, FIXTURE_NOW);
    expect(parsed?.map((meter) => meter.meter)).toEqual(["MONTHLY", "DAILY"]);
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

/**
 * OpenRouter is the one provider whose documented shape states money.
 *
 * The connector hands the two figures on as it read them; the normalizer is
 * what decides whether they are believable. These tests cover the handover and
 * the two ends of it.
 */
describe("openrouter amounts", () => {
  it("carries the documented credit figures onto the meter", () => {
    const parsed = parseOpenrouterPayload(openrouterFixture(), FIXTURE_NOW);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.usedAmount).toBe(12.47);
    expect(parsed?.[0]?.limitAmount).toBe(20);
    expect(parsed?.[0]?.currency).toBe("USD");
  });

  it("survives normalization with its amounts intact", () => {
    const normalized = normalizeMeters(
      parseOpenrouterPayload(openrouterFixture(), FIXTURE_NOW) ?? []
    );
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.usedAmount).toBe(12.47);
    expect(normalized[0]?.limitAmount).toBe(20);
    expect(normalized[0]?.currency).toBe("USD");
    expect(normalized[0]?.value).toBeCloseTo(62.35, 10);
  });

  it("keeps the percent when the amounts are too large to believe", () => {
    const parsed = parseOpenrouterPayload(
      { data: { total_credits: 4_000_000, total_usage: 2_000_000 } },
      FIXTURE_NOW
    );
    const normalized = normalizeMeters(parsed ?? []);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.value).toBe(50);
    expect(normalized[0]?.usedAmount).toBeUndefined();
    expect(normalized[0]?.limitAmount).toBeUndefined();
    expect(normalized[0]?.currency).toBeUndefined();
  });

  it("states no money at all when the payload states none", () => {
    const parsed = parseOpenrouterPayload(
      { data: { total_credits: 100, total_usage: 0 } },
      FIXTURE_NOW
    );
    expect(parsed?.[0]?.usedAmount).toBe(0);
    expect(normalizeMeters(parsed ?? [])[0]?.usedAmount).toBe(0);
  });
});
