import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

  it("removes a dangling directory link without resolving its deleted target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-link-"));
    roots.push(root);
    const target = path.join(root, "target"), alias = path.join(root, "link");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    await rm(target, { recursive: true });
    await unlink(alias);
  });

  it("copies protected hard link sources without poisoning later child exits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-source-"));
    roots.push(root);
    // Model a hosted Node executable inside the real home, outside the checkout.
    // All paths in this proof are synthetic and remain in the test sandbox.
    const workspace = path.join(root, "checkout"), sandbox = path.join(workspace, ".test-dist", "home");
    await mkdir(path.join(workspace, "scripts"), { recursive: true });
    await mkdir(sandbox, { recursive: true });
    const bootstrap = path.join(workspace, "scripts", "vitest-bootstrap.cjs");
    await cp(path.resolve("scripts/vitest-bootstrap.cjs"), bootstrap);
    const source = path.join(root, "hosted-node");
    await writeFile(source, "original");
    const script = `
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      os.userInfo = () => ({ homedir: ${JSON.stringify(root)} });
      require(${JSON.stringify(bootstrap)});
      (async () => {
        for (const kind of ["sync", "callback", "promise"]) {
          const destination = path.join(${JSON.stringify(sandbox)}, kind);
          try {
            if (kind === "sync") fs.linkSync(${JSON.stringify(source)}, destination);
            else if (kind === "callback") await new Promise((resolve, reject) => fs.link(${JSON.stringify(source)}, destination, error => error ? reject(error) : resolve()));
            else await fs.promises.link(${JSON.stringify(source)}, destination);
            throw new Error("Protected source must not share a writable inode");
          } catch (error) {
            if (error.code !== "EXDEV") throw error;
            await fs.promises.copyFile(${JSON.stringify(source)}, destination);
          }
          await fs.promises.writeFile(destination, "changed copy");
        }
      })().catch(error => { throw error; });
    `;
    const code = await new Promise<number>((resolve, reject) => {
      const worker = new Worker(script, {
        eval: true, execArgv: [], env: { ...process.env, OPENLIMITER_TEST_SANDBOX: sandbox }, stderr: true
      });
      worker.stderr.resume();
      worker.once("error", reject);
      worker.once("exit", resolve);
    });
    expect(code).toBe(0);
    expect(await readFile(source, "utf8")).toBe("original");
    await expect(readFile(path.join(sandbox, "home-write-violations.log"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["exec", "execFile"])("preserves the %s Promise contract through the guarded API", async (name) => {
    const script = `
      const { parentPort } = require("node:worker_threads");
      const cp = require("node:child_process");
      const { promisify } = require("node:util");
      const child = { pid: 123 };
      cp[${JSON.stringify(name)}] = (command, ...args) => {
        const options = args.find(value => value && typeof value === "object" && !Array.isArray(value));
        if (!options.env.NODE_OPTIONS.includes("vitest-bootstrap.cjs")) throw new Error("Guard bypassed");
        process.nextTick(args.at(-1), command === "fail" ? new Error("failure") : null, "output", "diagnostic");
        return child;
      };
      require(${JSON.stringify(path.resolve("scripts/vitest-bootstrap.cjs"))});
      (async () => {
        const run = promisify(cp[${JSON.stringify(name)}]);
        const promise = run("success", { env: {} });
        if (promise.child !== child) throw new Error("Missing child handle");
        const success = await promise;
        let failure;
        try { await run("fail", { env: {} }); }
        catch (error) { failure = { message: error.message, stdout: error.stdout, stderr: error.stderr }; }
        parentPort.postMessage({ success, failure });
      })().catch(error => { throw error; });
    `;
    const result = await new Promise<unknown>((resolve, reject) => {
      let message: unknown;
      const worker = new Worker(script, { eval: true, execArgv: [], stderr: true });
      worker.stderr.resume();
      worker.once("message", value => { message = value; });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve(message) : reject(new Error(`Worker exited ${code}`)));
    });
    expect(result).toEqual({
      success: { stdout: "output", stderr: "diagnostic" },
      failure: { message: "failure", stdout: "output", stderr: "diagnostic" }
    });
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
