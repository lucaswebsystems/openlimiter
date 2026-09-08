import { randomUUID } from "node:crypto";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileAtomically } from "@openlimiter/core";

export interface Launcher { node: string; entry: string }

const LAUNCHER_ENTRY_CONTENT = 'import("./node_modules/openlimiter/dist/bin.js");\n';

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
  if (entry !== LAUNCHER_ENTRY_CONTENT) {
    await writeFileAtomically(launcher.entry, LAUNCHER_ENTRY_CONTENT);
  }
  return true;
}

export async function verifyLauncher(launcher: Launcher): Promise<void> {
  if (!(await existingLauncherIsTrusted(launcher))) throw new Error("Invalid launcher");
}

/** Copy the shipped runtime, its production dependency closure and Node itself.
 * Never retain a reference to an npm cache directory that may be removed. */
export async function installLauncher(directory: string, source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")): Promise<Launcher> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "terminal-runtime");
  const result = { node: path.join(target, process.platform === "win32" ? "node.exe" : "node"), entry: path.join(target, "openlimiter.cjs") };
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
    try { await link(process.execPath, node); } catch { await cp(process.execPath, node); }
    await writeFile(path.join(staging, "openlimiter.cjs"), LAUNCHER_ENTRY_CONTENT, { mode: 0o600 });
    await verifyLauncher({ node, entry: path.join(staging, "openlimiter.cjs") });
    const displaced = `${target}.${process.pid}.${randomUUID()}.old`;
    let hadExisting = false;
    try {
      await rename(target, displaced);
      hadExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (hadExisting) await rename(displaced, target).catch(() => undefined);
      throw error;
    }
    if (hadExisting) await rm(displaced, { recursive: true, force: true });
    await verifyLauncher(result);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function launcherCommand(launcher: Launcher, shell: "posix" | "cmd" | "powershell"): string {
  const quote = shell === "cmd"
    ? (value: string): string => { if (/["%\r\n]/.test(value)) throw new Error("Invalid launcher"); return `"${value}"`; }
    : (value: string): string => `'${value.replaceAll("'", shell === "powershell" ? "''" : "'\\''")}'`;
  return `${shell === "powershell" ? "& " : ""}${quote(launcher.node)} ${quote(launcher.entry)}`;
}
