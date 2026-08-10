#!/usr/bin/env node
/**
 * Validate the provider capability registry.
 *
 * The registry is the product's answer to "which meters may this product even
 * have", and a surface that reads a malformed entry would either hide a meter
 * or invent one. So the entries are checked at build time, before anything
 * ships, and this script is wired into the root test script.
 *
 * Zero dependencies, deliberately. The specs are YAML because the audit asked
 * for YAML, and a full YAML parser would be a new dependency for two files, so
 * what follows reads a strict and very small subset of YAML and refuses
 * anything outside it rather than guessing. The subset is:
 *
 *   two space indentation, never tabs
 *   key: value pairs
 *   nested blocks under a key with a bare colon
 *   sequences of scalars and of maps, with a leading hyphen and one space
 *   scalars: unquoted text, "quoted" text, integers, decimals, true, false, null
 *   whole line comments beginning with a hash
 *
 * Anything else, including flow style, anchors, multi line strings and trailing
 * comments, is a hard error. A spec that a real YAML parser would read
 * differently from this one is a spec this script refuses.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specsRoot = path.join(repositoryRoot, "provider_specs");

class SpecError extends Error {}

function fail(where, message) {
  throw new SpecError(where + ": " + message);
}

/* ------------------------------------------------------------------ *
 * The YAML subset reader
 * ------------------------------------------------------------------ */

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Keys that must never reach an object, whatever a spec file says.
 *
 * A mapping key of __proto__ assigned onto an ordinary object literal does not
 * create a property, it walks the prototype chain and mutates it. That would
 * defeat the duplicate key check below, because the key never appears as an own
 * property, and it would let a required field resolve through the prototype so
 * a spec missing that field would validate. Every mapping is built with a null
 * prototype so the assignment is inert, and these three names are refused
 * outright so the attempt is loud rather than silent.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function readScalar(text, where) {
  /*
   * A trailing comment is not part of this subset. Swallowing one into a scalar
   * would silently give a field a value nobody wrote, so the space and hash
   * pair is refused. A hash with no space before it is left alone, because that
   * is a URL fragment.
   */
  if (text.includes(" #")) {
    fail(where, "inline trailing comments are not supported in this subset");
  }
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("[") || text.startsWith("{")) {
    fail(where, "flow style is not supported in this subset");
  }
  if (text.startsWith("&") || text.startsWith("*") || text.startsWith("!")) {
    fail(where, "anchors, aliases and tags are not supported in this subset");
  }
  if (text === "|" || text === ">") {
    fail(where, "block scalars are not supported in this subset");
  }
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    const inner = text.slice(1, -1);
    if (inner.includes("\\")) fail(where, "escape sequences are not supported");
    if (inner.includes(text[0])) fail(where, "nested quotes are not supported");
    return inner;
  }
  if (text.includes('"') || text.includes("'")) {
    fail(where, "a quote inside an unquoted scalar is not supported");
  }
  if (/^-?\d+$/u.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/u.test(text)) return Number.parseFloat(text);
  return text;
}

function splitKey(content, where) {
  /*
   * The colon that ends a key is the first one that ends the line or is
   * followed by a space. This is what keeps a value such as an https URL,
   * whose colon is followed by a slash, from being mistaken for a key.
   */
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== ":") continue;
    const next = content[index + 1];
    if (next === undefined || next === " ") {
      const key = content.slice(0, index);
      if (!KEY_PATTERN.test(key)) fail(where, "unsupported key " + JSON.stringify(key));
      if (FORBIDDEN_KEYS.has(key)) {
        fail(where, "the key " + key + " is refused because it reaches the prototype");
      }
      return { key, rest: content.slice(index + 1).trim() };
    }
  }
  return null;
}

function tokenize(text, file) {
  const tokens = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const where = file + " line " + String(index + 1);
    if (raw.includes("\t")) fail(where, "tabs are not allowed");
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed === "---" || trimmed === "...") {
      fail(where, "document markers are not supported in this subset");
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) fail(where, "indentation must be a multiple of two spaces");
    tokens.push({ indent, content: trimmed, where });
  }
  return tokens;
}

