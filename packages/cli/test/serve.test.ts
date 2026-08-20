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
      unknown: ["OPENROUTER", "ANTIGRAVITY", "GEMINI_CLI", "OPENCODE", "MANUAL"]
    });
    /* Nothing from the snapshot beyond those four fields ever leaves. */
    const text = JSON.stringify(document);
    for (const leaked of ["labels", "source", "credentialOrigin", "meter", "expiresAt"]) {
      expect(text.includes(leaked)).toBe(false);
    }
  });

  it("answers the quota route for a bearer token in the header", async () => {
    const handle = await serve(await seededDirectory());
    const response = await fetch(base(handle) + "/quota.json", {
      headers: { authorization: "Bearer " + handle.token }
    });
    expect(response.status).toBe(200);
    const document = await response.json() as { reason: string };
    expect(document.reason).toBe("NEAR_CAP");
  });

  it("refuses every data route without the token", async () => {
    const handle = await serve(await seededDirectory());
    for (const route of ["/quota.json", "/anything"]) {
      const response = await fetch(base(handle) + route);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "token_required" });
    }
  });

  it.each([
    ["an empty bearer value", "Bearer "],
    ["a bare token with no scheme", "TOKEN_HERE"],
    ["the wrong scheme", "Basic TOKEN_HERE"],
    ["a scheme and nothing else", "Bearer"]
  ])("refuses an Authorization header that is %s", async (_name, header) => {
    const handle = await serve(await seededDirectory());
    const response = await fetch(base(handle) + "/quota.json", {
      headers: { authorization: header.replace("TOKEN_HERE", handle.token) }
    });
    expect(response.status).toBe(401);
  });

  it("does not let a header claim override the token it presents", async () => {
    const handle = await serve(await seededDirectory());
    /* A wrong header is a wrong answer. It never falls through to the query
       fallback, or a caller could smuggle a token past a header check. */
    const response = await fetch(
      base(handle) + "/quota.json?" + TOKEN_PARAMETER + "=" + handle.token,
      { headers: { authorization: "Bearer not-the-token" } }
    );
    expect(response.status).toBe(401);
  });

  it("still accepts the query token for one release of compatibility", async () => {
    const handle = await serve(await seededDirectory());
    const response = await fetch(
      base(handle) + "/quota.json?" + TOKEN_PARAMETER + "=" + handle.token
    );
    expect(response.status).toBe(200);
  });

  it("refuses a token that is close but not equal", async () => {
    const handle = await serve(await seededDirectory());
    const wrong = handle.token.slice(0, -1) + (handle.token.endsWith("a") ? "b" : "a");
    const response = await fetch(base(handle) + "/quota.json", {
      headers: { authorization: "Bearer " + wrong }
    });
    expect(response.status).toBe(401);
  });

  it("serves the empty page shell on the root route without a token", async () => {
    const handle = await serve(await seededDirectory());
    /* The token is in the fragment, which never reaches a server, so the shell
       has to be reachable without one. It must therefore hold no data. */
    const response = await fetch(base(handle) + "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>OpenLimiter quota</title>");
    expect(html).toContain("noindex");
    /* The page reaches nothing but its own origin. */
    expect(html.includes("http://")).toBe(false);
    expect(html.includes("https://")).toBe(false);
    /* And it carries neither the token nor a single reading. The field names
       and reason codes the script draws with are markup, not data, so what is
       asserted here is the absence of values that could only come from the
       cache: a provider code, a percentage, an observed instant. */
    expect(html.includes(handle.token)).toBe(false);
    for (const leaked of ["CLAUDE", "CODEX", FIXTURE_NOW, '"fresh"']) {
      expect(html.includes(leaked)).toBe(false);
    }
  });

  it("moves the token out of the address and into a header", async () => {
    const handle = await serve(await seededDirectory());
    const html = await (await fetch(base(handle) + "/")).text();
    expect(html).toContain("history.replaceState(null, \"\", location.pathname)");
    expect(html).toContain("sessionStorage.setItem(key, token)");
    expect(html).toContain('"authorization": "Bearer " + token');
    /* Nothing in the page appends a token to a URL any more. */
    expect(html.includes("/quota.json?")).toBe(false);
  });

  it("bootstraps an address printed by an older build, then scrubs it", async () => {
    const handle = await serve(await seededDirectory());
    /* An older build printed the token in the query. That address still opens
       this page, so the page has to accept it once and then wipe it, rather
       than sit at 401 with the token on display in the address bar. */
    const response = await fetch(
      base(handle) + "/?" + TOKEN_PARAMETER + "=" + handle.token
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("new URLSearchParams(location.search).get(name)");
    expect(html).toContain("location.hash.indexOf(prefix)");
    /* The query is read first, the fragment second, storage last. */
    const queryAt = html.indexOf("URLSearchParams(location.search)");
    const hashAt = html.indexOf("location.hash.indexOf(prefix)");
    const storageAt = html.indexOf("sessionStorage.getItem(key)");
    expect(queryAt).toBeGreaterThan(-1);
    expect(hashAt).toBeGreaterThan(queryAt);
    expect(storageAt).toBeGreaterThan(hashAt);
    /* Reading the address at runtime is not the same as embedding a token:
       the served bytes are identical whether a token was in the URL or not. */
    expect(html.includes(handle.token)).toBe(false);
    expect(html).toBe(await (await fetch(base(handle) + "/")).text());
  });

  it("prints an address whose token is in the fragment, never the query", async () => {
    const handle = await serve(await seededDirectory());
    for (const address of [handle.url, handle.localUrl]) {
      expect(address).toContain("/#" + TOKEN_PARAMETER + "=" + handle.token);
      expect(address.includes("?")).toBe(false);
      const parsed = new URL(address);
      expect(parsed.search).toBe("");
      expect(parsed.pathname).toBe("/");
      expect(parsed.hash).toBe("#" + TOKEN_PARAMETER + "=" + handle.token);
    }
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
      unknown: [
        "CLAUDE",
        "OPENROUTER",
        "CODEX",
        "ANTIGRAVITY",
        "GEMINI_CLI",
        "OPENCODE",
        "MANUAL"
      ]
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
    expect(result.stdout).toContain("#" + TOKEN_PARAMETER + "=" + started.token);
    expect(result.stdout).toContain("Read only");
    expect(result.stdout).toContain("trusted home or office network");
    /* The two things the banner has to say plainly: the code is the key, and
       the bind is every interface, so forwarding the port is on the reader. */
    expect(result.stdout).toContain("anyone who can see this screen");
    expect(result.stdout).toContain("do not port forward this port");
    expect(result.stdout).toContain("listens on every interface");
    /* No printed address carries the token in a query string. */
    expect(result.stdout.includes("?" + TOKEN_PARAMETER + "=")).toBe(false);
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
