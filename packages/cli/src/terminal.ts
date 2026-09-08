import { lstat, readFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { connectors } from "@openlimiter/connectors";
import { type CredentialCommandRunner, writeFileAtomically } from "@openlimiter/core";
import {
  DEFAULT_PROVIDERS,
  DEFAULT_STATUSLINE,
  readConfig,
  writeConfig,
  type OpenLimiterConfig
} from "./config.js";
import {
  decodeWrappedStatuslineCommand,
  encodeWrappedStatuslineCommand
} from "./statusline-wrapper.js";

import { parseToml, editToml, tomlValue } from "./terminal-toml.js";
import { installLauncher } from "./terminal-launcher.js";
import { fallbackLauncherCommand } from "./terminal-fallback.js";
import { isOwned, originalConfiguration, readOptional, restoreOwned, writeOwned } from "./terminal-backup.js";

export const TERMINAL_HOST_NAMES: readonly string[] = [
  "claude",
  "antigravity",
  "grok",
  "codex",
  "shell"
];

export const UNSUPPORTED_HOST_ALTERNATIVE =
  "No status line support, use the shell prompt";

export const STATUS_WIRED = "Wired";
/**
 * The host already draws a status line, and it is not ours.
 *
 * Told apart from `STATUS_NOT_WIRED` on purpose: a host with somebody else's
 * command already in the slot is not a host with nothing there, and install
 * behaves differently in each case, saving the first and writing the second
 * fresh. Saying "Not installed" for both, as this used to, told a person
 * nothing about which one they were looking at.
 */
export const STATUS_OWN_LINE_FOUND = "Your own status line found, install saves it";
export const STATUS_NOT_WIRED = "Not wired";
export const CONNECT_FIRST_SENTENCE = "Connect it first";

export interface TerminalHostContext {
  homeDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
  stateDirectory?: string;
  platform: NodeJS.Platform;
  detectedProviders?: readonly string[];
  /** Required to identify the Windows shell and resolve its active profile. */
  shellRunner?: CredentialCommandRunner;
  /** Keep the saved command alongside OpenLimiter only when explicitly chosen. */
  wrap?: boolean;
}

export interface TerminalOperationResult {
  ok: boolean;
  message: string;
}

async function canonicalOverrideRoot(
  value: string | undefined,
  fallback: string,
  variable: string
): Promise<string> {
  const root = value === undefined || value === "" ? fallback : value;
  if (!path.isAbsolute(root)) throw new Error(`${variable} must be an absolute path.`);
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) return await realpath(root);
  try { return await realpath(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Default roots need the same canonical identity as overrides. Resolve the
    // nearest existing ancestor when a first install has not created them yet.
    const parentPath = path.dirname(root);
    if (parentPath === root) throw error;
    const parent = await canonicalOverrideRoot(parentPath, parentPath, variable);
    return path.join(parent, path.basename(root));
  }
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalConfigFile(root: string, name: string, variable: string): Promise<string> {
  const candidate = path.join(root, name);
  try {
    const target = await realpath(candidate);
    if (!isWithinDirectory(root, target)) throw new Error(`${variable} must point to a file under its root.`);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return candidate;
  }
}

async function claudeSettingsPath(context: TerminalHostContext): Promise<string> {
  const root = await canonicalOverrideRoot(
    context.environment?.["CLAUDE_CONFIG_DIR"],
    path.join(context.homeDirectory, ".claude"),
    "CLAUDE_CONFIG_DIR"
  );
  return await canonicalConfigFile(root, "settings.json", "CLAUDE_CONFIG_DIR");
}
function antigravitySettingsPath(context: TerminalHostContext): string {
  return path.join(context.homeDirectory, ".gemini", "antigravity-cli", "settings.json");
}
function grokConfigPath(context: TerminalHostContext): string {
  return path.join(context.homeDirectory, ".grok", "config.toml");
}
async function codexConfigPath(context: TerminalHostContext): Promise<string> {
  const root = await canonicalOverrideRoot(
    context.environment?.["CODEX_HOME"],
    path.join(context.homeDirectory, ".codex"),
    "CODEX_HOME"
  );
  return await canonicalConfigFile(root, "config.toml", "CODEX_HOME");
}

const POWERSHELL_PROFILE_TIMEOUT_MILLISECONDS = 5_000;

/** Ask the selected PowerShell, including redirected Documents and PS 7 layouts.
 * A shell that cannot identify its active profile is not a verified target. */
async function resolvePowerShellProfilePath(
  executable: string,
  runner: CredentialCommandRunner | undefined
): Promise<string> {
  if (!runner) throw new Error("Unsupported shell");
  const result = await runner(executable, ["-NoProfile", "-NonInteractive", "-Command", "$PROFILE"], POWERSHELL_PROFILE_TIMEOUT_MILLISECONDS);
  if (!result.ok || !path.isAbsolute(result.stdout.trim())) throw new Error("Unsupported shell");
  return result.stdout.trim();
}

export type TerminalConfigReadResult<T> =
  | { kind: "missing" }
  | { kind: "parse_error"; error: unknown }
  | { kind: "ok"; data: T };

export async function readJsonConfig(filePath: string): Promise<TerminalConfigReadResult<Record<string, unknown>>> {
  try {
    const text = await readFile(filePath, "utf8");
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { kind: "ok", data: parsed as Record<string, unknown> };
      }
      return { kind: "parse_error", error: new Error("Not a JSON object") };
    } catch (err) {
      return { kind: "parse_error", error: err };
    }
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: unknown }).code === "ENOENT"
    ) {
      return { kind: "missing" };
    }
    return { kind: "parse_error", error: err };
  }
}

