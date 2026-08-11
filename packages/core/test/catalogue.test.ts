import { describe, expect, it } from "vitest";
import providerSpecs from "../../../provider_specs/provider-specs.json" with { type: "json" };
import {
  CONNECTION_STATES,
  queryProviderCatalogue,
  type CatalogueProviderId,
  type ConnectionState
} from "../src/index.js";

describe("provider catalogue", () => {
  it("derives the five ship entries from generated provider data", () => {
    const catalogue = queryProviderCatalogue(providerSpecs);
    expect(catalogue.map((entry) => [entry.providerId, entry.displayName, entry.authMode]))
      .toEqual([
        ["claude", "Claude Code", "existing_local_cli"],
        ["openrouter", "OpenRouter", "api_key"],
        ["codex", "Codex", "existing_local_cli"],
        ["antigravity", "Antigravity", "existing_local_cli"],
        ["opencode", "OpenCode", "manual"]
      ]);
  });

  it("states the experimental and manual platform boundaries exactly", () => {
    const byId = new Map(queryProviderCatalogue(providerSpecs).map((entry) => [entry.providerId, entry]));
    expect(byId.get("antigravity")?.capabilities).toEqual({
      windows: { mode: "automatic", maturity: "experimental", label: "Experimental" },
      macos: { mode: "manual", maturity: "supported", label: "Manual" },
      linux: { mode: "manual", maturity: "supported", label: "Manual" }
    });
    for (const capability of Object.values(byId.get("opencode")?.capabilities ?? {})) {
      expect(capability).toEqual({
        mode: "manual",
        maturity: "experimental",
        label: "Manual experimental"
      });
    }
  });

  it("returns one action for every provider and every connection state", () => {
    const providerIds: readonly CatalogueProviderId[] = [
      "claude",
      "openrouter",
      "codex",
      "antigravity",
      "opencode"
    ];
    for (const providerId of providerIds) {
      for (const state of CONNECTION_STATES) {
        const states = { [providerId]: state } as Partial<Record<CatalogueProviderId, ConnectionState>>;
        const entry = queryProviderCatalogue(providerSpecs, states)
          .find((candidate) => candidate.providerId === providerId);
        expect(entry?.connectionState).toBe(state);
        expect(entry?.action).toEqual(expect.any(String));
        expect(entry?.action.length).toBeGreaterThan(0);
      }
    }
    const codex = queryProviderCatalogue(providerSpecs, { codex: "NEEDS_AUTH" })
      .find((entry) => entry.providerId === "codex");
    expect(codex?.action).toBe("Run codex login");
  });
});
