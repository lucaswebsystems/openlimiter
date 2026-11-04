import { describe, expect, it } from "vitest";
import { connectorMaturity, normalizeMeters } from "@openlimiter/core";
import {
  connectors,
  parseOpencodePayload,
  opencodeConnector,
  opencodeLabels,
  opencodeFixture,
  opencodeSanitizedLive,
  FIXTURE_NOW,
  hostileFixture
} from "../src/index.js";

/**
 * The OpenCode Go usage reader's contract: one JSON reply, rolling and weekly
 * required, monthly optional, and any window it cannot believe rejects the
 * whole reply. The Rust reader follows the same rules; the shared differential
 * corpus under fixtures/cases/opencode holds the two to each other.
 */

const NOW = "2026-08-07T12:00:00.000Z";

type Window = { status?: unknown; percent?: unknown; resetsAt?: unknown };

function reply(windows: Partial<Record<"rolling" | "weekly" | "monthly", Window>>): unknown {
  return { usage: windows };
}

const ok = (percent: number, resetsAt: unknown = "2026-08-07T15:00:00.000Z"): Window =>
  ({ status: "ok", percent, resetsAt });

describe("opencode: the reply it reads", () => {
  it("reads all three windows with their lengths and resets", () => {
    const meters = parseOpencodePayload(reply({
      rolling: ok(40),
      weekly: ok(92, "2026-08-10T00:00:00.000Z"),
      monthly: ok(15, "2026-08-30T00:00:00.000Z")
    }), NOW);
    expect(meters?.map((meter) => [meter.meter, meter.value, meter.window, meter.resetAt])).toEqual([
      ["FIVE_HOUR", 40, { kind: "rolling", durationSeconds: 18_000 }, "2026-08-07T15:00:00.000Z"],
      ["SEVEN_DAY", 92, { kind: "rolling", durationSeconds: 604_800 }, "2026-08-10T00:00:00.000Z"],
      ["MONTHLY", 15, { kind: "rolling", durationSeconds: 2_592_000 }, "2026-08-30T00:00:00.000Z"]
    ]);
    expect(normalizeMeters(meters ?? [])).toHaveLength(3);
  });

  it("stamps every reading with OpenLimiter's own labels and source", () => {
    const meters = parseOpencodePayload(opencodeFixture(FIXTURE_NOW), FIXTURE_NOW);
    expect(meters).toHaveLength(3);
    for (const meter of meters ?? []) {
      expect(meter).toMatchObject({
        provider: "OPENCODE",
        unit: "PERCENT",
        source: "internal_payload",
        precision: "estimated",
        observedAt: FIXTURE_NOW,
        expiresAt: "2026-01-01T00:01:00.000Z"
      });
      expect(meter.labels).toBe(opencodeLabels);
    }
    expect(opencodeLabels).toEqual({
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "internal-endpoint",
      automationRisk: "high",
      verification: "UNVERIFIED"
    });
  });

  it("keeps the percent a rate limited window states, inventing nothing", () => {
    const meters = parseOpencodePayload(reply({
      rolling: { status: "rate-limited", percent: 37, resetsAt: "2026-08-07T15:00:00.000Z" },
      weekly: ok(50, "2026-08-10T00:00:00.000Z")
    }), NOW);
    expect(meters?.map((meter) => [meter.meter, meter.value])).toEqual([
      ["FIVE_HOUR", 37],
      ["SEVEN_DAY", 50]
    ]);
  });

  it("treats the monthly window as optional", () => {
    const meters = parseOpencodePayload(reply({ rolling: ok(1), weekly: ok(2) }), NOW);
    expect(meters?.map((meter) => meter.meter)).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
  });

  it("keeps a reading whose reset is missing, past, implausible or not a timestamp", () => {
    for (const resetsAt of [undefined, null, 42, "soon", "2026-08-07T11:00:00.000Z", "2038-01-01T00:00:00.000Z"]) {
      const rolling = { status: "ok", percent: 10, ...(resetsAt === undefined ? {} : { resetsAt }) };
      const meters = parseOpencodePayload(reply({ rolling, weekly: ok(20) }), NOW);
      expect(meters?.[0]?.value, String(resetsAt)).toBe(10);
      expect(meters?.[0]?.resetAt, String(resetsAt)).toBeNull();
    }
  });

  it("accepts the bounds of a percentage", () => {
    expect(parseOpencodePayload(reply({ rolling: ok(0), weekly: ok(100) }), NOW)?.map((m) => m.value))
      .toEqual([0, 100]);
  });

  it("never lets provider text reach a reading", () => {
    const meters = parseOpencodePayload({ ...hostileFixture, usage: {
      rolling: { ...ok(5), note: hostileFixture.message },
      weekly: ok(6)
    } }, NOW);
    expect(meters).toHaveLength(2);
    expect(JSON.stringify(meters)).not.toContain(hostileFixture.message);
  });
});

