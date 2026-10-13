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

const BALANCE_PROVIDERS = new Set(["moonshot", "deepseek"]);

const MAX_SOURCES = 64;

export async function readApiSpend(stateDirectory: string): Promise<unknown> {
  const result = await readJsonFileSafely(path.join(stateDirectory, API_SPEND_FILE_NAME)).catch(() => null);
  return result?.ok === true ? result.value : undefined;
}

export interface MoneyCell {
  /** The cell without colour: a stale amount keeps its tilde here. */
  readonly plain: string;
  /** Band value for the shared colour rule, or null when the cell stays uncoloured. */
  readonly band: number | null;
  readonly prefix: string;
  /** The amount alone, never marked: with colour a stale amount is grey instead. */
  readonly amount: string;
  /** Past its freshness: grey with colour, a tilde without (hotfix 2.1.5 fix 8). */
  readonly stale: boolean;
}

export interface MoneyOptions {
  readonly now: string;
  /** Whether a provider name may be drawn. */
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
  for (const source of (document["sources"] as unknown[]).slice(0, MAX_SOURCES)) {
    if (!isRecord(source) || source["enabled"] !== true || typeof source["id"] !== "string") continue;
    const provider = source["provider"];
    if (typeof provider !== "string" || !options.allowed(provider)) continue;
    const sample = newest.get(source["id"]);
    if (sample === undefined) continue;
    // OpenRouter monthly spend is not the account's remaining credit balance.
    if (provider === "openrouter") continue;
    const tag = MONEY_TAGS[provider];
    if (tag === undefined) continue;
    const stale = freshnessPolicy({
      sourceClass: "internal_payload", observedAt: String(sample["observedAt"]), now: options.now, writer: "desktop"
    }).availability === "stale";
    const prefix = tag + " ";
    const cell = (amount: string, band: number | null): MoneyCell =>
      ({ plain: prefix + (stale ? "~" : "") + amount, prefix, amount, band, stale });
    const usd = sample["currencySource"] === "provider_usd";
    /* Moonshot's available_balance and DeepSeek's balance are current balances,
       never spend for the current month. */
    if (BALANCE_PROVIDERS.has(provider)) {
      const balance = decimal(sample["balanceUsd"]);
      const tooLow = source["status"] === "too_low_for_api_calls";
      if (usd && balance !== null) {
        cells.push(cell(money(balance), tooLow ? 95 : balanceBand(balance)));
      } else if (provider === "deepseek" && sample["currencySource"] === "provider_cny" &&
          sample["balanceUsd"] == null && sample["spendUsd"] == null) {
        // Yuan is never converted, so the cell says the currency and no amount.
        cells.push(cell("CNY", null));
      }
      continue;
    }
    const spend = decimal(sample["spendUsd"]);
    // A spend from an earlier month is not this month's spend, so it is not shown.
    if (!usd || spend === null || sample["month"] !== month) continue;
    cells.push(cell(money(spend), budgetBand(spend, source["budgetUsd"])));
  }
  return cells;
}
