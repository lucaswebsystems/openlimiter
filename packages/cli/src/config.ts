import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  readJsonFileSafely,
  resolveStateDirectory,
  writeFileAtomically
} from "@openlimiter/core";
import { connectors } from "@openlimiter/connectors";
import type { CredentialStore } from "./credentials.js";

export const CONFIG_FILE_NAME = "openlimiter-config.json";

/* ------------------------------------------------------------- statusline */

/** Whether a provider with several meters shows one cell or all of them. */
export type StatuslineMeters = "worst" | "all";

/**
 * When the statusline may paint.
 *
 * `auto` follows the terminal, which is what every other command does. It is
 * the honest default and it is also the reason the other two exist: a
 * statusline host captures the command's output rather than handing it a
 * terminal, so `auto` resolves to no colour in exactly the place a person most
 * wants colour. `always` is how you say the host understands escape codes.
 * `never` is how you say it does not, whatever the terminal claims.
 */
export type StatuslineColor = "auto" | "always" | "never";

export interface StatuslineConfig {
  /**
   * Provider ids, in the order they should appear.
   *
   * Empty means the built in order: subscription plans first, then the credit
   * and API meters. A partial list is honoured as far as it goes and every
   * provider it leaves out follows the built in order behind it.
   */
  readonly order: readonly string[];
  readonly meters: StatuslineMeters;
  /** The column budget one row may spend before the line stacks. */
  readonly width: number;
  readonly rows: 1 | 2;
  /** False restores the single plain line released in 0.1.0. */
  readonly bars: boolean;
  readonly color: StatuslineColor;
}

export const STATUSLINE_KEYS = [
  "order",
  "meters",
  "width",
  "rows",
  "bars",
  "color"
] as const;

export type StatuslineKey = (typeof STATUSLINE_KEYS)[number];

/**
 * The narrowest and widest budget a row may be given.
 *
 * Below forty columns not one cell and its header fit, so the setting would
 * only ever produce an empty row. Above four hundred the budget stops
 * describing any real terminal and starts being a way to ask for an unbounded
 * line, which this tool does not print.
 */
export const MIN_STATUSLINE_WIDTH = 40;
export const MAX_STATUSLINE_WIDTH = 400;

export const DEFAULT_STATUSLINE: StatuslineConfig = {
  order: [],
  meters: "worst",
  width: 140,
  rows: 2,
  bars: true,
  color: "auto"
};

const connectorIds: readonly string[] = connectors.map((connector) => connector.id);

/** The list of ids an error message offers back to the reader. */
const connectorIdList = connectorIds.join(", ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOrder(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > connectorIds.length) return null;
  const order: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const id = entry.toLowerCase();
    if (!connectorIds.includes(id) || order.includes(id)) return null;
    order.push(id);
  }
  return order;
}

function normalizeWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < MIN_STATUSLINE_WIDTH || value > MAX_STATUSLINE_WIDTH) return null;
  return value;
}

/**
 * Read a stored statusline section, key by key, keeping what is usable.
 *
 * A key this does not understand falls back to its default rather than
 * rejecting the file. The statusline is drawn inside somebody else's tool and
 * a hand edited typo in one field is not a reason to stop drawing the other
 * five. Everything written through `openlimiter config set` is validated
 * before it lands, so this path only ever repairs a file edited by hand.
 */
export function normalizeStatusline(value: unknown): StatuslineConfig {
  if (!isRecord(value)) return DEFAULT_STATUSLINE;
  const meters = value["meters"];
  const rows = value["rows"];
  const bars = value["bars"];
  const color = value["color"];
  return {
    order: normalizeOrder(value["order"]) ?? DEFAULT_STATUSLINE.order,
    meters: meters === "worst" || meters === "all" ? meters : DEFAULT_STATUSLINE.meters,
    width: normalizeWidth(value["width"]) ?? DEFAULT_STATUSLINE.width,
    rows: rows === 1 || rows === 2 ? rows : DEFAULT_STATUSLINE.rows,
    bars: typeof bars === "boolean" ? bars : DEFAULT_STATUSLINE.bars,
    color: color === "auto" || color === "always" || color === "never"
      ? color
      : DEFAULT_STATUSLINE.color
  };
}

