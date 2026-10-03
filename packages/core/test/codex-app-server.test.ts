import { readFileSync } from "node:fs";
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
  const sandbox = process.env["OPENLIMITER_TEST_SANDBOX"];
  if (sandbox === undefined) throw new Error("missing test sandbox");
  return {
    ...process.env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    LOCALAPPDATA: sandbox,
    APPDATA: sandbox,
    TMP: sandbox,
    TEMP: sandbox,
    TMPDIR: sandbox,
    XDG_STATE_HOME: sandbox,
    XDG_CONFIG_HOME: sandbox,
    XDG_CACHE_HOME: sandbox,
    XDG_DATA_HOME: sandbox,
    XDG_RUNTIME_DIR: sandbox,
    OPENLIMITER_FAKE_CODEX_SCENARIO: scenario
  };
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
      version: (JSON.parse(readFileSync(path.join(process.cwd(), "packages/core/package.json"), "utf8")) as { version: string }).version
    });
    expect(result).toMatchObject({
      ok: true,
      payload: { accountId: "synthetic-chatgpt-account", rateLimits: { limitId: "codex" } }
    });
  });

  it.each(["missing-identity", "null-identity"])(
    "accepts %s for the already resolved home",
    async (scenario) => {
      const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
        environment: environment(scenario),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 2_000
      });
      expect(result).toMatchObject({ ok: true });
    }
  );

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

  it.each(["signed-out", "signed-out-codex"])("maps the %s error", async (scenario) => {
    const result = await readCodexRateLimits({
      executable: process.execPath,
      argumentsPrefix: [fixture],
      environment: environment(scenario),
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

  it("reports a missing binary distinctly", async () => {
    const result = await readCodexRateLimits({
      executable: path.join(path.dirname(fixture), "missing-codex-binary"),
      environment: environment("missing-executable"),
      codexHome: home,
      expectedAccountId,
      timeoutMilliseconds: 200
    });
    expect(result).toEqual({ ok: false, reason: "missing_executable" });
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
