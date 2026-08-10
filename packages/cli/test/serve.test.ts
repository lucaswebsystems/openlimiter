import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW, claudeFixture, codexFixture } from "@openlimiter/connectors";
import {
  DEFAULT_SERVE_PORT,
  TOKEN_PARAMETER,
  isAllowedHostHeader,
  runCli,
  startQuotaServer,
  type QuotaServerHandle
} from "../src/index.js";

/**
 * Every test here talks to the server over a real socket, because the whole
 * point of this command is what an outside caller can and cannot get out of it.
 * Nothing is asserted against an internal function that a real request would
 * never reach.
 */

const directories: string[] = [];
const servers: QuotaServerHandle[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openlimiter-serve-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A state directory holding two providers, seeded through the real CLI. */
async function seededDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  for (const [provider, payload] of [
    ["claude", claudeFixture(FIXTURE_NOW)],
    ["codex", codexFixture(FIXTURE_NOW)]
  ] as const) {
    const result = await runCli(
      ["ingest", "--provider", provider, "--payload", JSON.stringify(payload)],
      { stateDirectory: directory, now: () => FIXTURE_NOW }
    );
    expect(result.exitCode).toBe(0);
  }
  return directory;
}

async function serve(directory: string): Promise<QuotaServerHandle> {
  const handle = await startQuotaServer({
    /* Loopback and an operating system port, so a test never opens a network
       listener and never collides with a port already in use. */
    host: "127.0.0.1",
    port: 0,
    stateDirectory: directory,
    now: () => FIXTURE_NOW
  });
  servers.push(handle);
  return handle;
}

function base(handle: QuotaServerHandle): string {
  return "http://127.0.0.1:" + String(handle.port);
}