function parseBlock(tokens, start, indent) {
  const first = tokens[start];
  if (first === undefined) return { value: null, next: start };
  if (first.content === "-" || first.content.startsWith("- ")) {
    return parseSequence(tokens, start, indent);
  }
  return parseMapping(tokens, start, indent);
}

function parseMapping(tokens, start, indent) {
  /* Null prototype: nothing a spec writes can reach Object.prototype. */
  const value = Object.create(null);
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.indent < indent) break;
    if (token.indent > indent) fail(token.where, "unexpected indentation");
    if (token.content.startsWith("- ") || token.content === "-") {
      fail(token.where, "a sequence item cannot sit where a key belongs");
    }
    const split = splitKey(token.content, token.where);
    if (split === null) fail(token.where, "expected a key and a colon");
    if (Object.prototype.hasOwnProperty.call(value, split.key)) {
      fail(token.where, "duplicate key " + split.key);
    }
    if (split.rest !== "") {
      value[split.key] = readScalar(split.rest, token.where);
      index += 1;
      continue;
    }
    const child = tokens[index + 1];
    if (child === undefined || child.indent <= token.indent) {
      value[split.key] = null;
      index += 1;
      continue;
    }
    const parsed = parseBlock(tokens, index + 1, child.indent);
    value[split.key] = parsed.value;
    index = parsed.next;
  }
  return { value, next: index };
}

function parseSequence(tokens, start, indent) {
  const value = [];
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.indent < indent) break;
    if (token.indent > indent) fail(token.where, "unexpected indentation");
    if (token.content !== "-" && !token.content.startsWith("- ")) break;
    const rest = token.content === "-" ? "" : token.content.slice(2).trim();
    if (rest === "") {
      const child = tokens[index + 1];
      if (child === undefined || child.indent <= token.indent) {
        fail(token.where, "a sequence item needs a value");
      }
      const parsed = parseBlock(tokens, index + 1, child.indent);
      value.push(parsed.value);
      index = parsed.next;
      continue;
    }
    if (splitKey(rest, token.where) === null) {
      value.push(readScalar(rest, token.where));
      index += 1;
      continue;
    }
    /*
     * A map whose first key sits on the hyphen line. Rewriting that line as an
     * ordinary key two columns in turns it into the same shape as the keys
     * below it, so one mapping parser handles both.
     */
    const rewritten = tokens.slice();
    rewritten[index] = { indent: token.indent + 2, content: rest, where: token.where };
    const parsed = parseMapping(rewritten, index, token.indent + 2);
    value.push(parsed.value);
    index = parsed.next;
  }
  return { value, next: index };
}

export function parseYamlSubset(text, file) {
  const tokens = tokenize(text, file);
  if (tokens.length === 0) fail(file, "the document is empty");
  const base = tokens[0].indent;
  if (base !== 0) fail(tokens[0].where, "the document must start at column zero");
  const parsed = parseBlock(tokens, 0, 0);
  if (parsed.next !== tokens.length) {
    fail(tokens[parsed.next].where, "unexpected content after the document");
  }
  return parsed.value;
}

/* ------------------------------------------------------------------ *
 * The schema
 * ------------------------------------------------------------------ */

const SOURCE_STATUS = new Set(["official", "provisional", "community"]);
const READERS = new Set([
  "statusline_payload",
  "local_event",
  "local_file",
  "local_command",
  "official_remote_api",
  "gateway_observation",
  "manual",
  "explicit_import",
  "experimental"
]);
const AUTH_MODES = new Set([
  "existing_local_cli",
  "oauth",
  "api_key",
  "admin_api_key",
  "management_key",
  "cloud_identity",
  "manual",
  "none"
]);
const PLATFORMS = new Set(["windows", "macos", "linux"]);
const METER_KINDS = new Set([
  "subscription_quota",
  "api_spend",
  "api_budget",
  "credits",
  "request_rate",
  "token_rate",
  "token_usage",
  "request_usage",
  "context",
  "model_quota"
]);
const SCOPES = new Set([
  "account",
  "organization",
  "workspace",
  "project",
  "api_key",
  "model",
  "feature",
  "family_pool"
]);
const WINDOW_KINDS = new Set([
  "session",
  "rolling",
  "calendar_day",
  "calendar_week",
  "calendar_month",
  "billing_period",
  "credit_balance",
  "lifetime",
  "provider_defined"
]);
const RESET_ENCODINGS = new Set(["unix_seconds", "unix_milliseconds", "iso8601", "none"]);
const UNITS = new Set(["percent_used", "tokens", "requests", "currency"]);
const VERIFICATION_STATUS = new Set([
  "unverified",
  "beta",
  "verified",
  "import_only",
  "manual",
  "experimental",
  "planned"
]);

