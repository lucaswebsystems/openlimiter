import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot } from "@openlimiter/core";
import type { HubReply, HubRequest, HubTransport } from "../src/hub.js";
import {
  SYNC_CURSOR_FILE_NAME,
  apiSpendSamplesFromSnapshots,
  runSync,
  usageSamplesFromSnapshots
} from "../src/hub-sync.js";

/* Tests run from the repository root, exactly like every other cross package
   fixture read in this suite (see packages/connectors/test for the same
   pattern), so the path is built from the working directory rather than
   `import.meta.url`, which would resolve inside the compiled test output. */
const FIXTURE_PATH = path.resolve(process.cwd(), "packages/core/fixtures/sync-envelope-v2.json");

const CONFIGURED = { OPENLIMITER_SUPABASE_ANON_KEY: "sb_publishable_test_key" };
const TOKEN = "t".repeat(32);
const DEVICE_ID = "device-1234";
const NOW = "2026-09-07T12:00:00.000Z";

let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), prefix));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function usageSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    provider: "CLAUDE",
    meter: "FIVE_HOUR",
    value: 27.5,
    unit: "PERCENT",
    window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt: "2026-09-07T14:00:00.000Z",
    source: "native_payload",
    precision: "exact",
    observedAt: "2026-09-07T11:59:30.000Z",
    expiresAt: "2026-09-07T12:05:00.000Z",
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "native-statusline-payload",
      automationRisk: "low",
      verification: "UNVERIFIED"
    },
    ...overrides
  };
}

function spendSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return usageSnapshot({
    provider: "OPENROUTER",
    meter: "API_BUDGET_PERCENT",
    unit: "CREDITS",
    value: 40.9,
    usedAmount: 40.9,
    limitAmount: 100,
    currency: "USD",
    accountId: "openrouter-key",
    accountLabel: "OpenRouter key",
    window: { kind: "fixed", durationSeconds: 30 * 86400 },
    resetAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  });
}

async function readCursor(directory: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(directory, SYNC_CURSOR_FILE_NAME), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function accepted(sequence: number, tier = "free"): HubReply {
  return { status: 200, body: JSON.stringify({ accepted: true, sequence, tier }) };
}

function recordingTransport(reply: (request: HubRequest, call: number) => HubReply | Promise<HubReply>): {
  transport: HubTransport;
  sent: HubRequest[];
} {
  const sent: HubRequest[] = [];
  let call = 0;
  return {
    sent,
    transport: async (request) => {
      sent.push(request);
      call += 1;
      return reply(request, call);
    }
  };
}

describe("envelope shape against the version 2 fixture", () => {
  it("carries exactly the same top level keys as the fixture", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
    const { transport, sent } = recordingTransport(() => accepted(1));
    await runSync({
      directory: await temporaryDirectory("openlimiter-sync-"),
      environment: CONFIGURED,
      transport,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot(), spendSnapshot()]
    });
    const envelope = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(Object.keys(fixture).sort());
  });

  it("carries exactly the same usage and spend row keys as the fixture", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as {
      usage_samples: Array<Record<string, unknown>>;
      api_spend_samples: Array<Record<string, unknown>>;
    };
    const usage = usageSamplesFromSnapshots([usageSnapshot()], NOW);
    const spend = apiSpendSamplesFromSnapshots([spendSnapshot()], NOW);
    expect(Object.keys(usage[0] ?? {}).sort()).toEqual(Object.keys(fixture.usage_samples[0] ?? {}).sort());
    expect(Object.keys(spend[0] ?? {}).sort()).toEqual(
      Object.keys(fixture.api_spend_samples[0] ?? {}).sort()
    );
  });
});

