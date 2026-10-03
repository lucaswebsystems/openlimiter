/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import type { Snapshot } from "./types";
import { providerMeterPresentation } from "./provider-presentation";

export const RETENTION_MILLISECONDS = 7 * 86_400_000;

/** Rust twin: data_rules::freshness_policy. Poll jitter plus bounded request latency. */
export function freshnessPolicy(input: { sourceClass: string; observedAt: string; now: string; provider?: string; writer?: string }) {
  const desktopIntervals: Readonly<Record<string, number>> = { CLAUDE: 900, GEMINI_CLI: 900, ANTIGRAVITY: 600, CODEX: 300, CURSOR: 300, GROK: 300, KIMI: 300, OPENROUTER: 300, OPENCODE: 300 };
  const interval = input.sourceClass === "native_payload" ? 60
    : input.writer === "desktop" ? desktopIntervals[input.provider ?? ""] ?? 900 : 900;
  const ttlSeconds = interval * 1.2 + 60;
  const observed = Date.parse(input.observedAt);
  const now = Date.parse(input.now);
  const deadline = observed + ttlSeconds * 1000;
  const expiresAt = Number.isFinite(deadline) ? new Date(deadline).toISOString() : input.observedAt;
  return { ttlSeconds, expiresAt, availability: !Number.isFinite(now) || !Number.isFinite(observed) || now < observed
    ? "unavailable" : now < deadline ? "fresh" : "stale" };
}

export function retainSnapshots(rows: readonly Snapshot[], now: number): Snapshot[] {
  return rows.filter(row => Date.parse(row.observedAt) >= now - RETENTION_MILLISECONDS);
}

export type FixKind = "reconnect" | "open_app" | "sign_in" | "switch_on" | "unsupported";
export interface ConnectionFlag {
  provider: Snapshot["provider"];
  accountId?: string;
  reason: string;
  fixKind: FixKind;
}

export function fixKind(reason: string): FixKind {
  if (reason === "disabled") return "switch_on";
  if (reason === "missing_credentials" || reason === "account_unresolved") return "sign_in";
  if (["expired_credentials", "stale", "rate_limited", "network_failure", "not_measured", "awaiting_statusline"].includes(reason)) return "open_app";
  if (["quota_unavailable", "unlimited", "placeholder", "schema_drift"].includes(reason)) return "unsupported";
  return "reconnect";
}

export function displayReason(row: Snapshot, now: string): string | null {
  if (row.availability !== undefined) return row.availability;
  const boundedSpend = row.usedAmount !== undefined && Number.isFinite(row.usedAmount) && row.usedAmount >= 0 &&
    row.limitAmount !== undefined && Number.isFinite(row.limitAmount) && row.limitAmount > 0 &&
    row.currency === "USD"; // spend past its cap is still a real reading
  if (row.window.kind === "unknown" && !boundedSpend || row.kind === "runtime_info" || row.meter === "ACQUISITION") return "placeholder";
  if (!Number.isFinite(row.value) || row.value < 0 || (row.unit === "PERCENT" && row.value > 100)) return "quota_unavailable";
  if (freshnessPolicy({ ...row, sourceClass: row.source, now }).availability !== "fresh") return "stale";
  return null;
}

/** A reading Claude Code handed its status line. Rust twin: data_rules::claude_statusline. */
function claudeStatusline(row: Snapshot): boolean {
  return row.provider === "CLAUDE" && row.provenance?.sourceKind === "statusline_payload" &&
    row.provenance.observedVia === "claude_code_statusline";
}

/**
 * Freshness is not visibility, for Claude status line rows only.
 *
 * Claude Code writes them only while it runs, so an idle session would lose
 * its card after two minutes. A stale row stays displayable (its age shows)
 * until its window resets; after that the honest answer is waiting for Claude
 * Code, never a number nobody measured.
 */
function heldReason(row: Snapshot, reason: string | null, now: string): string | null {
  const current = Date.parse(now);
  if (reason !== "stale" || !claudeStatusline(row) || !(Date.parse(row.observedAt) <= current)) return reason;
  return current < Date.parse(row.resetAt ?? "") ? null : "awaiting_statusline";
}

/** Active identities come from credentials or connections, never observation age. */
export function projectSnapshots(rows: readonly Snapshot[], now: string, active?: ReadonlyMap<string, ReadonlySet<string>>): { snapshots: Snapshot[]; flags: ConnectionFlag[] } {
  const snapshots: Snapshot[] = [];
  const flags = new Map<string, ConnectionFlag>();
  for (const row of rows) {
    const presentation = providerMeterPresentation(row.provider, row.meter);
    if (presentation?.visible === false) continue;
    const accounts = active?.get(row.provider);
    /* An anonymous status line row cannot be attributed, so it is never shown;
       its fix is a fresh Claude sign in that writes the account down. */
    const reason = row.availability !== undefined && presentation?.displayAvailability !== true
      ? row.availability
      : (accounts !== undefined && (!row.accountId || !accounts.has(row.accountId))
      ? (!row.accountId && claudeStatusline(row) ? "account_unresolved" : "account_not_connected")
      : heldReason(
        row,
        row.availability !== undefined && presentation?.displayAvailability === true
          ? null
          : displayReason(row, now),
        now,
      ));
    if (reason === null) snapshots.push({ ...row, expiresAt: freshnessPolicy({ ...row, sourceClass: row.source, now }).expiresAt });
    else flags.set([row.provider, row.accountId, reason].join(":"), {
      provider: row.provider, ...(row.accountId ? { accountId: row.accountId } : {}), reason, fixKind: fixKind(reason)
    });
  }
  return { snapshots, flags: [...flags.values()] };
}