describe("opencode: everything that rejects the whole reply", () => {
  const cases: readonly [string, unknown][] = [
    ["nothing at all", undefined],
    ["a null body", null],
    ["an HTML page", "<!doctype html><html><body><h3>Rolling Usage</h3><span>40%</span></body></html>"],
    ["an error reply", { error: { code: "unauthorized", message: "Synthetic expired sign in" } }],
    ["an array root", [opencodeFixture(NOW)]],
    ["usage that is not an object", { usage: [ok(1), ok(2)] }],
    ["a missing rolling window", reply({ weekly: ok(2), monthly: ok(3) })],
    ["a missing weekly window", reply({ rolling: ok(1), monthly: ok(3) })],
    ["a window that is not an object", reply({ rolling: ok(1), weekly: ok(2), monthly: 15 as never })],
    ["a null monthly window", reply({ rolling: ok(1), weekly: ok(2), monthly: null as never })],
    ["an unknown status", reply({ rolling: { ...ok(1), status: "exhausted" }, weekly: ok(2) })],
    ["a missing status", reply({ rolling: { percent: 1 }, weekly: ok(2) })],
    ["a status in other case", reply({ rolling: { ...ok(1), status: "OK" }, weekly: ok(2) })],
    ["a percent above 100", reply({ rolling: ok(100.5), weekly: ok(2) })],
    ["a negative percent", reply({ rolling: ok(1), weekly: ok(-1) })],
    ["an out of range monthly percent", reply({ rolling: ok(1), weekly: ok(2), monthly: ok(250) })],
    ["a percent written as text", reply({ rolling: { ...ok(1), percent: "40" }, weekly: ok(2) })],
    ["a missing percent", reply({ rolling: { status: "ok" }, weekly: ok(2) })],
    ["an infinite percent", reply({ rolling: ok(Number.POSITIVE_INFINITY), weekly: ok(2) })],
    ["a rate limited window with no percent", reply({ rolling: { status: "rate-limited" }, weekly: ok(2) })]
  ];
  for (const [reason, payload] of cases) {
    it("refuses " + reason, () => {
      expect(parseOpencodePayload(payload, NOW)).toBeNull();
    });
  }

  it("refuses a valid reply against an unreadable clock", () => {
    expect(parseOpencodePayload(opencodeFixture(NOW), "not a clock")).toBeNull();
  });
});

describe("opencode: the connector around it", () => {
  it("reports a connected reading, a waiting tool and a shape it cannot read", async () => {
    const read = (payload: unknown) => opencodeConnector.read({ payload, now: NOW, environment: {} });
    const good = await read(opencodeFixture(NOW));
    expect(good.ok).toBe(true);
    expect(good.connection?.state).toBe("CONNECTED");
    expect((await read(undefined)).connection?.state).toBe("DETECTED");
    const bad = await read("<html>signed out</html>");
    expect(bad.ok).toBe(false);
    expect(bad.connection).toMatchObject({ state: "ERROR", reason: "shape_mismatch" });
  });

  it("reads JSON and says it is beta", () => {
    expect(opencodeConnector.encoding).toBe("json");
    expect(connectorMaturity(opencodeConnector)).toBe("beta");
    for (const connector of connectors) {
      const experimental = [
        "cursor", "hermes", "commandcode", "cline", "kilocode", "copilot", "amp", "codebuff", "kiro", "crush"
      ];
      const expected = connector.id === "opencode" ? "beta" : experimental.includes(connector.id) ? "experimental" : "stable";
      expect(connectorMaturity(connector), connector.id).toBe(expected);
    }
  });

  it("has a sanitized live fixture slot, and says out loud that it is empty", () => {
    expect(opencodeSanitizedLive).toMatchObject({
      id: "opencode.sanitized_live.usage",
      connector: "opencode",
      status: "pending_capture",
      capturedAt: null,
      expectedMeters: 0
    });
    expect(opencodeSanitizedLive.skipReason).toContain("PENDING CAPTURE");
    expect(opencodeSanitizedLive.build(NOW)).toBeNull();
  });
});
