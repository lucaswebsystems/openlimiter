import { createElement } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudMeterPanel, CloudSpendRows } from "@/app/app/cloud-meter-panel";
import { OpenRouterCallbackView as OpenRouterCallbackPage } from "@/app/app/openrouter/callback/openrouter-callback-view";
import {
  cloudMeterKeyOf,
  cloudMeterKeysOf,
  deleteCloudKey,
  listCloudKeys,
  pollCloudKeyNow,
  storeCloudKey,
} from "@/lib/cloud-meter";
import {
  buildOpenRouterAuthorization,
  codeChallengeOf,
  exchangeOpenRouterCode,
  generateCodeVerifier,
  openRouterCallbackParams,
  storeOpenRouterVerifier,
  takeOpenRouterVerifier,
} from "@/lib/openrouter-oauth";
import { all, byText, flush, render, type Mounted } from "./render";
import * as accountClient from "@/lib/account-client";

/**
 * Cloud metering and OpenRouter sign in: the pure contract parsing, the
 * transport against a scripted Supabase client, the PKCE math against RFC
 * 7636's own published vector, and the three screens (the Configuration
 * panel, the bars row, the callback page) against a stubbed fetch. Nothing
 * here reaches openrouter.ai or a real Supabase project.
 */

vi.mock("next-intl", async () => {
  const catalog = (await import("../messages/en.json")).default as Record<string, unknown>;
  return {
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
      const path = `${namespace}.${key}`.split(".");
      let node: unknown = catalog;
      for (const step of path) {
        node =
          node === null || typeof node !== "object"
            ? undefined
            : (node as Record<string, unknown>)[step];
      }
      if (typeof node !== "string") throw new Error(`missing message: ${path.join(".")}`);
      return node.replace(/\{(\w+)\}/gu, (whole, name: string) =>
        values?.[name] === undefined ? whole : String(values[name]),
      );
    },
  };
});

