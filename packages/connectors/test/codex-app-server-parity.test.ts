import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeMeters } from "@openlimiter/core";
import { parseCodexPayload } from "../src/index.js";

interface ParityVector {
  readonly name: string;
  readonly payload: unknown;
  readonly meterIds: readonly string[];
  readonly values?: readonly number[];
}

const fixture = JSON.parse(readFileSync(path.resolve(
  "packages", "connectors", "fixtures", "codex-app-server-parity.json"
), "utf8")) as { now: string; vectors: ParityVector[] };

describe("Codex app server parser parity vectors", () => {
  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const normalized = normalizeMeters(parseCodexPayload(vector.payload, fixture.now) ?? []);
      expect(normalized.map((meter) => meter.meter)).toEqual(vector.meterIds);
      if (vector.values !== undefined) expect(normalized.map((meter) => meter.value)).toEqual(vector.values);
    });
  }
});
