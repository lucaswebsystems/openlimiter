import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeviceLoginError,
  managedCodexHome,
  scanLine,
  startCodexDeviceLogin,
  versionIsSupported,
  type DeviceLoginChild,
  type DeviceLoginRunner,
  type ScannedLine
} from "../src/codex-device-login.js";

let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), prefix));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("versionIsSupported", () => {
  it("accepts a client at or above the floor", () => {
    for (const value of ["0.153.3", "0.153.4", "0.154.0", "1.0.0", "v0.153.3"]) {
      expect(versionIsSupported(value)).toBe(true);
    }
  });

  it("refuses everything below the floor or unreadable", () => {
    for (const value of ["0.153.2", "0.152.9", "0.1.0", "", "0.153", "not a version", "0.153.3.1"]) {
      expect(versionIsSupported(value)).toBe(false);
    }
  });
});

describe("scanLine", () => {
  it("takes the code and the address out of the client's own output", () => {
    const found: ScannedLine = { code: null, url: null };
    scanLine("Open https://auth.openai.com/device and enter", found);
    scanLine("Your code is BDXK-9QTZ", found);
    expect(found.url).toBe("https://auth.openai.com/device");
    expect(found.code).toBe("BDXK-9QTZ");
  });

  it("refuses plain http and lookalike tokens", () => {
    const found: ScannedLine = { code: null, url: null };
    scanLine("Open http://auth.openai.com/device", found);
    scanLine("codex 0.153.3 starting", found);
    scanLine("listening on 127.0.0.1:1455", found);
    expect(found.url).toBeNull();
    expect(found.code).toBeNull();
  });
});

describe("managedCodexHome", () => {
  it("is never the person's own Codex folder, and only takes a minted id", () => {
    const home = managedCodexHome("C:/state", "abc123");
    expect(home).toBe(path.join("C:/state", "accounts", "codex", "abc123"));
    for (const hostile of ["", "..", "../codex", "A", "with space", "a".repeat(65)]) {
      expect(managedCodexHome("C:/state", hostile)).toBeNull();
    }
  });
});

interface StubOptions {
  readonly lines: readonly string[];
  readonly writesCredential: boolean;
  readonly silent?: boolean;
}

function stubRunner(options: StubOptions): { runner: DeviceLoginRunner; stopped: { value: boolean } } {
  const stopped = { value: false };
  const runner: DeviceLoginRunner = {
    start: async (home) => {
      let index = 0;
      let exhausted = false;
      const child: DeviceLoginChild = {
        nextLine: async () => {
          if (options.silent === true) return null;
          if (index >= options.lines.length) {
            exhausted = true;
            if (options.writesCredential) {
              await mkdir(home, { recursive: true });
              await writeFile(path.join(home, "auth.json"), JSON.stringify({ stub: true }), "utf8");
            }
            return null;
          }
          const line = options.lines[index];
          index += 1;
          return line ?? null;
        },
        finished: () => exhausted,
        stop: () => {
          stopped.value = true;
        }
      };
      return child;
    }
  };
  return { runner, stopped };
}

const STARTED_LINES = ["Open https://auth.openai.com/device", "Your code is BDXK-9QTZ"];

describe("startCodexDeviceLogin", () => {
  it("starts, reads the code and the address, and reports pending until the credential appears", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-codex-");
    const { runner } = stubRunner({ lines: STARTED_LINES, writesCredential: false });
    const home = managedCodexHome(stateDirectory, "session1");
    expect(home).not.toBeNull();
    const { session, start } = await startCodexDeviceLogin(runner, home ?? "", Date.now());
    expect(start.userCode).toBe("BDXK-9QTZ");
    expect(start.verificationUrl).toBe("https://auth.openai.com/device");
    expect((await session.state(Date.now())).kind).toBe("pending");
    /* Success is the credential appearing in the folder this login owns, and
       nothing else: not an exit code, not a line of output. */
    await writeFile(path.join(home ?? "", "auth.json"), JSON.stringify({ stub: true }), "utf8");
    expect((await session.state(Date.now())).kind).toBe("complete");
  });

  it("stops the client and fails when nothing is ever printed", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-codex-");
    const { runner, stopped } = stubRunner({ lines: [], writesCredential: false, silent: true });
    const home = managedCodexHome(stateDirectory, "session2");
    await expect(startCodexDeviceLogin(runner, home ?? "", Date.now())).rejects.toBeInstanceOf(
      DeviceLoginError
    );
    expect(stopped.value).toBe(true);
  });

  it("cancel stops the child and the state says cancelled", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-codex-");
    const { runner, stopped } = stubRunner({ lines: STARTED_LINES, writesCredential: false });
    const home = managedCodexHome(stateDirectory, "session3");
    const { session } = await startCodexDeviceLogin(runner, home ?? "", Date.now());
    session.cancel();
    expect(stopped.value).toBe(true);
    expect((await session.state(Date.now())).kind).toBe("cancelled");
  });

  it("times out at the deadline and takes the client with it", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-codex-");
    const { runner, stopped } = stubRunner({ lines: STARTED_LINES, writesCredential: false });
    const home = managedCodexHome(stateDirectory, "session4");
    const started = Date.now();
    const { session } = await startCodexDeviceLogin(runner, home ?? "", started);
    const after = started + 180_000 + 1_000;
    expect((await session.state(after)).kind).toBe("timed_out");
    expect(stopped.value).toBe(true);
  });

  it("refuses a managed home that is a symlink rather than following it", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-codex-");
    const home = managedCodexHome(stateDirectory, "session5");
    expect(home).not.toBeNull();
    const elsewhere = await temporaryDirectory("openlimiter-codex-elsewhere-");
    await mkdir(path.dirname(home ?? ""), { recursive: true });
    let linked = true;
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(elsewhere, home ?? "", "dir");
    } catch {
      linked = false;
    }
    if (!linked) return;
    const { runner } = stubRunner({ lines: STARTED_LINES, writesCredential: false });
    await expect(startCodexDeviceLogin(runner, home ?? "", Date.now())).rejects.toBeInstanceOf(
      DeviceLoginError
    );
  });
});
