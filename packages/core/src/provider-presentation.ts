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
  return words.join(" ");
}

function labelOf(
  key: ClaudeMeterLabelKey,
  model: string | null,
  copy: Partial<Record<ClaudeMeterLabelKey, string>> = {},
): string {
  const template = copy[key] ?? CLAUDE_METER_ENGLISH[key];
  return template.replaceAll("{model}", model ?? "");
}

export function isClaudeModelScopedMeter(code: string): boolean {
  return modelName(code.toUpperCase()) !== null;
}

export function claudeMeterPresentation(code: string): ClaudeMeterPresentation | null {
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
      compactLabel: fable ? contract.modelWeekly.fableCompactLabel : model,
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
