import { NextResponse, type NextRequest } from "next/server";
import { readDeviceSnapshots } from "@/lib/pro-device";
import { PHONE_TOKEN_COOKIE, phoneTokenPlanOf, readPhoneBars } from "@/lib/phone-session";

/**
 * Read the account's meters with the token cookie this path already holds.
 *
 * No token ever travels to or from the browser here: the cookie carries it,
 * and the answer is the rows the phone draws, nothing else. A missing cookie
 * answers `no_pair` so the page knows to ask for a fresh scan rather than
 * treating a browser that was never paired as one that went offline.
 */

export const runtime = "nodejs";

function privateJson(body: unknown, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(PHONE_TOKEN_COOKIE)?.value ?? "";
  if (token === "") {
    return privateJson({ error: "no_pair" }, { status: 401 });
  }

  const placeholder = { token, expiresAt: 0, refreshCredential: "", refreshExpiresAt: 0 };
  const answer = await readPhoneBars(placeholder, readDeviceSnapshots);

  if (answer.kind === "revoked") return privateJson({ error: "revoked" }, { status: 403 });
  /* The same shape the missing cookie branch above already answers: the
     browser's requestPhoneRead reads this exact { error: "no_pair" } at 401
     as `unpaired` and fires onUnpaired, which is the correct ending for a
     token the upstream no longer accepts at all, not a retry. */
  if (answer.kind === "unpaired") return privateJson({ error: "no_pair" }, { status: 401 });
  if (answer.kind !== "fresh") return privateJson({ error: "unavailable" }, { status: 503 });
  /* The answer as the server gave it, the account's current plan included.
     Only an answer with no entitlement key, from an older server or a
     rollback, gets the plan signed into the token beside it; the token itself
     never leaves the cookie. See phoneEntitlementOf in lib/phone-session.ts. */
  const body = answer.body;
  const reported = body !== null && typeof body === "object" && "entitlement" in body;
  const plan = reported ? null : phoneTokenPlanOf(token);
  return privateJson(plan === null ? { body } : { body, plan });
}
