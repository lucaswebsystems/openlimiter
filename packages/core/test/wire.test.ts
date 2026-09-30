import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  chooseWireVersion, readWireSample, toWireSampleV3, WIRE_SCHEMA_VERSION_V3,
  type LocalWireSample, type WireSampleV3
} from "../src/contracts/wire.js";
import {
  CONNECTOR_VERIFICATIONS, SNAPSHOT_KINDS, type Snapshot,
  type SnapshotAvailability, type SnapshotCurrency, type SnapshotPrecision, type SnapshotSource
} from "../src/types.js";

// Resolve from the root invocation rather than a compiled test output folder.
const core = path.resolve("packages/core");
const fixturesPath = path.join(core, "fixtures/wire");
interface Fixture {
  schema_version: 2 | 3;
  sample: unknown;
  local?: LocalWireSample;
  error?: string;
}
const fixtures = readdirSync(fixturesPath).filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, fixture: JSON.parse(readFileSync(path.join(fixturesPath, name), "utf8")) as Fixture }));

const baseline: WireSampleV3 = {
  account_id: "default", provider: "CLAUDE", meter: "FIVE_HOUR",
  window_id: "FIVE_HOUR", usage_percent: 42, reset_at: null,
  observed_at: "2026-09-28T12:00:00.000Z", stale: false
};

const snapshot: Snapshot = {
  provider: "CLAUDE", meter: "FIVE_HOUR", value: 42, unit: "PERCENT",
  window: { kind: "rolling", durationSeconds: 18_000 }, resetAt: null,
  source: "native_payload", precision: "exact",
  observedAt: "2026-09-28T12:00:00.000Z", expiresAt: "2026-09-28T12:05:00.000Z",
  labels: {
    credentialOrigin: "official-local-tool", dataInterfaceStatus: "native-statusline-payload",
    automationRisk: "low", verification: "UNVERIFIED"
  }, kind: "quota_percent"
};

describe("wire fixture round trips", () => {
  for (const { name, fixture } of fixtures) {
    if (fixture.error !== undefined) {
      it(`rejects ${name} with a clear reason`, () => {
        expect(() => readWireSample(fixture.sample)).toThrow(fixture.error);
      });
    } else {
      it(`round trips ${name} without loss`, () => {
        const local = readWireSample(fixture.sample);
        expect(local).toEqual(fixture.local);
        const wire = toWireSampleV3(local);
        expect(wire).toEqual(fixture.sample);
        expect(readWireSample(JSON.parse(JSON.stringify(wire)))).toEqual(local);
        expect(readWireSample(toWireSampleV3(fixture.local!))).toEqual(fixture.local);
      });
      if (fixture.schema_version === 2) {
        it(`leaves every new field unknown in ${name}`, () => {
          const local = readWireSample(fixture.sample);
          for (const key of ["source", "precision", "verification", "verificationEvidence", "kind", "availability", "retryAt"] as const) {
            expect(local[key]).toBeUndefined();
            expect(Object.hasOwn(local, key)).toBe(false);
          }
        });
      }
    }
  }
});

