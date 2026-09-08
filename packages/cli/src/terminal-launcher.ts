import { cp, link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface Launcher { node: string; entry: string }

export async function verifyLauncher(launcher: Launcher): Promise<void> {
  // No npx PATH, NODE_PATH or NODE_OPTIONS can help this child resolve code.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher.node, [launcher.entry, "--help"], {
      env: { PATH: "", SystemRoot: process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? "", HOME: path.dirname(launcher.entry), USERPROFILE: path.dirname(launcher.entry) },
      cwd: path.dirname(launcher.entry), timeout: 15_000, windowsHide: true, stdio: "ignore"
    });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("Invalid launcher")));
  });
}

/** Copy the shipped runtime, its production dependency closure and Node itself.
 * Never retain a reference to an npm cache directory that may be removed. */
export async function installLauncher(directory: string, source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")): Promise<Launcher> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "terminal-runtime");
  const result = { node: path.join(target, process.platform === "win32" ? "node.exe" : "node"), entry: path.join(target, "openlimiter.cjs") };
  try { await verifyLauncher(result); return result; } catch { /* Build a complete replacement before publishing it. */ }
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
    await writeFile(path.join(staging, "openlimiter.cjs"), 'import("./node_modules/openlimiter/dist/bin.js");\n', { mode: 0o600 });
    await verifyLauncher({ node, entry: path.join(staging, "openlimiter.cjs") });
    // A working runtime is reused above. Do not destroy an existing installation
    // when a failed verification could be transient.
    await rename(staging, target);
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
