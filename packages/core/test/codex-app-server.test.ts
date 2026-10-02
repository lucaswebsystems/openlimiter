import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_CLIENT_INFO,
  opaqueAccountId,
  readCodexRateLimits
} from "../src/index.js";

const fixture = path.resolve(
  "packages", "core", "test", "fixtures", "fake-codex-app-server.mjs"
);
const home = path.resolve("packages", "core", "test", "fixtures", "synthetic-codex-home");
const expectedAccountId = opaqueAccountId("CODEX", "synthetic-chatgpt-account");

function environment(scenario: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENLIMITER_FAKE_CODEX_SCENARIO: scenario };
}

describe("Codex documented app server acquisition", () => {
  it("initializes and reads rate limits over JSONL stdio", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: environment("success"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 2_000
    });
    expect(CODEX_APP_SERVER_CLIENT_INFO).toEqual({
      name: "openlimiter",
      title: "OpenLimiter",
      version: "2.0.3"
    });
    expect(result).toMatchObject({
      ok: true,
      payload: { accountId: "synthetic-chatgpt-account", rateLimits: { limitId: "codex" } }
    });
  });

  it("accepts an absent response account id for the already resolved home", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: environment("missing-identity"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 2_000
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("refuses a response belonging to another account", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: environment("identity-mismatch"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 2_000
    });
    expect(result).toEqual({ ok: false, reason: "identity_mismatch" });
  });

  it("maps the documented signed out error", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: environment("signed-out"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 2_000
    });
    expect(result).toEqual({ ok: false, reason: "needs_sign_in" });
  });

  it("settles stdin errors when the child exits before reading", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: environment("exit-before-read"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 2_000
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports a missing binary as unavailable", async () => {
    const result = await readCodexRateLimits({
      executable: path.join(path.dirname(fixture), "missing-codex-binary"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 200
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("kills and reports an app server that exceeds the deadline", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: environment("timeout"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 100
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("maps an app server protocol error separately from sign out", async () => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: environment("protocol-error"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 2_000
    });
    expect(result).toEqual({ ok: false, reason: "protocol" });
  });
});
