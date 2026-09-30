import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDER_CODES, WAVE_PROVIDERS, buildAdvice, type Snapshot } from "@openlimiter/core";
import { DEFAULT_STATUSLINE } from "../src/config.js";
import { renderStatuslineLayout, STATUSLINE_HOSTS, tenBlockBar } from "../src/statusline.js";
import { GOLDEN_NOW, GOLDEN_SNAPSHOTS } from "./fixtures/statusline-snapshots.js";

/**
 * Reference bars keep every enabled window and leave wrapping to the host.
 * These goldens changed from width shedding, truncated percentages and spend
 * amounts to the reference line, rounded percentages and remaining credits.
 * Legacy cells retain their width budget and explicitly request worst meters.
 */

const GOLDEN_DIR = path.join(process.cwd(), "packages/cli/test/golden");
const WIDTHS = [80, 120, 160] as const;
/* Measured against the providers that shipped before the 2.1 wave, so the
   golden files do not move when a 2.1 provider is switched on. */
const ADVICE = buildAdvice(GOLDEN_SNAPSHOTS, GOLDEN_NOW,
  PROVIDER_CODES.filter((code) => !WAVE_PROVIDERS.some((provider) => provider.code === code)));

describe("account and freshness status line goldens", () => {
  const row = (overrides: Partial<Snapshot> = {}): Snapshot => ({ ...GOLDEN_SNAPSHOTS[0]!, resetAt: null, ...overrides });
  const ago = (seconds: number): string => new Date(Date.parse(GOLDEN_NOW) - seconds * 1000).toISOString();
  const render = (snapshots: Snapshot[], show: string[] = []) => renderStatuslineLayout({
    advice: buildAdvice(snapshots, GOLDEN_NOW), snapshots, now: GOLDEN_NOW,
    config: { ...DEFAULT_STATUSLINE, style: "bar", width: 1000, rows: 2, show }, color: false, host: "claude"
  });
  it("omits dormant accounts while preserving their cached rows", () => {
    const rows = [row({ accountId: "active", value: 16 }), row({ accountId: "old", observedAt: ago(86401), value: 99 })];
    const before = JSON.stringify(rows);
    expect(render(rows)).toBe("5h [█░░░░░░░░░] 16%");
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("uses the 14 minute Codex weekly row instead of the old account headline", () => {
    const rows = [row({ value: 16 }),
      row({ provider: "CODEX", accountId: "old", meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604800 }, observedAt: ago(19 * 86400), value: 99 }),
      row({ provider: "CODEX", accountId: "active", meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604800 }, observedAt: ago(840), value: 26 })];
    expect(render(rows)).toBe("5h [█░░░░░░░░░] 16% | cx7d [██░░░░░░░░] ~26%");
    expect(render([...rows].reverse())).toBe(render(rows));
  });
  it.each([180, 900, 7200, 86400])("marks the last value as stale at %s seconds", (seconds) => {
    expect(render([row({ observedAt: ago(seconds), expiresAt: ago(seconds - 60) })]))
      .toBe("5h [████░░░░░░] ~42%");
  });
  it("leaves explicitly selected providers without readings out", () => {
    expect(render([row({ value: 16 })], ["claude", "codex", "antigravity", "gemini_cli", "openrouter"]))
      .toBe("5h [█░░░░░░░░░] 16%");
  });
  it("marks stale spend and unknown window readings", () => {
    expect(render([row({ provider: "GROK", meter: "SPEND", usedAmount: 12.5, currency: "USD", observedAt: ago(900) })]))
      .toBe("gk spend ~$12.50");
    expect(render([row({ provider: "GROK", meter: "UNSPECIFIED", window: { kind: "unknown" }, observedAt: ago(900) })]))
      .toBe("gk [████░░░░░░] ~42%");
  });
  it.each([
    ["missing_credentials", null],
    ["expired_credentials", null],
    ["access_denied", null],
    ["missing_subscription", null],
    ["unlimited", "unlimited"],
    ["quota_unavailable", null],
    ["rate_limited", null],
    ["network_failure", null],
    ["schema_drift", null]
  ] as const)("hides availability %s unless it is unlimited", (availability, expected) => {
    expect(render([row({
      provider: "CODEX",
      meter: "ACQUISITION",
      value: 0,
      window: { kind: "unknown" },
      availability,
      ...(availability === "rate_limited" ? { retryAt: "2026-01-01T14:05:00.000Z" } : {})
    })])).toBe(expected === null ? "OpenLimiter UNKNOWN" : "cx " + expected);
  });
  it("leaves an acquisition placeholder out instead of inventing a percentage", () => {
    expect(render([row({ provider: "CODEX", meter: "ACQUISITION", value: 0, window: { kind: "unknown" } })]))
      .toBe("OpenLimiter UNKNOWN");
  });
  it("omits a stale acquisition placeholder beside a stale real reading for the same account", () => {
    const accountId = "account-one";
    expect(render([
      row({
        accountId,
        meter: "ACQUISITION",
        value: 0,
        window: { kind: "unknown" },
        availability: "access_denied",
        observedAt: ago(240),
        expiresAt: ago(120)
      }),
      row({ accountId, observedAt: ago(240), expiresAt: ago(120), value: 42 })
    ])).toBe("5h " + tenBlockBar(42) + " ~42%");
  });
  it("omits a provider whose only account is more than 24 hours old", () => {
    expect(render([row({ value: 16 }), row({ provider: "CODEX", observedAt: ago(86401) })]))
      .toBe("5h [█░░░░░░░░░] 16%");
  });
  it("measures last seen per account, rather than discarding every older meter", () => {
    expect(render([row({ accountId: "active", value: 16 }), row({ accountId: "active", meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604800 }, observedAt: ago(90000), value: 26 })]))
      .toBe("5h [█░░░░░░░░░] 16% | 7d [██░░░░░░░░] ~26%");
  });
});

