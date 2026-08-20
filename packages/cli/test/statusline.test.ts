import { describe, expect, it } from "vitest";
import { buildAdvice, type ProviderCode, type Snapshot } from "@openlimiter/core";
import { DEFAULT_STATUSLINE, type StatuslineConfig } from "../src/config.js";
import { STATUSLINE_BAR_SEGMENTS } from "../src/render.js";
import {
  CELL_GAP,
  DEFAULT_PROVIDER_ORDER,
  STATUSLINE_UNKNOWN,
  meterClass,
  renderStatuslineLayout,
  resolveProviderOrder,
  statuslineCells,
  statuslineColor,
  statuslineHead
} from "../src/statusline.js";

/* The escape character, built from its code point so no control byte ever
   sits in this source file. */
const ESCAPE = String.fromCharCode(27);

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-01T00:01:00.000Z";

function reading(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    provider: "CLAUDE",
    meter: "FIVE_HOUR",
    value: 42,
    unit: "PERCENT",
    window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt: null,
    source: "native_payload",
    precision: "exact",
    observedAt: NOW,
    expiresAt: EXPIRES,
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "native-statusline-payload",
      automationRisk: "low",
      verification: "UNVERIFIED"
    },
    ...overrides
  };
}

/** One reading for every provider, at a different pressure each. */
const everyProvider: readonly Snapshot[] = [
  reading({ provider: "CLAUDE", meter: "FIVE_HOUR", value: 42 }),
  reading({
    provider: "CLAUDE",
    meter: "SEVEN_DAY",
    value: 64,
    window: { kind: "rolling", durationSeconds: 604_800 }
  }),
  reading({ provider: "CODEX", meter: "PRIMARY", value: 51 }),
  reading({
    provider: "ANTIGRAVITY",
    meter: "PRIMARY",
    value: 28,
    window: { kind: "fixed" }
  }),
  reading({
    provider: "OPENCODE",
    meter: "PRIMARY",
    value: 92,
    window: { kind: "fixed" }
  }),
  reading({
    provider: "GROK",
    meter: "WEEKLY",
    value: 42.5,
    window: { kind: "rolling", durationSeconds: 604_800 }
  }),
  reading({
    provider: "KIMI",
    meter: "FIVE_HOUR",
    value: 69.5,
    window: { kind: "rolling", durationSeconds: 18_000 }
  }),
  reading({
    provider: "MANUAL",
    meter: "MONTHLY",
    value: 35,
    window: { kind: "fixed" }
  }),
  reading({
    provider: "OPENROUTER",
    meter: "CREDITS",
    value: 62.35,
    window: { kind: "lifetime" }
  })
];

function layout(
  snapshots: readonly Snapshot[],
  overrides: Partial<StatuslineConfig> = {},
  color = false,
  wide?: boolean
): string {
  return renderStatuslineLayout({
    advice: buildAdvice(snapshots, NOW),
    snapshots,
    now: NOW,
    config: { ...DEFAULT_STATUSLINE, ...overrides },
    color,
    /* Stated only where a colour is asserted, so no test asks the machine it
       happens to be running on which colours it has. */
    ...(wide === undefined ? {} : { wide })
  });
}

function cellsOf(
  snapshots: readonly Snapshot[],
  order: readonly ProviderCode[] = DEFAULT_PROVIDER_ORDER,
  meters: StatuslineConfig["meters"] = "worst"
): readonly string[] {
  return statuslineCells(snapshots, NOW, order, meters, false)
    .map((cell) => cell.plain);
}

/** Every row of a render, with the cells of each row split apart again. */
function rowsOf(rendered: string): string[][] {
  return rendered.split("\n").map((row) => row.split(CELL_GAP));
}

