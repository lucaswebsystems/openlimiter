/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import contract from "./contracts/claude-presentation.json" with { type: "json" };

/**
 * Claude's meter vocabulary and sequence, shared by every product surface.
 *
 * Meter codes keep the provider supplied model scope. The visible Fable name
 * deliberately does not keep a version number because Claude presents it as
 * one included allowance while the returned model name can move from Fable 5
 * to Fable 5.1.
 */

export type ClaudeMeterLabelKey =
  | "claudeCurrentSession"
  | "claudeWeeklyAllModels"
  | "claudeWeeklyOAuthApps"
  | "claudeWeeklyFable"
  | "claudeWeeklyModel"
  | "claudeExtraUsage";

export interface ClaudeMeterPresentation {
  readonly labelKey: ClaudeMeterLabelKey;
  readonly defaultLabel: string;
  readonly compactLabel: string;
  readonly order: number;
  readonly model: string | null;
  readonly modelScoped: boolean;
}

export const CLAUDE_METER_ENGLISH: Readonly<Record<ClaudeMeterLabelKey, string>> =
  Object.freeze(contract.copy);

function contractLabelKey(value: string): ClaudeMeterLabelKey {
  if (value in CLAUDE_METER_ENGLISH) return value as ClaudeMeterLabelKey;
  throw new Error("Invalid Claude presentation label key");
}

const MODEL_WEEKLY_PREFIX = contract.modelWeekly.prefix;

function modelName(code: string): string | null {
  if (!code.startsWith(MODEL_WEEKLY_PREFIX)) return null;
  const parts = code.slice(MODEL_WEEKLY_PREFIX.length).split(/[_\s-]+/u).filter(Boolean);
  if (parts.length === 0) return null;
  const words: string[] = [];
  for (const part of parts) {
    const previous = words.at(-1);
    if (/^\d+$/u.test(part) && /\d$/u.test(previous ?? "")) {
      words[words.length - 1] = previous + "." + part;
    } else {
      const lower = part.toLowerCase();
      words.push(lower === "oauth" || lower === "api"
        ? lower.toUpperCase().replace("OAUTH", "OAuth")
        : lower.charAt(0).toUpperCase() + lower.slice(1));
    }
  }
  const model = words.join(" ");
  const family = contract.modelWeekly.families.find((candidate) =>
    model === candidate || model.startsWith(candidate + " "));
  return family === undefined ? null : model;
}

function labelOf(
  key: ClaudeMeterLabelKey,
  model: string | null,
  copy: Partial<Record<ClaudeMeterLabelKey, string>> = {},
): string {
  const template = copy[key] ?? CLAUDE_METER_ENGLISH[key];
  return template.replaceAll("{model}", model ?? "");
}

function compactModelLabel(model: string, familyCodes: readonly string[]): string {
  const familyModels = new Set(
    familyCodes
      .map((code) => modelName(code.toUpperCase()))
      .filter((candidate): candidate is string => candidate !== null)
      .filter((candidate) => candidate.startsWith(contract.modelWeekly.fablePrefix)),
  );
  if (familyModels.size <= 1) return "fable7d";
  return model.toLowerCase().split(" ")[0]! + "7d";
}

export function isClaudeModelScopedMeter(code: string): boolean {
  return modelName(code.toUpperCase()) !== null;
}