export function validateToml(text: string): boolean {
  try { parseToml(text); return true; } catch { return false; }
}

export async function readTomlConfig(filePath: string): Promise<TerminalConfigReadResult<string>> {
  try {
    const text = await readFile(filePath, "utf8");
    if (!validateToml(text)) {
      return { kind: "parse_error", error: new Error("Invalid TOML") };
    }
    return { kind: "ok", data: text };
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: unknown }).code === "ENOENT"
    ) {
      return { kind: "missing" };
    }
    return { kind: "parse_error", error: err };
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  const res = await readJsonConfig(filePath);
  return res.kind === "ok" ? res.data : null;
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

type ConfigHost = "claude" | "antigravity" | "grok" | "codex";
const HOST_CONFIG = {
  claude: { path: claudeSettingsPath, label: "Claude Code", file: "Claude Code settings", json: true, wired: "Wired Claude Code status line." },
  antigravity: { path: antigravitySettingsPath, label: "Antigravity", file: "Antigravity settings", json: true, wired: "Wired Antigravity CLI status line." },
  grok: { path: grokConfigPath, label: "Grok", file: "Grok config", json: false, wired: "Wired Grok Build status line." },
  codex: { path: codexConfigPath, label: "Codex", file: "Codex config", json: false, wired: "Wired Codex status line." }
};
const CODEX_ITEMS = ["five-hour-limit", "weekly-limit", "context-used", "model-with-reasoning", "current-dir"];

async function durableCommand(context: TerminalHostContext, shell: "posix" | "cmd" | "powershell", original: string | null): Promise<string> {
  const runtime = await installLauncher(context.stateDirectory ?? path.join(context.homeDirectory, ".openlimiter"));
  return await fallbackLauncherCommand(runtime, shell, original);
}

function ownedMarker(text: string, json: boolean): boolean {
  return json ? JSON.parse(text)["openlimiter managed"] === true
    : text.split(/\r?\n/).some(line => line.trim() === "# openlimiter managed");
}

