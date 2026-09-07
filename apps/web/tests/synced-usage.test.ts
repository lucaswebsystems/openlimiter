import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  apiSpendOf,
  groupLatestSyncedUsage,
  readSyncedApiSpend,
  readSyncedUsage,
} from "@/lib/synced-usage";

/**
 * What the hub reads back after a device syncs.
 *
 * The rows here are not invented. They are the shared envelope the desktop
 * uploads, at packages/core/fixtures/sync-envelope-v2.json, turned into the
 * shape the owner scoped read function answers with. The same file is
 * asserted by a Rust test in the desktop and by a Deno test on the server, so
 * a field renamed anywhere fails a test in three places instead of quietly
 * emptying somebody's dashboard.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../../packages/core/fixtures/sync-envelope-v2.json"),
    "utf8",
  ),
) as {
  device_id: string;
  client_version: string;
  usage_samples: Array<{
    account_id: string;
    provider: string;
    window_id: string;
    usage_percent: number;
    reset_at: string | null;
    observed_at: string;
    stale: boolean;
  }>;
};

/** The fixture as `read_current_usage_v1()` answers it. */
function usageRows() {
  return FIXTURE.usage_samples.map((sample) => ({
    device_id: FIXTURE.device_id,
    device_label: "This machine",
    provider: sample.provider,
    account_id: sample.account_id,
    window_id: sample.window_id,
    used_percent: sample.usage_percent,
    resets_at: sample.reset_at,
    observed_at: sample.observed_at,
    stale: sample.stale,
    client_version: FIXTURE.client_version,
  }));
}

const SPEND_ROWS = [
  {
    device_id: "9c1d4f60-2e83-4b17-8a5c-71e0d3f95b46",
    provider: "OPENROUTER",
    account_id: "openrouter-personal",
    currency: "USD",
    amount_minor: 4090,
    period_start: "2026-09-01T00:00:00.000Z",
    period_end: "2026-09-07T12:00:00.000Z",
    observed_at: "2026-09-07T12:00:00.000Z",
  },
];

function clientWith(options: {
  usage?: unknown;
  spend?: unknown;
  usageError?: unknown;
  session?: unknown;
  sessionError?: unknown;
}): SupabaseClient {
  return {
    auth: {
      getSession: async () => ({
        data: { session: options.session === undefined ? { user: { id: "u" } } : options.session },
        error: options.sessionError ?? null,
      }),
    },
    rpc: async (name: string) => {
      if (name === "read_current_usage_v1") {
        return { data: options.usage ?? [], error: options.usageError ?? null };
      }
      if (name === "read_current_api_spend_v1") {
        return { data: options.spend ?? [], error: null };
      }
      throw new Error(`no such function: ${name}`);
    },
  } as unknown as SupabaseClient;
}

