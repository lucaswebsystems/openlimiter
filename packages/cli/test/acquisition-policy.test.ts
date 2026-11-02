import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { readSnapshotCache } from "../../core/src/cache.js";

it("refresh honors a desktop lease, takes over at expiry, and retains the plan's capped server deadline across invocations", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "openlimiter-cli-policy-")));
  let current = Date.parse("2026-08-07T12:00:00.000Z");
  let calls = 0;
  const dependencies = {
    stateDirectory: dir, homeDirectory: dir,
    environment: { OPENLIMITER_OPENROUTER_KEY: "test-local-key" },
    now: () => new Date(current).toISOString(),
    acquisitionTransport: async () => { calls++; return { status: 429, body: "", retryAfterSeconds: 8 * 86400 }; }
  };
  try {
    await writeFile(path.join(dir, "acquisition-openrouter.json"), JSON.stringify({ owner: "desktop", expiresAt: current + 60000, nextAllowedAt: 0, attempts: 0, token: "desktop" }));
    expect((await runCli(["refresh"], dependencies)).exitCode).toBe(0);
    expect(calls).toBe(0);
    current += 60000;
    expect((await runCli(["refresh"], dependencies)).exitCode).toBe(0);
    expect(calls).toBe(1);
    const cache = await readSnapshotCache(dir);
    const deadline = current + 7 * 86400_000;
    expect(cache.ok && cache.snapshots.some((row) => row.availability === "rate_limited" && row.retryAt === new Date(deadline).toISOString())).toBe(true);
    current += 86400_000;
    expect((await runCli(["refresh"], dependencies)).exitCode).toBe(0);
    expect(calls).toBe(1);
    current = deadline - 1;
    expect((await runCli(["refresh"], dependencies)).exitCode).toBe(0);
    expect(calls).toBe(1);
    current = deadline;
    expect((await runCli(["refresh"], dependencies)).exitCode).toBe(0);
    expect(calls).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([
  [{ OPENROUTER_API_KEY: "standard-key" }, "standard-key"],
  [{ OPENLIMITER_OPENROUTER_KEY: "", OPENROUTER_API_KEY: "standard-key" }, "standard-key"],
  [{ OPENLIMITER_OPENROUTER_KEY: "own-key", OPENROUTER_API_KEY: "standard-key" }, "own-key"]
])("reads the OpenRouter key from the first non empty variable (%o)", async (environment, expected) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "openlimiter-cli-orkey-")));
  const sent: string[] = [];
  try {
    await runCli(["refresh"], {
      stateDirectory: dir, homeDirectory: dir, environment,
      now: () => "2026-11-02T12:00:00.000Z",
      acquisitionTransport: async (request: { headers?: Record<string, string> }) => {
        sent.push(request.headers?.["authorization"] ?? "");
        return { status: 500, body: "", retryAfterSeconds: null };
      }
    } as Parameters<typeof runCli>[1]);
    expect(sent[0]).toBe("Bearer " + expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
