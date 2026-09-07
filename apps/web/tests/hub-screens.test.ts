import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BarsEmpty } from "@/app/app/connect";
import { Onboarding } from "@/app/app/onboarding";
import { SignInCard } from "@/components/sign-in-card";
import { CONNECT_COMMAND, type AccountProfile } from "@/lib/onboarding";
import { all, byText, flush, messages, render, type Mounted } from "./render";

/**
 * The catalog, standing where next-intl's provider would.
 *
 * The library's client entry imports the Next router, which does not exist in
 * a bare document, so the hook is served from the shipped English file
 * instead. It is deliberately stricter than the real one: a key that is not in
 * the catalog throws here rather than rendering its own path, so a screen that
 * forgets to add a message fails a test rather than showing one to a reader.
 */
/**
 * The locale aware link, standing in as a plain anchor.
 *
 * The sign in card points at the download page through the site's own link
 * component, which is built on next-intl's navigation helpers, which reach for
 * the Next router. None of that is what these tests are about, and an anchor
 * is what it renders in the end anyway.
 */
vi.mock("@/i18n/navigation", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
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
        node = node === null || typeof node !== "object" ? undefined : (node as Record<string, unknown>)[step];
      }
      if (typeof node !== "string") throw new Error(`missing message: ${path.join(".")}`);
      return node.replace(/\{(\w+)\}/gu, (whole, name: string) =>
        values?.[name] === undefined ? whole : String(values[name]),
      );
    },
  };
});

/**
 * The screens a new account meets, mounted for real.
 *
 * These are the four surfaces this wave added or changed, and what is asserted
 * about each is what a reader would check by looking: which ways in the card
 * offers, whether the switch starts on, that the flow runs its three screens
 * and that both of its exits leave, and that the empty state is one sentence
 * and one command rather than a screen full of instructions.
 *
 * Every sentence is compared against the English catalog rather than against a
 * copy of it written here, so a wording change moves the test with the product
 * and a missing key fails loudly instead of rendering a key path.
 */

