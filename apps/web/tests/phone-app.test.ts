// @vitest-environment jsdom

import { act, createElement, type ReactNode, useState } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { PhoneTabs, type PhoneTab } from "@/app/app/pair/phone-tabs";
import { ProTab } from "@/app/app/pair/pro-tab";
import { PhoneSettings } from "@/app/app/pair/phone-settings";
import {
  PHONE_LAST_BARS_KEY,
  PHONE_PAIRING_GENERATION_KEY,
  endPhoneSession,
  readPhonePairMeta,
  readPhoneLastBars,
  requestPhoneRead,
  writePhoneLastBars,
  writePhonePairMeta,
} from "@/lib/phone-session";

const body = {
  rows: [{
    account_id: "work",
    provider: "CLAUDE",
    code: "SEVEN_DAY",
    percent: 42,
    amount: null,
    currency: null,
    resets_at: "2026-10-07T12:00:00.000Z",
    observed_at: "2026-10-06T12:00:00.000Z",
    stale: false,
  }],
};

const PHONE_THEME = readFileSync("app/app/theme.css", "utf8");
const PAIR_FLOW = readFileSync("app/app/pair/pair-flow.tsx", "utf8");

describe("phone card geometry", () => {
  it("uses the bar card radius for pairing and Pro cards and hangs bullet text", () => {
    expect(PAIR_FLOW).toContain('const CARD = "rounded-lg border border-hairline bg-surface p-5";');
    expect(PHONE_THEME).toMatch(/\.ol-lock\s*\{[\s\S]*?border-radius:\s*var\(--ol-radius-md\)/u);
    expect(PHONE_THEME).toMatch(/\.ol-lock-offer\s*\{[\s\S]*?border-radius:\s*var\(--ol-radius-md\)/u);
    expect(PHONE_THEME).toMatch(/\.ol-lock-list li\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*0\.375rem\s+minmax\(0,\s*1fr\)/u);
  });
});

describe("the paired phone display cache", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    writePhonePairMeta({ label: "Test phone", expiresAt: Date.now() / 1000 + 3600 });
  });

  it("keeps a bounded display record and always restores it as stale", () => {
    writePhoneLastBars({ rows: Array.from({ length: 140 }, (_, index) => ({
      ...body.rows[0], account_id: `account-${index}`,
    })) });
    const stored = JSON.parse(localStorage.getItem(PHONE_LAST_BARS_KEY) ?? "null");
    expect(stored.version).toBe(1);
    expect(stored.rows).toHaveLength(128);
    expect(stored.rows[0]).toEqual({
      account_id: "account-0",
      provider: "CLAUDE",
      code: "SEVEN_DAY",
      percent: 42,
      resets_at: "2026-10-07T12:00:00.000Z",
      observed_at: "2026-10-06T12:00:00.000Z",
      stale: true,
    });
    expect(readPhoneLastBars()).toEqual({ rows: stored.rows });
  });

  it("rejects oversized and mismatched cached records", () => {
    writePhoneLastBars(body);
    const stored = JSON.parse(localStorage.getItem(PHONE_LAST_BARS_KEY) ?? "null");
    localStorage.setItem(PHONE_LAST_BARS_KEY, JSON.stringify({ ...stored, rows: Array(129).fill(stored.rows[0]) }));
    expect(readPhoneLastBars()).toBeNull();
    localStorage.setItem(PHONE_LAST_BARS_KEY, JSON.stringify({ ...stored, pairingGeneration: "other" }));
    expect(readPhoneLastBars()).toBeNull();
    expect(localStorage.getItem(PHONE_PAIRING_GENERATION_KEY)).not.toBe("other");
  });

  it("clears cached bars on unpair and rejects the late read", async () => {
    writePhoneLastBars(body);
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      expect(String(input)).toBe("/app/pair/api/read");
      return new Promise<Response>((resolve) => { release = resolve; });
    }));
    const late = requestPhoneRead();
    await endPhoneSession();
    release?.(new Response(JSON.stringify({ body }), { status: 200 }));
    await expect(late).resolves.toEqual({ kind: "unpaired" });
    expect(localStorage.getItem(PHONE_LAST_BARS_KEY)).toBeNull();
  });

  it("clears the pairing and cached bars when a read is revoked", async () => {
    writePhoneLastBars(body);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    await expect(requestPhoneRead()).resolves.toEqual({ kind: "revoked" });
    expect(readPhonePairMeta()).toBeNull();
    expect(localStorage.getItem(PHONE_LAST_BARS_KEY)).toBeNull();
  });

  it("reads normally after a reload abandoned a replacement in this tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("session")
      ? new Promise<Response>(() => undefined) : new Response(JSON.stringify({ body }), { status: 200 })));
    vi.resetModules();
    void (await import("@/lib/phone-session")).establishPhoneSession({ token: "new", expiresAt: Date.now() / 1000 + 86_400,
      refreshCredential: "new-refresh", refreshExpiresAt: Date.now() / 1000 + 30 * 86_400 }, "New");
    vi.resetModules();
    const reloaded = await import("@/lib/phone-session");
    await expect(reloaded.readCurrentPhoneBars("Reloaded")).resolves.toEqual({ kind: "fresh", body });
  });
});

