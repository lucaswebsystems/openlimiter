import { describe, expect, it } from "vitest";
import { parseCliLoginResponse } from "@/lib/cli-login";

/**
 * The terminal sign in approve/deny answer, read by status code.
 *
 * The wire error string this build's own vocabulary matches (`unknown_code`,
 * `expired`, `already_used`, `device_cap`) is the ideal case; the fallback
 * that actually carries every one of these four in production is the HTTP
 * status Supabase's client surfaces on `error.context.status`, which is why
 * each of the four is asserted here by status alone, with no matching string
 * in the body at all.
 */

function refusal(status: number): unknown {
  return { context: { status } };
}

describe("parseCliLoginResponse", () => {
  it("reads the four documented refusals by status code alone", () => {
    expect(parseCliLoginResponse(null, refusal(404))).toEqual({
      ok: false,
      error: "unknown_code",
      deviceLabel: null,
    });
    expect(parseCliLoginResponse(null, refusal(410))).toEqual({
      ok: false,
      error: "expired",
      deviceLabel: null,
    });
    expect(parseCliLoginResponse(null, refusal(409))).toEqual({
      ok: false,
      error: "already_used",
      deviceLabel: null,
    });
    expect(parseCliLoginResponse(null, refusal(403))).toEqual({
      ok: false,
      error: "device_cap",
      deviceLabel: null,
    });
  });

  it("falls back to unavailable for a status none of the four documented refusals name", () => {
    expect(parseCliLoginResponse(null, refusal(500))).toEqual({
      ok: false,
      error: "unavailable",
      deviceLabel: null,
    });
  });

  it("prefers a matching error string in the body over a bare status code", () => {
    expect(parseCliLoginResponse({ error: "already_used" }, refusal(500))).toEqual({
      ok: false,
      error: "already_used",
      deviceLabel: null,
    });
  });

  it("reads the device label wherever the answer carries one", () => {
    expect(
      parseCliLoginResponse({ ok: true, device_label: "My terminal" }, null),
    ).toEqual({ ok: true, deviceLabel: "My terminal" });
  });

  it("succeeds on a plain ok answer with no error and no explicit failure", () => {
    expect(parseCliLoginResponse({ ok: true }, null)).toEqual({ ok: true, deviceLabel: null });
  });

  it("reads an explicit ok: false in the body as unavailable", () => {
    expect(parseCliLoginResponse({ ok: false }, null)).toEqual({
      ok: false,
      error: "unavailable",
      deviceLabel: null,
    });
  });
});
