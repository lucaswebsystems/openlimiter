import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("root test home isolation", () => {
  it("redirects every home and state fallback before CLI defaults are constructed", async () => {
    const sandbox = process.env["OPENLIMITER_TEST_SANDBOX"];
    expect(sandbox).toBeTruthy();
    for (const name of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
      expect(process.env[name]).toBe(sandbox);
    }
    expect(homedir()).toBe(sandbox);
    // This is the formerly dangerous missing homeDirectory dependency.
    // Invalid configuration cannot make the installer fall back to a real home.
    const result = await runCli(["terminal", "install", "claude"], { environment: { CLAUDE_CONFIG_DIR: "relative" } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("absolute path");
  });

  it.each(["sync", "promise", "callback", "open", "stream", "rename"])("blocks a %s write before filesystem access and fails even when caught", async (kind) => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "guard-proof-"));
    roots.push(sandbox);
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const { parentPort } = require("node:worker_threads");
      const target = path.join(require("node:os").userInfo().homedir, ".openlimiter-isolation-probe");
      (async () => {
        try {
          switch (${JSON.stringify(kind)}) {
            case "sync": fs.writeFileSync(target, "forbidden"); break;
            case "promise": await fs.promises.writeFile(target, "forbidden"); break;
            case "callback": fs.writeFile(target, "forbidden", () => {}); break;
            case "open": await fs.promises.open(target, "w"); break;
            case "stream": fs.createWriteStream(target); break;
            case "rename": fs.renameSync(path.join(process.env.HOME, "missing"), target); break;
          }
          parentPort.postMessage("guard failed");
        } catch (error) { parentPort.postMessage(error.message); }
      })();
    `;
    const result = await new Promise<{ code: number; message: string }>((resolve, reject) => {
      let message = "";
      const worker = new Worker(script, {
        eval: true, execArgv: ["--require", path.resolve("scripts/vitest-bootstrap.cjs")],
        env: { ...process.env, OPENLIMITER_TEST_SANDBOX: sandbox }, stderr: true
      });
      worker.stderr.resume();
      worker.once("message", (value: string) => { message = value; });
      worker.once("error", reject);
      worker.once("exit", (code) => resolve({ code, message }));
    });
    expect(result.message).toContain("Test isolation blocked real home write:");
    expect(result.code).toBe(1);
  });
});
