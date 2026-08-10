import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocsSidebar, type SidebarGroup } from "@/components/docs/sidebar";
import { SHELL } from "@/components/ui";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { docGroups } from "@/lib/docs";

/**
 * The documentation column renders inside the same SHELL as every other band on
 * the site, so the sidebar's left edge lines up with the wordmark above it and
 * the article's right edge lines up with the last header link.
 *
 * It is also where the sidebar's labels are read out of the catalog. The sidebar
 * hydrates, so anything it reads from the catalog would travel to the browser;
 * doing the reading here sends eleven labels instead of the whole
 * documentation's prose. See components/docs/sidebar.tsx.
 */
export default async function DocsLayout({
  children,
  params,
}: { children: ReactNode } & LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("docs");

  const groups: SidebarGroup[] = docGroups.map((group) => ({
    id: group.id,
    label: t(`groups.${group.id}`),
    pages: group.pages.map((page) => ({
      href: page.href,
      label: t(`pages.${page.id}.title`),
    })),
  }));

  const sidebar = {
    groups,
    navLabel: t("sidebar.label"),
    menuLabel: t("sidebar.menu"),
  };

  return (
    <main id="main" className="bg-canvas">
      <div className={`${SHELL} flex gap-12`}>
        <div className="hidden w-56 flex-none lg:block">
          <DocsSidebar variant="full" {...sidebar} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="lg:hidden">
            <DocsSidebar variant="compact" {...sidebar} />
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
