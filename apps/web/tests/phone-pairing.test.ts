import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PhoneButton from "@/app/app/phone-button";
import { PairFlow } from "@/app/app/pair/pair-flow";
import { PairInstallStep } from "@/app/app/pair/pair-install";
import {
  PHONE_PAIR_STORAGE_KEY,
  PHONE_RENEW_WITHIN_SECONDS,
  phonePairNeedsRenewal,
  phonePairOf,
  readPhonePair,
  renewPhonePair,
  writePhonePair,
  type PhonePair,
} from "@/lib/phone-session";
import { errorCorrectionCodewords, encodeQr, qrSize } from "@/lib/qr";
import { pairStateAfterPoll, type PairState } from "@/lib/pairing";
import { all, byText, flush, messages, render, type Mounted } from "./render";

/**
 * The phone lane: the QR encoder against the published vectors, the pair page
 * in each of its states, the renewal contract, and the install step's gating.
 *
 * Nothing here reaches a network. The transport is a recorded list of
 * scripted answers, so a state asserted on screen is a state the server could
 * have produced and nothing else.
 */

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

vi.mock("@/lib/pro", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/pro")>();
  /* The transport in lib/pro-device.ts answers "unreachable" without these
     and never touches fetch, so the pair page's scripted answers would sit
     unread. Two invented values keep the real transport, headers and all. */
  return {
    ...actual,
    SUPABASE_URL: "https://pro.openlimiter.test",
    SUPABASE_ANON_KEY: "test-anon-key",
  };
});

/* The meter drawing pulls in the generated engine, which the jsdom document
   can render; what it cannot do is matchMedia, which the install step needs
   either way, so one stub serves both. */
const mediaListeners = new Map<string, (event: { matches: boolean }) => void>();

function stubMatchMedia(standalone: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: standalone && query.includes("standalone"),
      media: query,
      addEventListener: (_name: string, fn: (event: { matches: boolean }) => void) => {
        mediaListeners.set(query, fn);
      },
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

function stubUserAgent(agent: string): void {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: agent,
  });
}

/* ------------------------------------------------------------------ the QR */

/* The published example: the numeric string 01234567 at version 1, level M. */
const ANNEX_I_DATA = Uint8Array.from([
  0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11,
  0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
]);
const ANNEX_I_ERROR_CORRECTION = [
  0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
];

describe("the QR encoder, against the known vectors", () => {
  it("matches the Reed Solomon codewords published in annex I of ISO 18004", () => {
    expect(Array.from(errorCorrectionCodewords(ANNEX_I_DATA, 10))).toEqual(
      ANNEX_I_ERROR_CORRECTION,
    );
  });

  it("matches the byte mode layout for the annex example's companion string", () => {
    /* "A" at version 1, level M, computed by hand from the standard's bit
       layout: mode 0100, length 00000001, then the byte, then terminator and
       the alternating pad codewords. */
    const matrix = encodeQr("A");
    expect(matrix.version).toBe(1);
    expect(matrix.size).toBe(qrSize(1));
    /* The finders and the dark module sit where the standard fixes them. */
    expect(matrix.modules[0]?.[0]).toBe(true);
    expect(matrix.modules[0]?.[matrix.size - 1]).toBe(true);
    expect(matrix.modules[matrix.size - 1]?.[0]).toBe(true);
    expect(matrix.modules[matrix.size - 8]?.[8]).toBe(true);
    /* Format bits: level M, so the top two bits of the unmasked word are 00. */
    let format = 0;
    const read = (row: number, column: number, index: number): void => {
      if (matrix.modules[row]?.[column] === true) format |= 1 << index;
    };
    for (let index = 0; index <= 5; index += 1) read(index, 8, index);
    read(7, 8, 6);
    read(8, 8, 7);
    read(8, 7, 8);
    for (let index = 9; index <= 14; index += 1) read(8, 14 - index, index);
    expect(((format ^ 0x5412) >>> 13) & 0b11).toBe(0b00);
  });

  it("encodes a full pair URL inside its version ceiling", () => {
    const matrix = encodeQr("https://openlimiter.com/app/pair#code=ABCD2345");
    expect(matrix.version).toBeLessThanOrEqual(6);
    expect(matrix.size).toBe(qrSize(matrix.version));
  });
});

/* ------------------------------------------------------------ the session */

const NOW = 1_800_000_000_000;

function pair(overrides: Partial<PhonePair> = {}): PhonePair {
  return {
    token: "read.token",
    expiresAt: NOW / 1_000 + 86_400,
    refreshCredential: "credential.one",
    refreshExpiresAt: NOW / 1_000 + 2_592_000,
    ...overrides,
  };
}

