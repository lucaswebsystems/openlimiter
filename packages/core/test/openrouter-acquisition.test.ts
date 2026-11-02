import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openrouterSpec } from "../src/acquire/providers.js";
import { runAcquisition } from "../src/acquire/runner.js";
import { parseOpenrouterPayload } from "../../connectors/src/openrouter.js";

const now = "2026-11-02T12:00:00.000Z";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

const keyBody = { data: { limit: null, limit_remaining: null, usage: 1 } };
const creditsBody = { data: { total_credits: 20, total_usage: 19.36 } };

async function read(replies: Record<string, { status: number; body: unknown; raw?: string; retry?: number }>) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "openrouter-synthetic-"));
  directories.push(stateDirectory);
  const sent: string[] = [];
  const result = await runAcquisition([openrouterSpec(parseOpenrouterPayload)], {
    now, stateDirectory, schedule: {},
    readCredential: async () => ({ ok: true as const, credential: { secret: "synthetic-key", accountId: null, expiresAtMilliseconds: null, origin: "operating_system" as const } }),
    transport: async (request: { endpoint?: unknown }) => {
      const endpoint = String(request.endpoint ?? "unknown");
      sent.push(endpoint);
      const reply = replies[endpoint] ?? { status: 500, body: {} };
      return { status: reply.status, body: reply.raw ?? JSON.stringify(reply.body), retryAfterSeconds: reply.retry ?? null };
    }
  } as unknown as Parameters<typeof runAcquisition>[1]);
  const report = result.reports[0];
  const meters = report?.ok === true
    ? report.snapshots.map((snapshot) => [snapshot.meter, snapshot.availability ?? "measured"])
    : [];
  return { result, sent, meters };
}

describe("OpenRouter read: key report then the optional credit report", () => {
  it("shows the measured credit beside the key row when both answer", async () => {
    const { result, sent, meters } = await read({
      openrouter_key: { status: 200, body: keyBody },
      openrouter_credits: { status: 200, body: creditsBody }
    });
    expect(sent).toEqual(["openrouter_key", "openrouter_credits"]);
    expect(result.reports[0]).toMatchObject({ ok: true });
    expect(meters).toEqual(expect.arrayContaining([["KEY_LIMIT", "unlimited"], ["ACCOUNT_BALANCE", "measured"]]));
  });

  it("keeps the key row and its schedule when the credit report is refused", async () => {
    const { result, meters } = await read({
      openrouter_key: { status: 200, body: keyBody },
      openrouter_credits: { status: 403, body: {} }
    });
    expect(result.reports[0]).toMatchObject({ ok: true });
    expect(meters).toEqual(expect.arrayContaining([["KEY_LIMIT", "unlimited"], ["ACCOUNT_BALANCE", "missing_credentials"]]));
    expect(result.schedule["OPENROUTER"]?.outcome).toBe("ok");
  });

  it("ignores the retry hint of a credit report that is not JSON", async () => {
    const plain = await read({
      openrouter_key: { status: 200, body: keyBody },
      openrouter_credits: { status: 200, body: creditsBody }
    });
    const broken = await read({
      openrouter_key: { status: 200, body: keyBody },
      openrouter_credits: { status: 200, body: null, raw: "not json", retry: 86_400 }
    });
    expect(broken.result.reports[0]).toMatchObject({ ok: true });
    expect(broken.result.schedule["OPENROUTER"]?.nextAttemptAt)
      .toBe(plain.result.schedule["OPENROUTER"]?.nextAttemptAt);
  });

  it("still fails the read, without asking for credit, when the key report fails", async () => {
    const { result, sent } = await read({ openrouter_key: { status: 500, body: {} } });
    expect(sent).toEqual(["openrouter_key"]);
    expect(result.reports.some((report) => report.ok)).toBe(false);
  });
});