function golden(name: string): string {
  return readFileSync(path.join(GOLDEN_DIR, name + ".txt"), "utf8");
}

describe("statusline golden files", () => {
  describe("bar style, per host shape", () => {
    for (const host of STATUSLINE_HOSTS) {
      for (const width of WIDTHS) {
        it(host + " at width " + String(width), () => {
          const rendered = renderStatuslineLayout({
            advice: ADVICE,
            snapshots: GOLDEN_SNAPSHOTS,
            now: GOLDEN_NOW,
            config: { ...DEFAULT_STATUSLINE, style: "bar", width, rows: 2 },
            color: false,
            host
          });
          expect(rendered + "\n").toBe(golden(host + "-bar-" + String(width)));
        });
      }
    }

    it("never leaves a cell with no tag in front of its bar", () => {
      /* A cell with no tag reads as label-less: "` [bar] 6%`" rather than
         "`gk [bar] 6%`", indistinguishable from every other blank cell on
         the row. `barStyleCells` falls back to the short provider tag
         whenever a reading is the host's own AND its window has no code
         (statusline.ts); this is the regression guard for that fallback,
         exercised for real by Grok's `ON_DEMAND_MONTHLY` fixture reading. */
      for (const host of STATUSLINE_HOSTS) {
        for (const width of WIDTHS) {
          const rendered = renderStatuslineLayout({
            advice: ADVICE,
            snapshots: GOLDEN_SNAPSHOTS,
            now: GOLDEN_NOW,
            config: { ...DEFAULT_STATUSLINE, style: "bar", width, rows: 2 },
            color: false,
            host
          });
          const cells = rendered.split("\n").flatMap((row) => row.split(" | "));
          for (const cell of cells) {
            expect(cell.startsWith(" ")).toBe(false);
            expect(cell.startsWith("[")).toBe(false);
          }
        }
      }
    });
  });

  describe("cells style, host independent", () => {
    for (const width of WIDTHS) {
      it("at width " + String(width) + " is the same for every host", () => {
        const goldenText = golden("cells-" + String(width));
        for (const host of STATUSLINE_HOSTS) {
          const rendered = renderStatuslineLayout({
            advice: ADVICE,
            snapshots: GOLDEN_SNAPSHOTS,
            now: GOLDEN_NOW,
            config: { ...DEFAULT_STATUSLINE, style: "cells", meters: "worst", width, rows: 2 },
            color: false,
            host
          });
          expect(rendered + "\n").toBe(goldenText);
        }
      });
    }
  });
});
