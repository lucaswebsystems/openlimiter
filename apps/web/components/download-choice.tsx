"use client";

import { useEffect, useState } from "react";

export type Platform = "windows" | "linux" | "macos" | "mobile" | "unknown";

export function detectedPlatform(
  signals?: Pick<Navigator, "platform" | "userAgent" | "maxTouchPoints">,
): Platform {
  if (signals === undefined) {
    if (typeof navigator === "undefined") return "unknown";
    signals = navigator;
  }

  const platform = signals.platform.toLowerCase();
  const userAgent = signals.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/gu.test(userAgent) || (platform === "macintel" && signals.maxTouchPoints > 1);
  if (isIos || userAgent.includes("android")) return "mobile";
  if (platform.includes("win") || userAgent.includes("windows")) return "windows";
  if (platform.includes("mac") || userAgent.includes("mac os")) return "macos";
  if (platform.includes("linux") || platform.includes("x11") || userAgent.includes("linux")) return "linux";
  return "unknown";
}

function WindowsGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M3 5.4 10.6 4.3v7.2H3V5.4Zm0 13.2 7.6 1.1v-7.1H3v6Zm8.7 1.3L21 21V12.6h-9.3v7.3Zm0-15.8v7.4H21V3l-9.3 1.1Z" />
    </svg>
  );
}

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M16.36 12.72c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3.01-.79-1.55.02-2.98.9-3.77 2.29-1.61 2.79-.41 6.92 1.15 9.18.77 1.11 1.68 2.35 2.87 2.3 1.15-.05 1.59-.74 2.98-.74 1.39 0 1.78.74 3 .72 1.24-.02 2.02-1.12 2.78-2.24.88-1.28 1.24-2.53 1.26-2.6-.03-.01-2.4-.92-2.42-3.69ZM14.1 5.98c.63-.77 1.06-1.83.94-2.9-.91.04-2.02.61-2.67 1.37-.58.68-1.09 1.77-.95 2.81 1.02.08 2.05-.52 2.68-1.28Z" />
    </svg>
  );
}

function LinuxGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.8c-2.5 0-3.8 2-3.8 4.3 0 1.6-.5 2.9-1.3 4.2-1 1.7-1.8 3.4-1.8 5.1 0 2.8 2.3 4.4 6.9 4.4s6.9-1.6 6.9-4.4c0-1.7-.8-3.4-1.8-5.1-.8-1.3-1.3-2.6-1.3-4.2 0-2.3-1.3-4.3-3.8-4.3Z" />
      <path d="M9.9 7.1v.01M14.1 7.1v.01" strokeWidth="2.3" />
      <path d="M10.7 9.3c.5.5 2.1.5 2.6 0" />
    </svg>
  );
}

function PlatformGlyph({ platform }: { platform: "windows" | "macos" | "linux" }) {
  if (platform === "windows") return <WindowsGlyph />;
  if (platform === "macos") return <AppleGlyph />;
  return <LinuxGlyph />;
}

