import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACQUISITION_CLIENT_VERSION,
  ANTIGRAVITY_CREDENTIAL_TARGET,
  codeAssistLoadRequest,
  createFetchTransport,
  validAcquisitionRequest,
  CREDENTIAL_FAILURE_SENTENCE,
  CREDENTIAL_TARGET_PATTERN,
  GROK_PREFERRED_ISSUER,
  OPENLIMITER_USER_AGENT,
  claudeUsageRequest,
  codeAssistQuotaRequest,
  codexUsageRequest,
  credentialCandidatePaths,
  credentialReadScript,
  decodeCredentialOutput,
  expiryMilliseconds,
  grokBillingRequest,
  kimiUsageRequest,
  openrouterKeyRequest,
  readAcquisitionCredential,
  readCredentialDocument,
  readWindowsCredentialWith
} from "../src/index.js";

/* A token shaped string that belongs to no account anywhere. Every assertion
   below compares against this constant rather than printing it. */
const SYNTHETIC_TOKEN = "synthetic-access-token-0000";

let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), "openlimiter-cred-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("acquisition identity", () => {
  it("states one honest user agent and never a vendor's", () => {
    expect(OPENLIMITER_USER_AGENT).toBe(
      "OpenLimiter/" + ACQUISITION_CLIENT_VERSION + " (+https://openlimiter.com)"
    );
    for (const request of [
      claudeUsageRequest(SYNTHETIC_TOKEN),
      codexUsageRequest(SYNTHETIC_TOKEN, "acct-1"),
      grokBillingRequest(SYNTHETIC_TOKEN, "user-1"),
      codeAssistLoadRequest(SYNTHETIC_TOKEN),
      kimiUsageRequest(SYNTHETIC_TOKEN),
      openrouterKeyRequest(SYNTHETIC_TOKEN),
      codeAssistQuotaRequest(SYNTHETIC_TOKEN, "managed-project-123")
    ]) {
      expect(request).not.toBeNull();
      const agent = request?.headers["user-agent"];
      expect(agent).toBe(OPENLIMITER_USER_AGENT);
      expect(agent).not.toMatch(/claude-code|codex-cli|antigravity|gemini/iu);
    }
  });

  it("names no vendor's own client on any request", () => {
    const grok = grokBillingRequest(SYNTHETIC_TOKEN, "user-1");
    /* xAI's own tool sends x-xai-token-auth: xai-grok-cli beside the token, and
       that value names the vendor's tool the way a copied user agent does. We
       identify as OpenLimiter and take whatever that costs. */
    expect(Object.keys(grok?.headers ?? {})).not.toContain("x-xai-token-auth");
    expect(JSON.stringify(grok)).not.toContain("grok-cli");
    expect(grok?.headers["x-userid"]).toBe("user-1");
    for (const request of [
      claudeUsageRequest(SYNTHETIC_TOKEN),
      codexUsageRequest(SYNTHETIC_TOKEN, "acct-1"),
      grok,
      kimiUsageRequest(SYNTHETIC_TOKEN),
      codeAssistLoadRequest(SYNTHETIC_TOKEN)
    ]) {
      expect(request).not.toBeNull();
      expect(validAcquisitionRequest(request!)).toBe(true);
    }
  });

  it("refuses at the boundary anything the closed table did not describe", () => {
    const good = kimiUsageRequest(SYNTHETIC_TOKEN);
    expect(good).not.toBeNull();
    const tampered = [
      { ...good!, url: "https://example.invalid/usage" },
      { ...good!, method: "POST" as const },
      {
        ...good!,
        headers: { ...good!.headers, "user-agent": "claude-code/2.1.0" }
      },
      { ...good!, headers: { ...good!.headers, cookie: "session=1" } }
    ];
    for (const request of tampered) {
      expect(validAcquisitionRequest(request)).toBe(false);
    }
    /* The transport refuses before it reaches the network, and says nothing
       about what it refused. */
    const transport = createFetchTransport(async () => {
      throw new Error("the network must not be reached");
    });
    return expect(transport(tampered[0]!)).rejects.toThrow(
      /acquisition contract/u
    );
  });

  it("refuses a header value that is not what that header may hold", () => {
    const claude = claudeUsageRequest(SYNTHETIC_TOKEN);
    const codex = codexUsageRequest(SYNTHETIC_TOKEN, "acct-1");
    expect(claude).not.toBeNull();
    /* A name allowlist stops a cookie. It says nothing about an authorization
       header that is not a bearer token or a beta contract we never agreed. */
    for (const tampered of [
      { ...claude!, headers: { ...claude!.headers, authorization: "Basic abc" } },
      {
        ...claude!,
        headers: { ...claude!.headers, "anthropic-beta": "oauth-9999-01-01" }
      },
      { ...claude!, headers: { ...claude!.headers, accept: "text/html" } },
      {
        ...codex!,
        headers: { ...codex!.headers, "chatgpt-account-id": "../../etc/passwd" }
      },
      {
        ...claude!,
        headers: { ...claude!.headers, "content-type": "application/json" }
      }
    ]) {
      expect(validAcquisitionRequest(tampered)).toBe(false);
    }
  });

  it("refuses a body that is not the body that endpoint may carry", () => {
    const load = codeAssistLoadRequest(SYNTHETIC_TOKEN);
    const quota = codeAssistQuotaRequest(SYNTHETIC_TOKEN, "managed-project-123");
    const kimi = kimiUsageRequest(SYNTHETIC_TOKEN);
    expect(validAcquisitionRequest(load!)).toBe(true);
    expect(validAcquisitionRequest(quota!)).toBe(true);
    for (const tampered of [
      { ...load!, body: JSON.stringify({ metadata: { pluginType: "OTHER" } }) },
      { ...load!, body: null },
      {
        ...quota!,
        body: JSON.stringify({ project: "../secrets", userAgent: OPENLIMITER_USER_AGENT })
      },
      {
        ...quota!,
        body: JSON.stringify({ project: "p", userAgent: "claude-code/2.1.0" })
      },
      {
        ...quota!,
        body: JSON.stringify({
          project: "p",
          userAgent: OPENLIMITER_USER_AGENT,
          extra: 1
        })
      },
      { ...quota!, body: "not json at all" },
      /* A GET that grew a body is not something this product sends. */
      { ...kimi!, body: JSON.stringify({ anything: true }) }
    ]) {
      expect(validAcquisitionRequest(tampered)).toBe(false);
    }
  });

  it("refuses a secret that could inject a second header", () => {
    expect(claudeUsageRequest("good\r\nx-injected: 1")).toBeNull();
    expect(kimiUsageRequest("")).toBeNull();
    expect(codexUsageRequest(SYNTHETIC_TOKEN, "acct 1")).toBeNull();
  });

  it("refuses a project identifier the provider tried to make into a payload", () => {
    expect(codeAssistQuotaRequest(SYNTHETIC_TOKEN, "../../etc")).toBeNull();
    expect(codeAssistQuotaRequest(SYNTHETIC_TOKEN, "")).toBeNull();
    const request = codeAssistQuotaRequest(SYNTHETIC_TOKEN, "managed-project-123");
    expect(JSON.parse(request?.body ?? "null")).toEqual({
      project: "managed-project-123",
      userAgent: OPENLIMITER_USER_AGENT
    });
  });
});

