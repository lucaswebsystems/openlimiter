/**
 * The five band contract.
 *
 * A meter's colour is the answer to how close a window is to running out, so
 * the boundaries between the bands are product behaviour, not styling. They
 * are also the exact percentages the notification thresholds fire on, which is
 * why a bar and a toast can never disagree about which band a reading is in.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderCode, Snapshot } from "@openlimiter/core";
import {
  buildProviderAccountRows,
  headroomTone,
  providerRowMarkup,
  windowBand,
} from "../src/provider-row.js";

const NOW = "2026-09-01T12:00:00.000Z";
const TOKENS = readFileSync(
  path.join(process.cwd(), "packages", "ui", "src", "tokens.css"),
  "utf8"
);

function snapshot(value: number, observedAt = NOW, expiresAt = "2026-09-01T13:00:00.000Z"): Snapshot {
  return {
    provider: "CLAUDE" as ProviderCode,
    meter: "FIVE_HOUR",
    value,
    unit: "PERCENT",
    window: { kind: "rolling" },
    resetAt: "2026-09-01T15:48:12.000Z",
    source: "internal_payload",
    precision: "exact",
    observedAt,
    expiresAt,
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "internal-endpoint",
      automationRisk: "high",
      verification: "UNVERIFIED",
    },
  };
}

function onlyWindow(value: number, observedAt?: string, expiresAt?: string) {
  const rows = buildProviderAccountRows(
    [snapshot(value, observedAt, expiresAt)],
    NOW,
    [],
    { providers: ["CLAUDE"] }
  );
  const window = rows[0]?.windows[0];
  expect(window).toBeDefined();
  return window!;
}

describe("band boundaries", () => {
  it("puts each side of 60, 80 and 90 in the band the contract names", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0, "green"],
      [59.9, "green"],
      [60, "yellow"],
      [79.9, "yellow"],
      [80, "orange"],
      [89.9, "orange"],
      [90, "red"],
      [100, "red"],
    ];
    for (const [value, band] of cases) {
      expect(windowBand(onlyWindow(value)), String(value)).toBe(band);
    }
  });

  it("agrees with the headroom tone it is derived from", () => {
    expect(headroomTone(59.9)).toBe("ok");
    expect(headroomTone(60)).toBe("watch");
    expect(headroomTone(80)).toBe("high");
    expect(headroomTone(90)).toBe("critical");
  });

  it("bands a stale reading as stale whatever its last number was", () => {
    const stale = onlyWindow(
      12,
      "2026-09-01T09:00:00.000Z",
      "2026-09-01T10:00:00.000Z"
    );
    expect(stale.state).toBe("stale");
    expect(stale.tone).toBe("ok");
    expect(windowBand(stale)).toBe("stale");
  });
});

describe("band rendering", () => {
  function markupAt(value: number, observedAt?: string, expiresAt?: string): string {
    const rows = buildProviderAccountRows(
      [snapshot(value, observedAt, expiresAt)],
      NOW,
      [],
      { providers: ["CLAUDE"] }
    );
    return providerRowMarkup(rows[0]!);
  }

  it("prints a percentage and draws an icon in every band", () => {
    for (const value of [24, 68, 84, 95]) {
      const markup = markupAt(value);
      expect(markup, String(value)).toContain('class="band-icon"');
      expect(markup, String(value)).toContain("%</strong>");
    }
  });

  it("marks the stale band on the element the stylesheet hatches", () => {
    const markup = markupAt(
      42,
      "2026-09-01T09:00:00.000Z",
      "2026-09-01T10:00:00.000Z"
    );
    expect(markup).toContain('data-band="stale"');
    expect(markup).toContain('data-state="stale"');
  });

  it("gives the icon no accessible name, because the readout already has one", () => {
    const markup = markupAt(95);
    expect(markup).toContain('<span class="band-icon" aria-hidden="true">');
  });
});

describe("band tokens", () => {
  const MEASURED: readonly (readonly [string, string])[] = [
    ["--ol-band-green-fill", "#2ea043"],
    ["--ol-band-green-label", "#3fb950"],
    ["--ol-band-yellow-fill", "#d29922"],
    ["--ol-band-yellow-label", "#e3b341"],
    ["--ol-band-orange-fill", "#db6d28"],
    ["--ol-band-orange-label", "#ffa657"],
    ["--ol-band-red-fill", "#f85149"],
    ["--ol-band-red-label", "#ff7b72"],
    ["--ol-band-stale-fill", "#72839b"],
    ["--ol-band-stale-label", "#929ead"],
  ];

  const MEASURED_LIGHT: readonly (readonly [string, string])[] = [
    ["--ol-band-green-fill", "#1a7f37"],
    ["--ol-band-green-label", "#116329"],
    ["--ol-band-yellow-fill", "#9e6a03"],
    ["--ol-band-yellow-label", "#744210"],
    ["--ol-band-orange-fill", "#bc4c00"],
    ["--ol-band-orange-label", "#872b00"],
    ["--ol-band-red-fill", "#cf222e"],
    ["--ol-band-red-label", "#82071e"],
    ["--ol-band-stale-fill", "#617087"],
    ["--ol-band-stale-label", "#46566b"],
  ];

  const dark = TOKENS.slice(0, TOKENS.indexOf(':root[data-theme="light"]'));
  const light = TOKENS.slice(TOKENS.indexOf(':root[data-theme="light"]'));

  it("carries the measured dark values", () => {
    for (const [token, value] of MEASURED) {
      expect(dark, token).toContain(token + ": " + value + ";");
    }
  });

  it("carries the measured light values", () => {
    for (const [token, value] of MEASURED_LIGHT) {
      expect(light, token).toContain(token + ": " + value + ";");
    }
  });

  it("hatches the stale track in both themes", () => {
    expect(dark).toContain("--ol-band-hatched-pattern: repeating-linear-gradient(");
    expect(light).toContain("--ol-band-hatched-pattern: repeating-linear-gradient(");
  });

  it("leaves no blue ramp behind on the meter names", () => {
    /* The old names survive as aliases so every consumer moves together, but
       they must resolve to a band rather than to a hex of their own. */
    for (const name of ["ok", "watch", "high", "critical"]) {
      expect(dark).toContain("--ol-meter-" + name + ": var(--ol-band-");
    }
    expect(dark).not.toMatch(/--ol-meter-(ok|watch|high|critical): #/u);
    expect(light).not.toMatch(/--ol-meter-(ok|watch|high|critical): #/u);
  });

  it("never lets a provider brand colour reach a meter", () => {
    const style = readFileSync(
      path.join(process.cwd(), "packages", "ui", "src", "provider-row.ts"),
      "utf8"
    );
    const meterRules = style
      .split("\n")
      .filter((line) => /\.meter-fill|\.window-meter|\.hero-readout/u.test(line));
    expect(meterRules.length).toBeGreaterThan(0);
    for (const rule of meterRules) {
      expect(rule).not.toContain("--ol-provider-");
    }
  });
});
