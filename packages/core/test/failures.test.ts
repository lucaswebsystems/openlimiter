import { describe, expect, it } from "vitest";
import {
  FAILURE_CATEGORIES,
  dedupeFailures,
  failureFromConnectorReason,
  failureSentence,
  type ProviderFailure
} from "../src/index.js";

/**
 * The failure vocabulary.
 *
 * The point of this module is that a human never reads a provider's own words,
 * so the tests below are mostly about what cannot happen rather than what can.
 */
describe("failure vocabulary", () => {
  it("has one fixed sentence for every category and no others", () => {
    expect(Object.keys(failureSentence).sort()).toEqual([...FAILURE_CATEGORIES].sort());
    for (const category of FAILURE_CATEGORIES) {
      const sentence = failureSentence[category];
      expect(typeof sentence).toBe("string");
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence.length).toBeLessThan(80);
    }
  });

  it("writes its sentences without a dash of any kind", () => {
    for (const category of FAILURE_CATEGORIES) {
      expect(failureSentence[category]).not.toMatch(/[-‐-―]/u);
    }
  });

  it("maps every connector refusal onto a category", () => {
    expect(failureFromConnectorReason("not_configured")).toBe("NOT_CONFIGURED");
    expect(failureFromConnectorReason("unavailable")).toBe("SESSION_EXPIRED");
    expect(failureFromConnectorReason("unknown")).toBe("PAYLOAD_UNREADABLE");
  });

  it("keeps the most specific answer when one provider fails twice", () => {
    const failures: ProviderFailure[] = [
      { provider: "OPENROUTER", category: "PAYLOAD_UNREADABLE" },
      { provider: "OPENROUTER", category: "VALIDATION_REJECTED" },
      { provider: "CLAUDE", category: "NOT_CONFIGURED" }
    ];
    const deduped = dedupeFailures(failures);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((entry) => entry.provider === "OPENROUTER")?.category).toBe(
      "VALIDATION_REJECTED"
    );
    expect(deduped.find((entry) => entry.provider === "CLAUDE")?.category).toBe(
      "NOT_CONFIGURED"
    );
  });

  it("returns nothing for no failures", () => {
    expect(dedupeFailures([])).toEqual([]);
  });
});
