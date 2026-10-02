import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import registry from "../../../provider_specs/provider-specs.json" with { type: "json" };
import legacy from "./provider-connect-legacy.json" with { type: "json" };
import { buildProviderDirectory, PROVIDER_RECOGNITION_ORDER } from "../src/provider-connect.js";

describe("generated provider directory", () => {
  it("preserves every field for the existing eight across connection states", () => {
    for (const [state, expected] of Object.entries(legacy)) {
      const states = Object.fromEntries(expected.map((row) => [row.connectorId, state]));
      expect(buildProviderDirectory(registry, { states }).filter(row => row.connectorId !== "cursor")).toEqual(expected);
    }
    expect(PROVIDER_RECOGNITION_ORDER).toEqual([...legacy.NOT_CONFIGURED.map((row) => row.specId), "cursor/editor"]);
  });

  it("takes labels and ordering from the supplied registry", () => {
    const custom = structuredClone(registry);
    const first = custom.providers.find((spec) => spec.directory?.order === 0)!;
    first.directory!.label = "Registry label";
    first.directory!.order = 100;
    const rows = buildProviderDirectory(custom);
    expect(rows.at(-1)?.displayName).toBe("Registry label");
    expect(rows.at(-1)?.specId).toBe(first.directory!.rowId);
  });

  it("does not promote an entry whose reader is absent", () => {
    const custom = structuredClone(registry);
    const first = custom.providers.find((spec) => spec.directory?.order === 0)!;
    first.support.reader = "absent";
    const row = buildProviderDirectory(custom).find((entry) => entry.specId === first.directory!.rowId);
    expect(row).toMatchObject({ availability: "planned", state: "PLANNED", action: "none" });
  });
});

describe("provider registry generator", () => {
  it("keeps the Codex runtime reader identity", () => {
    expect(registry.providers.find((spec) => spec.id === "openai/codex")?.collection?.readers)
      .toContainEqual(expect.objectContaining({ readerId: "codex_usage" }));
  });

  it("limits the documented fixture verification exception to Codex", async () => {
    const { parseYamlSubset, validateSpec } = await import(pathToFileURL(path.resolve("scripts/validate-provider-specs.mjs")).href);
    const file = "provider_specs/openai/codex.yaml";
    const spec = parseYamlSubset(readFileSync(file, "utf8"), file);
    spec.honesty.connector_id = "grok";
    spec.directory.connectorId = "grok";
    const fixtureIds = new Set(spec.verification.fixture_ids);

    expect(() => validateSpec(spec, file, "openai/codex.yaml", fixtureIds)).toThrow(
      "verification is UNVERIFIED until a verifier exists"
    );
  });

  it("keeps the four desktop only API billing sources experimental", () => {
    for (const id of ["anthropic/api", "openai/api", "xai/api", "moonshot/api"]) {
      expect(registry.providers.find((spec) => spec.id === id))
        .toMatchObject({ maturity: "experimental", acquisitionSurfaces: ["desktop"] });
    }
  });

  it("treats OpenRouter as a headline provider read by both implementations", () => {
    expect(registry.providers.find((spec) => spec.id === "openrouter/api"))
      .toMatchObject({ maturity: "headline", acquisitionSurfaces: ["desktop", "cli"] });
  });

  it("rejects invalid metadata and dangling meter references", async () => {
      const { parseYamlSubset, validateSpec } = await import(pathToFileURL(path.resolve("scripts/validate-provider-specs.mjs")).href);
      const file = 'provider_specs/anthropic/claude-code.yaml';
      const original = parseYamlSubset(readFileSync(file, 'utf8'), file);
      const mutations: Array<(spec: typeof original) => void> = [
        s => s.headlineMeter = 'missing',
        s => s.weeklyMeter = 'missing',
        s => s.acquisitionSurfaces = ['web'],
        s => s.displaySurfaces = ['unknown'],
        s => s.platforms = ['android'],
        s => s.platforms = ['windows'],
        s => s.acquisitionMethod = 'shell',
        s => s.maturity = 'verified',
        s => s.d5Review = '',
        s => s.noQuotaConcept = 'true',
        s => s.noQuotaConcept = true,
        s => s.meters = [],
        s => s.meters[0].kind = 'unknown',
        s => s.acquisitionSurfaces = ['desktop', 'desktop'],
        s => s.support.reader = 'absent',
        s => s.directory.order = -1,
      ];
      const results = mutations.map(mutate => {
        const spec = structuredClone(original);
        mutate(spec);
        try { validateSpec(spec, file, 'anthropic/claude-code.yaml', new Set()); return false; }
        catch { return true; }
      });
    expect(results).toEqual(Array(16).fill(true));
  });

  it("only removes the Ollama and LM Studio placeholder meters", () => {
    expect(registry.providers.filter((spec) => spec.noQuotaConcept).map((spec) => spec.id))
      .toEqual(["lmstudio/local", "ollama/local"]);
    for (const spec of registry.providers) {
      if (spec.noQuotaConcept) {
        expect(spec.meters).toEqual([]);
        expect(spec.headlineMeter).toBeNull();
      } else {
        expect(spec.meters.some((meter) => meter.id === spec.headlineMeter)).toBe(true);
      }
    }
  });

  it("produces byte identical registry and mirrors on two independent runs", async () => {
    const { generateRegistry } = await import(pathToFileURL(path.resolve("scripts/validate-provider-specs.mjs")).href);
    const temporary = mkdtempSync(path.join(tmpdir(), "openlimiter-registry-test-"));
    const artifacts = [
      "provider_specs/provider-specs.json",
      "apps/web/lib/provider-specs.generated.json",
      "apps/desktop/ui/provider-specs.generated.js",
    ];
    try {
      for (const run of ["first", "second"]) {
        await generateRegistry(["--emit", "--output-dir", path.join(temporary, run)]);
      }
      for (const artifact of artifacts) {
        expect(readFileSync(path.join(temporary, "first", artifact)))
          .toEqual(readFileSync(path.join(temporary, "second", artifact)));
      }
      expect(readFileSync(path.join(temporary, "first", artifacts[0]!)))
        .toEqual(readFileSync(path.join(temporary, "first", artifacts[1]!)));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
