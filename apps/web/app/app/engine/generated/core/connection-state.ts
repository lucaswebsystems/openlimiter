/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * The connection lifecycle, as one pure function and two human tables.
 *
 * A parser is not a connection. The product's central honesty problem is that
 * an implemented parser has been able to look like a live account, so the state
 * a connection is in has to be a value the whole product agrees on rather than
 * a sentence each surface invents. Everything here is data and arithmetic: no
 * clock, no network, no storage, so a surface can replay a connection's whole
 * history and get the same answer every time.
 */

export const CONNECTION_STATES = [
  "NOT_CONFIGURED",
  "DETECTED",
  "NEEDS_AUTH",
  "READY_TO_ENABLE",
  "CONNECTING",
  "CONNECTED",
  "DEGRADED",
  "STALE",
  "AUTH_EXPIRED",
  "IMPORT_ONLY",
  "MANUAL",
  "UNSUPPORTED",
  "ERROR"
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * How many consecutive network failures turn a degraded connection into a
 * broken one. One timeout is a bad moment; three in a row is a fault worth
 * showing a person.
 */
export const NETWORK_FAILURE_ERROR_THRESHOLD = 3;

export type ConnectionEvent =
  /** A supported local tool was found on this machine. */
  | { kind: "detected" }
  /** Setup established that this connection cannot proceed without a secret. */
  | { kind: "credential_required" }
  /** A secret was accepted into the operating system credential store. */
  | { kind: "credential_stored" }
  /** The user asked for this connection to start collecting. */
  | { kind: "enable_requested" }
  /** A remote read finished. `parsed` says whether we understood the body. */
  | { kind: "http_response"; status: number; parsed: boolean }
  /** A local read finished, for readers that never speak HTTP. */
  | { kind: "local_read"; parsed: boolean }
  /** A read never reached the provider. `consecutive` counts failures in a row. */
  | { kind: "network_failure"; consecutive: number }
  /** The newest observation aged past its own expiry. */
  | { kind: "expiry_passed" }
  /** The user removed this connection. */
  | { kind: "disconnected" }
  /** The product states this source can only be fed by an explicit import. */
  | { kind: "declared_import_only" }
  /** The product states this source is a user maintained plan. */
  | { kind: "declared_manual" }
  /** The product states no safe automatic source exists for this product. */
  | { kind: "declared_unsupported" };

/**
 * States that describe something the product declared rather than something it
 * attempted. A response cannot arrive in any of them, so a stray one is ignored
 * instead of quietly promoting an import only source to Connected.
 */
const declaredStates = new Set<ConnectionState>([
  "NOT_CONFIGURED",
  "IMPORT_ONLY",
  "MANUAL",
  "UNSUPPORTED"
]);

/**
 * What the transition function cannot work out from the current state alone.
 *
 * The one authentication question is whether this connection has ever worked,
 * and the current state cannot answer it. CONNECTED then a 404 lands in ERROR,
 * and a 401 arriving there would read as "we never had a credential" when what
 * actually happened is that a credential which used to work stopped, which is a
 * different sentence and a different button. So the fact is carried on the
 * connection record, where it belongs, and passed in. It is one way: nothing
 * ever sets it back to false, because a connection that worked once always did.
 */
export interface ConnectionContext {
  everConnected: boolean;
}

function afterResponse(
  state: ConnectionState,
  status: number,
  parsed: boolean,
  context: ConnectionContext
): ConnectionState {
  if (declaredStates.has(state)) return state;
  if (status === 401 || status === 403) {
    return context.everConnected ? "AUTH_EXPIRED" : "NEEDS_AUTH";
  }
  if (status === 429 || (status >= 500 && status <= 599)) return "DEGRADED";
  if (status < 200 || status > 299) return "ERROR";
  /*
   * The response arrived and was refused by our own parser. The connection is
   * healthy and our understanding of it is not, which is the exact failure the
   * Claude statusline contract mismatch was, so it reads as an error rather
   * than as a provider problem.
   */
  return parsed ? "CONNECTED" : "ERROR";
}

/**
 * Advance a connection by one event.
 *
 * Total and pure: every state, event and context triple has an answer, and an
 * event that makes no sense where it arrived leaves the state exactly as it was
 * rather than inventing a transition. The context is required rather than
 * defaulted, because a caller that forgets it would silently get the wrong
 * authentication answer, and a compiler error is cheaper than that.
 */
export function nextConnectionState(
  state: ConnectionState,
  event: ConnectionEvent,
  context: ConnectionContext
): ConnectionState {
  switch (event.kind) {
    case "disconnected":
      return "NOT_CONFIGURED";
    case "declared_import_only":
      return "IMPORT_ONLY";
    case "declared_manual":
      return "MANUAL";
    case "declared_unsupported":
      return "UNSUPPORTED";
    case "detected":
      return state === "NOT_CONFIGURED" ? "DETECTED" : state;
    case "credential_required":
      return state === "NOT_CONFIGURED" ||
        state === "DETECTED" ||
        state === "READY_TO_ENABLE"
        ? "NEEDS_AUTH"
        : state;
    case "credential_stored":
      return state === "NEEDS_AUTH" ||
        state === "AUTH_EXPIRED" ||
        state === "DETECTED"
        ? "READY_TO_ENABLE"
        : state;
    case "enable_requested":
      /*
       * A connection missing its credential cannot start collecting no matter
       * how many times the button is pressed, so those two states hold.
       */
      return state === "NEEDS_AUTH" ||
        state === "AUTH_EXPIRED" ||
        declaredStates.has(state)
        ? state
        : "CONNECTING";
    case "http_response":
      return afterResponse(state, event.status, event.parsed, context);
    case "local_read":
      if (declaredStates.has(state)) return state;
      return event.parsed ? "CONNECTED" : "ERROR";
    case "network_failure":
      if (declaredStates.has(state)) return state;
      return event.consecutive >= NETWORK_FAILURE_ERROR_THRESHOLD
        ? "ERROR"
        : "DEGRADED";
    case "expiry_passed":
      /*
       * Stale means the last reading is too old to trust, which only makes
       * sense once a reading exists. Nothing else ages.
       */
      return state === "CONNECTED" || state === "DEGRADED" ? "STALE" : state;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** One sentence per state, written for a person rather than for a log. */
export const connectionSentence = {
  NOT_CONFIGURED: "Not connected.",
  DETECTED: "Found on this machine but not collecting yet.",
  NEEDS_AUTH: "Waiting for a credential.",
  READY_TO_ENABLE: "Ready to start collecting.",
  CONNECTING: "Connecting.",
  CONNECTED: "Connected and collecting.",
  DEGRADED: "The provider is refusing reads for now.",
  STALE: "The last reading is older than it should be.",
  AUTH_EXPIRED: "The stored credential stopped working.",
  IMPORT_ONLY: "Reads only what you import. Nothing is collected automatically.",
  MANUAL: "Shows the plan you entered yourself.",
  UNSUPPORTED: "No safe automatic source exists for this product yet.",
  ERROR: "This connection failed and needs a look."
} as const satisfies Record<ConnectionState, string>;

/** The one thing to do next, in the words of the button that does it. */
export const connectionNextAction = {
  NOT_CONFIGURED: "Connect",
  DETECTED: "Enable local integration",
  NEEDS_AUTH: "Add credential",
  READY_TO_ENABLE: "Enable",
  CONNECTING: "Wait",
  CONNECTED: "Refresh now",
  DEGRADED: "Wait for the next retry",
  STALE: "Refresh now",
  AUTH_EXPIRED: "Reconnect",
  IMPORT_ONLY: "Import a payload",
  MANUAL: "Edit plan",
  UNSUPPORTED: "Add manual plan",
  ERROR: "View diagnostics"
} as const satisfies Record<ConnectionState, string>;

/** The five providers on the Connect and See catalogue surface. */
export const CATALOGUE_PROVIDER_IDS = [
  "claude",
  "openrouter",
  "codex",
  "antigravity",
  "opencode"
] as const;

export type CatalogueProviderId = (typeof CATALOGUE_PROVIDER_IDS)[number];
export type CataloguePlatform = "windows" | "macos" | "linux";
export type CatalogueCapabilityMode = "automatic" | "manual" | "event_driven";
export type CatalogueCapabilityMaturity = "supported" | "experimental";
export type CatalogueCapabilityLabel =
  | "Supported"
  | "Event driven"
  | "Experimental"
  | "Manual"
  | "Manual experimental";
export type CatalogueAuthMode = "existing_local_cli" | "api_key" | "manual";

export interface CataloguePlatformCapability {
  mode: CatalogueCapabilityMode;
  maturity: CatalogueCapabilityMaturity;
  label: CatalogueCapabilityLabel;
}

export interface ProviderCatalogueEntry {
  providerId: CatalogueProviderId;
  displayName: string;
  connectionState: ConnectionState;
  capabilities: Readonly<Record<CataloguePlatform, CataloguePlatformCapability>>;
  authMode: CatalogueAuthMode;
  action: string;
}

interface GeneratedProviderEntry {
  id?: unknown;
  displayName?: unknown;
  authModes?: unknown;
  platforms?: unknown;
  honesty?: { connectorId?: unknown } | null;
}

export interface GeneratedProviderDocument {
  providers?: unknown;
}

const supported = {
  mode: "automatic",
  maturity: "supported",
  label: "Supported"
} as const satisfies CataloguePlatformCapability;

const eventDriven = {
  mode: "event_driven",
  maturity: "supported",
  label: "Event driven"
} as const satisfies CataloguePlatformCapability;

const manual = {
  mode: "manual",
  maturity: "supported",
  label: "Manual"
} as const satisfies CataloguePlatformCapability;

const manualExperimental = {
  mode: "manual",
  maturity: "experimental",
  label: "Manual experimental"
} as const satisfies CataloguePlatformCapability;

const catalogueCapabilities = {
  claude: { windows: eventDriven, macos: eventDriven, linux: eventDriven },
  openrouter: { windows: supported, macos: supported, linux: supported },
  codex: { windows: supported, macos: supported, linux: supported },
  // The label states what this UI can do today; discovery returns only when its result reaches this surface.
  antigravity: { windows: manualExperimental, macos: manual, linux: manual },
  opencode: {
    windows: manualExperimental,
    macos: manualExperimental,
    linux: manualExperimental
  }
} as const satisfies Record<
  CatalogueProviderId,
  Readonly<Record<CataloguePlatform, CataloguePlatformCapability>>
>;

function isCatalogueProviderId(value: unknown): value is CatalogueProviderId {
  return typeof value === "string" &&
    (CATALOGUE_PROVIDER_IDS as readonly string[]).includes(value);
}

function isCatalogueAuthMode(value: unknown): value is CatalogueAuthMode {
  return value === "existing_local_cli" || value === "api_key" || value === "manual";
}

function catalogueState(value: unknown): ConnectionState {
  return typeof value === "string" &&
    (CONNECTION_STATES as readonly string[]).includes(value)
    ? value as ConnectionState
    : "NOT_CONFIGURED";
}

function actionFor(providerId: CatalogueProviderId, state: ConnectionState): string {
  if (providerId === "codex" && (state === "NEEDS_AUTH" || state === "AUTH_EXPIRED")) {
    return "Run codex login";
  }
  return connectionNextAction[state];
}

/**
 * Join generated provider facts to the closed connection state model.
 *
 * The generated document supplies identity, display name, auth mode and the
 * platform set. Product capability maturity is the frozen overlay above. No
 * site or local application is inspected at runtime.
 */
export function queryProviderCatalogue(
  generated: GeneratedProviderDocument,
  states: Readonly<Partial<Record<CatalogueProviderId, ConnectionState>>> = {}
): readonly ProviderCatalogueEntry[] {
  if (!Array.isArray(generated.providers)) return [];
  const found = new Map<CatalogueProviderId, GeneratedProviderEntry>();
  for (const candidate of generated.providers) {
    if (candidate === null || typeof candidate !== "object") continue;
    const entry = candidate as GeneratedProviderEntry;
    const providerId = entry.honesty?.connectorId;
    if (!isCatalogueProviderId(providerId)) continue;
    found.set(providerId, entry);
  }
  const catalogue: ProviderCatalogueEntry[] = [];
  for (const providerId of CATALOGUE_PROVIDER_IDS) {
    const source = found.get(providerId);
    if (source === undefined || typeof source.displayName !== "string") continue;
    if (!Array.isArray(source.authModes) || !isCatalogueAuthMode(source.authModes[0])) continue;
    const platforms = source.platforms;
    if (!Array.isArray(platforms)) continue;
    const hasEveryPlatform = (["windows", "macos", "linux"] as const)
      .every((platform) => platforms.includes(platform));
    if (!hasEveryPlatform) continue;
    const connectionState = catalogueState(states[providerId]);
    catalogue.push({
      providerId,
      displayName: source.displayName,
      connectionState,
      capabilities: catalogueCapabilities[providerId],
      authMode: source.authModes[0],
      action: actionFor(providerId, connectionState)
    });
  }
  return catalogue;
}

export interface PlannedProviderEntry {
  specId: string;
  displayName: string;
  action: "Planned";
}

export type CatalogueRow =
  | ({ availability: "connectable" } & ProviderCatalogueEntry)
  | ({ availability: "planned" } & PlannedProviderEntry);

/**
 * The connections surface showing connectable providers and planned products.
 *
 * The product catalogue presents every supported or planned provider in document
 * order after the connectable set. Planned rows carry no connection state because
 * no background collector or credential exists for them.
 */
export function queryCatalogueRows(
  generated: GeneratedProviderDocument,
  states: Readonly<Partial<Record<CatalogueProviderId, ConnectionState>>> = {}
): readonly CatalogueRow[] {
  const connectableRows: CatalogueRow[] = queryProviderCatalogue(generated, states).map(
    (entry) => ({
      availability: "connectable" as const,
      ...entry
    })
  );

  if (!Array.isArray(generated.providers)) return connectableRows;

  const plannedRows: CatalogueRow[] = [];
  for (const candidate of generated.providers) {
    if (candidate === null || typeof candidate !== "object") continue;
    const entry = candidate as GeneratedProviderEntry;
    const connectorId = entry.honesty?.connectorId;
    if (connectorId === "manual") continue;
    if (isCatalogueProviderId(connectorId)) continue;
    if (typeof entry.id !== "string" || typeof entry.displayName !== "string") continue;

    plannedRows.push({
      availability: "planned",
      specId: entry.id,
      displayName: entry.displayName,
      action: "Planned"
    });
  }

  return [...connectableRows, ...plannedRows];
}
