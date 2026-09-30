/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * Kilo Code: registered for the 2.1 providers wave and switched off.
 *
 * Route: the JSON profile of the installed Kilo runtime. Lane P1c owns this
 * file and fills it in: the parser, its fixtures (a real shaped answer,
 * unlimited, expired or signed out, schema drift, missing fields), and labels
 * identical to the honesty block its registry spec publishes. Readings follow
 * the meter contract in packages/core/src/data-rules.ts.
 *
 * Until then nothing here reads anything: the parser answers null for every
 * payload, the connector detects nothing, the contract gate refuses the
 * provider while its code is pending, and `connectors` in index.ts leaves it
 * out.
 */
import type { ConnectorContract, ConnectorLabels, RawMeter } from "../core";

export const kiloLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "documented-api",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

/** Nothing is parsed until the lane lands, so nothing can be invented. */
export function parseKiloPayload(_payload: unknown, _now: string): RawMeter[] | null {
  return null;
}

export const kiloConnector: ConnectorContract = {
  id: "kilo",
  encoding: "json",
  displayName: "Kilo Code",
  labels: kiloLabels,
  detect() {
    return false;
  },
  async read() {
    return { ok: false, reason: "not_configured" };
  }
};