export function claudeMeterPresentation(
  code: string,
  familyCodes: readonly string[] = [],
): ClaudeMeterPresentation | null {
  const meter = code.toUpperCase();
  if (contract.fixed.session.meters.includes(meter)) {
    return {
      labelKey: contractLabelKey(contract.fixed.session.labelKey),
      defaultLabel: CLAUDE_METER_ENGLISH.claudeCurrentSession,
      compactLabel: contract.fixed.session.compactLabel,
      order: contract.fixed.session.order,
      model: null,
      modelScoped: false,
    };
  }
  if (contract.fixed.weekly.meters.includes(meter)) {
    return {
      labelKey: contractLabelKey(contract.fixed.weekly.labelKey),
      defaultLabel: CLAUDE_METER_ENGLISH.claudeWeeklyAllModels,
      compactLabel: contract.fixed.weekly.compactLabel,
      order: contract.fixed.weekly.order,
      model: null,
      modelScoped: false,
    };
  }
  if (contract.fixed.oauthApps.meters.includes(meter)) {
    return {
      labelKey: contractLabelKey(contract.fixed.oauthApps.labelKey),
      defaultLabel: CLAUDE_METER_ENGLISH.claudeWeeklyOAuthApps,
      compactLabel: contract.fixed.oauthApps.compactLabel,
      order: contract.fixed.oauthApps.order,
      model: null,
      modelScoped: false,
    };
  }
  const model = modelName(meter);
  if (model !== null) {
    const fable = model === contract.modelWeekly.fablePrefix ||
      model.startsWith(contract.modelWeekly.fablePrefix + " ");
    const order = fable
      ? contract.modelWeekly.fableOrder
      : model === "Opus"
      ? contract.modelWeekly.opusOrder
      : model === "Sonnet"
      ? contract.modelWeekly.sonnetOrder
      : contract.modelWeekly.otherOrder;
    const key = contractLabelKey(fable
      ? contract.modelWeekly.fableLabelKey
      : contract.modelWeekly.labelKey);
    return {
      labelKey: key,
      defaultLabel: labelOf(key, model),
      compactLabel: fable
        ? compactModelLabel(model, familyCodes)
        : model.toLowerCase().split(" ")[0]! + contract.modelWeekly.modelCompactSuffix,
      order,
      model,
      modelScoped: true,
    };
  }
  if (contract.fixed.extra.meters.includes(meter)) {
    return {
      labelKey: contractLabelKey(contract.fixed.extra.labelKey),
      defaultLabel: CLAUDE_METER_ENGLISH.claudeExtraUsage,
      compactLabel: contract.fixed.extra.compactLabel,
      order: contract.fixed.extra.order,
      model: null,
      modelScoped: false,
    };
  }
  return null;
}

export function claudeMeterLabel(
  code: string,
  copy: Partial<Record<ClaudeMeterLabelKey, string>> = {},
): string | null {
  const presentation = claudeMeterPresentation(code);
  return presentation === null
    ? null
    : labelOf(presentation.labelKey, presentation.model, copy);
}

export function claudeMeterRank(code: string): number | null {
  return claudeMeterPresentation(code)?.order ?? null;
}

export function claudeMeterCompactLabel(code: string): string | null {
  return claudeMeterPresentation(code)?.compactLabel ?? null;
}

export type AntigravityMeterLabelKey =
  | "antigravityFiveHourQuota"
  | "antigravityWeeklyQuota"
  | "antigravityThirdPartySession"
  | "antigravityThirdPartyWeekly";

export interface AntigravityMeterPresentation {
  readonly labelKey: AntigravityMeterLabelKey;
  readonly defaultLabel: string;
  readonly compactLabel: string;
  readonly order: number;
}

const ANTIGRAVITY_PRESENTATION: Readonly<Record<string, AntigravityMeterPresentation>> = Object.freeze({
  FIVE_HOUR: { labelKey: "antigravityFiveHourQuota", defaultLabel: "5 hour quota", compactLabel: "5h", order: 10 },
  SEVEN_DAY: { labelKey: "antigravityWeeklyQuota", defaultLabel: "Weekly quota", compactLabel: "7d", order: 20 },
  THIRD_PARTY_SESSION: { labelKey: "antigravityThirdPartySession", defaultLabel: "Third party 5 hour quota", compactLabel: "3p5h", order: 30 },
  THIRD_PARTY_WEEKLY: { labelKey: "antigravityThirdPartyWeekly", defaultLabel: "Third party weekly quota", compactLabel: "3p7d", order: 40 }
});

export function antigravityMeterPresentation(code: string): AntigravityMeterPresentation | null {
  return ANTIGRAVITY_PRESENTATION[code.toUpperCase()] ?? null;
}

export function antigravityMeterLabel(code: string): string | null {
  return antigravityMeterPresentation(code)?.defaultLabel ?? null;
}

export function antigravityMeterRank(code: string): number | null {
  return antigravityMeterPresentation(code)?.order ?? null;
}

export function antigravityMeterCompactLabel(code: string): string | null {
  return antigravityMeterPresentation(code)?.compactLabel ?? null;
}

export type ProviderMeterValueSemantics = "used" | "balance";

