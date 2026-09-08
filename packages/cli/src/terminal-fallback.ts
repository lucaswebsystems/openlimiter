import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type Launcher } from "./terminal-launcher.js";

export const LAUNCHER_TIMEOUT_MILLISECONDS = 5_000;
export interface FallbackLauncherOptions {
  timeoutMilliseconds?: number;
  /** Omit to detect at build time; null selects the portable polling supervisor. */
  posixTimeoutCommand?: string | null;
}
const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

async function detectPosixTimeout(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(process.platform === "win32" ? "bash" : "/bin/sh", [
      "-c", 'if [ -x /usr/bin/timeout ]; then printf /usr/bin/timeout; else command -v timeout; fi'
    ], { windowsHide: true, timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Native supervisors deliberately live outside the replaceable Node runtime.
 * The original belongs to this immutable launcher, never to host settings.
 * Buffer stdout until success so a failing renderer cannot leak partial bars.
 */
function posixScript(runtime: Launcher, original: string | null, timeout: number, timeoutCommand: string | null): string {
  return `#!/bin/sh
exec 2>/dev/null
umask 077
work=$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/openlimiter.XXXXXXXX") || exit 0
trap '/bin/rm -rf "$work"' EXIT
trap 'exit 0' HUP INT TERM
if [ -t 0 ]; then : > "$work/input"; else /bin/cat > "$work/input"; fi
emit() {
  prefix=$(LC_ALL=C /bin/dd if="$1" bs=1 count=3 2>/dev/null)
  if [ "$prefix" = "$(printf '\\357\\273\\277')" ]; then
    /bin/dd if="$1" bs=1 skip=3 2>/dev/null
  else
    /bin/cat "$1"
  fi
}
run_number=0
run() {
  run_number=$((run_number + 1))
  run_work="$work/$run_number"
  /bin/mkdir "$run_work" || return 1
  output="$run_work/output"
${timeoutCommand === null ? `  # Supervisor: polling
  (
    "$@"
    printf '%s\\n' "$?" > "$run_work/status"
  ) < "$work/input" > "$output" 2>/dev/null &
  child=$!
  (/bin/sleep ${timeout / 1000}; [ ! -d "$run_work" ] || : > "$run_work/timeout") </dev/null >/dev/null 2>&1 &
  timer=$!
  # A complete status line is authoritative even if Git Bash reaps the job.
  while ! IFS= read -r result < "$run_work/status" && [ ! -f "$run_work/timeout" ]; do
    /bin/sleep 0.02
  done
  kill "$timer" 2>/dev/null
  if [ -f "$run_work/timeout" ]; then
    kill -9 -- "-$child" 2>/dev/null
    kill -9 "$child" 2>/dev/null
    return 1
  fi
  # Never wait here: termination can fail and must not hold the prompt open.
  [ "$result" = 0 ]` : `  # Supervisor: timeout
  ${posixQuote(timeoutCommand)} ${timeout / 1000} "$@" < "$work/input" > "$output" 2>/dev/null`}
}
if run ${posixQuote(runtime.node)} ${posixQuote(runtime.entry)} "$@"; then
  emit "$output"
${original === null ? "" : `else
  run /bin/sh -c ${posixQuote(original)}
  emit "$output"`}
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
  $fallback = !$result.ok
  ${original === null ? "if ($fallback) { exit 0 }" : `if ($fallback) {
    $result = Invoke-Bar "$env:SystemRoot\\System32\\cmd.exe" ${psQuote('/d /s /c "' + original + '"')}
  }`}
  $offset = 0
  if ($result.bytes.Length -ge 3 -and $result.bytes[0] -eq 0xef -and $result.bytes[1] -eq 0xbb -and $result.bytes[2] -eq 0xbf) {
    $offset = 3
  }
  [Console]::OpenStandardOutput().Write($result.bytes, $offset, $result.bytes.Length - $offset)
} catch { }
exit 0
`;
}

export async function fallbackLauncherCommand(
  runtime: Launcher,
  shell: "posix" | "cmd" | "powershell",
  original: string | null,
  options: FallbackLauncherOptions = {}
): Promise<string> {
  const timeout = options.timeoutMilliseconds ?? LAUNCHER_TIMEOUT_MILLISECONDS;
  const timeoutCommand = shell === "posix"
    ? options.posixTimeoutCommand === undefined ? await detectPosixTimeout() : options.posixTimeoutCommand
    : null;
  const script = shell === "posix" ? posixScript(runtime, original, timeout, timeoutCommand) : powershellScript(runtime, original, timeout);
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
