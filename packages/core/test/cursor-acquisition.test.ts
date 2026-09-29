import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cursorAccountId, cursorStatePath, readCursorSession } from "../src/acquire/cursor.js";
import { cursorUsageRequest, createFetchTransport, validAcquisitionRequest, retryAfterSeconds } from "../src/acquire/transport.js";
import { OPENLIMITER_USER_AGENT } from "../src/acquire/identity.js";
import { cursorSpec } from "../src/acquire/providers.js";
import { runAcquisition } from "../src/acquire/runner.js";
import { parseCursorPayload } from "../../connectors/src/cursor.js";

const directories: string[] = [];
const now = "2026-08-07T12:00:00.000Z";
const fixture = (name: string) => JSON.parse(readFileSync(path.resolve("packages/connectors/fixtures/cases/cursor", name + ".json"), "utf8")) as { status: number; headers: Record<string, string>; body: unknown };
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const result = await mkdtemp(path.join(tmpdir(), "cursor-synthetic-")); directories.push(result); return result; }

describe("Cursor local acquisition", () => {
  it("reads the committed WAL in place without changing database or WAL bytes", async () => {
    const file = path.join(await directory(), "state.vscdb");
    const writer = new DatabaseSync(file);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)");
      const insert = writer.prepare("INSERT INTO ItemTable VALUES (?, ?)");
      insert.run("cursorAuth/accessToken", "synthetic-token");
      insert.run("cursorAuth/stripeMembershipAuthId", "synthetic-auth");
      const before = await readFile(file);
      const wal = await readFile(file + "-wal");
      expect(await readCursorSession(file, Date.parse(now))).toMatchObject({ ok: true, credential: { accountId: "synthetic-auth", secret: "synthetic-token" } });
      expect(await readFile(file)).toEqual(before);
      expect(await readFile(file + "-wal")).toEqual(wal);
    } finally { writer.close(); }
  });

  it("does not create a missing credential database", async () => {
    const file = path.join(await directory(), "state.vscdb");
    expect(await readCursorSession(file, Date.parse(now))).toEqual({ ok: false, reason: "absent" });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves only the selected platform profile", () => {
    const homeDirectory = path.join(tmpdir(), "synthetic-profile");
    expect(cursorStatePath({ homeDirectory, platform: "linux", environment: {} })).toBe(path.join(homeDirectory, ".config/Cursor/User/globalStorage/state.vscdb"));
    expect(cursorStatePath({ homeDirectory, platform: "darwin", environment: {} })).toBe(path.join(homeDirectory, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"));
    expect(cursorStatePath({ homeDirectory, platform: "win32", environment: { APPDATA: homeDirectory } })).toBe(path.join(homeDirectory, "Cursor/User/globalStorage/state.vscdb"));
    expect(cursorStatePath({ homeDirectory, platform: "win32", environment: {} })).toBeNull();
  });

  it("sends only the cookie pair to Cursor with an honest identity and rejects redirects", async () => {
    const request = cursorUsageRequest("synthetic-token", "synthetic-auth")!;
    expect(request.headers).toEqual({ "user-agent": OPENLIMITER_USER_AGENT, accept: "application/json", cookie: "WorkosCursorSessionToken=synthetic-auth::synthetic-token" });
    expect(validAcquisitionRequest(request)).toBe(true);
    expect(validAcquisitionRequest({ ...request, endpoint: "kimi_usage", url: "https://api.kimi.com/coding/v1/usages" })).toBe(false);
    expect(cursorUsageRequest("token;another=bad", "synthetic-auth")).toBeNull();
    const calls: RequestInit[] = [];
    const transport = createFetchTransport(async (_url, init) => { calls.push(init!); return new Response(null, { status: 302, headers: { location: "https://example.invalid" } }); });
    await transport(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe("error");
  });

  it.each(["normal", "near-limit", "over-limit", "team-overall", "team-over-limit", "zero", "partial", "unlimited", "expired-credential", "access-denied", "rate-limited", "schema-drift"])("runs %s through the shared policy", async name => {
    const item = fixture(name);
    const stateDirectory = await directory();
    let calls = 0;
    const options = {
      now, stateDirectory, schedule: {},
      readCredential: async () => ({ ok: true as const, credential: { secret: "synthetic-token", accountId: "synthetic-auth", expiresAtMilliseconds: null, origin: "vendor_file" as const } }),
      transport: async () => { calls++; return { status: item.status, body: JSON.stringify(item.body), retryAfterSeconds: retryAfterSeconds(item.headers["retry-after"] ?? null, Date.parse(now)) }; }
    };
    const result = await runAcquisition([cursorSpec(parseCursorPayload)], options);
    expect(calls).toBe(1);
    if (item.status === 401) expect(result.rows[0]).toMatchObject({ availability: "expired_credentials" });
    else if (item.status === 403) expect(result.rows[0]).toMatchObject({ availability: "access_denied" });
    else if (item.status === 429) {
      expect(result.schedule["CURSOR"]?.outcome).toBe("rate_limited");
      expect(Date.parse(result.schedule["CURSOR"]!.nextAttemptAt)).toBeGreaterThanOrEqual(Date.parse(now) + 120_000);
    } else if (name === "schema-drift") expect(result.reports.some(report => report.ok)).toBe(false);
    else expect(result.reports[0]).toMatchObject({ ok: true, accountId: cursorAccountId("synthetic-auth") });
    await runAcquisition([cursorSpec(parseCursorPayload)], { ...options, schedule: result.schedule });
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-token");
    expect(JSON.stringify(result)).not.toContain("synthetic-auth");
  });
});
