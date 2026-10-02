import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRows } from "@/app/app/pieces";
import { cardOrderStorageKey } from "@/app/app/card-order";
import type { ProviderAccountRowView, ProviderCode } from "@/app/app/engine";
import { all, flush, messages, render, type Mounted } from "./render";

vi.mock("next-intl", async () => {
  const catalog = (await import("../messages/en.json")).default as Record<string, unknown>;
  return { useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    const path = `${namespace}.${key}`.split(".");
    let node: unknown = catalog;
    for (const step of path) node = (node as Record<string, unknown>)[step];
    if (typeof node !== "string") throw new Error(`missing message: ${path.join(".")}`);
    return node.replace(/\{(\w+)\}/gu, (whole, name: string) =>
      values?.[name] === undefined ? whole : String(values[name]));
  } };
});

function row(provider: ProviderCode, name: string): ProviderAccountRowView {
  return {
    key: `${provider}:account:named:one`,
    provider,
    providerLabel: name,
    accountId: "one",
    accountLabel: "Account 1",
    showAccountLabel: false,
    sourceLabel: null,
    windows: [{
      key: "weekly",
      label: "Weekly",
      state: "fresh",
      stateLabel: "Fresh",
      tone: "ok",
      metricKind: "percent",
      usedPercent: 20,
      readout: "20.0%",
      detail: "80.0% left",
      resetLabel: null,
      accessibleLabel: "Weekly, 20.0% used",
      updatedLabel: null,
    }],
    fallback: null,
    failure: null,
    demo: false,
  };
}

const rows = [row("CLAUDE", "Claude"), row("CODEX", "Codex")];
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  window.localStorage.clear();
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks();
});

function keys(): string[] {
  return all<HTMLElement>(mounted!.container, "[data-card-key]").map((node) => node.dataset["cardKey"] ?? "");
}

