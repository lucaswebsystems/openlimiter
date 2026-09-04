import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import type { KeyLike } from "node:crypto";
import {
  parseStrictJson,
  type HostedContextTrust
} from "./hosted-context.js";

export const HOSTED_TRUST_SCHEMA = "openlimiter.hosted_trust";
export const HOSTED_TRUST_VERSION = 1;
export const HOSTED_TRUST_FILE_NAME = "hosted-trust.json";
export const HOSTED_TRUST_MAX_BYTES = 16_384;

/**
 * Release builds replace this empty map with the current and next public
 * verification keys. The desktop trust document can select key ids, but it
 * can never introduce key material.
 */
export const PINNED_HOSTED_CONTEXT_PUBLIC_KEYS: Readonly<Record<string, KeyLike>> =
  Object.freeze({});

export interface HostedTrustDocument {
  schema: typeof HOSTED_TRUST_SCHEMA;
  version: typeof HOSTED_TRUST_VERSION;
  account_id: string;
  device_id: string;
  entitlement_epoch: number;
  last_verified_sequence: number;
  routing_state: "disabled" | "enabled";
  pinned_public_key_ids: string[];
}

export interface HostedTrustLoadOptions {
  homeDirectory: string;
  platform: NodeJS.Platform;
  now: string;
  pinnedPublicKeys?: Readonly<Record<string, KeyLike>>;
  trustedPlatformConfigRoot?: string;
}

const keyIdPattern = /^[A-Za-z0-9_.-]{1,64}$/u;
const accountPattern = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const openFlags = constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeInteger(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= (positive ? 1 : 0);
}

function documentFromUnknown(value: unknown): HostedTrustDocument | null {
  const root = record(value);
  if (root === null || !exactKeys(root, [
    "account_id",
    "device_id",
    "entitlement_epoch",
    "last_verified_sequence",
    "pinned_public_key_ids",
    "routing_state",
    "schema",
    "version"
  ])) return null;
  const ids = root["pinned_public_key_ids"];
  if (
    root["schema"] !== HOSTED_TRUST_SCHEMA ||
    root["version"] !== HOSTED_TRUST_VERSION ||
    typeof root["account_id"] !== "string" ||
    !accountPattern.test(root["account_id"]) ||
    typeof root["device_id"] !== "string" ||
    !uuidPattern.test(root["device_id"]) ||
    !safeInteger(root["entitlement_epoch"]) ||
    !safeInteger(root["last_verified_sequence"], true) ||
    (root["routing_state"] !== "enabled" && root["routing_state"] !== "disabled") ||
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 8 ||
    !ids.every((id) => typeof id === "string" && keyIdPattern.test(id)) ||
    new Set(ids).size !== ids.length
  ) return null;
  return root as unknown as HostedTrustDocument;
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function pathContainsLinkOrReparse(
  target: string,
  platform: NodeJS.Platform
): Promise<boolean> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) return true;
      const canonical = await realpath(current);
      if (normalizedPath(canonical, platform) !== normalizedPath(current, platform)) return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
      return true;
    }
  }
  return false;
}

async function readAtMost(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function ownerOnly(stat: Stats, platform: NodeJS.Platform): boolean {
  if (platform === "win32" || typeof process.getuid !== "function") return true;
  return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

export function hostedTrustFilePath(
  platform: NodeJS.Platform,
  homeDirectory: string,
  trustedPlatformConfigRoot?: string
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (trustedPlatformConfigRoot !== undefined) {
    return platformPath.join(
      trustedPlatformConfigRoot,
      platform === "linux" ? "openlimiter" : "OpenLimiter",
      HOSTED_TRUST_FILE_NAME
    );
  }
  if (platform === "win32") {
    return platformPath.join(
      homeDirectory,
      "AppData",
      "Roaming",
      "OpenLimiter",
      HOSTED_TRUST_FILE_NAME
    );
  }
  if (platform === "darwin") {
    return platformPath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "OpenLimiter",
      HOSTED_TRUST_FILE_NAME
    );
  }
  return platformPath.join(homeDirectory, ".config", "openlimiter", HOSTED_TRUST_FILE_NAME);
}

export async function loadHostedContextTrust(
  options: HostedTrustLoadOptions
): Promise<HostedContextTrust | undefined> {
  if (!path.isAbsolute(options.homeDirectory) || !Number.isFinite(Date.parse(options.now))) {
    return undefined;
  }
  if (
    options.trustedPlatformConfigRoot !== undefined &&
    !(options.platform === "win32" ? path.win32 : path.posix)
      .isAbsolute(options.trustedPlatformConfigRoot)
  ) return undefined;
  const file = hostedTrustFilePath(
    options.platform,
    options.homeDirectory,
    options.trustedPlatformConfigRoot
  );
  if (await pathContainsLinkOrReparse(file, options.platform)) return undefined;
  let handle: FileHandle;
  try {
    handle = await open(file, openFlags);
  } catch {
    return undefined;
  }
  try {
    const opened = await handle.stat();
    const linked = await lstat(file);
    if (
      !opened.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.size > HOSTED_TRUST_MAX_BYTES ||
      !ownerOnly(opened, options.platform) ||
      await pathContainsLinkOrReparse(file, options.platform)
    ) return undefined;
    const bytes = await readAtMost(handle, HOSTED_TRUST_MAX_BYTES);
    if (bytes.byteLength > HOSTED_TRUST_MAX_BYTES) return undefined;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(text);
    } catch {
      return undefined;
    }
    const document = documentFromUnknown(parsed);
    if (document === null) return undefined;
    const pinned = options.pinnedPublicKeys ?? PINNED_HOSTED_CONTEXT_PUBLIC_KEYS;
    const publicKeys = Object.create(null) as Record<string, KeyLike>;
    for (const id of document.pinned_public_key_ids) {
      if (!Object.prototype.hasOwnProperty.call(pinned, id)) return undefined;
      const key = pinned[id];
      if (key === undefined) return undefined;
      publicKeys[id] = key;
    }
    return {
      routingEnabled: document.routing_state === "enabled",
      accountId: document.account_id,
      deviceId: document.device_id.toLowerCase(),
      latestSequence: document.last_verified_sequence,
      greatestAcceptedRevocationEpoch: document.entitlement_epoch,
      currentHostedRevocationEpoch: document.entitlement_epoch,
      publicKeys,
      now: options.now
    };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
