/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * Cline: registered for the 2.1 providers wave and switched off.
 *
 * Route: the documented account balance endpoints, read with the token Cline
 * already stores. Lane P1b owns this file and fills it in: the parser, its
 * fixtures (a real shaped answer, unlimited, expired or signed out, schema
 * drift, missing fields), and labels identical to the honesty block its
 * registry spec publishes. Readings follow the meter contract in
 * packages/core/src/data-rules.ts.
 *
 * Until then nothing here reads anything: the parser answers null for every
 * payload, the connector detects nothing, the contract gate refuses the
 * provider while its code is pending, and `connectors` in index.ts leaves it
 * out.
 */
import type { ConnectorContract, ConnectorLabels, RawMeter } from "../core";

export const clineLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "documented-api",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

/** Nothing is parsed until the lane lands, so nothing can be invented. */
export function parseClinePayload(_payload: unknown, _now: string): RawMeter[] | null {
  return null;
}

export const clineConnector: ConnectorContract = {
  id: "cline",
  encoding: "json",
  displayName: "Cline",
  labels: clineLabels,
  detect() {
    return false;
  },
  async read() {
    return { ok: false, reason: "not_configured" };
  }
};
