import { execFile } from "node:child_process";
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

/**
 * What Windows has to say about who can reach the trust file.
 *
 * Windows has no POSIX mode bits, so the two facts the contract asks for come
 * from the operating system instead: the account this process runs as, and the
 * file's security descriptor in SDDL form. Both are read together so the owner
 * comparison cannot be made against a different account than the one that read
 * the descriptor.
 */
export interface WindowsTrustSecurity {
  currentUserSid: string;
  securityDescriptor: string;
}

/** How that pair is obtained. Injected in tests so no test reads a real file. */
export type WindowsTrustSecurityProbe = (
  file: string,
  signal?: AbortSignal
) => Promise<WindowsTrustSecurity | null>;

export interface HostedTrustLoadOptions {
  homeDirectory: string;
  platform: NodeJS.Platform;
  now: string;
  pinnedPublicKeys?: Readonly<Record<string, KeyLike>>;
  trustedPlatformConfigRoot?: string;
  windowsSecurity?: WindowsTrustSecurityProbe;
  /**
   * Deadline for the caller that asked for this trust document.
   *
   * A hook answers within a hard budget. When that budget is already spent the
   * load stops rather than finishing work whose answer has nowhere to go.
   */
  signal?: AbortSignal;
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

const sidPattern = /^S-1-\d{1,10}(?:-\d{1,10}){1,15}$/u;

/**
 * Split a security descriptor into its owner, group, DACL and SACL sections.
 *
 * Section markers are single letters followed by a colon at the top level of
 * the string, and no other colon can appear there, so the split is exact.
 * Anything that does not read as that grammar is refused rather than guessed
 * at, because a descriptor this code cannot account for is not a descriptor it
 * is entitled to approve.
 */
function descriptorSections(descriptor: string): Map<string, string> | null {
  const sections = new Map<string, string>();
  let depth = 0;
  let current: string | null = null;
  let start = 0;
  for (let index = 0; index < descriptor.length; index += 1) {
    const character = descriptor[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (character === ":" && depth === 0) {
      const marker = descriptor[index - 1];
      if (marker === undefined || !"OGDS".includes(marker)) return null;
      if (current === null) {
        if (index !== 1) return null;
      } else {
        sections.set(current, descriptor.slice(start, index - 1));
      }
      if (sections.has(marker)) return null;
      current = marker;
      start = index + 1;
    }
  }
  if (depth !== 0 || current === null) return null;
  sections.set(current, descriptor.slice(start));
  return sections;
}

/**
 * Decide whether a Windows trust file is the current user's alone.
 *
 * The owner has to be this account, because an owner can rewrite permissions
 * whatever they currently say. The access list has to be protected, so no
 * inherited entry from a parent folder applies, and every entry in it has to
 * name this account and nobody else. Anything else, including a descriptor
 * that does not parse, means no trust.
 */
export function windowsTrustIsOwnerOnly(security: WindowsTrustSecurity): boolean {
  const sid = security.currentUserSid;
  if (!sidPattern.test(sid)) return false;
  const sections = descriptorSections(security.securityDescriptor);
  if (sections === null || sections.get("O") !== sid) return false;
  const dacl = sections.get("D");
  if (dacl === undefined) return false;
  const firstEntry = dacl.indexOf("(");
  if (firstEntry < 0) return false;
  const flags = dacl.slice(0, firstEntry);
  const entries = dacl.slice(firstEntry);
  if (!/^[A-Z]*$/u.test(flags) || !flags.includes("P")) return false;
  if (!/^(?:\([^()]*\))+$/u.test(entries)) return false;
  let granted = false;
  for (const entry of entries.slice(1, -1).split(")(")) {
    const fields = entry.split(";");
    if (fields.length < 6 || fields.length > 7) return false;
    if (fields[0] !== "A" && fields[0] !== "D") return false;
    if ((fields[1] ?? "").includes("ID") || fields[5] !== sid) return false;
    if (fields[0] === "A") granted = true;
  }
  return granted;
}

/*
 * The probe itself.
 *
 * PowerShell is asked for both facts in one child process, with no shell and
 * no profile, and the path travels in an environment variable so no part of it
 * is ever parsed as script. The budget is short because a hook is waiting, and
 * every failure, including the timeout, resolves to no answer at all.
 */
const WINDOWS_SECURITY_TIMEOUT_MILLISECONDS = 300;
const WINDOWS_SECURITY_TARGET = "OPENLIMITER_TRUST_TARGET";
const windowsSecurityScript = [
  "$ErrorActionPreference = 'Stop'",
  "$target = [Environment]::GetEnvironmentVariable('" + WINDOWS_SECURITY_TARGET + "')",
  "$acl = Get-Acl -LiteralPath $target",
  "[Console]::Out.Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
  "[Console]::Out.Write([char]10)",
  "[Console]::Out.Write($acl.Sddl)"
].join("; ");

async function readWindowsTrustSecurity(
  file: string,
  signal?: AbortSignal
): Promise<WindowsTrustSecurity | null> {
  return await new Promise<WindowsTrustSecurity | null>((resolve) => {
    try {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-NoLogo",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          windowsSecurityScript
        ],
        {
          windowsHide: true,
          shell: false,
          timeout: WINDOWS_SECURITY_TIMEOUT_MILLISECONDS,
          maxBuffer: 16_384,
          env: { ...process.env, [WINDOWS_SECURITY_TARGET]: file },
          ...(signal === undefined ? {} : { signal })
        },
        (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          const lines = stdout.split("\n");
          if (lines.length !== 2) {
            resolve(null);
            return;
          }
          resolve({
            currentUserSid: lines[0]!.trim(),
            securityDescriptor: lines[1]!.trim()
          });
        }
      );
    } catch {
      resolve(null);
    }
  });
}

async function ownerOnly(
  stat: Stats,
  file: string,
  options: HostedTrustLoadOptions
): Promise<boolean> {
  if (options.platform !== "win32") {
    if (typeof process.getuid !== "function") return true;
    return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  }
  const probe = options.windowsSecurity ?? readWindowsTrustSecurity;
  let security: WindowsTrustSecurity | null;
  try {
    security = await probe(file, options.signal);
  } catch {
    return false;
  }
  return security !== null && windowsTrustIsOwnerOnly(security);
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
  if (
    options.signal?.aborted === true ||
    !path.isAbsolute(options.homeDirectory) ||
    !Number.isFinite(Date.parse(options.now))
  ) return undefined;
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
      await pathContainsLinkOrReparse(file, options.platform) ||
      !(await ownerOnly(opened, file, options))
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
