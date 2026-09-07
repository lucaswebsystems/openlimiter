import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  accessibleSentence,
  BAND_NAMES,
  buildRow,
  COPY,
  glanceResetText,
  leadRow,
  paceTickPercent,
  percentText,
  PROVIDER_NAMES,
  resetCellText,
  sortRows,
  windowLabel,
  WINDOW_NAMES,
  WINDOW_RANK,
  windowRank,
} from "./tray.js";

/*
 * The popover's rules, read out of the shipped file.
 *
 * tray.js keeps its naming, ordering and pacing arithmetic above the document
 * it draws into, so these tests exercise the code the tray actually runs
 * rather than a copy of it standing in for the code the tray actually runs.
 */

const read = (name) =>
  readFileSync(new URL("./" + name, import.meta.url), "utf8");

const SHARED_ROW = readFileSync(
  new URL("../../../packages/ui/src/provider-row.ts", import.meta.url),
  "utf8",
);

/** Lift one table literal out of the shared row's TypeScript source. */
function sharedTable(name, pattern) {
  const start = SHARED_ROW.indexOf("const " + name);
  assert.notEqual(start, -1, name + " went missing from the shared row");
  const open = SHARED_ROW.indexOf("{", start);
  const close = SHARED_ROW.indexOf("};", open);
  const body = SHARED_ROW.slice(open + 1, close);
  const table = {};
  for (const match of body.matchAll(pattern)) table[match[1]] = match[2];
  assert.ok(Object.keys(table).length > 5, name + " parsed as nearly empty");
  return table;
}

const HOUR = 3_600_000;

const PROVIDERS = Object.keys(PROVIDER_NAMES);

/** A live row, unless a test says otherwise. */
function row(overrides = {}) {
  return {
    provider: "CLAUDE",
    accountId: null,
    meter: "FIVE_HOUR",
    value: 42,
    band: "green",
    live: true,
    state: "fresh",
    resetAt: "2026-09-07T12:00:00Z",
    windowMs: 5 * HOUR,
    observedAt: "2026-09-07T09:30:00Z",
    ...overrides,
  };
}

/** A snapshot as the core hands one over. */
function snapshot(overrides = {}) {
  return {
    provider: "CLAUDE",
    meter: "SEVEN_DAY",
    value: 73.4,
    unit: "PERCENT",
    window: { kind: "rolling", durationSeconds: 604_800 },
    resetAt: "2026-09-10T12:00:00Z",
    observedAt: "2026-09-07T09:00:00Z",
    expiresAt: "2026-09-07T09:05:00Z",
    ...overrides,
  };
}

const alwaysGreen = () => "green";

test("a model scoped weekly reads as the cadence with the model in brackets", () => {
  assert.equal(windowLabel("SEVEN_DAY_FABLE", "CLAUDE"), "Weekly (Fable)");
  assert.equal(windowLabel("SEVEN_DAY_FABLE_5", "CLAUDE"), "Weekly (Fable 5)");
  assert.equal(windowLabel("SEVEN_DAY_HAIKU_4_5", "CLAUDE"), "Weekly (Haiku 4 5)");
  /* A shipped label still wins over the generated one. */
  assert.equal(windowLabel("SEVEN_DAY_OPUS", "CLAUDE"), "Weekly Opus");
  assert.equal(windowLabel("SEVEN_DAY_OAUTH_APPS", "CLAUDE"), "Weekly OAuth apps");
});

test("a numbered window keeps its base name and carries the number", () => {
  assert.equal(windowLabel("HOURLY_2", "CODEX"), "Hourly 2");
  assert.equal(windowLabel("FIVE_HOUR_3", "CLAUDE"), "5 hour session 3");
  assert.equal(windowLabel("MONTHLY_12", "KIMI"), "Monthly 12");
  /* A suffix of one is not a suffix, so the humaniser takes it. */
  assert.equal(windowLabel("HOURLY_1", "CODEX"), "Hourly 1");
});

test("OpenRouter credits are a spend, and only OpenRouter's are", () => {
  assert.equal(windowLabel("CREDITS", "OPENROUTER"), "Credit spend");
  assert.equal(windowLabel("BALANCE", "OPENROUTER"), "Credit spend");
  assert.equal(windowLabel("CREDITS", "KIMI"), "Credits");
  assert.equal(windowLabel("BALANCE", "GROK"), "Credits");
});

test("the codes the tray map was missing all resolve to their shipped names", () => {
  assert.equal(windowLabel("PRIMARY", "GROK"), "Primary window");
  assert.equal(windowLabel("SECONDARY", "GROK"), "Secondary window");
  assert.equal(windowLabel("FIVE_MINUTE", "GEMINI_CLI"), "5 minute window");
  assert.equal(windowLabel("EXTRA_USAGE", "CLAUDE"), "Extra usage");
  assert.equal(windowLabel("ON_DEMAND_MONTHLY", "CODEX"), "On demand monthly");
  assert.equal(windowLabel("LIMIT", "KIMI"), "Hard limit");
});

