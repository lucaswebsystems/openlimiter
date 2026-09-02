import {
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyLike
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOSTED_CONTEXT_LEVELS,
  HOSTED_CONTEXT_METERS,
  HOSTED_CONTEXT_PROVIDERS,
  HOSTED_CONTEXT_ROUTING_KINDS,
  HOSTED_CONTEXT_ROUTING_REASONS,
  canonicalHostedContext,
  hostedTrustFilePath,
  loadHostedContextTrust,
  validateHostedContextBytes,
  type HostedContextEnvelope,
  type HostedTrustDocument
} from "../src/index.js";

const NOW = "2026-09-01T12:05:00.000Z";
const created: string[] = [];

interface GoldenFixture {
  fixture_version: number;
  enum_contract: {
    providers: string[];
    meters: string[];
    levels: string[];
    routing_kinds: string[];
    routing_reasons: string[];
  };
  private_key_pkcs8_base64url: string;
  public_key_spki_base64url: string;
  public_key_raw_base64url: string;
  canonical_unsigned: string;
  envelope: HostedContextEnvelope;
  trust_document: HostedTrustDocument;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function golden(): Promise<GoldenFixture> {
  const text = await readFile(
    path.join(
      process.cwd(),
      "packages",
      "adapters",
      "test",
      "fixtures",
      "hosted-context-v1.golden.json"
    ),
    "utf8"
  );
  return JSON.parse(text) as GoldenFixture;
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openlimiter-hosted-trust-"));
  created.push(home);
  return home;
}

async function writeTrust(
  home: string,
  document: HostedTrustDocument,
  platform: NodeJS.Platform = "win32"
): Promise<string> {
  const file = hostedTrustFilePath(platform, home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(document), { encoding: "utf8", mode: 0o600 });
  return file;
}

function publicKey(fixture: GoldenFixture): KeyLike {
  return createPublicKey({
    key: Buffer.from(fixture.public_key_spki_base64url, "base64url"),
    format: "der",
    type: "spki"
  });
}

describe("protected hosted trust bridge", () => {
  it("uses fixed platform paths and accepts only an explicitly trusted native root", () => {
    expect(hostedTrustFilePath("win32", "C:\\Users\\fixture")).toBe(
      "C:\\Users\\fixture\\AppData\\Roaming\\OpenLimiter\\hosted-trust.json"
    );
    expect(hostedTrustFilePath("darwin", "/Users/fixture")).toBe(
      "/Users/fixture/Library/Application Support/OpenLimiter/hosted-trust.json"
    );
    expect(hostedTrustFilePath("linux", "/home/fixture")).toBe(
      "/home/fixture/.config/openlimiter/hosted-trust.json"
    );
    expect(hostedTrustFilePath("linux", "/home/fixture", "/mnt/config"))
      .toBe("/mnt/config/openlimiter/hosted-trust.json");
  });

  it("loads only desktop-selected ids from the application-pinned key set", async () => {
    const fixture = await golden();
    const home = await temporaryHome();
    await writeTrust(home, fixture.trust_document);
    const trust = await loadHostedContextTrust({
      homeDirectory: home,
      platform: "win32",
      now: NOW,
      pinnedPublicKeys: { "context-fixture-1": publicKey(fixture), unused: publicKey(fixture) }
    });
    expect(trust).toMatchObject({
      routingEnabled: true,
      accountId: "account-fixture",
      deviceId: "33333333-3333-4333-8333-333333333333",
      latestSequence: 42,
      greatestAcceptedRevocationEpoch: 7,
      currentHostedRevocationEpoch: 7
    });
    expect(Object.keys(trust?.publicKeys ?? {})).toEqual(["context-fixture-1"]);
    expect(validateHostedContextBytes(JSON.stringify(fixture.envelope), trust!))
      .toMatchObject({ ok: true });
  });

  it("turns missing, malformed, oversized, and unknown-key trust into zero trust", async () => {
    const fixture = await golden();
    const key = publicKey(fixture);
    for (const contents of [
      "{not-json",
      "x".repeat(16_385),
      JSON.stringify({ ...fixture.trust_document, extra: true }),
      JSON.stringify({
        ...fixture.trust_document,
        pinned_public_key_ids: ["unknown-key"]
      })
    ]) {
      const home = await temporaryHome();
      const file = hostedTrustFilePath("win32", home);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, "utf8");
      await expect(loadHostedContextTrust({
        homeDirectory: home,
        platform: "win32",
        now: NOW,
        pinnedPublicKeys: { "context-fixture-1": key }
      })).resolves.toBeUndefined();
    }
    const missing = await temporaryHome();
    await expect(loadHostedContextTrust({
      homeDirectory: missing,
      platform: "win32",
      now: NOW,
      pinnedPublicKeys: { "context-fixture-1": key }
    })).resolves.toBeUndefined();
  });

  it("rejects a junction anywhere in the desktop trust path", async () => {
    const fixture = await golden();
    const home = await temporaryHome();
    const outside = await temporaryHome();
    const file = hostedTrustFilePath("win32", home);
    await mkdir(path.dirname(path.dirname(file)), { recursive: true });
    await writeFile(path.join(outside, "hosted-trust.json"), JSON.stringify(fixture.trust_document));
    await symlink(outside, path.dirname(file), process.platform === "win32" ? "junction" : "dir");
    await expect(loadHostedContextTrust({
      homeDirectory: home,
      platform: "win32",
      now: NOW,
      pinnedPublicKeys: { "context-fixture-1": publicKey(fixture) }
    })).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "rejects group-readable trust on platforms with POSIX ownership",
    async () => {
      const fixture = await golden();
      const home = await temporaryHome();
      const file = await writeTrust(home, fixture.trust_document, process.platform);
      await chmod(file, 0o640);
      await expect(loadHostedContextTrust({
        homeDirectory: home,
        platform: process.platform,
        now: NOW,
        pinnedPublicKeys: { "context-fixture-1": publicKey(fixture) }
      })).resolves.toBeUndefined();
    }
  );
});

describe("cross implementation hosted context golden", () => {
  it("pins Pro enums, canonical JSON, Ed25519 signing, and trust schema", async () => {
    const fixture = await golden();
    expect(fixture.fixture_version).toBe(1);
    expect(fixture.enum_contract).toEqual({
      providers: [...HOSTED_CONTEXT_PROVIDERS],
      meters: [...HOSTED_CONTEXT_METERS],
      levels: [...HOSTED_CONTEXT_LEVELS],
      routing_kinds: [...HOSTED_CONTEXT_ROUTING_KINDS],
      routing_reasons: [...HOSTED_CONTEXT_ROUTING_REASONS]
    });
    const { signature: _signature, ...unsigned } = fixture.envelope;
    expect(canonicalHostedContext(unsigned)).toBe(fixture.canonical_unsigned);
    const privateKey = createPrivateKey({
      key: Buffer.from(fixture.private_key_pkcs8_base64url, "base64url"),
      format: "der",
      type: "pkcs8"
    });
    expect(sign(null, Buffer.from(fixture.canonical_unsigned), privateKey).toString("base64url"))
      .toBe(fixture.envelope.signature);
    expect(Buffer.from(fixture.public_key_raw_base64url, "base64url")).toHaveLength(32);
  });
});