const hub = messages.hub;
const signIn = messages.signIn;

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function press(node: Element | null): void {
  expect(node).not.toBeNull();
  mounted?.run(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** An auth client that answers nothing. No test here starts a sign in. */
function silentClient(): SupabaseClient {
  return {
    auth: {
      signInWithOAuth: vi.fn(async () => ({ data: { url: null }, error: null })),
      signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    },
  } as unknown as SupabaseClient;
}

const PROFILE: AccountProfile = {
  id: "user-1",
  email: "person@example.com",
  user_metadata: { full_name: "Ada Lovelace" },
  app_metadata: { provider: "github" },
};

describe("the sign in card", () => {
  it("offers three providers, GitHub first, each with its own mark", () => {
    mounted = render(
      createElement(SignInCard, {
        client: silentClient(),
        keepSignedIn: true,
        onKeepSignedInChange: async () => true,
      }),
    );

    const labels = all(mounted.container, "button")
      .map((node) => node.textContent?.trim() ?? "")
      .filter((text) => text.startsWith("Continue with"));
    expect(labels).toEqual([signIn.github, signIn.google, signIn.microsoft]);

    /* Each provider button leads with artwork rather than with a letter. */
    for (const text of labels) {
      const button = byText(mounted.container, "button", text);
      expect(button?.querySelector("svg, img")).not.toBeNull();
    }
  });

  it("starts with the session switch on and reports every move of it", async () => {
    const changes: boolean[] = [];
    mounted = render(
      createElement(SignInCard, {
        client: silentClient(),
        keepSignedIn: true,
        onKeepSignedInChange: async (next: boolean) => {
          changes.push(next);
          return true;
        },
      }),
    );

    const toggle = mounted.container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(toggle?.textContent).toContain(signIn.keepSignedIn);

    press(toggle);
    await flush();
    expect(changes).toEqual([false]);
  });

  it("draws the switch off when the host says it is off", () => {
    mounted = render(
      createElement(SignInCard, {
        client: silentClient(),
        keepSignedIn: false,
        onKeepSignedInChange: async () => true,
      }),
    );
    expect(
      mounted.container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("locks the switch once a sign in is in flight", () => {
    const client = {
      auth: {
        /* A provider sign in that never comes back, which is what a redirect
           looks like from here: the page is leaving and never answers. */
        signInWithOAuth: () => new Promise(() => undefined),
        signInWithOtp: async () => ({ data: {}, error: null }),
      },
    } as unknown as SupabaseClient;

    mounted = render(
      createElement(SignInCard, {
        client,
        keepSignedIn: true,
        onKeepSignedInChange: async () => true,
      }),
    );

    const toggle = mounted.container.querySelector('[role="switch"]');
    expect((toggle as HTMLButtonElement).disabled).toBe(false);

    press(byText(mounted.container, "button", signIn.github));
    /* The verifier is being written into whichever store the client was built
       around. Moving that store now would strand it. */
    expect((mounted.container.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says so when the browser refuses to move the session", async () => {
    mounted = render(
      createElement(SignInCard, {
        client: silentClient(),
        keepSignedIn: true,
        onKeepSignedInChange: async () => false,
      }),
    );

    press(mounted.container.querySelector('[role="switch"]'));
    await flush();

    expect(mounted.container.textContent).toContain(signIn.keepSignedInFailed);
    /* The switch stayed where it was, because the session did. */
    expect(
      mounted.container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("the first visit", () => {
  function mountFlow(overrides: { onSaveName?: (name: string) => void; onFinish?: () => void }) {
    return render(
      createElement(Onboarding, {
        profile: PROFILE,
        bars: createElement("p", { "data-testid": "bars" }, "bars go here"),
        onSaveName: overrides.onSaveName ?? (() => undefined),
        onFinish: overrides.onFinish ?? (() => undefined),
      }),
    );
  }

  it("opens on the account, prefilled from the provider, with the address locked", () => {
    mounted = mountFlow({});

    expect(mounted.container.querySelector("h2")?.textContent).toBe(hub.onboarding.profile.title);

    const [name, email] = all<HTMLInputElement>(mounted.container, "input");
    expect(name?.value).toBe("Ada Lovelace");
    expect(name?.readOnly).toBe(false);
    expect(email?.value).toBe("person@example.com");
    expect(email?.readOnly).toBe(true);
    expect(mounted.container.textContent).toContain("From your GitHub account");
  });

  it("marks the first of three steps, and only the first", () => {
    mounted = mountFlow({});
    const rail = all(mounted.container, ".ol-onboarding-rail > span");
    expect(rail).toHaveLength(3);
    expect(rail.map((node) => node.getAttribute("data-state"))).toEqual(["here", null, null]);
    expect(mounted.container.textContent).toContain("Step 1 of 3");
  });

  it("leaves for the bars when somebody says Later", () => {
    const finish = vi.fn();
    mounted = mountFlow({ onFinish: finish });
    press(byText(mounted.container, "button", hub.onboarding.profile.later));
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("saves the name on the way to the connect screen", () => {
    const saved: string[] = [];
    mounted = mountFlow({ onSaveName: (name) => saved.push(name) });

    const name = mounted.container.querySelector("input");
    mounted.run(() => {
      if (name !== null) {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set?.call(name, "  Grace Hopper  ");
        name.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    press(byText(mounted.container, "button", hub.onboarding.profile.continue));
    expect(saved).toEqual(["Grace Hopper"]);
  });

  it("shows every provider on the connect screen with the one command that connects them", () => {
    mounted = mountFlow({});
    press(byText(mounted.container, "button", hub.onboarding.profile.continue));

    expect(mounted.container.querySelector("h2")?.textContent).toBe(hub.connect.title);
    expect(mounted.container.querySelector(".ol-command code")?.textContent).toBe(CONNECT_COMMAND);

    const rows = all(mounted.container, ".ol-connect-row");
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      /* One mark, one name, one line, and the line says where a connection is
         actually made. Nothing on this screen claims the browser can do it.
         The terminal sentence is personalised with the tool's own name, so a
         row's line is checked against its own name filled into the template
         rather than the raw template string. */
      expect(row.querySelector(".ol-provider-mark")).not.toBeNull();
      const toolName = row.querySelector(".ol-connect-name strong")?.textContent ?? "";
      const line = row.querySelector(".ol-connect-name span")?.textContent ?? "";
      const expectedTerminal = hub.connect.terminal.replace("{tool}", toolName);
      expect([expectedTerminal, hub.connect.key]).toContain(line);
    }
    /* Seven different tools each say their own name: no two subscription rows
       repeat the exact same sentence. */
    const terminalLines = rows
      .map((row) => row.querySelector(".ol-connect-name span")?.textContent ?? "")
      .filter((line) => line !== hub.connect.key);
    expect(new Set(terminalLines).size).toBe(terminalLines.length);

    const rail = all(mounted.container, ".ol-onboarding-rail > span");
    expect(rail.map((node) => node.getAttribute("data-state"))).toEqual(["done", "here", null]);
  });

  it("moves focus to the new screen rather than leaving it on a removed button", () => {
    mounted = mountFlow({});
    press(byText(mounted.container, "button", hub.onboarding.profile.continue));

    const head = mounted.container.querySelector("h2");
    expect(head?.textContent).toBe(hub.connect.title);
    expect(document.activeElement).toBe(head);
  });

  it("lets somebody skip the connect screen out of the flow entirely", () => {
    const finish = vi.fn();
    mounted = mountFlow({ onFinish: finish });
    press(byText(mounted.container, "button", hub.onboarding.profile.continue));
    press(byText(mounted.container, "button", hub.onboarding.connect.skip));
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("ends on the hub's own bars, and finishes from there", () => {
    const finish = vi.fn();
    mounted = mountFlow({ onFinish: finish });
    press(byText(mounted.container, "button", hub.onboarding.profile.continue));
    press(byText(mounted.container, "button", hub.onboarding.connect.continue));

    expect(mounted.container.querySelector("h2")?.textContent).toBe(hub.onboarding.bars.title);
    /* The last screen shows the real thing the hub draws, not a picture of it. */
    expect(mounted.container.querySelector('[data-testid="bars"]')?.textContent).toBe(
      "bars go here",
    );
    const rail = all(mounted.container, ".ol-onboarding-rail > span");
    expect(rail.map((node) => node.getAttribute("data-state"))).toEqual(["done", "done", "here"]);

    press(byText(mounted.container, "button", hub.onboarding.bars.done));
    expect(finish).toHaveBeenCalledTimes(1);
  });
});

describe("the empty bars view", () => {
  it("is one sentence, one command and nothing else", () => {
    mounted = render(createElement(BarsEmpty));

    const paragraphs = all(mounted.container, "p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.textContent).toBe(hub.empty.line);

    expect(mounted.container.querySelector(".ol-command code")?.textContent).toBe(CONNECT_COMMAND);
    /* The copy control is the only thing here that can be pressed. */
    const buttons = all(mounted.container, "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent?.trim()).toBe(hub.command.copy);
  });

  it("says what happened when the clipboard refuses, and keeps the text", async () => {
    const clipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });

    mounted = render(createElement(BarsEmpty));
    press(byText(mounted.container, "button", hub.command.copy));
    await flush();

    expect(mounted.container.textContent).toContain(hub.command.failed);
    /* Nothing ever claimed a copy, and the command is still on screen to take. */
    expect(byText(mounted.container, "button", hub.command.copied)).toBeNull();
    expect(mounted.container.querySelector(".ol-command code")?.textContent).toBe(CONNECT_COMMAND);

    if (clipboard === undefined) {
      Reflect.deleteProperty(window.navigator, "clipboard");
    } else {
      Object.defineProperty(window.navigator, "clipboard", clipboard);
    }
  });

  it("carries the signature moment, and it says nothing to a screen reader", () => {
    mounted = render(createElement(BarsEmpty));
    const horizon = mounted.container.querySelector(".ol-horizon");
    expect(horizon?.getAttribute("aria-hidden")).toBe("true");
    /* Five bars, one per band, and not a number among them. */
    const bars = all(mounted.container, ".ol-horizon-bar");
    expect(bars.map((node) => node.getAttribute("data-band"))).toEqual([
      "green",
      "yellow",
      "orange",
      "red",
      "stale",
    ]);
    expect(horizon?.textContent).toBe("");
  });
});
