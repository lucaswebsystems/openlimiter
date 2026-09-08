/**
 * The one sign in this build spawns on somebody's behalf, ported from the
 * desktop's own implementation.
 *
 * `apps/desktop/src-tauri/src/codex_device_login.rs` is the reference for
 * every rule here: only Codex, because its client is Apache licensed and its
 * device flow is a documented subcommand nobody else offers; a managed
 * `CODEX_HOME` so the vendor's client never touches the person's own Codex
 * folder; a short startup deadline so a client that never prints a code
 * cannot hang the command that started it; a hard three minute ceiling so a
 * login nobody finished does not leave a process running forever; and a
 * version floor, because the subcommand does not exist in every client and
 * offering it anyway fails in a way nobody can read.
 *
 * Nothing here reads, copies or rewrites a credential file. The only thing
 * this module ever asks is whether one appeared.
 */
import { spawnWithWindowsCommandShim } from "@openlimiter/core";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

/** The client release that first carried `--device-auth`. */
export const MINIMUM_CODEX_VERSION: readonly [number, number, number] = [0, 153, 3];

/** How long a login may stay open before it is abandoned. */
export const LOGIN_TIMEOUT_MILLISECONDS = 180_000;

/** How long the client has to print its code before it is given up on. */
export const START_TIMEOUT_MILLISECONDS = 20_000;

/** The file the client writes when the login succeeded. */
const CREDENTIAL_FILE = "auth.json";

/** The most output lines read while waiting for the code and the address. */
const MAX_SCANNED_LINES = 64;

/** The most characters of one output line kept. */
const MAX_LINE_BYTES = 512;

export type DeviceLoginFailure = "not_installed" | "too_old" | "storage" | "spawn" | "no_code";

export class DeviceLoginError extends Error {
  constructor(public readonly reason: DeviceLoginFailure) {
    super(reason);
  }
}

export type DeviceLoginState =
  | { readonly kind: "pending" }
  | { readonly kind: "complete" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timed_out" }
  | { readonly kind: "failed"; readonly reason: DeviceLoginFailure };

export interface DeviceLoginStart {
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresInSeconds: number;
}

/**
 * Whether a version string clears the floor.
 *
 * Read off a client this process does not own, so anything that is not three
 * numbers is refused rather than interpreted generously.
 */
export function versionIsSupported(value: string): boolean {
  const trimmed = value.trim().replace(/^v/u, "");
  const head = trimmed.split(/[-+ ]/u)[0] ?? "";
  const parts = head.split(".");
  if (parts.length !== 3) return false;
  const numbers = parts.map((part) => (/^\d+$/u.test(part) ? Number.parseInt(part, 10) : null));
  if (numbers.some((value) => value === null)) return false;
  const [major, minor, patch] = numbers as [number, number, number];
  const [minMajor, minMinor, minPatch] = MINIMUM_CODEX_VERSION;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

/** Whether a token looks like a device user code. */
function isUserCode(token: string): boolean {
  const characters = [...token];
  if (characters.length < 6 || characters.length > 16) return false;
  let letters = 0;
  for (const character of characters) {
    if (character >= "A" && character <= "Z") {
      letters += 1;
    } else if (!(character >= "0" && character <= "9") && character !== "-") {
      return false;
    }
  }
  return letters > 0;
}

export interface ScannedLine {
  code: string | null;
  url: string | null;
}

/**
 * The user code and the address, taken out of one line of the client's own
 * output. Both are bounded and validated: the code is short and alphanumeric
 * with hyphens, and the address must be an https URL, never plain http.
 */
export function scanLine(line: string, found: ScannedLine): void {
  const bounded = line.slice(0, MAX_LINE_BYTES);
  for (const rawToken of bounded.split(/\s+/u)) {
    const token = rawToken.replace(/^["',.():]+|["',.():]+$/gu, "");
    if (found.url === null && token.startsWith("https://") && token.length <= 256) {
      found.url = token;
      continue;
    }
    if (found.code === null && isUserCode(token)) {
      found.code = token;
    }
  }
}

/**
 * Where one managed login keeps the client's own configuration.
 *
 * Under this product's own state directory, one folder per login, so a login
 * made here can never write into the folder the person's own Codex uses.
 */
export function managedCodexHome(stateDirectory: string, sessionId: string): string | null {
  if (sessionId.length === 0 || sessionId.length > 64 || !/^[a-z0-9]+$/u.test(sessionId)) {
    return null;
  }
  return path.join(stateDirectory, "accounts", "codex", sessionId);
}

async function rejectSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new DeviceLoginError("storage");
  } catch (error) {
    if (error instanceof DeviceLoginError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DeviceLoginError("storage");
  }
}

async function prepareManagedHome(home: string): Promise<void> {
  await rejectSymlink(home);
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
  } catch {
    throw new DeviceLoginError("storage");
  }
  await rejectSymlink(home);
}

/** A running login, from the caller's side. */
export interface DeviceLoginChild {
  /** The next line the client printed, or null once the deadline passes. */
  nextLine(deadlineMilliseconds: number): Promise<string | null>;
  finished(): boolean;
  stop(): void;
}

/** How the child process is started, injectable so no test spawns one. */
export interface DeviceLoginRunner {
  start(home: string): Promise<DeviceLoginChild>;
}

class RealDeviceLoginChild implements DeviceLoginChild {
  private readonly buffered: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;

  constructor(private readonly child: ChildProcess) {
    const onLine = (line: string): void => this.deliver(line.slice(0, MAX_LINE_BYTES));
    if (child.stdout !== null) createInterface({ input: child.stdout }).on("line", onLine);
    if (child.stderr !== null) createInterface({ input: child.stderr }).on("line", onLine);
    child.once("exit", () => {
      this.closed = true;
      this.deliver(null);
    });
    child.once("error", () => {
      this.closed = true;
      this.deliver(null);
    });
  }

  private deliver(line: string | null): void {
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(line);
      return;
    }
    if (line !== null) this.buffered.push(line);
  }

  async nextLine(deadlineMilliseconds: number): Promise<string | null> {
    const queued = this.buffered.shift();
    if (queued !== undefined) return queued;
    if (this.closed) return null;
    const remaining = deadlineMilliseconds - Date.now();
    if (remaining <= 0) return null;
    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        resolve(null);
      }, remaining);
      this.waiting = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
    });
  }

  finished(): boolean {
    return this.closed;
  }

  stop(): void {
    try {
      this.child.kill();
    } catch {
      /* Already gone. */
    }
  }
}