describe("serve", () => {
  it("answers the quota route with the bounded advice fields and nothing else", async () => {
    const handle = await serve(await seededDirectory());
    const response = await fetch(
      base(handle) + "/quota.json?" + TOKEN_PARAMETER + "=" + handle.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const document: unknown = await response.json();
    expect(document).toEqual({
      schema: 1,
      generatedAt: FIXTURE_NOW,
      /* NEAR_CAP because the Codex fixture reads 84, which is the demo set's
         meter in the orange band and above the engine's own 80 threshold. */
      reason: "NEAR_CAP",
      providers: [
        { provider: "CLAUDE", state: "fresh", usagePercent: 64, resetAt: expect.any(String) },
        { provider: "CODEX", state: "fresh", usagePercent: 84, resetAt: expect.any(String) }
      ],
      unknown: ["OPENROUTER", "ANTIGRAVITY", "OPENCODE", "MANUAL"]
    });
    /* Nothing from the snapshot beyond those four fields ever leaves. */
    const text = JSON.stringify(document);
    for (const leaked of ["labels", "source", "credentialOrigin", "meter", "expiresAt"]) {
      expect(text.includes(leaked)).toBe(false);
    }
  });

  it("refuses every route without the token", async () => {
    const handle = await serve(await seededDirectory());
    for (const route of ["/", "/quota.json", "/anything"]) {
      const response = await fetch(base(handle) + route);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "token_required" });
    }
  });

  it("refuses a token that is close but not equal", async () => {
    const handle = await serve(await seededDirectory());
    const wrong = handle.token.slice(0, -1) + (handle.token.endsWith("a") ? "b" : "a");
    const response = await fetch(
      base(handle) + "/quota.json?" + TOKEN_PARAMETER + "=" + wrong
    );
    expect(response.status).toBe(401);
  });

  it("serves the mobile page on the root route", async () => {
    const handle = await serve(await seededDirectory());
    const response = await fetch(
      base(handle) + "/?" + TOKEN_PARAMETER + "=" + handle.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>OpenLimiter quota</title>");
    expect(html).toContain("noindex");
    /* The page reaches nothing but its own origin. */
    expect(html.includes("http://")).toBe(false);
    expect(html.includes("https://")).toBe(false);
  });

  it("refuses a request that carries any origin at all", async () => {
    const handle = await serve(await seededDirectory());
    const response = await fetch(
      base(handle) + "/quota.json?" + TOKEN_PARAMETER + "=" + handle.token,
      { headers: { origin: "https://attacker.example" } }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross_origin_refused" });
  });

  it("refuses a host header that is a name, which is what rebinding needs", async () => {
    const handle = await serve(await seededDirectory());
    /* The fetch API forbids setting Host, so this one goes over raw HTTP. */
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: handle.port,
        path: "/quota.json?" + TOKEN_PARAMETER + "=" + handle.token,
        headers: { host: "attacker.example:" + String(handle.port) }
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it("judges host headers without a socket", () => {
    expect(isAllowedHostHeader("127.0.0.1:7317", 7317)).toBe(true);
    expect(isAllowedHostHeader("192.168.1.20:7317", 7317)).toBe(true);
    expect(isAllowedHostHeader("localhost:7317", 7317)).toBe(true);
    expect(isAllowedHostHeader("[::1]:7317", 7317)).toBe(true);
    expect(isAllowedHostHeader("openlimiter.test:7317", 7317)).toBe(false);
    /* A matching name on a different port is still refused. */
    expect(isAllowedHostHeader("127.0.0.1:7318", 7317)).toBe(false);
    expect(isAllowedHostHeader(undefined, 7317)).toBe(false);
  });

  it("has no route that writes, and answers nothing but reads", async () => {
    const handle = await serve(await seededDirectory());
    const target = base(handle) + "/quota.json?" + TOKEN_PARAMETER + "=" + handle.token;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(target, { method });
      expect(response.status).toBe(405);
    }
    const unknown = await fetch(
      base(handle) + "/nothing?" + TOKEN_PARAMETER + "=" + handle.token
    );
    expect(unknown.status).toBe(404);
  });

  it("reports every provider unknown when there is no cache to read", async () => {
    const handle = await serve(await temporaryDirectory());
    const response = await fetch(
      base(handle) + "/quota.json?" + TOKEN_PARAMETER + "=" + handle.token
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: 1,
      generatedAt: FIXTURE_NOW,
      reason: "UNKNOWN",
      providers: [],
      unknown: ["CLAUDE", "OPENROUTER", "CODEX", "ANTIGRAVITY", "OPENCODE", "MANUAL"]
    });
  });

  it("gives every start a different token", async () => {
    const directory = await seededDirectory();
    const first = await serve(directory);
    const second = await serve(directory);
    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThanOrEqual(20);
  });

  it("prints an address, a code, and the safety notes", async () => {
    const directory = await seededDirectory();
    let handle: QuotaServerHandle | null = null;
    const result = await runCli(["serve", "--host", "127.0.0.1", "--port", "0"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      colorOutput: false,
      onListening: (started) => {
        handle = started;
        servers.push(started);
      }
    });
    expect(result.exitCode).toBe(0);
    expect(handle).not.toBeNull();
    const started = handle as unknown as QuotaServerHandle;
    expect(result.stdout).toContain(started.url);
    expect(result.stdout).toContain(TOKEN_PARAMETER + "=" + started.token);
    expect(result.stdout).toContain("Read only");
    expect(result.stdout).toContain("trusted home or office network");
    /* The block characters are the QR symbol itself. */
    expect(result.stdout).toContain("█");
  });

  it("can be asked to leave the code out", async () => {
    const result = await runCli(
      ["serve", "--host", "127.0.0.1", "--port", "0", "--no-qr"],
      {
        stateDirectory: await seededDirectory(),
        now: () => FIXTURE_NOW,
        colorOutput: false,
        onListening: (started) => servers.push(started)
      }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("█");
  });

  it("rejects a port that is not a port", async () => {
    for (const value of ["not-a-port", "-1", "70000", "7317.5"]) {
      const result = await runCli(["serve", "--port", value]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("port");
    }
    expect((await runCli(["serve", "--port"])).exitCode).toBe(2);
    expect((await runCli(["serve", "--host"])).exitCode).toBe(2);
  });

  it("defaults to the documented port", () => {
    expect(DEFAULT_SERVE_PORT).toBe(7317);
  });

  it("names serve in the help output", async () => {
    const result = await runCli(["help"]);
    expect(result.stdout).toContain("openlimiter serve");
    expect(result.stdout).toContain("local network");
  });
});
