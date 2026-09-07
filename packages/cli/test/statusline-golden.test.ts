import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdvice } from "@openlimiter/core";
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
