/**
 * The one credential the CLI keeps for the hub, and how it is protected.
 *
 * This package ships no OS keyring driver, so the session lives in a plain
 * file beside the configuration, exactly the way the configuration itself
 * does. The file is written through the same atomic writer every other state
 * document in this product uses, which already puts it at mode 0600 on every
 * platform that has file modes. Windows has no such mode, so a best effort
 * owner only ACL is applied through `icacls` on top of that, and the file
 * says so about itself so a person who opens it understands why.
 */
import { unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import {
  canonicalJson,
  readJsonFileSafely,
  resolveStateDirectory,
  writeFileAtomically
} from "@openlimiter/core";
import type { CredentialCommandRunner } from "@openlimiter/core";

export const SESSION_FILE_NAME = "openlimiter-session.json";

/** How this build explains the file's own protection, inside the file. */
export const SESSION_SECURITY_NOTE_POSIX =
  "This file holds a hub sign in. It is written with mode 0600 (owner read and write only).";
export const SESSION_SECURITY_NOTE_WINDOWS =
  "This file holds a hub sign in. An owner only ACL is applied through icacls, best effort.";

export interface HubSession {
  readonly version: 1;
  readonly token: string;
  readonly expiresAt: string;
  readonly refreshCredential: string;
  readonly refreshExpiresAt: string;
  readonly deviceId: string;
  readonly accountLabel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/**
 * Read the stored session document, keeping only a value shaped exactly like
 * one this build could have written.
 *
 * A corrupt, foreign or unsafe file reads as no session at all rather than a
 * thrown error: every caller of this function already has to handle "nobody
 * is signed in" as an ordinary case, and a hand edited or half written file is
 * one more way to reach it, not a new failure mode.
 */
export async function readSession(
  directory = resolveStateDirectory()
): Promise<HubSession | null> {
  const result = await readJsonFileSafely(path.join(directory, SESSION_FILE_NAME));
  if (!result.ok || !isRecord(result.value)) return null;
  const value = result.value;
  if (value["version"] !== 1) return null;
  const token = value["token"];
  const expiresAt = value["expiresAt"];
  const refreshCredential = value["refreshCredential"];
  const refreshExpiresAt = value["refreshExpiresAt"];
  const deviceId = value["deviceId"];
  const accountLabel = value["accountLabel"];
  if (
    !boundedString(token, 16, 32_768) ||
    !validInstant(expiresAt) ||
    !boundedString(refreshCredential, 16, 4_096) ||
    !validInstant(refreshExpiresAt) ||
    !boundedString(deviceId, 1, 128) ||
    !boundedString(accountLabel, 1, 256)
  ) {
    return null;
  }
  return { version: 1, token, expiresAt, refreshCredential, refreshExpiresAt, deviceId, accountLabel };
}

/**
 * Apply an owner only ACL to the session file on Windows, best effort.
 *
 * `icacls` is asked to drop inherited permissions and grant the current user
 * full control and nobody else. Every failure here, including no runner being
 * available at all, is swallowed: the file is already private on every
 * platform where a file mode means anything, and a person who cannot run
 * `icacls` on their own machine still has a readable session file rather than
 * a command that refuses to finish signing them in.
 */
async function applyWindowsOwnerOnlyAcl(
  target: string,
  runner: CredentialCommandRunner | undefined
): Promise<void> {
  if (runner === undefined) return;
  const username = userInfo().username;
  if (username.length === 0 || username.length > 256) return;
  try {
    await runner("icacls", [target, "/inheritance:r", "/grant:r", username + ":F"], 5_000);
  } catch {
    /* Best effort, as documented on the file itself. */
  }
}

export interface WriteSessionOptions {
  readonly directory?: string;
  readonly platform: NodeJS.Platform;
  readonly windowsAclRunner?: CredentialCommandRunner;
}

/**
 * Write the session document, then narrow who can read it.
 *
 * The write itself goes through the product's shared atomic writer, which
 * already puts the file at mode 0600 wherever a file mode exists. The
 * Windows ACL is layered on afterwards because it is a second, independent
 * mechanism and a failure in it must never roll back a sign in that otherwise
 * succeeded.
 */
export async function writeSession(
  session: HubSession,
  options: WriteSessionOptions
): Promise<void> {
  const directory = options.directory ?? resolveStateDirectory();
  const target = path.join(directory, SESSION_FILE_NAME);
  const documented = {
    security: options.platform === "win32"
      ? SESSION_SECURITY_NOTE_WINDOWS
      : SESSION_SECURITY_NOTE_POSIX,
    ...session
  };
  await writeFileAtomically(target, canonicalJson(documented));
  if (options.platform === "win32") {
    await applyWindowsOwnerOnlyAcl(target, options.windowsAclRunner);
  }
}

/** Forget the session. `logout` is this and nothing else. */
export async function deleteSession(directory = resolveStateDirectory()): Promise<void> {
  await unlink(path.join(directory, SESSION_FILE_NAME)).catch(() => undefined);
}

/** How long before expiry this build renews, rather than waiting to lapse. */
export const RENEWAL_WINDOW_MILLISECONDS = 60 * 60 * 1_000;

/** Whether a session is fresh enough to use as it stands. */
export function sessionIsFresh(session: HubSession, now: string): boolean {
  const expiresAtMs = Date.parse(session.expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  return expiresAtMs - nowMs > RENEWAL_WINDOW_MILLISECONDS;
}
