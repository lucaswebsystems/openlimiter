import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAdvice, type Snapshot } from "@openlimiter/core";
import { runCli } from "../src/cli.js";
import { DEFAULT_STATUSLINE, readConfig } from "../src/config.js";
import { renderStatuslineLayout } from "../src/statusline.js";
import { terminalHide, terminalShow, terminalStatusTable } from "../src/terminal.js";

const ESC = String.fromCharCode(27);
const NOW = "2026-09-07T12:30:00.000Z";
const FRESH = "2026-09-07T12:25:00Z";

let counter = 0;
function source(provider: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  return { id: "src-" + String(counter), provider, keyLabel: provider, enabled: true, budgetUsd: null, status: "eligible", ...extra };
}
function sample(sourceId: string, provider: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  const balance = provider === "moonshot" || provider === "deepseek";
  return {
    id: "smp-" + String(counter), sourceId, sequence: 1, provider, metricKind: balance ? "balance" : "spend",
    month: "2026-09-01", spendUsd: null, balanceUsd: null, observedAt: FRESH, currencySource: "provider_usd", ...extra
  };
}
function document(pairs: Array<[ReturnType<typeof source>, Record<string, unknown>]>) {
  return {
    version: 1,
    sources: pairs.map(([s]) => s),
    samples: pairs.map(([s, extra]) => sample(s.id, s.provider, extra))
  };
}

function render(apiSpend: unknown, snapshots: readonly Snapshot[] = [], color = false, visibility: Record<string, boolean> = {}) {
  return renderStatuslineLayout({
    advice: buildAdvice(snapshots, NOW, []),
    snapshots, now: NOW, color, host: "shell", apiSpend,
    config: { ...DEFAULT_STATUSLINE, style: "bar", visibility }
  });
}

const orCache: Snapshot = {
  provider: "OPENROUTER", meter: "CREDITS", value: 12.34, unit: "CREDITS", window: { kind: "lifetime" }, resetAt: null,
  source: "internal_payload", precision: "exact", observedAt: NOW, expiresAt: "2026-09-07T12:35:00.000Z",
  labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint", automationRisk: "low", verification: "UNVERIFIED" }
};

function fullDocument() {
  return document([
    [source("openai"), { spendUsd: "12.34" }],
    [source("anthropic", { budgetUsd: "100" }), { spendUsd: "85", budgetUsd: "100" }],
    [source("moonshot"), { balanceUsd: "3" }],
    [source("deepseek"), { balanceUsd: "0.80" }],
    [source("deepseek"), { currencySource: "provider_cny" }],
    [source("openrouter"), { spendUsd: "7.5" }]
  ]);
}