async function changeConfigHost(host: ConfigHost, context: TerminalHostContext, install: boolean): Promise<TerminalOperationResult> {
  const spec = HOST_CONFIG[host];
  let file: string;
  try {
    file = await spec.path(context);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : `Could not resolve ${spec.file}.`
    };
  }
  const read = spec.json ? await readJsonConfig(file) : await readTomlConfig(file);
  if (read.kind === "parse_error") return { ok: false, message: `Could not read ${file}, fix it or move it aside` };
  try {
    const original = await readOptional(file);
    const firstConfiguration = await originalConfiguration(file, original);
    const text = original ?? (spec.json ? "{}" : "");
    const marker = ownedMarker(text, spec.json);
    if (!install) {
      const restored = original !== null && await restoreOwned(file, original, marker);
      if (marker && !restored) return { ok: false, message: `Could not update ${file}.` };
      return { ok: true, message: restored ? `Uninstalled ${spec.label} status line.` : `${spec.label} status line is not installed.` };
    }
    const previous: string | null = spec.json
      ? claudeLikeStatusLineCommand((JSON.parse(text) as Record<string, unknown>)["statusLine"])
      : host === "grok"
        ? (() => {
          const value = tomlValue(text, ["ui", "status_line", "command"]);
          return typeof value === "string" ? value : null;
        })()
        : null;
    const legacyOpenLimiter = previous !== null && isOpenLimiterStatuslineCommand(previous);
    const owned = original !== null && await isOwned(file, original, marker);
    if (marker && !owned && !legacyOpenLimiter) return { ok: false, message: `Could not write ${file}.` };

    const savedText = firstConfiguration ?? (spec.json ? "{}" : "");
    const savedCommand = spec.json
      ? claudeLikeStatusLineCommand((JSON.parse(savedText) as Record<string, unknown>)["statusLine"])
      : host === "grok" ? grokStatusLineCommand(savedText) : null;
    const userCommand = savedCommand === null ? null : unwrapOpenLimiterStatuslineCommand(savedCommand);
    const replaced = !owned && (userCommand !== null || (host === "codex" && tomlValue(savedText, ["tui", "status_line"]) !== undefined));
    const message = replaced
      ? `Your previous ${spec.label} status line is stored, and openlimiter terminal uninstall ${host} restores it.`
      : spec.wired;
    let updated: string;
    if (spec.json) {
      const data = JSON.parse(text) as Record<string, unknown>;
      const base = await durableCommand(context, context.platform === "win32" ? "cmd" : "posix", userCommand);
      const command = `${base} statusline --host ${host}` +
        (!context.wrap || userCommand === null ? "" : ` --wrap ${encodeWrappedStatuslineCommand(userCommand)}`);
      data["openlimiter managed"] = true;
      data["statusLine"] = host === "claude" ? { type: "command", command } : command;
      updated = JSON.stringify(data, null, 2) + "\n";
      JSON.parse(updated);
    } else if (host === "codex") {
      updated = editToml(text, ["tui"], { status_line: CODEX_ITEMS, status_line_use_colors: true });
    } else {
      const base = await durableCommand(context, context.platform === "win32" ? "cmd" : "posix", userCommand);
      const command = `${base} statusline --host grok` +
        (context.wrap && typeof userCommand === "string" ? ` --wrap ${encodeWrappedStatuslineCommand(userCommand)}` : "");
      updated = editToml(text, ["ui", "status_line"], { type: "command", command });
    }
    if (owned && updated === text) return { ok: true, message: spec.wired };
    await mkdir(path.dirname(file), { recursive: true });
    await writeOwned(file, original, updated);
    return { ok: true, message };
  } catch {
    return { ok: false, message: `Could not ${install ? "write" : "update"} ${file}.` };
  }
}

