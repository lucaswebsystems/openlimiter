import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { useClaudeMeterCopy } from "@/app/app/use-claude-meter-copy";
import catalog from "../messages/en.json";
import de from "../messages/de.json";
import es from "../messages/es.json";
import ja from "../messages/ja.json";
import ptBr from "../messages/pt-BR.json";
import proFeatures from "@/lib/pro-features.json";
import { render, type Mounted } from "./render";

/* Read from the layout itself, so this test cannot drift from what ships. */
const APP_NAMESPACES = JSON.parse(
  /namespaces=\{(\[[^\]]*\])\}/u.exec(readFileSync(resolve(process.cwd(), "app/app/layout.tsx"), "utf8"))?.[1] ?? "[]",
) as (keyof typeof catalog)[];
const appMessages = Object.fromEntries(
  APP_NAMESPACES.map((namespace) => [namespace, catalog[namespace]]),
);

function MessageProbe() {
  const t = useTranslations("hub");
  const claude = useClaudeMeterCopy();
  return createElement("output", null, [
    t("accountFallback", { count: 1 }),
    t("updatedMinutes", { count: 5 }),
    t("updatedHours", { count: 2 }),
    t("updatedDays", { count: 3 }),
    t("claudeFableDesktopHint"),
    claude.claudeCurrentSession,
    claude.claudeWeeklyAllModels,
    claude.claudeWeeklyFable,
    claude.claudeWeeklyModel,
    claude.claudeExtraUsage,
  ].join(" | "));
}

/* What the hub's Pro card and the paired phone's Pro tab read (U57, U61). */
function ProProbe() {
  const portal = useTranslations("proPortal");
  const feature = useTranslations("proFeatures");
  const pro = useTranslations("hub.pro");
  return createElement("output", null, [
    portal("upgrade.monthly", { price: "$5" }),
    portal("upgrade.yearly", { price: "$50" }),
    portal("upgrade.note"),
    portal("plan.active.title"),
    portal("plan.trial.title"),
    portal("plan.pastDue.title"),
    pro("locked.price", { monthly: "$5", yearly: "$50" }),
    pro("phonePush"),
    ...proFeatures.features.map(({ id }) => feature(id)),
  ].join(" | "));
}

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("app message loading", () => {
  it("has no catalog copy that promises the Claude poll is off by default", () => {
    for (const messages of [catalog, ptBr, es, de, ja]) {
      const copy = JSON.stringify(messages);
      expect(copy).not.toMatch(/opt in poll|off unless you turn it on/iu);
    }
  });
  it("resolves every reading key through the exact namespaces AppLayout provides", () => {
    const errors: unknown[] = [];
    mounted = render(createElement(
      NextIntlClientProvider,
      {
        locale: "en",
        messages: appMessages,
        onError: (error) => errors.push(error),
        children: createElement(MessageProbe),
      },
    ));

    expect(errors).toEqual([]);
    expect(mounted.container.textContent).not.toContain("desktopReadings");
    expect(mounted.container.textContent).not.toContain("hub.");
    expect(mounted.container.textContent).toContain("Current session");
    expect(mounted.container.textContent).toContain("Account 1");
  });

  it("resolves the Pro card and the phone's Pro tab through the same namespaces", () => {
    const errors: unknown[] = [];
    mounted = render(createElement(
      NextIntlClientProvider,
      {
        locale: "en",
        messages: appMessages,
        onError: (error) => errors.push(error),
        children: createElement(ProProbe),
      },
    ));
    expect(errors).toEqual([]);
    expect(mounted.container.textContent).not.toMatch(/proPortal\.|proFeatures\./u);
    expect(mounted.container.textContent).toContain(catalog.proFeatures.ember);
  });
});
