import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { connectors } from "@openlimiter/connectors";
import { type CredentialCommandRunner } from "@openlimiter/core";
import {
  DEFAULT_PROVIDERS,
  DEFAULT_STATUSLINE,
  readConfig,
  writeConfig,
  type OpenLimiterConfig
} from "./config.js";
import {
  encodeWrappedStatuslineCommand
} from "./statusline-wrapper.js";

import { parseToml, editToml, tomlValue } from "./terminal-toml.js";
import { installLauncher, launcherCommand } from "./terminal-launcher.js";
import { isOwned, readOptional, restoreOwned, writeOwned } from "./terminal-backup.js";

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
 * behaves differently in each case, wrapping the first and writing the second
 * fresh. Saying "Not installed" for both, as this used to, told a person
 * nothing about which one they were looking at.
 */
export const STATUS_OWN_LINE_FOUND = "Your own status line found, install wraps it";
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
}

export interface TerminalOperationResult {
  ok: boolean;
  message: string;
}

function claudeSettingsPath(context: TerminalHostContext): string {
  return path.join(context.environment?.["CLAUDE_CONFIG_DIR"] || path.join(context.homeDirectory, ".claude"), "settings.json");
}
function antigravitySettingsPath(context: TerminalHostContext): string {
  return path.join(context.homeDirectory, ".gemini", "antigravity-cli", "settings.json");
}
function grokConfigPath(context: TerminalHostContext): string {
  return path.join(context.homeDirectory, ".grok", "config.toml");
}
function codexConfigPath(context: TerminalHostContext): string {
  return path.join(context.environment?.["CODEX_HOME"] || path.join(context.homeDirectory, ".codex"), "config.toml");
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

async function durableCommand(context: TerminalHostContext, shell: "posix" | "cmd" | "powershell"): Promise<string> {
  const runtime = await installLauncher(context.stateDirectory ?? path.join(context.homeDirectory, ".openlimiter"));
  return launcherCommand(runtime, shell);
}

function ownedMarker(text: string, json: boolean): boolean {
  return json ? JSON.parse(text)["openlimiter managed"] === true
    : text.split(/\r?\n/).some(line => line.trim() === "# openlimiter managed");
}

async function changeConfigHost(host: ConfigHost, context: TerminalHostContext, install: boolean): Promise<TerminalOperationResult> {
  const spec = HOST_CONFIG[host];
  const file = spec.path(context);
  const read = spec.json ? await readJsonConfig(file) : await readTomlConfig(file);
  if (read.kind === "parse_error") return { ok: false, message: `Could not read ${file}, fix it or move it aside` };
  try {
    const original = await readOptional(file);
    const text = original ?? (spec.json ? "{}" : "");
    const marker = ownedMarker(text, spec.json);
    if (!install) {
      const restored = original !== null && await restoreOwned(file, original, marker);
      if (marker && !restored) return { ok: false, message: `Could not update ${spec.file}.` };
      return { ok: true, message: restored ? `Uninstalled ${spec.label} status line.` : `${spec.label} status line is not installed.` };
    }
    if (original !== null && await isOwned(file, original, marker)) {
      if (host !== "codex") await durableCommand(context, context.platform === "win32" ? "cmd" : "posix");
      return { ok: true, message: spec.wired };
    }
    if (marker) return { ok: false, message: `Could not write ${spec.file}.` };
    // A marker alone never authorizes adoption of a configuration or replacement
    // of its backup. Matching the complete saved result also protects later edits.
    let updated: string;
    if (spec.json) {
      const data = JSON.parse(text) as Record<string, unknown>;
      const previous = claudeLikeStatusLineCommand(data["statusLine"]);
      const base = await durableCommand(context, context.platform === "win32" ? "cmd" : "posix");
      const command = `${base} statusline --host ${host}` +
        (previous === null ? "" : ` --wrap ${encodeWrappedStatuslineCommand(previous)}`);
      data["openlimiter managed"] = true;
      data["statusLine"] = host === "claude" ? { type: "command", command } : command;
      updated = JSON.stringify(data, null, 2) + "\n";
      JSON.parse(updated);
    } else if (host === "codex") {
      updated = editToml(text, ["tui"], { status_line: CODEX_ITEMS, status_line_use_colors: true });
    } else {
      const previous = tomlValue(text, ["ui", "status_line", "command"]);
      const base = await durableCommand(context, context.platform === "win32" ? "cmd" : "posix");
      const command = `${base} statusline --host grok` +
        (typeof previous === "string" ? ` --wrap ${encodeWrappedStatuslineCommand(previous)}` : "");
      updated = editToml(text, ["ui", "status_line"], { type: "command", command });
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeOwned(file, original, updated);
    return { ok: true, message: spec.wired };
  } catch {
    return { ok: false, message: `Could not ${install ? "write" : "update"} ${spec.file}.` };
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
  throw new Error("Unsupported shell");
}

function shellSnippet(kind: ShellKind, command: string): string {
  const begin = "# openlimiter managed";
  const end = "# end openlimiter managed";
  if (kind === "bash") return [
    begin,
    "_openlimiter_statusline() { " + command + " statusline --host shell; }",
    'if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then',
    '  [[ " ${PROMPT_COMMAND[*]} " == *" _openlimiter_statusline "* ]] || PROMPT_COMMAND+=(_openlimiter_statusline)',
    'elif [[ ";${PROMPT_COMMAND};" != *";_openlimiter_statusline;"* ]]; then',
    '  PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND};}_openlimiter_statusline"',
    "fi", end
  ].join("\n");
  if (kind === "zsh") return [
    begin, "_openlimiter_statusline() { " + command + " statusline --host shell; }",
    "autoload -Uz add-zsh-hook", "add-zsh-hook precmd _openlimiter_statusline", end
  ].join("\n");
  return [
    begin,
    "if (-not (Test-Path Function:global:OpenLimiterOriginalPrompt)) {",
    "  $function:global:OpenLimiterOriginalPrompt = $function:prompt",
    "}",
    "function global:prompt {",
    "  $bar = " + command + " statusline --host shell",
    "  if ($bar) { Write-Host $bar }",
    "  & $function:global:OpenLimiterOriginalPrompt",
    "}", end
  ].join("\n");
}

export async function installShell(context: TerminalHostContext): Promise<TerminalOperationResult> {
  try {
    const target = await shellTarget(context);
    const original = await readOptional(target.file);
    const runtime = await installLauncher(context.stateDirectory ?? path.join(context.homeDirectory, ".openlimiter"));
    const posixCommand = launcherCommand(runtime, "posix");
    const powerShellCommand = launcherCommand(runtime, "powershell");
    const command = target.kind === "powershell" ? powerShellCommand : posixCommand;
    const snippets = shellSnippets(posixCommand, powerShellCommand);
    const alreadyOwned = original !== null && await isOwned(target.file, original, ownedMarker(original, false));
    if (!alreadyOwned) {
      const updated = (original ?? "") + "\n\n" + shellSnippet(target.kind, command) + "\n";
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
  } catch {
    return { ok: false, message: "Could not write configuration." };
  }
}

export async function uninstallShell(context: TerminalHostContext): Promise<TerminalOperationResult> {
  try {
    const target = await shellTarget(context);
    const original = await readOptional(target.file);
    if (original !== null) {
      const marker = ownedMarker(original, false);
      const restored = await restoreOwned(target.file, original, marker);
      if (marker && !restored) return { ok: false, message: "Could not write configuration." };
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

/** Wired, somebody else's, or nothing there, from the command alone. */
function classifyCommand(command: string | null): string {
  if (command === null) return STATUS_NOT_WIRED;
  return (command.includes("openlimiter statusline") || (command.includes("openlimiter.cjs") && command.includes(" statusline "))) ? STATUS_WIRED : STATUS_OWN_LINE_FOUND;
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
 * ours is wired, somebody else's is already there and install would wrap it
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
    const settings = await readJsonFile(claudeSettingsPath(context));
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
    const text = await readTextFile(codexConfigPath(context));
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
