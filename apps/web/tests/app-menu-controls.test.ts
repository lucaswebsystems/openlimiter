import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallControl } from "@/app/app/install";
import { SettingsMenu } from "@/app/app/pieces";
import { byText, flush, messages, render, type Mounted } from "./render";

vi.mock("next-intl", async () => {
  const catalog = (await import("../messages/en.json")).default as Record<string, unknown>;
  return { useTranslations: (namespace: string) => (key: string) => {
    const path = `${namespace}.${key}`.split(".");
    let node: unknown = catalog;
    for (const step of path) node = (node as Record<string, unknown>)[step];
    if (typeof node !== "string") throw new Error(`missing message: ${path.join(".")}`);
    return node;
  } };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("application menu controls", () => {
  it("reports installation state and disables the completed menu action", async () => {
    const states: boolean[] = [];
    mounted = render(createElement(InstallControl, {
      showButton: false,
      onInstalledChange: (installed: boolean) => states.push(installed),
    }));
    await flush();
    expect(states.at(-1)).toBe(false);
    mounted.run(() => { window.dispatchEvent(new Event("appinstalled")); });
    expect(states.at(-1)).toBe(true);
    mounted.unmount();

    mounted = render(createElement(SettingsMenu, {
      accountEmail: "person@example.test",
      syncEnabled: true,
      onSyncChange: () => undefined,
      showSettings: true,
      settingsSelected: false,
      onSettings: () => undefined,
      onPhone: () => undefined,
      onInstall: () => undefined,
      onCheckUpdate: () => undefined,
      onLogout: () => undefined,
      onOpen: () => undefined,
      installed: true,
      triggerRef: createRef<HTMLButtonElement>(),
    }));
    mounted.run(() => mounted?.container.querySelector<HTMLButtonElement>('[aria-label="Open menu"]')?.click());
    const installed = byText(mounted.container, "button", messages.hub.menu.installed) as HTMLButtonElement | null;
    expect(installed?.disabled).toBe(true);
    expect(mounted.container.textContent).not.toContain(messages.hub.menu.install);
  });
});
