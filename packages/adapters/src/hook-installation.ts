import { execFile } from "node:child_process";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, writeFileAtomically } from "@openlimiter/core";
import {
  AGENT_COMPATIBILITY,
  agentVersionCompatibility,
  type AgentId
} from "./stubs.js";

const CONFIG_MAX_BYTES = 1_048_576;
const MANAGED_MARKER_FLAG = "--managed-hook";
const MANAGED_MARKER_VALUE = "openlimiter-v1";
/* One managed handler renders exactly nine arguments, or fifteen when the
   agent executable stamp is pinned. Both counts are part of the shape a
   removal has to recognise, because that shape is the only thing that tells a
   handler this product wrote from a handler that merely quotes its marker. */
const MANAGED_ARGUMENT_COUNT = 9;
const MANAGED_STAMPED_ARGUMENT_COUNT = 15;
const ANTIGRAVITY_KEY = "openlimiter-managed-v1";
const KIMI_BEGIN = "# openlimiter hook begin v1";
const KIMI_END = "# openlimiter hook end v1";
const OPENCODE_MARKER = "// openlimiter experimental hook v1";

export interface HookInstallOptions {
  homeDirectory: string;
  openLimiterScript: string;
  nodeExecutable?: string;
  detectedVersion?: string | null;
  agentExecutable?: string;
  agentFileSize?: number;
  agentMtimeMilliseconds?: number;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}

export interface HookMutationResult {
  agent: AgentId;
  action: "install" | "uninstall";
  changed: boolean;
  supported: boolean;
  configPath: string | null;
  backupPath: string | null;
  version: string | null;
  message: string;
}

interface AgentTarget {
  format: "antigravity" | "json" | "kimi" | "opencode";
  path: string;
  event?: "BeforeAgent" | "UserPromptSubmit";
  timeout?: number;
}