describe("usageSamplesFromSnapshots", () => {
  it("carries only PERCENT rows, and marks a stale one honestly", () => {
    const fresh = usageSnapshot();
    const stale = usageSnapshot({
      meter: "SEVEN_DAY",
      observedAt: "2026-09-07T00:00:00.000Z",
      expiresAt: "2026-09-07T00:05:00.000Z"
    });
    const notPercent = usageSnapshot({ meter: "TOKENS_LEFT", unit: "TOKENS", value: 900 });
    const rows = usageSamplesFromSnapshots([fresh, stale, notPercent], NOW);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.meter === "FIVE_HOUR")?.stale).toBe(false);
    expect(rows.find((row) => row.meter === "SEVEN_DAY")?.stale).toBe(true);
  });

  it("drops a row outside the 0 to 100 bound rather than repairing it", () => {
    const rows = usageSamplesFromSnapshots([usageSnapshot({ value: 142 })], NOW);
    expect(rows).toHaveLength(0);
  });

  it("never treats API_BUDGET_PERCENT as a usage window, even at PERCENT unit, whichever provider carries it", () => {
    const openrouterBudget = usageSnapshot({ provider: "OPENROUTER", meter: "API_BUDGET_PERCENT", value: 40 });
    /* Moonshot's own budget reading carries provider KIMI in this build's own
       vocabulary (PROVIDER_CODES has no MOONSHOT at all), distinguished from
       an ordinary Kimi Code usage window by this same meter name alone. */
    const kimiBudget = usageSnapshot({ provider: "KIMI", meter: "API_BUDGET_PERCENT", value: 12 });
    const kimiUsage = usageSnapshot({ provider: "KIMI", meter: "FIVE_HOUR", value: 30 });
    const ordinary = usageSnapshot();
    const rows = usageSamplesFromSnapshots([openrouterBudget, kimiBudget, kimiUsage, ordinary], NOW);
    expect(rows.map((row) => row.provider).sort()).toEqual(["CLAUDE", "KIMI"]);
  });

  it("drops a row whose account id is present but not shaped like one, rather than defaulting it", () => {
    const malformed = usageSnapshot({ accountId: "Not Valid!" });
    const missing = usageSnapshot({ meter: "SEVEN_DAY" });
    const rows = usageSamplesFromSnapshots([malformed, missing], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account_id).toBe("default");
  });
});

