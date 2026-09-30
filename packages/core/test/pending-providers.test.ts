/**
 * The 2.1 providers are registered everywhere and switched on nowhere.
 *
 * One switch per provider lives in three places, and this suite holds them
 * together: `enabled` in its descriptor in src/providers (which
 * PENDING_PROVIDER_CODES follows), `ENABLED` in its Rust module, and `enabled`
 * in its registry spec. It also proves what "switched off" means on this side:
 * never stored, never attributed, never advised on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PENDING_PROVIDER_CODES,
  PROVIDER_CODES,
  buildAdvice,
  cliAccountMaterial,
  isEnabledProviderCode,
  keyFingerprintMaterial,
  normalizeMetersReport,
  opaqueAccountId,
  type ProviderCode,
  type RawMeter
} from "../src/index.js";
import { snapshot } from "./helpers.js";

type WaveCode = "SYNTHETIC" | "ZAI" | "MINIMAX" | "CLINE" | "AUGMENT" | "AMP" | "KILO" | "COPILOT";

/** Each 2.1 provider, its Rust module and its registry spec, pending or not. */
const WAVE: Readonly<Record<WaveCode, { module: string; spec: string }>> = {
  SYNTHETIC: { module: "synthetic", spec: "synthetic/subscription" },
  ZAI: { module: "zai", spec: "zai/coding-plan" },
  MINIMAX: { module: "minimax", spec: "minimax/token-plan" },
  CLINE: { module: "cline", spec: "cline/hosted" },
  AUGMENT: { module: "augment", spec: "augment/auggie" },
  AMP: { module: "amp", spec: "amp/cli" },
  KILO: { module: "kilo", spec: "kilo/cli" },
  COPILOT: { module: "copilot", spec: "github/copilot" }
};

const read = (file: string) => readFileSync(path.resolve(file), "utf8");

describe("the one switch, in three places", () => {
  it("holds each 2.1 provider in exactly one list: pending, or switched on", () => {
    const pending = PENDING_PROVIDER_CODES as readonly string[];
    for (const code of Object.keys(WAVE)) {
      expect(pending.includes(code) !== isEnabledProviderCode(code), code).toBe(true);
    }
    for (const code of pending) expect(code in WAVE, code).toBe(true);
    for (const code of PROVIDER_CODES) expect(isEnabledProviderCode(code)).toBe(true);
  });

  it("agrees with every Rust module's ENABLED constant", () => {
    for (const [code, { module }] of Object.entries(WAVE)) {
      const source = read("apps/desktop/src-tauri/src/providers/" + module + ".rs");
      const stated = /pub\(crate\) const ENABLED: bool = (true|false);/u.exec(source)?.[1];
      expect(stated, code).toBeDefined();
      expect(stated === "true", code).toBe(isEnabledProviderCode(code));
    }
  });

  it("agrees with every registry spec, which compiles only once switched on", () => {
    const compiled = JSON.parse(read("provider_specs/provider-specs.json")) as { providers: { id: string }[] };
    for (const [code, { spec }] of Object.entries(WAVE)) {
      const text = read("provider_specs/" + spec + ".yaml");
      const enabled = !/^enabled: false$/mu.test(text);
      /* Copilot's spec predates the wave and stays the compiled planned entry
         it always was; every new skeleton states enabled: false. */
      if (code !== "COPILOT") expect(enabled, code).toBe(isEnabledProviderCode(code));
      const inRegistry = compiled.providers.some((entry) => entry.id === spec);
      expect(inRegistry, code).toBe(code === "COPILOT" || enabled);
    }
  });
});

describe("switched off means never stored and never named", () => {
  const now = "2026-01-01T00:01:00.000Z";

  it("refuses a pending provider's row and blames nobody for it", () => {
    for (const code of PENDING_PROVIDER_CODES) {
      const report = normalizeMetersReport([
        snapshot({ provider: code as ProviderCode }) as unknown as RawMeter,
        snapshot() as unknown as RawMeter
      ]);
      expect(report.snapshots.map((row) => row.provider)).toEqual(["CLAUDE"]);
      /* Anonymous, like an unknown code: no failure row can name it. */
      expect(report.rejected).toEqual([]);
      expect(report.dropped).toBe(1);
    }
  });

  it("never lists a pending provider as unknown in advice", () => {
    const advice = buildAdvice([snapshot()], now);
    for (const code of PENDING_PROVIDER_CODES) {
      expect(advice.unknownProviders).not.toContain(code);
    }
    expect(advice.unknownProviders).toEqual(PROVIDER_CODES.filter((code) => code !== "CLAUDE"));
  });
});

interface RouteVector {
  provider: ProviderCode;
  route: "api_key" | "account_token" | "local_cli";
  input: string;
  scope?: "personal" | "organization";
  material: string;
  expected: string;
}

describe("the account identity contract, per route", () => {
  const vectors = JSON.parse(
    read("packages/core/src/contracts/account-route-vectors.json")
  ) as RouteVector[];

  for (const vector of vectors) {
    it(vector.provider + " " + vector.route + " " + JSON.stringify(vector.input), () => {
      const material = vector.route === "api_key" ? keyFingerprintMaterial(vector.input)
        : vector.route === "local_cli" ? cliAccountMaterial(vector.input, vector.scope!)
        : vector.input;
      expect(material).toBe(vector.material);
      expect(opaqueAccountId(vector.provider, material)).toBe(vector.expected);
    });
  }

  it("keeps a key out of its own identity", () => {
    const material = keyFingerprintMaterial("sk-fixture-secret-value");
    expect(material).not.toContain("sk-fixture-secret-value");
    expect(material).toMatch(/^api-key-sha256:[0-9a-f]{64}$/u);
  });

  it("makes one account of one key and two of two keys, and never aliases scopes", () => {
    const synthetic = vectors.filter((vector) => vector.provider === "SYNTHETIC");
    expect(synthetic[0]!.expected).toBe(synthetic[1]!.expected);
    expect(synthetic[0]!.expected).not.toBe(synthetic[2]!.expected);
    const augment = vectors.filter((vector) => vector.provider === "AUGMENT");
    expect(augment[0]!.expected).not.toBe(augment[1]!.expected);
    /* The same key on two vendors is two accounts. */
    const zai = vectors.find((vector) => vector.provider === "ZAI")!;
    expect(zai.material).toBe(synthetic[0]!.material);
    expect(zai.expected).not.toBe(synthetic[0]!.expected);
  });
});
