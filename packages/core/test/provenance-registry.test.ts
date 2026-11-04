import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const registryModule = pathToFileURL(resolve("scripts/validate-provider-specs.mjs")).href;
const { parseYamlSubset, validateSpec } = await import(registryModule) as {
  parseYamlSubset(text: string, file: string): Record<string, unknown>;
  validateSpec(document: Record<string, unknown>, file: string, relative: string, fixtures: Set<string>): unknown;
};

/* The five wave 2 specs record their endpoint terms, their sources with
   licences and their mark; the validator holds every one of those fields. */
const SPECS: readonly [string, readonly string[]][] = [
  ["github/copilot.yaml", ["copilot.provisional.user", "copilot.live.pending"]],
  ["amp/amp.yaml", ["amp.provisional.balance", "amp.live.pending"]],
  ["codebuff/codebuff.yaml", ["codebuff.official_source.usage", "codebuff.live.pending"]],
  ["kiro/kiro-cli.yaml", ["kiro.provisional.usage_limits", "kiro.live.pending"]],
  ["charm/crush.yaml", ["crush.official_source.credits", "crush.live.pending"]],
];

function load(relative: string) {
  const file = "provider_specs/" + relative;
  return { file, document: parseYamlSubset(readFileSync(resolve(file), "utf8"), file) };
}

describe("provider provenance", () => {
  for (const [relative, fixtures] of SPECS) {
    const validate = (document: Record<string, unknown>) =>
      validateSpec(document, load(relative).file, relative, new Set(fixtures));

    it(relative + " records terms, licensed sources and its mark", () => {
      const { document } = load(relative);
      const provenance = document["provenance"] as Record<string, unknown>;
      expect(provenance).toMatchObject({ endpoint_terms: "unreviewed", mark: "initials", mark_licence: null });
      const sources = provenance["sources"] as Record<string, unknown>[];
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) expect(typeof source["licence"]).toBe("string");
      expect(() => validate(document)).not.toThrow();
    });

    it(relative + " refuses an unknown terms status, an unlicensed source and an unlicensed mark", () => {
      for (const change of [
        (block: Record<string, unknown>) => { block["endpoint_terms"] = "probably_fine"; },
        (block: Record<string, unknown>) => { delete (block["sources"] as Record<string, unknown>[])[0]!["licence"]; },
        (block: Record<string, unknown>) => { block["mark"] = "logo.svg"; },
        (block: Record<string, unknown>) => { block["sources"] = []; },
      ]) {
        const { document } = load(relative);
        change(document["provenance"] as Record<string, unknown>);
        expect(() => validate(document)).toThrow();
      }
    });
  }
});
