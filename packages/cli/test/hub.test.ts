import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUB_URL,
  MAX_HUB_REQUEST_BYTES,
  cliLoginAckRequest,
  cliLoginPollRequest,
  cliLoginStartRequest,
  grantRenewRequest,
  hubAnonKey,
  hubBaseUrl,
  hubConfigured,
  parseHubJson,
  syncSnapshotsRequest
} from "../src/hub.js";

const CONFIGURED = { OPENLIMITER_SUPABASE_ANON_KEY: "sb_publishable_test_key" };
const OFF = { OPENLIMITER_SUPABASE_ANON_KEY: "off" };

describe("hub configuration", () => {
  it("is unconfigured when the key override is off, whatever the URL says", () => {
    expect(hubConfigured(OFF)).toBe(false);
    expect(hubConfigured({ ...OFF, OPENLIMITER_SUPABASE_URL: "https://example.supabase.co" })).toBe(false);
    expect(hubConfigured({})).toBe(true);
  });

  it("is configured once an anon key is present", () => {
    expect(hubConfigured(CONFIGURED)).toBe(true);
  });

  it("falls back to the default project address", () => {
    expect(hubBaseUrl({})).toBe(DEFAULT_HUB_URL);
    expect(hubBaseUrl({ OPENLIMITER_SUPABASE_URL: "https://other.supabase.co" })).toBe(
      "https://other.supabase.co"
    );
  });

  it("never accepts plain http, whatever host an override names", () => {
    expect(hubBaseUrl({ OPENLIMITER_SUPABASE_URL: "http://other.supabase.co" })).toBe(DEFAULT_HUB_URL);
    expect(hubBaseUrl({ OPENLIMITER_SUPABASE_URL: "http://" + DEFAULT_HUB_URL.replace(/^https:\/\//u, "") })).toBe(
      DEFAULT_HUB_URL
    );
  });

  it("falls back to the default project address for an override that is not a readable URL at all", () => {
    expect(hubBaseUrl({ OPENLIMITER_SUPABASE_URL: "not a url" })).toBe(DEFAULT_HUB_URL);
    expect(hubBaseUrl({ OPENLIMITER_SUPABASE_URL: "ftp://other.supabase.co" })).toBe(DEFAULT_HUB_URL);
  });

  it("reads the override, ships a default, and off disables the hub", () => {
    expect(hubAnonKey({}).length).toBeGreaterThan(20);
    expect(hubAnonKey(OFF)).toBe("");
    expect(hubAnonKey(CONFIGURED)).toBe("sb_publishable_test_key");
  });
});

describe("hub request builders", () => {
  it("refuses every request when the hub is switched off", () => {
    expect(cliLoginStartRequest(OFF)).toBeNull();
    expect(cliLoginPollRequest(OFF, "device-code-1234")).toBeNull();
    expect(grantRenewRequest(OFF, "a".repeat(20))).toBeNull();
    expect(syncSnapshotsRequest(OFF, "a".repeat(20), {})).toBeNull();
  });

  it("builds the login start request against the closed cli-login endpoint", () => {
    const request = cliLoginStartRequest(CONFIGURED);
    expect(request).not.toBeNull();
    expect(request?.url).toBe(DEFAULT_HUB_URL + "/functions/v1/cli-login");
    expect(request?.method).toBe("POST");
    expect(request?.headers["apikey"]).toBe("sb_publishable_test_key");
    expect(request?.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(request?.body ?? "{}")).toEqual({ action: "start" });
  });

  it("builds the poll request carrying the device code, and refuses a malformed one", () => {
    const request = cliLoginPollRequest(CONFIGURED, "abc123device");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      action: "poll",
      device_code: "abc123device"
    });
    expect(cliLoginPollRequest(CONFIGURED, "")).toBeNull();
    expect(cliLoginPollRequest(CONFIGURED, "has a space")).toBeNull();
  });

  it("builds proof bound start, poll, and acknowledgement requests", () => {
    const proof = "p".repeat(43);
    const hash = "h".repeat(43);
    expect(JSON.parse(cliLoginStartRequest(CONFIGURED, hash)?.body ?? "{}")).toEqual({
      action: "start",
      client_proof_hash: hash
    });
    expect(JSON.parse(cliLoginPollRequest(CONFIGURED, "abc123device", proof)?.body ?? "{}")).toEqual({
      action: "poll",
      device_code: "abc123device",
      client_proof: proof
    });
    expect(JSON.parse(cliLoginAckRequest(CONFIGURED, "abc123device", "t".repeat(32), proof)?.body ?? "{}")).toEqual({
      action: "ack",
      device_code: "abc123device",
      token: "t".repeat(32),
      client_proof: proof
    });
    expect(cliLoginStartRequest(CONFIGURED, "short")).toBeNull();
    expect(cliLoginPollRequest(CONFIGURED, "abc123device", "short")).toBeNull();
    expect(cliLoginAckRequest(CONFIGURED, "abc123device", "t".repeat(32), "short")).toBeNull();
  });

  it("builds the renewal request against pro-service", () => {
    const credential = "refresh-credential-1234567890";
    const request = grantRenewRequest(CONFIGURED, credential);
    expect(request?.url).toBe(DEFAULT_HUB_URL + "/functions/v1/pro-service");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      action: "grant_renew",
      refresh_credential: credential
    });
    expect(grantRenewRequest(CONFIGURED, "too-short")).toBeNull();
  });

  it("builds the sync request with a bearer token and refuses an empty one", () => {
    const token = "a".repeat(32);
    const request = syncSnapshotsRequest(CONFIGURED, token, { hello: "world" });
    expect(request?.url).toBe(DEFAULT_HUB_URL + "/functions/v1/sync-snapshots");
    expect(request?.headers["authorization"]).toBe("Bearer " + token);
    expect(request?.body).toBe(JSON.stringify({ hello: "world" }));
    expect(syncSnapshotsRequest(CONFIGURED, "", { hello: "world" })).toBeNull();
  });

  it("refuses a body larger than the request bound", () => {
    const token = "a".repeat(32);
    const huge = { blob: "x".repeat(MAX_HUB_REQUEST_BYTES) };
    expect(syncSnapshotsRequest(CONFIGURED, token, huge)).toBeNull();
  });
});

describe("parseHubJson", () => {
  it("reads a JSON object and refuses everything else", () => {
    expect(parseHubJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseHubJson("[]")).toBeNull();
    expect(parseHubJson("not json")).toBeNull();
    expect(parseHubJson("")).toBeNull();
  });
});
