import { NextResponse, type NextRequest } from "next/server";
import { readDeviceSnapshots } from "@/lib/pro-device";
import { PHONE_TOKEN_COOKIE, readPhoneBars } from "@/lib/phone-session";

/**
 * Read the account's meters with the token cookie this path already holds.
 *
 * No token ever travels to or from the browser here: the cookie carries it,
 * and the answer is the rows the phone draws, nothing else. A missing cookie
 * answers `no_pair` so the page knows to ask for a fresh scan rather than
 * treating a browser that was never paired as one that went offline.
 */

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(PHONE_TOKEN_COOKIE)?.value ?? "";
  if (token === "") {
    return NextResponse.json({ error: "no_pair" }, { status: 401 });
  }

  const placeholder = { token, expiresAt: 0, refreshCredential: "", refreshExpiresAt: 0 };
  const answer = await readPhoneBars(placeholder, readDeviceSnapshots);

  if (answer.kind === "revoked") return NextResponse.json({ error: "revoked" }, { status: 403 });
  if (answer.kind !== "fresh") return NextResponse.json({ error: "unavailable" }, { status: 503 });
  return NextResponse.json({ body: answer.body });
}
