import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdvice, type Snapshot } from "@openlimiter/core";
import { DEFAULT_STATUSLINE } from "../src/config.js";
import { renderStatuslineLayout, STATUSLINE_HOSTS } from "../src/statusline.js";
import { GOLDEN_NOW, GOLDEN_SNAPSHOTS } from "./fixtures/statusline-snapshots.js";

/**
 * Byte for byte golden files, one per host shape and width, for both styles.
 *
 * `bar` is decision D6's reference grammar and differs by host, because the
 * whole point of a host tag is to disappear for the provider that host
 * belongs to: `openlimiter statusline --host codex` draws Codex's own window
 * bare and tags everyone else's. `cells` is the pre D6 grammar this project
 * shipped first; it never reads which host is asking, so one set of files
 * covers every host and the width sweep below asserts that directly rather
 * than writing five identical copies of the same three files.
 *
 * The golden text lives under `packages/cli/test/golden/`, generated from a
 * real render of `fixtures/statusline-snapshots.ts` rather than typed out by
 * hand, so a change to a column, a tag, a bar, a percent or a separator has
 * to be made in the renderer and reviewed here, exactly as the CLI's own
 * golden demo output is kept honest.
 */

const GOLDEN_DIR = path.join(process.cwd(), "packages/cli/test/golden");
const WIDTHS = [80, 120, 160] as const;
const ADVICE = buildAdvice(GOLDEN_SNAPSHOTS, GOLDEN_NOW);

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
    expect(render(rows)).toBe("5h [█░░░░░░░░░] 16% | cx7d [██░░░░░░░░] 26% stale 14m");
    expect(render([...rows].reverse())).toBe(render(rows));
  });
  it.each([180, 900, 7200, 86400])("retains the last value with age at %s seconds", (seconds) => {
    const age = seconds === 180 ? "3m" : seconds === 900 ? "15m" : seconds === 7200 ? "2h" : "1d";
    expect(render([row({ observedAt: ago(seconds), expiresAt: ago(seconds - 60) })]))
      .toBe("5h [████░░░░░░] 42% stale " + age);
  });
  it("omits providers with no rows even when explicitly selected", () => {
    expect(render([row({ value: 16 })], ["claude", "codex", "antigravity", "gemini_cli", "openrouter"]))
      .toBe("5h [█░░░░░░░░░] 16%");
  });
  it("keeps stale spend and unknown window readings with their age", () => {
    expect(render([row({ provider: "GROK", meter: "SPEND", usedAmount: 12.5, currency: "USD", observedAt: ago(900) })]))
      .toBe("gk spend $12.50 stale 15m");
    expect(render([row({ provider: "GROK", meter: "UNSPECIFIED", window: { kind: "unknown" }, observedAt: ago(900) })]))
      .toBe("gk [████░░░░░░] 42% stale 15m");
  });
  it("omits a provider whose only account is more than 24 hours old", () => {
    expect(render([row({ value: 16 }), row({ provider: "CODEX", observedAt: ago(86401) })]))
      .toBe("5h [█░░░░░░░░░] 16%");
  });
  it("measures last seen per account, rather than discarding every older meter", () => {
    expect(render([row({ accountId: "active", value: 16 }), row({ accountId: "active", meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604800 }, observedAt: ago(90000), value: 26 })]))
      .toBe("5h [█░░░░░░░░░] 16% | 7d [██░░░░░░░░] 26% stale 1d");
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
            config: { ...DEFAULT_STATUSLINE, style: "cells", width, rows: 2 },
            color: false,
            host
          });
          expect(rendered + "\n").toBe(goldenText);
        }
      });
    }
  });
});