vi.mock("next/link", async () => {
  const { createElement: element } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      element("a", { href, ...rest }, children as never),
  };
});

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function press(node: Element | null): void {
  expect(node).not.toBeNull();
  mounted?.run(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(input: Element | null, value: string): void {
  expect(input).not.toBeNull();
  mounted?.run(() => {
    const element = input as HTMLInputElement;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/* ------------------------------------------------------------- the contract */

describe("the wire shape", () => {
  it.each([null, true, false, "", "   "])("28: does not turn missing money %s into zero", (amount) => {
    expect(cloudMeterKeyOf({ id: "k1", provider: "xai", label: "Usage", amount, currency: "USD" }))
      .toMatchObject({ amount: null, currency: null });
  });

  it("19: reads the real poll field and ages an old successful amount", () => {
    const row = cloudMeterKeyOf({ id: "k1", provider: "xai", label: "Usage", amount: 10, currency: "USD", last_status: "ok", last_polled_at: "2026-09-08T12:00:00Z" });
    expect(row?.observedAt).toBe("2026-09-08T12:00:00.000Z");
    mounted = render(createElement(CloudSpendRows, { rows: [row!], now: "2026-09-08T12:06:00Z" }));
    expect(mounted.container.querySelector("[data-state=stale]")).not.toBeNull();
    expect(mounted.container.textContent).toContain("Observed");
    expect(mounted.container.textContent).toContain("Stale");
  });

  it("treats a future poll as stale with an unknown age", () => {
    const row = cloudMeterKeyOf({ id: "k1", provider: "xai", label: "Usage", amount: 10, currency: "USD", last_status: "ok", last_polled_at: "2026-09-08T12:01:00Z" });
    expect(row?.observedAt).toBe("2026-09-08T12:01:00.000Z");
    mounted = render(createElement(CloudSpendRows, { rows: [row!], now: "2026-09-08T12:00:00Z" }));
    expect(mounted.container.querySelector("[data-state=stale]")).not.toBeNull();
    expect(mounted.container.textContent).toContain("Observation age unknown");
    expect(mounted.container.querySelector(".sr-only")?.textContent).toContain("Stale");
  });
  it("parses a stored row and rejects one missing a required field", () => {
    const row = cloudMeterKeyOf({
      id: "k1",
      provider: "anthropic_admin",
      label: "Prod org",
      last_status: "ok",
    });
    expect(row).toEqual({
      id: "k1",
      provider: "anthropic_admin",
      label: "Prod org",
      lastStatus: "ok",
      amount: null,
      currency: null,
      observedAt: null,
    });
    expect(cloudMeterKeyOf({ id: "k1", provider: "not_a_provider", label: "x" })).toBeNull();
    expect(cloudMeterKeyOf({ id: "", provider: "xai", label: "x" })).toBeNull();
  });

  it("carries an amount only when a currency comes with it", () => {
    expect(
      cloudMeterKeyOf({ id: "k1", provider: "xai", label: "x", amount: 12.5, currency: "USD" }),
    ).toMatchObject({ amount: 12.5, currency: "USD" });
    expect(
      cloudMeterKeyOf({ id: "k1", provider: "xai", label: "x", amount: 12.5 }),
    ).toMatchObject({ amount: null, currency: null });
  });

  it("reads every valid row out of a list answer and drops the rest", () => {
    const rows = cloudMeterKeysOf({
      rows: [
        { id: "k1", provider: "moonshot", label: "Kimi key", last_status: "needs_attention" },
        { id: "bad" },
        { id: "k2", provider: "openrouter", label: "OpenRouter", last_status: "ok" },
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["k1", "k2"]);
  });

  it("accepts every status the hub's own vocabulary carries, and nothing else", () => {
    for (const status of ["ok", "error", "rate_limited", "unauthorized", "needs_attention"]) {
      expect(cloudMeterKeyOf({ id: "k1", provider: "xai", label: "x", last_status: status })).toMatchObject({
        lastStatus: status,
      });
    }
    expect(
      cloudMeterKeyOf({ id: "k1", provider: "xai", label: "x", last_status: "pending" }),
    ).toMatchObject({ lastStatus: "unknown" });
    expect(
      cloudMeterKeyOf({ id: "k1", provider: "xai", label: "x", last_status: "made_up" }),
    ).toMatchObject({ lastStatus: "unknown" });
  });
});

function fakeClient(invokeHandler: (name: string, options: unknown) => Promise<unknown>): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    },
    functions: { invoke: vi.fn(invokeHandler) },
  } as unknown as SupabaseClient;
}

describe("the four actions, against a scripted client", () => {
  it("stores a key and answers the row, never the key itself", async () => {
    let sentBody: unknown = null;
    const client = fakeClient(async (_fn, options) => {
      sentBody = (options as { body: unknown }).body;
      return { data: { id: "k1", provider: "xai", label: "Prod", last_status: "needs_attention" }, error: null };
    });
    const result = await storeCloudKey(client, { provider: "xai", label: "Prod", key: "secret-value" });
    expect(sentBody).toEqual({ action: "store", provider: "xai", label: "Prod", key: "secret-value" });
    expect(result).toEqual({
      ok: true,
      value: { id: "k1", provider: "xai", label: "Prod", lastStatus: "needs_attention", amount: null, currency: null, observedAt: null },
    });
  });

  it("answers needsPro on a 403, disabled on a 503, and invalidKey on a 400 from store", async () => {
    const forbidden = fakeClient(async () => ({
      data: null,
      error: { context: { status: 403 } },
    }));
    expect(await storeCloudKey(forbidden, { provider: "xai", label: "x", key: "k" })).toEqual({
      ok: false,
      reason: "needsPro",
    });

    const off = fakeClient(async () => ({ data: null, error: { context: { status: 503 } } }));
    expect(await listCloudKeys(off)).toEqual({ ok: false, reason: "disabled" });

    const invalid = fakeClient(async () => ({ data: null, error: { context: { status: 400 } } }));
    expect(await storeCloudKey(invalid, { provider: "xai", label: "x", key: "k" })).toEqual({
      ok: false,
      reason: "invalidKey",
    });
  });

  it("lists, polls and deletes by id", async () => {
    const seen: unknown[] = [];
    const client = fakeClient(async (_fn, options) => {
      seen.push((options as { body: unknown }).body);
      const body = (options as { body: { action: string } }).body;
      if (body.action === "list") {
        return { data: { rows: [{ id: "k1", provider: "moonshot", label: "Kimi", last_status: "ok" }] }, error: null };
      }
      if (body.action === "poll_now") {
        return { data: { id: "k1", provider: "moonshot", label: "Kimi", last_status: "ok", amount: 4.2, currency: "USD" }, error: null };
      }
      return { data: { ok: true }, error: null };
    });
    expect((await listCloudKeys(client)).ok).toBe(true);
    const polled = await pollCloudKeyNow(client, "k1");
    expect(polled).toMatchObject({ ok: true, value: { amount: 4.2, currency: "USD" } });
    expect(await deleteCloudKey(client, "k1")).toEqual({ ok: true, value: null });
    expect(seen).toEqual([
      { action: "list" },
      { action: "poll_now", id: "k1" },
      { action: "delete", id: "k1" },
    ]);
  });
});

/* -------------------------------------------------------------------- PKCE */

describe("the OpenRouter PKCE math", () => {
  it("matches RFC 7636's own worked example", async () => {
    /* Appendix B: the published verifier and the S256 challenge it produces. */
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await codeChallengeOf(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a verifier inside RFC 7636's own length bounds", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(generateCodeVerifier()).not.toBe(verifier);
  });

  it("builds the documented authorize address with S256", async () => {
    const { url, nonce, verifier } = await buildOpenRouterAuthorization();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://openrouter.ai/auth");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBe(await codeChallengeOf(verifier));
    const callback = new URL(parsed.searchParams.get("callback_url") ?? "");
    expect(callback.pathname).toBe("/app/openrouter/callback");
    expect(callback.searchParams.get("n")).toBe(nonce);
  });

  it("stores the verifier under its nonce and removes it on the one read", () => {
    storeOpenRouterVerifier("nonce-1", "verifier-1");
    expect(takeOpenRouterVerifier("nonce-1")).toBe("verifier-1");
    expect(takeOpenRouterVerifier("nonce-1")).toBeNull();
  });

  it("exchanges a code for a key against the documented endpoint", async () => {
    let sentUrl: string | null = null;
    let sentBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sentUrl = url;
        sentBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ key: "sk-or-v1-abc" }), { status: 200 });
      }),
    );
    const outcome = await exchangeOpenRouterCode("the-code", "the-verifier");
    expect(sentUrl).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(sentBody).toEqual({
      code: "the-code",
      code_verifier: "the-verifier",
      code_challenge_method: "S256",
    });
    expect(outcome).toEqual({ ok: true, key: "sk-or-v1-abc" });
  });

  it("answers not ok on a refused exchange", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 400 })));
    expect(await exchangeOpenRouterCode("code", "verifier")).toEqual({ ok: false });
  });

  it("reads the code and nonce back out of the callback query", () => {
    expect(openRouterCallbackParams("?code=abc&n=xyz")).toEqual({ code: "abc", nonce: "xyz" });
    expect(openRouterCallbackParams("")).toEqual({ code: null, nonce: null });
  });
});

