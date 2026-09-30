/**
 * Amp: registered for the 2.1 providers wave and switched off.
 *
 * Route: the text the installed Amp CLI's usage command prints. Lane P1c owns
 * this file and fills it in: the parser, its fixtures (a real shaped answer,
 * unlimited, expired or signed out, schema drift, missing fields), and labels
 * identical to the honesty block its registry spec publishes. Readings follow
 * the meter contract in packages/core/src/data-rules.ts.
 *
 * Until then nothing here reads anything: the parser answers null for every
 * payload, the connector detects nothing, the contract gate refuses the
 * provider while its code is pending, and `connectors` in index.ts leaves it
 * out.
 */
import type { ConnectorContract, ConnectorLabels, RawMeter } from "@openlimiter/core";

export const ampLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "documented-api",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

/** Nothing is parsed until the lane lands, so nothing can be invented. */
export function parseAmpPayload(_payload: unknown, _now: string): RawMeter[] | null {
  return null;
}

export const ampConnector: ConnectorContract = {
  id: "amp",
  encoding: "text",
  displayName: "Amp",
  labels: ampLabels,
  detect() {
    return false;
  },
  async read() {
    return { ok: false, reason: "not_configured" };
  }
};