export function DownloadChoice({
  windowsHref,
  linuxHref,
  macosHref,
  otherHref,
  windowsLabel,
  linuxLabel,
  macosLabel,
  otherLabel,
  windowsSummary,
  macosSummary,
  linuxSummary,
  versionLine,
  releaseNotesLabel,
  releaseNotesHref,
  detectedLabel,
  previewTitle,
  previewAlt,
}: {
  windowsHref: string;
  linuxHref: string;
  macosHref: string;
  otherHref: string;
  windowsLabel: string;
  linuxLabel: string;
  macosLabel: string;
  otherLabel: string;
  windowsSummary: string;
  /**
   * What a Mac reader has to do the first time, and what they do not get yet.
   *
   * Both builds this site offers are unsigned, and an unsigned build is only
   * honest if the note is beside the button rather than three sections below
   * it. macOS gets the same treatment Windows already had.
   */
  macosSummary: string;
  linuxSummary: string;
  /**
   * "Version {version}", already rendered by the caller. It sits beside the
   * button grid rather than under the whole component: the product preview
   * below this card is tall enough that a line placed after it would sit
   * below the fold, and a reader deciding what to download should not have
   * to scroll to find out what they are about to get.
   */
  versionLine: string;
  releaseNotesLabel: string;
  releaseNotesHref: string;
  detectedLabel: string;
  previewTitle: string;
  previewAlt: string;
}) {
  const [platform, setPlatform] = useState<Platform>("unknown");

  useEffect(() => {
    setPlatform(detectedPlatform());
  }, []);

  const targets = [
    {
      id: "windows" as const,
      label: windowsLabel,
      href: windowsHref,
      note: windowsSummary,
    },
    {
      id: "macos" as const,
      label: macosLabel,
      href: macosHref,
      note: macosSummary,
    },
    {
      id: "linux" as const,
      label: linuxLabel,
      href: linuxHref,
      note: linuxSummary,
    },
  ];

  return (
    <div className="mx-auto flex max-w-4xl flex-col items-center gap-10">
      <div className="flex w-full flex-col items-center rounded-2xl border border-hairline bg-surface p-6 sm:p-8 text-center elev-1">
        <div className="grid w-full grid-cols-1 items-stretch gap-4 text-center md:grid-cols-3">
          {targets.map((target) => {
            const isDetected = target.id === platform;
            return (
              <article
                key={target.id}
                id={target.id}
                className={`flex h-full min-h-64 flex-col rounded-xl border p-5 text-center transition-colors ${
                  isDetected
                    ? "border-accent bg-accent-subtle/30"
                    : "border-hairline bg-raised/50 hover:border-hairline-strong"
                }`}
              >
                <div className="flex h-full flex-col items-center">
                  <div className="mb-3 flex min-h-8 items-center justify-center gap-2">
                    <h2 className="heading-face text-sm font-semibold text-heading">
                      {target.id === "windows"
                        ? "Windows"
                        : target.id === "macos"
                          ? "macOS"
                          : "Linux"}
                    </h2>
                    {isDetected && (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-2xs font-medium text-on-accent">
                        {detectedLabel}
                      </span>
                    )}
                  </div>
                  {target.note && (
                    <p className="mx-auto max-w-xs text-sm leading-relaxed text-muted">
                      {target.note}
                    </p>
                  )}
                <a
                  href={target.href}
                  className="focus-ring lift-sm mt-auto inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
                >
                  <PlatformGlyph platform={target.id} />
                  {target.label}
                </a>
                </div>
              </article>
            );
          })}
        </div>

        <div className="mt-8 border-t border-hairline pt-5 w-full text-center">
          <p className="text-xs leading-relaxed text-muted">
            {versionLine}
            <span className="legal-dot" aria-hidden="true" />
            <a
              href={releaseNotesHref}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
            >
              {releaseNotesLabel}
            </a>
          </p>
          <a
            href={otherHref}
            className="focus-ring mt-3 inline-block rounded text-sm text-muted underline underline-offset-4 hover:text-heading"
          >
            {otherLabel}
          </a>
        </div>
      </div>

      <div className="w-full text-center">
        <h2 className="heading-face mb-3 text-center text-xl font-semibold text-heading">{previewTitle}</h2>
        <div className="elev-2 overflow-hidden rounded-2xl border border-hairline bg-frame">
          <picture>
            <source
              type="image/webp"
              srcSet="/screenshots/desktop-home@1x.webp 1x, /screenshots/desktop-home@2x.webp 2x"
              sizes="(min-width: 1024px) 900px, calc(100vw - 2rem)"
            />
            <img
              src="/screenshots/desktop-home.png"
              alt={previewAlt}
              width={2000}
              height={2410}
              loading="lazy"
              sizes="(min-width: 1024px) 900px, calc(100vw - 2rem)"
              className="h-auto w-full"
            />
          </picture>
        </div>
      </div>
    </div>
  );
}
