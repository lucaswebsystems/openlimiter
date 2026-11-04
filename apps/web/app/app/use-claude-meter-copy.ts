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
    claudeWeeklyOAuthApps: t("claudeWeeklyOAuthApps"),
    claudeWeeklyFable: t("claudeWeeklyFable"),
    claudeWeeklyModel: t("claudeWeeklyModel", { model: "{model}" }),
    claudeExtraUsage: t("claudeExtraUsage"),
    antigravityFiveHourQuota: t("antigravityFiveHourQuota"),
    antigravityWeeklyQuota: t("antigravityWeeklyQuota"),
    antigravityThirdPartySession: t("antigravityThirdPartySession"),
    antigravityThirdPartyWeekly: t("antigravityThirdPartyWeekly"),
    codexMonthlyCreditLimit: t("codexMonthlyCreditLimit"),
    codexCredits: t("codexCredits"),
    openrouterKeyAllowance: t("openrouterKeyAllowance"),
    openrouterAccountBalance: t("openrouterAccountBalance"),
    kimiWeeklyUsed: t("kimiWeeklyUsed"),
    kimiFiveHourUsed: t("kimiFiveHourUsed"),
    kimiFiveMinuteUsed: t("kimiFiveMinuteUsed"),
    kimiDailyUsed: t("kimiDailyUsed"),
    kimiSevenDayUsed: t("kimiSevenDayUsed"),
    kimiUsageUsed: t("kimiUsageUsed"),
    opencodeFiveHour: t("opencodeFiveHour"),
    opencodeWeekly: t("opencodeWeekly"),
    opencodeMonthly: t("opencodeMonthly"),
    hermesMonthly: t("hermesMonthly"),
    hermesBalance: t("hermesBalance"),
    commandcodeFiveHour: t("commandcodeFiveHour"),
    commandcodeWeekly: t("commandcodeWeekly"),
    commandcodeBalance: t("commandcodeBalance"),
    clineFiveHour: t("clineFiveHour"),
    clineWeekly: t("clineWeekly"),
    clineMonthly: t("clineMonthly"),
    kilocodeBalance: t("kilocodeBalance"),
  }), [t]);
}
