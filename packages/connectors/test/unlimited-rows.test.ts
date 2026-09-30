/**
 * An unlimited answer is an availability row, and every gate a row passes on
 * its way to a surface has to accept it as one. A kind the normalizer does not
 * know turned the real parsers' unlimited rows into rejected providers.
 */
import { describe, expect, it } from "vitest";
import { normalizeMetersReport } from "@openlimiter/core";
import { parseCodexPayload } from "../src/codex.js";
import { parseOpenrouterPayload } from "../src/openrouter.js";

const NOW = "2026-08-07T12:00:00.000Z";

describe("unlimited answers from the real parsers", () => {
  it.each([
    ["OpenRouter", () => parseOpenrouterPayload({ data: { limit: null, limit_remaining: null, usage: 12.47 } }, NOW)],
    ["Codex", () => parseCodexPayload({ credits: { has_credits: true, unlimited: true, balance: null } }, NOW)]
  ])("%s keeps its unlimited answer through the normalizer", (_name, parse) => {
    const rows = parse();
    expect(rows).not.toBeNull();
    const report = normalizeMetersReport(rows!);
    expect(report.rejected).toEqual([]);
    expect(report.snapshots.filter((row) => row.availability === "unlimited")).toHaveLength(1);
  });
});
