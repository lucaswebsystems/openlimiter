"use client";

import { useEffect, useState } from "react";

type Platform = "windows" | "linux" | "macos";

function detectedPlatform(): Platform {
  if (typeof navigator === "undefined") return "windows";
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("linux") || value.includes("x11")) return "linux";
  return "windows";
}

function OctagonExclamationIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 1.5h6l3.5 3.5v6L11 14.5H5L1.5 11V5L5 1.5Z" />
      <path d="M8 5v3.8M8 11.2v.5" />
    </svg>
  );
}

function ClockGlyph({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5v3.8l2.5 1.5" />
    </svg>
  );
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
  linuxNote,
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
  linuxNote: string;
}) {
  const [platform, setPlatform] = useState<Platform>("windows");
  const [countdownSec, setCountdownSec] = useState(860); // 14m 20s

  useEffect(() => {
    setPlatform(detectedPlatform());
    const interval = window.setInterval(() => {
      setCountdownSec((prev) => (prev > 1 ? prev - 1 : 860));
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const formatCountdown = (totalSec: number) => {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  };

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
      note: linuxNote,
    },
  ];

  /* Radial SVG calculations for 96% */
  const radius = 28;
  const circumference = 2 * Math.PI * radius; // ~175.93
  const strokeDashoffset = circumference * 0.04; // 96% filled

  return (
    <div className="mx-auto flex max-w-4xl flex-col items-center gap-10">
      {/* OS Download Cards */}
      <div className="flex w-full flex-col items-center rounded-2xl border border-hairline bg-surface p-6 sm:p-8 text-center elev-1">
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

      {/* Product Preview: Desktop Main Window with Signature Live Meter */}
      <div className="w-full text-left">
        <div className="mb-3 flex items-center justify-between px-1">
          <span className="heading-face text-sm font-semibold text-heading">
            Desktop Application Preview
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted font-mono">
            <span className="ol-live-pulse-dot" aria-hidden="true" />
            <span>Local Native Engine</span>
          </span>
        </div>

        <div className="elev-2 overflow-hidden rounded-2xl border border-hairline bg-frame">
          {/* Desktop Titlebar Chrome */}
          <div className="flex items-center justify-between border-b border-hairline bg-raised/70 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-[#FF5F57]/90" aria-hidden="true" />
              <span className="h-3 w-3 rounded-full bg-[#FEBC2E]/90" aria-hidden="true" />
              <span className="h-3 w-3 rounded-full bg-[#28C840]/90" aria-hidden="true" />
            </div>
            <span className="heading-face text-xs font-semibold text-muted tracking-tight">
              OpenLimiter Desktop
            </span>
            <div className="flex items-center gap-2 font-mono text-2xs text-heading">
              <span className="ol-live-pulse-dot" aria-hidden="true" />
              <span>Live Meter</span>
            </div>
          </div>

          {/* Window Body: Live Meter & Provider Headroom Summary */}
          <div className="p-5 sm:p-7 space-y-6 bg-surface">
            {/* Embedded Live Meter */}
            <div className="rounded-xl border border-hairline bg-raised/40 p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-hairline">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface border border-hairline">
                    <span className="ol-live-pulse-dot" aria-hidden="true" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <strong className="heading-face text-sm font-semibold text-heading">
                        Google Antigravity
                      </strong>
                    </div>
                    <p className="text-xs text-muted">Gemini 2.5 Pro (5h pool)</p>
                  </div>
                </div>

                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold font-mono tracking-wider"
                  style={{
                    backgroundColor: "var(--ol-band-red-subtle)",
                    color: "var(--ol-band-red-label)",
                    border: "1px solid var(--ol-band-red-fill)",
                  }}
                >
                  <OctagonExclamationIcon className="h-3.5 w-3.5 flex-none" />
                  <span>96% USED</span>
                </div>
              </div>

              {/* Dual Ring + Progress Bar */}
              <div className="pt-4 flex flex-col sm:flex-row items-center gap-5">
                <div className="relative flex-none flex items-center justify-center">
                  <svg className="h-16 w-16 -rotate-90 transform" viewBox="0 0 72 72" aria-hidden="true">
                    <circle cx="36" cy="36" r={radius} stroke="var(--ol-track)" strokeWidth="5.5" fill="none" />
                    <circle
                      cx="36"
                      cy="36"
                      r={radius}
                      stroke="var(--ol-band-red-fill)"
                      strokeWidth="5.5"
                      strokeDasharray={circumference}
                      strokeDashoffset={strokeDashoffset}
                      strokeLinecap="round"
                      fill="none"
                      className="ol-ring-progress"
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="font-mono text-xs font-bold" style={{ color: "var(--ol-band-red-label)" }}>
                      96%
                    </span>
                  </div>
                </div>

                <div className="flex-1 w-full flex flex-col gap-2">
                  <div className="relative w-full h-3.5 rounded-full bg-track overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: "96%",
                        backgroundColor: "var(--ol-band-red-fill)",
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted font-mono tabular-nums">
                    <span>96% Used (4% Headroom)</span>
                    <span className="flex items-center gap-1.5 font-medium text-heading">
                      <ClockGlyph className="h-3.5 w-3.5 text-muted flex-none" />
                      <span>Resets in {formatCountdown(countdownSec)}</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Provider Grid Snippet */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
              <div className="rounded-lg border border-hairline bg-raised/30 p-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-sans font-medium text-heading">Claude Code</span>
                  <span className="font-semibold" style={{ color: "var(--ol-band-green-label)" }}>24%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-track overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: "24%", backgroundColor: "var(--ol-band-green-fill)" }} />
                </div>
                <span className="text-2xs text-muted">Normal Headroom</span>
              </div>

              <div className="rounded-lg border border-hairline bg-raised/30 p-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-sans font-medium text-heading">OpenAI Codex</span>
                  <span className="font-semibold" style={{ color: "var(--ol-band-yellow-label)" }}>68%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-track overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: "68%", backgroundColor: "var(--ol-band-yellow-fill)" }} />
                </div>
                <span className="text-2xs text-muted">Watch Threshold</span>
              </div>

              <div className="rounded-lg border border-hairline bg-raised/30 p-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-sans font-medium text-heading">OpenCode</span>
                  <span className="font-semibold" style={{ color: "var(--ol-band-stale-label)" }}>STALE</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-track overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: "100%", background: "var(--ol-meter-hatched-pattern)" }} />
                </div>
                <span className="text-2xs text-muted">Hatched Stale State</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
