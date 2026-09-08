import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliPageView as CliPage } from "@/app/app/cli/cli-page-view";
import { Dashboard } from "@/app/app/dashboard";
import { ONBOARDED_METADATA_KEY, onboardedStorageKey } from "@/lib/onboarding";
import { INTENT_TTL_MS, pendingIntent, rememberIntent } from "@/lib/pending-intent";
import { authRedirectUrl } from "@/lib/pro";
import {
  cleanCliCode,
  validateCliCode,
} from "@/lib/cli-login";
import { all, byText, flush, messages, render, type Mounted } from "./render";

vi.mock("@/i18n/navigation", async () => {
  const { createElement: element } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      element("a", { href, ...rest }, children as never),
    redirect: () => undefined,
    usePathname: () => "/app",
    useRouter: () => ({ push: () => undefined, replace: () => undefined }),
    getPathname: ({ href }: { href: string }) => href,
  };
});

vi.mock("next-intl", async () => {
  const catalog = (await import("../messages/en.json")).default as Record<string, unknown>;
  return {
    useLocale: () => "en",
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

vi.mock("@/app/app/notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("@/app/app/install", () => ({ InstallControl: () => null }));
vi.mock("@/lib/synced-usage", () => ({
  readSyncedApiSpend: async () => ({ ok: true, sources: [] }),
  readSyncedUsage: async () => ({ ok: false, reason: "signed_out" }),
}));

let currentSession: Session | null = null;
const currentInvoke: (name: string, options: unknown) => Promise<unknown> = async () => ({
  data: { ok: true },
  error: null,
});

vi.mock("@/lib/account-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-client")>();
  return {
    ...actual,
    createAccountClient: () => ({
      auth: {
        getSession: vi.fn(async () => ({ data: { session: currentSession }, error: null })),
        onAuthStateChange: vi.fn(() => ({
          data: { subscription: { unsubscribe: vi.fn() } },
        })),
        stopAutoRefresh: vi.fn(async () => {}),
        startAutoRefresh: vi.fn(async () => {}),
        signOut: vi.fn(async () => {}),
        updateUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      },
      functions: {
        invoke: vi.fn((name, options) => currentInvoke(name, options)),
      },
    }),
  };
});

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  window.history.replaceState(null, "", "/app/cli");
  currentSession = null;
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function fakeSession(extraUserMetadata: Record<string, unknown> = {}): Session {
  return {
    access_token: "test-access-token",
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: "test-refresh-token",
    user: {
      id: "user-1",
      email: "user@example.com",
      app_metadata: {},
      user_metadata: { ...extraUserMetadata },
      aud: "authenticated",
      created_at: new Date().toISOString(),
    },
  };
}

describe("06: pending authentication intent", () => {
  it("bounds the authentication return URL when browser storage is refused", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("refused"); });
    window.history.replaceState(null, "", "/app/cli?code=abcd2345&returnTo=https://untrusted.test#fragment");
    mounted = render(createElement(CliPage));
    await flush(4);
    expect(new URL(authRedirectUrl()).search).toBe("?code=ABCD2345");
    expect(new URL(authRedirectUrl()).hash).toBe("");
    window.history.replaceState(null, "", "/app?trial=1&returnTo=https://untrusted.test");
    expect(new URL(authRedirectUrl()).search).toBe("?trial=1");
    window.history.replaceState(null, "", "/app/cli?code=invalid");
    expect(new URL(authRedirectUrl()).search).toBe("");
  });
  it("prefills the CLI code after a signed out page is destroyed and authentication returns", async () => {
    window.history.replaceState(null, "", "/app/cli?code=ABCD2345");
    mounted = render(createElement(CliPage));
    await flush(4);
    expect(window.location.search).toBe("");
    expect(pendingIntent()).toEqual({ kind: "cli", code: "ABCD2345" });
    mounted.unmount();
    window.sessionStorage.clear(); // A magic link may return in a new tab.
    currentSession = fakeSession();
    mounted = render(createElement(CliPage));
    await flush(4);
    expect(mounted.container.querySelector<HTMLInputElement>("input:not([type=checkbox])")?.value).toBe("ABCD2345");
    expect(pendingIntent()).toBeNull();
  });

  it("restores the trial after authentication and consumes it", async () => {
    window.history.replaceState(null, "", "/app?trial=1");
    mounted = render(createElement(Dashboard, { lockup: null }));
    await flush(4);
    expect(pendingIntent()).toEqual({ kind: "trial" });
    mounted.unmount();
    currentSession = fakeSession({ [ONBOARDED_METADATA_KEY]: true });
    mounted = render(createElement(Dashboard, { lockup: null }));
    await flush(6);
    expect(mounted.container.textContent).toContain(messages.hub.trial.alerts.title);
    expect(pendingIntent()).toBeNull();
  });

  it("expires abandoned intent after ten minutes", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    rememberIntent({ kind: "cli", code: "ABCD2345" });
    vi.mocked(Date.now).mockReturnValue(now + INTENT_TTL_MS);
    expect(pendingIntent()).toBeNull();
  });
});