/* ------------------------------------------------------------------ the panel */

describe("the Configuration panel", () => {
  it("shows the trial offer on needsPro, and asks for nothing else", async () => {
    const client = fakeClient(async () => ({ data: null, error: { context: { status: 403 } } }));
    mounted = render(createElement(CloudMeterPanel, { client, onStartTrial: () => undefined }));
    await flush(3);
    expect(mounted.container.textContent).toContain("Start a free trial to meter spend from the cloud");
  });

  it("shows switched off on a 503", async () => {
    const client = fakeClient(async () => ({ data: null, error: { context: { status: 503 } } }));
    mounted = render(createElement(CloudMeterPanel, { client, onStartTrial: () => undefined }));
    await flush(3);
    expect(mounted.container.textContent).toContain("switched off");
  });

  it("lists stored keys with Poll now and Delete, and calls the right action", async () => {
    const calls: string[] = [];
    const client = fakeClient(async (_fn, options) => {
      const body = (options as { body: { action: string } }).body;
      calls.push(body.action);
      if (body.action === "list") {
        return { data: { rows: [{ id: "k1", provider: "xai", label: "My xAI key", last_status: "ok" }] }, error: null };
      }
      return { data: { id: "k1", provider: "xai", label: "My xAI key", last_status: "ok" }, error: null };
    });
    mounted = render(createElement(CloudMeterPanel, { client, onStartTrial: () => undefined }));
    await flush(3);
    expect(mounted.container.textContent).toContain("My xAI key");

    press(byText(mounted.container, "button", "Poll now"));
    await flush(3);
    press(byText(mounted.container, "button", "Delete"));
    await flush(3);

    expect(calls).toEqual(["list", "poll_now", "list", "delete", "list"]);
  });

  it("never persists the typed key anywhere, success or failure", async () => {
    const client = fakeClient(async (_fn, options) => {
      const body = (options as { body: { action: string } }).body;
      if (body.action === "list") return { data: { rows: [] }, error: null };
      return { data: { id: "k1", provider: "xai", label: "New key", last_status: "needs_attention" }, error: null };
    });
    mounted = render(createElement(CloudMeterPanel, { client, onStartTrial: () => undefined }));
    await flush(3);

    const labelInput = all(mounted.container, "input[type='text']")[0] ?? null;
    const keyInput = mounted.container.querySelector("input[type='password']");
    typeInto(labelInput, "New key");
    typeInto(keyInput, "sk-super-secret");
    await flush();

    /* Before submit: the field holds it in memory, storage holds nothing. */
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);

    press(byText(mounted.container, "button", "Add"));
    await flush(4);

    /* After a successful submit: the field is cleared and nothing was ever
       written to a store this browser keeps between reloads. */
    expect((keyInput as HTMLInputElement).value).toBe("");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(
      Object.keys(window.localStorage).some((entry) => entry.includes("sk-super-secret")),
    ).toBe(false);
  });

  it("shows the generic error and still clears the field on a refused store", async () => {
    const client = fakeClient(async (_fn, options) => {
      const body = (options as { body: { action: string } }).body;
      if (body.action === "list") return { data: { rows: [] }, error: null };
      return { data: null, error: { context: { status: 500 } } };
    });
    mounted = render(createElement(CloudMeterPanel, { client, onStartTrial: () => undefined }));
    await flush(3);

    typeInto(all(mounted.container, "input[type='text']")[0] ?? null, "Label");
    typeInto(mounted.container.querySelector("input[type='password']"), "sk-secret");
    await flush();
    press(byText(mounted.container, "button", "Add"));
    await flush(4);

    expect(mounted.container.textContent).toContain("The service did not answer. Try again.");
    expect((mounted.container.querySelector("input[type='password']") as HTMLInputElement).value).toBe("");
  });

  it("shows the invalid key sentence, never the outage sentence, on a 400 from store", async () => {
    const client = fakeClient(async (_fn, options) => {
      const body = (options as { body: { action: string } }).body;
      if (body.action === "list") return { data: { rows: [] }, error: null };
      return { data: null, error: { context: { status: 400 } } };
    });
    mounted = render(createElement(CloudMeterPanel, { client, onStartTrial: () => undefined }));
    await flush(3);

    typeInto(all(mounted.container, "input[type='text']")[0] ?? null, "Label");
    typeInto(mounted.container.querySelector("input[type='password']"), "sk-secret");
    await flush();
    press(byText(mounted.container, "button", "Add"));
    await flush(4);

    expect(mounted.container.textContent).toContain("That key could not be added. Check it and try again.");
    expect(mounted.container.textContent).not.toContain("The service did not answer. Try again.");
  });

  it("gives rate_limited and unauthorized rows their own sentence in the list", async () => {
    const client = fakeClient(async (_fn, options) => {
      const body = (options as { body: { action: string } }).body;
      if (body.action !== "list") return { data: { ok: true }, error: null };
      return {
        data: {
          rows: [
            { id: "k1", provider: "xai", label: "Rate limited key", last_status: "rate_limited" },
            { id: "k2", provider: "moonshot", label: "Unauthorized key", last_status: "unauthorized" },
          ],
        },
        error: null,
      };
    });
    mounted = render(createElement(CloudMeterPanel, { client, onStartTrial: () => undefined }));
    await flush(3);
    expect(mounted.container.textContent).toContain("Too many attempts. Try again in a moment.");
    expect(mounted.container.textContent).toContain("That key could not be added. Check it and try again.");
  });
});

