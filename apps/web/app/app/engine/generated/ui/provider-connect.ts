/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
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
  support?: { reader?: unknown };
  directory?: {
    order: number;
    rowId: string;
    label: string;
    connectorId: string;
    access: ProviderAccessClass;
  } | null;
}

export interface GeneratedProviderRegistry {
  providers?: unknown;
}

export interface ProviderDirectoryOptions {
  states?: Readonly<Record<string, string | null | undefined>>;
}

/** Recognition identity, labels, and ordering are authored only in the YAML. */
export const PROVIDER_RECOGNITION_ORDER: readonly string[] = Object.freeze(
  directorySpecs(providerRegistry).map((spec) => spec.directory!.rowId),
);

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

function directorySpecs(registry: GeneratedProviderRegistry): GeneratedProviderSpec[] {
  return [...readSpecs(registry).values()]
    .filter((spec) => {
      const row = spec.directory;
      return row != null && Number.isSafeInteger(row.order) && row.order >= 0 &&
        typeof row.rowId === "string" && typeof row.label === "string" &&
        typeof row.connectorId === "string" && PROVIDER_ACCESS_CLASSES.includes(row.access);
    })
    .sort((left, right) => left.directory!.order - right.directory!.order);
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

  const recognition = directorySpecs(registry);
  for (const connectorSpec of recognition) {
    const directory = connectorSpec.directory!;
    const specId = directory.rowId;
    const spec = specs.get(specId);
    if (spec === undefined || typeof spec.displayName !== "string") continue;
    const connectorId = directory.connectorId;
    const availability =
      connectorSpec.support?.reader === "implemented" ? "ready" : "planned";
    const access = directory.access;
    const displayName = directory.label;

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

  const byDisplayOrder = new Map<string, number>(
    recognition.map((spec, index) => [spec.directory!.rowId, index]),
  );
  const fallbackOrder = recognition.length;

  return [
    ...rows
      .filter((row) => row.availability === "ready")
      .sort(
        (left, right) =>
          (byDisplayOrder.get(left.specId) ?? fallbackOrder) -
          (byDisplayOrder.get(right.specId) ?? fallbackOrder),
      ),
    ...rows
      .filter((row) => row.availability === "planned")
      .sort(
        (left, right) =>
          (byDisplayOrder.get(left.specId) ?? fallbackOrder) -
          (byDisplayOrder.get(right.specId) ?? fallbackOrder),
      ),
  ];
}
import providerRegistry from "../../../provider_specs/provider-specs.json" with { type: "json" };