describe("provider ordering", () => {
  it("puts every subscription plan before the credit and API meters", () => {
    expect(DEFAULT_PROVIDER_ORDER).toEqual([
      "CLAUDE",
      "CODEX",
      "ANTIGRAVITY",
      "OPENCODE",
      "GROK",
      "KIMI",
      "MANUAL",
      "OPENROUTER"
    ]);
  });

  it("renders the cells in that order and nothing else", () => {
    const cells = cellsOf(everyProvider);
    expect(cells.map((cell) => cell.split(" ")[0])).toEqual([
      "CLAUDE",
      "CODEX",
      "ANTIGRAVITY",
      "OPENCODE",
      "GROK",
      "KIMI",
      "MANUAL",
      "OPENROUTER"
    ]);
  });

  it("honours a configured order and lets the rest follow the default", () => {
    expect(resolveProviderOrder(["openrouter", "manual"])).toEqual([
      "OPENROUTER",
      "MANUAL",
      "CLAUDE",
      "CODEX",
      "ANTIGRAVITY",
      "OPENCODE",
      "GROK",
      "KIMI"
    ]);
  });

  it("ignores an id it does not know and an id named twice", () => {
    expect(resolveProviderOrder(["codex", "nope", "codex", "CLAUDE"])).toEqual([
      "CODEX",
      "CLAUDE",
      "ANTIGRAVITY",
      "OPENCODE",
      "GROK",
      "KIMI",
      "MANUAL",
      "OPENROUTER"
    ]);
  });

  it("draws the configured order in the line itself", () => {
    const rendered = layout(everyProvider, { order: ["openrouter"], width: 400 });
    const names = rowsOf(rendered)[0]!.slice(1).map((cell) => cell.split(" ")[0]);
    expect(names[0]).toBe("OPENROUTER");
    expect(names[1]).toBe("CLAUDE");
  });
});

describe("meter ordering", () => {
  it.each([
    [reading({ window: { kind: "rolling", durationSeconds: 18_000 } }), "session"],
    [reading({ window: { kind: "rolling", durationSeconds: 86_400 } }), "daily"],
    [reading({ window: { kind: "rolling", durationSeconds: 604_800 } }), "weekly"],
    [reading({ window: { kind: "rolling", durationSeconds: 2_678_400 } }), "monthly"],
    [reading({ window: { kind: "lifetime" }, meter: "CREDITS" }), "credits"],
    [reading({ window: { kind: "fixed" }, meter: "PRIMARY" }), "session"],
    [reading({ window: { kind: "fixed" }, meter: "MONTHLY" }), "monthly"],
    [reading({ window: { kind: "fixed" }, meter: "SOMETHING_ELSE" }), "other"]
  ])("classes a meter as %#", (snapshot, expected) => {
    expect(meterClass(snapshot)).toBe(expected);
  });

  it("orders a provider's meters session, daily, weekly, monthly, credits", () => {
    const many = [
      reading({ meter: "LIFETIME", window: { kind: "lifetime" } }),
      reading({ meter: "MONTHLY", window: { kind: "fixed" } }),
      reading({ meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604_800 } }),
      reading({ meter: "DAILY", window: { kind: "rolling", durationSeconds: 86_400 } }),
      reading({ meter: "FIVE_HOUR", window: { kind: "rolling", durationSeconds: 18_000 } })
    ];
    expect(cellsOf(many, ["CLAUDE"], "all").map((cell) => cell.split(" ")[0])).toEqual([
      "CLAUDE:FIVE_HOUR",
      "CLAUDE:DAILY",
      "CLAUDE:SEVEN_DAY",
      "CLAUDE:MONTHLY",
      "CLAUDE:LIFETIME"
    ]);
  });
});

describe("worst against all", () => {
  it("shows only the meter closest to its cap by default", () => {
    const cells = cellsOf(everyProvider);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toBe("CLAUDE ###.. 64.0%");
  });

  it("shows every meter as its own cell when asked", () => {
    const cells = cellsOf(everyProvider, DEFAULT_PROVIDER_ORDER, "all");
    expect(cells).toHaveLength(9);
    expect(cells[0]).toBe("CLAUDE:FIVE_HOUR ##... 42.0%");
    expect(cells[1]).toBe("CLAUDE:SEVEN_DAY ###.. 64.0%");
  });

  it("keeps the worst cell agreeing with the reason code above it", () => {
    const rendered = layout(everyProvider, { width: 400 });
    expect(rendered.startsWith("OpenLimiter NEAR_CAP")).toBe(true);
    expect(rendered).toContain("OPENCODE ####. 92.0%");
  });
});

