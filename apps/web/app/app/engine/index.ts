import {
  PROVIDER_CODES,
  buildAdvice,
  floorFixed,
  freshness,
  mergeSnapshots,
  normalizeMeters,
  type Advice,
  type ProviderCode,
  type RawMeter,
  type Snapshot,
  type SnapshotState,
} from "./generated/core";
import {
  antigravityFixture,
  claudeFixture,
  codexFixture,
  manualFixture,
  opencodeFixture,
  openrouterFixture,
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseManualPayload,
  parseOpencodePayload,
  parseOpenrouterPayload,
} from "./generated/connectors";
import { buildAgentContext, renderClaudeStatusline } from "./generated/adapters/claude-code";

/**
 * The engine, as the dashboard uses it.
 *
 * Every rule applied here comes from the mirrored packages: what a valid meter
 * is, when a reading goes stale, which provider is under the most pressure,
 * and what the agent context block says. This module only decides which parser
 * to offer a pasted document to, and shapes the result for rendering.
 *
 * Nothing in this file, or anything it calls, performs a network request.
 */

export type {
  Advice,
  ProviderCode,
  Snapshot,
  SnapshotState,
};

export { PROVIDER_CODES, buildAgentContext, floorFixed, renderClaudeStatusline };

/** The parsers a pasted document is offered to, in order, with their labels. */
const PARSERS: readonly {
  label: string;
  parse: (payload: unknown, now: string) => RawMeter[] | null;
}[] = [
  { label: "Claude Code statusline payload", parse: parseClaudePayload },
  { label: "Codex payload", parse: parseCodexPayload },
  { label: "Antigravity payload", parse: parseAntigravityPayload },
  { label: "OpenCode payload", parse: parseOpencodePayload },
  { label: "OpenRouter credits payload", parse: parseOpenrouterPayload },
  { label: "manual quota document", parse: parseManualPayload },
];

export type ParseResult =
  | { ok: true; snapshots: readonly Snapshot[]; recognised: readonly string[] }
  | { ok: false; reason: "empty" | "not_json" | "no_meters" };

/**
 * Turn pasted text into snapshots.
 *
 * An array is treated as the output of `openlimiter export`, which is already
 * a list of snapshots and goes straight through the normalizer. Anything else
 * is offered to every connector parser, and every parser that recognises it
 * contributes, so one document carrying two providers produces both.
 *
 * Failure is always closed. A document nothing recognises produces no meters
 * at all, never a zero and never an exhausted provider.
 */
export function parseQuotaText(text: string, now: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  let document: unknown;
  try {
    document = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (Array.isArray(document)) {
    const snapshots = normalizeMeters(document as RawMeter[]);
    return snapshots.length === 0
      ? { ok: false, reason: "no_meters" }
      : { ok: true, snapshots, recognised: ["openlimiter export output"] };
  }
  const meters: RawMeter[] = [];
  const recognised: string[] = [];
  for (const parser of PARSERS) {
    const parsed = parser.parse(document, now);
    if (parsed === null || parsed.length === 0) continue;
    meters.push(...parsed);
    recognised.push(parser.label);
  }
  const snapshots = normalizeMeters(meters);
  return snapshots.length === 0
    ? { ok: false, reason: "no_meters" }
    : { ok: true, snapshots, recognised };
}

/** Every bundled synthetic fixture, parsed the same way a paste would be. */
export function sampleSnapshots(now: string): readonly Snapshot[] {
  return normalizeMeters([
    ...(parseClaudePayload(claudeFixture(now), now) ?? []),
    ...(parseOpenrouterPayload(openrouterFixture(), now) ?? []),
    ...(parseCodexPayload(codexFixture(now), now) ?? []),
    ...(parseAntigravityPayload(antigravityFixture(now), now) ?? []),
    ...(parseOpencodePayload(opencodeFixture(now), now) ?? []),
    ...(parseManualPayload(manualFixture(now), now) ?? []),
  ]);
}

/** Fold newly parsed snapshots into what is already on screen. */
export function combine(
  existing: readonly Snapshot[],
  incoming: readonly Snapshot[],
): Snapshot[] {
  return mergeSnapshots(existing, incoming);
}

export interface MeterView {
  meter: string;
  value: number;
  unit: string;
  state: SnapshotState;
  resetAt: string | null;
  observedAt: string;
  precision: Snapshot["precision"];
  source: Snapshot["source"];
  risk: Snapshot["labels"]["automationRisk"];
}

export interface ProviderView {
  provider: ProviderCode;
  /** Null when this provider has contributed nothing readable. */
  worst: MeterView | null;
  meters: readonly MeterView[];
}

export interface DashboardView {
  providers: readonly ProviderView[];
  advice: Advice;
  agentContext: string;
  statusline: string;
  /** Providers with no readable meter at all. Never rendered as zero. */
  unknown: readonly ProviderCode[];
}

function toMeterView(snapshot: Snapshot, now: string): MeterView {
  return {
    meter: snapshot.meter,
    value: snapshot.value,
    unit: snapshot.unit,
    state: freshness(snapshot.observedAt, snapshot.expiresAt, now),
    resetAt: snapshot.resetAt,
    observedAt: snapshot.observedAt,
    precision: snapshot.precision,
    source: snapshot.source,
    risk: snapshot.labels.automationRisk,
  };
}

/**
 * Shape the snapshots for rendering.
 *
 * One row per provider, always all six, so a provider with nothing to say is
 * visibly unknown rather than quietly missing. Within a provider the meter
 * under the most pressure leads, which is the same choice the advice engine
 * makes when it decides what to tell an agent.
 */
export function dashboardView(
  snapshots: readonly Snapshot[],
  now: string,
): DashboardView {
  const advice = buildAdvice(snapshots, now, PROVIDER_CODES);
  const providers = PROVIDER_CODES.map((provider) => {
    const meters = snapshots
      .filter((snapshot) => snapshot.provider === provider)
      .map((snapshot) => toMeterView(snapshot, now))
      .sort((left, right) => right.value - left.value);
    const readable = meters.filter((meter) => meter.state !== "unknown");
    return {
      provider,
      worst: readable[0] ?? null,
      meters,
    };
  });
  return {
    providers,
    advice,
    agentContext: buildAgentContext(advice),
    statusline: renderClaudeStatusline(advice),
    unknown: advice.inject ? advice.unknownProviders : PROVIDER_CODES,
  };
}
