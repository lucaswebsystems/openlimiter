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

export function DownloadChoice({ windowsHref, linuxHref, comingSoon }: {
  windowsHref: string;
  linuxHref: string;
  comingSoon: string;
}) {
  const [platform, setPlatform] = useState<Platform>("windows");
  const [open, setOpen] = useState(false);

  useEffect(() => setPlatform(detectedPlatform()), []);

  const choices: readonly Choice[] = [
    { platform: "windows", label: "Download for Windows", href: windowsHref },
    { platform: "linux", label: "Download for Linux", href: linuxHref },
    { platform: "macos", label: `macOS ${comingSoon}` },
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
        <p className="mt-3 text-xs text-muted">SmartScreen: More info, then Run anyway.</p>
      )}

      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className="focus-ring mt-5 rounded text-sm text-accent hover:text-accent-hover">
        Other platforms
      </button>

      {open && (
        <div className="mt-4 flex flex-wrap justify-center gap-3" aria-label="Other platforms">
          {choices.filter((choice) => choice.platform !== platform).map((choice) =>
            choice.href ? (
              <a key={choice.platform} href={choice.href} className="focus-ring rounded-lg border border-hairline px-4 py-2 text-sm text-heading hover:border-hairline-strong hover:bg-raised">
                {choice.label}
              </a>
            ) : (
              <span key={choice.platform} className="rounded-lg border border-hairline px-4 py-2 text-sm text-muted">
                {choice.label}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}