export const installClaude = (context: TerminalHostContext): Promise<TerminalOperationResult> => changeConfigHost("claude", context, true);
export const uninstallClaude = (context: TerminalHostContext): Promise<TerminalOperationResult> => changeConfigHost("claude", context, false);
export const installAntigravity = (context: TerminalHostContext): Promise<TerminalOperationResult> => changeConfigHost("antigravity", context, true);
export const uninstallAntigravity = (context: TerminalHostContext): Promise<TerminalOperationResult> => changeConfigHost("antigravity", context, false);
export const installGrok = (context: TerminalHostContext): Promise<TerminalOperationResult> => changeConfigHost("grok", context, true);
export const uninstallGrok = (context: TerminalHostContext): Promise<TerminalOperationResult> => changeConfigHost("grok", context, false);
export const installCodex = (context: TerminalHostContext): Promise<TerminalOperationResult> => changeConfigHost("codex", context, true);
export const uninstallCodex = (context: TerminalHostContext): Promise<TerminalOperationResult> => changeConfigHost("codex", context, false);

function shellSnippets(posixCommand: string, powerShellCommand: string): { starship: string; tmux: string; ohMyPosh: string } {
  const command = posixCommand + " statusline --host shell";
  return {
    starship: [
      "[custom.openlimiter]", "command = " + JSON.stringify(command),
      'when = "true"', 'shell = ["bash", "--noprofile", "--norc"]',
      'format = "[$output]($style) "'
    ].join("\n"),
    tmux: "set -g status-right " + JSON.stringify("#(" + command + ")") + "\nset -g status-interval 60",
    ohMyPosh: JSON.stringify({ type: "command", properties: {
      command: powerShellCommand + " statusline --host shell", shell: "powershell", cache: { duration: "60s" }
    } }, null, 2)
  };
}

type ShellKind = "bash" | "zsh" | "powershell";
class UnsupportedShellError extends Error {
  constructor(readonly shell: string) { super("Unsupported shell"); }
}

async function shellTarget(context: TerminalHostContext): Promise<{ kind: ShellKind; file: string }> {
  const env = context.environment ?? process.env;
  let executable = env["SHELL"] || "";
  if (!executable && context.platform === "win32" && context.shellRunner) {
    // npm can sit between Node and the interactive shell. Walk ancestors until
    // the actual PowerShell or Unix shell is found, rather than trusting COMSPEC
    // (which remains cmd.exe even inside PowerShell).
    const query = "$ancestorId = " + process.ppid + "; for ($n = 0; $n -lt 12 -and $ancestorId; $n++) { " +
      "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ancestorId); " +
      "if ($p.Name -match '^(pwsh|powershell|bash|zsh)(\\.exe)?$') { $p.ExecutablePath; break }; " +
      "$ancestorId = $p.ParentProcessId }";
    const found = await context.shellRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], POWERSHELL_PROFILE_TIMEOUT_MILLISECONDS);
    if (found.ok) executable = found.stdout.trim();
  }
  const name = path.basename(executable).toLowerCase();
  if (name === "bash" || name === "bash.exe") {
    return { kind: "bash", file: path.join(context.homeDirectory, ".bashrc") };
  }
  if (name === "zsh") {
    return { kind: "zsh", file: path.join(env["ZDOTDIR"] || context.homeDirectory, ".zshrc") };
  }
  if (name === "pwsh" || name === "pwsh.exe" || name === "powershell" || name === "powershell.exe") {
    return { kind: "powershell", file: await resolvePowerShellProfilePath(executable, context.shellRunner) };
  }
  if (name !== "") throw new UnsupportedShellError(name);
  throw new Error("Unsupported shell");
}

function escapedRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function userFunctionExists(text: string, name: string, powershell: boolean): boolean {
  const escaped = escapedRegExp(name);
  return powershell
    ? new RegExp(`(?:^|\\r?\\n)\\s*function\\s+(?:global:)?${escaped}\\b`, "i").test(text)
    : new RegExp(`(?:^|\\r?\\n)\\s*(?:function\\s+)?${escaped}\\s*(?:\\(\\s*\\))?\\s*\\{`).test(text);
}

