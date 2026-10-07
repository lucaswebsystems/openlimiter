"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  applyTheme,
  isTheme,
  THEME_STORAGE_KEY,
  type ThemeChoice as Choice,
} from "@/lib/theme";

function storedChoice(): Choice {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : "system";
  } catch { return "system"; }
}

export function ThemeChoice() {
  const t = useTranslations("hub.phoneSettings.theme");
  const [choice, setChoice] = useState<Choice>("system");
  useEffect(() => setChoice(storedChoice()), []);
  return (
    <div className="ol-theme-choice" role="group" aria-label={t("label")}>
      {(["system", "light", "dark"] as const).map((value) => (
        <button
          key={value}
          type="button"
          className="focus-ring"
          data-selected={choice === value ? "" : undefined}
          aria-pressed={choice === value}
          onClick={() => {
            applyTheme(value);
            setChoice(value);
          }}
        >
          {t(value)}
        </button>
      ))}
    </div>
  );
}
