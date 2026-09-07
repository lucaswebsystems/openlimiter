import { NextResponse, type NextRequest } from "next/server";
import { PHONE_COOKIE_PATH, PHONE_REFRESH_COOKIE, PHONE_TOKEN_COOKIE, phonePairOf } from "@/lib/phone-session";

/**
 * Where the phone's two secrets stop being something JavaScript can read.
 *
 * This route is called exactly once per pairing, right after the approving
 * poll hands the browser a fresh token and refresh credential. It writes both
 * as HttpOnly, Secure, SameSite=Strict cookies scoped to this one path and
 * answers nothing sensitive back: not the token, not the credential, not even
 * an echo of what was sent. From this point on the browser has no way to read
 * either secret again; only this path's own routes can, because only they run
 * on the server the cookies are sent to.
 *
 * DELETE clears both cookies, which is the only way this pairing ends from
 * the browser's side (the server side ending, a revoked epoch, is answered by
 * the renew route instead).
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const pair = phonePairOf(body);
  if (pair === null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const now = Math.floor(Date.now() / 1_000);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PHONE_TOKEN_COOKIE, pair.token, cookieOptions(pair.expiresAt - now));
  response.cookies.set(
    PHONE_REFRESH_COOKIE,
    pair.refreshCredential,
    cookieOptions(pair.refreshExpiresAt - now),
  );
  return response;
}

export async function DELETE(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PHONE_TOKEN_COOKIE, "", cookieOptions(0));
  response.cookies.set(PHONE_REFRESH_COOKIE, "", cookieOptions(0));
  return response;
}