function uniqueShellName(text: string, base: string, powershell: boolean): string {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}_${suffix + 1}`;
    if (!userFunctionExists(text, candidate, powershell)) return candidate;
  }
}

const MANAGED_SHELL_BLOCK = /(^|\r?\n)# openlimiter managed\r?\n[\s\S]*?\r?\n# end openlimiter managed/g;

function hasManagedShellBlock(text: string): boolean {
  return /(?:^|\r?\n)# openlimiter managed\r?\n[\s\S]*?\r?\n# end openlimiter managed/.test(text);
}

function withoutManagedShellBlock(text: string): string {
  return text.replace(MANAGED_SHELL_BLOCK, "$1");
}

function replaceManagedShellBlock(text: string, snippet: string): string {
  return text.replace(MANAGED_SHELL_BLOCK, `$1${snippet}`);
}

function shellSnippet(kind: ShellKind, command: string, source = ""): string {
  const begin = "# openlimiter managed";
  const end = "# end openlimiter managed";
  const hook = uniqueShellName(source, kind === "powershell" ? "__openlimiter_prompt_hook" : "__openlimiter_statusline", kind === "powershell");
  if (kind === "bash") return [
    begin,
    `if ! declare -F ${hook} >/dev/null 2>&1; then`,
    `  ${hook}() { ${command} statusline --host shell; }`,
    "fi",
    'if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then',
    `  [[ " \${PROMPT_COMMAND[*]} " == *" ${hook} "* ]] || PROMPT_COMMAND+=(${hook})`,
    `elif [[ ";\${PROMPT_COMMAND};" != *";${hook};"* ]]; then`,
    `  PROMPT_COMMAND="\${PROMPT_COMMAND:+\${PROMPT_COMMAND};}${hook}"`,
    "fi", end
  ].join("\n");
  if (kind === "zsh") return [
    begin,
    `if (( ! $+functions[${hook}] )); then`,
    `  ${hook}() { ${command} statusline --host shell; }`,
    "fi",
    "autoload -Uz add-zsh-hook",
    `if (( \${precmd_functions[(I)${hook}]} == 0 )); then add-zsh-hook precmd ${hook}; fi`, end
  ].join("\n");
  const originalPrompt = uniqueShellName(source, "__openlimiter_original_prompt", true);
  const guard = uniqueShellName(source, "__openlimiter_prompt_guard", true);
  return [
    begin,
    `if (-not (Test-Path Function:global:${originalPrompt})) {`,
    `  $function:global:${originalPrompt} = $function:prompt`,
    "}",
    `if (-not (Test-Path Function:global:${hook})) {`,
    `  function global:${hook} {`,
    `    $bar = ${command} statusline --host shell`,
    "    if ($bar) { Write-Host $bar }",
    `    & $function:global:${originalPrompt}`,
    "  }",
    "}",
    `if (-not (Test-Path Function:global:${guard})) {`,
    `  function global:${guard} { & $function:global:${hook} }`,
    "}",
    "function global:prompt {",
    `  & $function:global:${guard}`,
    "}", end
  ].join("\n");
}

async function manualShellSnippetPath(context: TerminalHostContext): Promise<string> {
  const directory = context.stateDirectory ?? path.join(context.homeDirectory, ".openlimiter");
  const file = path.join(directory, "shell-snippet.txt");
  await mkdir(directory, { recursive: true }).then(
    () => writeFileAtomically(file, "openlimiter statusline --host shell\n")
  ).catch(() => undefined);
  return file;
}

export async function installShell(context: TerminalHostContext): Promise<TerminalOperationResult> {
  try {
    const target = await shellTarget(context);
    const original = await readOptional(target.file);
    const runtime = await installLauncher(context.stateDirectory ?? path.join(context.homeDirectory, ".openlimiter"));
    const posixCommand = await fallbackLauncherCommand(runtime, "posix", null);
    const powerShellCommand = await fallbackLauncherCommand(runtime, "powershell", null);
    const command = target.kind === "powershell" ? powerShellCommand : posixCommand;
    const snippets = shellSnippets(posixCommand, powerShellCommand);
    const alreadyOwned = original !== null && await isOwned(target.file, original, ownedMarker(original, false));
    const source = withoutManagedShellBlock(original ?? "");
    const snippet = shellSnippet(target.kind, command, source);
    const marker = original !== null && ownedMarker(original, false);
    if (alreadyOwned || (marker && hasManagedShellBlock(original ?? ""))) {
      const updated = replaceManagedShellBlock(original!, snippet);
      if (updated !== original) {
        await writeOwned(target.file, original, updated);
      }
    } else if (marker) {
      return { ok: false, message: `Could not write ${target.file}.` };
    } else {
      const updated = (original ?? "") + "\n\n" + snippet + "\n";
      await mkdir(path.dirname(target.file), { recursive: true });
      await writeOwned(target.file, original, updated);
    }
    const message = [
      "Wired shell prompt integration.", "",
      "Starship snippet (~/.config/starship.toml):", snippets.starship, "",
      "tmux snippet (~/.tmux.conf):", snippets.tmux, "",
      "Oh My Posh segment:", snippets.ohMyPosh
    ].join("\n");
    return { ok: true, message };
  } catch (error) {
    if (error instanceof UnsupportedShellError) {
      const file = await manualShellSnippetPath(context);
      return { ok: true, message: `Skipped ${error.shell} shell. See ${file} for the manual snippet.` };
    }
    return { ok: false, message: "Could not write configuration." };
  }
}

export async function uninstallShell(context: TerminalHostContext): Promise<TerminalOperationResult> {
  try {
    const target = await shellTarget(context);
    const original = await readOptional(target.file);
    await originalConfiguration(target.file, original);
    if (original !== null) {
      const marker = ownedMarker(original, false);
      const restored = await restoreOwned(target.file, original, marker);
      if (marker && !restored) return { ok: false, message: `Could not update ${target.file}.` };
    }
    return { ok: true, message: "Uninstalled shell prompt integration." };
  } catch {
    return { ok: false, message: "Could not write configuration." };
  }
}

/**
 * The command a Claude Code or Antigravity style status line field carries,
 * whichever of the two shapes it was written in.
 *
 * `null` means the field is absent, which is the only case that counts as
 * nothing being wired at all.
 */
function claudeLikeStatusLineCommand(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const command = (value as Record<string, unknown>)["command"];
    if (typeof command === "string") return command;
  }
  return null;
}

function isOpenLimiterStatuslineCommand(command: string): boolean {
  return /(?:^|[\\/"'\s])openlimiter(?:\.cjs|\.cmd|\.exe|\.sh|\.ps1)?(?=$|[\\/"'\s])/i.test(command) &&
    /\bstatusline\s+--host\s+[A-Za-z0-9_-]+\b/i.test(command);
}

function unwrapOpenLimiterStatuslineCommand(command: string): string | null {
  if (!isOpenLimiterStatuslineCommand(command)) return command;
  const encoded = /\s--wrap\s+([A-Za-z0-9_-]+)/i.exec(command)?.[1];
  return encoded === undefined ? null : decodeWrappedStatuslineCommand(encoded);
}

/** Wired, somebody else's, or nothing there, from the command alone. */
function classifyCommand(command: string | null): string {
  if (command === null) return STATUS_NOT_WIRED;
  return isOpenLimiterStatuslineCommand(command) ? STATUS_WIRED : STATUS_OWN_LINE_FOUND;
}

/** The command inside Grok's `[ui.status_line]` table, or nothing found. */
function grokStatusLineCommand(text: string | null): string | null {
  if (text === null) return null;
  try {
    const parsed = parseToml(text);
    const command = tomlValue(text, ["ui", "status_line", "command"]);
    return typeof command === "string" ? command
      : parsed.tables.some(t => JSON.stringify(t.keys) === '["ui","status_line"]') ? "" : null;
  } catch { return null; }
}

/**
 * Wired, somebody else's, or nothing there, for Codex's `[tui]` table.
 *
 * Codex has no free form command to inspect: the table names a fixed list of
 * built in items instead. So this reads the comment install leaves behind
 * rather than a command string, and falls back to the presence of the
 * `status_line` key itself for a table this build did not write.
 */
function classifyCodexSection(text: string | null): string {
  if (text === null) return STATUS_NOT_WIRED;
  try {
    if (tomlValue(text, ["tui", "status_line"]) === undefined) return STATUS_NOT_WIRED;
    return ownedMarker(text, false) ? STATUS_WIRED : STATUS_OWN_LINE_FOUND;
  } catch { return STATUS_NOT_WIRED; }
}

/**
 * Check wiring status for a host.
 *
 * Three states for every host that can carry somebody else's status line:
 * ours is wired, somebody else's is already there and install would save it
 * rather than overwrite it, or nothing is there at all. The shell host has no
 * wrap to offer, install only ever appends our own snippet, so it stays a
 * plain wired or not.
 */
export async function hostStatus(
  host: string,
  context: TerminalHostContext
): Promise<string> {
  const h = host.toLowerCase();
  if (h === "gemini" || h === "opencode" || h === "kimi") {
    return UNSUPPORTED_HOST_ALTERNATIVE;
  }

  if (h === "claude") {
    let settingsPath: string;
    try { settingsPath = await claudeSettingsPath(context); }
    catch { return STATUS_NOT_WIRED; }
    const settings = await readJsonFile(settingsPath);
    return classifyCommand(
      settings ? claudeLikeStatusLineCommand(settings["statusLine"]) : null
    );
  }

  if (h === "antigravity") {
    const settings = await readJsonFile(antigravitySettingsPath(context));
    return classifyCommand(
      settings ? claudeLikeStatusLineCommand(settings["statusLine"]) : null
    );
  }

  if (h === "grok") {
    const text = await readTextFile(grokConfigPath(context));
    return classifyCommand(grokStatusLineCommand(text));
  }

  if (h === "codex") {
    let configPath: string;
    try { configPath = await codexConfigPath(context); }
    catch { return STATUS_NOT_WIRED; }
    const text = await readTextFile(configPath);
    return classifyCodexSection(text);
  }

  if (h === "shell") {
    try {
      const target = await shellTarget(context);
      const text = await readOptional(target.file);
      return text !== null && await isOwned(target.file, text, ownedMarker(text, false)) ? STATUS_WIRED : STATUS_NOT_WIRED;
    } catch { return STATUS_NOT_WIRED; }
  }

  return STATUS_NOT_WIRED;
}

/**
 * Dispatch installer for a host
 */
export async function installHost(
  host: string,
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const h = host.toLowerCase();
  if (h === "claude") return await installClaude(context);
  if (h === "antigravity") return await installAntigravity(context);
  if (h === "grok") return await installGrok(context);
  if (h === "codex") return await installCodex(context);
  if (h === "shell") return await installShell(context);
  return {
    ok: false,
    message: "Unknown host. Supported hosts: " + TERMINAL_HOST_NAMES.join(", ") + "."
  };
}

/**
 * Dispatch uninstaller for a host
 */
export async function uninstallHost(
  host: string,
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const h = host.toLowerCase();
  if (h === "claude") return await uninstallClaude(context);
  if (h === "antigravity") return await uninstallAntigravity(context);
  if (h === "grok") return await uninstallGrok(context);
  if (h === "codex") return await uninstallCodex(context);
  if (h === "shell") return await uninstallShell(context);
  return {
    ok: false,
    message: "Unknown host. Supported hosts: " + TERMINAL_HOST_NAMES.join(", ") + "."
  };
}

/**
 * Terminal status table
 */
export async function terminalStatusTable(
  context: TerminalHostContext
): Promise<string> {
  const displayHosts = [
    "Claude",
    "Antigravity",
    "Grok",
    "Codex",
    "Gemini",
    "OpenCode",
    "Kimi",
    "Shell"
  ];

  const rows: string[] = [];
  for (const name of displayHosts) {
    const status = await hostStatus(name, context);
    rows.push(`${name}: ${status}`);
  }
  return rows.join("\n");
}

/**
 * The stored configuration, or the defaults, and never a refusal.
 *
 * No configuration file yet is the ordinary state of a machine that has
 * never run `init` or `config set`, not a failure: `terminal show` and
 * `terminal hide` have to work on it the same way every other command in
 * this file reads its configuration (config.ts, `readStatuslineConfig`).
 * `detectedProviders` on the context is what the CLI dispatcher always
 * supplies from a fresh environment scan, so an empty connector list here
 * costs nothing in the one path that matters.
 */
async function loadTerminalConfig(
  context: TerminalHostContext
): Promise<OpenLimiterConfig> {
  const readRes = await readConfig(context.stateDirectory);
  if (readRes.ok) return readRes.config;
  return {
    version: 1,
    connectors: [],
    statusline: DEFAULT_STATUSLINE,
    providers: DEFAULT_PROVIDERS
  };
}

/**
 * Toggle terminal show providers
 */
export async function terminalShow(
  providerIds: readonly string[],
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const config = await loadTerminalConfig(context);

  const detected = new Set(
    (context.detectedProviders ?? config.connectors.filter((c) => c.detected).map((c) => c.id)).map((id) =>
      id.toLowerCase()
    )
  );

  const invalid: string[] = [];
  for (const id of providerIds) {
    const lower = id.toLowerCase();
    if (!detected.has(lower)) {
      invalid.push(lower);
    }
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      message: CONNECT_FIRST_SENTENCE
    };
  }

  const currentShow = [...config.statusline.show];
  for (const id of providerIds) {
    const lower = id.toLowerCase();
    if (!currentShow.includes(lower)) {
      currentShow.push(lower);
    }
  }

  const updatedConfig = {
    ...config,
    statusline: {
      ...config.statusline,
      show: currentShow,
      showMode: "explicit" as const
    }
  };

  try {
    await writeConfig(updatedConfig, context.stateDirectory);
    return {
      ok: true,
      message: "Showing in terminal: " + currentShow.join(", ") + "."
    };
  } catch {
    return { ok: false, message: "Could not write configuration." };
  }
}

/**
 * Toggle terminal hide providers
 */
export async function terminalHide(
  providerIds: readonly string[],
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const config = await loadTerminalConfig(context);

  const detected = new Set(
    (context.detectedProviders ?? config.connectors.filter((c) => c.detected).map((c) => c.id)).map((id) =>
      id.toLowerCase()
    )
  );

  const invalid: string[] = [];
  for (const id of providerIds) {
    const lower = id.toLowerCase();
    if (!detected.has(lower)) {
      invalid.push(lower);
    }
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      message: CONNECT_FIRST_SENTENCE
    };
  }

  let currentShow: string[];
  if (config.statusline.show.length === 0 && config.statusline.showMode !== "explicit") {
    const allProviders = connectors.map((c) => c.id);
    currentShow = allProviders.filter(
      (id) => !providerIds.map((p) => p.toLowerCase()).includes(id.toLowerCase())
    );
  } else {
    currentShow = config.statusline.show.filter(
      (id) => !providerIds.map((p) => p.toLowerCase()).includes(id.toLowerCase())
    );
  }

  const updatedConfig = {
    ...config,
    statusline: {
      ...config.statusline,
      show: currentShow,
      showMode: "explicit" as const
    }
  };

  try {
    await writeConfig(updatedConfig, context.stateDirectory);
    return {
      ok: true,
      message: currentShow.length === 0
        ? "No providers shown in terminal."
        : "Showing in terminal: " + currentShow.join(", ") + "."
    };
  } catch {
    return { ok: false, message: "Could not write configuration." };
  }
}
