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
  /* 2.1.7, plan item 8: the direct Claude request is opt in, and every page
     that mentions it says so: off until you turn it on, what it sends, to
     whom, how often, and that it becomes the source of every Claude bar. The
     retired switch name and the 2.1.5 behaviour are gone in every locale. */
  it("describes the Claude request as off until it is turned on, in every locale", () => {
    const en = catalog as unknown as Record<string, Record<string, unknown>>;
    const at = (path: string) => path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], en) as string;
    for (const path of [
      "integrations.connectors.claude.detail",
      "download.disclosure.claude",
      "docs.pages.providers.sections.the-nine.rows.claude.reads",
      "docs.pages.providers.sections.how-data-arrives.bullets.claude",
      "docs.pages.zero-setup.sections.providers.rows.claude.source",
      "docs.pages.cli.sections.commands.claudePoll",
    ]) expect(at(path), path).toMatch(/off until you turn it on/iu);
    for (const path of ["download.disclosure.claude", "docs.pages.cli.sections.commands.claudePoll"]) {
      for (const fact of ["your own Claude Code login", "only to Anthropic", "about every five minutes", "every Claude bar", "Anthropic's policy for tools like this is unresolved"]) {
        expect(at(path), path).toContain(fact);
      }
    }
    /* The first run's consent keys leave with the DESK lane's first run work. */
    const consent = new Set(["claudePollConsentTitle", "claudePollNotNow", "claudePollSaveFailed", "claudePollContinueOff"]);
    const leaves = (node: unknown, key = ""): string[] => typeof node === "string"
      ? (consent.has(key) ? [] : [node])
      : node !== null && typeof node === "object"
        ? Object.entries(node).flatMap(([child, value]) => leaves(value, child))
        : [];
    for (const messages of [catalog, ptBr, es, de, ja]) {
      for (const copy of leaves(messages)) {
        expect(copy).not.toMatch(/Show Fable limit|Fable Limit anzeigen|Mostrar límite de Fable|Fable の上限を表示|Mostrar limite do Fable/u);
        expect(copy).not.toMatch(/starts on|after a disclosure|after showing you a disclosure|records its own choice|are asked first/u);
      }
    }
    const llms = readFileSync(resolve(process.cwd(), "public/llms.txt"), "utf8");
    expect(llms).toMatch(/off until you turn it on/u);
    expect(llms).not.toMatch(/starts on|records its own choice|show the disclosure before recording on/u);
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
