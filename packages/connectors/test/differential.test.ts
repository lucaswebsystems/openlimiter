import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeMeters, type RawMeter } from "@openlimiter/core";
import { parseClaudePayload } from "../src/claude.js";
import { parseCodexPayload } from "../src/codex.js";
import { parseOpenrouterPayload } from "../src/openrouter.js";
import { parseKimiPayload } from "../src/kimi.js";
import { parseCursorPayload } from "../src/cursor.js";
import { parseSyntheticPayload } from "../src/synthetic.js";
import { parseZaiPayload } from "../src/zai.js";
import { parseMinimaxPayload } from "../src/minimax.js";
import { parseClinePayload } from "../src/cline.js";
import { parseAugmentPayload } from "../src/augment.js";
import { parseAmpPayload } from "../src/amp.js";
import { parseKiloPayload } from "../src/kilo.js";
import { parseCopilotPayload } from "../src/copilot.js";

const root = resolve(process.cwd(), "packages/connectors/fixtures");
/* The 2.1 providers join when their lane adds a corpus folder: the folder is
   the registration, and nothing in this file names a case. */
const wave = {
  synthetic: parseSyntheticPayload,
  zai: parseZaiPayload,
  minimax: parseMinimaxPayload,
  cline: parseClinePayload,
  augment: parseAugmentPayload,
  amp: parseAmpPayload,
  kilo: parseKiloPayload,
  copilot: parseCopilotPayload
};
const providers = [
  "claude", "codex", "openrouter", "kimi", "cursor",
  ...Object.keys(wave).filter((provider) => existsSync(resolve(root, "cases", provider)))
];
type Provider = string;
type Answer = { outcome: "readings" | "rejected"; readings: unknown[] };
interface Case {
  provider: Provider;
  case: string;
  reader: string;
  now: string;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  fixture?: string;
}
interface Expected {
  expected: Answer;
}
const parsers: Record<string, (payload: unknown, now: string) => RawMeter[] | null> = {
  claude: parseClaudePayload,
  codex: parseCodexPayload,
  openrouter: parseOpenrouterPayload,
  kimi: parseKimiPayload,
  cursor: parseCursorPayload,
  ...wave
};
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a parser string");
  return value;
}
const instant = (value: unknown): string | null =>
  value === null ? null : new Date(text(value)).toISOString();
function windowFields(value: unknown): { kind: unknown; durationSeconds: unknown } {
  if (value === null || typeof value !== "object") throw new Error("Expected a parser window");
  const window = value as Record<string, unknown>;
  return { kind: window["kind"], durationSeconds: window["durationSeconds"] ?? null };
}

/** A projection, not a second parser. Do not repair or infer provider fields here. */
function normalize(rows: RawMeter[] | null): Answer {
  if (rows === null) return { outcome: "rejected", readings: [] };
  return {
    outcome: "readings",
    readings: rows.map(row => ({
      provider: row.provider,
      meter: text(row.meter),
      value: row.value,
      unit: row.unit,
      window: windowFields(row.window),
      resetAt: instant(row.resetAt),
      precision: row.precision,
      source: row.source,
      // Legacy parsers do not set the optional contract discriminators.
      kind: "kind" in row ? row.kind ?? null : null,
      availability: "availability" in row ? row.availability ?? null : null,
      currency: row.currency ?? null,
      usedAmount: row.usedAmount ?? null,
      limitAmount: row.limitAmount ?? null,
      observedAt: instant(row.observedAt)
    })).sort((a, b) => a.meter < b.meter ? -1 : a.meter > b.meter ? 1 : 0)
  };
}