describe("apiSpendSamplesFromSnapshots", () => {
  it("builds a row only when the amount, limit and currency all travel together", () => {
    const complete = spendSnapshot();
    const partial = usageSnapshot({ provider: "CLAUDE", usedAmount: 5 });
    const rows = apiSpendSamplesFromSnapshots([complete, partial], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spend_usd).toBe(40.9);
    expect(rows[0]?.budget_usd).toBe(100);
    expect(rows[0]?.currency_source).toBe("PROVIDER_USD");
  });

  it("derives a stable source id across two builds of the same row", () => {
    const first = apiSpendSamplesFromSnapshots([spendSnapshot()], NOW);
    const second = apiSpendSamplesFromSnapshots([spendSnapshot()], NOW);
    expect(first[0]?.source_id).toBe(second[0]?.source_id);
  });

  it("keeps a spend row only for the providers the hub accepts, so one extra pool never voids the envelope", () => {
    const claudePool = spendSnapshot({ provider: "CLAUDE", accountId: "claude-max", accountLabel: "Claude Max" });
    const rows = apiSpendSamplesFromSnapshots([spendSnapshot(), claudePool], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("OPENROUTER");
  });

  it("drops a spend row whose account id is present but not shaped like one", () => {
    const rows = apiSpendSamplesFromSnapshots([spendSnapshot({ accountId: "Not Valid!" })], NOW);
    expect(rows).toHaveLength(0);
  });
});

describe("a cache holding both a budget reading and a Kimi usage reading", () => {
  it("uploads the usage window but never the budget reading, so the hub never sees a row it would reject", () => {
    const cache = [
      usageSnapshot({ provider: "OPENROUTER", meter: "API_BUDGET_PERCENT", value: 40 }),
      usageSnapshot({ provider: "KIMI", meter: "API_BUDGET_PERCENT", value: 12 }),
      usageSnapshot({ provider: "KIMI", meter: "FIVE_HOUR", value: 30 }),
      usageSnapshot()
    ];
    const usage = usageSamplesFromSnapshots(cache, NOW);
    expect(usage.map((row) => row.provider).sort()).toEqual(["CLAUDE", "KIMI"]);
    expect(usage.some((row) => row.meter === "API_BUDGET_PERCENT")).toBe(false);
  });
});

describe("runSync", () => {
  it("reports nothing to sync when the cache has no qualifying row", async () => {
    const { transport } = recordingTransport(() => accepted(1));
    const result = await runSync({
      directory: await temporaryDirectory("openlimiter-sync-"),
      environment: CONFIGURED,
      transport,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: []
    });
    expect(result).toEqual({ kind: "nothing_to_sync" });
  });

  it("accepts a first upload at sequence one, and settles the cursor", async () => {
    const directory = await temporaryDirectory("openlimiter-sync-");
    const { transport, sent } = recordingTransport(() => accepted(1, "pro"));
    const result = await runSync({
      directory,
      environment: CONFIGURED,
      transport,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot()]
    });
    expect(result).toEqual({ kind: "accepted", rows: 1, tier: "pro" });
    const envelope = JSON.parse(sent[0]?.body ?? "{}") as { previous_sequence: number; sequence: number };
    expect(envelope.previous_sequence).toBe(0);
    expect(envelope.sequence).toBe(1);
    expect((await readCursor(directory))["sequence"]).toBe(1);
  });

  it("resends the identical envelope, under the same event id, when the reply never arrives", async () => {
    const directory = await temporaryDirectory("openlimiter-sync-");
    const alwaysUnavailable: HubTransport = async () => {
      throw new Error("offline");
    };
    const firstRun = await runSync({
      directory,
      environment: CONFIGURED,
      transport: alwaysUnavailable,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot()]
    });
    expect(firstRun).toEqual({ kind: "unavailable" });
    const pendingEventId = (await readCursor(directory))["pendingEventId"];
    expect(typeof pendingEventId).toBe("string");

    const { transport, sent } = recordingTransport(() => accepted(1));
    const secondRun = await runSync({
      directory,
      environment: CONFIGURED,
      transport,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot()]
    });
    expect(secondRun.kind).toBe("accepted");
    const envelope = JSON.parse(sent[0]?.body ?? "{}") as { event_id: string; previous_sequence: number };
    expect(envelope.event_id).toBe(pendingEventId);
    expect(envelope.previous_sequence).toBe(0);
  });

  it("mints a fresh event id once the readings have moved on from the pending upload", async () => {
    const directory = await temporaryDirectory("openlimiter-sync-");
    const alwaysUnavailable: HubTransport = async () => {
      throw new Error("offline");
    };
    await runSync({
      directory,
      environment: CONFIGURED,
      transport: alwaysUnavailable,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot({ value: 27.5 })]
    });
    const pendingEventId = (await readCursor(directory))["pendingEventId"];

    const { transport, sent } = recordingTransport(() => accepted(1));
    await runSync({
      directory,
      environment: CONFIGURED,
      transport,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot({ value: 55 })]
    });
    const envelope = JSON.parse(sent[0]?.body ?? "{}") as { event_id: string };
    expect(envelope.event_id).not.toBe(pendingEventId);
  });

  it("adopts the hub's own sequence on a conflict, and retries once to land it", async () => {
    const directory = await temporaryDirectory("openlimiter-sync-");
    const { transport, sent } = recordingTransport((_request, call) =>
      call === 1
        ? { status: 409, body: JSON.stringify({ current_sequence: 5 }) }
        : accepted(6)
    );
    const result = await runSync({
      directory,
      environment: CONFIGURED,
      transport,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot()]
    });
    expect(result).toEqual({ kind: "accepted", rows: 1, tier: "free" });
    expect(sent).toHaveLength(2);
    const retried = JSON.parse(sent[1]?.body ?? "{}") as { previous_sequence: number };
    expect(retried.previous_sequence).toBe(5);
    expect((await readCursor(directory))["sequence"]).toBe(6);
  });

  it("clears nothing itself on a 401, and hands the caller a revoked outcome", async () => {
    const { transport } = recordingTransport(() => ({ status: 401, body: "" }));
    const result = await runSync({
      directory: await temporaryDirectory("openlimiter-sync-"),
      environment: CONFIGURED,
      transport,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot()]
    });
    expect(result).toEqual({ kind: "revoked" });
  });

  it("rejects and settles the cursor on an ordinary refusal", async () => {
    const directory = await temporaryDirectory("openlimiter-sync-");
    const { transport } = recordingTransport(() => ({ status: 400, body: "" }));
    const result = await runSync({
      directory,
      environment: CONFIGURED,
      transport,
      now: NOW,
      token: TOKEN,
      deviceId: DEVICE_ID,
      snapshots: [usageSnapshot()]
    });
    expect(result).toEqual({ kind: "rejected" });
    expect((await readCursor(directory))["sequence"]).toBe(0);
  });
});
