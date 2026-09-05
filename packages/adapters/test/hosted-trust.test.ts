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
  realpath,
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
  windowsTrustIsOwnerOnly,
  type HostedContextEnvelope,
  type HostedTrustDocument,
  type WindowsTrustSecurityProbe
} from "../src/index.js";

const NOW = "2026-09-01T12:05:00.000Z";
/* The temp root in canonical form, which is the form the product compares
   against. macOS keeps its temp directory behind a symbolic link (/var is
   /private/var) and the GitHub Windows runner names its own with an 8.3 short
   name; the product refuses both as a link in a protected path, so every
   fixture starts from the canonical spelling and proves the same thing on
   every operating system. */
let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

/* Trust files are laid out for the host this suite runs on. A Windows layout
   under a Unix home is a backslash string that Unix reads as one file name in
   the working directory: it wrote junk into the checkout, and the loader then
   passed against a file that was never where the test claimed it was. */
const HOST_PLATFORM = process.platform;

/*
 * Recorded Windows security descriptors.
 *
 * Every account identifier below is fabricated. The shapes are the ones
 * Get-Acl returns on Windows 11: a protected owner only descriptor, the
 * inherited descriptor an ordinary file carries, a descriptor owned by
 * another account, and one that keeps the owner but readmits a second
 * principal. No test reads the security of a real file.
 */
const OWNER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OWNER_ONLY_DESCRIPTOR = "O:" + OWNER_SID + "G:" + OWNER_SID +
  "D:PAI(A;;FA;;;" + OWNER_SID + ")";
const INHERITED_DESCRIPTOR = "O:" + OWNER_SID + "G:" + OWNER_SID +
  "D:AI(A;ID;0x1301bf;;;S-1-5-21-4444444444-5555555555-6666666666-7777777777)" +
  "(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;" + OWNER_SID + ")";
const FOREIGN_OWNER_DESCRIPTOR = "O:S-1-5-18G:" + OWNER_SID +
  "D:PAI(A;;FA;;;" + OWNER_SID + ")";
const SHARED_DESCRIPTOR = "O:" + OWNER_SID + "G:" + OWNER_SID +
  "D:PAI(A;;FA;;;" + OWNER_SID + ")(A;;FA;;;S-1-5-32-544)";
const DENY_DESCRIPTOR = "O:" + OWNER_SID + "G:" + OWNER_SID +
  "D:PAI(A;;FA;;;" + OWNER_SID + ")(D;;FW;;;" + OWNER_SID + ")";

function recordedSecurity(descriptor: string): WindowsTrustSecurityProbe {
  return async () => ({
    currentUserSid: OWNER_SID,
    securityDescriptor: descriptor
  });
}

const ownerOnlySecurity = recordedSecurity(OWNER_ONLY_DESCRIPTOR);

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
  const home = await mkdtemp(path.join(await scratchRoot(), "openlimiter-hosted-trust-"));
  created.push(home);
  return home;
}

/* Owner only modes throughout, so on a POSIX host the document is the only
   thing under test; on Windows the recorded descriptor plays that part. */