/** One stored key, rendered the way `config get` prints it. */
export function statuslineValueText(
  statusline: StatuslineConfig,
  key: StatuslineKey
): string {
  if (key === "order") {
    return statusline.order.length === 0 ? "NONE" : statusline.order.join(",");
  }
  if (key === "meters") return statusline.meters;
  if (key === "width") return String(statusline.width);
  if (key === "rows") return String(statusline.rows);
  if (key === "bars") return statusline.bars ? "true" : "false";
  return statusline.color;
}

export function isStatuslineKey(key: string): key is StatuslineKey {
  return (STATUSLINE_KEYS as readonly string[]).includes(key);
}

export type StatuslineUpdate =
  | { ok: true; statusline: StatuslineConfig }
  | { ok: false; message: string };

/**
 * Apply one key from the command line, or say why it cannot be applied.
 *
 * Every rejection names the key and lists what it would have accepted, because
 * a configuration error a person cannot fix from the message is a second
 * problem on top of the first. No value is ever coerced into something near
 * enough: a width of `wide` is refused rather than read as the default.
 */
export function setStatuslineValue(
  statusline: StatuslineConfig,
  key: string,
  value: string
): StatuslineUpdate {
  if (!isStatuslineKey(key)) {
    return {
      ok: false,
      message: "unknown statusline key. Known keys: " + STATUSLINE_KEYS.join(", ") + "."
    };
  }
  if (key === "order") {
    if (value === "" || value === "NONE" || value === "none") {
      return { ok: true, statusline: { ...statusline, order: [] } };
    }
    const order = normalizeOrder(value.split(",").map((entry) => entry.trim()));
    return order === null
      ? {
          ok: false,
          message: "statusline.order must be a comma separated list of provider " +
            "ids from " + connectorIdList + ", each named once, or NONE for the " +
            "built in order."
        }
      : { ok: true, statusline: { ...statusline, order } };
  }
  if (key === "meters") {
    return value === "worst" || value === "all"
      ? { ok: true, statusline: { ...statusline, meters: value } }
      : { ok: false, message: "statusline.meters must be worst or all." };
  }
  if (key === "width") {
    const width = /^\d{1,4}$/u.test(value) ? normalizeWidth(Number(value)) : null;
    return width === null
      ? {
          ok: false,
          message: "statusline.width must be a whole number from " +
            String(MIN_STATUSLINE_WIDTH) + " to " + String(MAX_STATUSLINE_WIDTH) + "."
        }
      : { ok: true, statusline: { ...statusline, width } };
  }
  if (key === "rows") {
    return value === "1" || value === "2"
      ? { ok: true, statusline: { ...statusline, rows: value === "1" ? 1 : 2 } }
      : { ok: false, message: "statusline.rows must be 1 or 2." };
  }
  if (key === "bars") {
    return value === "true" || value === "false"
      ? { ok: true, statusline: { ...statusline, bars: value === "true" } }
      : { ok: false, message: "statusline.bars must be true or false." };
  }
  return value === "auto" || value === "always" || value === "never"
    ? { ok: true, statusline: { ...statusline, color: value } }
    : { ok: false, message: "statusline.color must be auto, always, or never." };
}

/* ------------------------------------------------------------------ file */

export interface ConfigConnector {
  id: string;
  enabled: true;
  detected: boolean;
}

export interface OpenLimiterConfig {
  version: 1;
  connectors: readonly ConfigConnector[];
  statusline: StatuslineConfig;
}