/*
 * The four independent support questions, from audit finding 4. A parser is not
 * a reader, a reader is not an auth flow, and none of the three is a
 * verification. Keeping them apart is what stops a working parser from being
 * displayed as a working connection.
 */
const PARSER_SUPPORT = new Set(["implemented", "absent"]);
const READER_SUPPORT = new Set(["implemented", "absent"]);
const AUTH_SUPPORT = new Set(["implemented", "not_required", "absent"]);

const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DOTTED_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const METER_CODE = /^[A-Z][A-Z0-9_]{0,31}$/u;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A real day on a real calendar, not just four digits and two pairs.
 *
 * The shape check alone accepts 2026-13-40, and worse it accepts 2026-02-30,
 * which JavaScript quietly rolls forward to the second of March. A review date
 * that means a different day from the one written is a review date nobody can
 * audit, so the parsed value has to print back exactly what was written.
 */
export function isCalendarDate(text) {
  if (typeof text !== "string" || !DATE.test(text)) return false;
  const parsed = new Date(text + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text;
}

function requireObject(value, where, field) {
  const inner = value[field];
  if (!isPlainObject(inner)) fail(where, field + " must be a block");
  return inner;
}

function requireString(value, where, field, allowed) {
  const inner = value[field];
  if (typeof inner !== "string" || inner === "") {
    fail(where, field + " must be a non empty string");
  }
  if (allowed !== undefined && !allowed.has(inner)) {
    fail(where, field + " has unknown value " + JSON.stringify(inner));
  }
  return inner;
}

function requireBoolean(value, where, field) {
  if (typeof value[field] !== "boolean") fail(where, field + " must be true or false");
  return value[field];
}

function requireArray(value, where, field) {
  const inner = value[field];
  if (!Array.isArray(inner) || inner.length === 0) {
    fail(where, field + " must be a non empty list");
  }
  return inner;
}

function validateMeter(meter, where) {
  if (!isPlainObject(meter)) fail(where, "each meter must be a block");
  const id = requireString(meter, where, "id");
  if (!IDENTIFIER.test(id)) fail(where, "meter id " + id + " is not a safe identifier");
  const at = where + " meter " + id;
  requireString(meter, at, "label");
  requireString(meter, at, "kind", METER_KINDS);
  requireString(meter, at, "unit", UNITS);
  requireString(meter, at, "scope", SCOPES);
  const window = requireObject(meter, at, "window");
  const windowKind = requireString(window, at + " window", "kind", WINDOW_KINDS);
  if (windowKind === "rolling") {
    const duration = window["duration_seconds"];
    if (!Number.isInteger(duration) || duration <= 0 || duration > 31_536_000) {
      fail(at + " window", "a rolling window needs a duration in seconds");
    }
  }
  const sourcePath = requireString(meter, at, "source_path");
  if (!DOTTED_PATH.test(sourcePath)) fail(at, "source_path is not a dotted path");
  const resetPath = meter["reset_path"];
  if (resetPath !== null && typeof resetPath !== "string") {
    fail(at, "reset_path must be a dotted path or null");
  }
  if (typeof resetPath === "string" && !DOTTED_PATH.test(resetPath)) {
    fail(at, "reset_path is not a dotted path");
  }
  const encoding = requireString(meter, at, "reset_encoding", RESET_ENCODINGS);
  /*
   * A reset path with no encoding cannot be read, and an encoding with no path
   * has nothing to read. Either mistake would silently cost a reset countdown,
   * so the pair has to agree.
   */
  if (resetPath === null && encoding !== "none") {
    fail(at, "a meter with no reset path must state reset_encoding none");
  }
  if (typeof resetPath === "string" && encoding === "none") {
    fail(at, "a meter with a reset path must state how it is encoded");
  }
  const optional = requireBoolean(meter, at, "optional");
  const code = meter["meter_code"];
  if (code !== undefined && (typeof code !== "string" || !METER_CODE.test(code))) {
    fail(at, "meter_code must match the normalizer's meter name rule");
  }
  /* The compiled shape a surface reads. Ordinary object, ordinary key order. */
  return {
    id,
    label: meter["label"],
    kind: meter["kind"],
    unit: meter["unit"],
    scope: meter["scope"],
    window: windowKind === "rolling"
      ? { kind: windowKind, durationSeconds: window["duration_seconds"] }
      : { kind: windowKind },
    optional,
    meterCode: typeof code === "string" ? code : null
  };
}

function validateSpec(document, file, relative) {
  if (!isPlainObject(document)) fail(file, "the document must be a block");
  const providerId = requireString(document, file, "provider_id");
  const productId = requireString(document, file, "product_id");
  if (!IDENTIFIER.test(providerId)) fail(file, "provider_id is not a safe identifier");
  if (!IDENTIFIER.test(productId)) fail(file, "product_id is not a safe identifier");
  const expected = providerId + "/" + productId + ".yaml";
  if (relative !== expected) {
    fail(file, "the path must be provider_specs/" + expected);
  }
  requireString(document, file, "display_name");

  const source = requireObject(document, file, "source");
  const status = requireString(source, file + " source", "source_status", SOURCE_STATUS);
  const reviewedAt = requireString(source, file + " source", "reviewed_at");
  if (!isCalendarDate(reviewedAt)) {
    fail(file + " source", "reviewed_at must be a real calendar date, YYYY-MM-DD");
  }
  const docsUrl = source["docs_url"];
  if (status === "official") {
    if (typeof docsUrl !== "string" || !docsUrl.startsWith("https://")) {
      fail(file + " source", "an official source needs an https docs_url");
    }
  } else if (docsUrl !== null && typeof docsUrl !== "string") {
    fail(file + " source", "docs_url must be a string or null");
  }

  const availability = requireObject(document, file, "availability");
  requireString(availability, file + " availability", "requires_plan");
  requireString(availability, file + " availability", "appears_after");
  requireBoolean(availability, file + " availability", "absence_is_error");

  const connectionReaders = [];
  const connectionAuthModes = [];
  const platformSet = new Set();
  for (const connection of requireArray(document, file, "connections")) {
    if (!isPlainObject(connection)) fail(file, "each connection must be a block");
    connectionReaders.push(
      requireString(connection, file + " connection", "reader", READERS)
    );
    connectionAuthModes.push(
      requireString(connection, file + " connection", "auth_mode", AUTH_MODES)
    );
    for (const platform of requireArray(connection, file + " connection", "platforms")) {
      if (typeof platform !== "string" || !PLATFORMS.has(platform)) {
        fail(file + " connection", "unknown platform " + JSON.stringify(platform));
      }
      platformSet.add(platform);
    }
  }
  const connectionPlatforms = [...platformSet].sort();

  const verification = requireObject(document, file, "verification");
  const verificationStatus = requireString(
    verification,
    file + " verification",
    "verification_status",
    VERIFICATION_STATUS
  );
  const lastVerified = verification["last_verified_at"];
  if (lastVerified !== null && !isCalendarDate(lastVerified)) {
    fail(file + " verification", "last_verified_at must be a real calendar date or null");
  }
  /*
   * The claim the whole audit turns on. A product may only be called verified
   * once a human has recorded the day it was checked against a real account.
   */
  if (verificationStatus === "verified" && lastVerified === null) {
    fail(file + " verification", "verified needs a last_verified_at date");
  }
  requireArray(verification, file + " verification", "fixture_ids");

  const support = requireObject(document, file, "support");
  const parser = requireString(support, file + " support", "parser", PARSER_SUPPORT);
  const reader = requireString(support, file + " support", "reader", READER_SUPPORT);
  const auth = requireString(support, file + " support", "auth", AUTH_SUPPORT);
  /*
   * The one combination that would be a lie. Calling a product verified while
   * stating that nothing can read it means the verification was of a paste.
   */
  if (verificationStatus === "verified" && reader === "absent") {
    fail(file, "a product with no reader cannot be verified");
  }

  const ids = new Set();
  const meters = [];
  for (const meter of requireArray(document, file, "meters")) {
    const compiled = validateMeter(meter, file);
    if (ids.has(compiled.id)) fail(file, "duplicate meter id " + compiled.id);
    ids.add(compiled.id);
    meters.push(compiled);
  }

  return {
    id: providerId + "/" + productId,
    providerId,
    productId,
    displayName: document["display_name"],
    docsUrl: typeof docsUrl === "string" ? docsUrl : null,
    reviewedAt,
    sourceStatus: status,
    support: { parser, reader, auth, verification: verificationStatus },
    lastVerifiedAt: lastVerified,
    readers: connectionReaders,
    authModes: connectionAuthModes,
    platforms: connectionPlatforms,
    meters
  };
}

/* ------------------------------------------------------------------ *
 * Parser self check
 * ------------------------------------------------------------------ */

const SELF_TEST_DOCUMENT = `# comment
provider_id: sample
source:
  docs_url: https://example.test/docs#section
  reviewed_at: "2026-08-10"
  empty_value: null
  count: 12
  ratio: 1.5
  flag: true
list:
  - one
  - two
blocks:
  - key: first
    nested:
      deep: 1
  - key: second
    nested:
      deep: 2
`;

const SELF_TEST_EXPECTED = {
  provider_id: "sample",
  source: {
    docs_url: "https://example.test/docs#section",
    reviewed_at: "2026-08-10",
    empty_value: null,
    count: 12,
    ratio: 1.5,
    flag: true
  },
  list: ["one", "two"],
  blocks: [
    { key: "first", nested: { deep: 1 } },
    { key: "second", nested: { deep: 2 } }
  ]
};

function selfTest() {
  const parsed = parseYamlSubset(SELF_TEST_DOCUMENT, "<self test>");
  const actual = JSON.stringify(parsed);
  const expected = JSON.stringify(SELF_TEST_EXPECTED);
  if (actual !== expected) {
    throw new Error(
      "the YAML subset reader is wrong\n  expected " + expected + "\n  actual   " + actual
    );
  }
  const rejects = [
    "key:\tvalue",
    "key: [1, 2]",
    " key: value",
    "key: value\n   nested: value",
    "no colon here",
    /* Prototype pollution, in the three shapes a spec could try. */
    "__proto__:\n  polluted: true",
    "__proto__: polluted",
    "constructor:\n  prototype:\n    polluted: true",
    "meters:\n  - id: one\n    __proto__: polluted",
    /* Trailing comments, which would otherwise become part of a value. */
    "key: value # comment",
    "reviewed_at: \"2026-08-10\" # reviewed by hand"
  ];
  for (const document of rejects) {
    let refused = false;
    try {
      parseYamlSubset(document, "<self test>");
    } catch (error) {
      refused = error instanceof SpecError;
    }
    if (!refused) {
      throw new Error("the reader accepted something it must refuse: " + document);
    }
  }
  /* Nothing above may have touched the prototype on its way to being refused. */
  if ({}["polluted"] !== undefined || Object.prototype["polluted"] !== undefined) {
    throw new Error("the reader polluted Object.prototype");
  }
  const parsedMapping = parseYamlSubset("key: value", "<self test>");
  if (Object.getPrototypeOf(parsedMapping) !== null) {
    throw new Error("mappings must be built without a prototype");
  }
  const badDates = ["2026-13-40", "2026-02-30", "2026-00-10", "2026-04-31", "not a date"];
  for (const text of badDates) {
    if (isCalendarDate(text)) throw new Error("accepted a date that does not exist: " + text);
  }
  if (!isCalendarDate("2026-08-10") || !isCalendarDate("2024-02-29")) {
    throw new Error("refused a real calendar date");
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function specFiles() {
  const found = [];
  const providers = await readdir(specsRoot, { withFileTypes: true });
  for (const provider of providers) {
    if (!provider.isDirectory()) continue;
    const directory = path.join(specsRoot, provider.name);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".yaml")) {
        found.push({ path: path.join(directory, entry.name), unexpected: true });
        continue;
      }
      found.push({
        path: path.join(directory, entry.name),
        relative: provider.name + "/" + entry.name,
        unexpected: false
      });
    }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/* ------------------------------------------------------------------ *
 * The compiled artifact
 * ------------------------------------------------------------------ */

/**
 * Where the compiled registry is written.
 *
 * A top level file rather than one inside a provider directory, so the scan
 * above, which only descends into directories, never mistakes it for a spec.
 */
export const COMPILED_FILE = path.join(specsRoot, "provider-specs.json");

/**
 * Version of the compiled shape, for the surfaces that read it.
 *
 * Separate from any spec's own review date: this number changes when the shape
 * of this file changes, not when a provider's facts do.
 */
const COMPILED_SCHEMA = 1;

/**
 * The support matrix, compiled from the YAML into one file a surface imports.
 *
 * The site's connection matrix, the desktop's connection cards and the docs all
 * have to say the same thing about which providers work, and the way that goes
 * wrong is three surfaces each keeping their own list until one of them quietly
 * claims a provider is live. So there is one file, it is generated, and it is
 * never edited by hand: the check below fails when it drifts from the YAML,
 * which means a spec change that is not compiled cannot reach a release.
 */
function compileRegistry(entries) {
  return JSON.stringify(
    {
      schema: COMPILED_SCHEMA,
      note: "Generated from provider_specs/**/*.yaml by " +
        "scripts/validate-provider-specs.mjs. Do not edit by hand. " +
        "Regenerate with: node scripts/validate-provider-specs.mjs --emit",
      providers: [...entries].sort((left, right) => left.id.localeCompare(right.id))
    },
    null,
    2
  ) + "\n";
}

async function readCompiled() {
  try {
    return await readFile(COMPILED_FILE, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  selfTest();
  const emit = process.argv.includes("--emit");
  const files = await specFiles();
  if (files.length === 0) {
    console.error("FAIL provider_specs holds no spec files");
    process.exitCode = 1;
    return;
  }
  const seen = new Map();
  const problems = [];
  const compiled = [];
  for (const file of files) {
    const shown = path.relative(repositoryRoot, file.path).split(path.sep).join("/");
    if (file.unexpected) {
      problems.push(shown + ": only .yaml spec files belong in provider_specs");
      continue;
    }
    try {
      const text = await readFile(file.path, "utf8");
      const document = parseYamlSubset(text, shown);
      const entry = validateSpec(document, shown, file.relative);
      if (seen.has(entry.id)) {
        problems.push(shown + ": duplicate provider and product of " + seen.get(entry.id));
      }
      seen.set(entry.id, shown);
      compiled.push(entry);
      console.log("PASS " + shown);
    } catch (error) {
      problems.push(error instanceof SpecError ? error.message : String(error));
    }
  }

  /*
   * The artifact is only written or compared once every spec validated. Half a
   * registry is worse than a stale one, because a surface reading it would show
   * a shorter support matrix and quietly drop a provider.
   */
  if (problems.length === 0) {
    const wanted = compileRegistry(compiled);
    const current = await readCompiled();
    const shown = path.relative(repositoryRoot, COMPILED_FILE)
      .split(path.sep).join("/");
    if (emit) {
      if (current === wanted) {
        console.log("PASS " + shown + " already current");
      } else {
        await writeFile(COMPILED_FILE, wanted, "utf8");
        console.log("WROTE " + shown);
      }
    } else if (current === null) {
      problems.push(shown + " is missing. Run: node " +
        "scripts/validate-provider-specs.mjs --emit");
    } else if (current !== wanted) {
      problems.push(shown + " is stale relative to the yaml. Run: node " +
        "scripts/validate-provider-specs.mjs --emit");
    } else {
      console.log("PASS " + shown + " matches the yaml");
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error("FAIL " + problem);
    console.error(
      "FAIL " + String(problems.length) + " provider spec problem(s) found"
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "PASS " + String(files.length) + " provider spec(s) validated"
  );
}

await main();
