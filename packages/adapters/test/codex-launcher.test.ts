import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgentInstallation } from "../src/hook-installation.js";

/*
 * The CLI resolves Codex by the desktop's own launch rule
 * (apps/desktop/src-tauri/src/provider_detection.rs), so both accept and
 * refuse the same Codex paths (2.1.7 fix round, decision B and Astra's
 * finding 1): a shim is mapped through its manager's own package tree and
 * never run, only npm's official launcher names its package, and on macOS
 * Homebrew's own codex link runs its target.
 */

const created: string[] = [];
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "openlimiter-codex-launch-")));
  created.push(directory);
  return directory;
}

async function write(file: string, text = "fixture"): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

const arch = process.arch === "arm64" ? "arm64" : "x64";

/** The npm package under `prefix` with its platform package beside it; the native binary. */
async function codexPackage(prefix: string, platform: "win32" | "darwin"): Promise<string> {
  const [name, triple, executable] = platform === "win32"
    ? [`codex-win32-${arch}`, arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc", "codex.exe"]
    : [`codex-darwin-${arch}`, arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin", "codex"];
  const scope = path.join(prefix, "node_modules", "@openai");
  await write(path.join(scope, "codex", "bin", "codex.js"), "launcher");
  const native = path.join(scope, name, "vendor", triple, "codex", executable);
  await write(native, "native codex");
  return realpath(native);
}

function recorder() {
  const seen: string[] = [];
  return {
    seen,
    runCommand: async (command: string) => {
      seen.push(command);
      return { ok: true as const, stdout: "codex 0.153.3", stderr: "" };
    }
  };
}

describe("the CLI resolves Codex by the desktop's launch rule", () => {
  it("maps a Windows Volta shim to Volta's package image and never runs the shim", async () => {
    const home = await scratch();
    const local = path.join(home, "local");
    const bin = path.join(local, "Volta", "bin");
    await write(path.join(bin, "codex.exe"), "volta shim");
    const environment = { Path: bin, PATHEXT: ".EXE", LOCALAPPDATA: local, USERPROFILE: home };
    expect(await detectAgentInstallation("codex", { platform: "win32", environment, ...recorder() })).toBeNull();
    const native = await codexPackage(path.join(local, "Volta", "tools", "image", "packages", "@openai", "codex"), "win32");
    const run = recorder();
    expect(await detectAgentInstallation("codex", { platform: "win32", environment, runCommand: run.runCommand }))
      .toMatchObject({ executable: native, version: "0.153.3" });
    expect(run.seen).toEqual([native]);
  });

  it("maps a Windows pnpm shim through pnpm's global folder, never an npm tree beside the shim", async () => {
    const home = await scratch();
    const local = path.join(home, "local");
    const pnpm = path.join(local, "pnpm");
    await write(path.join(pnpm, "codex.cmd"), "@echo off");
    await codexPackage(pnpm, "win32");
    const environment = { Path: pnpm, PATHEXT: ".CMD", LOCALAPPDATA: local, USERPROFILE: home };
    expect(await detectAgentInstallation("codex", { platform: "win32", environment, ...recorder() })).toBeNull();
    const native = await codexPackage(path.join(pnpm, "global", "5"), "win32");
    expect(await detectAgentInstallation("codex", { platform: "win32", environment, ...recorder() }))
      .toMatchObject({ executable: native });
  });

  it("maps a macOS pnpm script through ~/Library/pnpm/global and never runs the script", async () => {
    const home = await scratch();
    const pnpm = path.join(home, "Library", "pnpm");
    await write(path.join(pnpm, "codex"), "#!/bin/sh");
    const environment = { PATH: pnpm, HOME: home };
    expect(await detectAgentInstallation("codex", { platform: "darwin", environment, ...recorder() })).toBeNull();
    const native = await codexPackage(path.join(pnpm, "global", "5"), "darwin");
    expect(await detectAgentInstallation("codex", { platform: "darwin", environment, ...recorder() }))
      .toMatchObject({ executable: native });
  });

  it.runIf(process.platform !== "win32")("maps a macOS Volta shim link to the image and follows no other script (finding 1)", async () => {
    const home = await scratch();
    const volta = path.join(home, ".volta");
    const bin = path.join(volta, "bin");
    await write(path.join(bin, "volta-shim"), "volta");
    // A script in Volta's folder with a binary planted where a package keeps one.
    const planted = path.join(volta, "planted");
    await write(path.join(planted, "bin", "anything.js"), "not the official launcher");
    await write(path.join(planted, "vendor", arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin", "codex", "codex"), "planted");
    await symlink(path.join(planted, "bin", "anything.js"), path.join(bin, "codex"));
    const environment = { PATH: bin, HOME: home };
    expect(await detectAgentInstallation("codex", { platform: "darwin", environment, ...recorder() })).toBeNull();
    const native = await codexPackage(path.join(volta, "tools", "image", "packages", "@openai", "codex", "lib"), "darwin");
    expect(await detectAgentInstallation("codex", { platform: "darwin", environment, ...recorder() }))
      .toMatchObject({ executable: native });
  });

  it.runIf(process.platform !== "win32")("runs Homebrew's own codex link and refuses a link into another keg", async () => {
    const systemRoot = await scratch();
    const brew = path.join(systemRoot, "opt", "homebrew");
    const bin = path.join(brew, "bin");
    const formula = path.join(brew, "Cellar", "codex", "0.47.0", "bin", "codex");
    const cask = path.join(brew, "Caskroom", "codex", "0.47.0", "codex-aarch64-apple-darwin");
    const stranger = path.join(brew, "Cellar", "other", "1.0", "bin", "codex");
    for (const file of [formula, cask, stranger]) await write(file, "native binary");
    await mkdir(bin, { recursive: true });
    const options = { platform: "darwin" as const, environment: { PATH: bin, HOME: systemRoot }, systemRoot };
    for (const [target, expected] of [[formula, formula], [cask, cask], [stranger, null]] as const) {
      await rm(path.join(bin, "codex"), { force: true });
      await symlink(target, path.join(bin, "codex"));
      const detected = await detectAgentInstallation("codex", { ...options, ...recorder() });
      expect(detected?.executable ?? null).toBe(expected === null ? null : await realpath(expected));
    }
  });
});