test("Antigravity's incoming third party meters read as English already", () => {
  assert.equal(
    windowLabel("THIRD_PARTY_SESSION", "ANTIGRAVITY"),
    "Third party session",
  );
  assert.equal(
    windowLabel("THIRD_PARTY_WEEKLY", "ANTIGRAVITY"),
    "Third party weekly",
  );
  /* And they sort at the far end rather than pretending to be a known window. */
  assert.equal(windowRank("THIRD_PARTY_SESSION"), 90);
  assert.equal(windowRank("THIRD_PARTY_WEEKLY"), 90);
});

test("the tray names and ranks every window exactly as the main window does", () => {
  const names = sharedTable(
    "WINDOW_NAMES",
    /^\s*([A-Z_0-9]+):\s*"([^"]*)",$/gmu,
  );
  const ranks = sharedTable("WINDOW_RANK", /^\s*([A-Z_0-9]+):\s*([0-9]+),$/gmu);

  assert.deepEqual({ ...WINDOW_NAMES }, names);
  assert.deepEqual(
    { ...WINDOW_RANK },
    Object.fromEntries(
      Object.entries(ranks).map(([code, rank]) => [code, Number(rank)]),
    ),
  );
  for (const code of Object.keys(names)) {
    assert.equal(windowLabel(code, "CLAUDE"), names[code], code);
  }
});

test("one account reads session, then week, then model week, then month", () => {
  const ordered = sortRows([
    row({ meter: "THIRTY_DAY", value: 91 }),
    row({ meter: "SEVEN_DAY_FABLE_5", value: 20 }),
    row({ meter: "SEVEN_DAY", value: 55 }),
    row({ meter: "FIVE_HOUR", value: 3 }),
  ]).map((each) => each.meter);

  assert.deepEqual(ordered, [
    "FIVE_HOUR",
    "SEVEN_DAY",
    "SEVEN_DAY_FABLE_5",
    "THIRTY_DAY",
  ]);
});

test("accounts are ordered by pressure and a stale reading sorts under them all", () => {
  const ordered = sortRows([
    row({ meter: "SEVEN_DAY", value: 55 }),
    row({ provider: "CODEX", meter: "SEVEN_DAY", value: 99 }),
    row({ meter: "FIVE_HOUR", value: 3 }),
    row({ provider: "CODEX", meter: "FIVE_HOUR", value: 12 }),
    row({ meter: "HOURLY", value: 98, live: false, state: "stale", band: "stale" }),
  ]).map((each) => each.provider + " " + each.meter);

  assert.deepEqual(ordered, [
    "CODEX FIVE_HOUR",
    "CODEX SEVEN_DAY",
    "CLAUDE FIVE_HOUR",
    "CLAUDE SEVEN_DAY",
    "CLAUDE HOURLY",
  ]);
});

test("the headline still speaks for the most pressed live window", () => {
  const rows = sortRows([
    row({ meter: "SEVEN_DAY", value: 55 }),
    row({ provider: "CODEX", meter: "FIVE_HOUR", value: 12 }),
    row({ provider: "CODEX", meter: "SEVEN_DAY", value: 99 }),
  ]);
  /* The list now leads with the hottest account's shortest window, so the
     headline has to choose its own row rather than take the first one. */
  assert.equal(rows[0].meter, "FIVE_HOUR");
  assert.equal(leadRow(rows).provider, "CODEX");
  assert.equal(leadRow(rows).meter, "SEVEN_DAY");
  assert.equal(leadRow([]), null);
});

test("a window half elapsed puts the pace tick at the halfway point", () => {
  const now = Date.parse("2026-09-07T09:30:00Z");
  assert.equal(paceTickPercent(row(), now), 50);

  /* A quarter in, and three quarters in. */
  assert.equal(
    paceTickPercent(row({ resetAt: "2026-09-07T13:15:00Z" }), now),
    25,
  );
  assert.equal(
    paceTickPercent(row({ resetAt: "2026-09-07T10:45:00Z" }), now),
    75,
  );
});

test("no reset time and no window length mean no tick at all", () => {
  const now = Date.parse("2026-09-07T09:30:00Z");
  assert.equal(paceTickPercent(row({ resetAt: null }), now), null);
  assert.equal(paceTickPercent(row({ windowMs: null }), now), null);
  assert.equal(paceTickPercent(row({ resetAt: "not an instant" }), now), null);
  assert.equal(paceTickPercent(row({ windowMs: 0 }), now), null);
  /* A clock outside the window the provider stated supports no projection. */
  assert.equal(
    paceTickPercent(row(), Date.parse("2026-09-07T12:30:00Z")),
    null,
  );
  assert.equal(
    paceTickPercent(row(), Date.parse("2026-09-07T06:00:00Z")),
    null,
  );
});

test("a reading that is not live never carries a tick", () => {
  const now = Date.parse("2026-09-07T09:30:00Z");
  assert.equal(
    paceTickPercent(row({ live: false, state: "stale", band: "stale" }), now),
    null,
  );
  assert.equal(
    paceTickPercent(
      row({ live: false, state: "unknown", band: "stale", value: null }),
      now,
    ),
    null,
  );
});

