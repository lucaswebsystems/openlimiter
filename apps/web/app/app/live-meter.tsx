"use client";

import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "./engine";
import { ProviderMark } from "./marks";

export interface LiveMeterProps {
  snapshots: readonly Snapshot[];
  now: string | null;
  demo?: boolean;
}

export function CheckmarkShieldIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.5 2.5 3.8v4.5c0 3.6 2.4 5.9 5.5 6.7 3.1-.8 5.5-3.1 5.5-6.7V3.8L8 1.5Z" />
      <path d="m5.5 8 1.8 1.8 3.5-3.5" />
    </svg>
  );
}

export function WarningTriangleIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2 1.5 13.5h13L8 2.2Z" />
      <path d="M8 6.5v3M8 11.5v.5" />
    </svg>
  );
}

export function AlertDiamondIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8 8 1.5Z" />
      <path d="M8 5.5v3.2M8 11v.5" />
    </svg>
  );
}

export function OctagonExclamationIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 1.5h6l3.5 3.5v6L11 14.5H5L1.5 11V5L5 1.5Z" />
      <path d="M8 5v3.8M8 11.2v.5" />
    </svg>
  );
}

export function DisconnectedCircleIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" strokeDasharray="3 3" />
      <path d="m4.5 4.5 7 7" />
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

export function getBandDetails(usedPercent: number | null, isStale: boolean) {
  if (isStale || usedPercent === null) {
    return {
      band: 5,
      name: "Stale / Unknown",
      tone: "stale" as const,
      statusLabel: "STALE",
      fillVar: "var(--ol-band-stale-fill)",
      labelVar: "var(--ol-band-stale-label)",
      subtleVar: "var(--ol-band-stale-subtle)",
      Icon: DisconnectedCircleIcon,
    };
  }
  if (usedPercent < 60) {
    return {
      band: 1,
      name: "Normal Headroom",
      tone: "ok" as const,
      statusLabel: `${Math.round(usedPercent)}% USED`,
      fillVar: "var(--ol-band-green-fill)",
      labelVar: "var(--ol-band-green-label)",
      subtleVar: "var(--ol-band-green-subtle)",
      Icon: CheckmarkShieldIcon,
    };
  }
  if (usedPercent < 80) {
    return {
      band: 2,
      name: "Watch Threshold",
      tone: "watch" as const,
      statusLabel: `${Math.round(usedPercent)}% USED`,
      fillVar: "var(--ol-band-yellow-fill)",
      labelVar: "var(--ol-band-yellow-label)",
      subtleVar: "var(--ol-band-yellow-subtle)",
      Icon: WarningTriangleIcon,
    };
  }
  if (usedPercent < 90) {
    return {
      band: 3,
      name: "High Utilization",
      tone: "high" as const,
      statusLabel: `${Math.round(usedPercent)}% USED`,
      fillVar: "var(--ol-band-orange-fill)",
      labelVar: "var(--ol-band-orange-label)",
      subtleVar: "var(--ol-band-orange-subtle)",
      Icon: AlertDiamondIcon,
    };
  }
  return {
    band: 4,
    name: "Critical Depletion",
    tone: "critical" as const,
    statusLabel: `${Math.round(usedPercent)}% USED`,
    fillVar: "var(--ol-band-red-fill)",
    labelVar: "var(--ol-band-red-label)",
    subtleVar: "var(--ol-band-red-subtle)",
    Icon: OctagonExclamationIcon,
  };
}

