/**
 * Where each vendor's own client keeps the credential it obtained, and how to
 * read it without ever changing it.
 *
 * Three rules hold this whole file together.
 *
 * One: nothing here writes. Not a refresh, not a rewrite, not a touch of the
 * modification time. A vendor's credential file belongs to that vendor's
 * client, and a monitor that repairs it is a monitor that can corrupt a login
 * somebody depends on for work.
 *
 * Two: no secret ever leaves this module by any route other than the request
 * builders in `transport.ts`. Every failure is a closed literal with no
 * payload, so a token cannot reach a log, an error string, a report or a
 * process argument.
 *
 * Three: absent is not broken. A machine without Codex installed is not a
 * failure to report, it is a provider this person does not use.
 */
import { homedir } from "node:os";
import path from "node:path";
import { readJsonFileSafely } from "../cache.js";

/** The providers this path can read a credential for. */
export const ACQUISITION_PROVIDERS = [
  "CLAUDE",
  "CODEX",
  "GEMINI_CLI",
  "ANTIGRAVITY",
  "GROK",
  "KIMI",
  "OPENROUTER"
] as const;

export type AcquisitionProvider = (typeof ACQUISITION_PROVIDERS)[number];

/** Largest credential document this path will read into memory. */
export const MAX_CREDENTIAL_FILE_BYTES = 65_536;

/**
 * Why no usable credential came back.
 *
 * `absent` is the ordinary answer on a machine that does not run that client.
 * `expired` is separated from `invalid` because only one of them has an action
 * a person can take, and the row says so.
 */
export type CredentialFailureReason =
  | "absent"
  | "unreadable"
  | "invalid"
  | "expired"
  | "keychain_not_read";

/**
 * Whose login this actually is.
 *
 * The one that matters is `shared_code_assist`. Antigravity keeps its token in
 * the Windows credential store, and when that store holds nothing this reader
 * falls back to the Gemini CLI's file, which is what the Antigravity client's
 * own quota shares a backend with. That fallback is legitimate and it is what
 * every other reader does, but the resulting row is NOT Antigravity's own
 * login, and presenting it as one would tell a person they had connected
 * something they never connected. So the origin travels with the credential and
 * the row says which it is.
 */
export const CREDENTIAL_ORIGINS = [
  "vendor_store",
  "vendor_file",
  "shared_code_assist",
  "user_key"
] as const;

export type CredentialOrigin = (typeof CREDENTIAL_ORIGINS)[number];

export interface AcquiredCredential {
  /** The bearer secret. Never printed, never logged, never persisted by us. */
  readonly secret: string;
  /** The account the provider knows this credential by, when it states one. */
  readonly accountId: string | null;
  /** Expiry in epoch milliseconds, when the document states one. */
  readonly expiresAtMilliseconds: number | null;
  /** Where this credential came from, so a row can say whose login it is. */
  readonly origin: CredentialOrigin;
}

export type CredentialResult =
  | { ok: true; credential: AcquiredCredential }
  | { ok: false; reason: CredentialFailureReason };

export interface CredentialLookupOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  /** Injected clock, so an expiry test does not depend on the wall clock. */
  readonly now?: string;
  /**
   * How a Windows Credential Manager entry is read.
   *
   * Injected so the Antigravity path can be proved without a real credential
   * on the machine, and so no test ever touches the live credential store.
   */
  readonly readWindowsCredential?: WindowsCredentialReader;
}

export type WindowsCredentialReader = (
  target: string
) => Promise<{ ok: true; value: string } | { ok: false; reason: CredentialFailureReason }>;