/** The real runner: `codex login --device-auth` with a managed `CODEX_HOME`. */
export class SystemDeviceLoginRunner implements DeviceLoginRunner {
  constructor(
    private readonly executable: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async start(home: string): Promise<DeviceLoginChild> {
    let child;
    try {
      child = spawnWithWindowsCommandShim(this.executable, ["login", "--device-auth"], {
        env: { ...process.env, CODEX_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }, this.platform);
    } catch {
      throw new DeviceLoginError("spawn");
    }
    return new RealDeviceLoginChild(child);
  }
}

async function credentialWritten(home: string): Promise<boolean> {
  try {
    const stat = await lstat(path.join(home, CREDENTIAL_FILE));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export interface CodexDeviceLoginSession {
  readonly home: string;
  state(now: number): Promise<DeviceLoginState>;
  cancel(): void;
}

class RunningCodexDeviceLoginSession implements CodexDeviceLoginSession {
  private cancelled = false;

  constructor(
    public readonly home: string,
    private readonly child: DeviceLoginChild,
    private readonly deadline: number
  ) {}

  async state(now: number): Promise<DeviceLoginState> {
    if (this.cancelled) return { kind: "cancelled" };
    if (await credentialWritten(this.home)) return { kind: "complete" };
    if (now >= this.deadline) {
      this.cancel();
      return { kind: "timed_out" };
    }
    if (this.child.finished()) {
      if (await credentialWritten(this.home)) return { kind: "complete" };
      return { kind: "failed", reason: "no_code" };
    }
    return { kind: "pending" };
  }

  cancel(): void {
    this.cancelled = true;
    this.child.stop();
  }
}

/**
 * Start a login and read the code and the address out of the client's own
 * output.
 *
 * A client that starts and never prints a code is stopped rather than left
 * running: it is not going to become useful later, and a process waiting on a
 * login nobody can complete is a process nobody knows about.
 */
export async function startCodexDeviceLogin(
  runner: DeviceLoginRunner,
  home: string,
  now: number
): Promise<{ session: CodexDeviceLoginSession; start: DeviceLoginStart }> {
  await prepareManagedHome(home);
  const child = await runner.start(home);
  const startupDeadline = Date.now() + START_TIMEOUT_MILLISECONDS;
  const found: ScannedLine = { code: null, url: null };
  for (let scanned = 0; scanned < MAX_SCANNED_LINES; scanned += 1) {
    const line = await child.nextLine(startupDeadline);
    if (line === null) break;
    scanLine(line, found);
    if (found.code !== null && found.url !== null) break;
  }
  if (found.code === null || found.url === null) {
    child.stop();
    throw new DeviceLoginError("no_code");
  }
  const session = new RunningCodexDeviceLoginSession(home, child, now + LOGIN_TIMEOUT_MILLISECONDS);
  return {
    session,
    start: {
      userCode: found.code,
      verificationUrl: found.url,
      expiresInSeconds: LOGIN_TIMEOUT_MILLISECONDS / 1_000
    }
  };
}
