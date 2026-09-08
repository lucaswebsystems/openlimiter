/**
 * The one credential the CLI keeps for the hub, and how it is protected.
 *
 * This package ships no OS keyring driver, so the session lives in a plain
 * file beside the configuration, exactly the way the configuration itself
 * does. The file is written through the same atomic writer every other state
 * document in this product uses, which already puts it at mode 0600 on every
 * platform that has file modes. On Windows the containing directory receives
 * a verified, protected owner only ACL before any credential bytes are written.
 */
import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  acquireRefreshLock,
  prepareStateDirectory,
  readJsonFileSafely,
  resolveStateDirectory,
  writeFileAtomically
} from "@openlimiter/core";
import type { CredentialCommandRunner } from "@openlimiter/core";

export const SESSION_FILE_NAME = "openlimiter-session.json";
export const SESSION_LOCK_NAME = "openlimiter-session.lock";
export const SESSION_LOCK_WAIT_MILLISECONDS = 10_000;

function windowsSystemTool(...segments: string[]): string {
  return path.win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", ...segments);
}

/** How this build explains the file's own protection, inside the file. */
export const SESSION_SECURITY_NOTE_POSIX =
  "This file holds a hub sign in. It is written with mode 0600 (owner read and write only).";
export const SESSION_SECURITY_NOTE_WINDOWS =
  "This file holds a hub sign in. An owner only ACL is verified before credentials are written.";

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
 * Protect the directory and verify the effective rule set before writing.
 * The atomic writer's temporary file inherits only this rule. Never restore
 * inheritance or write credentials after a helper failure.
 */
async function applyWindowsOwnerOnlyAcl(
  target: string,
  runner: CredentialCommandRunner | undefined
): Promise<void> {
  const repairFailure = (detail: string): Error => new Error(
    "Private session storage is unavailable at " + target + ". " +
    "Restore access with icacls " + target + " /reset from your own account. " + detail
  );
  if (runner === undefined) {
    throw repairFailure("The Windows ACL helper is unavailable");
  }
  const principal = await windowsPrincipal(runner);
  if (principal === null) {
    throw repairFailure("The current Windows user identity is unavailable");
  }
  /* Verify first and repair only when the rule set is wrong. The repair goes
     through the .NET SetAccessControl call rather than Set-Acl: Set-Acl on a
     directory whose rules are already protected demands SeSecurityPrivilege,
     which an ordinary sign in does not hold, so the second write of every
     session (the renewal) failed with it. Measured on Windows 11, 2026-09-08. */
  const verify = "$check=Get-Acl -LiteralPath $p;" +
    "$rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));" +
    "$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');" +
    "$bad=$rules|Where-Object {$allowed -notcontains $_.IdentityReference.Value -or $_.IsInherited -or " +
    "$_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or " +
    "[int]$_.FileSystemRights -ne [int]$full -or [int]$_.InheritanceFlags -ne [int]$inherit -or " +
    "[int]$_.PropagationFlags -ne [int][System.Security.AccessControl.PropagationFlags]::None};" +
    "$private=($check.AreAccessRulesProtected -and $rules.Count -ge 1 -and " +
    "@($rules|Where-Object {$_.IdentityReference.Value -eq $sid.Value}).Count -eq 1 -and " +
    "$null -eq $bad -and " +
    "$check.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value);";
  const repair = "$acl=Get-Acl -LiteralPath $p;" +
    "$acl.SetAccessRuleProtection($true,$false);" +
    "@($acl.Access)|ForEach-Object {$acl.RemoveAccessRuleSpecific($_)};" +
    "$acl.SetOwner($sid);" +
    "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,$full,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);" +
    "$acl.AddAccessRule($rule);" +
    "(Get-Item -LiteralPath $p -Force).SetAccessControl($acl);";
  const script = "$ErrorActionPreference='Stop';" +
    "$p='" + target.replace(/'/gu, "''") + "';" +
    "$sid=[System.Security.Principal.SecurityIdentifier]::new('" + principal + "');" +
    "$full=[System.Security.AccessControl.FileSystemRights]::FullControl;" +
    "$inherit=[System.Enum]::Parse([System.Security.AccessControl.InheritanceFlags],'ContainerInherit,ObjectInherit');" +
    verify +
    "if (!$private) {" + repair + verify + "};" +
    "if (!$private) {throw 'Private storage unavailable'};" +
    "Write-Output 'PRIVATE'";
  let result;
  try {
    result = await runner(windowsSystemTool("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], 15_000);
  } catch {
    throw repairFailure("The PowerShell ACL helper is unavailable");
  }
  if (!result.ok) {
    throw repairFailure("The PowerShell ACL helper failed");
  }
  if (result.stdout.trim() !== "PRIVATE") {
    throw repairFailure("The PowerShell ACL verification rejected the ACL");
  }
}

/**
 * Use the current user's unambiguous SID, or refuse the write.
 */
async function windowsPrincipal(runner: CredentialCommandRunner): Promise<string | null> {
  try {
    const answer = await runner(windowsSystemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], 15_000);
    if (answer.ok) {
      const match = /"(S-1-[0-9-]+)"/u.exec(answer.stdout);
      if (match?.[1] !== undefined) return match[1];
    }
  } catch {
    /* A helper failure cannot establish a private owner. */
  }
  return null;
}

async function rejectStateReparsePoint(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) {
    throw new Error("Private session storage refused a symbolic link at " + directory);
  }
}

export interface WriteSessionOptions {
  readonly directory?: string;
  readonly platform: NodeJS.Platform;
  readonly windowsAclRunner?: CredentialCommandRunner;
}

/**
 * Establish private storage, then atomically replace the session document.
 */
export async function writeSession(
  session: HubSession,
  options: WriteSessionOptions
): Promise<void> {
  const directory = options.directory ?? resolveStateDirectory();
  const target = path.join(directory, SESSION_FILE_NAME);
  await prepareStateDirectory(directory);
  if (options.platform === "win32") {
    await applyWindowsOwnerOnlyAcl(directory, options.windowsAclRunner);
    await rejectStateReparsePoint(directory);
  }
  const documented = {
    security: options.platform === "win32"
      ? SESSION_SECURITY_NOTE_WINDOWS
      : SESSION_SECURITY_NOTE_POSIX,
    ...session
  };
  await writeFileAtomically(target, canonicalJson(documented));
}

/** One cross process transaction for renewal, revocation and sync cursors. */
export async function withSessionLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const lockPath = path.join(directory, SESSION_LOCK_NAME);
  for (;;) {
    const lock = await acquireRefreshLock(directory, Date.now(), SESSION_LOCK_NAME);
    if (!lock.ok) {
      if (lock.reason === "unavailable") throw new Error("Private session storage is unavailable");
      const elapsed = Date.now() - startedAt;
      if (elapsed >= SESSION_LOCK_WAIT_MILLISECONDS) {
        throw new Error(
          "another OpenLimiter command holds the session lock at " + lockPath
        );
      }
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(25, SESSION_LOCK_WAIT_MILLISECONDS - elapsed)
      ));
      continue;
    }
    try {
      return await action();
    } finally {
      await lock.release();
    }
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
