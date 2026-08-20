export const PROVIDER_ACCESS_CLASSES = ["automatic", "key", "manual"] as const;

export type ProviderAccessClass = (typeof PROVIDER_ACCESS_CLASSES)[number];
export type ProviderDirectoryAvailability = "ready" | "planned";
export type ProviderDirectoryTone = "live" | "ready" | "attention" | "quiet";
export type ProviderDirectoryAction = "connect" | "enable" | "refresh" | "manual" | "none";

export interface ProviderDirectoryRow {
  key: string;
  specId: string;
  connectorId: string | null;
  displayName: string;
  access: ProviderAccessClass;
  accessLabel: "Automatic" | "Key" | "Manual" | "Roadmap";
  availability: ProviderDirectoryAvailability;
  description: string;
  state: string;
  stateLabel: string;
  stateTone: ProviderDirectoryTone;
  action: ProviderDirectoryAction;
  actionLabel: string | null;
}

interface GeneratedProviderSpec {
  id?: unknown;
  displayName?: unknown;
  authModes?: unknown;
  honesty?: { connectorId?: unknown } | null;
}

export interface GeneratedProviderRegistry {
  providers?: unknown;
}

export interface ProviderDirectoryOptions {
  states?: Readonly<Record<string, string | null | undefined>>;
}

const READY_SPEC_ORDER = [
  "anthropic/claude-code",
  "openai/codex",
  "xai/api",
  "moonshot/api",
  "openrouter/api",
  "google/antigravity",
  "google/gemini-cli",
  "opencode/opencode",
  "openlimiter/manual",
] as const;

/** The expansion order shown in the owner's reference image. */
const PLANNED_SPEC_ORDER = [
  "perplexity/api",
  "xai/api",
  "github/copilot",
  "cursor/editor",
  "windsurf/editor",
  "ollama/local",
  "lmstudio/local",
  "together/api",
  "mistral/api",
  "deepseek/api",
  "moonshot/api",
] as const;

const SPEC_ORDER = [...new Set([...READY_SPEC_ORDER, ...PLANNED_SPEC_ORDER])];

const READY_CONNECTORS = new Set([
  "claude",
  "codex",
  "openrouter",
  "antigravity",
  "gemini-cli",
  "opencode",
  "grok",
  "kimi",
  "manual",
]);

/** Grok and Kimi are entering through local discovery despite their API catalog entries. */
const AUTOMATIC_OVERRIDES = new Set(["xai/api", "moonshot/api"]);

/**
 * The expansion reference names provider families, while automatic collection
 * lands as a product specific CLI spec. Join the CLI fact to the existing row
 * so an arriving connector promotes that row instead of adding a duplicate.
 */
const CONNECTOR_SPEC_FOR_ROW: Readonly<Record<string, string>> = {
  "xai/api": "xai/grok-cli",
  "moonshot/api": "moonshot/kimi-code",
};

/** Runtime connectors that arrived after their research specs were generated. */
const CONNECTOR_ID_FOR_ROW: Readonly<Record<string, string>> = {
  "google/gemini-cli": "gemini-cli",
};

const COMPACT_NAMES: Readonly<Record<string, string>> = {
  "xai/api": "Grok (xAI)",
  "moonshot/api": "Kimi",
  "together/api": "Together",
  "mistral/api": "Mistral",
  "windsurf/editor": "Devin Desktop",
};

const ACCESS_LABELS = {
  automatic: "Automatic",
  key: "Key",
  manual: "Manual",
} as const satisfies Record<ProviderAccessClass, ProviderDirectoryRow["accessLabel"]>;

const ACCESS_DESCRIPTIONS = {
  automatic: "Local detection",
  key: "Secure key",
  manual: "Enter usage",
} as const satisfies Record<ProviderAccessClass, string>;

function firstAuthMode(spec: GeneratedProviderSpec): string | null {
  if (!Array.isArray(spec.authModes)) return null;
  const mode = spec.authModes[0];
  return typeof mode === "string" ? mode : null;
}

function accessClass(specId: string, spec: GeneratedProviderSpec): ProviderAccessClass {
  if (specId === "openlimiter/manual") return "manual";
  if (AUTOMATIC_OVERRIDES.has(specId)) return "automatic";
  const mode = firstAuthMode(spec);
  if (mode === "existing_local_cli" || mode === "oauth" || mode === "none") {
    return "automatic";
  }
  if (mode === "api_key" || mode === "admin_api_key" || mode === "management_key") {
    return "key";
  }
  return "manual";
}

