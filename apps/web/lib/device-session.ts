/**
 * The phone's device session, held in this browser and nowhere else.
 *
 * A paired phone has no Supabase session. What it has is a read scoped device
 * token, minted by the Pro server when the desktop approved the pairing, plus
 * the refresh material that says when to ask for the next one.
 *
 * IT IS DELIBERATELY NOT A COOKIE
 * -------------------------------
 * A cookie is attached to every request this origin makes, which would put a
 * bearer token in front of the website, the static assets and any future route
 * that never needed it. This token belongs in exactly one header, on exactly
 * the calls that read quota, so it lives in local storage and is read by the
 * code that builds those calls. Nothing here writes a cookie, and nothing here
 * sends anything anywhere.
 */

const STORAGE_KEY = "openlimiter-device-session";

export interface DeviceSession {
  /** The signed, read scoped token. Sent only as x-openlimiter-entitlement. */
  token: string;
  /** Unix seconds. Ask for a fresh token once the clock passes this. */
  refreshAfter: number;
  /** Unix seconds. The token is not accepted after this. */
  expiresAt: number;
  /** Unix seconds. The last moment a refresh can still recover the session. */
  graceUntil: number;
  /** What the server said the plan was at pairing time. Display only. */
  planState: string;
  features: string[];
  interval: string | null;
}

function seconds(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A poll delivery, as a session.
 *
 * The one place the server's approved response becomes something this app
 * stores, so a malformed delivery is refused here rather than three screens
 * later. Null means the response was not a delivery.
 */
export function deviceSessionOf(value: unknown): DeviceSession | null {
  const row = record(value);
  if (row === null || row.status !== "approved") return null;
  const token = typeof row.device_token === "string" ? row.device_token : "";
  const refresh = record(row.refresh);
  const summary = record(row.entitlement_summary);
  const refreshAfter = seconds(refresh?.after);
  const expiresAt = seconds(refresh?.expires_at);
  const graceUntil = seconds(refresh?.grace_until);
  if (token === "" || refreshAfter === null || expiresAt === null || graceUntil === null) {
    return null;
  }
  const features = Array.isArray(summary?.features)
    ? summary.features.filter((item): item is string => typeof item === "string")
    : [];
  return {
    token,
    refreshAfter,
    expiresAt,
    graceUntil,
    planState: typeof summary?.plan_state === "string" ? summary.plan_state : "unknown",
    features,
    interval: typeof summary?.interval === "string" ? summary.interval : null,
  };
}

export function readDeviceSession(): DeviceSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : storedSessionOf(raw);
  } catch {
    return null;
  }
}

/**
 * The stored shape, which is the session itself rather than a poll response.
 *
 * `deviceSessionOf` reads the wire shape; a value written by `writeDeviceSession`
 * is already flat, so it is parsed here instead of being reshaped on the way in
 * and out.
 */
export function storedSessionOf(raw: string): DeviceSession | null {
  const row = record(JSON.parse(raw));
  const token = typeof row?.token === "string" ? row.token : "";
  const refreshAfter = seconds(row?.refreshAfter);
  const expiresAt = seconds(row?.expiresAt);
  const graceUntil = seconds(row?.graceUntil);
  if (token === "" || refreshAfter === null || expiresAt === null || graceUntil === null) {
    return null;
  }
  return {
    token,
    refreshAfter,
    expiresAt,
    graceUntil,
    planState: typeof row?.planState === "string" ? row.planState : "unknown",
    features: Array.isArray(row?.features)
      ? row.features.filter((item): item is string => typeof item === "string")
      : [],
    interval: typeof row?.interval === "string" ? row.interval : null,
  };
}

/** The token alone, for the one header that carries it. */
export function readDeviceToken(): string | null {
  return readDeviceSession()?.token ?? null;
}

export function writeDeviceSession(session: DeviceSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* A browser with storage refused keeps the session in memory only. */
  }
}

export function clearDeviceSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing to clear if storage was never available. */
  }
}

/** Whether a stored session is still worth sending. Pure, so it is testable. */
export function deviceSessionUsable(
  session: DeviceSession | null,
  now: number = Date.now(),
): boolean {
  if (session === null) return false;
  return session.graceUntil * 1_000 > now;
}

/** Whether the token should be rotated before the next read. */
export function deviceSessionNeedsRefresh(
  session: DeviceSession | null,
  now: number = Date.now(),
): boolean {
  if (session === null) return false;
  return session.refreshAfter * 1_000 <= now;
}
