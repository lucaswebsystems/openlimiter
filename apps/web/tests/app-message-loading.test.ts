import { createElement } from "react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { useClaudeMeterCopy } from "@/app/app/use-claude-meter-copy";
import catalog from "../messages/en.json";
import de from "../messages/de.json";
import es from "../messages/es.json";
import ja from "../messages/ja.json";
import ptBr from "../messages/pt-BR.json";
import { render, type Mounted } from "./render";

const APP_NAMESPACES = ["common", "nav", "announce", "signIn", "hub"] as const;
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
});
