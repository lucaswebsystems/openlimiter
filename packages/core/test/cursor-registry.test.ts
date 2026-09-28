import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const registryModule = pathToFileURL(resolve("scripts/validate-provider-specs.mjs")).href;
const { parseYamlSubset, validateSpec } = await import(registryModule) as {
  parseYamlSubset(text: string, file: string): Record<string, unknown>;
  validateSpec(document: Record<string, unknown>, file: string, relative: string, fixtures: Set<string>): {
    maturity: string; honesty: { verification: string }; collection: { readers: { readerId: string }[] };
  };
};
const file = "provider_specs/cursor/editor.yaml";
function spec() { return parseYamlSubset(readFileSync(resolve(file), "utf8"), file); }
function validate(document: Record<string, unknown>) {
  return validateSpec(document, file, "cursor/editor.yaml", new Set(["cursor.synthetic.normal"]));
}

describe("Cursor registry contract", () => {
  it("carries experimental maturity and fixture verification through generated data", () => {
    expect(validate(spec())).toMatchObject({ maturity: "experimental", honesty: { verification: "VERIFIED_FIXTURES" },
      collection: { readers: [{ readerId: "cursor_usage", endpointId: "cursor_usage", credentialKind: "cursor_session" }] } });
  });
  it("refuses live verification without a live verifier", () => {
    const document = spec();
    (document["honesty"] as Record<string, unknown>)["verification"] = "VERIFIED_LIVE";
    expect(() => validate(document)).toThrow();
  });
  it("refuses an undeclared reader", () => {
    const document = spec();
    ((document["collection"] as { readers: Record<string, unknown>[] }).readers[0]!)["reader_id"] = "unreviewed_reader";
    expect(() => validate(document)).toThrow();
  });
  it("requires the pinned fixture before accepting the verification label", () => {
    expect(() => validateSpec(spec(), file, "cursor/editor.yaml", new Set())).toThrow();
  });
});