describe("the bars view's cloud spend rows", () => {
  it.each(["poll_now", "delete"])("29: awaits %s, reports failure and releases both buttons", async (action) => {
    let finish: (answer: unknown) => void = () => undefined;
    const client = fakeClient(async (_name, options) => {
      if ((options as { body: { action: string } }).body.action === "list") {
        return { data: { rows: [{ id: "k1", provider: "xai", label: "Usage", last_status: "ok" }] }, error: null };
      }
      return new Promise((resolve) => { finish = resolve; });
    });
    mounted = render(createElement(CloudMeterPanel, { client, onStartTrial: () => undefined }));
    await flush(4);
    const row = mounted.container.querySelector(".ol-directory-row")!;
    const buttons = [...row.querySelectorAll("button")];
    press(buttons[action === "poll_now" ? 0 : 1]);
    await flush();
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await mounted.run(async () => { finish({ data: null, error: { context: { status: 503 } } }); });
    await flush(3);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(row.querySelector("[role=alert]")?.textContent).toContain("not");
  });
  it("draws a row per priced key, with the cloud glyph and its own label", async () => {
    const client = fakeClient(async () => ({
      data: {
        rows: [
          { id: "k1", provider: "xai", label: "My xAI key", last_status: "ok", amount: 9.5, currency: "USD", last_polled_at: "2026-09-08T12:00:00.000Z" },
          { id: "k2", provider: "moonshot", label: "Unpolled key", last_status: "needs_attention" },
        ],
      },
      error: null,
    }));
    const result = await listCloudKeys(client);
    mounted = render(createElement(CloudSpendRows, { rows: result.ok ? result.value : [], now: new Date().toISOString() }));
    await flush(3);
    expect(mounted.container.textContent).toContain("My xAI key");
    expect(mounted.container.querySelector("svg")).not.toBeNull();
  });

  it("never hides an unpolled key, and reads its unpolled sentence rather than nothing", async () => {
    const client = fakeClient(async () => ({
      data: {
        rows: [{ id: "k2", provider: "moonshot", label: "Unpolled key", last_status: "needs_attention" }],
      },
      error: null,
    }));
    const result = await listCloudKeys(client);
    mounted = render(createElement(CloudSpendRows, { rows: result.ok ? result.value : [], now: new Date().toISOString() }));
    await flush(3);
    expect(mounted.container.textContent).toContain("Unpolled key");
    expect(mounted.container.textContent).toContain("First poll pending");
    expect(
      mounted.container.querySelector("[data-state='stale']"),
    ).not.toBeNull();
  });

  it("draws nothing at all with no client or no rows", async () => {
    mounted = render(createElement(CloudSpendRows, { rows: [], now: new Date().toISOString() }));
    await flush();
    expect(mounted.container.textContent?.trim()).toBe("");

    const empty = fakeClient(async () => ({ data: { rows: [] }, error: null }));
    mounted.unmount();
    const result = await listCloudKeys(empty);
    mounted = render(createElement(CloudSpendRows, { rows: result.ok ? result.value : [], now: new Date().toISOString() }));
    await flush(3);
    expect(mounted.container.textContent?.trim()).toBe("");
  });
});