describe("the paired phone shell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: ReactNode) {
    act(() => root.render(createElement(NextIntlClientProvider, {
      locale: "en",
      messages,
      children: node,
    })));
  }

  it("switches from Usage to the four Pro features and trial action", () => {
    function Harness() {
      const [tab, setTab] = useState<PhoneTab>("usage");
      return createElement("div", null,
        createElement("div", { id: "ol-phone-panel-usage", role: "tabpanel", "aria-labelledby": "ol-phone-tab-usage", hidden: tab !== "usage" }, "bars"),
        createElement("div", { id: "ol-phone-panel-pro", role: "tabpanel", "aria-labelledby": "ol-phone-tab-pro", hidden: tab !== "pro" }, createElement(ProTab)),
        createElement(PhoneTabs, { active: tab, onSelect: setTab }));
    }
    render(createElement(Harness));
    const pro = [...container.querySelectorAll("button")].find((button) => button.textContent === messages.hub.phoneTabs.pro)!;
    act(() => pro.click());
    expect(container.querySelectorAll(".ol-lock-list li")).toHaveLength(4);
    expect(container.textContent).toContain(messages.hub.trial.start);
    expect(pro.getAttribute("aria-controls")).toBe("ol-phone-panel-pro");
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(2);
    expect(container.querySelector<HTMLElement>("#ol-phone-panel-usage")?.hidden).toBe(true);
    expect(container.querySelector<HTMLElement>("#ol-phone-panel-pro")?.hidden).toBe(false);
    act(() => pro.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    const usage = [...container.querySelectorAll("button")].find((button) => button.textContent === messages.hub.phoneTabs.usage)!;
    expect(usage.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(usage);
    act(() => usage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement?.textContent).toBe(messages.hub.phoneTabs.pro);
  });

  it("uses ordinary navigation links when the destinations are different routes", () => {
    render(createElement(PhoneTabs, { active: "pro" }));
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.getAttribute("role") === null)).toBe(true);
    expect(links.every((link) => link.getAttribute("aria-controls") === null)).toBe(true);
    expect(links.find((link) => link.textContent === messages.hub.phoneTabs.pro)?.getAttribute("aria-current")).toBe("page");
  });

  it("traps focus in the gear sheet and unpairs from its action", async () => {
    writePhonePairMeta({ label: "Test phone", expiresAt: Date.now() / 1000 + 3600 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const unpaired = vi.fn();
    render(createElement("header", null, createElement(PhoneSettings, { label: "Test phone", onUnpaired: unpaired })));
    const gear = container.querySelector<HTMLButtonElement>(".ol-phone-gear")!;
    act(() => gear.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(dialog.parentElement).toBe(document.body.querySelector(".ol-sheet-backdrop"));
    const buttons = dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    last.focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(first);
    const unpair = [...buttons].find((button) => button.textContent === messages.hub.phoneSettings.unpair)!;
    await act(async () => { unpair.click(); await Promise.resolve(); });
    expect(unpaired).toHaveBeenCalledOnce();
    expect(readPhonePairMeta()).toBeNull();
  });
});
