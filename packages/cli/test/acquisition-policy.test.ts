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
