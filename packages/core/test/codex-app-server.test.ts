import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_CLIENT_INFO,
  readCodexRateLimits
} from "../src/index.js";

const fixture = path.resolve(
  "packages", "core", "test", "fixtures", "fake-codex-app-server.mjs"
);

describe("Codex documented app server acquisition", () => {
  it("initializes and reads rate limits over JSONL stdio", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: { ...process.env, OPENLIMITER_FAKE_CODEX_SCENARIO: "success" },
      timeoutMilliseconds: 2_000
    });

    expect(CODEX_APP_SERVER_CLIENT_INFO).toEqual({
      name: "openlimiter",
      title: "OpenLimiter",
      version: "2.0.3"
    });
    expect(result).toMatchObject({
      ok: true,
      /* Baseline 342f8cc hashes tokens.account_id with the Codex slug and a
         zero separator. This literal freezes that byte exact identity. */
      accountId: "codex-824c7eddd1cf39d1d49b3ee8",
      payload: { rateLimits: { limitId: "codex" } }
    });
  });

  it("maps the documented signed out error without returning a payload", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: { ...process.env, OPENLIMITER_FAKE_CODEX_SCENARIO: "signed-out" },
      timeoutMilliseconds: 2_000
    });
    expect(result).toEqual({ ok: false, reason: "needs_sign_in" });
  });

  it("negotiates the experimental workspace routing identity fallback", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: { ...process.env, OPENLIMITER_FAKE_CODEX_SCENARIO: "workspace-identity" },
      timeoutMilliseconds: 2_000
    });
    expect(result).toMatchObject({
      ok: true,
      accountId: "codex-65878ca2f14631a3af09adc7"
    });
  });

  it("returns successful limits with no invented identity when both fields are absent", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: { ...process.env, OPENLIMITER_FAKE_CODEX_SCENARIO: "missing-identity" },
      timeoutMilliseconds: 2_000
    });
    expect(result).toMatchObject({ ok: true, accountId: null });
  });

  it("settles stdin EPIPE when the child exits before reading", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: { ...process.env, OPENLIMITER_FAKE_CODEX_SCENARIO: "exit-before-read" },
      timeoutMilliseconds: 2_000
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports a missing binary as unavailable", async () => {
    const result = await readCodexRateLimits({
      executable: path.join(path.dirname(fixture), "missing-codex-binary"),
      timeoutMilliseconds: 200
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("kills and reports an app server that exceeds the deadline", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: { ...process.env, OPENLIMITER_FAKE_CODEX_SCENARIO: "timeout" },
      timeoutMilliseconds: 100
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});