const divergenceList = readFileSync(resolve(root, "expected/KNOWN_DIVERGENCES.md"), "utf8");
describe("shared differential provider corpus", () => {
  for (const provider of providers) {
    const names = readdirSync(resolve(root, "cases", provider)).filter(name => name.endsWith(".json")).sort();
    it(provider + " has cases and no orphan expected files", () => {
      expect(names.length).toBeGreaterThan(0);
      expect(readdirSync(resolve(root, "expected", provider)).sort()).toEqual(names);
    });
    for (const name of names) {
      const spec = json<Case>(resolve(root, "cases", provider, name));
      const answer = json<Expected>(resolve(root, "expected", provider, name));
      const id = provider + "/" + spec.case;
      it(id, () => {
        expect(spec.provider).toBe(provider);
        expect(name).toBe(spec.case + ".json");
        expect(spec.now).toBe("2026-08-07T12:00:00.000Z");
        expect(spec.reader).toMatch(provider === "openrouter" ? /^(key|credits)$/u
          : provider in wave ? /^[a-z][a-z_]*$/u : /^usage$/u);
        expect([200, 401, 403, 429]).toContain(spec.status);
        expect(spec.headers).toEqual(spec.status === 429 ? { "retry-after": "120" } : {});
        expect(spec.fixture === undefined).toBe(Object.hasOwn(spec, "body"));
        const body = spec.fixture === undefined ? spec.body : json<unknown>(resolve(root, spec.fixture));
        // Even error bodies reach the parser. No test-only HTTP status shortcut can hide acceptance.
        const rows = parsers[provider]!(body, spec.now);
        const actual = normalize(rows);
        if (provider === "cursor" && rows !== null) {
          expect(normalizeMeters(rows)).toHaveLength(rows.length);
          for (const row of rows) expect(row.labels).toMatchObject({ verification: "VERIFIED_FIXTURES" });
        }
        expect(divergenceList.trim()).toBe("");
        expect(actual).toEqual(answer.expected);
        if (spec.status !== 200) expect(actual).toEqual({ outcome: "rejected", readings: [] });
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
        expect(text).not.toMatch(/eyJ|Bearer |sk-[A-Za-z0-9]|wrk_[A-Za-z0-9]/u);
      });
    }
  }
});

// This small validator deliberately supports only the vocabulary used by the
// embedded JSON schema. Unknown keywords fail rather than silently passing.
// No retry, lease or freshness implementation is introduced in this unit.
type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  minItems?: number;
  minLength?: number;
  pattern?: string;
  format?: string;
};
function checkSchema(schema: Schema, value: unknown, path = "$"): void {
  const vocabulary = ["type", "properties", "required", "additionalProperties", "items",
    "enum", "minimum", "minItems", "minLength", "pattern", "format"];
  for (const key of Object.keys(schema)) expect(vocabulary, path + ": schema keyword").toContain(key);
  const types = typeof schema.type === "string" ? [schema.type] : schema.type;
  const matches = (type: string): boolean => {
    switch (type) {
      case "null": return value === null;
      case "array": return Array.isArray(value);
      case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "string": return typeof value === "string";
      case "boolean": return typeof value === "boolean";
      default: throw new Error("Unsupported JSON schema type: " + type);
    }
  };
  if (types) expect(types.some(matches), path + ": type").toBe(true);
  if (schema.enum) expect(schema.enum, path + ": enum").toContainEqual(value);
  if (schema.minimum !== undefined) expect(value, path).toBeGreaterThanOrEqual(schema.minimum);
  if (typeof value === "string") {
    if (schema.minLength !== undefined) expect(value.length, path).toBeGreaterThanOrEqual(schema.minLength);
    if (schema.pattern) expect(value, path).toMatch(new RegExp(schema.pattern, "u"));
    if (schema.format) {
      expect(schema.format).toBe("date-time");
      expect(value, path).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
      expect(Number.isFinite(Date.parse(value)), path).toBe(true);
      expect(new Date(value).toISOString(), path).toBe(value);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) expect(value.length, path).toBeGreaterThanOrEqual(schema.minItems);
    if (schema.items) value.forEach((item, i) => checkSchema(schema.items!, item, path + "[" + i + "]"));
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) expect(Object.hasOwn(object, key), path + "." + key).toBe(true);
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) checkSchema(property, item, path + "." + key);
      else if (schema.additionalProperties === false) throw new Error(path + ": unexpected " + key);
    }
  }
}

describe("shared policy vectors, schema only until L1a", () => {
  const policy = json<{ schema: Schema; vectors: Record<string, { id: string }[]> }>(
    resolve(process.cwd(), "packages/core/src/contracts/policy-vectors.json")
  );
  it("validates every vector against the embedded JSON schema", () => {
    checkSchema(policy.schema, policy.vectors);
    for (const vectors of Object.values(policy.vectors)) {
      expect(new Set(vectors.map(vector => vector.id)).size).toBe(vectors.length);
    }
  });
  it("rejects a missing field, wrong type, invalid date and unknown property", () => {
    const first = policy.vectors["retry"]?.[0] as { id: string; input: Record<string, unknown> } | undefined;
    expect(first).toBeDefined();
    for (const replacement of [
      { id: "missing-fields" },
      { ...first, id: 42 },
      { ...first, unexpected: true },
      { ...first, input: { ...first?.input, now: "not-a-date" } },
      { ...first, input: { ...first?.input, jitterSeconds: -1 } }
    ]) {
      const invalid = { ...policy.vectors, retry: [replacement] };
      expect(() => checkSchema(policy.schema, invalid)).toThrow();
    }
  });
});
