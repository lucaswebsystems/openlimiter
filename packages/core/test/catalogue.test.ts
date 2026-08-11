import { describe, expect, it } from "vitest";
import providerSpecs from "../../../provider_specs/provider-specs.json" with { type: "json" };
import {
  CONNECTION_STATES,
  queryCatalogueRows,
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

describe("catalogue rows", () => {
  it("derives all seventeen catalogue rows in document order", () => {
    const rows = queryCatalogueRows(providerSpecs);
    expect(rows).toHaveLength(17);

    const connectableRows = rows.slice(0, 5);
    expect(connectableRows.every((row) => row.availability === "connectable")).toBe(true);
    expect(
      connectableRows.map((row) => (row.availability === "connectable" ? row.providerId : undefined))
    ).toEqual(["claude", "openrouter", "codex", "antigravity", "opencode"]);

    const plannedRows = rows.slice(5);
    expect(plannedRows).toHaveLength(12);
    for (const row of plannedRows) {
      expect(row.availability).toBe("planned");
      expect(row.action).toBe("Planned");
      expect("connectionState" in row).toBe(false);
    }

    for (const row of rows) {
      expect(row.displayName).not.toBe("Manual");
      if (row.availability === "planned") {
        expect(row.specId).not.toBe("openlimiter/manual");
      }
    }
  });

  it("applies connection state overrides to the connectable claude row only", () => {
    const rows = queryCatalogueRows(providerSpecs, { claude: "CONNECTED" });
    const connectableRows = rows.filter(
      (row): row is Extract<typeof row, { availability: "connectable" }> =>
        row.availability === "connectable"
    );

    const claudeRow = connectableRows.find((row) => row.providerId === "claude");
    expect(claudeRow?.connectionState).toBe("CONNECTED");

    for (const row of connectableRows) {
      if (row.providerId !== "claude") {
        expect(row.connectionState).toBe("NOT_CONFIGURED");
      }
    }
  });
});