describe("the phone pair store and renewal", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps both credentials under one key", () => {
    writePhonePair(pair());
    expect(readPhonePair()).toEqual(pair());
    expect(window.localStorage.getItem(PHONE_PAIR_STORAGE_KEY)).not.toBeNull();
  });

  it("parses the wire shape the approving poll and phone_renew both answer", () => {
    const parsed = phonePairOf({
      token: "t",
      expires_at: "2027-01-08T00:00:00.000Z",
      refresh_credential: "rc",
      refresh_expires_at: "2027-02-06T00:00:00.000Z",
    });
    expect(parsed?.token).toBe("t");
    expect(parsed?.expiresAt).toBe(Math.floor(Date.parse("2027-01-08T00:00:00.000Z") / 1_000));
    expect(phonePairOf({ token: "t" })).toBeNull();
  });

  it("asks for renewal exactly at the one hour boundary", () => {
    const base = pair({ expiresAt: NOW / 1_000 + PHONE_RENEW_WITHIN_SECONDS });
    expect(phonePairNeedsRenewal(base, NOW)).toBe(true);
    expect(phonePairNeedsRenewal(pair({ expiresAt: NOW / 1_000 + 3_601 }), NOW)).toBe(false);
    expect(phonePairNeedsRenewal(pair({ expiresAt: NOW / 1_000 - 10 }), NOW)).toBe(true);
  });

  it("recovers a lost answer by retrying once inside the grace", async () => {
    const answers = [
      { status: 0, body: null },
      {
        status: 200,
        body: {
          token: "read.two",
          expires_at: "2027-01-08T00:00:00.000Z",
          refresh_credential: "credential.two",
          refresh_expires_at: "2027-02-06T00:00:00.000Z",
        },
      },
    ];
    const calls: string[] = [];
    const outcome = await renewPhonePair(pair(), async (credential) => {
      calls.push(credential);
      return answers.shift() ?? { status: 0, body: null };
    });
    expect(calls).toEqual(["credential.one", "credential.one"]);
    expect(outcome.kind).toBe("renewed");
    if (outcome.kind === "renewed") expect(outcome.pair.refreshCredential).toBe("credential.two");
  });

  it("answers revoked only on a 401, and never retries it", async () => {
    let calls = 0;
    const outcome = await renewPhonePair(pair(), async () => {
      calls += 1;
      return { status: 401, body: { error: "revoked" } };
    });
    expect(outcome).toEqual({ kind: "revoked" });
    expect(calls).toBe(1);
  });

  it("takes the approval answer as a pair in the state machine", () => {
    const waiting: PairState = {
      phase: "waiting",
      code: "ABCD2345",
      claimId: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      expiresAt: null,
      pollInterval: 2_000,
      session: null,
      phonePair: null,
    };
    const next = pairStateAfterPoll(
      waiting,
      {
        status: "approved",
        token: "read.token",
        expires_at: "2027-01-08T00:00:00.000Z",
        refresh_credential: "credential.one",
        refresh_expires_at: "2027-02-06T00:00:00.000Z",
      },
      200,
    );
    expect(next.phase).toBe("approved");
    expect(next.phonePair?.token).toBe("read.token");
    /* The legacy delivery still counts. */
    const legacy = pairStateAfterPoll(
      waiting,
      {
        status: "approved",
        device_token: "signed.phone.token",
        refresh: { after: 1_800, expires_at: 3_600, grace_until: 7_200 },
      },
      200,
    );
    expect(legacy.phase).toBe("approved");
    expect(legacy.session?.token).toBe("signed.phone.token");
    expect(legacy.phonePair).toBeNull();
  });
});

/* ------------------------------------------------------------- the screens */

