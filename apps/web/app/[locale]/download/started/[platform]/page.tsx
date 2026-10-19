import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { DocLink } from "@/components/docs/prose";
import { DownloadStart } from "@/components/download-start";
import { PageShell } from "@/components/page-shell";
import { pageLocale } from "@/i18n/params";
import { type DesktopPlatform, primaryDownloadHref } from "@/lib/downloads";
import { pageMetadata } from "@/lib/metadata";
import { CURRENT_VERSION } from "@/lib/site";

/**
 * The step after a desktop download button.
 *
 * The button lands here with the query string it was given, so a tagged visit
 * is counted again, by platform and by source, as a page view: Vercel Web
 * Analytics records `/download/started/windows/via/reddit-a` with no event,
 * no cookie and no new tag. The page shows what to do next and starts the file.
 */

const PLATFORMS = ["windows", "macos", "linux"] as const;
const NAMES: Record<DesktopPlatform, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

/** The steps after the click, as keys under `download.started`. */
const STEPS: Record<DesktopPlatform, readonly string[]> = {
  windows: ["windows.open", "windows.smartScreen", "firstRun"],
  macos: ["macos.open", "macos.gatekeeper", "firstRun"],
  linux: ["linux.open", "linux.packages", "firstRun", "linux.wayland"],
};

const APPIMAGE = "chmod +x OpenLimiter-linux-x86_64.AppImage\n./OpenLimiter-linux-x86_64.AppImage";

interface StartedParams {
  params: Promise<{ locale: string; platform: string }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return PLATFORMS.map((platform) => ({ platform }));
}

async function platformOf(params: StartedParams["params"]): Promise<DesktopPlatform> {
  const { platform } = await params;
  if (!(PLATFORMS as readonly string[]).includes(platform)) notFound();
  return platform as DesktopPlatform;
}

export async function generateMetadata({ params }: StartedParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const platform = await platformOf(params);
  const t = await getTranslations({ locale, namespace: "download.started" });
  return {
    ...pageMetadata({
      title: t("title"),
      description: t("lead", { version: CURRENT_VERSION, platform: NAMES[platform] }),
      route: `/download/started/${platform}`,
      locale,
    }),
    /* A step in a flow, not a page to find in a search. */
    robots: { index: false, follow: true },
  };
}

export default async function DownloadStartedPage({ params }: StartedParams) {
  await pageLocale(params);
  const platform = await platformOf(params);
  const t = await getTranslations("download.started");
  const href = primaryDownloadHref(platform);

  return (
    <PageShell title={t("title")} lead={t("lead", { version: CURRENT_VERSION, platform: NAMES[platform] })}>
      <DownloadStart href={href} />
      <ol className="mx-auto max-w-2xl list-inside list-decimal space-y-4 text-center text-soft">
        {STEPS[platform].map((step) => (
          <li key={step}>
            {t.rich(step, {
              download: (chunks) => <DocLink href="/download">{chunks}</DocLink>,
            })}
            {step === "linux.open" && (
              <pre className="mx-auto mt-3 block w-fit max-w-full overflow-x-auto rounded-xl border border-hairline bg-frame px-5 py-4 text-left text-sm text-heading">
                <code>{APPIMAGE}</code>
              </pre>
            )}
          </li>
        ))}
      </ol>
      <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-muted">
        {t.rich("manual", {
          file: (chunks) => (
            <a href={href} className="focus-ring rounded text-accent underline underline-offset-4">
              {chunks}
            </a>
          ),
        })}
      </p>
      <p className="mt-4 text-center text-sm">
        <DocLink href="/download">{t("back")}</DocLink>
      </p>
    </PageShell>
  );
}
