import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CACHE_LOCK_NAME, LOCK_STALE_MILLISECONDS } from "@openlimiter/core";

export interface Launcher { node: string; entry: string; version: string }

const LAUNCHER_ENTRY_CONTENT = 'import("./node_modules/openlimiter/dist/bin.js");\n';
export const RUNTIME_STAMP_FILE_NAME = ".openlimiter-runtime.json";
const INSTALL_LOCK_NAME = CACHE_LOCK_NAME;
const INSTALL_LOCK_MAX_AGE = LOCK_STALE_MILLISECONDS;

interface RuntimeStamp {
  readonly version: string;
  readonly files: Readonly<Record<string, string>>;
}

interface InstallLockOwner {
  readonly pid: number;
  readonly startedAt: number;
  readonly token: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function reclaimInstallLock(lockPath: string): Promise<boolean> {
  let owner: InstallLockOwner | null = null;
  try {
    owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as InstallLockOwner;
  } catch {
    /* A directory created before its owner record is also recoverable. */
  }
  let age: number;
  try {
    age = Date.now() - (owner?.startedAt ?? (await stat(lockPath)).mtimeMs);
  } catch {
    return false;
  }
  if (age < INSTALL_LOCK_MAX_AGE && (owner === null || processIsAlive(owner.pid))) return false;
  const displaced = lockPath + ".reclaim." + randomUUID();
  try {
    await rename(lockPath, displaced);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  let stillObserved = owner === null;
  if (owner !== null) {
    try {
      const parsed = JSON.parse(await readFile(path.join(displaced, "owner.json"), "utf8")) as InstallLockOwner;
      stillObserved = parsed.token === owner.token;
    } catch {
      stillObserved = false;
    }
  } else {
    try {
      await lstat(path.join(displaced, "owner.json"));
      stillObserved = false;
    } catch (error) {
      stillObserved = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  if (stillObserved) await rm(displaced, { recursive: true, force: true });
  return true;
}

async function withInstallLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(directory, INSTALL_LOCK_NAME);
  const token = randomUUID();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner: InstallLockOwner = { pid: process.pid, startedAt: Date.now(), token };
      await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner) + "\n", { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reclaimInstallLock(lockPath);
      if (attempt >= 240) throw new Error("Launcher installation lock timeout");
      await new Promise(resolve => setTimeout(resolve, Math.min(25 * (attempt + 1), 300)));
    }
  }
  try {
    return await action();
  } finally {
    try {
      const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as InstallLockOwner;
      if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
    } catch {
      /* A stale lock recovery can have removed the directory after an abort. */
    }
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

function ownerIsCurrentUser(uid: number | undefined): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  return uid === process.getuid();
}

async function assertSafeTree(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const info = await lstat(current);
    if (info.isSymbolicLink() || !ownerIsCurrentUser(info.uid)) throw new Error("Invalid launcher");
    if (!info.isDirectory()) continue;
    for (const entry of await readdir(current)) pending.push(path.join(current, entry));
  }
}

async function runtimeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current)) {
      const file = path.join(current, entry);
      const info = await lstat(file);
      if (info.isSymbolicLink() || !ownerIsCurrentUser(info.uid)) throw new Error("Invalid launcher");
      if (info.isDirectory()) pending.push(file);
      else files.push(file);
    }
  }
  return files
    .filter(file => path.relative(root, file).split(path.sep).join("/") !== RUNTIME_STAMP_FILE_NAME)
    .sort((a, b) => a.localeCompare(b));
}

async function runtimeFileHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of await runtimeFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    hashes[relative] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return hashes;
}

