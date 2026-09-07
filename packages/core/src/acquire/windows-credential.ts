/**
 * Reading one Windows Credential Manager entry, with no native dependency.
 *
 * The Antigravity client keeps its token in the credential store rather than in
 * a file, so a Windows machine has nothing on disk to read. Every published way
 * to reach the store from Node is a native module with an install script, which
 * is a compiler on a user's machine and a post install hook in our supply chain
 * for the sake of one string. This asks Windows itself instead: PowerShell with
 * no profile, a small block that declares CredRead through the platform
 * invocation layer, and base64 on the way out so a credential containing a
 * quote or a newline cannot change the shape of what comes back.
 *
 * Nothing here writes to the store, and the target is a constant supplied by
 * the caller rather than anything read off disk.
 */

/** How long the helper may run before it is abandoned. */
export const WINDOWS_CREDENTIAL_TIMEOUT_MILLISECONDS = 5_000;

/** Largest credential blob accepted, matching the desktop's own bound. */
export const MAX_WINDOWS_CREDENTIAL_BYTES = 16_384;

/**
 * The one shape a credential target may take.
 *
 * Bounded printable ASCII with no quote and no newline, so the value can never
 * end a string literal inside the script below. A target outside this shape is
 * refused rather than escaped: there is exactly one target in this product and
 * it is a constant.
 */
export const CREDENTIAL_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@\\/-]{0,127}$/u;

export type CredentialCommandRunner = (
  executable: string,
  argumentsList: readonly string[],
  timeoutMilliseconds: number
) => Promise<{ ok: true; stdout: string } | { ok: false }>;

export type WindowsCredentialOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: "absent" | "unreadable" | "invalid" };

/**
 * The script the helper runs.
 *
 * It declares only CredRead and CredFree, reads the blob as bytes, and writes
 * base64 to standard output. A missing entry prints nothing and exits zero,
 * which is how "this machine has no Antigravity login" reaches us as an absence
 * rather than as an error.
 */
export function credentialReadScript(target: string): string {
  return [
    "$ErrorActionPreference = 'Stop';",
    "Add-Type -Namespace OpenLimiterCred -Name Native -MemberDefinition @'",
    "[DllImport(\"advapi32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
    "public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);",
    "[DllImport(\"advapi32.dll\", SetLastError = true)]",
    "public static extern void CredFree(IntPtr buffer);",
    "'@;",
    "$handle = [IntPtr]::Zero;",
    "if (-not [OpenLimiterCred.Native]::CredRead('" + target + "', 1, 0, [ref] $handle)) { exit 0 };",
    "try {",
    /* CREDENTIALW packs its blob size and blob pointer at different offsets on
       a 32 bit and a 64 bit host, so the offsets are derived from the pointer
       width rather than hard coded to whichever one this machine happens to
       be. Reading the wrong offset would hand back another field's bytes. */
    "  $wide = [IntPtr]::Size -eq 8;",
    "  $sizeOffset = if ($wide) { 32 } else { 24 };",
    "  $blobOffset = if ($wide) { 40 } else { 28 };",
    "  $size = [Runtime.InteropServices.Marshal]::ReadInt32($handle, $sizeOffset);",
    "  $blob = [Runtime.InteropServices.Marshal]::ReadIntPtr($handle, $blobOffset);",
    "  if ($size -le 0 -or $size -gt " + String(MAX_WINDOWS_CREDENTIAL_BYTES) + ") { exit 0 };",
    "  $bytes = New-Object byte[] $size;",
    "  [Runtime.InteropServices.Marshal]::Copy($blob, $bytes, 0, $size);",
    "  [Console]::Out.Write([Convert]::ToBase64String($bytes));",
    "} finally { [OpenLimiterCred.Native]::CredFree($handle) }"
  ].join("\n");
}

/**
 * Decode what the helper printed.
 *
 * Empty output is an absent entry, which is the ordinary answer on a machine
 * that never ran the Antigravity client. Anything that is not base64 of valid
 * UTF-16 or UTF-8 text is unreadable, and neither branch ever echoes what it
 * saw.
 */
export function decodeCredentialOutput(stdout: string): WindowsCredentialOutcome {
  const trimmed = stdout.trim();
  if (trimmed === "") return { ok: false, reason: "absent" };
  if (!/^[A-Za-z0-9+/=]+$/u.test(trimmed)) return { ok: false, reason: "unreadable" };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(trimmed, "base64");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WINDOWS_CREDENTIAL_BYTES) {
    return { ok: false, reason: "unreadable" };
  }
  /* The store holds the blob the writer chose, and this one is UTF-8 JSON. A
     zero byte in an even position is the signature of UTF-16, which the same
     writer uses on some releases, so both are read and neither is guessed. */
  const utf16 = bytes.byteLength % 2 === 0 && bytes[1] === 0;
  const text = utf16
    ? bytes.toString("utf16le")
    : bytes.toString("utf8");
  const value = text.replace(/\0+$/u, "");
  return value.length === 0
    ? { ok: false, reason: "unreadable" }
    : { ok: true, value };
}

export interface WindowsCredentialOptions {
  readonly runCommand: CredentialCommandRunner;
  readonly powerShellExecutable?: string;
  readonly timeoutMilliseconds?: number;
}

/** The executable the helper is run through, named rather than searched for. */
export const DEFAULT_POWERSHELL_EXECUTABLE = "powershell.exe";

/**
 * Read one credential target through the helper.
 *
 * The runner is injected so this whole path is provable without a credential on
 * the machine and so a test can never reach the real store.
 */
export async function readWindowsCredentialWith(
  target: string,
  options: WindowsCredentialOptions
): Promise<WindowsCredentialOutcome> {
  if (!CREDENTIAL_TARGET_PATTERN.test(target)) return { ok: false, reason: "invalid" };
  const result = await options.runCommand(
    options.powerShellExecutable ?? DEFAULT_POWERSHELL_EXECUTABLE,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      credentialReadScript(target)
    ],
    options.timeoutMilliseconds ?? WINDOWS_CREDENTIAL_TIMEOUT_MILLISECONDS
  );
  return result.ok
    ? decodeCredentialOutput(result.stdout)
    : { ok: false, reason: "unreadable" };
}
