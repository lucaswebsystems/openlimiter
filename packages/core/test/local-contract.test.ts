import { describe, expect, it } from "vitest";
import { normalizeMeter } from "../src/normalizer.js";
import {
  CONNECTOR_VERIFICATIONS, MAX_SNAPSHOT_AMOUNT, PROVIDER_CODES, SNAPSHOT_KINDS,
  type RawMeter
} from "../src/types.js";
import {
  availabilityConnectionReason, CONNECTION_REASONS, SNAPSHOT_AVAILABILITIES
} from "../src/connection-state.js";
import { snapshot } from "./helpers.js";

const evidence = {
  providerVersion: "2.0.0", accountShape: "individual", os: "windows",
  date: "2026-01-01T00:00:00.000Z"
};
const raw = (patch: Partial<RawMeter> = {}): RawMeter => ({ ...snapshot(), ...patch });

describe("local snapshot contract", () => {
  it("local_contract_legacy_bytes", () => {
    const before = JSON.stringify(snapshot());
    const parsed = normalizeMeter(JSON.parse(before) as RawMeter);
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).toBe(before);
    expect(parsed).not.toHaveProperty("kind");
    expect(parsed).not.toHaveProperty("availability");
    expect(parsed).not.toHaveProperty("retryAt");
    expect(parsed?.labels).not.toHaveProperty("verificationEvidence");
  });

  it("local_contract_verification", () => {
    for (const verification of CONNECTOR_VERIFICATIONS) {
      const row = raw({ labels: { ...snapshot().labels, verification } });
      const result = normalizeMeter(row);
      expect(result?.labels.verification).toBe(verification);
      expect(JSON.stringify(result)).toBe(JSON.stringify(row));
      expect(normalizeMeter(JSON.parse(JSON.stringify(result)) as RawMeter)).toEqual(result);
    }
    for (const verification of ["VERIFIED", "verified_live", "", null, 1]) {
      expect(normalizeMeter(raw({ labels: { ...snapshot().labels, verification } }))).toBeNull();
    }
    for (const verification of [undefined, "UNVERIFIED", "VERIFIED_FIXTURES"]) {
      expect(normalizeMeter(raw({ labels: {
        ...snapshot().labels, verification, verificationEvidence: evidence
      } }))).toBeNull();
    }
    const live = raw({ labels: {
      ...snapshot().labels, verification: "VERIFIED_LIVE", verificationEvidence: evidence
    } });
    expect(JSON.stringify(normalizeMeter(live))).toBe(JSON.stringify(live));
    for (const invalid of [null, [], {}, "proof",
      { ...evidence, providerVersion: " " }, { ...evidence, accountShape: 1 },
      { ...evidence, os: "" }, { ...evidence, date: "2026-01-01" },
      { ...evidence, date: "2026-02-30T00:00:00.000Z" }]) {
      expect(normalizeMeter(raw({ labels: {
        ...snapshot().labels, verification: "VERIFIED_LIVE", verificationEvidence: invalid
      } }))).toBeNull();
    }
  });

  it("local_contract_kind_currency", () => {
    for (const kind of SNAPSHOT_KINDS) {
      const row = raw({ kind });
      expect(JSON.stringify(normalizeMeter(row))).toBe(JSON.stringify(row));
    }
    for (const kind of ["unknown", "PERCENT", "", null, 1]) {
      expect(normalizeMeter(raw({ kind }))).toBeNull();
    }
    for (const unit of ["PERCENT", "CREDITS", "TOKENS", "REQUESTS"]) {
      expect(normalizeMeter(raw({ unit }))).not.toHaveProperty("kind");
    }
    for (const usedAmount of [0, 12.47, MAX_SNAPSHOT_AMOUNT]) {
      const row = raw({ usedAmount, limitAmount: 20, currency: "CNY" });
      expect(JSON.stringify(normalizeMeter(row))).toBe(JSON.stringify(row));
    }
    expect(MAX_SNAPSHOT_AMOUNT).toBe(1_000_000);
    expect(normalizeMeter(raw({
      usedAmount: MAX_SNAPSHOT_AMOUNT + 1, limitAmount: 20, currency: "CNY"
    }))).not.toHaveProperty("currency");
  });

  it("local_contract_availability", () => {
    const retryAt = "2026-01-01T00:01:00.000Z";
    for (const availability of SNAPSHOT_AVAILABILITIES) {
      const row = raw({ value: 0, availability });
      expect(JSON.stringify(normalizeMeter(row))).toBe(JSON.stringify(row));
      const withRetry = normalizeMeter({ ...row, retryAt });
      if (availability === "rate_limited") expect(withRetry?.retryAt).toBe(retryAt);
      else expect(withRetry).toBeNull();
      const reason = availabilityConnectionReason[availability];
      if (reason !== null) expect(CONNECTION_REASONS).toContain(reason);
    }
    for (const availability of ["unknown", "no_credential", "", null, 1]) {
      expect(normalizeMeter(raw({ availability }))).toBeNull();
    }
    expect(normalizeMeter(raw({ retryAt }))).toBeNull();
    for (const invalid of [null, 1, "soon", "2026-01-01", "2026-02-30T00:00:00.000Z"]) {
      expect(normalizeMeter(raw({ availability: "rate_limited", retryAt: invalid }))).toBeNull();
    }
    const zero = normalizeMeter(raw({ value: 0 }));
    expect(zero?.value).toBe(0);
    expect(zero).not.toHaveProperty("availability");
    expect(availabilityConnectionReason.network_failure).toBe("network_unreachable");
    expect(availabilityConnectionReason.schema_drift).toBe("shape_mismatch");
  });

  it("local_contract_provider_codes", () => {
    // New providers join PROVIDER_CODES with their reader, mark and registry
    // entry (relaunch units L1b and L6), never ahead of them.
    for (const provider of PROVIDER_CODES) {
      expect(normalizeMeter(raw({ provider }))?.provider).toBe(provider);
    }
    expect(normalizeMeter(raw({ provider: "UNRECOGNIZED" }))).toBeNull();
  });
});