interface Resolved {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

function resolve(options: CredentialLookupOptions): Resolved {
  return {
    platform: options.platform ?? process.platform,
    environment: options.environment ?? process.env,
    home: options.homeDirectory ?? homedir()
  };
}

function directoryFrom(
  value: string | undefined
): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

function xdgConfig(context: Resolved): string | null {
  return directoryFrom(context.environment["XDG_CONFIG_HOME"]) ??
    path.join(context.home, ".config");
}

function xdgData(context: Resolved): string | null {
  return directoryFrom(context.environment["XDG_DATA_HOME"]) ??
    path.join(context.home, ".local", "share");
}

function join(base: string | null, ...parts: readonly string[]): string | null {
  return base === null ? null : path.join(base, ...parts);
}

/**
 * Every place a provider's own client is known to keep its credential, in the
 * order the vendor's own environment variable would win.
 *
 * The first readable document that yields a usable secret wins. Order matters
 * only for a machine carrying two of them, and in that case the explicit
 * environment variable is the one the person set on purpose.
 */
export function credentialCandidatePaths(
  provider: AcquisitionProvider,
  options: CredentialLookupOptions = {}
): string[] {
  const context = resolve(options);
  const home = context.home;
  const candidates: (string | null)[] = [];
  if (provider === "CLAUDE") {
    candidates.push(
      join(directoryFrom(context.environment["CLAUDE_CONFIG_DIR"]), ".credentials.json"),
      path.join(home, ".claude", ".credentials.json"),
      join(xdgConfig(context), "claude", ".credentials.json"),
      join(xdgConfig(context), "claude-code", ".credentials.json"),
      join(xdgData(context), "claude-code", ".credentials.json")
    );
  } else if (provider === "CODEX") {
    candidates.push(
      join(directoryFrom(context.environment["CODEX_HOME"]), "auth.json"),
      path.join(home, ".codex", "auth.json"),
      join(xdgConfig(context), "codex", "auth.json"),
      join(xdgData(context), "codex", "auth.json")
    );
  } else if (provider === "GEMINI_CLI" || provider === "ANTIGRAVITY") {
    candidates.push(
      join(directoryFrom(context.environment["GEMINI_DIR"]), "oauth_creds.json"),
      path.join(home, ".gemini", "oauth_creds.json")
    );
  } else if (provider === "GROK") {
    candidates.push(
      join(directoryFrom(context.environment["GROK_HOME"]), "auth.json"),
      path.join(home, ".grok", "auth.json")
    );
  } else if (provider === "KIMI") {
    candidates.push(
      join(
        directoryFrom(context.environment["KIMI_CODE_HOME"]),
        "credentials",
        "kimi-code.json"
      ),
      path.join(home, ".kimi", "credentials", "kimi-code.json"),
      path.join(home, ".kimi-code", "credentials", "kimi-code.json"),
      join(
        directoryFrom(context.environment["KIMI_SHARE_DIR"]),
        "credentials",
        "kimi-code.json"
      )
    );
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    paths.push(candidate);
  }
  return paths;
}

/** The Windows Credential Manager target the Antigravity client writes to. */
export const ANTIGRAVITY_CREDENTIAL_TARGET = "gemini:antigravity";

/** The macOS keychain service Claude Code writes to, which this path skips. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  source: Record<string, unknown>,
  names: readonly string[]
): string | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * The container inside a credential document that actually holds the token.
 *
 * Every one of these clients nests it under a different key, and two of them
 * changed the key between releases, so the root itself is tried last rather
 * than first: a document that carries both a nested container and a stray top
 * level field should be read the way its own client reads it.
 */
const CONTAINERS: Readonly<Record<AcquisitionProvider, readonly string[]>> = {
  CLAUDE: ["claudeAiOauth", "oauth", "credentials"],
  CODEX: ["tokens", "oauth", "credentials"],
  GEMINI_CLI: ["oauth", "tokens", "credentials"],
  ANTIGRAVITY: ["token", "oauth", "tokens", "credentials"],
  GROK: ["credentials", "auth", "tokens"],
  KIMI: ["credentials", "oauth", "tokens"],
  OPENROUTER: ["credentials"]
};

const SECRET_FIELDS: Readonly<Record<AcquisitionProvider, readonly string[]>> = {
  CLAUDE: ["accessToken", "access_token", "token"],
  CODEX: ["access_token", "accessToken"],
  GEMINI_CLI: ["access_token", "accessToken"],
  ANTIGRAVITY: ["access_token", "accessToken", "token"],
  GROK: ["access_token", "accessToken", "key"],
  KIMI: ["access_token", "accessToken"],
  OPENROUTER: ["key", "api_key", "apiKey"]
};

const ACCOUNT_FIELDS: readonly string[] = [
  "chatgpt_account_id",
  "account_id",
  "accountId",
  "user_id",
  "userId"
];

const EXPIRY_FIELDS: readonly string[] = [
  "expiresAt",
  "expires_at",
  "expiry_date",
  "expiry",
  "expires"
];

/** The issuer a Grok credential file should be read under when it names one. */
export const GROK_PREFERRED_ISSUER = "https://auth.x.ai";

/**
 * An expiry, whatever unit the document happened to state it in.
 *
 * Seconds, milliseconds and RFC3339 all appear across these six clients. A
 * value below the seconds ceiling is read as seconds, which is the same rule
 * every reset parser in this product already uses.
 */
export function expiryMilliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1_000) : Math.round(value);
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const trimmed = value.trim();
  if (/^\d{9,14}$/u.test(trimmed)) {
    return expiryMilliseconds(Number.parseInt(trimmed, 10));
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read one credential document that has already been parsed.
 *
 * Exported so a test can prove every shape without writing a file, and so the
 * Windows Credential Manager path can reuse exactly the same reader for the
 * envelope it gets back from the credential store.
 */
export function readCredentialDocument(
  provider: AcquisitionProvider,
  document: unknown,
  nowMilliseconds: number,
  origin: CredentialOrigin = "vendor_file"
): CredentialResult {
  const root = isRecord(document) ? document : null;
  if (root === null) return { ok: false, reason: "invalid" };
  const containers: Record<string, unknown>[] = [];
  for (const name of CONTAINERS[provider]) {
    const nested = root[name];
    if (isRecord(nested)) containers.push(nested);
  }
  containers.push(root);
  /*
   * Grok files seen in the wild key their credentials by issuer, because the
   * client can hold a login from more than one. The issuer this product wants
   * is named rather than guessed at, and a file with only one entry still
   * reads through the ordinary path below.
   */
  if (provider === "GROK") {
    const issuers = isRecord(root["issuers"]) ? root["issuers"] : root;
    const preferred = issuers[GROK_PREFERRED_ISSUER];
    if (isRecord(preferred)) containers.unshift(preferred);
  }
  for (const container of containers) {
    const secret = stringField(container, SECRET_FIELDS[provider]);
    if (secret === null) continue;
    const expiry = expiryMilliseconds(
      EXPIRY_FIELDS.map((name) => container[name]).find(
        (value) => value !== undefined
      ) ?? root["expiresAt"] ?? root["expires_at"]
    );
    if (expiry !== null && expiry <= nowMilliseconds) {
      return { ok: false, reason: "expired" };
    }
    const accountId = stringField(container, ACCOUNT_FIELDS) ??
      stringField(root, ACCOUNT_FIELDS);
    return {
      ok: true,
      credential: {
        secret,
        accountId,
        expiresAtMilliseconds: expiry,
        origin
      }
    };
  }
  return { ok: false, reason: "invalid" };
}

/**
 * Read the credential a provider's own client stored, from disk.
 *
 * The result is one of four things and never a mixture: a usable credential, a
 * provider that is simply not installed here, a document that could not be
 * believed, or a login that has run out. Nothing is refreshed and nothing is
 * written back.
 */
export async function readAcquisitionCredential(
  provider: AcquisitionProvider,
  options: CredentialLookupOptions = {}
): Promise<CredentialResult> {
  const context = resolve(options);
  const nowMilliseconds = Date.parse(options.now ?? new Date().toISOString());
  const clock = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
  if (provider === "ANTIGRAVITY" && context.platform === "win32") {
    const reader = options.readWindowsCredential;
    if (reader !== undefined) {
      const stored = await reader(ANTIGRAVITY_CREDENTIAL_TARGET);
      if (stored.ok) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stored.value) as unknown;
        } catch {
          return { ok: false, reason: "invalid" };
        }
        return readCredentialDocument(provider, parsed, clock, "vendor_store");
      }
      /* A credential store that answered "not here" still lets the Gemini file
         below stand in, which is what the Antigravity client itself falls back
         to on a machine where the store was never written. */
      if (stored.reason !== "absent") return stored;
    }
  }
  let firstFailure: CredentialFailureReason | null = null;
  for (const candidate of credentialCandidatePaths(provider, options)) {
    const document = await readJsonFileSafely(candidate, MAX_CREDENTIAL_FILE_BYTES);
    if (!document.ok) {
      if (document.reason !== "missing" && firstFailure === null) {
        firstFailure = "unreadable";
      }
      continue;
    }
    /* Antigravity reading the Gemini CLI's file is the shared Code Assist
       quota, not Antigravity's own login, and the row has to say so. */
    const result = readCredentialDocument(
      provider,
      document.value,
      clock,
      provider === "ANTIGRAVITY" ? "shared_code_assist" : "vendor_file"
    );
    if (result.ok) return result;
    if (firstFailure === null) firstFailure = result.reason;
  }
  if (firstFailure !== null) return { ok: false, reason: firstFailure };
  /*
   * Claude on macOS keeps its credential in the login keychain rather than in a
   * file, and reading it would raise an authorization prompt in the middle of a
   * status line render. That is a deliberate omission with a sentence attached,
   * not a silent miss, so the row can say why the poll did not happen.
   */
  if (provider === "CLAUDE" && context.platform === "darwin") {
    return { ok: false, reason: "keychain_not_read" };
  }
  return { ok: false, reason: "absent" };
}

/**
 * One sentence per failure, for the row a person actually reads.
 *
 * No dashes anywhere, and every sentence names the next step rather than the
 * internal reason, because a person cannot act on the word "invalid".
 */
export const CREDENTIAL_FAILURE_SENTENCE:
  Readonly<Record<CredentialFailureReason, string>> = {
  absent: "no local login found for this provider",
  unreadable: "the local login file could not be read",
  invalid: "the local login file was not in a shape this build understands",
  expired: "the local login has expired, open the provider's own tool once to refresh it",
  keychain_not_read:
    "the login is in the macOS keychain, which this command does not open"
};