test("the tick reaches the track only through that projection", () => {
  const source = read("tray.js");
  assert.match(source, /const pace = paceTickPercent\(row, now\);/u);
  assert.match(source, /pace === null\s*\n?\s*\?\s*""/u);
  assert.equal(source.split('class="tray-pace"').length - 1, 1);

  const css = read("tray.css");
  assert.match(css, /\.tray-pace \{[\s\S]*?background: var\(--ol-heading\);/u);
  assert.match(css, /\.tray-pace \{[\s\S]*?position: absolute;/u);
});

test("an unknown reading loses its number and its clock, and wears the hatch", () => {
  const built = buildRow(snapshot(), "unknown", alwaysGreen);
  assert.equal(built.value, null);
  assert.equal(built.resetAt, null);
  assert.equal(built.band, "stale");
  assert.equal(built.live, false);
  assert.equal(percentText(built), COPY.noValue);
  assert.equal(resetCellText(built, null), "");
  assert.equal(glanceResetText(built, null), "");
  /* Nothing downstream can put a countdown back on it. */
  assert.equal(resetCellText(built, "04h 00m 00s"), "");
  assert.equal(
    accessibleSentence(built, "04h 00m 00s").includes("resets in"),
    false,
  );
});

test("a merely stale reading keeps the number it had and still wears the hatch", () => {
  const built = buildRow(snapshot(), "stale", alwaysGreen);
  assert.equal(built.value, 73.4);
  assert.equal(built.band, "stale");
  assert.equal(built.live, false);
  assert.equal(built.resetAt, "2026-09-10T12:00:00Z");
  assert.equal(percentText(built), "73%");
  assert.equal(resetCellText(built, "3d 02h"), "3d 02h");
  assert.equal(resetCellText(built, null), COPY.noReset);
});

test("the stylesheet paints the hatch for every row the renderer bands stale", () => {
  const css = read("tray.css");
  assert.match(
    css,
    /\.tray-row\[data-band="stale"\] \.tray-meter \{\s*background: var\(--ol-band-hatched-pattern\);\s*\}/u,
  );
  assert.match(
    css,
    /\.tray-row\[data-band="stale"\] \.tray-meter-fill \{\s*background: transparent;\s*\}/u,
  );
  /* Both freshness states arrive at that one selector. */
  for (const state of ["stale", "unknown"]) {
    assert.equal(buildRow(snapshot(), state, alwaysGreen).band, "stale");
  }
});

test("a fresh reading keeps its band, its number and its clock", () => {
  const built = buildRow(snapshot(), "fresh", alwaysGreen);
  assert.equal(built.band, "green");
  assert.equal(built.live, true);
  assert.equal(built.windowMs, 604_800_000);
  assert.equal(resetCellText(built, "3d 02h"), "3d 02h");
  assert.equal(glanceResetText(built, "3d 02h"), "Resets in 3d 02h");
  assert.equal(built.value, 73.4);

  /* A snapshot with no stated duration simply has none, and no tick follows. */
  const noWindow = buildRow(
    snapshot({ window: { kind: "unknown" } }),
    "fresh",
    alwaysGreen,
  );
  assert.equal(noWindow.windowMs, null);
  assert.equal(paceTickPercent(noWindow, Date.now()), null);
});

test("nothing this popover can say carries a dash of any kind", () => {
  const dashes = /[-­‐-―−]/u;
  const said = [
    ...Object.values(PROVIDER_NAMES),
    ...Object.values(WINDOW_NAMES),
    ...Object.values(BAND_NAMES),
    ...Object.values(COPY),
  ];

  const codes = [
    ...Object.keys(WINDOW_NAMES),
    "SEVEN_DAY_FABLE",
    "SEVEN_DAY_FABLE_5",
    "SEVEN_DAY_HAIKU_4_5",
    "HOURLY_2",
    "THIRTY_DAY_3",
    "THIRD_PARTY_SESSION",
    "THIRD_PARTY_WEEKLY",
    "GEMINI_2_5_PRO",
    "SOMETHING_NOBODY_SHIPPED_YET",
    "",
  ];
  for (const provider of PROVIDERS) {
    for (const code of codes) said.push(windowLabel(code, provider));
  }

  for (const state of ["fresh", "stale", "unknown"]) {
    for (const accountId of [null, "work"]) {
      for (const countdown of [null, "3d 02h", "00h 04m 09s"]) {
        const built = buildRow(
          snapshot({ accountId: accountId ?? undefined }),
          state,
          alwaysGreen,
        );
        said.push(accessibleSentence(built, countdown));
        said.push(resetCellText(built, countdown));
        said.push(glanceResetText(built, countdown));
        said.push(percentText(built));
      }
    }
  }

  for (const sentence of said) {
    assert.equal(dashes.test(sentence), false, sentence);
  }
});

test("no dash reaches the popover's own document either", () => {
  const dashes = /[-­‐-―−]/u;
  const text = read("tray.html")
    .replaceAll(/<script[\s\S]*?<\/script>/gu, "")
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

  assert.ok(text.includes("Open OpenLimiter"));
  assert.equal(dashes.test(text), false, text);
});
