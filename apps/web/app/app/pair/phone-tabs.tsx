"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { KeyboardEvent, ReactNode } from "react";

export type PhoneTab = "usage" | "pro";

export function PhoneTabs({ active, onSelect }: {
  active: PhoneTab;
  onSelect?: (tab: PhoneTab) => void;
}) {
  const t = useTranslations("hub.phoneTabs");
  const tabs: Array<{ tab: PhoneTab; href: string }> = [
    { tab: "usage", href: "/app/pair" },
    { tab: "pro", href: "/app?trial=1" },
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const current = tabs.findIndex(({ tab }) => tab === event.currentTarget.dataset.tab);
    if (current < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const element = event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-tab="${tabs[next]!.tab}"]`);
    if (element === null || element === undefined) return;
    event.preventDefault();
    onSelect?.(tabs[next]!.tab);
    element.focus();
  };
  const item = (tab: PhoneTab, href: string) => onSelect === undefined ? (
    <Link
      key={tab}
      href={href}
      aria-current={active === tab ? "page" : undefined}
      data-tab={tab}
      data-selected={active === tab ? "" : undefined}
      className="ol-product-tab focus-ring"
    >{t(tab)}</Link>
  ) : (
    <button
      key={tab}
      type="button"
      role="tab"
      id={`ol-phone-tab-${tab}`}
      aria-controls={`ol-phone-panel-${tab}`}
      aria-selected={active === tab}
      tabIndex={active === tab ? 0 : -1}
      data-tab={tab}
      data-selected={active === tab ? "" : undefined}
      className="ol-product-tab focus-ring"
      onClick={() => onSelect(tab)}
      onKeyDown={onKeyDown}
    >{t(tab)}</button>
  );
  const items: ReactNode = tabs.map(({ tab, href }) => item(tab, href));
  return onSelect === undefined
    ? <nav className="ol-phone-tabs" aria-label={t("label")}>{items}</nav>
    : <div className="ol-phone-tabs" role="tablist" aria-label={t("label")}>{items}</div>;
}