describe("api money cells in the bar status line", () => {
  it("draws one plain cell per source, in source order", () => {
    expect(render(fullDocument())).toBe("oa $12.34 | an $85.00 | ms $3.00 | ds $0.80 | ds CNY | or $7.50 spent");
  });

  it("colours budget spend by band and balances like the or cell", () => {
    const painted = render(fullDocument(), [], true);
    expect(painted).toContain("oa $12.34 | an " + ESC + "[38;5;208m$85.00" + ESC + "[0m");
    expect(painted).toContain("ms " + ESC + "[33m$3.00" + ESC + "[0m");
    expect(painted).toContain("ds " + ESC + "[31m$0.80" + ESC + "[0m");
    expect(painted).not.toContain("oa " + ESC);
  });

  it("adds no second or cell when the cache already has one", () => {
    const line = render(fullDocument(), [orCache]);
    expect(line.match(/\bor \$/g)).toHaveLength(1);
    expect(line).toContain("or $12.34");
    expect(line).not.toContain("spent");
  });

  it("draws one or cell for two cached accounts, using the newest balance", () => {
    const older = { ...orCache, accountId: "account-a", value: 12.34, observedAt: "2026-09-07T12:28:00Z" };
    const newer = { ...orCache, accountId: "account-b", value: 56.78, observedAt: "2026-09-07T12:29:00Z" };
    const line = render(fullDocument(), [older, newer]);
    expect(line.match(/\bor \$/g)).toHaveLength(1);
    expect(line).toContain("or $56.78");
    expect(line).not.toContain("or $12.34");
    expect(line).not.toContain("spent");
  });

  it("draws one or cell for several OpenRouter sources, the newest current period one", () => {
    const doc = document([
      [source("openrouter"), { spendUsd: "9", month: "2026-08-01" }],
      [source("openrouter"), { spendUsd: "2", observedAt: "2026-09-07T12:24:00Z" }],
      [source("openai"), { spendUsd: "3" }],
      [source("openrouter"), { spendUsd: "1", observedAt: "2026-09-07T12:20:00Z" }]
    ]);
    expect(render(doc)).toBe("or $2.00 spent | oa $3.00");
  });

  it("lets the cache or cell win over several OpenRouter sources", () => {
    const doc = document([
      [source("openrouter"), { spendUsd: "1" }],
      [source("openrouter"), { spendUsd: "2" }]
    ]);
    const line = render(doc, [orCache]);
    expect(line.match(/\bor \$/g)).toHaveLength(1);
    expect(line).toContain("or $12.34");
  });

  it("draws xai spend and a red DeepSeek amount for a too low balance", () => {
    const doc = document([
      [source("xai"), { spendUsd: "0.42" }],
      [source("deepseek", { status: "too_low_for_api_calls" }), { balanceUsd: "7" }]
    ]);
    expect(render(doc)).toBe("xa $0.42 | ds $7.00");
    expect(render(doc, [], true)).toContain("ds " + ESC + "[31m$7.00" + ESC + "[0m");
  });

  it("matches samples by source id, so two keys of one provider each show their own amount", () => {
    const doc = document([
      [source("openai"), { spendUsd: "1.10" }],
      [source("openai"), { spendUsd: "2.20" }]
    ]);
    expect(render(doc)).toBe("oa $1.10 | oa $2.20");
  });

  it("uses the newest sample of a source", () => {
    const s = source("openai");
    const doc = {
      version: 1, sources: [s],
      samples: [
        sample(s.id, "openai", { spendUsd: "1", observedAt: "2026-09-07T12:00:00Z", sequence: 1 }),
        sample(s.id, "openai", { spendUsd: "2", observedAt: FRESH, sequence: 2 })
      ]
    };
    expect(render(doc)).toBe("oa $2.00");
  });

  it("shows nothing for a spend sample from a previous period", () => {
    const doc = document([[source("openai"), { spendUsd: "9", month: "2026-08-01" }]]);
    expect(render(doc)).toBe("OpenLimiter UNKNOWN");
  });

  it("skips disabled sources", () => {
    const doc = document([[source("openai", { enabled: false }), { spendUsd: "9" }]]);
    expect(render(doc)).toBe("OpenLimiter UNKNOWN");
  });

  it("prefixes a stale sample with a tilde", () => {
    const doc = document([[source("openai"), { spendUsd: "12.34", observedAt: "2026-09-07T10:00:00Z" }]]);
    expect(render(doc)).toBe("oa ~$12.34");
    const cny = document([[source("deepseek"), { currencySource: "provider_cny", observedAt: "2026-09-07T10:00:00Z" }]]);
    expect(render(cny)).toBe("ds ~CNY");
  });

  it("draws no money cell for a source whose key was just replaced", async () => {
    /* The state the desktop writes when a key is replaced, pinned by api_spend.rs:
       the old key's samples left with it, so nothing is selected by its source id. */
    const fixture = async (name: string): Promise<unknown> => JSON.parse(await readFile(
      path.resolve(process.cwd(), "apps/desktop/src-tauri/tests/fixtures", name), "utf8"));
    expect(render(await fixture("api-spend-v1-2.0.2.json"))).toContain("xa ");
    const replaced = render(await fixture("api-spend-v1-replaced-key.json"));
    expect(replaced).not.toContain("xa ");
    expect(replaced).toContain("or ");
  });

  it("renders nothing, with no error, for a non USD amount", () => {
    const doc = document([[source("openai"), { spendUsd: "12.34", currencySource: "provider_cny" }]]);
    expect(render(doc)).toBe("OpenLimiter UNKNOWN");
  });

  it("renders nothing for missing or malformed documents", () => {
    for (const bad of [undefined, null, "text", 5, [], { version: 1 }, { version: 1, sources: 3, samples: [] },
      { version: 1, sources: [null, 4], samples: [null] }]) {
      expect(render(bad)).toBe("OpenLimiter UNKNOWN");
    }
  });

  it("honours terminal visibility by name", () => {
    expect(render(fullDocument(), [], false, { deepseek: false })).not.toContain("ds ");
    expect(render(fullDocument(), [], false, { openai: false, openrouter: false }))
      .toBe("an $85.00 | ms $3.00 | ds $0.80 | ds CNY");
  });
});

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "openlimiter-api-spend-"));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("api money cells end to end", () => {
  const run = (stateDirectory: string) => runCli(["statusline", "--host", "shell"], {
    stateDirectory, now: () => NOW, environment: { NO_COLOR: "" }, colorOutput: false, readStandardInput: async () => ""
  });

  it("reads api-spend-v1.json from the state directory", async () => {
    const stateDirectory = await directory();
    await writeFile(path.join(stateDirectory, "api-spend-v1.json"), JSON.stringify(fullDocument()));
    const result = await run(stateDirectory);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("oa $12.34 | an $85.00 | ms $3.00");
  });

  it("stays silent for a missing file and for malformed JSON", async () => {
    const stateDirectory = await directory();
    const missing = await run(stateDirectory);
    expect(missing).toMatchObject({ exitCode: 0, stderr: "" });
    await writeFile(path.join(stateDirectory, "api-spend-v1.json"), "{not json");
    const broken = await run(stateDirectory);
    expect(broken).toMatchObject({ exitCode: 0, stderr: "" });
    expect(broken.stdout).toBe(missing.stdout);
    expect(broken.stdout).not.toContain("$");
  });
});

describe("terminal show and hide for api money", () => {
  it("hides deepseek by name or tag and lists the new names", async () => {
    const root = await directory();
    const context = { stateDirectory: root, homeDirectory: root, platform: "win32" as const, detectedProviders: [] };
    const before = await terminalStatusTable(context);
    for (const name of ["openai", "anthropic", "xai", "moonshot", "deepseek"]) {
      expect(before).toMatch(new RegExp("Shown: .*\\b" + name + "\\b"));
    }
    expect((await terminalHide(["ds"], context)).ok).toBe(true);
    expect(await terminalStatusTable(context)).toContain("Hidden: dir, deepseek");
    const saved = await readConfig(root);
    if (!saved.ok) throw new Error("config unavailable");
    const hidden = render(fullDocument(), [], false, saved.config.statusline.visibility);
    expect(hidden).not.toContain("ds ");
    expect(hidden).toContain("ms $3.00");
    expect((await terminalShow(["oa", "an", "xa", "ms"], context)).ok).toBe(true);
  });
});
