import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { connectors } from "@openlimiter/connectors";
import {
  DEFAULT_PROVIDERS,
  DEFAULT_STATUSLINE,
  readConfig,
  writeConfig,
  type OpenLimiterConfig,
  type StatuslineConfig
} from "./config.js";
import {
  decodeWrappedStatuslineCommand,
  encodeWrappedStatuslineCommand
} from "./statusline-wrapper.js";
import { isStatuslineHost, type StatuslineHost } from "./statusline.js";

export const TERMINAL_HOST_NAMES: readonly string[] = [
  "claude",
  "antigravity",
  "grok",
  "codex",
  "shell"
];

export const UNSUPPORTED_HOST_ALTERNATIVE =
  "No status line support with the shell alternative";

export const STATUS_WIRED = "Wired";
export const STATUS_NOT_INSTALLED = "Not installed";
export const CONNECT_FIRST_SENTENCE = "Connect it first";

export interface TerminalHostContext {
  homeDirectory: string;
  stateDirectory?: string;
  platform: NodeJS.Platform;
  detectedProviders?: readonly string[];
}

export interface TerminalOperationResult {
  ok: boolean;
  message: string;
}

function claudeSettingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

function antigravitySettingsPath(home: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

function grokConfigPath(home: string): string {
  return path.join(home, ".grok", "config.toml");
}

function codexConfigPath(home: string): string {
  return path.join(home, ".codex", "config.toml");
}

function powerShellProfilePath(home: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return path.join(
      home,
      "Documents",
      "WindowsPowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
  }
  return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeJsonFile(
  filePath: string,
  data: Record<string, unknown>
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeTextFile(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

/**
 * Install status line into Claude Code ~/.claude/settings.json
 */
export async function installClaude(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const settingsFile = claudeSettingsPath(context.homeDirectory);
  const existing = (await readJsonFile(settingsFile)) ?? {};
  const currentStatusLine = existing["statusLine"];

  let existingCommand: string | null = null;
  if (typeof currentStatusLine === "object" && currentStatusLine !== null) {
    const cmd = (currentStatusLine as Record<string, unknown>)["command"];
    if (typeof cmd === "string") existingCommand = cmd;
  } else if (typeof currentStatusLine === "string") {
    existingCommand = currentStatusLine;
  }

  /*
   * A command that already runs us, wrapped or not, is left exactly as it
   * is: re-running install must never re-wrap an already wrapped command,
   * and must never fall back to the bare default and silently drop the
   * user's original status line the wrap exists to protect.
   */
  let commandToSet = "openlimiter statusline --host claude";
  if (existingCommand !== null) {
    commandToSet = existingCommand.includes("openlimiter statusline")
      ? existingCommand
      : `openlimiter statusline --host claude --wrap ${encodeWrappedStatuslineCommand(existingCommand)}`;
  }

  existing["statusLine"] = {
    type: "command",
    command: commandToSet
  };

  try {
    await writeJsonFile(settingsFile, existing);
    return { ok: true, message: "Wired Claude Code status line." };
  } catch {
    return { ok: false, message: "Could not write Claude Code settings." };
  }
}

export async function uninstallClaude(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const settingsFile = claudeSettingsPath(context.homeDirectory);
  const existing = await readJsonFile(settingsFile);
  if (!existing || !existing["statusLine"]) {
    return { ok: true, message: "Claude Code status line is not installed." };
  }

  const current = existing["statusLine"];
  let cmd: string | null = null;
  if (typeof current === "object" && current !== null) {
    const c = (current as Record<string, unknown>)["command"];
    if (typeof c === "string") cmd = c;
  } else if (typeof current === "string") {
    cmd = current;
  }

  if (cmd !== null && cmd.includes("--wrap")) {
    const match = /--wrap\s+([A-Za-z0-9_-]+)/.exec(cmd);
    const restored = match?.[1] ? decodeWrappedStatuslineCommand(match[1]) : null;
    if (restored !== null) {
      existing["statusLine"] = {
        type: "command",
        command: restored
      };
      await writeJsonFile(settingsFile, existing);
      return { ok: true, message: "Restored original Claude Code status line." };
    }
  }

  delete existing["statusLine"];
  try {
    await writeJsonFile(settingsFile, existing);
    return { ok: true, message: "Uninstalled Claude Code status line." };
  } catch {
    return { ok: false, message: "Could not update Claude Code settings." };
  }
}

/**
 * Install status line into Antigravity ~/.gemini/antigravity-cli/settings.json
 */
export async function installAntigravity(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const settingsFile = antigravitySettingsPath(context.homeDirectory);
  const existing = (await readJsonFile(settingsFile)) ?? {};
  const current = existing["statusLine"];

  let existingCommand: string | null = null;
  if (typeof current === "string") {
    existingCommand = current;
  } else if (typeof current === "object" && current !== null) {
    const cmd = (current as Record<string, unknown>)["command"];
    if (typeof cmd === "string") existingCommand = cmd;
  }

  /* See installClaude: an already installed command, wrapped or not, is
     left exactly as it is on a second install. */
  let commandToSet = "openlimiter statusline --host antigravity";
  if (existingCommand !== null) {
    commandToSet = existingCommand.includes("openlimiter statusline")
      ? existingCommand
      : `openlimiter statusline --host antigravity --wrap ${encodeWrappedStatuslineCommand(existingCommand)}`;
  }

  existing["statusLine"] = commandToSet;

  try {
    await writeJsonFile(settingsFile, existing);
    return { ok: true, message: "Wired Antigravity CLI status line." };
  } catch {
    return { ok: false, message: "Could not write Antigravity settings." };
  }
}

export async function uninstallAntigravity(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const settingsFile = antigravitySettingsPath(context.homeDirectory);
  const existing = await readJsonFile(settingsFile);
  if (!existing || !existing["statusLine"]) {
    return { ok: true, message: "Antigravity status line is not installed." };
  }

  const current = existing["statusLine"];
  let cmd: string | null = null;
  if (typeof current === "string") {
    cmd = current;
  } else if (typeof current === "object" && current !== null) {
    const c = (current as Record<string, unknown>)["command"];
    if (typeof c === "string") cmd = c;
  }

  if (cmd !== null && cmd.includes("--wrap")) {
    const match = /--wrap\s+([A-Za-z0-9_-]+)/.exec(cmd);
    const restored = match?.[1] ? decodeWrappedStatuslineCommand(match[1]) : null;
    if (restored !== null) {
      existing["statusLine"] = restored;
      await writeJsonFile(settingsFile, existing);
      return { ok: true, message: "Restored original Antigravity status line." };
    }
  }

  delete existing["statusLine"];
  try {
    await writeJsonFile(settingsFile, existing);
    return { ok: true, message: "Uninstalled Antigravity status line." };
  } catch {
    return { ok: false, message: "Could not update Antigravity settings." };
  }
}

/**
 * Install status line into Grok Build ~/.grok/config.toml
 */
export async function installGrok(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const configFile = grokConfigPath(context.homeDirectory);
  const text = (await readTextFile(configFile)) ?? "";

  let existingCommand: string | null = null;
  const match = /command\s*=\s*"([^"]+)"/.exec(text);
  if (match && match[1]) {
    existingCommand = match[1];
  }

  /* See installClaude: an already installed command, wrapped or not, is
     left exactly as it is on a second install. */
  let commandToSet = "openlimiter statusline --host grok";
  if (existingCommand !== null) {
    commandToSet = existingCommand.includes("openlimiter statusline")
      ? existingCommand
      : `openlimiter statusline --host grok --wrap ${encodeWrappedStatuslineCommand(existingCommand)}`;
  }

  const statusLineSection = [
    "[ui.status_line]",
    'type = "command"',
    `command = "${commandToSet}"`
  ].join("\n");

  let updated: string;
  if (text.includes("[ui.status_line]")) {
    /*
     * Matches up to the next top level table header (a "[" that starts its
     * own line) or the end of the file, never up to the next "[" anywhere:
     * Grok's own documented config carries an `items` array, and a value
     * with a bracket in it is exactly the shape `[^\[]*` truncates on.
     */
    updated = text.replace(/\[ui\.status_line\][\s\S]*?(?=\n\[|$)/, statusLineSection + "\n");
  } else {
    updated = text ? text.trimEnd() + "\n\n" + statusLineSection + "\n" : statusLineSection + "\n";
  }

  try {
    await writeTextFile(configFile, updated);
    return { ok: true, message: "Wired Grok Build status line." };
  } catch {
    return { ok: false, message: "Could not write Grok config." };
  }
}

export async function uninstallGrok(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const configFile = grokConfigPath(context.homeDirectory);
  const text = await readTextFile(configFile);
  if (!text || !text.includes("[ui.status_line]")) {
    return { ok: true, message: "Grok status line is not installed." };
  }

  const updated = text.replace(/\[ui\.status_line\][\s\S]*?(?=\n\[|$)/, "").trimEnd() + "\n";
  try {
    await writeTextFile(configFile, updated);
    return { ok: true, message: "Uninstalled Grok status line." };
  } catch {
    return { ok: false, message: "Could not update Grok config." };
  }
}

/**
 * Install built in status line items into Codex ~/.codex/config.toml
 */
export async function installCodex(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const configFile = codexConfigPath(context.homeDirectory);
  const text = (await readTextFile(configFile)) ?? "";

  const codexSection = [
    "[tui]",
    'status_line = ["five-hour-limit", "weekly-limit", "context-used", "model-with-reasoning", "current-dir"]',
    "status_line_use_colors = true"
  ].join("\n");

  let updated: string;
  if (text.includes("[tui]")) {
    /* See installGrok: matches up to the next top level table header or the
       end of the file, never up to the next "[" anywhere, because the
       status_line array this build writes carries brackets of its own. */
    updated = text.replace(/\[tui\][\s\S]*?(?=\n\[|$)/, codexSection + "\n");
  } else {
    updated = text ? text.trimEnd() + "\n\n" + codexSection + "\n" : codexSection + "\n";
  }

  try {
    await writeTextFile(configFile, updated);
    return { ok: true, message: "Wired Codex status line." };
  } catch {
    return { ok: false, message: "Could not write Codex config." };
  }
}

export async function uninstallCodex(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const configFile = codexConfigPath(context.homeDirectory);
  const text = await readTextFile(configFile);
  if (!text || !text.includes("[tui]")) {
    return { ok: true, message: "Codex status line is not installed." };
  }

  const updated = text.replace(/\[tui\][\s\S]*?(?=\n\[|$)/, "").trimEnd() + "\n";
  try {
    await writeTextFile(configFile, updated);
    return { ok: true, message: "Uninstalled Codex status line." };
  } catch {
    return { ok: false, message: "Could not update Codex config." };
  }
}

export const SHELL_SNIPPETS = {
  starship: [
    "[custom.openlimiter]",
    'command = "openlimiter statusline --host shell"',
    'when = "true"',
    'shell = ["bash", "--noprofile", "--norc"]',
    'format = "[$output]($style) "'
  ].join("\n"),

  ohMyPosh: [
    "{",
    '  "type": "command",',
    '  "properties": {',
    '    "command": "openlimiter statusline --host shell",',
    '    "cache": { "duration": "60s" }',
    "  }",
    "}"
  ].join("\n"),

  tmux: "set -g status-right '#(openlimiter statusline --host shell)'\nset -g status-interval 60",

  powerShell: [
    "# OpenLimiter status line snippet",
    "function prompt {",
    "  $bar = openlimiter statusline --host shell",
    "  if ($bar) { Write-Host $bar }",
    "  \"PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) \"",
    "}"
  ].join("\n")
};

/**
 * Install shell prompt integration
 */
export async function installShell(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const profileFile = powerShellProfilePath(context.homeDirectory, context.platform);
  const existing = (await readTextFile(profileFile)) ?? "";

  if (!existing.includes("openlimiter statusline")) {
    const toAppend = "\n\n" + SHELL_SNIPPETS.powerShell + "\n";
    try {
      await writeTextFile(profileFile, existing + toAppend);
    } catch {
      // Writing profile is optional, snippets are still printed
    }
  }

  const message = [
    "Wired shell prompt integration.",
    "",
    "Starship snippet (~/.config/starship.toml):",
    SHELL_SNIPPETS.starship,
    "",
    "tmux snippet (~/.tmux.conf):",
    SHELL_SNIPPETS.tmux,
    "",
    "Oh My Posh segment:",
    SHELL_SNIPPETS.ohMyPosh
  ].join("\n");

  return { ok: true, message };
}

export async function uninstallShell(
  context: TerminalHostContext
): Promise<TerminalOperationResult> {
  const profileFile = powerShellProfilePath(context.homeDirectory, context.platform);
  const existing = await readTextFile(profileFile);
  if (existing && existing.includes("openlimiter statusline")) {
    const updated = existing
      .replace(/# OpenLimiter status line snippet[\s\S]*?^}/m, "")
      .trimEnd() + "\n";
    try {
      await writeTextFile(profileFile, updated);
    } catch {
      // Ignored
    }
  }
  return { ok: true, message: "Uninstalled shell prompt integration." };
}

/**
 * Check wiring status for a host
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
    const settings = await readJsonFile(claudeSettingsPath(context.homeDirectory));
    if (settings && settings["statusLine"]) {
      const sl = settings["statusLine"];
      if (typeof sl === "object" && sl !== null) {
        const cmd = (sl as Record<string, unknown>)["command"];
        if (typeof cmd === "string" && cmd.includes("openlimiter statusline")) {
          return STATUS_WIRED;
        }
      }
    }
    return STATUS_NOT_INSTALLED;
  }

  if (h === "antigravity") {
    const settings = await readJsonFile(antigravitySettingsPath(context.homeDirectory));
    if (settings && settings["statusLine"]) {
      const sl = settings["statusLine"];
      if (typeof sl === "string" && sl.includes("openlimiter statusline")) {
        return STATUS_WIRED;
      }
    }
    return STATUS_NOT_INSTALLED;
  }

  if (h === "grok") {
    const text = await readTextFile(grokConfigPath(context.homeDirectory));
    if (text && text.includes("openlimiter statusline")) {
      return STATUS_WIRED;
    }
    return STATUS_NOT_INSTALLED;
  }

  if (h === "codex") {
    const text = await readTextFile(codexConfigPath(context.homeDirectory));
    if (text && text.includes("[tui]") && text.includes("status_line")) {
      return STATUS_WIRED;
    }
    return STATUS_NOT_INSTALLED;
  }

  if (h === "shell") {
    const text = await readTextFile(powerShellProfilePath(context.homeDirectory, context.platform));
    if (text && text.includes("openlimiter statusline")) {
      return STATUS_WIRED;
    }
    return STATUS_NOT_INSTALLED;
  }

  return STATUS_NOT_INSTALLED;
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
      show: currentShow
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

  let currentShow: string[];
  if (config.statusline.show.length === 0) {
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
      show: currentShow
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