export type ProviderMeterLabelKey =
  | ClaudeMeterLabelKey
  | AntigravityMeterLabelKey
  | "codexMonthlyCreditLimit"
  | "codexCredits"
  | "openrouterKeyAllowance"
  | "openrouterAccountBalance"
  | "kimiWeeklyUsed"
  | "kimiFiveHourUsed"
  | "kimiFiveMinuteUsed"
  | "kimiDailyUsed"
  | "kimiSevenDayUsed"
  | "kimiUsageUsed"
  | "opencodeFiveHourPage"
  | "opencodeWeeklyPage"
  | "opencodeMonthlyPage"
  | "cursorLegacyHidden";

export interface ProviderMeterPresentation {
  readonly labelKey: ProviderMeterLabelKey;
  readonly defaultLabel: string;
  readonly compactLabel: string;
  readonly order: number;
  readonly valueSemantics: ProviderMeterValueSemantics;
  readonly visible: boolean;
  readonly displayAvailability: boolean;
}

const presentation = (
  labelKey: ProviderMeterLabelKey,
  defaultLabel: string,
  compactLabel: string,
  order: number,
  valueSemantics: ProviderMeterValueSemantics = "used",
  visible = true,
  displayAvailability = false,
): ProviderMeterPresentation => ({
  labelKey,
  defaultLabel,
  compactLabel,
  order,
  valueSemantics,
  visible,
  displayAvailability,
});

const FIXED_PRESENTATION: Readonly<Record<string, ProviderMeterPresentation>> = Object.freeze({
  "CODEX:MONTHLY_CREDIT_LIMIT": presentation(
    "codexMonthlyCreditLimit", "Monthly credit limit", "Monthly", 40,
  ),
  "CODEX:CREDITS": presentation("codexCredits", "Credits", "Credits", 100, "balance", true, true),
  "OPENROUTER:KEY_LIMIT": presentation(
    "openrouterKeyAllowance", "Key allowance", "key", 10, "used", true, true,
  ),
  "OPENROUTER:ACCOUNT_BALANCE": presentation(
    "openrouterAccountBalance", "Account balance", "Balance", 100, "balance", true, true,
  ),
  "KIMI:WEEKLY": presentation("kimiWeeklyUsed", "Weekly limit", "Weekly used", 10),
  "KIMI:FIVE_HOUR": presentation("kimiFiveHourUsed", "5 hour limit", "5h used", 20),
  "KIMI:FIVE_MINUTE": presentation("kimiFiveMinuteUsed", "5 minute limit", "5m used", 24),
  "KIMI:DAILY": presentation("kimiDailyUsed", "Daily limit", "1d used", 25),
  "KIMI:SEVEN_DAY": presentation("kimiSevenDayUsed", "7 day limit", "7d used", 30),
  "OPENCODE:FIVE_HOUR": presentation(
    "opencodeFiveHourPage", "5 hour limit, from the OpenCode page", "Page 5h", 10,
  ),
  "OPENCODE:SEVEN_DAY": presentation(
    "opencodeWeeklyPage", "Weekly limit, from the OpenCode page", "Page 7d", 20,
  ),
  "OPENCODE:MONTHLY": presentation(
    "opencodeMonthlyPage", "Monthly limit, from the OpenCode page", "Page month", 30,
  ),
  "CURSOR:AUTO": presentation("cursorLegacyHidden", "", "", 90, "used", false),
  "CURSOR:API": presentation("cursorLegacyHidden", "", "", 90, "used", false),
  "CURSOR:INCLUDED": presentation("cursorLegacyHidden", "", "", 90, "used", false),
});

function claudeProviderPresentation(
  code: string,
  familyCodes: readonly string[] = [],
): ProviderMeterPresentation | null {
  const found = claudeMeterPresentation(code, familyCodes);
  if (found === null) return null;
  return presentation(
    found.labelKey,
    found.defaultLabel,
    found.compactLabel,
    found.order,
  );
}

function antigravityProviderPresentation(code: string): ProviderMeterPresentation | null {
  const found = antigravityMeterPresentation(code);
  if (found === null) return null;
  return presentation(
    found.labelKey,
    found.defaultLabel,
    found.compactLabel,
    found.order,
  );
}

