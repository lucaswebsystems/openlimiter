import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRows } from "@/app/app/pieces";
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
    const earlier = all<HTMLButtonElement>(mounted.container, ".ol-card-move-popover button")
      .find((button) => button.getAttribute("aria-label")?.startsWith(messages.hub.grid.moveEarlier));
    const later = all<HTMLButtonElement>(mounted.container, ".ol-card-move-popover button")
      .find((button) => button.getAttribute("aria-label")?.startsWith(messages.hub.grid.moveLater));
    expect(earlier?.disabled).toBe(true);
    expect(later?.disabled).toBe(false);
    mounted.run(() => later?.click());
    expect(keys()).toEqual([rows[1]!.key, rows[0]!.key]);
    const movedGrip = mounted.container.querySelector<HTMLButtonElement>(`[data-card-key="${rows[0]!.key}"] .ol-card-grip`);
    expect(document.activeElement).toBe(movedGrip);
    expect(mounted.container.querySelector('[role="status"]')?.textContent)
      .toContain("position 2 of 2");

    mounted.run(() => { movedGrip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(keys()).toEqual([rows[0]!.key, rows[1]!.key]);
    expect(document.activeElement).toBe(movedGrip);
  });

  it("starts dragging only on the grip and restores the original order on pointer cancel", async () => {
    mounted = render(createElement(ProviderRows, {
      rows,
      orderScope: { kind: "paired", id: "phone" },
      reorderable: true,
    }));
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
    mounted.run(() => { grip?.dispatchEvent(pointer("pointercancel")); });
    expect(keys()).toEqual([rows[0]!.key, rows[1]!.key]);
    expect(document.activeElement).toBe(grip);
  });
});
