/**
 * The 2.1 registry skeletons: validated like any spec, compiled into nothing.
 *
 * A skeleton names a provider every closed list already knows and claims
 * nothing a surface could read. These are the rules that keep it that way, and
 * the mark block that records where each vendor's own artwork came from.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import registry from "../../../provider_specs/provider-specs.json" with { type: "json" };

/* The wave's new specs. A skeleton is one still marked `enabled: false`, so
   each lane's spec leaves these checks the moment it is switched on. */
const SKELETONS = [
  "synthetic/subscription",
  "zai/coding-plan",
  "minimax/token-plan",
  "cline/hosted",
  "augment/auggie",
  "amp/cli",
  "kilo/cli",
].filter((id) => /^enabled: false$/mu.test(readFileSync("provider_specs/" + id + ".yaml", "utf8")));

async function validator() {
  return await import(pathToFileURL(path.resolve("scripts/validate-provider-specs.mjs")).href);
}

function load(parse: (text: string, file: string) => Record<string, unknown>, id: string) {
  const file = "provider_specs/" + id + ".yaml";
  return { file, relative: id + ".yaml", document: parse(readFileSync(file, "utf8"), file) };
}

describe("registry skeletons", () => {
  it("validates every skeleton and compiles none of them", async () => {
    const { parseYamlSubset, validateSpec, compileRegistry } = await validator();
    const entries = SKELETONS.map((id) => {
      const { file, relative, document } = load(parseYamlSubset, id);
      return validateSpec(document, file, relative, new Set());
    });
    for (const entry of entries) {
      expect(entry).toMatchObject({ enabled: false, maturity: "planned", acquisitionSurfaces: [], displaySurfaces: [] });
      expect(entry.mark.file).toMatch(/\.svg$/u);
    }
    const compiled = JSON.parse(compileRegistry(entries));
    expect(compiled.providers).toEqual([]);
    const shipped = new Set(registry.providers.map((spec) => spec.id));
    for (const id of SKELETONS) expect(shipped.has(id), id).toBe(false);
  });

  it.skipIf(SKELETONS.length === 0)("refuses a skeleton that claims anything a surface reads", async () => {
    const { parseYamlSubset, validateSpec } = await validator();
    const { file, relative, document } = load(parseYamlSubset, SKELETONS[0]!);
    const mutations: Array<(spec: any) => void> = [
      (spec) => { spec.maturity = "experimental"; },
      (spec) => { spec.support.reader = "implemented"; },
      (spec) => { spec.support.parser = "implemented"; },
      (spec) => { spec.displaySurfaces = ["desktop"]; },
      (spec) => { spec.acquisitionSurfaces = ["desktop"]; },
      (spec) => { spec.directory = { order: 40, rowId: "synthetic/subscription", label: "Synthetic", connectorId: "synthetic", access: "key" }; },
      (spec) => { spec.honesty = { connector_id: "synthetic", credential_origin: "user-key", data_interface_status: "documented-api", automation_risk: "low", verification: "UNVERIFIED" }; },
      (spec) => { spec.noQuotaConcept = true; },
      (spec) => { spec.headlineMeter = "quota"; },
      (spec) => { spec.enabled = "false"; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const spec = structuredClone(document) as any;
      mutate(spec);
      expect(() => validateSpec(spec, file, relative, new Set()), String(index)).toThrow();
    }
  });

  it.skipIf(SKELETONS.length === 0)("holds the mark block to one vendor file and one https source", async () => {
    const { parseYamlSubset, validateSpec, refuseUrlLiterals } = await validator();
    const { file, relative, document } = load(parseYamlSubset, SKELETONS[0]!);
    const refused: Array<(spec: any) => void> = [
      (spec) => { spec.mark.file = "missing.svg"; },
      (spec) => { spec.mark.file = "../amp.svg"; },
      (spec) => { spec.mark.source_url = "http://ampcode.com/app-icon.svg"; },
      (spec) => { spec.mark.source_url = null; },
      (spec) => { spec.mark.extra = "value"; },
      (spec) => { spec.source.source_url = "https://ampcode.com/app-icon.svg"; },
      (spec) => { spec.source_url = "https://ampcode.com/app-icon.svg"; },
    ];
    for (const [index, mutate] of refused.entries()) {
      const spec = structuredClone(document) as any;
      mutate(spec);
      expect(() => validateSpec(spec, file, relative, new Set()), String(index)).toThrow();
    }
    /* Checked as a finding, not a gap: no official SVG exists, so no mark. */
    const none = structuredClone(document) as any;
    none.mark = { file: null, source_url: null };
    expect(validateSpec(none, file, relative, new Set()).mark).toEqual({ file: null, sourceUrl: null });
    /* The literal check lets source_url carry exactly one https address. */
    expect(() => refuseUrlLiterals("  source_url: https://ampcode.com/app-icon.svg", "x")).not.toThrow();
    expect(() => refuseUrlLiterals("  source_url: https://a.example/x,https://b.example/y", "x")).toThrow();
    expect(() => refuseUrlLiterals("  file: https://ampcode.com/app-icon.svg", "x")).toThrow();
  });

  it("keeps a spec written before skeletons compiling exactly as it did", async () => {
    const { parseYamlSubset, validateSpec, compileRegistry } = await validator();
    const { file, relative, document } = load(parseYamlSubset, "openrouter/api");
    const entry = validateSpec(document, file, relative, new Set(["openrouter.documented.credits"]));
    expect(entry.enabled).toBe(true);
    const compiled = JSON.parse(compileRegistry([entry])).providers[0];
    expect("enabled" in compiled).toBe(false);
    expect("mark" in compiled).toBe(false);
    expect(compiled).toEqual(registry.providers.find((spec) => spec.id === "openrouter/api"));
  });
});
