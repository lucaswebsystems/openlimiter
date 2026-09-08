import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Launcher } from "./terminal-launcher.js";

export const LAUNCHER_TIMEOUT_MILLISECONDS = 5_000;
const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Native supervisors deliberately live outside the replaceable Node runtime.
 * The original belongs to this immutable launcher, never to host settings.
 * Buffer stdout until success so a failing renderer cannot leak partial bars.
 */
function posixScript(runtime: Launcher, original: string | null, timeout: number): string {
  return `#!/bin/sh
exec 2>/dev/null
umask 077
work=$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/openlimiter.XXXXXXXX") || exit 0
trap '/bin/rm -rf "$work"' EXIT
trap 'exit 0' HUP INT TERM
if [ -t 0 ]; then : > "$work/input"; else /bin/cat > "$work/input"; fi
run() {
  "$@" < "$work/input" > "$work/output" 2>/dev/null &
  child=$!
  (/bin/sleep ${timeout / 1000}; : > "$work/timeout"; kill -9 "$child" 2>/dev/null) </dev/null >/dev/null 2>&1 &
  timer=$!
  wait "$child" 2>/dev/null
  result=$?
  kill "$timer" 2>/dev/null
  wait "$timer" 2>/dev/null
  [ ! -f "$work/timeout" ] && [ "$result" -eq 0 ]
}
if run ${posixQuote(runtime.node)} ${posixQuote(runtime.entry)} "$@"; then
  /bin/cat "$work/output"
${original === null ? "" : `else
  /bin/rm -f "$work/timeout"
  run /bin/sh -c ${posixQuote(original)}
  /bin/cat "$work/output"`}
fi
exit 0
`;
}

function powershellScript(runtime: Launcher, original: string | null, timeout: number): string {
  // PS 5 requires a BOM for Unicode literals. All pipe transfers use raw streams,
  // not PowerShell's line oriented pipeline or its console encoding conversion.
  return `\uFEFF$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $inputBytes = New-Object IO.MemoryStream
  if ([Console]::IsInputRedirected) { [Console]::OpenStandardInput().CopyTo($inputBytes) }
  function Invoke-Bar([string]$executable, [string]$arguments) {
    $p = New-Object Diagnostics.Process
    $p.StartInfo.FileName = $executable
    $p.StartInfo.Arguments = $arguments
    $p.StartInfo.UseShellExecute = $false
    $p.StartInfo.CreateNoWindow = $true
    $p.StartInfo.RedirectStandardInput = $true
    $p.StartInfo.RedirectStandardOutput = $true
    $p.StartInfo.RedirectStandardError = $true
    $outputBytes = New-Object IO.MemoryStream
    $errorBytes = New-Object IO.MemoryStream
    $ok = $false
    try {
      [void]$p.Start()
      $outTask = $p.StandardOutput.BaseStream.CopyToAsync($outputBytes)
      $errTask = $p.StandardError.BaseStream.CopyToAsync($errorBytes)
      $inputBytes.Position = 0
      $inTask = $inputBytes.CopyToAsync($p.StandardInput.BaseStream)
      $inputClosed = $false
      $clock = [Diagnostics.Stopwatch]::StartNew()
      while (!$p.HasExited -and $clock.ElapsedMilliseconds -lt ${timeout}) {
        if ($inTask.IsCompleted -and !$inputClosed) { $p.StandardInput.Close(); $inputClosed = $true }
        [void]$p.WaitForExit(10)
      }
      if (!$p.HasExited) {
        $p.Kill()
        [void]$p.WaitForExit(1000)
      } elseif ($outTask.Wait(100) -and $errTask.Wait(100)) {
        $ok = $p.ExitCode -eq 0
      }
    } catch { } finally {
      try { if (!$p.HasExited) { $p.Kill(); [void]$p.WaitForExit(1000) } } catch { }
      $p.Dispose()
    }
    return @{ ok = $ok; bytes = $outputBytes.ToArray() }
  }
  $result = Invoke-Bar ${psQuote(runtime.node)} (${psQuote('"' + runtime.entry + '" ')} + ($args -join ' '))
  ${original === null ? "if (!$result.ok) { exit 0 }" : `if (!$result.ok) {
    $result = Invoke-Bar "$env:SystemRoot\\System32\\cmd.exe" ${psQuote('/d /s /c "' + original + '"')}
  }`}
  [Console]::OpenStandardOutput().Write($result.bytes, 0, $result.bytes.Length)
} catch { }
exit 0
`;
}

export async function fallbackLauncherCommand(
  runtime: Launcher,
  shell: "posix" | "cmd" | "powershell",
  original: string | null,
  timeout = LAUNCHER_TIMEOUT_MILLISECONDS
): Promise<string> {
  const script = shell === "posix" ? posixScript(runtime, original, timeout) : powershellScript(runtime, original, timeout);
  const id = createHash("sha256").update(script).digest("hex");
  const directory = path.join(path.dirname(path.dirname(runtime.entry)), "terminal-launchers", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, shell === "posix" ? "openlimiter.sh" : "openlimiter.ps1");
  try {
    await writeFile(file, script, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || await readFile(file, "utf8") !== script) throw new Error("Invalid launcher");
  }
  if (shell === "posix") return `/bin/sh ${posixQuote(file)}`;
  const executable = path.win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (shell === "powershell") return `& ${psQuote(executable)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${psQuote(file)}`;
  if (/["%\r\n]/.test(file + executable)) throw new Error("Invalid launcher");
  return `"${executable}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file}"`;
}
