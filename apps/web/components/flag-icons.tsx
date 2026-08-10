import type { ComponentType } from "react";
import type { Locale } from "@/i18n/locales";

export interface FlagIconProps {
  className?: string;
}

const baseClassName =
  "h-3.5 w-5 shrink-0 overflow-hidden rounded-[2px] border border-hairline";

function flagClassName(className: string | undefined): string {
  return className === undefined ? baseClassName : `${baseClassName} ${className}`;
}

export function UnitedStatesFlag({ className }: FlagIconProps) {
  return (
    <svg
      viewBox="0 0 20 14"
      className={flagClassName(className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="20" height="14" fill="#fff" />
      <path d="M0 0h20v2H0zm0 4h20v2H0zm0 4h20v2H0zm0 4h20v2H0z" fill="#B22234" />
      <rect width="8" height="8" fill="#3C3B6E" />
    </svg>
  );
}

export function BrazilFlag({ className }: FlagIconProps) {
  return (
    <svg
      viewBox="0 0 20 14"
      className={flagClassName(className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="20" height="14" fill="#009C3B" />
      <path d="M10 2 18 7l-8 5-8-5z" fill="#FFDF00" />
      <circle cx="10" cy="7" r="2.75" fill="#002776" />
    </svg>
  );
}

export function SpainFlag({ className }: FlagIconProps) {
  return (
    <svg
      viewBox="0 0 20 14"
      className={flagClassName(className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="20" height="14" fill="#AA151B" />
      <rect y="3.5" width="20" height="7" fill="#F1BF00" />
    </svg>
  );
}

export function GermanyFlag({ className }: FlagIconProps) {
  return (
    <svg
      viewBox="0 0 20 14"
      className={flagClassName(className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="20" height="14" fill="#000" />
      <rect y="4.67" width="20" height="4.67" fill="#DD0000" />
      <rect y="9.34" width="20" height="4.66" fill="#FFCE00" />
    </svg>
  );
}

export function JapanFlag({ className }: FlagIconProps) {
  return (
    <svg
      viewBox="0 0 20 14"
      className={flagClassName(className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="20" height="14" fill="#fff" />
      <circle cx="10" cy="7" r="3.4" fill="#BC002D" />
    </svg>
  );
}

export const LOCALE_FLAG_ICONS: Record<Locale, ComponentType<FlagIconProps>> = {
  en: UnitedStatesFlag,
  "pt-BR": BrazilFlag,
  es: SpainFlag,
  de: GermanyFlag,
  ja: JapanFlag,
};
