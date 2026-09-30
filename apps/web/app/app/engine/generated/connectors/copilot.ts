/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * GitHub Copilot: registered for the 2.1 providers wave and switched off.
 *
 * Route: the official SDK account quota call, answered by the installed
 * Copilot runtime. Lane P1c owns this file and fills it in: the parser, its
 * fixtures (a real shaped answer, unlimited, expired or signed out, schema
 * drift, missing fields), and labels identical to the honesty block its
 * registry spec publishes. Readings follow the meter contract in
 * packages/core/src/data-rules.ts.
 *
 * Until then nothing here reads anything: the parser answers null for every
 * payload, the connector detects nothing, the contract gate refuses the
 * provider while its code is pending, and `connectors` in index.ts leaves it
 * out.
 *
 * The labels are the cautious pair until the lane states them: GitHub marks
 * the account call experimental.
 */
import type { ConnectorContract, ConnectorLabels, RawMeter } from "../core";

export const copilotLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

/** Nothing is parsed until the lane lands, so nothing can be invented. */
export function parseCopilotPayload(_payload: unknown, _now: string): RawMeter[] | null {
  return null;
}

export const copilotConnector: ConnectorContract = {
  id: "copilot",
  encoding: "json",
  displayName: "GitHub Copilot",
  labels: copilotLabels,
  detect() {
    return false;
  },
  async read() {
    return { ok: false, reason: "not_configured" };
  }
};