describe("the read path", () => {
  it("answers with the rows the account's own function returned", async () => {
    /* The client here has no table reader at all and refuses any function
       but the two owner scoped ones, so a read that went back to a table, or
       to a function this account does not own, has nothing to answer with. */
    const result = await readSyncedUsage(clientWith({ usage: usageRows() }));
    expect(result).toEqual({
      ok: true,
      providers: [
        {
          provider: "CLAUDE",
          accountLabel: "claude-personal",
          windows: [
            {
              windowName: "FIVE_HOUR",
              percentage: 27.5,
              resetAt: "2026-09-07T14:00:00.000Z",
              observedAt: "2026-09-07T11:59:30.000Z",
              stale: false,
            },
            {
              windowName: "SEVEN_DAY_FABLE",
              percentage: 62.5,
              resetAt: "2026-09-11T09:00:00.000Z",
              observedAt: "2026-09-07T11:59:30.000Z",
              stale: false,
            },
          ],
        },
        {
          provider: "CODEX",
          accountLabel: "codex-personal",
          windows: [
            {
              windowName: "PRIMARY_WINDOW",
              percentage: 98,
              resetAt: "2026-09-12T03:00:00.000Z",
              observedAt: "2026-09-07T11:58:00.000Z",
              stale: true,
            },
          ],
        },
      ],
    });
  });

  it("says why it has nothing rather than showing an empty account", async () => {
    expect(await readSyncedUsage(null)).toEqual({ ok: false, reason: "unconfigured" });
    expect(await readSyncedUsage(clientWith({ session: null }))).toEqual({
      ok: false,
      reason: "signed_out",
    });
    expect(await readSyncedUsage(clientWith({ usageError: { message: "denied" } }))).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await readSyncedUsage(clientWith({ sessionError: { message: "broken" } }))).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("gives a model scoped window a row of its own", async () => {
    /* The Claude weekly window and the model scoped weekly window are two
       readings of two different allowances. A hub that folded them into one
       row would show a person one bar where they have three, which is the
       whole reason the meter carries the window's own name. */
    const result = await readSyncedUsage(clientWith({ usage: usageRows() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const claude = result.providers.find((provider) => provider.provider === "CLAUDE");
    expect(claude?.accountLabel).toBe("claude-personal");
    expect(claude?.windows.map((window) => window.windowName)).toEqual([
      "FIVE_HOUR",
      "SEVEN_DAY_FABLE",
    ]);
    const fable = claude?.windows.find((window) => window.windowName === "SEVEN_DAY_FABLE");
    expect(fable?.percentage).toBe(62.5);
    expect(fable?.resetAt).toBe("2026-09-11T09:00:00.000Z");
    expect(fable?.stale).toBe(false);

    /* Two providers, each with its own account label. */
    expect(result.providers.map((provider) => provider.provider)).toEqual(["CLAUDE", "CODEX"]);
    const codex = result.providers.find((provider) => provider.provider === "CODEX");
    expect(codex?.windows).toHaveLength(1);
    expect(codex?.windows[0].stale).toBe(true);
  });

  it("drops a row it cannot trust instead of drawing it", () => {
    const rows = usageRows();
    const grouped = groupLatestSyncedUsage([
      ...rows,
      { ...rows[0], provider: "not a provider code" },
      { ...rows[0], account_id: "Not An Account" },
      { ...rows[0], window_id: "lower case" },
      { ...rows[0], used_percent: 140 },
      { ...rows[0], observed_at: "whenever" },
      { ...rows[0], resets_at: "whenever" },
      null,
      "a string",
    ]);
    expect(grouped.flatMap((provider) => provider.windows)).toHaveLength(3);
  });

  it("keeps the newest reading of a window when a device sent two", () => {
    const [first] = usageRows();
    const older = { ...first, used_percent: 9, observed_at: "2026-09-07T10:00:00.000Z" };
    const grouped = groupLatestSyncedUsage([older, first]);
    expect(grouped[0].windows[0].percentage).toBe(first.used_percent);
  });
});

describe("the spend read path", () => {
  it("keeps money in its minor unit and its own currency", async () => {
    const result = await readSyncedApiSpend(clientWith({ spend: SPEND_ROWS }));
    expect(result).toEqual({
      ok: true,
      sources: [
        {
          provider: "OPENROUTER",
          accountLabel: "openrouter-personal",
          currency: "USD",
          amountMinor: 4090,
          periodStart: "2026-09-01T00:00:00.000Z",
          periodEnd: "2026-09-07T12:00:00.000Z",
          observedAt: "2026-09-07T12:00:00.000Z",
        },
      ],
    });
  });

  it("refuses a fractional amount, a bad currency and a period that runs backwards", () => {
    const [row] = SPEND_ROWS;
    expect(apiSpendOf({ ...row, amount_minor: 40.9 })).toBeNull();
    expect(apiSpendOf({ ...row, currency: "dollars" })).toBeNull();
    expect(apiSpendOf({ ...row, period_end: row.period_start })).toBeNull();
    expect(apiSpendOf(null)).toBeNull();
  });

  it("says why it has nothing rather than showing a zero", async () => {
    expect(await readSyncedApiSpend(null)).toEqual({ ok: false, reason: "unconfigured" });
    expect(await readSyncedApiSpend(clientWith({ session: null }))).toEqual({
      ok: false,
      reason: "signed_out",
    });
  });
});
