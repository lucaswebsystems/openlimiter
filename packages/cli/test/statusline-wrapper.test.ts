import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_FILE_NAME } from "@openlimiter/core";
import { FIXTURE_NOW, claudeFixture } from "@openlimiter/connectors";
import {
  decodeWrappedStatuslineCommand,
  encodeWrappedStatuslineCommand,
  runCli,
  runStatuslineWrapper,
  type StatuslineWrapperSpawn
} from "../src/index.js";

const created: string[] = [];
const slash = String.fromCharCode(92);
const quote = String.fromCharCode(34);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openlimiter-wrapper-test-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface FakeCommand {
  echoInput?: boolean;
  stdout?: Buffer;
  stderr?: Buffer;
  exitCode?: number;
  hangs?: boolean;
}

function fakeSpawn(options: FakeCommand = {}): StatuslineWrapperSpawn {
  return () => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const echoed: Buffer[] = [];
    if (options.echoInput === true) {
      stdin.on("data", (chunk: Buffer) => echoed.push(Buffer.from(chunk)));
    }
    stdin.on("finish", () => {
      if (options.echoInput === true) stdout.write(Buffer.concat(echoed));
      if (options.stdout !== undefined) stdout.write(options.stdout);
      if (options.stderr !== undefined) stderr.write(options.stderr);
      if (options.hangs === true) return;
      stdout.end();
      stderr.end();
      queueMicrotask(() => events.emit("close", options.exitCode ?? 0, null));
    });
    const child = Object.assign(events, {
      stdin,
      stdout,
      stderr,
      kill: () => true,
      unref: () => child
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

function claudeStatuslinePayload(): Buffer {
  return Buffer.from(JSON.stringify({
    hook_event_name: "Status",
    session_id: "00000000-0000-4000-8000-000000000000",
    ...claudeFixture(FIXTURE_NOW)
  }));
}

const noIngest = async (): Promise<void> => {};

describe("Claude statusline wrapper", () => {
  it("round trips Windows and POSIX quoting landmines without shell quoting them", () => {
    const windowsPath = ["C:", "Program Files", "meter", "status.cmd"].join(slash);
    const filePath = ["C:", "Users", "Name", "file"].join(slash);
    const original =
      quote + windowsPath + quote + " " + quote + "double quoted" + quote + " " +
      "'single quoted' " + filePath + " & 100%";
    const encoded = encodeWrappedStatuslineCommand(original);
    expect(encoded).toBe(
      "IkM6XFByb2dyYW0gRmlsZXNcbWV0ZXJcc3RhdHVzLmNtZCIgImRvdWJsZSBxdW90ZWQiICdzaW5nbGUgcXVvdGVkJyBDOlxVc2Vyc1xOYW1lXGZpbGUgJiAxMDAl"
    );
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
    expect(decodeWrappedStatuslineCommand(encoded)).toBe(original);
  });

  it("passes the same buffered bytes to a special command without changing it", async () => {
    const command =
      quote + ["C:", "Program Files", "meter tool.cmd"].join(slash) + quote +
      " " + quote + "double" + quote + " 'single' & 100%";
    const payload = Buffer.from([0, 1, 2, 10, 13, 34, 39, 92, 38, 37, 255]);
    let receivedCommand = "";
    let ingested = 0;
    const echo = fakeSpawn({ echoInput: true });
    const result = await runStatuslineWrapper(payload, command, {
      ingest: async (received) => {
        ingested += 1;
        expect(received).toBe(payload);
      },
      spawnCommand: (received) => {
        receivedCommand = received;
        return echo(received);
      }
    });
    expect(receivedCommand).toBe(command);
    expect(ingested).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.equals(payload)).toBe(true);
    expect(result.stderr.length).toBe(0);
  });

  it("fails open when the original command cannot be spawned", async () => {
    const result = await runStatuslineWrapper(Buffer.from("private payload"), "missing", {
      ingest: noIngest,
      spawnCommand: () => {
        throw new Error("not spawnable");
      }
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false
    });
  });

  it("bounds a hung original and returns only what it printed", async () => {
    const result = await runStatuslineWrapper(Buffer.from("private payload"), "hung", {
      ingest: noIngest,
      timeoutMilliseconds: 20,
      spawnCommand: fakeSpawn({
        stdout: Buffer.from("partial"),
        hangs: true
      })
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("partial");
    expect(result.stderr.length).toBe(0);
    expect(result.timedOut).toBe(true);
  });

  it("propagates a nonzero original exit and preserves its output", async () => {
    const result = await runStatuslineWrapper(Buffer.from("private payload"), "nonzero", {
      ingest: noIngest,
      spawnCommand: fakeSpawn({
        stdout: Buffer.from("visible"),
        exitCode: 17
      })
    });
    expect(result.exitCode).toBe(17);
    expect(result.stdout.toString()).toBe("visible");
    expect(result.stderr.length).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("preserves an original command that prints nothing", async () => {
    const result = await runStatuslineWrapper(Buffer.from("private payload"), "quiet", {
      ingest: noIngest,
      spawnCommand: fakeSpawn()
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
  });

  it("uses the existing Claude ingest path when rate limits are present", async () => {
    const directory = await temporaryDirectory();
    const payload = claudeStatuslinePayload();
    const result = await runStatuslineWrapper(payload, "foreign", {
      ingest: async (received) => {
        await runCli(["statusline"], {
          stateDirectory: directory,
          now: () => FIXTURE_NOW,
          readStandardInput: async () => received.toString("utf8")
        });
      },
      ingestTimeoutMilliseconds: 2_000,
      spawnCommand: fakeSpawn({ stdout: Buffer.from("foreign status") })
    });
    expect(result.stdout.toString()).toBe("foreign status");
    const cache = JSON.parse(
      await readFile(path.join(directory, CACHE_FILE_NAME), "utf8")
    ) as { snapshots: { meter: string }[] };
    expect(cache.snapshots.map((snapshot) => snapshot.meter).sort()).toEqual([
      "FIVE_HOUR",
      "SEVEN_DAY"
    ]);
  });

  it("keeps a payload without rate limits invisible and preserves the original", async () => {
    const directory = await temporaryDirectory();
    const payload = Buffer.from(JSON.stringify({ model: { id: "synthetic" } }));
    const result = await runStatuslineWrapper(payload, "foreign", {
      ingest: async (received) => {
        await runCli(["statusline"], {
          stateDirectory: directory,
          now: () => FIXTURE_NOW,
          readStandardInput: async () => received.toString("utf8")
        });
      },
      spawnCommand: fakeSpawn({ stdout: Buffer.from("foreign status") })
    });
    expect(result.stdout.toString()).toBe("foreign status");
    expect(result.stdout.includes(payload)).toBe(false);
    await expect(readFile(path.join(directory, CACHE_FILE_NAME), "utf8")).rejects.toThrow();
  });
});