async function rejectSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Unsafe state path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writeConfig(
  config: OpenLimiterConfig,
  directory = resolveStateDirectory()
): Promise<void> {
  await rejectSymlink(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectSymlink(directory);
  const target = path.join(directory, CONFIG_FILE_NAME);
  await rejectSymlink(target);
  await writeFileAtomically(target, canonicalJson(config));
}

function connectorRows(
  environment: Readonly<Record<string, string | undefined>>
): readonly ConfigConnector[] {
  return connectors.map((connector) => ({
    id: connector.id,
    enabled: true as const,
    detected: connector.detect(environment)
  }));
}

function normalizeConnectors(value: unknown): readonly ConfigConnector[] {
  if (!Array.isArray(value)) return [];
  const rows: ConfigConnector[] = [];
  for (const entry of value.slice(0, connectorIds.length)) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    if (typeof id !== "string" || !connectorIds.includes(id)) continue;
    if (rows.some((row) => row.id === id)) continue;
    rows.push({ id, enabled: true, detected: entry["detected"] === true });
  }
  return rows;
}

export type ConfigReadResult =
  | { ok: true; config: OpenLimiterConfig }
  | { ok: false; reason: "missing" | "corrupt" | "unsafe" };

/**
 * Read the configuration file.
 *
 * The document is validated the same way the cache is: an unreadable or
 * unsafe file is reported rather than replaced, and a readable file with a
 * field this version does not recognise keeps the fields it does. A file that
 * is simply not there yet is `missing`, which is not a failure.
 */
export async function readConfig(
  directory = resolveStateDirectory()
): Promise<ConfigReadResult> {
  try {
    await rejectSymlink(directory);
  } catch {
    return { ok: false, reason: "unsafe" };
  }
  const document = await readJsonFileSafely(path.join(directory, CONFIG_FILE_NAME));
  if (!document.ok) return document;
  if (!isRecord(document.value)) return { ok: false, reason: "corrupt" };
  return {
    ok: true,
    config: {
      version: 1,
      connectors: normalizeConnectors(document.value["connectors"]),
      statusline: normalizeStatusline(document.value["statusline"])
    }
  };
}

/**
 * The statusline section, or the defaults, and never an exception.
 *
 * The statusline command runs inside another tool's status row on every
 * redraw. It reads its own configuration the way it reads everything else:
 * if the answer is not there, the answer is the default, and the line is still
 * drawn.
 */
export async function readStatuslineConfig(
  directory?: string
): Promise<StatuslineConfig> {
  try {
    const result = await readConfig(directory);
    return result.ok ? result.config.statusline : DEFAULT_STATUSLINE;
  } catch {
    return DEFAULT_STATUSLINE;
  }
}

export async function initialize(
  environment: Readonly<Record<string, string | undefined>>,
  credentialStore: CredentialStore,
  promptForSecret: () => Promise<string>,
  directory?: string
): Promise<{ config: OpenLimiterConfig; credentialStored: boolean }> {
  /*
   * Re running init re detects the connectors and keeps the statusline the
   * person configured. Detection is a fact about the machine and is meant to
   * be refreshed; the layout is a preference and overwriting it would punish
   * anyone who ran the command twice.
   */
  const existing = await readConfig(
    directory ?? resolveStateDirectory()
  ).catch((): ConfigReadResult => ({ ok: false, reason: "missing" }));
  const config: OpenLimiterConfig = {
    version: 1,
    connectors: connectorRows(environment),
    statusline: existing.ok ? existing.config.statusline : DEFAULT_STATUSLINE
  };
  let credentialStored = false;
  const openrouter = config.connectors.find((connector) => connector.id === "openrouter");
  if (openrouter?.detected === true) {
    try {
      const existingSecret = await credentialStore.get("openlimiter", "openrouter");
      if (existingSecret === null) {
        const secret = await promptForSecret();
        if (secret.length > 0 && secret.length <= 8_192) {
          await credentialStore.set("openlimiter", "openrouter", secret);
          credentialStored = true;
        }
      }
    } catch {
      credentialStored = false;
    }
  }
  await writeConfig(config, directory);
  return { config, credentialStored };
}

/**
 * The configuration a `config set` writes into when there is no file yet.
 *
 * Connector detection is redone rather than left blank, so a first `config
 * set` produces the same file `init` would have produced with the chosen key
 * changed, instead of a file that claims no connector exists.
 */
export function defaultConfig(
  environment: Readonly<Record<string, string | undefined>>
): OpenLimiterConfig {
  return {
    version: 1,
    connectors: connectorRows(environment),
    statusline: DEFAULT_STATUSLINE
  };
}
