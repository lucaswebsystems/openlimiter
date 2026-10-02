import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodexPayload } from "../src/index.js";

interface ParityVector {
  readonly name: string;
  readonly payload: unknown;
  readonly meterIds: readonly string[];
}

const fixture = JSON.parse(readFileSync(path.resolve(
  "packages", "connectors", "fixtures", "codex-app-server-parity.json"
), "utf8")) as { now: string; vectors: ParityVector[] };

describe("Codex app server parser parity vectors", () => {
  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      expect(parseCodexPayload(vector.payload, fixture.now)?.map((meter) => meter.meter))
        .toEqual(vector.meterIds);
    });
  }
});