describe("the cell", () => {
  it("is a name, a five block bar and a truncated percent", () => {
    const cells = cellsOf([reading({ value: 99.99 })], ["CLAUDE"]);
    const parts = cells[0]!.split(" ");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("CLAUDE");
    expect(parts[1]).toHaveLength(STATUSLINE_BAR_SEGMENTS);
    expect(parts[2]).toBe("99.9%");
  });

  it("draws the bar in ASCII and never rounds a block upward", () => {
    expect(cellsOf([reading({ value: 19.9 })], ["CLAUDE"])[0]).toBe("CLAUDE ..... 19.9%");
    expect(cellsOf([reading({ value: 20 })], ["CLAUDE"])[0]).toBe("CLAUDE #.... 20.0%");
    expect(cellsOf([reading({ value: 99.99 })], ["CLAUDE"])[0]).toBe("CLAUDE ####. 99.9%");
    expect(cellsOf([reading({ value: 100 })], ["CLAUDE"])[0]).toBe("CLAUDE ##### 100.0%");
  });

  it("leaves a reading with no percentage out of the line entirely", () => {
    const credits = reading({ unit: "CREDITS", value: 400, meter: "CREDITS" });
    expect(cellsOf([credits], ["CLAUDE"])).toEqual([]);
  });
});

describe("the head", () => {
  it("leads with the reason code and carries the recommendation", () => {
    expect(statuslineHead(buildAdvice(everyProvider, NOW)))
      .toBe("OpenLimiter NEAR_CAP PREFER ANTIGRAVITY");
  });

  it("names the providers it has nothing for", () => {
    const head = statuslineHead(buildAdvice([reading()], NOW));
    expect(head).toContain("UNKNOWN OPENROUTER,CODEX,ANTIGRAVITY,OPENCODE,GROK,KIMI,MANUAL");
  });

  it("says so plainly when there is nothing bounded at all", () => {
    expect(layout([])).toBe(STATUSLINE_UNKNOWN);
  });
});

