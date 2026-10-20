import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdvice, type Snapshot } from "@openlimiter/core";
import { DEFAULT_STATUSLINE } from "../src/config.js";
import {
  claudeWeeklyHint, renderPlainStatusline, renderStatuslineLayout, STATUSLINE_HOSTS, tenBlockBar
} from "../src/statusline.js";
import { GOLDEN_NOW, GOLDEN_SNAPSHOTS } from "./fixtures/statusline-snapshots.js";

/**
 * Reference bars keep to the width budget on one row of ten block bars (2.1.7,
 * UX audit U44, fix round decision A): a line that does not fit keeps the
 * readings closest to their caps and counts the rest. So the 80, 120 and 160
 * goldens differ, and each stays inside its width. Legacy cells retain their
 * width budget and explicitly request worst meters.
 */

const GOLDEN_DIR = path.join(process.cwd(), "packages/cli/test/golden");
const WIDTHS = [80, 120, 160] as const;
const ADVICE = buildAdvice(GOLDEN_SNAPSHOTS, GOLDEN_NOW);
const LEGACY_CELLS_SNAPSHOTS = GOLDEN_SNAPSHOTS;
const LEGACY_CELLS_ADVICE = buildAdvice(LEGACY_CELLS_SNAPSHOTS, GOLDEN_NOW);

describe("account and freshness status line goldens", () => {
  const row = (overrides: Partial<Snapshot> = {}): Snapshot => ({ ...GOLDEN_SNAPSHOTS[0]!, resetAt: null, ...overrides });
  const ago = (seconds: number): string => new Date(Date.parse(GOLDEN_NOW) - seconds * 1000).toISOString();
  const render = (snapshots: Snapshot[], show: string[] = [], color = false) => renderStatuslineLayout({
    advice: buildAdvice(snapshots, GOLDEN_NOW), snapshots, now: GOLDEN_NOW,
    config: { ...DEFAULT_STATUSLINE, style: "bar", width: 1000, rows: 2, show }, color, host: "claude"
  });
  /* Hotfix 2.1.5: with colour, a reading that could not be refreshed is grey
     and the tilde marks an estimate only; without colour, grey cannot say it,
     so a stale reading keeps the tilde 2.1.4 drew (fix 6). Age alone never
     marks a reading. */
  const grey = (text: string) => "\x1b[90m" + text + "\x1b[0m";
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
    expect(render(rows)).toBe("5h [█░░░░░░░░░] 16% | cx 7d [██░░░░░░░░] 26%");
    expect(render([...rows].reverse())).toBe(render(rows));
  });
  it.each([180, 900, 7200, 86400])("greys the last value once it is stale at %s seconds", (seconds) => {
    const stale = [row({ observedAt: ago(seconds), expiresAt: ago(seconds - 60) })];
    expect(render(stale, [], true)).toBe("5h " + grey("[████░░░░░░]") + " " + grey("42%"));
    expect(render(stale)).toBe("5h [████░░░░░░] ~42%");
  });
  it("leaves explicitly selected providers without readings out", () => {
    expect(render([row({ value: 16 })], ["claude", "codex", "antigravity", "gemini_cli", "openrouter"]))
      .toBe("5h [█░░░░░░░░░] 16%");
  });
  it("marks spend and unknown window readings by freshness, never by age", () => {
    expect(render([row({ provider: "GROK", meter: "SPEND", usedAmount: 12.5, currency: "USD", observedAt: ago(900) })]))
      .toBe("gk 5h spend $12.50");
    expect(render([row({ provider: "GROK", meter: "UNSPECIFIED", window: { kind: "unknown" }, observedAt: ago(900) })]))
      .toBe("gk [████░░░░░░] 42%");
    expect(render([row({ provider: "GROK", meter: "SPEND", usedAmount: 12.5, currency: "USD", observedAt: ago(900), expiresAt: ago(840) })], [], true))
      .toBe("gk 5h spend " + grey("$12.50"));
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
  it("keeps a quiet provider's only account, stale, for seven days and then leaves it out", () => {
    expect(render([row({ value: 16 }), row({ provider: "CODEX", observedAt: ago(86401) })]))
      .toBe("5h [█░░░░░░░░░] 16% | cx 5h [████░░░░░░] 42%");
    expect(render([row({ value: 16 }), row({ provider: "CODEX", observedAt: ago(7 * 86400 + 1) })]))
      .toBe("5h [█░░░░░░░░░] 16%");
  });
  it("draws a stale Claude weekly, grey, instead of hiding it", () => {
    const weekly = row({ meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604800 }, value: 26,
      source: "internal_payload", provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
      observedAt: ago(7200), expiresAt: ago(6060) });
    expect(render([row({ value: 16 }), weekly])).toBe("5h [█░░░░░░░░░] 16% | 7d [██░░░░░░░░] ~26%");
    expect(render([row({ value: 16 }), weekly], [], true)).toContain("7d " + grey("[██░░░░░░░░]") + " " + grey("26%"));
  });
  it("drops a weekly past its seven days beside a current session, and says the weekly is missing", async () => {
    // Seven days and an hour old, expired nineteen minutes after it was read.
    const weekly = row({ meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604800 }, value: 26,
      source: "internal_payload", provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
      observedAt: ago(7 * 86400 + 3600), expiresAt: ago(7 * 86400 + 2460) });
    const rows = [row({ value: 16 }), weekly];
    expect(render(rows)).toBe("5h [█░░░░░░░░░] 16%");
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), "openlimiter-golden-"));
    try {
      expect(await claudeWeeklyHint(rows, GOLDEN_NOW, false, directory)).toBe("7d off");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("draws a retained two day old reading grey with colour and with its 2.1.4 tilde without", () => {
    const stale = [row({ observedAt: ago(2 * 86400), expiresAt: ago(2 * 86400 - 1140) })];
    const fresh = [row({ observedAt: ago(60), expiresAt: ago(-600) })];
    const layout = (snapshots: Snapshot[], style: "bar" | "cells", color: boolean) => renderStatuslineLayout({
      advice: buildAdvice(snapshots, GOLDEN_NOW), snapshots, now: GOLDEN_NOW, color, host: "claude",
      config: { ...DEFAULT_STATUSLINE, style, width: 1000, rows: 2 }
    });
    const plain = (snapshots: Snapshot[]) =>
      renderPlainStatusline(buildAdvice(snapshots, GOLDEN_NOW), snapshots, GOLDEN_NOW, ["CLAUDE"], "all", undefined, "CLAUDE");
    for (const style of ["bar", "cells"] as const) {
      expect(layout(stale, style, true)).toContain(grey("42%"));
      expect(layout(stale, style, true)).not.toContain("~");
      expect(layout(stale, style, false)).toContain(" ~42%");
      expect(layout(fresh, style, false)).not.toContain("~");
    }
    // The plain style never paints, so fresh and stale differ by the tilde.
    expect(plain(fresh)).toContain(" 5h 42% ");
    expect(plain(stale)).toContain(" 5h ~42% ");
    expect(plain(fresh)).not.toContain("~");
    // An estimate keeps its tilde with colour as well.
    expect(layout([row({ observedAt: ago(60), expiresAt: ago(-600), precision: "estimated" })], "bar", true)).toContain("~42%");
  });
  it("leads with a fresh reading over a fuller stale one, and draws the stale one when it is alone", () => {
    const weekly = (accountId: string, value: number, observedAt: string, expiresAt: string) => row({
      accountId, meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604800 }, value,
      source: "internal_payload", provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
      observedAt, expiresAt });
    const fresh = weekly("account-a", 10, GOLDEN_NOW, ago(-1140));
    const stale = weekly("account-b", 99, ago(7200), ago(6060));
    const worst = (snapshots: Snapshot[]) => renderStatuslineLayout({
      advice: buildAdvice(snapshots, GOLDEN_NOW), snapshots, now: GOLDEN_NOW, color: false, host: "codex",
      config: { ...DEFAULT_STATUSLINE, style: "bar", meters: "worst", width: 1000, rows: 2 }
    });
    expect(worst([fresh, stale])).toBe("cl 7d " + tenBlockBar(10) + " 10%");
    expect(worst([stale])).toBe("cl 7d " + tenBlockBar(99) + " ~99%");
  });
  it("measures last seen per account, rather than discarding every older meter", () => {
    expect(render([row({ accountId: "active", value: 16 }), row({ accountId: "active", meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604800 }, observedAt: ago(90000), value: 26 })]))
      .toBe("5h [█░░░░░░░░░] 16% | 7d [██░░░░░░░░] 26%");
  });
});