/** Presentation metadata for the meter identities whose provider wording matters. */
export function providerMeterPresentation(
  provider: string,
  code: string,
  familyCodes: readonly string[] = [],
): ProviderMeterPresentation | null {
  const normalizedProvider = provider.toUpperCase();
  const meter = code.toUpperCase();
  if (normalizedProvider === "CLAUDE") return claudeProviderPresentation(meter, familyCodes);
  if (normalizedProvider === "ANTIGRAVITY") return antigravityProviderPresentation(meter);
  const fixed = FIXED_PRESENTATION[normalizedProvider + ":" + meter];
  if (fixed !== undefined) return fixed;
  if (normalizedProvider === "KIMI") {
    const repeated = meter.match(/^(WEEKLY|FIVE_HOUR|FIVE_MINUTE|DAILY|SEVEN_DAY)_([1-9]\d*)$/u);
    if (repeated !== null) {
      const base = FIXED_PRESENTATION["KIMI:" + repeated[1]];
      const ordinal = Number(repeated[2]);
      if (base !== undefined && Number.isSafeInteger(ordinal) && ordinal >= 2) {
        return {
          ...base,
          defaultLabel: base.defaultLabel + " " + String(ordinal),
          compactLabel: base.compactLabel + " " + String(ordinal),
          order: base.order + ordinal - 1,
        };
      }
    }
    const dynamic = meter.match(/^WINDOW_([1-9]\d*)(?:_([1-9]\d*))?$/u);
    if (dynamic !== null) {
      const seconds = Number(dynamic[1]);
      const ordinal = dynamic[2] === undefined ? 1 : Number(dynamic[2]);
      if (Number.isSafeInteger(seconds) && Number.isSafeInteger(ordinal) && ordinal >= 1) {
        const unit = seconds % 86_400 === 0
          ? { count: seconds / 86_400, name: "day", compact: "d" }
          : seconds % 3_600 === 0
          ? { count: seconds / 3_600, name: "hour", compact: "h" }
          : seconds % 60 === 0
          ? { count: seconds / 60, name: "minute", compact: "m" }
          : { count: seconds, name: "second", compact: "s" };
        const suffix = ordinal === 1 ? "" : " " + String(ordinal);
        return presentation(
          "kimiUsageUsed",
          String(unit.count) + " " + unit.name + " limit" + suffix,
          String(unit.count) + unit.compact + " used" + suffix,
          40 + ordinal - 1,
        );
      }
    }
    return presentation("kimiUsageUsed", "Usage limit", "Used", 40);
  }
  return null;
}

export function providerMeterLabel(
  provider: string,
  code: string,
  copy: Partial<Record<ProviderMeterLabelKey, string>> = {},
): string | null {
  if (provider.toUpperCase() === "CLAUDE") {
    return claudeMeterLabel(
      code,
      copy as Partial<Record<ClaudeMeterLabelKey, string>>,
    );
  }
  const found = providerMeterPresentation(provider, code);
  if (found === null) return null;
  const localized = copy[found.labelKey];
  const repeated = provider.toUpperCase() === "KIMI"
    ? code.toUpperCase().match(/^(?:WEEKLY|FIVE_HOUR|FIVE_MINUTE|DAILY|SEVEN_DAY)_([1-9]\d*)$/u)
    : null;
  const dynamic = provider.toUpperCase() === "KIMI"
    ? code.toUpperCase().match(/^WINDOW_[1-9]\d*(?:_([1-9]\d*))?$/u)
    : null;
  if (localized === undefined) return found.defaultLabel;
  if (repeated !== null) return localized + " " + repeated[1];
  if (dynamic !== null) {
    const duration = found.compactLabel.split(" used", 1)[0];
    const ordinal = dynamic[1] === undefined ? "" : " " + dynamic[1];
    return localized + " (" + duration + ")" + ordinal;
  }
  return localized;
}

export function providerMeterRank(provider: string, code: string): number | null {
  return providerMeterPresentation(provider, code)?.order ?? null;
}

export function providerMeterCompactLabel(provider: string, code: string): string | null {
  return providerMeterPresentation(provider, code)?.compactLabel ?? null;
}

export function providerMeterVisible(provider: string, code: string): boolean {
  return providerMeterPresentation(provider, code)?.visible ?? true;
}