function formatTickingCountdown(resetAt: string | null | undefined, currentMillis: number): string {
  if (!resetAt) return "Active session";
  const target = Date.parse(resetAt);
  if (Number.isNaN(target)) return "Active session";
  const diffSec = Math.max(0, Math.floor((target - currentMillis) / 1000));
  if (diffSec <= 0) return "Window reset";

  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;

  const pad = (n: number) => n.toString().padStart(2, "0");

  if (hours > 0) {
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  return `${pad(minutes)}m ${pad(seconds)}s`;
}

export function LiveMeter({ snapshots }: LiveMeterProps) {
  const [tickerMillis, setTickerMillis] = useState<number>(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setTickerMillis(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const featuredSnapshot = useMemo(() => {
    if (snapshots.length === 0) return null;
    const withPercent = snapshots.filter(
      (s) => s.unit === "PERCENT" && typeof s.value === "number",
    );
    if (withPercent.length > 0) return withPercent[0]!;
    return snapshots[0]!;
  }, [snapshots]);

  if (featuredSnapshot === null) return null;

  const usedPercent = typeof featuredSnapshot.value === "number" ? featuredSnapshot.value : 0;
  const isStale =
    featuredSnapshot.expiresAt !== undefined &&
    Date.parse(featuredSnapshot.expiresAt) < tickerMillis;

  const bandInfo = getBandDetails(usedPercent, isStale);
  const headroomPercent = Math.max(0, Math.round(100 - usedPercent));
  const countdownText = formatTickingCountdown(featuredSnapshot.resetAt, tickerMillis);

  const providerTitle =
    featuredSnapshot.provider === "CLAUDE"
      ? "Claude Code"
      : featuredSnapshot.provider === "CODEX"
        ? "OpenAI Codex"
        : featuredSnapshot.provider === "GEMINI_CLI"
          ? "Gemini CLI"
          : featuredSnapshot.provider === "ANTIGRAVITY"
            ? "Google Antigravity"
            : featuredSnapshot.provider === "OPENCODE"
              ? "OpenCode"
              : featuredSnapshot.provider === "GROK"
                ? "xAI Grok"
                : featuredSnapshot.provider === "KIMI"
                  ? "Moonshot Kimi"
                  : featuredSnapshot.provider === "OPENROUTER"
                    ? "OpenRouter"
                    : "Session Quota";

  const windowTitle =
    featuredSnapshot.meter && featuredSnapshot.meter !== "default"
      ? featuredSnapshot.meter
      : "Live Ticking Session Window";

  /* SVG Ring properties */
  const radius = 28;
  const circumference = 2 * Math.PI * radius; // ~175.93
  const strokeDashoffset = isStale
    ? 0
    : circumference - (Math.min(100, Math.max(0, usedPercent)) / 100) * circumference;

  return (
    <section
      aria-label="Signature Live Meter"
      className="ol-live-meter-card elev-1 relative overflow-hidden rounded-2xl border border-hairline bg-surface p-5 sm:p-6"
    >
      <span aria-hidden="true" className="hairline-sheen" />

      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-hairline">
        <div className="flex items-center gap-3 min-w-0">
          <span className="ol-provider-mark flex-none" data-provider={featuredSnapshot.provider}>
            <ProviderMark provider={featuredSnapshot.provider} label={providerTitle} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="ol-live-pulse-dot" aria-hidden="true" />
              <strong className="heading-face truncate text-sm text-heading font-semibold">
                {providerTitle}
              </strong>
            </div>
            <p className="truncate text-xs text-muted mt-0.5">{windowTitle}</p>
          </div>
        </div>

        {/* Semantic Status Badge */}
        <div
          className="ol-band-badge inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold font-mono tracking-wider tabular-nums"
          style={{
            backgroundColor: bandInfo.subtleVar,
            color: bandInfo.labelVar,
            border: `1px solid ${bandInfo.fillVar}`,
          }}
        >
          <bandInfo.Icon className="h-3.5 w-3.5 flex-none" />
          <span>{bandInfo.statusLabel}</span>
        </div>
      </div>

      {/* Dual Meter Presentation: Animated Ring + Expansive Bar */}
      <div className="py-5 flex flex-col sm:flex-row items-center gap-5 sm:gap-6">
        {/* Animated Circular Ring Gauge */}
        <div className="relative flex-none flex items-center justify-center">
          <svg
            className="h-20 w-20 -rotate-90 transform"
            viewBox="0 0 72 72"
            aria-hidden="true"
          >
            {/* Background Track Circle */}
            <circle
              cx="36"
              cy="36"
              r={radius}
              stroke="var(--ol-track)"
              strokeWidth="5.5"
              fill="none"
            />
            {/* Animated Value Arc */}
            <circle
              cx="36"
              cy="36"
              r={radius}
              stroke={isStale ? "var(--ol-band-stale-fill)" : bandInfo.fillVar}
              strokeWidth="5.5"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              fill="none"
              className="ol-ring-progress"
            />
          </svg>
          {/* Centered Readout / Status Icon */}
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
            {isStale ? (
              <DisconnectedCircleIcon className="h-5 w-5 text-muted" />
            ) : (
              <span
                className="font-mono text-sm font-bold tracking-tight tabular-nums"
                style={{ color: bandInfo.labelVar }}
              >
                {Math.round(usedPercent)}%
              </span>
            )}
          </div>
        </div>

        {/* Expansive Progress Bar Track */}
        <div className="flex-1 w-full flex flex-col justify-center gap-2">
          <div
            className="ol-live-meter-bar-track relative w-full h-4 rounded-full bg-track overflow-hidden"
            data-tone={bandInfo.tone}
            data-state={isStale ? "stale" : "fresh"}
          >
            <div
              className="ol-live-meter-bar-fill h-full rounded-full"
              style={{
                width: isStale ? "100%" : `${Math.min(100, Math.max(0, usedPercent))}%`,
                background: isStale ? "var(--ol-meter-hatched-pattern)" : bandInfo.fillVar,
              }}
            />
          </div>

          {/* Dual Sub-text telemetry */}
          <div className="flex items-center justify-between gap-3 text-xs text-muted font-mono tabular-nums">
            <span>
              {isStale
                ? "Stale snapshot observation"
                : `${Math.round(usedPercent)}% Used (${headroomPercent}% Headroom Remaining)`}
            </span>
            <span className="flex items-center gap-1.5 font-medium text-heading">
              <ClockGlyph className="h-3.5 w-3.5 text-muted flex-none" />
              <span>{countdownText.startsWith("Active") || countdownText.startsWith("Window") ? countdownText : `Resets in ${countdownText}`}</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
