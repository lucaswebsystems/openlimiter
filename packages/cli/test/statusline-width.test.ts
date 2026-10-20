import { describe, expect, it } from "vitest";
import { buildAdvice, type Snapshot } from "@openlimiter/core";
import { DEFAULT_STATUSLINE, type StatuslineConfig } from "../src/config.js";
import {
  captionFor, displayColumns, formatResetTime, paintBand, renderPlainStatusline, renderStatuslineLayout,
  STATUSLINE_HOSTS, statuslineColor, statuslineWide, type StatuslineHost
} from "../src/statusline.js";
import type { StatuslineSession } from "../src/statusline-ingest.js";
import { GOLDEN_NOW, GOLDEN_SNAPSHOTS } from "./fixtures/statusline-snapshots.js";

/* Status line rows U44 to U48 of the 2026-10-11 UX audit, 2.1.7, in the shape
   the owner locked in the fix round (decision A): one row of ten block bars. */

const ESCAPE = /\x1b\[[0-9;]*m/gu;
const row = (overrides: Partial<Snapshot> = {}): Snapshot => ({ ...GOLDEN_SNAPSHOTS[0]!, resetAt: null, ...overrides });
const render = (
  config: Partial<StatuslineConfig> = {},
  options: {
    host?: StatuslineHost; color?: boolean; wide?: boolean; unicode?: boolean; snapshots?: readonly Snapshot[];
    session?: StatuslineSession; apiSpend?: unknown;
  } = {}
): string => {
  const snapshots = options.snapshots ?? GOLDEN_SNAPSHOTS;
  return renderStatuslineLayout({
    advice: buildAdvice(snapshots, GOLDEN_NOW), snapshots, now: GOLDEN_NOW,
    config: { ...DEFAULT_STATUSLINE, style: "bar", rows: 2, ...config },
    color: options.color ?? false, host: options.host ?? "claude",
    ...(options.wide === undefined ? {} : { wide: options.wide }),
    ...(options.unicode === undefined ? {} : { unicode: options.unicode }),
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.apiSpend === undefined ? {} : { apiSpend: options.apiSpend })
  });
};
/** Readings drawn and readings counted out: every one of the fixture's twelve, once. */
const accounted = (line: string): number =>
  line.split(" | ").filter((cell) => !/^\+\d+ more$/u.test(cell)).length + Number(/\+(\d+) more$/u.exec(line)?.[1] ?? 0);

describe("decision A and U44: one row of ten block bars inside the width", () => {
  it("draws one row inside the width at 80, 120 and 160 columns, on every host, with and without colour", () => {
    for (const host of STATUSLINE_HOSTS) {
      for (const width of [80, 120, 160]) {
        for (const color of [false, true]) {
          for (const rows of [1, 2] as const) {
            const line = render({ width, rows }, { host, color });
            expect(line.split("\n")).toHaveLength(1);
            expect(displayColumns(line)).toBeLessThanOrEqual(width);
            expect(line.replace(ESCAPE, "")).not.toMatch(/\[[█░]{5}\]/u);
          }
        }
      }
    }
  });

  it("draws a different line at 80, 120 and 160 columns", () => {
    expect(new Set([80, 120, 160].map((width) => render({ width }))).size).toBe(3);
  });

  it("keeps the readings closest to their caps and counts every other one exactly", () => {
    const narrow = render({ width: 80 });
    expect(narrow).toBe("oc 5h [█████████░] 92%!! ↻5h | km 5h [██████░░░░] 70% ↻5h | +10 more");
    for (const width of [80, 120, 160, 400]) expect(accounted(render({ width }))).toBe(12);
    expect(render({ width: 400 })).not.toContain("more");
  });

  it("leaves a line that fits exactly as before", () => {
    expect(render({ width: 80 }, { snapshots: [row({ value: 16 })] })).toBe("5h [█░░░░░░░░░] 16%");
  });
});

