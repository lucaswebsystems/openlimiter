// Endpoint facts: research/01-codenotch-harvest.md, Cursor recipe.
// This implementation does not translate upstream source code.
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CredentialLookupOptions, CredentialResult } from "./credentials.js";

export function cursorAccountId(authId: string): string {
  return "cursor-" + createHash("sha256").update("cursor").update(new Uint8Array([0])).update(authId).digest("hex").slice(0, 24);
}

export function cursorStatePath(options: CredentialLookupOptions & { homeDirectory: string }): string | null {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const base = platform === "win32" ? environment["APPDATA"]
    : platform === "darwin" ? path.join(options.homeDirectory, "Library", "Application Support")
    : environment["XDG_CONFIG_HOME"] ?? path.join(options.homeDirectory, ".config");
  return base ? path.join(base, "Cursor", "User", "globalStorage", "state.vscdb") : null;
}

export function cursorCookieComponent(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,16384}$/u.test(value);
}

export async function readCursorSession(file: string, nowMilliseconds: number): Promise<CredentialResult> {
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: "unreadable" };
    // Lazy import keeps SQLite out of browser bundles. Read the active WAL in place.
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true, timeout: 250 });
    db.exec("BEGIN");
    const query = db.prepare("SELECT value FROM ItemTable WHERE key = ? AND length(value) BETWEEN 1 AND 16384");
    const token = query.get("cursorAuth/accessToken")?.["value"];
    const authId = query.get("cursorAuth/stripeMembershipAuthId")?.["value"];
    if (token === undefined || authId === undefined) return { ok: false, reason: "absent" };
    if (!cursorCookieComponent(token) || !cursorCookieComponent(authId)) return { ok: false, reason: "invalid" };
    let expiresAtMilliseconds: number | null = null;
    const parts = token.split(".");
    if (parts.length === 3) {
      try {
        const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: unknown };
        if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) expiresAtMilliseconds = claims.exp * 1000;
      } catch { return { ok: false, reason: "invalid" }; }
    }
    if (expiresAtMilliseconds !== null && expiresAtMilliseconds <= nowMilliseconds) return { ok: false, reason: "expired" };
    return { ok: true, credential: { secret: token, accountId: authId, expiresAtMilliseconds, origin: "vendor_file" } };
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" };
  } finally {
    db?.close();
  }
}
