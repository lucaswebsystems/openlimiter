import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./pro";

/**
 * The three calls a device with no account session makes.
 *
 * A paired phone holds no Supabase session, only a read scoped device token, so
 * these go out as plain requests rather than through the account client. Each
 * one returns the status and the parsed body untouched, because the decision
 * about what a response means belongs to the pure state machine in
 * lib/pairing.ts rather than to the transport.
 *
 * Nothing here logs, stores or prints a token or a code.
 */

export interface HostedResponse {
  status: number;
  body: unknown;
}

const UNREACHABLE: HostedResponse = { status: 0, body: null };

async function post(
  fn: string,
  body: Record<string, unknown>,
  deviceToken?: string,
): Promise<HostedResponse> {
  if (SUPABASE_URL === "" || SUPABASE_ANON_KEY === "") return UNREACHABLE;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
  if (deviceToken !== undefined && deviceToken !== "") {
    headers["x-openlimiter-entitlement"] = deviceToken;
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } catch {
    return UNREACHABLE;
  }
}

export interface ClaimDevice {
  name: string;
  platform: string;
  user_agent_hash: string;
}

/** Claim a pairing code. The code travels in the body and nowhere else. */
export function claimPairingCode(code: string, device: ClaimDevice): Promise<HostedResponse> {
  return post("pair-device", { action: "claim", code, device });
}

/** Ask whether the desktop has answered yet. */
export function pollPairingClaim(claimId: string): Promise<HostedResponse> {
  return post("pair-device", { action: "poll", claim_id: claimId });
}

/** Read the account's current meters with a read scoped device token. */
export function readDeviceSnapshots(deviceToken: string): Promise<HostedResponse> {
  return post("pro-service", { action: "read_snapshots" }, deviceToken);
}

/** Rotate a device token before it expires. Retried with the same request id. */
export function refreshDeviceToken(
  deviceToken: string,
  requestId: string,
): Promise<HostedResponse> {
  return post("entitlement", { action: "refresh", request_id: requestId }, deviceToken);
}