/* --------------------------------------------------------------- the callback */

function fakeSession(): Session {
  return {
    access_token: "t",
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: "r",
    user: {
      id: "user-1",
      email: "user@example.com",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: new Date().toISOString(),
    },
  };
}

describe("the OpenRouter callback page", () => {
  it("18: creates one owned client and recovers from a missing session", async () => {
    const client = fakeClient(async () => ({ data: null, error: null }));
    const make = vi.spyOn(accountClient, "createAccountClient").mockReturnValue(client);
    const stop = vi.spyOn(accountClient, "stopAccountClient").mockResolvedValue();
    mounted = render(createElement(OpenRouterCallbackPage));
    await flush(9);
    expect(make).toHaveBeenCalledTimes(1);
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(mounted.container.textContent).toContain("Sign in to continue");
    expect(mounted.container.querySelector("a")?.getAttribute("href")).toBe("/app?configuration=1");
    mounted.unmount();
    mounted = null;
    expect(stop).toHaveBeenCalledWith(client);
  });

  it("scrubs the callback and consumes the verifier when the session is lost", async () => {
    storeOpenRouterVerifier("lost-session", "verifier-lost");
    window.history.replaceState(null, "", "/app/openrouter/callback?code=abc123&n=lost-session");
    const client = fakeClient(async () => ({ data: null, error: null }));
    mounted = render(createElement(OpenRouterCallbackPage, {
      client,
      session: null,
      search: "?code=abc123&n=lost-session",
    }));
    await flush(5);
    expect(window.location.search).toBe("");
    expect(takeOpenRouterVerifier("lost-session")).toBeNull();
  });

  it("18: recovers when session lookup rejects", async () => {
    const client = fakeClient(async () => ({ data: null, error: null }));
    vi.mocked(client.auth.getSession).mockRejectedValue(new Error("offline"));
    mounted = render(createElement(OpenRouterCallbackPage, { client }));
    await flush(4);
    expect(mounted.container.textContent).toContain("Sign in to continue");
  });
  it("exchanges the code, stores the key, and removes the verifier", async () => {
    storeOpenRouterVerifier("nonce-1", "verifier-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ key: "sk-or-v1-xyz" }), { status: 200 })),
    );
    let storedBody: unknown = null;
    const client = fakeClient(async (_fn, options) => {
      storedBody = (options as { body: unknown }).body;
      return { data: { id: "k1", provider: "openrouter", label: "OpenRouter", last_status: "needs_attention" }, error: null };
    });

    mounted = render(
      createElement(OpenRouterCallbackPage, {
        client,
        session: fakeSession(),
        search: "?code=abc123&n=nonce-1",
      }),
    );
    await flush(4);

    expect(storedBody).toEqual({
      action: "store",
      provider: "openrouter",
      label: "OpenRouter",
      key: "sk-or-v1-xyz",
    });
    expect(mounted.container.textContent).toContain("OpenRouter connected");
    expect(takeOpenRouterVerifier("nonce-1")).toBeNull();
  });

  it("shows the error card when the verifier is already gone", async () => {
    const client = fakeClient(async () => ({ data: { ok: true }, error: null }));
    mounted = render(
      createElement(OpenRouterCallbackPage, {
        client,
        session: fakeSession(),
        search: "?code=abc123&n=missing-nonce",
      }),
    );
    await flush(4);
    expect(mounted.container.textContent).toContain("OpenRouter could not connect");
  });

  it("shows the error card when the exchange itself fails", async () => {
    storeOpenRouterVerifier("nonce-2", "verifier-2");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 400 })));
    const client = fakeClient(async () => ({ data: { ok: true }, error: null }));
    mounted = render(
      createElement(OpenRouterCallbackPage, {
        client,
        session: fakeSession(),
        search: "?code=abc123&n=nonce-2",
      }),
    );
    await flush(4);
    expect(mounted.container.textContent).toContain("OpenRouter could not connect");
  });
});
