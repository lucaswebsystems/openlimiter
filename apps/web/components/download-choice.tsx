"use client";

import { useEffect, useState } from "react";

type Platform = "windows" | "linux" | "macos";

interface Choice {
  platform: Platform;
  label: string;
  href?: string;
}

function detectedPlatform(): Platform {
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("linux") || value.includes("x11")) return "linux";
  return "windows";
}

export function DownloadChoice({
  windowsHref,
  linuxHref,
  otherHref,
  windowsLabel,
  linuxLabel,
  macosLabel,
  otherLabel,
  smartScreen,
}: {
  windowsHref: string;
  linuxHref: string;
  otherHref: string;
  windowsLabel: string;
  linuxLabel: string;
  macosLabel: string;
  otherLabel: string;
  smartScreen: string;
}) {
  const [platform, setPlatform] = useState<Platform>("windows");

  useEffect(() => setPlatform(detectedPlatform()), []);

  const choices: readonly Choice[] = [
    { platform: "windows", label: windowsLabel, href: windowsHref },
    { platform: "linux", label: linuxLabel, href: linuxHref },
    { platform: "macos", label: macosLabel },
  ];
  const primary = choices.find((choice) => choice.platform === platform) ?? choices[0]!;

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-hairline bg-surface p-7 text-center sm:p-9">
      {primary.href ? (
        <a href={primary.href} className="focus-ring lift-sm inline-flex min-h-12 items-center justify-center rounded-xl bg-accent px-6 text-sm font-semibold text-on-accent hover:bg-accent-hover">
          {primary.label}
        </a>
      ) : (
        <span className="inline-flex min-h-12 items-center justify-center rounded-xl border border-hairline px-6 text-sm font-semibold text-muted">
          {primary.label}
        </span>
      )}

      {platform === "windows" && (
        <p className="mt-3 text-xs text-muted">{smartScreen}</p>
      )}

      <a href={otherHref} className="focus-ring mt-5 rounded text-sm text-muted underline underline-offset-4 hover:text-heading">
        {otherLabel}
      </a>
    </div>
  );
}