describe("rearrangeable provider grid", () => {
  it("opens named move buttons from the grip, moves by button and arrow key, and keeps focus", async () => {
    mounted = render(createElement(ProviderRows, {
      rows,
      orderScope: { kind: "user", id: "person" },
      reorderable: true,
    }));
    await flush();
    const host = mounted.container.querySelector<HTMLElement>("openlimiter-provider-row");
    expect(host?.shadowRoot?.querySelector('.identity > slot[name="actions"]')).not.toBeNull();
    expect(host?.shadowRoot?.querySelector("style")?.textContent).toContain("@container (max-width: 30rem)");
    const firstGrip = mounted.container.querySelector<HTMLButtonElement>(".ol-card-grip");
    expect(firstGrip?.parentElement).toBe(host);
    mounted.run(() => firstGrip?.click());
    expect(firstGrip?.getAttribute("aria-expanded")).toBe("true");
    expect(firstGrip?.hasAttribute("aria-haspopup")).toBe(false);
    const description = document.getElementById(firstGrip?.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toContain("arrow keys");
    const earlier = all<HTMLButtonElement>(mounted.container, ".ol-card-move-popover button")
      .find((button) => button.getAttribute("aria-label")?.startsWith(messages.hub.grid.moveEarlier));
    const later = all<HTMLButtonElement>(mounted.container, ".ol-card-move-popover button")
      .find((button) => button.getAttribute("aria-label")?.startsWith(messages.hub.grid.moveLater));
    expect(mounted.container.querySelector('.ol-card-move-popover[role="menu"]')).toBeNull();
    expect(mounted.container.querySelector('[role="menuitem"]')).toBeNull();
    expect(earlier?.disabled).toBe(true);
    expect(later?.disabled).toBe(false);
    expect(document.activeElement).toBe(later);

    mounted.run(() => {
      firstGrip?.focus();
      firstGrip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(keys()).toEqual([rows[0]!.key, rows[1]!.key]);
    expect(firstGrip?.getAttribute("aria-expanded")).toBe("true");
    mounted.run(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(firstGrip?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(firstGrip);

    mounted.run(() => firstGrip?.click());
    const reopenedLater = all<HTMLButtonElement>(mounted.container, ".ol-card-move-popover button")
      .find((button) => button.getAttribute("aria-label")?.startsWith(messages.hub.grid.moveLater));
    mounted.run(() => reopenedLater?.click());
    expect(keys()).toEqual([rows[1]!.key, rows[0]!.key]);
    const movedGrip = mounted.container.querySelector<HTMLButtonElement>(`[data-card-key="${rows[0]!.key}"] .ol-card-grip`);
    expect(document.activeElement).toBe(movedGrip);
    expect(mounted.container.querySelector('[role="status"]')?.textContent)
      .toContain("position 2 of 2");

    mounted.run(() => { movedGrip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(keys()).toEqual([rows[0]!.key, rows[1]!.key]);
    expect(document.activeElement).toBe(movedGrip);
  });

  it("keeps a refreshed drag as preview only, then restores storage and announces cancellation", async () => {
    const storageKey = cardOrderStorageKey({ kind: "paired", id: "phone" });
    let refreshRows: () => void = () => {};
    function RowsHarness() {
      const [currentRows, setCurrentRows] = useState(rows);
      refreshRows = () => setCurrentRows((current) => current.map((item) => ({ ...item })));
      return createElement(ProviderRows, {
        rows: currentRows,
        orderScope: { kind: "paired", id: "phone" },
        reorderable: true,
      });
    }
    mounted = render(createElement(RowsHarness));
    await flush();
    const grip = mounted.container.querySelector<HTMLButtonElement>(".ol-card-grip");
    const target = all<HTMLElement>(mounted.container, "[data-card-key]")[1];
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    const pointer = (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 10 });
      Object.defineProperty(event, "pointerId", { value: 7 });
      return event;
    };
    mounted.run(() => {
      grip?.dispatchEvent(pointer("pointerdown"));
      grip?.dispatchEvent(pointer("pointermove"));
    });
    expect(keys()).toEqual([rows[1]!.key, rows[0]!.key]);
    mounted.run(refreshRows);
    expect(window.localStorage.getItem(storageKey)).not.toContain(rows[1]!.key + "\",\"" + rows[0]!.key);
    mounted.run(() => { grip?.dispatchEvent(pointer("pointercancel")); });
    expect(keys()).toEqual([rows[0]!.key, rows[1]!.key]);
    expect(document.activeElement).toBe(grip);
    expect(mounted.container.querySelector('[role="status"]')?.textContent).toContain("cancelled");

    mounted.unmount();
    mounted = render(createElement(ProviderRows, {
      rows,
      orderScope: { kind: "paired", id: "phone" },
      reorderable: true,
    }));
    await flush();
    expect(keys()).toEqual([rows[0]!.key, rows[1]!.key]);
  });

  it("keeps account identity visible in compact cards", async () => {
    const accountRows = [
      { ...row("CLAUDE", "Claude"), key: "claude:one", accountLabel: "Work", showAccountLabel: true },
      { ...row("CLAUDE", "Claude"), key: "claude:two", accountLabel: "Personal", showAccountLabel: true },
    ];
    mounted = render(createElement(ProviderRows, { rows: accountRows }));
    await flush();
    const hosts = all<HTMLElement>(mounted.container, "openlimiter-provider-row");
    expect(hosts.map((host) => host.shadowRoot?.querySelector(".account-label")?.textContent))
      .toEqual(["Work", "Personal"]);
    const style = hosts[0]?.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(style).not.toContain(".account-label { display: none; }");
  });

  it("uses matching wide tracks for column headings and values", async () => {
    mounted = render(createElement(ProviderRows, { rows }));
    await flush();
    const style = mounted.container.querySelector<HTMLElement>("openlimiter-provider-row")
      ?.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(style).toMatch(/--row-columns:[^;]+2rem;/u);
    expect(style).toMatch(/\.identity\s*\{[^}]*grid-template-columns:\s*var\(--row-columns\)/u);
    expect(style).toMatch(/\.window-line\s*\{[^}]*grid-template-columns:\s*var\(--row-columns\)/u);
  });

  it("keeps the Claude setup hint inside the shared card footer", async () => {
    mounted = render(createElement(ProviderRows, {
      rows: [row("CLAUDE", "Claude")],
      claudeFableHintText: "Turn on Show Fable limit in the desktop app.",
    }));
    await flush();

    const host = mounted.container.querySelector<HTMLElement>("openlimiter-provider-row");
    const footer = host?.querySelector<HTMLElement>('[slot="footer"]');
    expect(footer?.textContent).toBe("Turn on Show Fable limit in the desktop app.");
    expect(host?.shadowRoot?.querySelector('slot[name="footer"]')).not.toBeNull();
  });
});