describe("stacking", () => {
  it("fits one row when the budget allows it", () => {
    const rendered = layout(everyProvider, { width: 260 });
    expect(rendered.split("\n")).toHaveLength(1);
    expect(rendered.length).toBeLessThanOrEqual(260);
  });

  it("breaks into a second row at the default budget", () => {
    const rendered = layout(everyProvider);
    const rows = rendered.split("\n");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(140);
  });

  it("breaks between cells and never inside one", () => {
    for (const width of [60, 80, 100, 120, 140, 160]) {
      const rendered = layout(everyProvider, { width });
      for (const row of rowsOf(rendered)) {
        for (const cell of row) {
          /* Every cell is either the head or a whole three field cell. */
          if (cell.startsWith("OpenLimiter ")) continue;
          expect(cell).toMatch(/^[A-Z:_]+ [#.]{5} \d+\.\d%$|^\+\d+ more$/u);
        }
      }
    }
  });

  it("never spends more than the budget on a row", () => {
    for (let width = 40; width <= 200; width += 1) {
      for (const row of layout(everyProvider, { width }).split("\n")) {
        /* The head alone is allowed to exceed a budget it cannot fit in. */
        if (row.startsWith("OpenLimiter ") && !row.includes(CELL_GAP)) continue;
        expect(row.length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("stops at one row when told to, and says what it dropped", () => {
    const rendered = layout(everyProvider, { rows: 1 });
    expect(rendered.split("\n")).toHaveLength(1);
    expect(rendered).toContain("+4 more");
  });

  it("keeps the worst providers when it has to drop some", () => {
    const rendered = layout(everyProvider, { rows: 1, width: 100 });
    const shown = rowsOf(rendered)[0]!.slice(1);
    expect(rendered).toContain("OPENCODE ####. 92.0%");
    expect(rendered).toContain("+6 more");
    /* Twenty eight percent is the furthest from a cap, so it goes first. */
    expect(shown.some((cell) => cell.startsWith("ANTIGRAVITY "))).toBe(false);
    expect(rendered.length).toBeLessThanOrEqual(100);
  });

  it("ends the last row with the dropped count and nothing after it", () => {
    const rendered = layout(everyProvider, { rows: 2, width: 60 });
    const rows = rendered.split("\n");
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.at(-1)?.endsWith("more")).toBe(true);
  });

  it("counts every dropped cell exactly once", () => {
    const head = statuslineHead(buildAdvice(everyProvider, NOW));
    for (const width of [40, 55, 70, 90, 110]) {
      for (const rows of [1, 2] as const) {
        const rendered = layout(everyProvider, { width, rows });
        const shown = rowsOf(rendered)
          .flat()
          .filter((cell) => !cell.startsWith("OpenLimiter ") && !cell.endsWith("more"));
        const more = /\+(\d+) more/u.exec(rendered);
        if (shown.length === 0 && more === null) {
          /* One row too narrow to hold the head and anything else at all. */
          expect(rendered).toBe(head);
          continue;
        }
        expect(shown.length + Number(more?.[1] ?? 0)).toBe(8);
      }
    }
  });

  it("keeps the head even when not one cell fits beside it", () => {
    const rendered = layout(everyProvider, { rows: 1, width: 40 });
    expect(rendered).toBe(statuslineHead(buildAdvice(everyProvider, NOW)));
  });
});

describe("colour", () => {
  /** One reading in each of the four bands, so a whole line has all of them. */
  const everyBand: readonly Snapshot[] = [
    reading({ provider: "CLAUDE", value: 42 }),
    reading({ provider: "CODEX", value: 64 }),
    reading({ provider: "ANTIGRAVITY", value: 84 }),
    reading({ provider: "OPENCODE", value: 92 })
  ];

  it("paints each cell in its own band", () => {
    const rendered = layout(everyProvider, { width: 400 }, true, true);
    expect(rendered).toContain(ESCAPE + "[32m");
    expect(rendered).toContain(ESCAPE + "[33m");
    expect(rendered).toContain(ESCAPE + "[31m");
  });

  it("draws all four bands in one line, orange included", () => {
    const rendered = layout(everyBand, { width: 400 }, true, true);
    expect(rendered).toContain(ESCAPE + "[32m");
    expect(rendered).toContain(ESCAPE + "[33m");
    expect(rendered).toContain(ESCAPE + "[38;5;208m");
    expect(rendered).toContain(ESCAPE + "[31m");
  });

  it("degrades the orange band to yellow where there is no orange", () => {
    const rendered = layout(everyBand, { width: 400 }, true, false);
    expect(rendered).not.toContain("38;5;208");
    expect(rendered).toContain(ESCAPE + "[33m");
    /* The cell is not dropped and the reading is not changed. Only the
       distinction between the urgent band and the watch band is lost. */
    expect(rendered).toContain("84.0%");
    expect(rendered).toContain(ESCAPE + "[31m");
  });

  it("measures the same width whether or not the orange is available", () => {
    const orange = layout(everyBand, { width: 400 }, true, true);
    const yellow = layout(everyBand, { width: 400 }, true, false);
    const strip = (line: string): string =>
      line.split(ESCAPE).map((part) => part.replace(/^\[[\d;]*m/u, "")).join("");
    expect(strip(orange)).toBe(strip(yellow));
  });

  it("measures the budget on the text, not on the escape codes", () => {
    const painted = layout(everyProvider, { width: 200 }, true);
    const plain = layout(everyProvider, { width: 200 }, false);
    expect(painted.split("\n")).toHaveLength(plain.split("\n").length);
    /* Same layout decision, more bytes. */
    expect(painted.length).toBeGreaterThan(plain.length);
  });

  it("emits no control character at all when colour is refused", () => {
    expect(layout(everyProvider, {}, false)).not.toContain(ESCAPE);
  });

  it("lets always beat a host that is not a terminal, and never beat everything", () => {
    expect(statuslineColor("auto", {}, false)).toBe(false);
    expect(statuslineColor("auto", {}, true)).toBe(true);
    expect(statuslineColor("always", {}, false)).toBe(true);
    expect(statuslineColor("never", {}, true)).toBe(false);
  });

  it("obeys NO_COLOR over every setting, including always", () => {
    for (const setting of ["auto", "always", "never"] as const) {
      expect(statuslineColor(setting, { NO_COLOR: "" }, true)).toBe(false);
      expect(statuslineColor(setting, { NO_COLOR: "1" }, true)).toBe(false);
    }
  });
});