describe("Snapshot to wire v3", () => {
  it("maps explicit local metadata and preserves zero", () => {
    const wire = toWireSampleV3({ ...snapshot, value: 0, accountId: "personal" }, snapshot.observedAt);
    expect(wire).toEqual({ ...baseline, account_id: "personal", usage_percent: 0,
      source: "native_payload", precision: "exact", verification: "UNVERIFIED", kind: "quota_percent" });
    expect(readWireSample(wire).usagePercent).toBe(0);
  });

  it("never derives kind from the unit", () => {
    const { kind: _kind, ...withoutKind } = snapshot;
    expect(toWireSampleV3(withoutKind).kind).toBeUndefined();
  });

  it("evaluates staleness at conversion time with an injectable clock", () => {
    expect(toWireSampleV3(snapshot, snapshot.observedAt).stale).toBe(false);
    expect(toWireSampleV3(snapshot, snapshot.expiresAt).stale).toBe(true);
    expect(toWireSampleV3(snapshot, "2026-09-29T12:00:00.000Z").stale).toBe(true);
  });

  it.each([0, 42])("suppresses a placeholder percent %s during rate limiting", (value) => {
    const wire = toWireSampleV3({ ...snapshot, value, availability: "rate_limited", retryAt: "2026-09-28T12:10:00.000Z" });
    expect(wire).not.toHaveProperty("usage_percent");
    expect(wire).not.toHaveProperty("percent");
    expect(readWireSample(wire)).toMatchObject({ availability: "rate_limited", retryAt: "2026-09-28T12:10:00.000Z" });
  });

  it("maps live evidence with snake case keys and no verification upgrade", () => {
    const evidence = { providerVersion: "1", accountShape: "individual", os: "windows", date: snapshot.observedAt };
    const wire = toWireSampleV3({ ...snapshot, labels: { ...snapshot.labels, verification: "VERIFIED_LIVE", verificationEvidence: evidence } });
    expect(wire.verification_evidence).toEqual({ provider_version: "1", account_shape: "individual", os: "windows", date: snapshot.observedAt });
    expect(readWireSample(wire).verificationEvidence).toEqual(evidence);
    expect(readWireSample(wire).verification).toBe("VERIFIED_LIVE");
  });

  it("preserves an explicit CNY amount without conversion", () => {
    const wire = toWireSampleV3({ ...snapshot, unit: "CREDITS", value: 12.5, usedAmount: 12.5, limitAmount: 100, currency: "CNY", kind: "spend" });
    expect(wire.amount).toBe(12.5);
    expect(wire.currency).toBe("CNY");
    expect(wire.usage_percent).toBeUndefined();
  });

  it("carries a balance as its amount, its currency and its direction", () => {
    const wire = toWireSampleV3({ ...snapshot, unit: "CREDITS", value: 12.34, kind: "money_balance", currency: "USD" });
    expect(wire).toMatchObject({ amount: 12.34, currency: "USD", kind: "money_balance" });
    expect(wire).not.toHaveProperty("usage_percent");
    expect(readWireSample(wire)).toMatchObject({ amount: 12.34, currency: "USD", kind: "money_balance" });
  });

  it("never turns unlimited into a percentage", () => {
    const wire = toWireSampleV3({ ...snapshot, value: 0, availability: "unlimited" });
    expect(wire).not.toHaveProperty("usage_percent");
    expect(wire.availability).toBe("unlimited");
  });

  it("rejects nonpercent snapshots without an explicit representable amount", () => {
    expect(() => toWireSampleV3({ ...snapshot, unit: "TOKENS", kind: "token_count" })).toThrow("unit has no v2 usage representation");
  });
});

describe("wire input validation", () => {
  it.each([
    ["source", "guessed", "source must be one of"],
    ["precision", "approximate", "precision must be one of"],
    ["kind", "PERCENT", "kind must be one of"],
    ["availability", "offline", "availability must be one of"],
    ["verification", null, "verification must be one of"],
    ["stale", "false", "stale must be a boolean"],
    ["usage_percent", -1, "usage_percent must be a finite number"],
    ["usage_percent", Number.NaN, "usage_percent must be a finite number"],
    ["usage_percent", Number.POSITIVE_INFINITY, "usage_percent must be a finite number"],
    ["usage_percent", 100_001, "usage_percent must be a finite number"],
    ["observed_at", "2026-02-30T12:00:00.000Z", "observed_at must be a canonical ISO instant"],
    ["account_id", "bad account", "account_id must be a valid account alias"],
    ["retry_at", "2026-09-28T12:10:00.000Z", "retry_at requires rate_limited"],
    ["source", undefined, "must not be undefined"]
  ])("rejects invalid %s (%s)", (field, value, reason) => {
    expect(() => readWireSample({ ...baseline, [field]: value })).toThrow(reason);
  });

  it.each([null, [], 42, "sample"])("rejects nonobject sample %s", (value) => {
    expect(() => readWireSample(value)).toThrow("sample must be an object");
  });

  it.each(["UNVERIFIED", "VERIFIED_FIXTURES", undefined])("rejects evidence with verification %s", (verification) => {
    const row = { ...baseline, ...(verification === undefined ? {} : { verification }), verification_evidence: {} };
    expect(() => readWireSample(row)).toThrow("verification_evidence requires VERIFIED_LIVE");
  });

  it("rejects unknown evidence keys", () => {
    expect(() => readWireSample({ ...baseline, verification: "VERIFIED_LIVE", verification_evidence: {
      provider_version: "1", account_shape: "individual", os: "windows", date: baseline.observed_at, surprise: true
    } })).toThrow("verification_evidence.surprise is an unknown key");
  });

  it.each([
    [{ percent: 41 }, "usage_percent/percent aliases must agree"],
    [{ code: "OTHER" }, "meter/code aliases must agree"],
    [{ resets_at: "2026-09-28T13:00:00.000Z" }, "reset_at/resets_at aliases must agree"],
    [{ amount: 0 }, "amount/currency must be supplied together"],
    [{ amount: 1, currency: "EUR" }, "currency must be one of"],
    [{ source_period: [baseline.observed_at] }, "source_period must contain two ISO instants"],
    [{ source_period: ["2026-09-29T12:00:00.000Z", baseline.observed_at] }, "source_period must be ordered"],
    [{ usage_percent: null }, "requires a numeric percent, an amount, or availability"],
    [{ usage_percent: null, percent: 0, availability: "rate_limited" }, "usage_percent/percent aliases must agree"]
  ])("rejects invalid combinations %j", (fields, reason) => {
    expect(() => readWireSample({ ...baseline, ...fields })).toThrow(reason);
  });

  it("rejects a numeric percent alias alongside availability", () => {
    const { usage_percent: _percent, ...row } = baseline;
    expect(() => readWireSample({ ...row, percent: 0, availability: "rate_limited" })).toThrow("cannot accompany a numeric percent");
  });

  it("preserves metadata absence on v3 and accepts the legacy percent range", () => {
    expect(readWireSample({ ...baseline, usage_percent: 100_000 }).usagePercent).toBe(100_000);
    expect(readWireSample(baseline).verification).toBeUndefined();
  });
});

