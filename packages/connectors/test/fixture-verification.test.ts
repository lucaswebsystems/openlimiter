import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RawMeter } from "@openlimiter/core";
import { describe, expect, it } from "vitest";
import {
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseOpencodePayload,
  parseOpenrouterPayload,
  connectors
} from "../src/index.js";

/**
 * The fixture verification markers, held honest.
 *
 * `fixtures/verification.json` records, per provider, whether its frozen
 * redacted sample is trusted enough to call the parser FIXTURE VERIFIED. This
 * suite makes the marker mean something: a provider may be marked verified only
 * if its frozen fixture actually parses to the meters the manifest expects, and
 * a provider marked unverified must say, in words, why its evidence is too thin.
 *
 * The marker is deliberately NOT the honesty `verification` label in
 * `provider_specs`. That label is pinned to the literal "UNVERIFIED" by the core
 * types for every provider whose interface the vendor does not officially
 * publish, and this suite asserts the two never get conflated.
 */

const FIXTURE_DIR = resolve(process.cwd(), "packages/connectors/fixtures");

type Parser = (payload: unknown, now: string) => RawMeter[] | null;

const parsers: Readonly<Record<string, Parser>> = {
  parseClaudePayload,
  parseOpenrouterPayload,
  parseCodexPayload,
  parseAntigravityPayload,
  parseOpencodePayload
};

interface ManifestProvider {
  connector: string;
  file: string;
  encoding: "json" | "text";
  parser: string;
  expectedMeters: number;
}

interface Manifest {
  captureClock: string;
  providers: readonly ManifestProvider[];
}

interface Marker {
  fixtureVerified: boolean;
  evidence: string;
  reason: string;
}

interface Verification {
  note: string;
  providers: Readonly<Record<string, Marker>>;
}

const manifest = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "manifest.json"), "utf8")
) as Manifest;

const verification = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "verification.json"), "utf8")
) as Verification;

const LIVE_PROVIDERS = new Set([
  "claude",
  "openrouter",
  "codex",
  "antigravity",
  "opencode"
]);

function loadFixture(entry: ManifestProvider): unknown {
  const raw = readFileSync(resolve(FIXTURE_DIR, entry.file), "utf8");
  return entry.encoding === "text" ? raw : JSON.parse(raw);
}

describe("fixture verification markers", () => {
  it("keeps the marker separate from the honesty label, which stays UNVERIFIED", () => {
    expect(verification.note.toLowerCase()).toContain("unverified");
    /* Every shipped connector's honesty label is still UNVERIFIED, whatever the
       fixture marker says. The two live side by side and never merge. */
    expect(connectors.every((connector) => connector.labels.verification === "UNVERIFIED"))
      .toBe(true);
  });

  it("marks only known live providers", () => {
    for (const id of Object.keys(verification.providers)) {
      expect(LIVE_PROVIDERS.has(id), id + " is not a known live provider").toBe(true);
    }
  });

  for (const [id, marker] of Object.entries(verification.providers)) {
    describe(id, () => {
      it("carries an explicit boolean and a non empty reason", () => {
        expect(typeof marker.fixtureVerified).toBe("boolean");
        expect(typeof marker.reason).toBe("string");
        expect(marker.reason.length).toBeGreaterThan(0);
      });

      if (marker.fixtureVerified) {
        it("only claims verified when its frozen fixture actually parses", () => {
          const entry = manifest.providers.find((provider) => provider.connector === id);
          expect(entry, "no manifest entry for " + id).toBeDefined();
          if (entry === undefined) return;
          const parser = parsers[entry.parser];
          expect(parser, "no parser named " + entry.parser).toBeDefined();
          const meters = parser?.(loadFixture(entry), manifest.captureClock) ?? null;
          expect(meters).not.toBeNull();
          expect(meters).toHaveLength(entry.expectedMeters);
        });
      } else {
        it("says, in words, why its evidence is too thin", () => {
          expect(marker.reason.toLowerCase()).toMatch(
            /thin|scrape|layout|no .*interface|not .*published|unverified/u
          );
        });
      }
    });
  }
});
