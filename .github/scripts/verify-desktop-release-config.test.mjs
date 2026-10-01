import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { updaterPlatforms, verifyManifest } from "./verify-desktop-release-config.mjs";

const workflow = readFileSync(new URL("../workflows/desktop-release.yml", import.meta.url), "utf8");

test("every release job checks out and verifies the selected tag", () => {
  const checkouts = workflow.match(/uses: actions\/checkout@/gu) ?? [];
  const selectedRefs = workflow.match(/ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/gu) ?? [];
  const sourceChecks = workflow.match(/name: Verify checked out release source/gu) ?? [];
  const commitChecks = workflow.match(/git rev-parse "\$RELEASE_TAG\^\{commit\}"/gu) ?? [];
  const versionChecks = workflow.match(/version !== tag\.replace\(\/\^v\/u, ""\)/gu) ?? [];
  assert.equal(checkouts.length, 3);
  assert.equal(selectedRefs.length, checkouts.length);
  assert.equal(sourceChecks.length, checkouts.length);
  assert.equal(commitChecks.length, checkouts.length);
  assert.equal(versionChecks.length, checkouts.length);
});

test("the build verifies its source before either artifact upload", () => {
  const build = workflow.split(/^  build:\s*$/mu)[1]?.split(/^  verify_existing:\s*$/mu)[0];
  assert.ok(build);
  const sourceCheck = build.indexOf("name: Verify checked out release source");
  assert.ok(sourceCheck >= 0);
  assert.ok(sourceCheck < build.indexOf("uses: tauri-apps/tauri-action@"));
  assert.ok(sourceCheck < build.indexOf("name: Upload stable installer aliases"));
});

function fixture(t, algorithm = "ED") {
  const assetsDir = mkdtempSync(join(tmpdir(), "updater-gate-"));
  t.after(() => rmSync(assetsDir, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const keyPacket = Buffer.concat([
    Buffer.from("Ed"), id, publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ]);
  const pubkey = Buffer.from(`untrusted comment: synthetic test key\n${keyPacket.toString("base64")}\n`).toString("base64");
  const config = { version: "2.0.0", plugins: { updater: { pubkey } } };
  const platforms = {};
  for (const name of updaterPlatforms(workflow)) {
    const filename = `${name}.bin`;
    const bytes = Buffer.from(`synthetic installer for ${name}`);
    writeFileSync(join(assetsDir, filename), bytes);
    const data = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
    const detached = sign(null, data, privateKey);
    const comment = `timestamp:1 file:${filename}`;
    const packet = Buffer.concat([Buffer.from(algorithm), id, detached]);
    const globalSignature = sign(null, Buffer.concat([detached, Buffer.from(comment)]), privateKey);
    const signature = Buffer.from([
      "untrusted comment: synthetic signature",
      packet.toString("base64"),
      `trusted comment: ${comment}`,
      globalSignature.toString("base64"), "",
    ].join("\n")).toString("base64");
    platforms[name] = {
      url: `https://github.com/lucaswebsystems/openlimiter/releases/download/v2.0.0/${filename}`,
      signature,
    };
  }
  return {
    manifest: { version: "2.0.0", platforms },
    options: { config, workflow, assetsDir, tag: "v2.0.0" },
  };
}

function changeSignature(entry, mutate) {
  const lines = Buffer.from(entry.signature, "base64").toString().trimEnd().split("\n");
  mutate(lines);
  entry.signature = Buffer.from(`${lines.join("\n")}\n`).toString("base64");
}

test("valid manifest verifies generated ED signatures over every asset", (t) => {
  const { manifest, options } = fixture(t);
  assert.deepEqual(updaterPlatforms(workflow), ["linux-x86_64", "windows-x86_64"]);
  assert.doesNotThrow(() => verifyManifest(manifest, options));
});

test("legacy Ed signatures verify without prehashing", (t) => {
  const { manifest, options } = fixture(t, "Ed");
  assert.doesNotThrow(() => verifyManifest(manifest, options));
});

test("rejects a manifest version different from the desktop configuration", (t) => {
  const { manifest, options } = fixture(t);
  manifest.version = "1.9.0";
  assert.throws(() => verifyManifest(manifest, options), /differs from the desktop version/u);
});

test("rejects a manifest version different from the release tag", (t) => {
  const { manifest, options } = fixture(t);
  options.tag = "v2.0.1";
  assert.throws(() => verifyManifest(manifest, options), /differs from the release tag/u);
});

for (const platform of ["linux-x86_64", "windows-x86_64"]) {
  test(`rejects a missing ${platform} platform`, (t) => {
    const { manifest, options } = fixture(t);
    delete manifest.platforms[platform];
    assert.throws(() => verifyManifest(manifest, options), /missing platform/u);
  });
}

test("rejects an unsigned macOS platform", (t) => {
  const { manifest, options } = fixture(t);
  manifest.platforms["darwin-aarch64"] = manifest.platforms["linux-x86_64"];
  assert.throws(() => verifyManifest(manifest, options), /Unsigned macOS/u);
});

test("requires an assets directory", (t) => {
  const { manifest, options } = fixture(t);
  delete options.assetsDir;
  assert.throws(() => verifyManifest(manifest, options), /--assets needs a directory/u);
});

test("rejects an asset filename that is not present", (t) => {
  const { manifest, options } = fixture(t);
  manifest.platforms["linux-x86_64"].url += ".missing";
  assert.throws(() => verifyManifest(manifest, options), /asset does not exist/u);
});

test("rejects a tampered asset", (t) => {
  const { manifest, options } = fixture(t);
  writeFileSync(join(options.assetsDir, "linux-x86_64.bin"), "changed installer bytes");
  assert.throws(() => verifyManifest(manifest, options), /Invalid asset signature/u);
});

test("rejects an invalid signature over unchanged bytes", (t) => {
  const { manifest, options } = fixture(t);
  changeSignature(manifest.platforms["linux-x86_64"], (lines) => {
    const packet = Buffer.from(lines[1], "base64");
    packet[10] ^= 1;
    lines[1] = packet.toString("base64");
  });
  assert.throws(() => verifyManifest(manifest, options), /Invalid asset signature/u);
});

test("rejects a mismatched key id even when the signature bytes are valid", (t) => {
  const { manifest, options } = fixture(t);
  changeSignature(manifest.platforms["linux-x86_64"], (lines) => {
    const packet = Buffer.from(lines[1], "base64");
    packet[2] ^= 1;
    lines[1] = packet.toString("base64");
  });
  assert.throws(() => verifyManifest(manifest, options), /key id mismatch/u);
});

test("rejects a tampered trusted comment", (t) => {
  const { manifest, options } = fixture(t);
  changeSignature(manifest.platforms["linux-x86_64"], (lines) => { lines[2] += " changed"; });
  assert.throws(() => verifyManifest(manifest, options), /Invalid trusted comment signature/u);
});

test("derives additional updater targets from the build matrix", (t) => {
  const { manifest, options } = fixture(t);
  options.workflow = workflow.replace("rust_targets: x86_64-unknown-linux-gnu", "rust_targets: x86_64-unknown-linux-gnu,aarch64-unknown-linux-gnu");
  assert.throws(() => verifyManifest(manifest, options), /missing platform linux-aarch64/u);
});