describe("Astra finding 6: ranked by actual pressure, API budget pressure included", () => {
  const spend = (spendUsd: string) => ({
    version: 1,
    sources: [{ id: "src-1", provider: "anthropic", keyLabel: "anthropic", enabled: true, budgetUsd: "100", status: "eligible" }],
    samples: [{
      id: "smp-1", sourceId: "src-1", sequence: 1, provider: "anthropic", metricKind: "spend",
      month: "2026-01-01", spendUsd, balanceUsd: null, observedAt: GOLDEN_NOW, currencySource: "provider_usd"
    }]
  });

  it("keeps an API budget at 95 percent over a window at 50 percent", () => {
    const snapshots = [row({ value: 50 })];
    expect(render({ width: 25 }, { snapshots, apiSpend: spend("95") })).toBe("an $95.00 | +1 more");
    expect(render({ width: 25 }, { snapshots, apiSpend: spend("10") })).toBe("5h [█████░░░░░] 50% | +1 more");
  });

  it("keeps the tightest reading even when it is the last and longest cell in provider order", () => {
    const snapshots = [
      row({ value: 10 }),
      row({ provider: "KIMI", meter: "WINDOW_604800", window: { kind: "rolling", durationSeconds: 604_800 }, value: 97 })
    ];
    const line = render({ width: 40 }, { snapshots });
    expect(line).toContain("97%!!");
    expect(line).toMatch(/\+1 more$/u);
  });
});

describe("Astra finding 5: display columns, and a bounded session head", () => {
  it("measures display columns, not string length", () => {
    expect(displayColumns("5h [█░░░░░░░░░] 16% ↻3h20m")).toBe(26);
    expect(displayColumns("漢字")).toBe(4);
    expect(displayColumns("é")).toBe(1);
    expect(displayColumns("\x1b[32mab\x1b[0m")).toBe(2);
    expect(displayColumns("🔥")).toBe(2);
  });

  it("keeps a session head of wide and combining characters inside the width", () => {
    const session = { model: "opus-5-5", effort: "high", dir: "漢字漢字漢字漢字漢字 café", ctx: 42 };
    for (const width of [60, 80, 120]) {
      const line = render({ width, visibility: { dir: true } }, { session });
      expect(line.split("\n")).toHaveLength(1);
      expect(displayColumns(line)).toBeLessThanOrEqual(width);
    }
  });

  it("bounds an oversized session head so the tightest reading and the count still show", () => {
    const session = { model: "opus-5-5", effort: "high", dir: "a".repeat(300), ctx: 42 };
    const line = render({ width: 80, visibility: { dir: true } }, { session });
    expect(displayColumns(line)).toBeLessThanOrEqual(80);
    expect(line).toContain("…");
    expect(line).toContain("92%!!");
    expect(line).toMatch(/\+\d+ more$/u);
  });
});

describe("U45: a reset reads as a reset, not as a second window", () => {
  it("marks the time left to a reset with the reset arrow", () => {
    expect(formatResetTime("2026-01-07T23:00:00.000Z", GOLDEN_NOW)).toBe("↻6d23h");
    expect(render({ width: 400 })).toContain("7d [██████░░░░] 64% ↻7d");
    expect(render({ width: 400 })).not.toContain("·");
  });

  it("spells it out where the terminal cannot draw the arrow", () => {
    expect(render({ width: 400 }, { unicode: false, snapshots: [row({ resetAt: "2026-01-01T03:20:00.000Z" })] }))
      .toBe("5h [####......] 42% resets 3h20m");
  });
});

describe("U46: every tag is spaced from its window", () => {
  it("never glues a provider tag to a window code", () => {
    const line = render({ width: 400 });
    for (const tag of ["cx 5h", "ag 5h", "oc 5h", "gk 7d", "gk mo", "km 5h", "mn mo", "or key", "or bal $7.53"]) {
      expect(line).toContain(tag);
    }
    for (const glued of ["cx5h", "gkmo", "mnmo", "| or $"]) expect(line).not.toContain(glued);
  });

  it("leaves the plain line of statusline.bars false byte for byte", () => {
    const plain = renderPlainStatusline(buildAdvice(GOLDEN_SNAPSHOTS, GOLDEN_NOW), GOLDEN_SNAPSHOTS, GOLDEN_NOW,
      ["CLAUDE", "CODEX", "GROK", "OPENCODE", "MANUAL", "OPENROUTER"], "worst", undefined, "CLAUDE");
    expect(plain).toContain(" cx5h 51% ");
    expect(plain).toContain(" oc5h 92% ");
    expect(plain).toContain(" mnmo 35% ");
    expect(plain).not.toContain("!");
  });
});

