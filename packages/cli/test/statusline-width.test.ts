import { describe, expect, it } from "vitest";
import { buildAdvice, type Snapshot } from "@openlimiter/core";
import { DEFAULT_STATUSLINE, normalizeStatusline, type StatuslineConfig } from "../src/config.js";
import {
  captionFor, detectTerminalColumns, displayColumns, formatResetTime, paintBand, renderPlainStatusline, renderStatuslineLayout,
  STATUSLINE_HOSTS, statuslineColor, statuslineWide, statuslineWidth, type StatuslineHost
} from "../src/statusline.js";
import type { StatuslineSession } from "../src/statusline-ingest.js";
import { GOLDEN_NOW, GOLDEN_SNAPSHOTS } from "./fixtures/statusline-snapshots.js";

/* Status line rows U44 to U48 of the 2026-10-11 UX audit, 2.1.7, in the shape
   the owner locked in the fix round (decision A): one row of ten block bars,
   which is the `wrap: false` path now that wrapping is the default. */

const ESCAPE = /\x1b\[[0-9;]*m/gu;
const row = (overrides: Partial<Snapshot> = {}): Snapshot => ({ ...GOLDEN_SNAPSHOTS[0]!, resetAt: null, ...overrides });
/** The layout with the stored defaults, wrap included. */
const draw = (
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
/** The one row path, which only `wrap: false` selects. */
const render = (
  config: Partial<StatuslineConfig> = {},
  options: Parameters<typeof draw>[1] = {}
): string => draw({ wrap: false, ...config }, options);
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

  it("wraps whole cells onto up to three lines by default, each inside the width", () => {
    const wrapped = draw({ width: 120 });
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(displayColumns(line)).toBeLessThanOrEqual(120);
    expect(accounted(lines.join(" | "))).toBe(12);
    expect(wrapped).not.toMatch(/[█░]/u);
    expect(wrapped).toMatch(/▆/u);
    expect(wrapped).toBe(draw({ width: 120, wrap: true }));
  });

  it("fills each line up to the width before it breaks, and never past it", () => {
    for (const width of [100, 120, 140]) {
      const lines = draw({ width }).split("\n");
      lines.forEach((line, index) => {
        expect(displayColumns(line)).toBeLessThanOrEqual(width);
        const next = lines[index + 1]?.split(" | ")[0];
        if (next !== undefined) expect(displayColumns(line) + 3 + displayColumns(next)).toBeGreaterThan(width);
      });
    }
  });

  it("reads wrap as on unless the stored file says false", () => {
    expect(normalizeStatusline({ wrap: false }).wrap).toBe(false);
    for (const wrap of [true, "no", 0, null, undefined]) expect(normalizeStatusline({ wrap }).wrap).not.toBe(false);
    expect(DEFAULT_STATUSLINE.wrap).not.toBe(false);
  });

  it("keeps full blocks while everything fits on one line, and lowers them only once lines stack", () => {
    expect(draw({ width: 400 })).toContain("█");
    expect(draw({ width: 400 })).toBe(render({ width: 400 }));
    expect(draw({ width: 120 })).not.toContain("█");
  });

  it("keeps the one row with wrap false", () => {
    for (const width of [80, 120]) {
      expect(draw({ width, wrap: false }).split("\n")).toHaveLength(1);
      expect(draw({ width, wrap: false })).toBe(render({ width }));
    }
    expect(draw({ width: 120, wrap: false })).toMatch(/\+\d+ more$/u);
  });

  it("draws a different line at 80, 120 and 160 columns", () => {
    expect(new Set([80, 120, 160].map((width) => render({ width }))).size).toBe(3);
  });

  it("keeps the readings closest to their caps and counts every other one exactly", () => {
    const narrow = render({ width: 80 });
    expect(narrow).toBe("oc 5h [█████████░] 92%!! · 5h | km 5h [██████░░░░] 70% · 5h | +10 more");
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
    // 30 columns hold one of the two and the count (29), never both (31).
    const snapshots = [row({ value: 50 })];
    expect(render({ width: 30 }, { snapshots, apiSpend: spend("95") })).toBe("an $95.00 | +1 more");
    expect(render({ width: 30 }, { snapshots, apiSpend: spend("10") })).toBe("5h [█████░░░░░] 50% | +1 more");
    expect(render({ width: 25 }, { snapshots, apiSpend: spend("10") })).toBe("+2 more");
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
    expect(displayColumns("5h [█░░░░░░░░░] 16% · 3h20m")).toBe(27);
    expect(displayColumns("漢字")).toBe(4);
    expect(displayColumns("é")).toBe(1);
    expect(displayColumns("\x1b[32mab\x1b[0m")).toBe(2);
    expect(displayColumns("🔥")).toBe(2);
  });

  it("measures grapheme clusters: a presentation selector, a family and a flag take two columns each", () => {
    expect(displayColumns("❤️")).toBe(2);
    expect(displayColumns("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe(2);
    expect(displayColumns("\u{1F1E7}\u{1F1F7}")).toBe(2);
    expect(displayColumns("é")).toBe(1);
  });

  it("keeps a session head of forty hearts inside the width (Astra round 2)", () => {
    const session = { model: "opus-5-5", effort: "high", dir: "❤️".repeat(40), ctx: 42 };
    const line = render({ width: 80, visibility: { dir: true } }, { session });
    expect(displayColumns(line)).toBeLessThanOrEqual(80);
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
  it("marks the time left to a reset with a quiet dot, never the old arrow (owner, 2026-11-02)", () => {
    expect(formatResetTime("2026-01-07T23:00:00.000Z", GOLDEN_NOW)).toBe("↻6d23h");
    expect(render({ width: 400 })).toContain("7d [██████░░░░] 64% · 7d");
    expect(render({ width: 400 })).not.toContain("↻");
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

  it("reads FORCE_COLOR as an explicit level before any terminal hint (Astra finding 8)", () => {
    const terminal = { TERM: "xterm-256color", COLORTERM: "truecolor", WT_SESSION: "b0c1d2e3" };
    // Empty and true are level 1: colour, in the 16 colour palette whatever the terminal claims.
    for (const force of ["", "true", "1"]) {
      expect(statuslineColor("auto", { FORCE_COLOR: force }, false, "codex")).toBe(true);
      expect(statuslineWide({ ...terminal, FORCE_COLOR: force })).toBe(false);
    }
    for (const force of ["0", "false"]) {
      expect(statuslineColor("auto", { FORCE_COLOR: force }, true, "claude")).toBe(false);
      expect(statuslineWide({ ...terminal, FORCE_COLOR: force })).toBe(false);
    }
    for (const force of ["2", "3", "4"]) expect(statuslineWide({ TERM: "dumb", FORCE_COLOR: force })).toBe(true);
    // A value that is no level leaves it to the terminal.
    expect(statuslineColor("auto", { FORCE_COLOR: "yes please" }, false, "codex")).toBe(false);
    expect(statuslineWide({ ...terminal, FORCE_COLOR: "yes please" })).toBe(true);
    // NO_COLOR and the saved setting still come first.
    expect(statuslineColor("auto", { FORCE_COLOR: "3", NO_COLOR: "" }, true, "claude")).toBe(false);
    expect(statuslineColor("never", { FORCE_COLOR: "3" }, true, "claude")).toBe(false);
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

describe("the real terminal width", () => {
  it("reads the columns of stdout, then stderr, before it opens any terminal", () => {
    const device = (): number => { throw new Error("must not open a terminal"); };
    expect(detectTerminalColumns({ stdout: { columns: 132 }, stderr: { columns: 90 }, device })).toBe(132);
    expect(detectTerminalColumns({ stdout: {}, stderr: { columns: 90 }, device })).toBe(90);
  });

  it("falls back to the controlling terminal: /dev/tty on POSIX, the CONOUT$ console device on Windows", () => {
    const asked: string[] = [];
    const device = (path: string): number => { asked.push(path); return 101; };
    expect(detectTerminalColumns({ stdout: {}, stderr: {}, platform: "linux", device })).toBe(101);
    expect(detectTerminalColumns({ stdout: {}, stderr: {}, platform: "darwin", device })).toBe(101);
    expect(detectTerminalColumns({ stdout: {}, stderr: {}, platform: "win32", device })).toBe(101);
    expect(asked).toEqual(["/dev/tty", "/dev/tty", "\\\\.\\CONOUT$"]);
  });

  it("is null when nothing answers, when the terminal fails, or when it states no real width", () => {
    expect(detectTerminalColumns({ stdout: {}, stderr: {}, device: () => undefined })).toBeNull();
    expect(detectTerminalColumns({ stdout: {}, stderr: {}, device: () => { throw new Error("no tty"); } })).toBeNull();
    expect(detectTerminalColumns({ stdout: { columns: 0 }, stderr: { columns: Number.NaN }, device: () => 0 })).toBeNull();
    // The real thing, on whatever machine runs this: a width or null, never an exception.
    const real = detectTerminalColumns();
    expect(real === null || (Number.isInteger(real) && real > 0)).toBe(true);
  });

  it("budgets one column short of the terminal, else the configured width", () => {
    expect(statuslineWidth(DEFAULT_STATUSLINE.width, 200)).toBe(199);
    expect(statuslineWidth(DEFAULT_STATUSLINE.width, 80)).toBe(79);
    expect(statuslineWidth(DEFAULT_STATUSLINE.width, null)).toBe(DEFAULT_STATUSLINE.width);
    expect(statuslineWidth(100, null)).toBe(100);
  });

  it("lets a width the person set win when it is narrower than the terminal", () => {
    expect(statuslineWidth(100, 200)).toBe(100);
    expect(statuslineWidth(100, 80)).toBe(79);
    expect(statuslineWidth(100, 101)).toBe(100);
  });

  it("wraps at the detected width and keeps the one row with wrap false", () => {
    for (const columns of [90, 130, 200]) {
      const width = statuslineWidth(DEFAULT_STATUSLINE.width, columns);
      const lines = draw({ width }).split("\n");
      for (const line of lines) expect(displayColumns(line)).toBeLessThanOrEqual(columns - 1);
      expect(lines.length).toBeGreaterThan(1);
      expect(render({ width }).split("\n")).toHaveLength(1);
    }
  });
});
