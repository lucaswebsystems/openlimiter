/**
 * The meter contract, and the vectors its Rust twin (data_rules::measure) is
 * held to. One answer to "what is this number", so no surface decides alone.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONNECTION_NOTE_REASONS,
  displayReason,
  isConnectionNote,
  meterAmountText,
  meterReading,
  moneyText,
  projectSnapshots,
  type MeterReading
} from "../src/data-rules.js";
import { normalizeMeter } from "../src/normalizer.js";
import type { RawMeter, Snapshot } from "../src/types.js";
import { snapshot } from "./helpers.js";

interface Vector {
  name: string;
  row: Snapshot;
  expected: Pick<MeterReading, "measure" | "direction" | "usedPercent" | "currency"> | null;
}

const vectors = JSON.parse(
  readFileSync(path.resolve("packages/core/src/contracts/meter-vectors.json"), "utf8")
) as Vector[];

describe("the meter contract vectors, shared with Rust", () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const reading = meterReading(vector.row);
      if (vector.expected === null) {
        expect(reading).toBeNull();
        return;
      }
      expect(reading).toMatchObject(vector.expected);
      expect(reading?.value).toBe(vector.row.value);
      expect(reading?.unit).toBe(vector.row.unit);
    });
  }

  it("covers every measure, both directions, no direction, and every refusal", () => {
    const measures = new Set(vectors.map((vector) => vector.expected?.measure ?? "refused"));
    expect([...measures].sort()).toEqual(["amount", "balance", "count", "percent", "refused", "spend"]);
    const directions = new Set(vectors.map((vector) => String(vector.expected?.direction)));
    expect([...directions].sort()).toEqual(["null", "remaining", "undefined", "used"]);
  });
});

describe("balance direction", () => {
  it("never reads a balance as spent or a spend as left", () => {
    const balance = meterReading(snapshot({ unit: "CREDITS", value: 12, kind: "money_balance" }));
    const spend = meterReading(snapshot({ unit: "CREDITS", value: 12, kind: "spend" }));
    expect(balance?.direction).toBe("remaining");
    expect(spend?.direction).toBe("used");
  });

  it("claims no direction a reader never stated", () => {
    expect(meterReading(snapshot({ unit: "CREDITS", value: 12 }))).toMatchObject({ measure: "amount", direction: null });
  });

  it("gives only a percent a used share to draw", () => {
    for (const vector of vectors) {
      const reading = meterReading(vector.row);
      if (reading === null) continue;
      expect(reading.usedPercent === null, vector.name).toBe(reading.measure !== "percent");
    }
  });
});

describe("units and currencies", () => {
  it("states each reading in its own unit and never converts money", () => {
    const text = (row: Partial<Snapshot>) => meterAmountText(meterReading(snapshot(row))!);
    expect(text({ value: 35.55 })).toBe("35.5%");
    expect(text({ unit: "CREDITS", value: 45.2, kind: "money_balance" })).toBe("45.20 credits");
    expect(text({ unit: "CREDITS", value: 1, kind: "money_balance" })).toBe("1.00 credit");
    expect(text({ unit: "CREDITS", value: 12.349, kind: "money_balance", currency: "USD" })).toBe("$12.34");
    expect(text({ unit: "CREDITS", value: 8, kind: "spend", currency: "CNY" })).toBe("CN¥8.00");
    expect(text({ unit: "REQUESTS", value: 120, kind: "token_count" })).toBe("120 requests");
    expect(text({ unit: "REQUESTS", value: 1, kind: "money_balance" })).toBe("1 request");
    expect(text({ unit: "TOKENS", value: 1500.75, kind: "token_count" })).toBe("1500.75 tokens");
    expect(moneyText(19.999, "USD")).toBe("$19.99");
  });

  it("keeps a lone currency only on a money balance or a spend", () => {
    const raw = (extra: Record<string, unknown>): RawMeter => ({
      ...snapshot({ unit: "CREDITS", value: 12.34 }),
      ...extra
    } as unknown as RawMeter);
    expect(normalizeMeter(raw({ kind: "money_balance", currency: "USD" }))?.currency).toBe("USD");
    expect(normalizeMeter(raw({ kind: "spend", currency: "CNY" }))?.currency).toBe("CNY");
    /* Anywhere else it is dropped as a broken pair is, and the reading stands. */
    expect(normalizeMeter(raw({ currency: "USD" }))?.currency).toBeUndefined();
    expect(normalizeMeter(raw({ kind: "token_count", currency: "USD" }))?.currency).toBeUndefined();
    expect(normalizeMeter(raw({ kind: "money_balance", currency: "EUR" }))?.currency).toBeUndefined();
    const percent = { ...snapshot({ value: 40 }), kind: "money_balance", currency: "USD" } as unknown as RawMeter;
    expect(normalizeMeter(percent)?.currency).toBeUndefined();
    /* A used amount with no limit is still a broken pair. */
    expect(normalizeMeter(raw({ kind: "spend", currency: "USD", usedAmount: 1 }))?.currency).toBeUndefined();
  });
});

describe("what is displayable", () => {
  const now = "2026-01-01T00:01:00.000Z";

  it("flags a unit and kind that contradict each other instead of drawing them", () => {
    expect(displayReason(snapshot({ value: 40, kind: "money_balance" }), now)).toBe("quota_unavailable");
    expect(displayReason(snapshot({ unit: "CREDITS", value: 40, kind: "quota_percent" }), now)).toBe("quota_unavailable");
    expect(displayReason(snapshot({ unit: "CREDITS", value: 40, kind: "money_balance" }), now)).toBeNull();
    expect(displayReason(snapshot({ value: 40 }), now)).toBeNull();
    /* OpenRouter's rows since 2.0: a used share of a money limit that names its
       balance kind, proven by the pair. It stays on screen exactly as before. */
    expect(displayReason(snapshot({
      value: 25, kind: "money_balance", usedAmount: 12.5, limitAmount: 50, currency: "USD"
    }), now)).toBeNull();
  });

  it("keeps unlimited a note: never a meter, never a thing to fix", () => {
    expect(CONNECTION_NOTE_REASONS).toEqual(["unlimited"]);
    expect(isConnectionNote("unlimited")).toBe(true);
    expect(isConnectionNote("expired_credentials")).toBe(false);
    const unlimited = snapshot({ meter: "CREDITS", value: 0, availability: "unlimited" });
    const projected = projectSnapshots([unlimited], now);
    expect(projected.snapshots).toEqual([]);
    expect(projected.flags).toEqual([{ provider: "CLAUDE", reason: "unlimited", fixKind: "unsupported" }]);
    expect(meterReading(unlimited)).toBeNull();
  });
});