describe("U47: a band never rests on colour alone", () => {
  it("adds ! at 80 and !! at 90, with or without colour", () => {
    const values = [59, 79, 80, 89, 90, 100].map((value) => row({ value }));
    for (const color of [false, true]) {
      const marks = values.map((snapshot) => render({ width: 400 }, { color, snapshots: [snapshot] }).replace(ESCAPE, ""));
      expect(marks).toEqual([
        "5h [█████░░░░░] 59%", "5h [███████░░░] 79%", "5h [████████░░] 80%!",
        "5h [████████░░] 89%!", "5h [█████████░] 90%!!", "5h [██████████] 100%!!"
      ]);
    }
  });

  it("falls back to the 16 colour yellow where the terminal claims no 256 colour palette", () => {
    expect(paintBand("x", 85, "fresh", false)).toBe("\x1b[33mx\x1b[0m");
    expect(paintBand("x", 85, "fresh", true)).toBe("\x1b[38;5;208mx\x1b[0m");
    expect(render({ width: 400 }, { color: true, wide: false, snapshots: [row({ value: 85 })] })).not.toContain("38;5;208");
    expect(render({ width: 400 }, { color: true, wide: true, snapshots: [row({ value: 85 })] })).toContain("38;5;208");
  });

  it("honours FORCE_COLOR where the setting is auto, while NO_COLOR and never still win", () => {
    expect(statuslineColor("auto", {}, false, "codex")).toBe(false);
    expect(statuslineColor("auto", { FORCE_COLOR: "1" }, false, "codex")).toBe(true);
    expect(statuslineColor("auto", { FORCE_COLOR: "0" }, true, "claude")).toBe(false);
    expect(statuslineColor("auto", { FORCE_COLOR: "1", NO_COLOR: "" }, false, "codex")).toBe(false);
    expect(statuslineColor("never", { FORCE_COLOR: "1" }, true, "claude")).toBe(false);
    expect(statuslineColor("always", { FORCE_COLOR: "0" }, false, "codex")).toBe(true);
  });

  it("reads the 256 colour claim from the terminal or from FORCE_COLOR 2 and above", () => {
    expect(statuslineWide({})).toBe(false);
    expect(statuslineWide({ TERM: "xterm-256color" })).toBe(true);
    expect(statuslineWide({ COLORTERM: "truecolor" })).toBe(true);
    // Windows Terminal sets neither TERM nor COLORTERM, and draws 24 bit colour.
    expect(statuslineWide({ WT_SESSION: "b0c1d2e3" })).toBe(true);
    expect(statuslineWide({ FORCE_COLOR: "1" })).toBe(false);
    expect(statuslineWide({ FORCE_COLOR: "2" })).toBe(true);
    expect(statuslineWide({ FORCE_COLOR: "3" })).toBe(true);
  });
});

describe("U48: Tagged tags every cell, Short tags every cell that is not the host's own", () => {
  const weekly = row({ meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604_800 } });
  const fable = row({ meter: "SEVEN_DAY_FABLE", window: { kind: "rolling", durationSeconds: 604_800 } });
  const extra = row({ meter: "EXTRA_USAGE", window: { kind: "unknown" } });

  it("tags Claude's model and extra captions like every other caption", () => {
    expect(captionFor(fable, "CLAUDE", "short")).toBe("fable7d");
    expect(captionFor(fable, "CLAUDE", "tagged")).toBe("cl fable7d");
    expect(captionFor(fable, "CODEX", "short")).toBe("cl fable7d");
    expect(captionFor(extra, "CLAUDE", "short")).toBe("extra");
    expect(captionFor(extra, "CLAUDE", "tagged")).toBe("cl extra");
    expect(captionFor(extra, null, "short")).toBe("cl extra");
    expect(captionFor(weekly, "CLAUDE", "short")).toBe("7d");
    expect(captionFor(weekly, "CLAUDE", "tagged")).toBe("cl 7d");
  });

  it("tags every cell of a Tagged line under every host", () => {
    for (const host of STATUSLINE_HOSTS) {
      const cells = render({ width: 400, captions: "tagged" }, { host }).split(" | ");
      for (const cell of cells) expect(cell).toMatch(/^(cl|cx|ag|gm|oc|gk|km|mn|or) /u);
    }
  });
});
