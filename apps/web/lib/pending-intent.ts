import { cleanCliCode, validateCliCode } from "./cli-login";

const KEY = "openlimiter-pending-intent";
// Local storage also covers an email link returning in a new tab. No action is auto approved.
export const INTENT_TTL_MS = 10 * 60_000;
type Intent = { kind: "cli"; code: string } | { kind: "trial" };
type StoredIntent = Intent & { expiresAt: number; userId: string | null };

export function rememberIntent(intent: Intent, userId: string | null = null): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({
      ...intent,
      expiresAt: Date.now() + INTENT_TTL_MS,
      userId,
    } satisfies StoredIntent));
    return true;
  } catch { return false; }
}

export function pendingIntent(userId?: string | null): Intent | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() ||
        value.expiresAt > Date.now() + INTENT_TTL_MS) {
      clearIntent();
      return null;
    }
    if (userId !== undefined) {
      const storedUserId = typeof value.userId === "string" ? value.userId : null;
      if (storedUserId !== null && storedUserId !== userId) {
        clearIntent();
        return null;
      }
      if (userId === null && storedUserId !== null) {
        clearIntent();
        return null;
      }
      if (storedUserId === null && userId !== null) {
        window.localStorage.setItem(KEY, JSON.stringify({ ...value, userId } satisfies StoredIntent));
      }
    }
    if (value.kind === "trial") return { kind: "trial" };
    if (value.kind === "cli" && typeof value.code === "string" && validateCliCode(value.code).valid) {
      return { kind: "cli", code: cleanCliCode(value.code) };
    }
  } catch { /* Storage can be unavailable. */ }
  return null;
}

export function clearIntent(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* Nothing persisted. */ }
}
