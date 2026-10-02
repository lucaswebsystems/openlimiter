/*
 * The one place a code or a catalog key becomes words.
 *
 * Rust, the cache and the status line spell providers and meters as upper case
 * codes (CLAUDE, SEVEN_DAY_FABLE); older writers and the registry spell them in
 * lower case with hyphens. Every surface in this window asks here, so a code
 * never reaches the screen, a tooltip or an aria label, and "Unknown" is never
 * the answer: an unfamiliar code is read out of its own parts instead.
 */
import { PROVIDER_SPECS } from "./provider-specs.generated.js";
import catalog from "./readings.en.json" with { type: "json" };
import {
  claudeMeterLabel,
  claudeMeterRank,
} from "../../../packages/core/dist/provider-presentation.js";

/** The words Home, the edge panel and Needs attention say, in English. */
export const READINGS_COPY = Object.freeze(catalog);

/** One sentence from the catalog with its values filled in. */
export function say(key, values = {}) {
  return (READINGS_COPY[key] ?? "").replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ""));
}

/** "Updated 3 min ago" for one observation instant, at `now`. */
export function updatedLabel(instant, now) {
  const at = Date.parse(instant ?? "");
  if (!Number.isFinite(at)) return say("noReading");
  const minutes = Math.floor((Date.parse(now) - at) / 60_000);
  if (minutes < 1) return say("updatedJustNow");
  if (minutes < 60) return say("updatedMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? say("updatedHours", { count: hours }) : say("updatedDays", { count: Math.floor(hours / 24) });
}

/** "4d 14h", "1h 55m", "12m": a span of time, never below a minute. */
export function duration(seconds) {
  const minutes = Math.max(1, Math.floor(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Any spelling of a code, as upper case words joined by underscores. */
export function providerCode(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[\s-]+/gu, "_");
}

/* Registry rows by provider code. The directory names the connector each code
   comes from; manual entry is the one product with no directory row. */
const SPECS = new Map(PROVIDER_SPECS.providers.flatMap((spec) => {
  const key = spec.directory?.connectorId ?? (spec.providerId === "openlimiter" ? spec.productId : null);
  return key ? [[providerCode(key), spec]] : [];
}));

/* Words that keep their own capitals when a code is read out. */
const PROPER = new Map([["OAUTH", "OAuth"], ["API", "API"], ["CLI", "CLI"], ["AI", "AI"]]);

/** SEVEN_DAY_HAIKU_4_5 style parts as words; numbers that follow each other join with a point. */
function words(code, title) {
  const parts = providerCode(code).split("_").filter(Boolean);
  const out = [];
  for (const part of parts) {
    const previous = out.at(-1);
    if (/^\d+$/u.test(part) && /\d$/u.test(previous ?? "")) out[out.length - 1] = `${previous}.${part}`;
    else out.push(part);
  }
  return out.map((part, index) => PROPER.get(part) ??
    (title || index === 0 ? part.charAt(0) + part.slice(1).toLowerCase() : part.toLowerCase())).join(" ");
}

/** How a provider is read: "automatic" (its own sign in on this computer),
    "key" (a key a person pasted) or "manual" (numbers a person entered). */
export function providerAccess(value) {
  const code = providerCode(value);
  return SPECS.get(code)?.directory?.access ?? (code === "MANUAL" ? "manual" : "automatic");
}

/** The name the registry's directory gives a provider (the one Connections
    lists), its display name, or the code read out as words. */
export function providerName(value) {
  const code = providerCode(value);
  const spec = SPECS.get(code);
  return spec?.directory?.label ?? spec?.displayName ?? words(code, true);
}

/* The names a person already uses for these windows. */
const METERS = Object.freeze({
  FIVE_HOUR: "5 hour", SEVEN_DAY: "Weekly", FIVE_MINUTE: "5 minute", HOURLY: "Hourly",
  DAILY: "Daily", ONE_DAY: "Daily", WEEKLY: "Weekly", THIRTY_DAY: "Monthly", MONTHLY: "Monthly",
  SESSION: "Session", EXTRA_USAGE: "Extra usage", CREDITS: "Credits", BALANCE: "Balance",
});

/* Words a code may never be read out as, and parts that look like an id: a
   long run of hex with digits in it, or any part longer than a word. */
const RESERVED = new Set(["UNKNOWN", "UNDEFINED", "NULL", "NONE", "NAN"]);
const identityShaped = (part) => part.length > 16 || (/^[0-9A-F]{8,}$/u.test(part) && /\d/u.test(part));

/**
 * A meter code as a label. The two windows every tool shares come first, then
 * a model's own weekly pool, then the label the reviewed
 * registry gives that provider's meter, then the code read out as words. A
 * code built on a reserved word or an id reads as the neutral "Limit".
 */
export function meterLabel(code, provider) {
  const meter = providerCode(code);
  if (meter.split("_").some((part) => RESERVED.has(part) || identityShaped(part))) return say("meterFallback");
  if (providerCode(provider) === "CLAUDE") {
    const claude = claudeMeterLabel(meter, READINGS_COPY);
    if (claude !== null) return claude;
  }
  if (meter === "FIVE_HOUR" || meter === "SEVEN_DAY") return METERS[meter];
  const numbered = meter.match(/^(FIVE_HOUR|SEVEN_DAY)_([2-9]\d*)$/u);
  if (numbered) return `${METERS[numbered[1]]} ${numbered[2]}`;
  if (meter.startsWith("SEVEN_DAY_")) return `${words(meter.slice("SEVEN_DAY_".length), true)} weekly`;
  const registered = SPECS.get(providerCode(provider))?.meters?.find((entry) => entry.meterCode === meter)?.label;
  return registered ?? METERS[meter] ?? (words(meter, false) || "Usage");
}

/** Claude's provider order, or null when another provider owns the meter. */
export function meterRank(code, provider) {
  return providerCode(provider) === "CLAUDE"
    ? claudeMeterRank(providerCode(code)) ?? 90
    : null;
}

/* Agents report the tool they run in; Claude's agent is Claude Code. */
const AGENT_PROVIDERS = Object.freeze({ claude_code: "CLAUDE" });

/** An agent's tool name, or null for an agent this build cannot name. */
export function agentName(agent) {
  const key = String(agent ?? "");
  if (!key || key === "unknown") return null;
  return providerName(AGENT_PROVIDERS[key] ?? key);
}

/** The provider code an agent runs under, for its mark. */
export function agentProvider(agent) {
  return providerCode(AGENT_PROVIDERS[String(agent ?? "")] ?? agent);
}