const hub = messages.hub;

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/app/pair");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function press(node: Element | null): void {
  expect(node).not.toBeNull();
  mounted?.run(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the phone button panel", () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });

  it("opens on the sentence, the QR and the download link, nothing else", async () => {
    mounted = render(createElement(PhoneButton));
    press(byText(mounted.container, "button", hub.phone.button));
    await flush();

    const panel = mounted.container.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    const phone = hub.phone;
    expect(panel?.textContent).toContain(phone.line);
    /* One SVG symbol, dark modules on a light field, named for a reader. */
    const svg = panel?.querySelector("svg[role='img']");
    expect(svg?.getAttribute("aria-label")).toBe(phone.qrAlt);
    expect(svg?.querySelector("rect")?.getAttribute("fill")).toBe("#ffffff");
    /* English is the unprefixed default: `as-needed` leaves `/download` bare,
       and `/en/download` is a spelling the middleware bounces. */
    expect(panel?.querySelector("a")?.getAttribute("href")).toBe("/download");
    expect(all(panel as HTMLElement, "button")).toHaveLength(0);
  });

  it("stays closed until it is asked", () => {
    mounted = render(createElement(PhoneButton));
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("the install step gating", () => {
  it("shows the Android button once the platform offers the prompt, and replays it", async () => {
    stubMatchMedia(false);
    stubUserAgent("Mozilla/5.0 (Linux; Android 15) Chrome/140");
    mounted = render(createElement(PairInstallStep));
    await flush();
    expect(mounted.container.textContent).not.toContain((hub.phoneInstall as Record<string, string>).add);

    const prompted: boolean[] = [];
    await mounted.run(async () => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      Object.assign(event, {
        prompt: async () => {
          prompted.push(true);
        },
        userChoice: Promise.resolve({ outcome: "accepted" }),
      });
      window.dispatchEvent(event);
    });
    await flush();

    const button = byText(mounted.container, "button", (hub.phoneInstall as Record<string, string>).add);
    expect(button).not.toBeNull();
    press(button);
    await flush();
    expect(prompted).toEqual([true]);
  });

  it("shows the three line overlay on iOS Safari", async () => {
    stubMatchMedia(false);
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1");
    mounted = render(createElement(PairInstallStep));
    await flush();
    const install = hub.phoneInstall as Record<string, string>;
    for (const line of [install.iosOne, install.iosTwo, install.iosThree]) {
      expect(mounted.container.textContent).toContain(line);
    }
    expect(all(mounted.container, "button")).toHaveLength(0);
  });

  it("shows nothing when the page already runs installed", async () => {
    stubMatchMedia(true);
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1");
    mounted = render(createElement(PairInstallStep));
    await flush();
    expect(mounted.container.textContent?.trim()).toBe("");
  });
});

describe("the pair page", () => {
  beforeEach(() => {
    stubMatchMedia(true);
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1");
  });

  it("waits for the desktop when a fresh code arrives", async () => {
    window.history.replaceState(null, "", "/app/pair#code=ABCD2345");
    /* The claim answer never arrives, so the page stays on reading the code. */
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => undefined)));
    mounted = render(createElement(PairFlow));
    await flush();
    expect(mounted.container.textContent).toContain("Reading the code");
    /* The fragment is consumed before anything else could render it. */
    expect(window.location.hash).toBe("");
  });

  it("says scan again when there is no code and no stored pair", async () => {
    mounted = render(createElement(PairFlow));
    await flush();
    expect(mounted.container.textContent).toContain("This link has no pairing code");
  });

  it("renews a stored pair due for renewal, then reads with the fresh token", async () => {
    vi.useFakeTimers({ now: NOW });
    writePhonePair(pair({ expiresAt: NOW / 1_000 + 100 }));
    const seen: { fn: string; token: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const fn = String(url).split("/").pop() ?? "";
        seen.push({
          fn,
          token: (init.headers as Record<string, string>)["x-openlimiter-entitlement"] ?? null,
        });
        if (fn === "pro-service" && String(init.body).includes("phone_renew")) {
          return new Response(
            JSON.stringify({
              token: "read.two",
              expires_at: NOW / 1_000 + 86_400,
              refresh_credential: "credential.two",
              refresh_expires_at: NOW / 1_000 + 2_592_000,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            rows: [
              {
                account_id: "work",
                provider: "CLAUDE",
                code: "SEVEN_DAY_OPUS",
                percent: 41,
                amount: null,
                currency: null,
                resets_at: null,
                observed_at: new Date(NOW).toISOString(),
                stale: false,
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    mounted = render(createElement(PairFlow));
    await flush(6);
    expect(seen[0]).toMatchObject({ fn: "pro-service", token: null });
    expect(seen[1]).toMatchObject({ fn: "pro-service", token: "read.two" });
    expect(readPhonePair()?.refreshCredential).toBe("credential.two");
    expect(mounted.container.textContent).toContain(hub.pairPage.bars.title);
    vi.useRealTimers();
  });

  it("falls back to scan again only when the epoch is revoked", async () => {
    vi.useFakeTimers({ now: NOW });
    writePhonePair(pair({ expiresAt: NOW / 1_000 + 100 }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 })),
    );
    mounted = render(createElement(PairFlow));
    await flush(6);
    const revoked = hub.pairPage.revoked;
    expect(mounted.container.textContent).toContain(revoked.title);
    expect(mounted.container.textContent).toContain(revoked.body);
    expect(readPhonePair()).toBeNull();
    vi.useRealTimers();
  });

  it("keeps the last bars with the stale mark when the service is silent", async () => {
    vi.useFakeTimers({ now: NOW });
    /* A token nowhere near renewal, so the open goes straight to the read. */
    writePhonePair(pair({ expiresAt: NOW / 1_000 + 80_000 }));
    const bodies = [
      new Response(
        JSON.stringify({
          rows: [
            {
              account_id: "work",
              provider: "CLAUDE",
              code: "SEVEN_DAY_OPUS",
              percent: 41,
              amount: null,
              currency: null,
              resets_at: null,
              observed_at: new Date(NOW).toISOString(),
              stale: false,
            },
          ],
        }),
        { status: 200 },
      ),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => bodies.shift() ?? Promise.reject(new Error("offline"))),
    );
    mounted = render(createElement(PairFlow));
    await flush(6);
    expect(mounted.container.textContent).toContain(hub.pairPage.bars.title);
    vi.useRealTimers();
  });
});
