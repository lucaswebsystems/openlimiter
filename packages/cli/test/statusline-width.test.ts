import { describe, expect, it } from "vitest";
import { buildAdvice, type Snapshot } from "@openlimiter/core";
import { DEFAULT_STATUSLINE, type StatuslineConfig } from "../src/config.js";
import {
  captionFor, formatResetTime, paintBand, renderPlainStatusline, renderStatuslineLayout,
  STATUSLINE_HOSTS, statuslineColor, statuslineWide, type StatuslineHost
} from "../src/statusline.js";
import { GOLDEN_NOW, GOLDEN_SNAPSHOTS } from "./fixtures/statusline-snapshots.js";

/* Status line rows U44 to U48 of the 2026-10-11 UX audit, 2.1.7. */

const ESCAPE = /\x1b\[[0-9;]*m/gu;
const row = (overrides: Partial<Snapshot> = {}): Snapshot => ({ ...GOLDEN_SNAPSHOTS[0]!, resetAt: null, ...overrides });
const render = (
  config: Partial<StatuslineConfig> = {},
  options: { host?: StatuslineHost; color?: boolean; wide?: boolean; unicode?: boolean; snapshots?: readonly Snapshot[] } = {}
): string => {
  const snapshots = options.snapshots ?? GOLDEN_SNAPSHOTS;
  return renderStatuslineLayout({
    advice: buildAdvice(snapshots, GOLDEN_NOW), snapshots, now: GOLDEN_NOW,
    config: { ...DEFAULT_STATUSLINE, style: "bar", rows: 2, ...config },
    color: options.color ?? false, host: options.host ?? "claude",
    ...(options.wide === undefined ? {} : { wide: options.wide }),
    ...(options.unicode === undefined ? {} : { unicode: options.unicode })
  });
};

describe("U44: the bar style honours the width setting", () => {
  it("keeps every row inside the width at 80, 120 and 160 columns, on every host, with and without colour", () => {
    for (const host of STATUSLINE_HOSTS) {
      for (const width of [80, 120, 160]) {
        for (const color of [false, true]) {
          const rows = render({ width }, { host, color }).split("\n");
          expect(rows.length).toBeLessThanOrEqual(2);
          for (const line of rows) expect(line.replace(ESCAPE, "").length).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("draws a different line at 80, 120 and 160 columns", () => {
    expect(new Set([80, 120, 160].map((width) => render({ width }))).size).toBe(3);
  });

  it("truncates for real at 80 columns: the tightest readings stay and the rest are counted", () => {
    const narrow = render({ width: 80 });
    expect(narrow).toMatch(/\+\d+ more$/u);
    // OpenCode at 92 and Kimi at 70 are the two readings closest to their caps.
    expect(narrow).toContain("oc 5h");
    expect(narrow).toContain("km 5h");
    // The tighter reading of two is the one kept: Grok's 6 percent never beats them.
    expect(narrow).not.toContain("gk mo");
  });

  it("draws five blocks where ten would not fit, and keeps ten where they do", () => {
    expect(render({ width: 80 })).toMatch(/\[[█░]{5}\]/u);
    expect(render({ width: 80 })).not.toMatch(/\[[█░]{10}\]/u);
    expect(render({ width: 400 })).toMatch(/\[[█░]{10}\]/u);
  });

  it("leaves a line that fits as one row, exactly as before", () => {
    expect(render({ width: 80 }, { snapshots: [row({ value: 16 })] })).toBe("5h [█░░░░░░░░░] 16%");
  });

  it("stays on one row when the setting says one row", () => {
    const one = render({ width: 120, rows: 1 });
    expect(one.split("\n")).toHaveLength(1);
    expect(one.length).toBeLessThanOrEqual(120);
    expect(one).toMatch(/\+\d+ more$/u);
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