describe("wire schema parity", () => {
  interface ObjectSchema { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }
  const schema = JSON.parse(readFileSync(path.join(core, "src/contracts/wire-v3.schema.json"), "utf8"));
  const source = ts.createSourceFile("wire.ts", readFileSync(path.join(core, "src/contracts/wire.ts"), "utf8"), ts.ScriptTarget.Latest, true);

  it.each([
    ["WireSampleV3", schema.$defs.sample], ["WireEnvelopeV3", schema],
    ["WireVerificationEvidence", schema.$defs.verificationEvidence],
    ["WireApiSpendSample", schema.$defs.apiSpendSample],
    ["WireForecastInput", schema.$defs.forecastInput]
  ])("matches the actual %s TypeScript field list and required fields", (name, definition: ObjectSchema) => {
    const declaration = source.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name);
    expect(declaration).toBeDefined();
    const properties = declaration!.members.filter(ts.isPropertySignature);
    expect(properties.map((property) => property.name.getText(source)).sort()).toEqual(Object.keys(definition.properties).sort());
    expect(properties.filter((property) => !property.questionToken).map((property) => property.name.getText(source)).sort()).toEqual([...definition.required].sort());
    expect(definition.additionalProperties).toBe(false);
  });

  it("uses draft 2020-12 and freezes version 3", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.schema_version.const).toBe(WIRE_SCHEMA_VERSION_V3);
    expect(WIRE_SCHEMA_VERSION_V3).toBe(3);
  });

  it("matches local closed metadata value sets", () => {
    const availabilities: Record<SnapshotAvailability, true> = {
      network_failure: true, missing_credentials: true, expired_credentials: true,
      access_denied: true, missing_subscription: true, unlimited: true,
      quota_unavailable: true, rate_limited: true, schema_drift: true
    };
    const sources: Record<SnapshotSource, true> = { native_payload: true, documented_api: true, internal_payload: true, authenticated_page: true, manual_entry: true };
    const precisions: Record<SnapshotPrecision, true> = { exact: true, estimated: true, manual: true };
    const currencies: Record<SnapshotCurrency, true> = { USD: true, CNY: true };
    const properties = schema.$defs.sample.properties;
    expect(properties.source.enum.sort()).toEqual(Object.keys(sources).sort());
    expect(properties.precision.enum.sort()).toEqual(Object.keys(precisions).sort());
    expect(properties.currency.anyOf[0].enum.sort()).toEqual(Object.keys(currencies).sort());
    expect(properties.verification.enum).toEqual([...CONNECTOR_VERIFICATIONS]);
    expect(properties.kind.enum).toEqual([...SNAPSHOT_KINDS]);
    expect(properties.availability.enum.sort()).toEqual(Object.keys(availabilities).sort());
    for (const availability of Object.keys(availabilities)) {
      const { usage_percent: _percent, ...row } = baseline;
      expect(readWireSample({ ...row, availability }).availability).toBe(availability);
    }
  });
});

describe("chooseWireVersion", () => {
  it.each([
    [[], 2], [[2], 2], [[1, 2], 2], [[4], 2], [[3.1], 2],
    [[3], 3], [[2, 3], 3], [[3, 2], 3], [[4, 3, 3], 3]
  ])("chooses %j -> %s", (accepted, expected) => {
    expect(chooseWireVersion(accepted)).toBe(expected);
  });
});