describe("credential discovery", () => {
  it("honours each vendor's own home variable before the default path", () => {
    const options = {
      platform: "linux" as const,
      homeDirectory: "/home/person",
      environment: {
        CLAUDE_CONFIG_DIR: "/elsewhere/claude",
        CODEX_HOME: "/elsewhere/codex",
        GROK_HOME: "/elsewhere/grok",
        KIMI_CODE_HOME: "/elsewhere/kimi"
      }
    };
    expect(credentialCandidatePaths("CLAUDE", options)[0]).toBe(
      path.join("/elsewhere/claude", ".credentials.json")
    );
    expect(credentialCandidatePaths("CODEX", options)[0]).toBe(
      path.join("/elsewhere/codex", "auth.json")
    );
    expect(credentialCandidatePaths("GROK", options)[0]).toBe(
      path.join("/elsewhere/grok", "auth.json")
    );
    expect(credentialCandidatePaths("KIMI", options)[0]).toBe(
      path.join("/elsewhere/kimi", "credentials", "kimi-code.json")
    );
    expect(credentialCandidatePaths("GEMINI_CLI", options)).toContain(
      path.join("/home/person", ".gemini", "oauth_creds.json")
    );
  });

  it("names no path for the key this product stores itself", () => {
    expect(credentialCandidatePaths("OPENROUTER", {
      platform: "linux",
      homeDirectory: "/home/person",
      environment: {}
    })).toEqual([]);
  });

  it("reads each client's own nesting", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(readCredentialDocument(
      "CLAUDE",
      { claudeAiOauth: { accessToken: SYNTHETIC_TOKEN } },
      now
    )).toEqual({
      ok: true,
      credential: {
        secret: SYNTHETIC_TOKEN,
        accountId: null,
        expiresAtMilliseconds: null,
        origin: "vendor_file"
      }
    });
    expect(readCredentialDocument(
      "CODEX",
      { tokens: { access_token: SYNTHETIC_TOKEN, account_id: "acct-1" } },
      now
    )).toEqual({
      ok: true,
      credential: {
        secret: SYNTHETIC_TOKEN,
        accountId: "acct-1",
        expiresAtMilliseconds: null,
        origin: "vendor_file"
      }
    });
    const kimi = readCredentialDocument(
      "KIMI",
      { access_token: SYNTHETIC_TOKEN },
      now
    );
    expect(kimi.ok).toBe(true);
  });

  it("prefers the named issuer in a Grok file that holds several", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const result = readCredentialDocument("GROK", {
      "https://auth.other.example": { access_token: "wrong-one" },
      [GROK_PREFERRED_ISSUER]: {
        access_token: SYNTHETIC_TOKEN,
        user_id: "user-1"
      }
    }, now);
    expect(result).toEqual({
      ok: true,
      credential: {
        secret: SYNTHETIC_TOKEN,
        accountId: "user-1",
        expiresAtMilliseconds: null,
        origin: "vendor_file"
      }
    });
  });

  it("reports an expired login rather than sending it", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const result = readCredentialDocument("GEMINI_CLI", {
      access_token: SYNTHETIC_TOKEN,
      expiry_date: Date.parse("2025-12-31T23:00:00.000Z")
    }, now);
    expect(result).toEqual({ ok: false, reason: "expired" });
    expect(CREDENTIAL_FAILURE_SENTENCE.expired).toContain("refresh");
    expect(CREDENTIAL_FAILURE_SENTENCE.expired).not.toContain("-");
  });

  it("reads an expiry in seconds, in milliseconds and as a timestamp", () => {
    expect(expiryMilliseconds(1_800_000_000)).toBe(1_800_000_000_000);
    expect(expiryMilliseconds(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(expiryMilliseconds("2026-01-02T00:00:00.000Z")).toBe(
      Date.parse("2026-01-02T00:00:00.000Z")
    );
    expect(expiryMilliseconds("not a date")).toBeNull();
  });

  it("reads a real file and never repairs it", async () => {
    const directory = await temporaryDirectory();
    const claude = path.join(directory, ".claude");
    await mkdir(claude, { recursive: true });
    const file = path.join(claude, ".credentials.json");
    const document = JSON.stringify({
      claudeAiOauth: { accessToken: SYNTHETIC_TOKEN, expiresAt: 1_900_000_000_000 }
    });
    await writeFile(file, document, "utf8");
    const result = await readAcquisitionCredential("CLAUDE", {
      platform: "linux",
      homeDirectory: directory,
      environment: {},
      now: "2026-01-01T00:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    /* The bytes on disk are byte for byte what the client wrote. Reading a
       credential must never be a write of any kind. */
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(file, "utf8")).toBe(document);
  });

  it("says a provider is simply absent rather than broken", async () => {
    const directory = await temporaryDirectory();
    expect(await readAcquisitionCredential("CODEX", {
      platform: "linux",
      homeDirectory: directory,
      environment: {},
      now: "2026-01-01T00:00:00.000Z"
    })).toEqual({ ok: false, reason: "absent" });
  });

  it("says why the macOS keychain was not opened", async () => {
    const directory = await temporaryDirectory();
    expect(await readAcquisitionCredential("CLAUDE", {
      platform: "darwin",
      homeDirectory: directory,
      environment: {},
      now: "2026-01-01T00:00:00.000Z"
    })).toEqual({ ok: false, reason: "keychain_not_read" });
  });
});

describe("windows credential helper", () => {
  it("names the target the Antigravity client writes to", () => {
    expect(ANTIGRAVITY_CREDENTIAL_TARGET).toBe("gemini:antigravity");
    expect(CREDENTIAL_TARGET_PATTERN.test(ANTIGRAVITY_CREDENTIAL_TARGET)).toBe(true);
  });

  it("builds a script with no npm install step behind it", () => {
    const script = credentialReadScript(ANTIGRAVITY_CREDENTIAL_TARGET);
    expect(script).toContain("CredRead");
    expect(script).toContain(ANTIGRAVITY_CREDENTIAL_TARGET);
    /* Reading only. A write call in this script would be a change to somebody
       else's login, which this product never makes. */
    expect(script).not.toContain("CredWrite");
    expect(script).not.toContain("CredDelete");
  });

  it("refuses a target that could close the string it sits in", async () => {
    const result = await readWindowsCredentialWith("bad'target", {
      runCommand: async () => ({ ok: true, stdout: "" })
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("decodes what the helper printed, in either text encoding", () => {
    const envelope = JSON.stringify({ token: { access_token: SYNTHETIC_TOKEN } });
    expect(decodeCredentialOutput(
      Buffer.from(envelope, "utf8").toString("base64")
    )).toEqual({ ok: true, value: envelope });
    expect(decodeCredentialOutput(
      Buffer.from(envelope, "utf16le").toString("base64")
    )).toEqual({ ok: true, value: envelope });
    expect(decodeCredentialOutput("")).toEqual({ ok: false, reason: "absent" });
    expect(decodeCredentialOutput("not base64 !!")).toEqual({
      ok: false,
      reason: "unreadable"
    });
  });

  it("reads the Antigravity credential through the injected store", async () => {
    const directory = await temporaryDirectory();
    const envelope = JSON.stringify({
      token: { access_token: SYNTHETIC_TOKEN, token_type: "Bearer" }
    });
    const result = await readAcquisitionCredential("ANTIGRAVITY", {
      platform: "win32",
      homeDirectory: directory,
      environment: {},
      now: "2026-01-01T00:00:00.000Z",
      readWindowsCredential: async (target) => {
        expect(target).toBe(ANTIGRAVITY_CREDENTIAL_TARGET);
        return { ok: true, value: envelope };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.credential.secret : null).toBe(SYNTHETIC_TOKEN);
    /* Antigravity's own login, out of Antigravity's own store. */
    expect(result.ok ? result.credential.origin : null).toBe("vendor_store");
  });

  it("falls back to the Gemini file when the store holds nothing", async () => {
    const directory = await temporaryDirectory();
    await mkdir(path.join(directory, ".gemini"), { recursive: true });
    await writeFile(
      path.join(directory, ".gemini", "oauth_creds.json"),
      JSON.stringify({ access_token: SYNTHETIC_TOKEN }),
      "utf8"
    );
    const result = await readAcquisitionCredential("ANTIGRAVITY", {
      platform: "win32",
      homeDirectory: directory,
      environment: {},
      now: "2026-01-01T00:00:00.000Z",
      readWindowsCredential: async () => ({ ok: false, reason: "absent" })
    });
    expect(result.ok).toBe(true);
    /*
     * The fallback is kept, because the two share one Google Code Assist pool
     * and every honest reader does the same. What it must never do is call the
     * result Antigravity's own login, so the origin says which it was and the
     * row is filed under its own account label.
     */
    expect(result.ok ? result.credential.origin : null).toBe("shared_code_assist");
  });
});
