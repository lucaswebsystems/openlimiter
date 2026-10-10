import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAdvice, normalizeMeters, type Snapshot } from "@openlimiter/core";
import { parseClaudePayload, parseOpenrouterPayload } from "@openlimiter/connectors";
import { DEFAULT_STATUSLINE, normalizeStatusline, readConfig } from "../src/config.js";
import { parseStatuslineSession } from "../src/statusline-ingest.js";
import { formatResetTime, paintBand, renderStatuslineLayout, statuslineColor, statuslineUnicode, tenBlockBar } from "../src/statusline.js";
import { terminalHide, terminalShow, terminalStatusTable } from "../src/terminal.js";

const NOW = "2026-01-01T00:00:00.000Z";
const payload = (directory: string) => ({
  model: { display_name: "Claude Opus 5.5 (long context)", id: "fallback" },
  effort: { level: "high" }, workspace: { current_dir: directory },
  context_window: { used_percentage: 42 }, output_style: { name: "concise" },
  rate_limits: {
    five_hour: { used_percentage: 16.6, resets_at: Date.parse("2026-01-01T03:20:00Z") / 1000 },
    seven_day: { used_percentage: 26, resets_at: "2026-01-05T02:00:00Z" }
  }
});
const hostRows = normalizeMeters(parseClaudePayload(payload("/work/project"), NOW)!);
const row = (overrides: Partial<Snapshot>): Snapshot => ({ ...hostRows[0]!, ...overrides });
const snapshots = [
  ...hostRows,
  row({
    meter: "SEVEN_DAY",
    value: 26,
    source: "internal_payload",
    provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    window: { kind: "rolling", durationSeconds: 604_800 },
    resetAt: "2026-01-05T02:00:00Z",
    observedAt: NOW,
    expiresAt: "2026-01-01T00:05:00.000Z"
  }),
  row({ provider: "CODEX", meter: "SEVEN_DAY", value: 32, window: { kind: "rolling", durationSeconds: 604800 }, resetAt: "2026-01-05T02:00:00Z" }),
  row({ provider: "ANTIGRAVITY", value: 9, resetAt: "2026-01-01T00:18:00Z" }),
  row({ provider: "OPENCODE", value: 42, resetAt: null }),
  row({ provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", value: 38.3, window: { kind: "lifetime" }, usedAmount: 7.66, limitAmount: 20, currency: "USD", resetAt: null })
];
const green = (text: string) => "\x1b[32m" + text + "\x1b[0m";
const render = (rows: readonly Snapshot[], options: Partial<Parameters<typeof renderStatuslineLayout>[0]> = {}) => renderStatuslineLayout({
  advice: buildAdvice(rows, NOW), snapshots: rows, now: NOW, config: DEFAULT_STATUSLINE,
  host: "claude", color: false, ...options
});

describe("Lucas reference layout", () => {
  it.each([
    ["Windows", "C:\\work\\Olá projeto\\"],
    ["macOS", "/Volumes/work/Olá projeto/"],
    ["Linux", "/workspace/Olá projeto"]
  ])("renders the exact plain and ANSI payload line for %s paths", (_os, directory) => {
    const session = parseStatuslineSession(payload(directory));
    const plain = "opus-5-5 high | ctx 42% | 5h [█░░░░░░░░░] 17% ·3h20m | 7d [██░░░░░░░░] 26% ·4d2h | cx7d [███░░░░░░░] 32% ·4d2h | ag5h [█░░░░░░░░░] 9% ·18m | oc5h [████░░░░░░] 42% | or $12.34 | concise";
    const painted = "opus-5-5 high | ctx 42% | 5h " + green("[█░░░░░░░░░]") + " " + green("17%") + " ·3h20m | 7d " + green("[██░░░░░░░░]") + " " + green("26%") + " ·4d2h | cx7d " + green("[███░░░░░░░]") + " " + green("32%") + " ·4d2h | ag5h " + green("[█░░░░░░░░░]") + " " + green("9%") + " ·18m | oc5h " + green("[████░░░░░░]") + " " + green("42%") + " | or $12.34 | concise";
    expect(render(snapshots, { session })).toBe(plain);
    expect(render(snapshots, { session, color: true })).toBe(painted);
    expect(render(snapshots, { session, color: statuslineColor("always", { NO_COLOR: "" }, true, "claude") })).toBe(plain);
    // The folder only appears once someone opts in, and then by its last name.
    expect(render(snapshots, { session, config: { ...DEFAULT_STATUSLINE, visibility: { dir: true } } }))
      .toBe(plain.replace("opus-5-5 high | ", "opus-5-5 high | Olá projeto | "));
  });

  it("uses metadata fallbacks and discards malformed or default fields", () => {
    expect(parseStatuslineSession({ model: { id: "Claude Opus 5.5 [variant]" }, cwd: "D:\\work\\folder", output_style: { name: "default" }, context_window: { used_percentage: NaN } }))
      .toEqual({ model: "opus-5-5", dir: "folder" });
    expect(parseStatuslineSession(null)).toEqual({});
    expect(parseStatuslineSession({ effort: { level: "hi\n\u001bgh" } }).effort).toBe("high");
  });

  it.each([[0, "32"], [59, "32"], [60, "33"], [79, "33"], [80, "38;5;208"], [89, "38;5;208"], [90, "31"], [100, "31"]])("locks band %s for fresh and stale values", (value, code) => {
    for (const state of ["fresh", "stale"] as const) expect(paintBand("value", Number(value), state, false)).toBe(`\x1b[${code}mvalue\x1b[0m`);
  });

  it("marks stale and estimated numbers without changing band or hiding the reset", () => {
    const value = row({ value: 85, observedAt: "2025-12-31T23:45:00Z", expiresAt: "2025-12-31T23:46:00Z" });
    expect(render([value], { color: true })).toBe("5h \x1b[38;5;208m[████████░░]\x1b[0m \x1b[38;5;208m~85%\x1b[0m ·3h20m");
    expect(render([row({ value: 1, precision: "estimated" })])).toContain("~1%");
  });

  it.each([[12.34, "32"], [5, "32"], [4.99, "33"], [1, "33"], [0.99, "31"], [0, "31"]])("keeps remaining credits neutral %s", (balance, _code) => {
    const credit = row({ provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", window: { kind: "lifetime" }, usedAmount: 20 - Number(balance), limitAmount: 20, currency: "USD" });
    expect(render([credit], { color: true })).toBe(`or $${Number(balance).toFixed(2)}`);
  });

  it("renders a direct account balance in credits as money", () => {
    const credit = row({
      provider: "OPENROUTER",
      meter: "ACCOUNT_BALANCE",
      unit: "CREDITS",
      value: 12.34,
      window: { kind: "lifetime" },
    });
    expect(render([credit])).toBe("or $12.34");
  });

  it("keeps the key allowance distinct from the account balance", () => {
    const key = normalizeMeters(parseOpenrouterPayload({
      data: { limit: 100, limit_remaining: 90, limit_reset: "monthly", usage: 500 },
    }, NOW) ?? []);
    const balance = normalizeMeters(parseOpenrouterPayload({
      data: { total_credits: 20, total_usage: 7.66 },
    }, NOW) ?? []);

    expect(render([...key, ...balance])).toBe("or key $10.00/$100.00 | or $12.34");
  });

  it("shows an uncapped key and a balance unavailable without a management key", () => {
    const rows = normalizeMeters(parseOpenrouterPayload({
      data: { limit: null, limit_remaining: null, usage: 500 },
    }, NOW) ?? []);

    expect(render(rows)).toBe("or No key cap | or unavailable");
  });

  it("keeps the account balance beside key pressure in worst mode", () => {
    const key = normalizeMeters(parseOpenrouterPayload({
      data: { limit: 100, limit_remaining: 90, limit_reset: "monthly", usage: 500 },
    }, NOW) ?? []);
    const balance = normalizeMeters(parseOpenrouterPayload({
      data: { total_credits: 20, total_usage: 7.66 },
    }, NOW) ?? []);
    expect(render([...key, ...balance], { config: { ...DEFAULT_STATUSLINE, meters: "worst" } }))
      .toBe("or key $10.00/$100.00 | or $12.34");
  });

  it("keeps a measured balance when a newer unavailable placeholder exists", () => {
    const measured = row({
      provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", value: 38.3,
      usedAmount: 7.66, limitAmount: 20, currency: "USD", window: { kind: "lifetime" },
    });
    const unavailable = row({
      provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", value: 0,
      availability: "missing_credentials", observedAt: "2026-01-01T00:00:30.000Z",
      expiresAt: "2026-01-01T00:01:30.000Z", window: { kind: "lifetime" },
    });
    expect(render([measured, unavailable], { config: { ...DEFAULT_STATUSLINE, meters: "worst" } }))
      .toBe("or $12.34");
  });

  it("keeps Kimi direction and OpenCode provenance in the default line", () => {
    const rendered = render([
      row({ provider: "KIMI", meter: "FIVE_HOUR", value: 20 }),
      row({ provider: "OPENCODE", meter: "FIVE_HOUR", value: 38.3 }),
    ], { config: { ...DEFAULT_STATUSLINE, meters: "worst" } });
    expect(rendered).toContain("km5h");
    expect(rendered).toContain("oc5h");
  });

  it("never draws unknown markers, even for a selected provider, and leaves dormant accounts out", () => {
    expect(render([])).toBe("OpenLimiter UNKNOWN");
    const config = { ...DEFAULT_STATUSLINE, visibility: { codex: true } };
    expect(render([], { config, color: true })).toBe("OpenLimiter UNKNOWN");
    expect(render([row({ provider: "CODEX", observedAt: "2025-12-24T23:59:59Z" })], { config })).toBe("OpenLimiter UNKNOWN");
    expect(render([row({ provider: "CODEX", meter: "ACQUISITION", availability: "access_denied" })], { config })).toBe("OpenLimiter UNKNOWN");
  });

  it("supports ASCII only when the terminal indicates limited encoding", () => {
    expect(statuslineUnicode({})).toBe(true);
    expect(statuslineUnicode({ LANG: "en_US.UTF-8" })).toBe(true);
    expect(statuslineUnicode({ LC_ALL: "C" })).toBe(false);
    expect(statuslineUnicode({ TERM: "dumb" })).toBe(false);
    expect(render([row({ value: 0.1 })], { unicode: false })).toBe("5h [#.........] 0% .3h20m");
    expect(tenBlockBar(0)).toBe("[░░░░░░░░░░]");
    expect(formatResetTime("invalid", NOW)).toBe("");
    expect(formatResetTime(NOW, NOW)).toBe("");
  });

  it.each([
    ["2026-01-01T04:59:00.000Z", "·4h59m"],
    ["2026-01-07T23:00:00.000Z", "·6d23h"],
  ])("formats every provider reset as one compact trailing marker", (resetAt, expected) => {
    expect(formatResetTime(resetAt, NOW)).toBe(expected);
  });

  it("preserves ANSI in Claude's captured output and honours NO_COLOR", () => {
    expect(statuslineColor("auto", {}, false, "claude")).toBe(true);
    expect(statuslineColor("auto", { NO_COLOR: "" }, false, "claude")).toBe(false);
  });

  it("labels each provider window by its actual duration", () => {
    expect(render([row({ provider: "OPENCODE", window: { kind: "rolling", durationSeconds: 14400 }, resetAt: null })]))
      .toBe("oc4h [█░░░░░░░░░] 17%");
  });
  it("keeps weekly visibility stable while allowing a model override", () => {
    const weekly = row({ meter: "SEVEN_DAY", window: { kind: "rolling", durationSeconds: 604_800 } });
    const fable = row({ meter: "SEVEN_DAY_FABLE_5_1", window: { kind: "rolling", durationSeconds: 604_800 } });
    const opus = row({ meter: "SEVEN_DAY_OPUS", window: { kind: "rolling", durationSeconds: 604_800 } });
    const hidden = normalizeStatusline({ visibility: { "7d": false, fable: true, opus: false } });
    const visible = render([weekly, fable, opus], {
      config: normalizeStatusline({ visibility: { "7d": true, fable: true, opus: true } })
    });

    expect(hidden.visibility).toEqual({ "7d": false, fable: true, opus: false });
    expect(visible).toContain("fable7d ");
    expect(visible).toContain("opus7d");
    expect(render([weekly, fable, opus], { config: hidden })).toContain("fable7d ");
    expect(render([weekly, fable, opus], { config: hidden })).not.toMatch(/(?:^|\| )7d /u);
    expect(render([weekly, fable, opus], { config: hidden })).not.toContain("opus7d");
  });

  it("renders parsed Claude extra usage with its compact caption and both amounts", () => {
    const parsed = normalizeMeters(parseClaudePayload({
      extra_usage: { used_amount: 12.47, limit_amount: 20, currency: "USD" },
    }, NOW) ?? []);

    expect(render(parsed)).toBe("extra $12.47/$20.00");
  });
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("terminal visibility persistence", () => {
  it("round trips mixed toggles without changing automatic discovery or other configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openlimiter-visibility-")); roots.push(root);
    const context = { stateDirectory: root, homeDirectory: root, platform: "win32" as const, detectedProviders: [] };
    expect((await terminalHide(["MODEL", "effort", "dir", "ctx", "style", "7d", "ag"], context)).ok).toBe(true);
    expect((await terminalShow(["cx", "5h"], context)).ok).toBe(true);
    const saved = await readConfig(root);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("config unavailable");
    expect(saved.config.statusline.show).toEqual([]);
    expect(saved.config.statusline.visibility).toEqual({ model: false, effort: false, dir: false, ctx: false, style: false, "7d": false, antigravity: false, codex: true, "5h": true });
    expect(render(snapshots, { config: saved.config.statusline, session: parseStatuslineSession(payload("/work/project")) }))
      .toBe("5h [█░░░░░░░░░] 17% ·3h20m | oc5h [████░░░░░░] 42% | or $12.34");
    const status = await terminalStatusTable(context);
    expect(status).toContain("Hidden: model, effort, dir, ctx, style, 7d, antigravity");
    const before = saved.config;
    expect((await terminalShow(["model", "bogus"], context)).ok).toBe(false);
    expect(await readConfig(root)).toEqual({ ok: true, config: before });
    expect((await terminalShow(["model", "effort", "dir", "ctx", "style", "7d", "ag"], context)).ok).toBe(true);
  });

  it("validates stored visibility values", () => {
    expect(normalizeStatusline({ visibility: { model: false, effort: "yes", bogus: true, codex: true } }).visibility).toEqual({ model: false, codex: true });
  });
});
