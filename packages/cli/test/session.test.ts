import { mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireRefreshLock } from "@openlimiter/core";
import {
  RENEWAL_WINDOW_MILLISECONDS,
  SESSION_FILE_NAME,
  SESSION_LOCK_NAME,
  SESSION_LOCK_WAIT_MILLISECONDS,
  deleteSession,
  readSession,
  sessionIsFresh,
  writeSession,
  type HubSession
} from "../src/session.js";

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

function session(overrides: Partial<HubSession> = {}): HubSession {
  return {
    version: 1,
    token: "a".repeat(32),
    expiresAt: "2026-09-07T13:00:00.000Z",
    refreshCredential: "b".repeat(32),
    refreshExpiresAt: "2026-10-07T12:00:00.000Z",
    deviceId: "11111111-1111-1111-1111-111111111111",
    accountLabel: "person@example.com",
    ...overrides
  };
}

describe("session file", () => {
  it("round trips a session written and read back", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    const value = session();
    await writeSession(value, { directory, platform: "linux" });
    const read = await readSession(directory);
    expect(read).toEqual(value);
  });

  it("writes the file at mode 0600 on a platform with file modes", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    await writeSession(session(), { directory, platform: "linux" });
    const info = await stat(path.join(directory, SESSION_FILE_NAME));
    if (process.platform !== "win32") {
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it("documents the file's own protection inside a security field", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    await writeSession(session(), { directory, platform: "linux" });
    const raw = JSON.parse(await readFile(path.join(directory, SESSION_FILE_NAME), "utf8")) as Record<
      string,
      unknown
    >;
    expect(typeof raw["security"]).toBe("string");
    expect((raw["security"] as string).length).toBeGreaterThan(0);
  });

  it("verifies owner only inherited file permissions before writing on Windows", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    const calls: Array<{ executable: string; timeout: number }> = [];
    await writeSession(session(), {
      directory,
      platform: "win32",
      windowsAclRunner: async (executable, _args, timeout) => {
        calls.push({ executable, timeout });
        return executable.endsWith("whoami.exe")
          ? { ok: true, stdout: '"lucas\\lucas","S-1-5-21-1-2-3-1001"\r\n' }
          : timeout >= 15_000 ? { ok: true, stdout: "PRIVATE" } : { ok: false };
      }
    });
    expect(await readSession(directory)).toEqual(session());
    expect(calls.some((call) => call.executable.endsWith("powershell.exe") && call.timeout >= 15_000)).toBe(true);
  });

  it("never calls the Windows ACL runner off Windows", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    let called = false;
    await writeSession(session(), {
      directory,
      platform: "linux",
      windowsAclRunner: async () => {
        called = true;
        return { ok: true, stdout: "" };
      }
    });
    expect(called).toBe(false);
  });

  it("fails closed before writing when the ACL runner itself fails", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    await expect(
      writeSession(session(), {
        directory,
        platform: "win32",
        windowsAclRunner: async () => {
          throw new Error("icacls exploded");
        }
      })
    ).rejects.toThrow("icacls " + directory + " /reset");
    await expect(
      writeSession(session(), {
        directory,
        platform: "win32",
        windowsAclRunner: async () => ({ ok: false, stdout: "" })
      })
    ).rejects.toThrow(directory);
    expect(await readSession(directory)).toBeNull();
  });

  it("refuses a reparse point state directory before the credential write", async (context) => {
    const target = await temporaryDirectory("openlimiter-session-target-");
    const link = path.join(await scratchRoot(), "openlimiter-session-link-");
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return context.skip();
    }
    created.push(link);
    await expect(writeSession(session(), {
      directory: link,
      platform: "win32",
      windowsAclRunner: async (executable) => executable.endsWith("whoami.exe")
        ? { ok: true, stdout: '"lucas\\lucas","S-1-5-21-1-2-3-1001"' }
        : { ok: true, stdout: "PRIVATE" }
    })).rejects.toThrow();
    expect(await readSession(target)).toBeNull();
  });

  it("reads no session from an empty directory", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    expect(await readSession(directory)).toBeNull();
  });

  it("reads no session from a corrupt or foreign shaped file", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, SESSION_FILE_NAME), "{ not json", "utf8");
    expect(await readSession(directory)).toBeNull();

    await writeFile(
      path.join(directory, SESSION_FILE_NAME),
      JSON.stringify({ version: 1, token: "too short" }),
      "utf8"
    );
    expect(await readSession(directory)).toBeNull();
  });

  it("deletes the session, and a second delete is not an error", async () => {
    const directory = await temporaryDirectory("openlimiter-session-");
    await writeSession(session(), { directory, platform: "linux" });
    await deleteSession(directory);
    expect(await readSession(directory)).toBeNull();
    await expect(deleteSession(directory)).resolves.toBeUndefined();
  });
});

describe("sessionIsFresh", () => {
  const expiresAt = "2026-09-07T13:00:00.000Z";

  it("is fresh well inside the renewal window", () => {
    const value = session({ expiresAt });
    expect(sessionIsFresh(value, "2026-09-07T10:00:00.000Z")).toBe(true);
  });

  it("is not fresh once inside the one hour renewal window", () => {
    const value = session({ expiresAt });
    const insideWindow = new Date(
      Date.parse(expiresAt) - RENEWAL_WINDOW_MILLISECONDS + 1_000
    ).toISOString();
    expect(sessionIsFresh(value, insideWindow)).toBe(false);
  });

  it("is not fresh exactly at the boundary", () => {
    const value = session({ expiresAt });
    const boundary = new Date(Date.parse(expiresAt) - RENEWAL_WINDOW_MILLISECONDS).toISOString();
    expect(sessionIsFresh(value, boundary)).toBe(false);
  });

  it("is not fresh once expired", () => {
    const value = session({ expiresAt });
    expect(sessionIsFresh(value, "2026-09-08T00:00:00.000Z")).toBe(false);
  });
});

describe("session lock", () => {
  it("times out with the lock path when another command keeps the lock", async () => {
    const directory = await temporaryDirectory("openlimiter-session-lock-");
    const held = await acquireRefreshLock(directory, Date.now(), SESSION_LOCK_NAME);
    expect(held.ok).toBe(true);
    vi.useFakeTimers();
    try {
      const waiting = import("../src/session.js").then(({ withSessionLock }) =>
        withSessionLock(directory, async () => "unreachable")
      );
      await vi.advanceTimersByTimeAsync(SESSION_LOCK_WAIT_MILLISECONDS + 25);
      await expect(waiting).rejects.toThrow(
        "another OpenLimiter command holds the session lock at " + path.join(directory, SESSION_LOCK_NAME)
      );
    } finally {
      vi.useRealTimers();
      if (held.ok) await held.release();
    }
  });
});