function stateView(
  state: string,
  access: ProviderAccessClass,
): Pick<ProviderDirectoryRow, "stateLabel" | "stateTone" | "action" | "actionLabel"> {
  switch (state) {
    case "CONNECTED":
      return {
        stateLabel: "Connected",
        stateTone: "live",
        action: "refresh",
        actionLabel: "Refresh",
      };
    case "DETECTED":
      return {
        stateLabel: "Detected",
        stateTone: "ready",
        action: "enable",
        actionLabel: "Enable",
      };
    case "READY_TO_ENABLE":
      return {
        stateLabel: "Ready",
        stateTone: "ready",
        action: "enable",
        actionLabel: "Enable",
      };
    case "CONNECTING":
      return {
        stateLabel: "Connecting",
        stateTone: "ready",
        action: "none",
        actionLabel: null,
      };
    case "DEGRADED":
      return {
        stateLabel: "Retrying",
        stateTone: "attention",
        action: "none",
        actionLabel: null,
      };
    case "STALE":
      return {
        stateLabel: "Stale",
        stateTone: "attention",
        action: "refresh",
        actionLabel: "Refresh",
      };
    case "AUTH_EXPIRED":
      return {
        stateLabel: access === "key" ? "Key expired" : "Sign in again",
        stateTone: "attention",
        action: "connect",
        actionLabel: "Reconnect",
      };
    case "NEEDS_AUTH":
      return {
        stateLabel: access === "key" ? "Key needed" : "Sign in",
        stateTone: "attention",
        action: "connect",
        actionLabel: "Connect",
      };
    case "IMPORT_ONLY":
      return {
        stateLabel: "Desktop only",
        stateTone: "quiet",
        action: access === "manual" ? "manual" : "connect",
        actionLabel: access === "manual" ? "Add numbers" : "Connect",
      };
    case "MANUAL":
      return {
        stateLabel: "Manual entry",
        stateTone: "quiet",
        action: "manual",
        actionLabel: "Add numbers",
      };
    case "ERROR":
      return {
        stateLabel: "Needs attention",
        stateTone: "attention",
        action: "connect",
        actionLabel: "Review",
      };
    default:
      if (access === "automatic") {
        return {
          stateLabel: "Not found",
          stateTone: "quiet",
          action: "connect",
          actionLabel: "Scan again",
        };
      }
      if (access === "key") {
        return {
          stateLabel: "Key needed",
          stateTone: "quiet",
          action: "connect",
          actionLabel: "Connect",
        };
      }
      return {
        stateLabel: "Manual entry",
        stateTone: "quiet",
        action: "manual",
        actionLabel: "Add numbers",
      };
  }
}

function readSpecs(registry: GeneratedProviderRegistry): Map<string, GeneratedProviderSpec> {
  const result = new Map<string, GeneratedProviderSpec>();
  if (!Array.isArray(registry.providers)) return result;
  for (const candidate of registry.providers) {
    if (candidate === null || typeof candidate !== "object") continue;
    const spec = candidate as GeneratedProviderSpec;
    if (typeof spec.id !== "string" || typeof spec.displayName !== "string") continue;
    result.set(spec.id, spec);
  }
  return result;
}

/**
 * Build the one provider directory shared by web and desktop.
 *
 * Generated provider facts decide identity and access class. Runtime state is
 * optional and comes from the owning detector or connection backend. Missing
 * state is rendered as an invitation, never as a failed connection.
 */
export function buildProviderDirectory(
  registry: GeneratedProviderRegistry,
  options: ProviderDirectoryOptions = {},
): readonly ProviderDirectoryRow[] {
  const specs = readSpecs(registry);
  const rows: ProviderDirectoryRow[] = [];

  for (const specId of SPEC_ORDER) {
    const spec = specs.get(specId);
    if (spec === undefined || typeof spec.displayName !== "string") continue;
    const connectorSpec = specs.get(CONNECTOR_SPEC_FOR_ROW[specId] ?? specId) ?? spec;
    const rawConnector = connectorSpec.honesty?.connectorId;
    const connectorId =
      CONNECTOR_ID_FOR_ROW[specId] ??
      (typeof rawConnector === "string" ? rawConnector : null);
    const availability =
      connectorId !== null && READY_CONNECTORS.has(connectorId) ? "ready" : "planned";
    const access = accessClass(specId, connectorSpec);
    const displayName = COMPACT_NAMES[specId] ?? spec.displayName;

    if (availability === "planned") {
      rows.push({
        key: specId,
        specId,
        connectorId,
        displayName,
        access,
        accessLabel: "Roadmap",
        availability,
        description: "Roadmap item",
        state: "PLANNED",
        stateLabel: "Not built yet",
        stateTone: "quiet",
        action: "none",
        actionLabel: null,
      });
      continue;
    }

    const state =
      connectorId === "manual"
        ? "MANUAL"
        : String(options.states?.[connectorId ?? ""] ?? "NOT_CONFIGURED").toUpperCase();
    rows.push({
      key: specId,
      specId,
      connectorId,
      displayName,
      access,
      accessLabel: ACCESS_LABELS[access],
      availability,
      description: ACCESS_DESCRIPTIONS[access],
      state,
      ...stateView(state, access),
    });
  }

  const byReadyOrder = new Map<string, number>(
    READY_SPEC_ORDER.map((specId, index) => [specId, index]),
  );
  const byPlannedOrder = new Map<string, number>(
    PLANNED_SPEC_ORDER.map((specId, index) => [specId, index]),
  );
  const fallbackOrder = SPEC_ORDER.length;

  return [
    ...rows
      .filter((row) => row.availability === "ready")
      .sort(
        (left, right) =>
          (byReadyOrder.get(left.specId) ?? fallbackOrder) -
          (byReadyOrder.get(right.specId) ?? fallbackOrder),
      ),
    ...rows
      .filter((row) => row.availability === "planned")
      .sort(
        (left, right) =>
          (byPlannedOrder.get(left.specId) ?? fallbackOrder) -
          (byPlannedOrder.get(right.specId) ?? fallbackOrder),
      ),
  ];
}
