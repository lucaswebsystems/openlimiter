import path from "node:path";
import { freshnessPolicy, readJsonFileSafely } from "@openlimiter/core";

/**
 * API money for the terminal status line.
 *
 * The desktop app polls provider spend and balances and persists them to
 * `api-spend-v1.json` in the state directory, the same folder the CLI already
 * resolves for the quota cache on every OS. This module only reads that file,
 * once, with no network. Anything unexpected draws nothing: a status row runs
 * inside somebody else's tool and must never fail over a money cell.
 */

export const API_SPEND_FILE_NAME = "api-spend-v1.json";

/** Money providers the desktop app saves, with the short tag the row uses. */
export const MONEY_TAGS: Readonly<Record<string, string>> = {
  openai: "oa",
  anthropic: "an",
  xai: "xa",
  moonshot: "ms",
  deepseek: "ds"
};

const MAX_SOURCES = 64;

export async function readApiSpend(stateDirectory: string): Promise<unknown> {
  const result = await readJsonFileSafely(path.join(stateDirectory, API_SPEND_FILE_NAME)).catch(() => null);
  return result?.ok === true ? result.value : undefined;
}

export interface MoneyCell {
  readonly plain: string;
  /** Band value for the shared colour rule, or null when the cell stays uncoloured. */
  readonly band: number | null;
  readonly prefix: string;
  readonly amount: string;
}

export interface MoneyOptions {
  readonly now: string;
  /** The quota cache already drew an `or` cell, so the file adds none. */
  readonly hasOpenRouter: boolean;
  /** Whether a provider name (`openai`, `openrouter`...) may be drawn. */
  readonly allowed: (provider: string) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const money = (value: number): string => "$" + value.toFixed(2);

/** Lower is worse: yellow under $5, red under $1, as the `or` balance cell. */
const balanceBand = (value: number): number => value < 1 ? 95 : value < 5 ? 65 : 0;

/** The band rule's percent of budget; an uncoloured cell has no budget to measure. */
function budgetBand(spend: number, budget: unknown): number | null {
  const limit = decimal(budget);
  return limit !== null && limit > 0 ? spend / limit * 100 : null;
}

export function moneyCells(document: unknown, options: MoneyOptions): readonly MoneyCell[] {
  if (!isRecord(document) || !Array.isArray(document["sources"]) || !Array.isArray(document["samples"])) return [];
  const month = options.now.slice(0, 7) + "-01";
  const newest = new Map<string, Record<string, unknown>>();
  for (const sample of document["samples"] as unknown[]) {
    if (!isRecord(sample) || typeof sample["sourceId"] !== "string") continue;
    const observed = Date.parse(String(sample["observedAt"]));
    if (!Number.isFinite(observed)) continue;
    const held = newest.get(sample["sourceId"]);
    const heldAt = held === undefined ? -Infinity : Date.parse(String(held["observedAt"]));
    if (observed > heldAt || observed === heldAt && Number(sample["sequence"]) > Number(held?.["sequence"])) {
      newest.set(sample["sourceId"], sample);
    }
  }
  const cells: MoneyCell[] = [];
  let openRouter: { cell: MoneyCell; observedAt: number } | undefined;
  for (const source of (document["sources"] as unknown[]).slice(0, MAX_SOURCES)) {
    if (!isRecord(source) || source["enabled"] !== true || typeof source["id"] !== "string") continue;
    const provider = source["provider"];
    if (typeof provider !== "string" || !options.allowed(provider)) continue;
    const sample = newest.get(source["id"]);
    if (sample === undefined) continue;
    const tag = provider === "openrouter" ? "or" : MONEY_TAGS[provider];
    if (tag === undefined || provider === "openrouter" && options.hasOpenRouter) continue;
    const stale = freshnessPolicy({
      sourceClass: "internal_payload", observedAt: String(sample["observedAt"]), now: options.now, writer: "desktop"
    }).availability === "stale";
    const prefix = tag + " ";
    const mark = stale ? "~" : "";
    const usd = sample["currencySource"] === "provider_usd";
    if (provider === "moonshot" || provider === "deepseek") {
      const balance = decimal(sample["balanceUsd"]);
      const tooLow = source["status"] === "too_low_for_api_calls";
      if (usd && balance !== null) {
        const amount = mark + money(balance);
        cells.push({ plain: prefix + amount, prefix, amount, band: tooLow ? 95 : balanceBand(balance) });
      } else if (provider === "deepseek" && sample["currencySource"] === "provider_cny" &&
          sample["balanceUsd"] == null && sample["spendUsd"] == null) {
        // Yuan is never converted, so the cell says the currency and no amount.
        const amount = mark + "CNY";
        cells.push({ plain: prefix + amount, prefix, amount, band: null });
      }
      continue;
    }
    const spend = decimal(sample["spendUsd"]);
    // A spend from an earlier month is not this month's spend, so it is not shown.
    if (!usd || spend === null || sample["month"] !== month) continue;
    const amount = mark + money(spend);
    const suffix = provider === "openrouter" ? " spent" : "";
    const cell = { plain: prefix + amount + suffix, prefix, amount: amount + suffix, band: budgetBand(spend, source["budgetUsd"]) };
    if (provider === "openrouter") {
      // One `or` cell at most: the most recently observed source wins, the first on a tie.
      const observedAt = Date.parse(String(sample["observedAt"]));
      if (openRouter !== undefined && observedAt <= openRouter.observedAt) continue;
      openRouter = { cell, observedAt };
    }
    cells.push(cell);
  }
  return cells.filter(cell => cell.prefix !== "or " || cell === openRouter?.cell);
}
