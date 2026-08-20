import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeMeters, type RawMeter } from "@openlimiter/core";
import { describe, expect, it } from "vitest";
import {
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseGrokPayload,
  parseKimiPayload,
  parseOpencodePayload,
  parseOpenrouterPayload
} from "../src/index.js";

/**
 * The frozen fixtures, held against their parsers, offline.
 *
 * Every provider now ships one frozen redacted sample response FILE under
 * `packages/connectors/fixtures`, sourced from the recorded evidence in
 * `Product Idea/reference-implementation`. This suite reads each file straight
 * off disk, runs the parser the manifest names against the pinned capture
 * clock, and asserts the exact meters a correct parser returns. No builder
 * stands in for the file, so a fixture that drifts from its parser fails here
 * rather than passing because our code agrees with itself.
 *
 * Nothing here touches the network or a live account. The whole point of the
 * frozen file is that CI can prove the parser reads a real shaped response with
 * no capture step at all.
 */

type Parser = (payload: unknown, now: string) => RawMeter[] | null;

const parsers: Readonly<Record<string, Parser>> = {
  parseClaudePayload,
  parseOpenrouterPayload,
  parseCodexPayload,
  parseGrokPayload,
  parseKimiPayload,
  parseAntigravityPayload,
  parseOpencodePayload
};

const FIXTURE_DIR = resolve(process.cwd(), "packages/connectors/fixtures");

interface ManifestExpectation {
  meter: string;
  value: number;
  usedAmount?: number;
  limitAmount?: number;
}

interface ManifestProvider {
  provider: string;
  connector: string;
  file: string;
  encoding: "json" | "text";
  parser: string;
  evidence: string;
  expectedMeters: number;
  expect: readonly ManifestExpectation[];
}

interface Manifest {
  captureClock: string;
  providers: readonly ManifestProvider[];
}

const manifest = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "manifest.json"), "utf8")
) as Manifest;

const clock = manifest.captureClock;

/** The raw file, decoded the way the manifest says its parser wants it. */
function loadFixture(entry: ManifestProvider): unknown {
  const raw = readFileSync(resolve(FIXTURE_DIR, entry.file), "utf8");
  return entry.encoding === "text" ? raw : JSON.parse(raw);
}

describe("frozen provider fixtures", () => {
  it("pins the capture clock as an instant every fixture reads against", () => {
    expect(Number.isFinite(Date.parse(clock))).toBe(true);
  });

  it("carries one frozen fixture file for all seven live providers", () => {
    const connectors = manifest.providers.map((entry) => entry.connector).sort();
    expect(connectors).toEqual(
      ["antigravity", "claude", "codex", "grok", "kimi", "opencode", "openrouter"]
    );
  });

  for (const entry of manifest.providers) {
    describe(entry.provider, () => {
      it("parses the frozen file into exactly the expected meters", () => {
        const parser = parsers[entry.parser];
        expect(parser, "no parser named " + entry.parser).toBeDefined();
        const meters = parser?.(loadFixture(entry), clock) ?? null;
        expect(meters).not.toBeNull();
        expect(meters).toHaveLength(entry.expectedMeters);
        expect(meters?.every((meter) => meter.provider === entry.provider)).toBe(true);
      });

      it("reads the exact numbers the frozen file states", () => {
        const parser = parsers[entry.parser];
        const meters = parser?.(loadFixture(entry), clock) ?? [];
        const byMeter = new Map(meters.map((meter) => [meter.meter, meter]));
        for (const wanted of entry.expect) {
          const got = byMeter.get(wanted.meter);
          expect(got, entry.provider + " is missing meter " + wanted.meter).toBeDefined();
          expect(got?.value).toBeCloseTo(wanted.value, 2);
          if (wanted.usedAmount !== undefined) {
            expect(got?.usedAmount).toBe(wanted.usedAmount);
          }
          if (wanted.limitAmount !== undefined) {
            expect(got?.limitAmount).toBe(wanted.limitAmount);
          }
        }
      });

      it("survives normalization end to end", () => {
        const parser = parsers[entry.parser];
        const normalized = normalizeMeters(parser?.(loadFixture(entry), clock) ?? []);
        expect(normalized).toHaveLength(entry.expectedMeters);
      });

      it("carries no identity in the frozen file", () => {
        const raw = readFileSync(resolve(FIXTURE_DIR, entry.file), "utf8");
        /* Redaction is by construction, and this proves it stays that way: a
           frozen sample must never regrow an email, a JWT, a bearer token, an
           api key or a real workspace id. */
        expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
        expect(raw).not.toContain("eyJ");
        expect(raw).not.toContain("Bearer ");
        expect(raw).not.toMatch(/sk-[A-Za-z0-9]/u);
        expect(raw).not.toMatch(/wrk_[A-Za-z0-9]/u);
      });
    });
  }
});