function targetFor(agent: AgentId, home: string): AgentTarget | null {
  if (agent === "claude") {
    return { format: "json", path: path.join(home, ".claude", "settings.json"), event: "UserPromptSubmit", timeout: 1 };
  }
  if (agent === "codex") {
    return { format: "json", path: path.join(home, ".codex", "hooks.json"), event: "UserPromptSubmit", timeout: 1 };
  }
  if (agent === "gemini") {
    return { format: "json", path: path.join(home, ".gemini", "settings.json"), event: "BeforeAgent", timeout: 500 };
  }
  if (agent === "antigravity") {
    return { format: "antigravity", path: path.join(home, ".gemini", "config", "hooks.json"), timeout: 1 };
  }
  if (agent === "kimi") {
    return { format: "kimi", path: path.join(home, ".kimi", "config.toml"), timeout: 1 };
  }
  if (agent === "opencode") {
    return {
      format: "opencode",
      path: path.join(home, ".config", "opencode", "plugins", "openlimiter.js")
    };
  }
  return null;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function pathContainsLink(target: string): Promise<boolean> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

async function rejectReparsePath(target: string, home: string): Promise<void> {
  if (!path.isAbsolute(target) || !within(home, target)) throw new Error("unsafe path");
  const relative = path.relative(path.resolve(home), path.resolve(target));
  let current = path.resolve(home);
  try {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("unsafe path");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error("unsafe path");
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
  }
}

async function rejectExecutable(target: string): Promise<void> {
  if (!path.isAbsolute(target) || await pathContainsLink(target)) {
    throw new Error("unsafe executable");
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe executable");
}

async function readAtMost(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readBounded(file: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    const linked = await lstat(file);
    if (
      !opened.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.size > CONFIG_MAX_BYTES
    ) throw new Error("unsafe config");
    const bytes = await readAtMost(handle, CONFIG_MAX_BYTES);
    if (bytes.byteLength > CONFIG_MAX_BYTES) throw new Error("unsafe config");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("invalid config encoding");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseRoot(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === "") return {};
  const parsed = JSON.parse(text) as unknown;
  const root = record(parsed);
  if (root === null) throw new Error("invalid config");
  return root;
}

function quoteWindows(argument: string): string {
  if (argument !== "" && !/[\s"]/u.test(argument)) return argument;
  let result = "\"";
  let slashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === "\"") {
      result += "\\".repeat(slashes * 2 + 1) + "\"";
      slashes = 0;
      continue;
    }
    result += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  return result + "\\".repeat(slashes * 2) + "\"";
}

function quotePosix(argument: string): string {
  return "'" + argument.replaceAll("'", "'\\''") + "'";
}

export function quoteHookArgument(argument: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? quoteWindows(argument) : quotePosix(argument);
}

function hookCommand(
  agent: AgentId,
  version: string,
  options: HookInstallOptions
): { command: string; argv: string[] } {
  const node = options.nodeExecutable ?? process.execPath;
  const argv = [
    node,
    options.openLimiterScript,
    "hook",
    "--agent",
    agent,
    "--host-version",
    version,
    ...(options.agentExecutable === undefined ||
      options.agentFileSize === undefined ||
      options.agentMtimeMilliseconds === undefined
      ? []
      : [
          "--agent-executable",
          options.agentExecutable,
          "--agent-file-size",
          String(options.agentFileSize),
          "--agent-mtime-ms",
          String(options.agentMtimeMilliseconds)
        ]),
    "--managed-hook",
    "openlimiter-v1"
  ];
  const platform = options.platform ?? process.platform;
  return { command: argv.map((argument) => quoteHookArgument(argument, platform)).join(" "), argv };
}

/**
 * Read a rendered Windows command back into the arguments it was built from.
 *
 * The renderer above joins arguments with exactly one space and quotes only
 * what has to be quoted, so this accepts that grammar and nothing else. A
 * string it cannot account for is not a string this product wrote, and the
 * caller treats that as "not managed" rather than guessing.
 */
function splitWindowsCommand(command: string): string[] | null {
  const argv: string[] = [];
  let index = 0;
  while (index < command.length) {
    if (command[index] === " ") return null;
    let token = "";
    if (command[index] === "\"") {
      index += 1;
      let slashes = 0;
      let closed = false;
      while (index < command.length) {
        const character = command[index]!;
        if (character === "\\") {
          slashes += 1;
          index += 1;
          continue;
        }
        if (character === "\"") {
          index += 1;
          if (slashes % 2 === 1) {
            token += "\\".repeat((slashes - 1) / 2) + "\"";
            slashes = 0;
            continue;
          }
          token += "\\".repeat(slashes / 2);
          closed = true;
          break;
        }
        token += "\\".repeat(slashes) + character;
        slashes = 0;
        index += 1;
      }
      if (!closed) return null;
    } else {
      while (index < command.length && command[index] !== " ") {
        if (command[index] === "\"") return null;
        token += command[index];
        index += 1;
      }
    }
    argv.push(token);
    if (index < command.length) {
      if (command[index] !== " ") return null;
      index += 1;
      if (index >= command.length) return null;
    }
  }
  return argv.length === 0 ? null : argv;
}

/** The same reverse reading for the POSIX single quote grammar. */
function splitPosixCommand(command: string): string[] | null {
  const argv: string[] = [];
  let index = 0;
  while (index < command.length) {
    if (command[index] !== "'") return null;
    index += 1;
    let token = "";
    let closed = false;
    while (index < command.length) {
      if (command[index] === "'") {
        if (command.slice(index, index + 4) === "'\\''") {
          token += "'";
          index += 4;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      token += command[index];
      index += 1;
    }
    if (!closed) return null;
    argv.push(token);
    if (index < command.length) {
      if (command[index] !== " ") return null;
      index += 1;
      if (index >= command.length) return null;
    }
  }
  return argv.length === 0 ? null : argv;
}

function absoluteArgument(value: string | undefined): boolean {
  return value !== undefined && value !== "" &&
    (path.win32.isAbsolute(value) || path.posix.isAbsolute(value));
}

/**
 * Decide whether one argument list is exactly the handler this product installs.
 *
 * Every position is checked: the two absolute executables, the verb, the agent
 * this configuration file belongs to, the host version, the optional pinned
 * stamp, and the marker pair in the final two places. A user command that
 * merely contains the marker text fails at the first position that disagrees,
 * which is what keeps an unrelated hook out of the removal set.
 */
function managedArgv(argv: readonly string[], agent: AgentId): boolean {
  if (
    argv.length !== MANAGED_ARGUMENT_COUNT &&
    argv.length !== MANAGED_STAMPED_ARGUMENT_COUNT
  ) return false;
  if (
    argv[argv.length - 2] !== MANAGED_MARKER_FLAG ||
    argv[argv.length - 1] !== MANAGED_MARKER_VALUE
  ) return false;
  if (!absoluteArgument(argv[0]) || !absoluteArgument(argv[1])) return false;
  if (argv[2] !== "hook" || argv[3] !== "--agent" || argv[4] !== agent) return false;
  const version = argv[6];
  if (
    argv[5] !== "--host-version" ||
    version === undefined ||
    version === "" ||
    /\s/u.test(version)
  ) return false;
  if (argv.length === MANAGED_ARGUMENT_COUNT) return true;
  return argv[7] === "--agent-executable" &&
    absoluteArgument(argv[8]) &&
    argv[9] === "--agent-file-size" &&
    /^\d{1,16}$/u.test(argv[10] ?? "") &&
    argv[11] === "--agent-mtime-ms" &&
    /^\d{1,16}(?:\.\d{1,6})?$/u.test(argv[12] ?? "");
}

/**
 * Recognise one installed handler, by shape rather than by substring.
 *
 * A handler carrying an argument array is compared position by position. A
 * handler carrying a rendered command string is read back through both quoting
 * grammars, because the string on disk was written by whichever platform ran
 * the installation and a removal cannot assume it is the same one.
 */
function managedHandler(value: unknown, agent: AgentId): boolean {
  const handler = record(value);
  if (handler === null) return false;
  const command = handler["command"];
  if (typeof command !== "string" || command === "") return false;
  const args = handler["args"];
  if (args !== undefined) {
    return Array.isArray(args) &&
      args.every((entry) => typeof entry === "string") &&
      managedArgv([command, ...args as string[]], agent);
  }
  return [splitWindowsCommand(command), splitPosixCommand(command)]
    .some((argv) => argv !== null && managedArgv(argv, agent));
}

function jsonHandler(
  agent: AgentId,
  target: AgentTarget,
  command: { command: string; argv: string[] },
  platform: NodeJS.Platform
): Record<string, unknown> {
  if (agent === "claude") {
    return {
      type: "command",
      command: command.argv[0],
      args: command.argv.slice(1),
      timeout: target.timeout
    };
  }
  if (agent === "gemini") {
    return {
      type: "command",
      command: command.command,
      name: "openlimiter",
      description: "OpenLimiter routing context",
      timeout: target.timeout
    };
  }
  return {
    type: "command",
    command: command.command,
    ...(platform === "win32" ? { commandWindows: command.command } : {}),
    timeout: target.timeout,
    additionalContextLimit: 2_400
  };
}

function jsonInstall(
  original: string | null,
  agent: AgentId,
  target: AgentTarget,
  command: { command: string; argv: string[] },
  platform: NodeJS.Platform
): string {
  const root = parseRoot(original);
  const hooks = record(root["hooks"]) ?? {};
  const event = target.event!;
  const groups = Array.isArray(hooks[event]) ? [...hooks[event] as unknown[]] : [];
  const desired = jsonHandler(agent, target, command, platform);
  let found = false;
  let changed = false;
  const updated = groups.flatMap((candidate): unknown[] => {
    const group = record(candidate);
    if (group === null || !Array.isArray(group["hooks"])) return [candidate];
    const handlers: unknown[] = [];
    for (const handler of group["hooks"] as unknown[]) {
      if (!managedHandler(handler, agent)) {
        handlers.push(handler);
      } else if (!found) {
        found = true;
        handlers.push(desired);
        if (canonicalJson(handler) !== canonicalJson(desired)) changed = true;
      } else {
        changed = true;
      }
    }
    return handlers.length === 0 ? [] : [{ ...group, hooks: handlers }];
  });
  if (found && !changed && original !== null) return original;
  if (!found) updated.push({ hooks: [desired] });
  root["hooks"] = { ...hooks, [event]: updated };
  return canonicalJson(root) + "\n";
}

function jsonUninstall(
  original: string | null,
  agent: AgentId,
  target: AgentTarget
): string | null {
  if (original === null) return null;
  const root = parseRoot(original);
  const hooks = record(root["hooks"]);
  if (hooks === null || target.event === undefined || !Array.isArray(hooks[target.event])) {
    return original;
  }
  const groups: unknown[] = [];
  let removed = false;
  for (const candidate of hooks[target.event] as unknown[]) {
    const group = record(candidate);
    if (group === null || !Array.isArray(group["hooks"])) {
      groups.push(candidate);
      continue;
    }
    const handlers = (group["hooks"] as unknown[]).filter((entry) => {
      const managed = managedHandler(entry, agent);
      if (managed) removed = true;
      return !managed;
    });
    if (handlers.length > 0) groups.push({ ...group, hooks: handlers });
  }
  if (!removed) return original;
  root["hooks"] = { ...hooks, [target.event]: groups };
  return canonicalJson(root) + "\n";
}

function antigravityInstall(original: string | null, command: string): string {
  const root = parseRoot(original);
  const managed = record(root[ANTIGRAVITY_KEY]);
  const desired = {
    PreInvocation: [{ type: "command", command, timeout: 1 }]
  };
  if (managed !== null && canonicalJson(managed) === canonicalJson(desired) && original !== null) {
    return original;
  }
  if (
    root[ANTIGRAVITY_KEY] !== undefined &&
    (!Array.isArray(managed?.["PreInvocation"]) ||
      !(managed["PreInvocation"] as unknown[]).some(
        (entry) => managedHandler(entry, "antigravity")
      ))
  ) throw new Error("managed hook name is already in use");
  root[ANTIGRAVITY_KEY] = desired;
  return canonicalJson(root) + "\n";
}

function antigravityUninstall(original: string | null): string | null {
  if (original === null) return null;
  const root = parseRoot(original);
  const managed = record(root[ANTIGRAVITY_KEY]);
  if (managed === null || !Array.isArray(managed["PreInvocation"])) return original;
  const handlers = managed["PreInvocation"] as unknown[];
  if (!handlers.some((entry) => managedHandler(entry, "antigravity"))) return original;
  delete root[ANTIGRAVITY_KEY];
  return canonicalJson(root) + "\n";
}

function kimiBlock(command: string): string {
  return [
    KIMI_BEGIN,
    "[[hooks]]",
    'event = "UserPromptSubmit"',
    "command = " + JSON.stringify(command),
    "timeout = 1",
    KIMI_END
  ].join("\n");
}

function kimiInstall(original: string | null, command: string): string {
  const text = original ?? "";
  const begin = text.indexOf(KIMI_BEGIN);
  const end = text.indexOf(KIMI_END);
  if ((begin >= 0) !== (end >= 0) || (begin >= 0 && end < begin)) {
    throw new Error("damaged managed block");
  }
  const desired = kimiBlock(command);
  if (begin >= 0) {
    const after = end + KIMI_END.length;
    if (text.slice(begin, after) === desired) return text;
    return text.slice(0, begin) + desired + text.slice(after);
  }
  return text + (text === "" || text.endsWith("\n") ? "" : "\n") + desired + "\n";
}

function kimiUninstall(original: string | null): string | null {
  if (original === null) return null;
  const begin = original.indexOf(KIMI_BEGIN);
  const end = original.indexOf(KIMI_END);
  if (begin < 0 && end < 0) return original;
  if (begin < 0 || end < begin) throw new Error("damaged managed block");
  const after = end + KIMI_END.length;
  const consumeNewline = original.slice(after).startsWith("\r\n")
    ? 2
    : original.slice(after).startsWith("\n") ? 1 : 0;
  return original.slice(0, begin) + original.slice(after + consumeNewline);
}

function opencodePlugin(command: { command: string; argv: string[] }): string {
  return [
    OPENCODE_MARKER,
    "export const OpenLimiter = async ({ directory }) => ({",
    '  "experimental.chat.system.transform": async (input, output) => {',
    '    if (process.env.OPENLIMITER_EXPERIMENTAL_OPENCODE !== "1") return;',
    "    const child = Bun.spawn({",
    "      cmd: " + JSON.stringify(command.argv) + ",",
    '      stdin: new Blob([JSON.stringify({ hook_event_name: "OpenCodeSystemTransform", session_id: input.sessionID, cwd: directory })]),',
    '      stdout: "pipe",',
    '      stderr: "ignore"',
    "    });",
    "    const timer = setTimeout(() => child.kill(), 500);",
    "    try {",
    "      const text = await new Response(child.stdout).text();",
    "      if ((await child.exited) === 0 && text.startsWith(\"<openlimiter_untrusted_data version=\\\"1\\\">\")) output.system.push(text.trim());",
    "    } finally { clearTimeout(timer); }",
    "  }",
    "});",
    ""
  ].join("\n");
}

async function backup(file: string, original: string | null): Promise<string | null> {
  if (original === null) return null;
  const backupPath = file + ".openlimiter.bak";
  const existing = await readBounded(backupPath);
  if (existing === null) await writeFileAtomically(backupPath, original);
  return backupPath;
}

async function mutate(
  agent: AgentId,
  action: "install" | "uninstall",
  version: string,
  options: HookInstallOptions,
  target: AgentTarget
): Promise<{ changed: boolean; backupPath: string | null }> {
  await rejectReparsePath(target.path, options.homeDirectory);
  if (action === "install") {
    await rejectExecutable(options.openLimiterScript);
    await rejectExecutable(options.nodeExecutable ?? process.execPath);
    if (options.agentExecutable !== undefined) {
      await rejectExecutable(options.agentExecutable);
    }
    await mkdir(path.dirname(target.path), { recursive: true, mode: 0o700 });
    await rejectReparsePath(target.path, options.homeDirectory);
  }
  const original = await readBounded(target.path);
  const command = hookCommand(agent, version, options);
  let next: string | null;
  if (target.format === "json") {
    next = action === "install"
      ? jsonInstall(
          original,
          agent,
          target,
          command,
          options.platform ?? process.platform
        )
      : jsonUninstall(original, agent, target);
  } else if (target.format === "antigravity") {
    next = action === "install"
      ? antigravityInstall(original, command.command)
      : antigravityUninstall(original);
  } else if (target.format === "kimi") {
    next = action === "install"
      ? kimiInstall(original, command.command)
      : kimiUninstall(original);
  } else {
    if (
      action === "install" &&
      original !== null &&
      !original.startsWith(OPENCODE_MARKER)
    ) throw new Error("OpenCode plugin path is already in use");
    next = action === "install" ? opencodePlugin(command) : original;
    if (action === "uninstall" && original?.startsWith(OPENCODE_MARKER) === true) next = "";
  }
  if (next === original || (original === null && (next === null || next === ""))) {
    return { changed: false, backupPath: null };
  }
  const backupPath = await backup(target.path, original);
  if (
    target.format === "opencode" &&
    action === "uninstall" &&
    original?.startsWith(OPENCODE_MARKER) === true
  ) {
    await unlink(target.path);
    return { changed: true, backupPath };
  }
  if (next !== null) await writeFileAtomically(target.path, next);
  return { changed: true, backupPath };
}

const executableNames: Readonly<Partial<Record<AgentId, string>>> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  antigravity: "agy",
  kimi: "kimi",
  opencode: "opencode",
  grok: "grok"
};

export interface AgentInstallation {
  version: string;
  executable: string;
  fileSize: number;
  mtimeMilliseconds: number;
}

async function resolvedAgentExecutable(
  agent: AgentId,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): Promise<string | null> {
  const name = executableNames[agent];
  if (name === undefined) return null;
  const pathText = environment[platform === "win32" ? "Path" : "PATH"] ??
    environment["PATH"] ?? environment["Path"] ?? "";
  const extensions = platform === "win32"
    ? (environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const delimiter = platform === "win32" ? ";" : ":";
  for (const rawDirectory of pathText.split(delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/gu, "");
    if (directory === "" || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, name + extension.toLowerCase());
      const alternatives = extension === extension.toLowerCase()
        ? [candidate]
        : [candidate, path.resolve(directory, name + extension)];
      for (const file of alternatives) {
        try {
          const stat = await lstat(file);
          if (
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            !(await pathContainsLink(file))
          ) return file;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") continue;
        }
      }
    }
  }
  return null;
}

async function executableVersion(executable: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    try {
      execFile(
        executable,
        ["--version"],
        { windowsHide: true, timeout: 1_000, shell: false, maxBuffer: 16_384 },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          const match = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/u.exec(stdout + " " + stderr);
          resolve(match?.[1] ?? null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

export async function detectAgentInstallation(
  agent: AgentId,
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
  } = {}
): Promise<AgentInstallation | null> {
  const platform = options.platform ?? process.platform;
  const executable = await resolvedAgentExecutable(
    agent,
    options.environment ?? process.env,
    platform
  );
  if (executable === null) return null;
  const version = await executableVersion(executable);
  if (version === null) return null;
  try {
    const stat = await lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return {
      version,
      executable,
      fileSize: stat.size,
      mtimeMilliseconds: stat.mtimeMs
    };
  } catch {
    return null;
  }
}

export async function detectAgentVersion(agent: AgentId): Promise<string | null> {
  return (await detectAgentInstallation(agent))?.version ?? null;
}

export async function validateAgentExecutableStamp(
  executable: string,
  fileSize: number,
  mtimeMilliseconds: number
): Promise<boolean> {
  if (
    !path.isAbsolute(executable) ||
    !Number.isSafeInteger(fileSize) ||
    fileSize < 1 ||
    !Number.isFinite(mtimeMilliseconds) ||
    mtimeMilliseconds < 0
  ) return false;
  try {
    const stat = await lstat(executable);
    return stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size === fileSize &&
      stat.mtimeMs === mtimeMilliseconds;
  } catch {
    return false;
  }
}

function unsupported(
  agent: AgentId,
  action: "install" | "uninstall",
  version: string | null,
  target: AgentTarget | null,
  message: string
): HookMutationResult {
  return {
    agent,
    action,
    changed: false,
    supported: false,
    configPath: target?.path ?? null,
    backupPath: null,
    version,
    message
  };
}

export async function changeAgentHook(
  agent: AgentId,
  action: "install" | "uninstall",
  options: HookInstallOptions
): Promise<HookMutationResult> {
  const target = targetFor(agent, options.homeDirectory);
  if (target === null) {
    return unsupported(agent, action, null, null, "Grok Build discards hook stdout; use openlimiter status --agent-context.");
  }
  const detectionOptions = {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.platform === undefined ? {} : { platform: options.platform })
  };
  const detected = action === "uninstall"
    ? null
    : options.detectedVersion === undefined
    ? await detectAgentInstallation(agent, detectionOptions)
    : options.detectedVersion === null ||
      options.agentExecutable === undefined ||
      options.agentFileSize === undefined ||
      options.agentMtimeMilliseconds === undefined
      ? null
      : {
          version: options.detectedVersion,
          executable: options.agentExecutable,
          fileSize: options.agentFileSize,
          mtimeMilliseconds: options.agentMtimeMilliseconds
        };
  const version = detected?.version ?? options.detectedVersion ?? null;
  if (action === "install") {
    const gate = AGENT_COMPATIBILITY[agent];
    if (gate.launchState === "excluded") {
      return unsupported(agent, action, version, target, "Dynamic injection is excluded for this agent.");
    }
    if (gate.launchState === "gated") {
      return unsupported(agent, action, version, target, "This agent has no passing Windows live fixture for installation.");
    }
    if (
      gate.launchState === "experimental" &&
      options.environment?.["OPENLIMITER_EXPERIMENTAL_OPENCODE"] !== "1"
    ) {
      return unsupported(agent, action, version, target, "Experimental OpenCode support is disabled.");
    }
    if (
      version === null ||
      !["supported", "newer"].includes(agentVersionCompatibility(agent, version))
    ) {
      return unsupported(agent, action, version, target, "The detected agent version is older than the minimum tested version or is not a valid release version.");
    }
    if (detected === null) {
      return unsupported(agent, action, version, target, "The agent executable could not be pinned safely.");
    }
  }
  try {
    const mutationOptions = detected === null
      ? options
      : {
          ...options,
          agentExecutable: detected.executable,
          agentFileSize: detected.fileSize,
          agentMtimeMilliseconds: detected.mtimeMilliseconds
        };
    const changed = await mutate(
      agent,
      action,
      version ?? "unknown",
      mutationOptions,
      target
    );
    return {
      agent,
      action,
      changed: changed.changed,
      supported: true,
      configPath: target.path,
      backupPath: changed.backupPath,
      version,
      message: changed.changed ? "Configuration changed atomically." : "Configuration already matched the requested state."
    };
  } catch {
    return unsupported(agent, action, version, target, "Configuration was rejected as unreadable or unsafe.");
  }
}

/** Exercise an unapproved host fixture without weakening the production compatibility gate. */
export async function changeAgentHookFixture(
  agent: AgentId,
  action: "install" | "uninstall",
  options: HookInstallOptions
): Promise<HookMutationResult> {
  const target = targetFor(agent, options.homeDirectory);
  const version = options.detectedVersion ?? "fixture";
  if (target === null) {
    return unsupported(agent, action, version, null, "This agent has no hook configuration target.");
  }
  try {
    const result = await mutate(agent, action, version, options, target);
    return {
      agent,
      action,
      changed: result.changed,
      supported: true,
      configPath: target.path,
      backupPath: result.backupPath,
      version,
      message: result.changed ? "Fixture configuration changed." : "Fixture configuration was unchanged."
    };
  } catch {
    return unsupported(agent, action, version, target, "Fixture configuration was rejected.");
  }
}

export async function readAgentHookStatus(
  agent: AgentId,
  options: Pick<HookInstallOptions, "homeDirectory">
): Promise<{ configPath: string | null; installed: boolean }> {
  const target = targetFor(agent, options.homeDirectory);
  if (target === null) return { configPath: null, installed: false };
  try {
    await rejectReparsePath(target.path, options.homeDirectory);
    const text = await readBounded(target.path);
    if (text === null) return { configPath: target.path, installed: false };
    let installed = false;
    if (target.format === "kimi") {
      installed = text.includes(KIMI_BEGIN) && text.includes(KIMI_END);
    } else if (target.format === "opencode") {
      installed = text.startsWith(OPENCODE_MARKER);
    } else if (target.format === "antigravity") {
      const root = parseRoot(text);
      const definition = record(root[ANTIGRAVITY_KEY]);
      installed = Array.isArray(definition?.["PreInvocation"]) &&
        (definition["PreInvocation"] as unknown[]).some(
          (entry) => managedHandler(entry, agent)
        );
    } else {
      const root = parseRoot(text);
      const hooks = record(root["hooks"]);
      const groups = target.event === undefined ? null : hooks?.[target.event];
      installed = Array.isArray(groups) && groups.some((candidate) => {
        const group = record(candidate);
        return Array.isArray(group?.["hooks"]) &&
          (group["hooks"] as unknown[]).some(
            (entry) => managedHandler(entry, agent)
          );
      });
    }
    return {
      configPath: target.path,
      installed
    };
  } catch {
    return { configPath: target.path, installed: false };
  }
}