async function writeTrust(
  home: string,
  document: HostedTrustDocument | string,
  platform: NodeJS.Platform = HOST_PLATFORM
): Promise<string> {
  const file = hostedTrustFilePath(platform, home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(
    file,
    typeof document === "string" ? document : JSON.stringify(document),
    { encoding: "utf8", mode: 0o600 }
  );
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
      platform: HOST_PLATFORM,
      now: NOW,
      /* Consulted on Windows alone; a POSIX host reads the file's own mode. */
      windowsSecurity: ownerOnlySecurity,
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
      await writeTrust(home, contents);
      await expect(loadHostedContextTrust({
        homeDirectory: home,
        platform: HOST_PLATFORM,
        now: NOW,
        windowsSecurity: ownerOnlySecurity,
        pinnedPublicKeys: { "context-fixture-1": key }
      })).resolves.toBeUndefined();
    }
    const missing = await temporaryHome();
    await expect(loadHostedContextTrust({
      homeDirectory: missing,
      platform: HOST_PLATFORM,
      now: NOW,
      windowsSecurity: ownerOnlySecurity,
      pinnedPublicKeys: { "context-fixture-1": key }
    })).resolves.toBeUndefined();
  });

  it("rejects a junction anywhere in the desktop trust path", async () => {
    /* A home of its own, and the link sits exactly where the trust directory
       belongs in the host's layout: a junction on Windows, a symbolic link
       elsewhere. The document behind it is owner only and is the one that
       loads two tests up, so the link is the only reason left for a refusal. */
    const fixture = await golden();
    const home = await temporaryHome();
    const outside = await temporaryHome();
    const file = hostedTrustFilePath(HOST_PLATFORM, home);
    await mkdir(path.dirname(path.dirname(file)), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(outside, path.basename(file)),
      JSON.stringify(fixture.trust_document),
      { encoding: "utf8", mode: 0o600 }
    );
    await symlink(outside, path.dirname(file), HOST_PLATFORM === "win32" ? "junction" : "dir");
    await expect(loadHostedContextTrust({
      homeDirectory: home,
      platform: HOST_PLATFORM,
      now: NOW,
      windowsSecurity: ownerOnlySecurity,
      pinnedPublicKeys: { "context-fixture-1": publicKey(fixture) }
    })).resolves.toBeUndefined();
  });

  it.runIf(HOST_PLATFORM === "win32")(
    "refuses Windows trust that is not owned by the current user alone",
    async () => {
      /* The probe is wired in on Windows alone, so this runs where the probe
         runs. The descriptor grammar it leans on is proved for every host in
         the next test, and the POSIX ownership rule has its own test below. */
      const fixture = await golden();
      for (const windowsSecurity of [
        recordedSecurity(INHERITED_DESCRIPTOR),
        recordedSecurity(FOREIGN_OWNER_DESCRIPTOR),
        recordedSecurity(SHARED_DESCRIPTOR),
        recordedSecurity(DENY_DESCRIPTOR),
        recordedSecurity("O:" + OWNER_SID + "G:" + OWNER_SID + "D:NO_ACCESS_CONTROL"),
        recordedSecurity("O:" + OWNER_SID + "G:" + OWNER_SID + "D:P"),
        recordedSecurity("not a security descriptor"),
        (async () => null) as WindowsTrustSecurityProbe,
        (async () => {
          throw new Error("probe failure");
        }) as WindowsTrustSecurityProbe
      ]) {
        const home = await temporaryHome();
        await writeTrust(home, fixture.trust_document);
        await expect(loadHostedContextTrust({
          homeDirectory: home,
          platform: "win32",
          now: NOW,
          windowsSecurity,
          pinnedPublicKeys: { "context-fixture-1": publicKey(fixture) }
        })).resolves.toBeUndefined();
      }
    }
  );

  it("reads owner and access control out of a recorded security descriptor", () => {
    expect(windowsTrustIsOwnerOnly({
      currentUserSid: OWNER_SID,
      securityDescriptor: OWNER_ONLY_DESCRIPTOR
    })).toBe(true);
    for (const securityDescriptor of [
      INHERITED_DESCRIPTOR,
      FOREIGN_OWNER_DESCRIPTOR,
      SHARED_DESCRIPTOR,
      DENY_DESCRIPTOR,
      "O:" + OWNER_SID + "G:" + OWNER_SID + "D:NO_ACCESS_CONTROL",
      "O:" + OWNER_SID + "G:" + OWNER_SID + "D:P",
      "O:" + OWNER_SID + "G:" + OWNER_SID + "D:P(A;ID;FA;;;" + OWNER_SID + ")",
      "O:" + OWNER_SID + "G:" + OWNER_SID + "D:PAI(A;;FA;;;" + OWNER_SID,
      "D:PAI(A;;FA;;;" + OWNER_SID + ")",
      ""
    ]) {
      expect(windowsTrustIsOwnerOnly({
        currentUserSid: OWNER_SID,
        securityDescriptor
      })).toBe(false);
    }
    expect(windowsTrustIsOwnerOnly({
      currentUserSid: "not-a-sid",
      securityDescriptor: OWNER_ONLY_DESCRIPTOR
    })).toBe(false);
  });

  it.runIf(HOST_PLATFORM !== "win32")(
    "rejects group-readable trust on platforms with POSIX ownership",
    async () => {
      const fixture = await golden();
      const home = await temporaryHome();
      const file = await writeTrust(home, fixture.trust_document);
      await chmod(file, 0o640);
      await expect(loadHostedContextTrust({
        homeDirectory: home,
        platform: HOST_PLATFORM,
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