function fakeClient(invokeHandler: (name: string, options: unknown) => Promise<unknown>): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: currentSession }, error: null })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      stopAutoRefresh: vi.fn(async () => {}),
      startAutoRefresh: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
      updateUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    },
    functions: {
      invoke: vi.fn(invokeHandler),
    },
  } as unknown as SupabaseClient;
}

function press(node: Element | null): void {
  expect(node).not.toBeNull();
  mounted?.run(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(input: HTMLInputElement | null, value: string): void {
  expect(input).not.toBeNull();
  mounted?.run(() => {
    if (input !== null) {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

const hub = messages.hub;

describe("pure cli code helpers", () => {
  it("cleans codes by uppercasing and stripping whitespace and hyphens", () => {
    expect(cleanCliCode("  2345-6789  ")).toBe("23456789");
    expect(cleanCliCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(cleanCliCode("ab cd ef gh")).toBe("ABCDEFGH");
  });

  it("validates alphabet and length", () => {
    expect(validateCliCode("23456789")).toEqual({
      valid: true,
      hasInvalidChars: false,
      isRightLength: true,
    });
    // 0 and 1 are not in the Base32 alphabet
    expect(validateCliCode("01234567")).toEqual({
      valid: false,
      hasInvalidChars: true,
      isRightLength: true,
    });
    // Less than 8 characters
    expect(validateCliCode("23456")).toEqual({
      valid: false,
      hasInvalidChars: false,
      isRightLength: false,
    });
  });
});

describe("/app/cli approve page", () => {
  it("prefills code from the query string and strips spaces and hyphens", async () => {
    window.history.replaceState(null, "", "/app/cli?code=abcd-2345");
    currentSession = fakeSession();
    const client = fakeClient(async () => ({ data: { ok: true }, error: null }));
    mounted = render(createElement(CliPage, { client, session: currentSession }));
    await flush();

    const input = mounted.container.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("ABCD2345");

    const approveButton = byText(mounted.container, "button", hub.cliPage.approve) as HTMLButtonElement;
    expect(approveButton.disabled).toBe(false);
  });

  it("performs live alphabet and length validation as the user types", async () => {
    currentSession = fakeSession();
    const client = fakeClient(async () => ({ data: { ok: true }, error: null }));
    mounted = render(createElement(CliPage, { client, session: currentSession }));
    await flush();

    const input = mounted.container.querySelector("input") as HTMLInputElement;
    const approveButton = byText(mounted.container, "button", hub.cliPage.approve) as HTMLButtonElement;
    const denyButton = byText(mounted.container, "button", hub.cliPage.deny) as HTMLButtonElement;

    // Initially empty: buttons disabled, no validation error
    expect(input.value).toBe("");
    expect(approveButton.disabled).toBe(true);
    expect(denyButton.disabled).toBe(true);
    expect(mounted.container.textContent).not.toContain(hub.cliPage.validationInvalidChars);

    // Enter partial valid code: shows length hint, buttons disabled
    typeInto(input, "2345");
    await flush();
    expect(input.value).toBe("2345");
    expect(mounted.container.textContent).toContain(hub.cliPage.validationLength);
    expect(approveButton.disabled).toBe(true);
    expect(denyButton.disabled).toBe(true);

    // Enter invalid characters (0 and 1 are not in Base32 alphabet)
    typeInto(input, "234501");
    await flush();
    expect(mounted.container.textContent).toContain(hub.cliPage.validationInvalidChars);
    expect(approveButton.disabled).toBe(true);

    // Strips spaces and hyphens live and converts to uppercase
    typeInto(input, "abcd-2345");
    await flush();
    expect(input.value).toBe("ABCD2345");
    expect(mounted.container.textContent).not.toContain(hub.cliPage.validationInvalidChars);
    expect(mounted.container.textContent).not.toContain(hub.cliPage.validationLength);
    expect(approveButton.disabled).toBe(false);
    expect(denyButton.disabled).toBe(false);
  });

  it("approves terminal sign in successfully and shows success state", async () => {
    let calledOptions: unknown = null;
    currentSession = fakeSession();
    const client = fakeClient(async (_fn, options) => {
      calledOptions = options;
      return { data: { ok: true, device_label: "MacBook Pro" }, error: null };
    });

    mounted = render(
      createElement(CliPage, {
        client,
        session: currentSession,
        initialCode: "23456789",
      }),
    );
    await flush();

    press(byText(mounted.container, "button", hub.cliPage.approve));
    await flush();

    expect(calledOptions).toMatchObject({
      body: { action: "approve", user_code: "23456789" },
    });

    expect(mounted.container.textContent).toContain(hub.cliPage.successTitle);
    expect(mounted.container.textContent).toContain(hub.cliPage.successBody);
    expect(mounted.container.textContent).toContain("MacBook Pro");
  });

  it("denies terminal sign in and shows denied state", async () => {
    let calledOptions: unknown = null;
    currentSession = fakeSession();
    const client = fakeClient(async (_fn, options) => {
      calledOptions = options;
      return { data: { ok: true }, error: null };
    });

    mounted = render(
      createElement(CliPage, {
        client,
        session: currentSession,
        initialCode: "23456789",
      }),
    );
    await flush();

    press(byText(mounted.container, "button", hub.cliPage.deny));
    await flush();

    expect(calledOptions).toMatchObject({
      body: { action: "deny", user_code: "23456789" },
    });

    expect(mounted.container.textContent).toContain(hub.cliPage.deniedTitle);
    expect(mounted.container.textContent).toContain(hub.cliPage.deniedBody);
  });

  it("shows unknown_code error in one sentence", async () => {
    currentSession = fakeSession();
    const client = fakeClient(async () => ({
      data: { error: "unknown_code" },
      error: null,
    }));

    mounted = render(
      createElement(CliPage, {
        client,
        session: currentSession,
        initialCode: "23456789",
      }),
    );
    await flush();

    press(byText(mounted.container, "button", hub.cliPage.approve));
    await flush();

    expect(mounted.container.textContent).toContain(hub.cliPage.errorUnknownCode);
  });

  it("shows expired error in one sentence", async () => {
    currentSession = fakeSession();
    const client = fakeClient(async () => ({
      data: { error: "expired" },
      error: null,
    }));

    mounted = render(
      createElement(CliPage, {
        client,
        session: currentSession,
        initialCode: "23456789",
      }),
    );
    await flush();

    press(byText(mounted.container, "button", hub.cliPage.approve));
    await flush();

    expect(mounted.container.textContent).toContain(hub.cliPage.errorExpired);
  });

  it("shows already_used error in one sentence", async () => {
    currentSession = fakeSession();
    const client = fakeClient(async () => ({
      data: { error: "already_used" },
      error: null,
    }));

    mounted = render(
      createElement(CliPage, {
        client,
        session: currentSession,
        initialCode: "23456789",
      }),
    );
    await flush();

    press(byText(mounted.container, "button", hub.cliPage.approve));
    await flush();

    expect(mounted.container.textContent).toContain(hub.cliPage.errorAlreadyUsed);
  });

  it("shows device_cap error in one sentence", async () => {
    currentSession = fakeSession();
    const client = fakeClient(async () => ({
      data: { error: "device_cap" },
      error: null,
    }));

    mounted = render(
      createElement(CliPage, {
        client,
        session: currentSession,
        initialCode: "23456789",
      }),
    );
    await flush();

    press(byText(mounted.container, "button", hub.cliPage.approve));
    await flush();

    expect(mounted.container.textContent).toContain(hub.cliPage.errorDeviceCap);
  });

  it("shows the generic sentence when the service does not answer at all", async () => {
    currentSession = fakeSession();
    const client = fakeClient(async () => {
      throw new Error("network down");
    });

    mounted = render(
      createElement(CliPage, {
        client,
        session: currentSession,
        initialCode: "23456789",
      }),
    );
    await flush();

    press(byText(mounted.container, "button", hub.cliPage.approve));
    await flush();

    expect(mounted.container.textContent).toContain(hub.cliPage.errorGeneric);
  });

  it("reuses the sign in card when signed out", async () => {
    currentSession = null;
    const client = fakeClient(async () => ({ data: null, error: null }));
    mounted = render(createElement(CliPage, { client, session: null }));
    await flush();

    expect(mounted.container.textContent).toContain("Sign in to OpenLimiter");
    expect(mounted.container.querySelector("input")).toBeNull();
    expect(byText(mounted.container, "button", hub.cliPage.approve)).toBeNull();
  });
});

describe("Hub Configuration", () => {
  it("gains a row Sign in a terminal linking to /app/cli", async () => {
    // Account marked as onboarded so Dashboard goes to bars and offers configuration
    currentSession = fakeSession({ [ONBOARDED_METADATA_KEY]: true });
    window.localStorage.setItem(onboardedStorageKey("user-1"), "true");

    mounted = render(createElement(Dashboard, { lockup: null }));
    await flush(3);

    // Open configuration via the gear icon
    const gear = all(mounted.container, "button").find(
      (node) => node.getAttribute("aria-label") === hub.configuration,
    );
    press(gear ?? null);
    await flush();

    // Check that the terminal row is rendered and links to /app/cli
    expect(mounted.container.textContent).toContain(hub.cli.signInTerminal);
    const cliLink = mounted.container.querySelector('a[href="/app/cli"]');
    expect(cliLink).not.toBeNull();
    expect(cliLink?.textContent).toContain(hub.cli.signInTerminal);
  });
});