function golden(name: string): string {
  return readFileSync(path.join(GOLDEN_DIR, name + ".txt"), "utf8");
}

describe("statusline golden files", () => {
  it("keeps reset markers compact for provider rows", () => {
    expect(golden("claude-bar-160")).toMatch(/cx 5h [^|]+ 51% ↻4h59m/u);
  });

  it("differs at 80, 120 and 160 columns and keeps every row inside its width", () => {
    for (const host of STATUSLINE_HOSTS) {
      const files = WIDTHS.map((width) => golden(host + "-bar-" + String(width)));
      expect(new Set(files).size).toBe(WIDTHS.length);
      WIDTHS.forEach((width, index) => {
        for (const row of files[index]!.trimEnd().split("\n")) expect(row.length).toBeLessThanOrEqual(width);
      });
    }
  });

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

  describe("cells style, host aware", () => {
    for (const width of WIDTHS) {
      it("at width " + String(width) + " keeps host captions explicit", () => {
        const goldenText = golden("cells-" + String(width));
        for (const host of STATUSLINE_HOSTS) {
          const rendered = renderStatuslineLayout({
            advice: LEGACY_CELLS_ADVICE,
            snapshots: LEGACY_CELLS_SNAPSHOTS,
            now: GOLDEN_NOW,
            config: { ...DEFAULT_STATUSLINE, style: "cells", meters: "worst", width, rows: 2 },
            color: false,
            host
          });
          const hostGolden = host === "claude"
            ? goldenText
            : goldenText.replace("  7d ", "  cl 7d ");
          const hostAwareGolden = host === "antigravity"
            ? hostGolden.replaceAll("ag 5h", "5h").replaceAll("ag 7d", "7d")
            : host === "grok"
            ? hostGolden.replaceAll("gk 7d", "7d").replaceAll("gk mo", "mo")
            : host === "codex"
            ? hostGolden.replaceAll("cx 5h", "5h").replaceAll("cx 7d", "7d")
            : hostGolden;
          expect(rendered + "\n").toBe(hostAwareGolden);
        }
      });
    }
  });
});
