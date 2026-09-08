import { NextResponse, type NextRequest } from "next/server";
import { renewPhoneCredential } from "@/lib/pro-device";
import {
  PHONE_COOKIE_PATH,
  PHONE_REFRESH_COOKIE,
  PHONE_TOKEN_COOKIE,
  renewPhonePair,
} from "@/lib/phone-session";

/**
 * Trade the refresh cookie for a fresh pair, entirely on the server.
 *
 * The browser sends no body: the refresh credential travels only as the
 * HttpOnly cookie this same path already holds, so this route is the one
 * place it is ever read back out. A successful renewal rotates both cookies
 * and answers only the new expiry, never either secret. The one answer that
 * ends the pairing is the server's explicit revoked epoch signal
 * (`isRevokedEpochResponse`); every other failure, a dead credential, a
 * closed connection, a 5xx, leaves the cookies exactly as they were so the
 * next attempt can still succeed.
 */

export const runtime = "nodejs";

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: "strict" as const,
    path: PHONE_COOKIE_PATH,
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const refreshCredential = request.cookies.get(PHONE_REFRESH_COOKIE)?.value ?? "";
  if (refreshCredential === "") {
    return NextResponse.json({ error: "no_pair" }, { status: 401 });
  }

  const placeholder = { token: "", expiresAt: 0, refreshCredential, refreshExpiresAt: 0 };
  const outcome = await renewPhonePair(placeholder, async (credential) => {
    const response = await renewPhoneCredential(credential);
    /* The hosted service uses 401 for an expired refresh credential. Turn that
       server answer into the route's explicit permanent no_pair reason while
       leaving the pure renewal helper's generic 401 contract intact. */
    return response.status === 401 ? { ...response, body: { error: "no_pair" } } : response;
  });

  if (outcome.kind === "revoked") {
    const response = NextResponse.json({ error: "revoked" }, { status: 403 });
    response.cookies.set(PHONE_TOKEN_COOKIE, "", cookieOptions(0));
    response.cookies.set(PHONE_REFRESH_COOKIE, "", cookieOptions(0));
    return response;
  }
  if (outcome.kind === "unpaired") {
    return NextResponse.json({ error: "no_pair" }, { status: 401 });
  }
  if (outcome.kind !== "renewed") {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  const now = Math.floor(Date.now() / 1_000);
  const response = NextResponse.json({ expires_at: outcome.pair.expiresAt });
  response.cookies.set(
    PHONE_TOKEN_COOKIE,
    outcome.pair.token,
    cookieOptions(outcome.pair.expiresAt - now),
  );
  response.cookies.set(
    PHONE_REFRESH_COOKIE,
    outcome.pair.refreshCredential,
    cookieOptions(outcome.pair.refreshExpiresAt - now),
  );
  return response;
}