async function runtimeStampIsValid(root: string, expectedVersion?: string): Promise<boolean> {
  let stamp: RuntimeStamp;
  try {
    const stampFile = path.join(root, RUNTIME_STAMP_FILE_NAME);
    const info = await lstat(stampFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) return false;
    const parsed: unknown = JSON.parse(await readFile(stampFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const candidate = parsed as { version?: unknown; files?: unknown };
    if (typeof candidate.version !== "string" || candidate.version.length === 0 ||
        typeof candidate.files !== "object" || candidate.files === null || Array.isArray(candidate.files)) return false;
    const files = candidate.files as Record<string, unknown>;
    if (Object.keys(files).some(file => !file || path.posix.isAbsolute(file) || file.includes("..") ||
      typeof files[file] !== "string" || !/^[a-f0-9]{64}$/u.test(files[file] as string))) return false;
    stamp = { version: candidate.version, files: files as Record<string, string> };
  } catch {
    return false;
  }
  if (expectedVersion !== undefined && stamp.version !== expectedVersion) return false;
  const actual = await runtimeFileHashes(root);
  const actualNames = Object.keys(actual).sort();
  const stampedNames = Object.keys(stamp.files).sort();
  if (actualNames.length !== stampedNames.length || actualNames.some((file, index) => file !== stampedNames[index])) return false;
  return actualNames.every(file => actual[file] === stamp.files[file]);
}

/** Check only bytes and filesystem metadata. Never execute an existing file. */
async function existingLauncherIsTrusted(launcher: Launcher): Promise<boolean> {
  const root = path.dirname(launcher.entry);
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await assertSafeTree(root);
  let entry: string;
  try {
    entry = await readFile(launcher.entry, "utf8");
    const node = await lstat(launcher.node);
    if (!node.isFile()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (entry !== LAUNCHER_ENTRY_CONTENT) return false;
  return await runtimeStampIsValid(root, launcher.version);
}

export async function verifyLauncher(launcher: Launcher): Promise<void> {
  if (!(await existingLauncherIsTrusted(launcher))) throw new Error("Invalid launcher");
}

/** Copy the shipped runtime, its production dependency closure and Node itself.
 * Never retain a reference to an npm cache directory that may be removed. */
/**
 * Remove runtimes displaced by earlier swaps. Windows refuses to delete a
 * node.exe that is still running, so a swap may leave one behind; best effort.
 */
export async function sweepDisplacedRuntimes(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(names
    .filter(name => /^terminal-runtime\.\d+\.[0-9a-f-]{36}\.old$/u.test(name))
    .map(name => rm(path.join(directory, name), { recursive: true, force: true }).catch(() => undefined)));
}

async function installLauncherUnlocked(directory: string, source: string): Promise<Launcher> {
  const target = path.join(directory, "terminal-runtime");
  const recoveryNames = (await readdir(directory).catch(() => [] as string[]))
    .filter(name => /^terminal-runtime\.\d+\.[0-9a-f-]{36}\.old$/u.test(name))
    .sort()
    .reverse();
  if (!(await lstat(target).then(() => true).catch(() => false))) {
    for (const name of recoveryNames) {
      const candidate = path.join(directory, name);
      const version = await readFile(path.join(candidate, RUNTIME_STAMP_FILE_NAME), "utf8")
        .then(text => (JSON.parse(text) as { version?: unknown }).version)
        .catch(() => undefined);
      if (typeof version !== "string") continue;
      const candidateLauncher = {
        node: path.join(candidate, process.platform === "win32" ? "node.exe" : "node"),
        entry: path.join(candidate, "openlimiter.cjs"),
        version
      };
      if (!(await existingLauncherIsTrusted(candidateLauncher).catch(() => false))) continue;
      try {
        await renameWithRetry(candidate, target);
        break;
      } catch {
        /* Another installer won the recovery target. */
      }
    }
  }
  await sweepDisplacedRuntimes(directory);
  const sourceManifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as { version?: unknown };
  if (typeof sourceManifest.version !== "string" || sourceManifest.version.length === 0) throw new Error("Invalid launcher");
  const version = sourceManifest.version;
  const result = { node: path.join(target, process.platform === "win32" ? "node.exe" : "node"), entry: path.join(target, "openlimiter.cjs"), version };
  try {
    if (await existingLauncherIsTrusted(result)) return result;
  } catch {
    /* A present runtime with unsafe metadata must never be adopted or followed. */
    throw new Error("Invalid launcher");
  }
  const staging = await mkdtemp(path.join(directory, "terminal-runtime-"));
  try {
    const copied = new Set<string>();
    async function copyPackage(root: string): Promise<void> {
      const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name: string; dependencies?: Record<string, string> };
      if (copied.has(manifest.name)) return;
      copied.add(manifest.name);
      const destination = path.join(staging, "node_modules", manifest.name);
      await mkdir(destination, { recursive: true });
      await cp(path.join(root, "dist"), path.join(destination, "dist"), {
        recursive: true, dereference: true,
        filter: file => !file.endsWith(".map") && !file.endsWith(".d.ts") && !file.endsWith(".tsbuildinfo")
      });
      await cp(path.join(root, "package.json"), path.join(destination, "package.json"));
      const resolve = createRequire(path.join(root, "package.json"));
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        // OpenLimiter's shipped packages expose dist/index.js and contain only
        // first party runtime dependencies. Refuse an unexpected package layout.
        const entry = resolve.resolve(name);
        if (path.basename(path.dirname(entry)) !== "dist") throw new Error("Invalid launcher");
        await copyPackage(path.dirname(path.dirname(entry)));
      }
    }
    await copyPackage(source);
    const node = path.join(staging, path.basename(result.node));
    /* A hard link to the system node on Windows shares its always running image,
       so the runtime could never be removed or replaced while any node app runs. */
    if (process.platform === "win32") await cp(process.execPath, node);
    else try { await link(process.execPath, node); } catch { await cp(process.execPath, node); }
    await writeFile(path.join(staging, "openlimiter.cjs"), LAUNCHER_ENTRY_CONTENT, { mode: 0o600 });
    const stamp = { version, files: await runtimeFileHashes(staging) };
    await writeFile(path.join(staging, RUNTIME_STAMP_FILE_NAME), JSON.stringify(stamp) + "\n", { mode: 0o600 });
    await verifyLauncher({ node, entry: path.join(staging, "openlimiter.cjs"), version });
    const displaced = `${target}.${process.pid}.${randomUUID()}.old`;
    let hadExisting = false;
    try {
      await renameWithRetry(target, displaced);
      hadExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await renameWithRetry(staging, target);
    } catch (error) {
      if (hadExisting) {
        try {
          await renameWithRetry(displaced, target);
          const restoredEntry = path.join(target, "openlimiter.cjs");
          const restoredNode = path.join(target, path.basename(result.node));
          if (await readFile(restoredEntry, "utf8") !== LAUNCHER_ENTRY_CONTENT ||
              !(await lstat(restoredNode)).isFile() ||
              !(await runtimeStampIsValid(target))) {
            throw new Error("Launcher rollback verification failed");
          }
        } catch (rollbackError) {
          throw new Error("Launcher rollback failed", { cause: rollbackError });
        }
      }
      throw error;
    }
    /* The swap already succeeded. A displaced runtime still running (Windows keeps
       node.exe locked) is swept by the next install instead of failing this one. */
    if (hadExisting) await rm(displaced, { recursive: true, force: true }).catch(() => undefined);
    await verifyLauncher(result);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function installLauncher(
  directory: string,
  source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
): Promise<Launcher> {
  await mkdir(directory, { recursive: true });
  return withInstallLock(directory, () => installLauncherUnlocked(directory, source));
}

export function launcherCommand(launcher: Launcher, shell: "posix" | "cmd" | "powershell"): string {
  const quote = shell === "cmd"
    ? (value: string): string => { if (/["%\r\n]/.test(value)) throw new Error("Invalid launcher"); return `"${value}"`; }
    : (value: string): string => `'${value.replaceAll("'", shell === "powershell" ? "''" : "'\\''")}'`;
  return `${shell === "powershell" ? "& " : ""}${quote(launcher.node)} ${quote(launcher.entry)}`;
}
