"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { ClaudeMeterCopy } from "./language";

/** The web locale adapter for the shared Claude meter contract. */
export function useClaudeMeterCopy(): ClaudeMeterCopy {
  const t = useTranslations("hub");
  return useMemo(() => ({
    claudeCurrentSession: t("claudeCurrentSession"),
    claudeWeeklyAllModels: t("claudeWeeklyAllModels"),
    claudeWeeklyFable: t("claudeWeeklyFable"),
    claudeWeeklyModel: t("claudeWeeklyModel", { model: "{model}" }),
    claudeExtraUsage: t("claudeExtraUsage"),
  }), [t]);
}
