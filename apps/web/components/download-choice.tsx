"use client";

import { useEffect, useState } from "react";

type Platform = "windows" | "linux" | "macos";

function detectedPlatform(): Platform {
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("linux") || value.includes("x11")) return "linux";
  return "windows";
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
  smartScreen,
  openAnyway,
}: {
  windowsHref: string;
  linuxHref: string;
  macosHref: string;
  otherHref: string;
  windowsLabel: string;
  linuxLabel: string;
  macosLabel: string;
  otherLabel: string;
  smartScreen: string;
  /**
   * What a Mac reader has to do the first time, and what they do not get yet.
   *
   * Both builds this site offers are unsigned, and an unsigned build is only
   * honest if the note is beside the button rather than three sections below
   * it. macOS gets the same treatment Windows already had.
   */
  openAnyway: string;
}) {
  const [platform, setPlatform] = useState<Platform>("windows");

  useEffect(() => setPlatform(detectedPlatform()), []);

  const targets = [
    {
      id: "windows" as const,
      label: windowsLabel,
      href: windowsHref,
      note: smartScreen,
    },
    {
      id: "macos" as const,
      label: macosLabel,
      href: macosHref,
      note: openAnyway,
    },
    {
      id: "linux" as const,
      label: linuxLabel,
      href: linuxHref,
      note: null,
    },
  ];

  return (
    <div className="mx-auto flex max-w-4xl flex-col items-center rounded-2xl border border-hairline bg-surface p-6 sm:p-8 text-center elev-1">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
        {targets.map((target) => {
          const isDetected = target.id === platform;
          return (
            <div
              key={target.id}
              className={`flex flex-col justify-between rounded-xl border p-5 transition-colors ${
                isDetected
                  ? "border-accent bg-accent-subtle/30"
                  : "border-hairline bg-raised/50 hover:border-hairline-strong"
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="heading-face text-sm font-semibold text-heading">
                    {target.id === "windows"
                      ? "Windows"
                      : target.id === "macos"
                        ? "macOS"
                        : "Linux"}
                  </span>
                  {isDetected && (
                    <span className="rounded-full bg-accent px-2 py-0.5 text-2xs font-medium text-on-accent">
                      Detected
                    </span>
                  )}
                </div>
                {target.note && (
                  <p className="text-xs leading-relaxed text-muted mb-4">
                    {target.note}
                  </p>
                )}
              </div>
              <a
                href={target.href}
                className={`focus-ring lift-sm inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
                  isDetected
                    ? "bg-accent text-on-accent hover:bg-accent-hover"
                    : "border border-hairline-strong bg-surface text-heading hover:bg-raised"
                }`}
              >
                {target.label}
              </a>
            </div>
          );
        })}
      </div>

      <div className="mt-8 border-t border-hairline pt-5 w-full text-center">
        <a
          href={otherHref}
          className="focus-ring inline-block rounded text-sm text-muted underline underline-offset-4 hover:text-heading"
        >
          {otherLabel}
        </a>
      </div>
    </div>
  );
}
