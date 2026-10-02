/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
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
  Object.freeze({
    claudeCurrentSession: "Current session",
    claudeWeeklyAllModels: "Weekly, all models",
    claudeWeeklyFable: "Weekly, Fable",
    claudeWeeklyModel: "Weekly, {model}",
    claudeExtraUsage: "Extra usage",
  });

const MODEL_WEEKLY_PREFIX = "SEVEN_DAY_";

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
  if (meter === "FIVE_HOUR" || meter === "SESSION") {
    return {
      labelKey: "claudeCurrentSession",
      defaultLabel: CLAUDE_METER_ENGLISH.claudeCurrentSession,
      compactLabel: "5h",
      order: 10,
      model: null,
      modelScoped: false,
    };
  }
  if (meter === "SEVEN_DAY") {
    return {
      labelKey: "claudeWeeklyAllModels",
      defaultLabel: CLAUDE_METER_ENGLISH.claudeWeeklyAllModels,
      compactLabel: "7d",
      order: 20,
      model: null,
      modelScoped: false,
    };
  }
  const model = modelName(meter);
  if (model !== null) {
    const fable = /^Fable(?:\s|$)/u.test(model);
    const order = fable ? 30 : model === "Opus" ? 40 : model === "Sonnet" ? 41 : 42;
    const key = fable ? "claudeWeeklyFable" : "claudeWeeklyModel";
    return {
      labelKey: key,
      defaultLabel: labelOf(key, model),
      compactLabel: fable ? "Fable" : model,
      order,
      model,
      modelScoped: true,
    };
  }
  if (meter === "EXTRA_USAGE") {
    return {
      labelKey: "claudeExtraUsage",
      defaultLabel: CLAUDE_METER_ENGLISH.claudeExtraUsage,
      compactLabel: "Extra",
      order: 50,
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
