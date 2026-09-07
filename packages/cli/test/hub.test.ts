import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUB_URL,
  MAX_HUB_REQUEST_BYTES,
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

describe("hub configuration", () => {
  it("is unconfigured with no anon key, whatever the URL says", () => {
    expect(hubConfigured({})).toBe(false);
    expect(hubConfigured({ OPENLIMITER_SUPABASE_URL: "https://example.supabase.co" })).toBe(false);
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

  it("reads the anon key from the environment and nowhere else", () => {
    expect(hubAnonKey({})).toBe("");
    expect(hubAnonKey(CONFIGURED)).toBe("sb_publishable_test_key");
  });
});

describe("hub request builders", () => {
  it("refuses every request when the hub is not configured", () => {
    expect(cliLoginStartRequest({})).toBeNull();
    expect(cliLoginPollRequest({}, "device-code-1234")).toBeNull();
    expect(grantRenewRequest({}, "a".repeat(20))).toBeNull();
    expect(syncSnapshotsRequest({}, "a".repeat(20), {})).toBeNull();
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
