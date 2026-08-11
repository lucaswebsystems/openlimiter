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

/*
 * Addresses may not appear in a specification at all, comments included.
 *
 * The tokenizer drops comment lines before anything else sees them, so a
 * literal runtime URL could sit in a spec forever without any check noticing.
 * That matters more than it looks. The whole claim of this registry is that it
 * cannot influence where a credential is sent, and a file whose comments print
 * the exact address a reader uses is a file that reads, to a human, as the
 * place addresses are configured. Somebody eventually moves the value out of
 * the comment and into a key.
 *
 * A docs_url is the one exception, because a link to a provider's published
 * documentation is the opposite of a runtime address: it is how a reviewer
 * checks the shape by hand. So it is allowed on that key alone, and refused
 * everywhere else, comments included.
 */
const URL_LITERAL = /\bhttps?:\/\//giu;

export function refuseUrlLiterals(text, file) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    URL_LITERAL.lastIndex = 0;
    if (!URL_LITERAL.test(line)) continue;
    if (/^\s*docs_url:/u.test(line)) continue;
    fail(
      file + " line " + String(index + 1),
      "a specification may not contain a literal address. Every URL is a Rust " +
        "constant in apps/desktop/src-tauri/src/net.rs; naming one here, even " +
        "in a comment, makes this file look like where addresses are configured"
    );
  }
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
const RESET_ENCODINGS = new Set([
  "unix_seconds",
  "unix_milliseconds",
  "iso8601",
  "rfc3339",
  "duration_words",
  "none"
]);

/*
 * Where a meter's number lives in whatever the provider returned.
 *
 * `json_path` is the ordinary case and keeps the dotted path rule. `html_label`
 * exists for exactly one provider: OpenCode publishes no interface at all, so
 * its meters are found by the LABEL rendered beside them on a logged in page.
 * A dotted path cannot describe that, and writing one anyway would be the
 * registry stating a location that does not exist. A meter that is found by
 * label carries `source_label` and no `source_path`.
 */
const SOURCE_FORMATS = new Set(["json_path", "html_label"]);
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

/*
 * The collection vocabularies, frozen.
 *
 * These three sets are the registry's half of one identifier that also exists
 * as a Rust enum in apps/desktop/src-tauri/src/reader_registry.rs and as a
 * frozen list in apps/desktop/ui/backend.js. Spelling one of them differently
 * in any of the three places is how a reader ends up selecting the wrong
 * parser, so all three are closed and all three are checked.
 *
 * What is deliberately NOT here: a URL, a method, a header, a permitted status.
 * Those are Rust constants. A registry that could state an address would be a
 * registry that could redirect a credential, and this file is edited far more
 * often, and reviewed far less carefully, than the network layer.
 */
const READER_IDS = new Set([
  "openrouter_key",
  "openrouter_credits",
  "codex_usage",
  "antigravity_quota",
  "opencode_usage"
]);
const ENDPOINT_IDS = new Set([
  "openrouter_key",
  "openrouter_credits",
  "codex_usage",
  "antigravity_quota",
  "opencode_usage"
]);
const CREDENTIAL_KINDS = new Set([
  "openrouter_inference_key",
  "openrouter_management_key",
  "codex_session",
  "antigravity_session",
  "opencode_browser_session"
]);
const COLLECTION_SUPPORT = new Set(["implemented"]);

/*
 * The honesty vocabularies, mirroring ConnectorLabels in
 * packages/core/src/types.ts. Closed, because these four words are the ones a
 * person reads to decide whether to trust a number, and a surface that could
 * invent a fifth could soften any of them.
 */
const CREDENTIAL_ORIGINS = new Set([
  "official-local-tool",
  "user-key",
  "browser-session",
  "user-entered"
]);
const DATA_INTERFACE_STATUSES = new Set([
  "native-statusline-payload",
  "documented-api",
  "internal-endpoint",
  "authenticated-scrape",
  "manual"
]);
const AUTOMATION_RISKS = new Set(["low", "high"]);
const CONNECTOR_IDS = new Set([
  "claude",
  "openrouter",
  "codex",
  "antigravity",
  "opencode",
  "manual"
]);
const HONESTY_KEYS = new Set([
  "connector_id",
  "credential_origin",
  "data_interface_status",
  "automation_risk",
  "verification"
]);

/*
 * How the evidence behind a live reader stands today.
 *
 *   documented      the provider publishes the response shape.
 *   captured        a sanitized capture from a real account is in the tree.
 *   pending_capture the request contract is known and no sanitized response
 *                   has been committed. The reader may ship; the provider
 *                   stays UNVERIFIED and this file says so out loud.
 *
 * pending_capture is a real state rather than a hole because inventing a
 * capture is the exact fault the fixture classes exist to prevent. Run this
 * script with --require-captures to make it fatal, which is what the release
 * gate does.
 */
const EVIDENCE_STATUS = new Set(["documented", "captured", "pending_capture"]);

/*
 * The interface honesty labels that may never sit beside a documented API
 * claim. A provider whose connector says it reads an internal endpoint or
 * scrapes an authenticated page has not got an official interface, whatever
 * its source_status says, and the two must not disagree.
 */
const UNOFFICIAL_READERS = new Set(["experimental", "gateway_observation"]);

/*
 * Readers that never leave the machine.
 *
 * A local reader has no address, no credential kind and no endpoint, so the
 * collection block does not apply to it: the block exists to pin down where a
 * secret is sent, and these send nothing anywhere. A spec whose connections are
 * all local therefore ships a reader with no block, correctly.
 */
const LOCAL_READERS = new Set([
  "statusline_payload",
  "local_event",
  "local_file",
  "local_command",
  "manual",
  "explicit_import"
]);

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
  /*
   * Absent means json_path, so every spec written before a scraped provider
   * existed still validates and still means what it said.
   */
  const sourceFormat = meter["source_format"] === undefined
    ? "json_path"
    : requireString(meter, at, "source_format", SOURCE_FORMATS);
  const sourcePath = meter["source_path"];
  const sourceLabel = meter["source_label"];
  if (sourceFormat === "json_path") {
    if (typeof sourcePath !== "string" || !DOTTED_PATH.test(sourcePath)) {
      fail(at, "source_path is not a dotted path");
    }
    if (sourceLabel !== undefined) {
      fail(at, "a json_path meter has no source_label");
    }
  } else {
    if (typeof sourceLabel !== "string" || sourceLabel === "") {
      fail(at, "an html_label meter must state the source_label it is found by");
    }
    if (sourcePath !== undefined && sourcePath !== null) {
      fail(at, "an html_label meter has no source_path, because there is no path");
    }
  }
  const resetPath = meter["reset_path"];
  if (resetPath !== null && typeof resetPath !== "string") {
    fail(at, "reset_path must be a dotted path or null");
  }
  if (typeof resetPath === "string" && sourceFormat === "json_path" &&
      !DOTTED_PATH.test(resetPath)) {
    fail(at, "reset_path is not a dotted path");
  }
  const encoding = requireString(meter, at, "reset_encoding", RESET_ENCODINGS);
  /*
   * A reset path with no encoding cannot be read, and an encoding with no path
   * has nothing to read. Either mistake would silently cost a reset countdown,
   * so the pair has to agree.
   */
  if (sourceFormat === "json_path") {
    if (resetPath === null && encoding !== "none") {
      fail(at, "a meter with no reset path must state reset_encoding none");
    }
    if (typeof resetPath === "string" && encoding === "none") {
      fail(at, "a meter with a reset path must state how it is encoded");
    }
  } else {
    /*
     * A scraped meter's reset has no path either: it is a countdown rendered
     * beside the label, so the encoding says how to read the words and the path
     * stays null. Only that one encoding makes sense here, and stating any
     * other would be claiming a document shape that does not exist.
     */
    if (resetPath !== null) {
      fail(at, "an html_label meter has no reset path, because there is no path");
    }
    if (encoding !== "duration_words" && encoding !== "none") {
      fail(at, "an html_label meter reads its reset as duration_words, or not at all");
    }
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
    sourceFormat,
    window: windowKind === "rolling"
      ? { kind: windowKind, durationSeconds: window["duration_seconds"] }
      : { kind: windowKind },
    optional,
    meterCode: typeof code === "string" ? code : null
  };
}

function validateSpec(document, file, relative, fixtureIds) {
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
   * The collection block: present exactly when a live reader ships, absent
   * exactly when one does not. Both halves are checked, because a block with
   * no reader would publish a route nothing implements, and a reader with no
   * block would ship an address no surface can describe.
   */
  const collectionBlock = document["collection"];
  const at = file + " collection";
  let collection = null;
  if (collectionBlock !== undefined && collectionBlock !== null) {
    if (!isPlainObject(collectionBlock)) fail(at, "collection must be a block");
    for (const key of Object.keys(collectionBlock)) {
      if (!["reader", "auth", "readers"].includes(key)) {
        fail(at, "collection may not carry " + key);
      }
    }
    /* A reader is not an auth flow. Shipping the first without the second is
       a connection that can be pointed somewhere and never authenticated. */
    requireString(collectionBlock, at, "reader", COLLECTION_SUPPORT);
    requireString(collectionBlock, at, "auth", COLLECTION_SUPPORT);
    /*
     * A LIST, because a product can ship more than one reader against one
     * account. OpenRouter does: an inference key reads its own limit and a
     * management key reads the account's credits, two addresses and two
     * credential kinds under one provider. A single valued block could only
     * ever describe one of them, and the half it left out would be a live
     * reader no surface could name.
     */
    /*
     * Nothing but these keys, ever.
     *
     * The point of this block is to say WHICH closed identifier a reader uses,
     * never where it goes. Without this check a spec could carry a url, a
     * method or a headers block: the compiler would drop them silently, and the
     * file would read to a human as though the registry decided the address.
     * A registry that appears to name a destination is one somebody will
     * eventually wire up.
     */
    const READER_KEYS = new Set([
      "reader_id",
      "endpoint_id",
      "credential_kind",
      "evidence_fixture",
      "evidence_status",
      "last_verified_at"
    ]);
    const entries = requireArray(collectionBlock, at, "readers");
    const readers = [];
    const seenReaders = new Set();
    const seenCredentials = new Set();
    const seenEndpoints = new Set();
    for (const entry of entries) {
      if (!isPlainObject(entry)) fail(at, "each reader must be a block");
      for (const key of Object.keys(entry)) {
        if (!READER_KEYS.has(key)) {
          fail(at, "a reader may not carry " + key +
            ": an address is a Rust constant, never a registry value");
        }
      }
      const readerId = requireString(entry, at, "reader_id", READER_IDS);
      const endpointId = requireString(entry, at, "endpoint_id", ENDPOINT_IDS);
      const credentialKind =
        requireString(entry, at, "credential_kind", CREDENTIAL_KINDS);
      const evidenceFixture = requireString(entry, at, "evidence_fixture");
      const evidenceStatus =
        requireString(entry, at, "evidence_status", EVIDENCE_STATUS);
      const readerVerifiedAt = entry["last_verified_at"];
      if (readerVerifiedAt !== null && !isCalendarDate(readerVerifiedAt)) {
        fail(at, "last_verified_at must be a real calendar date or null");
      }
      /* A reviewed date on a reader nobody has captured would be a date about
         nothing. It is allowed only once the evidence is real. */
      if (evidenceStatus === "pending_capture" && readerVerifiedAt !== null) {
        fail(at, "a pending capture cannot carry a last_verified_at date");
      }
      if (evidenceStatus !== "pending_capture" && readerVerifiedAt === null) {
        fail(at, "evidence that exists must state the day it was last verified");
      }
      /* One reader is one address is one credential. Two entries sharing
         either would mean the routing table could not tell them apart. */
      if (seenReaders.has(readerId)) fail(at, "duplicate reader_id " + readerId);
      seenReaders.add(readerId);
      if (seenCredentials.has(credentialKind)) {
        fail(at, "duplicate credential_kind " + credentialKind);
      }
      seenCredentials.add(credentialKind);
      /* An endpoint is one destination. Two readers of one product sharing it
         would mean two credentials reaching the same address, which is the
         pairing the whole routing table exists to keep apart. */
      if (seenEndpoints.has(endpointId)) fail(at, "duplicate endpoint_id " + endpointId);
      seenEndpoints.add(endpointId);
      /* The fixture named here has to be a fixture that exists. */
      if (!fixtureIds.has(evidenceFixture)) {
        fail(at, "evidence_fixture " + evidenceFixture +
          " names no fixture in packages/connectors/src/fixtures.ts");
      }
      /* And it has to be one this spec already claims. */
      const claimed = verification["fixture_ids"];
      if (Array.isArray(claimed) && !claimed.includes(evidenceFixture)) {
        fail(at, "evidence_fixture " + evidenceFixture +
          " is not among this spec's verification fixture_ids");
      }
      readers.push({
        readerId,
        endpointId,
        credentialKind,
        evidenceFixture,
        evidenceStatus,
        lastVerifiedAt: readerVerifiedAt
      });
    }
    if (reader !== "implemented") {
      fail(file, "a spec with a collection block must state support.reader implemented");
    }
    if (auth !== "implemented") {
      fail(file, "a live reader needs an implemented authentication path");
    }
    collection = { readers };
  } else if (
    reader === "implemented" &&
    !connectionReaders.every((entry) => LOCAL_READERS.has(entry))
  ) {
    fail(
      file,
      "a shipped remote reader must publish a collection block naming its " +
        "reader_id, endpoint_id, credential_kind and evidence fixture"
    );
  }

  /*
   * A provider cannot call its interface official while its own connections
   * describe an experiment or a gateway observation. The label and the claim
   * have to agree, because the label is what a person reads.
   */
  if (status === "official" && connectionReaders.some((entry) => UNOFFICIAL_READERS.has(entry))) {
    fail(file, "a documented source cannot also declare an unofficial reader");
  }
  /*
   * The one combination that would be a lie. Calling a product verified while
   * stating that nothing can read it means the verification was of a paste.
   */
  if (verificationStatus === "verified" && reader === "absent") {
    fail(file, "a product with no reader cannot be verified");
  }

  /*
   * The honesty block, present exactly when a spec describes a shipped
   * connector. A spec without one is research: it documents an interface
   * nothing in this repository reads, so it has no labels to print.
   */
  const honestyBlock = document["honesty"];
  let honesty = null;
  if (honestyBlock !== undefined && honestyBlock !== null) {
    const where = file + " honesty";
    if (!isPlainObject(honestyBlock)) fail(where, "honesty must be a block");
    for (const key of Object.keys(honestyBlock)) {
      if (!HONESTY_KEYS.has(key)) fail(where, "honesty may not carry " + key);
    }
    const connectorId = requireString(honestyBlock, where, "connector_id", CONNECTOR_IDS);
    const credentialOrigin =
      requireString(honestyBlock, where, "credential_origin", CREDENTIAL_ORIGINS);
    const dataInterfaceStatus =
      requireString(honestyBlock, where, "data_interface_status", DATA_INTERFACE_STATUSES);
    const automationRisk =
      requireString(honestyBlock, where, "automation_risk", AUTOMATION_RISKS);
    /*
     * One value, always. Nothing in this product has earned any other, and a
     * spec that could write "verified" here could do it without a human ever
     * checking an account.
     */
    const verification = requireString(honestyBlock, where, "verification");
    if (verification !== "UNVERIFIED") {
      fail(where, "verification is UNVERIFIED until a verifier exists");
    }
    /* A scrape or an internal endpoint is never low risk. The pair would read
       as reassurance nobody is entitled to. */
    if (
      (dataInterfaceStatus === "authenticated-scrape" ||
        dataInterfaceStatus === "internal-endpoint") &&
      automationRisk !== "high"
    ) {
      fail(where, dataInterfaceStatus + " cannot be anything but high risk");
    }
    honesty = {
      connectorId,
      credentialOrigin,
      dataInterfaceStatus,
      automationRisk,
      verification
    };
  } else if (status === "provisional" && reader === "implemented") {
    fail(file, "a shipped reader must publish its honesty labels");
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
    collection,
    honesty,
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

/*
 * The web app deploys standalone from apps/web, where a path above the app
 * root does not exist at build time, so the artifact is mirrored into the
 * app and both copies are held to the same emit and drift rules. One source
 * of truth, two identical bytes on disk.
 */
export const ARTIFACT_FILES = [
  COMPILED_FILE,
  path.join(repositoryRoot, "apps", "web", "lib", "provider-specs.generated.json")
];

/*
 * The desktop window's copy.
 *
 * A module rather than JSON, because the window loads files directly with no
 * bundler and no fetch: an import is the only way it can read this. Same bytes
 * of payload as the canonical artifact, and compared against it on every run,
 * so a desktop card can never render a label the registry does not state. It
 * existed as a requirement and not as a file until now, which is exactly how
 * the honesty labels ended up hard coded in two places.
 */
export const DESKTOP_ARTIFACT_FILE = path.join(
  repositoryRoot, "apps", "desktop", "ui", "provider-specs.generated.js"
);

function compileDesktopRegistry(json) {
  return "/*\n" +
    " * Generated from provider_specs by scripts/validate-provider-specs.mjs.\n" +
    " * Do not edit by hand.\n" +
    " * Regenerate with: node scripts/validate-provider-specs.mjs --emit\n" +
    " *\n" +
    " * The desktop window renders honesty labels from here and from nowhere\n" +
    " * else. Hard coding one in index.html or app.js is how a surface ends up\n" +
    " * softening a word the registry froze.\n" +
    " */\n" +
    "export const PROVIDER_SPECS = " + json.trimEnd() + ";\n";
}

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

async function readTarget(target) {
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

/**
 * Where the fixture classes live, so a named fixture can be proven to exist.
 *
 * Read as text rather than imported: this script has zero dependencies and
 * runs before anything is compiled, so it cannot load TypeScript. Every fixture
 * declares its own `id`, and the ids are what this collects, so deleting a
 * fixture that a spec names is caught here rather than at run time.
 */
export const FIXTURES_FILE = path.join(
  repositoryRoot, "packages", "connectors", "src", "fixtures.ts"
);

const FIXTURE_ID_PATTERN = /\bid:\s*"([a-z0-9_.-]+)"/gu;

async function readFixtureIds() {
  const text = await readFile(FIXTURES_FILE, "utf8");
  const found = new Set();
  for (const match of text.matchAll(FIXTURE_ID_PATTERN)) found.add(match[1]);
  return found;
}

async function main() {
  selfTest();
  const emit = process.argv.includes("--emit");
  /*
   * The release gate's switch. Off, a live reader whose sanitized capture has
   * not been taken passes with a loud WARN. On, it fails. Off is the default so
   * that the rest of the suite can run while a capture is outstanding; the
   * release gate turns it on, and the WARN below is never silent either way.
   */
  const requireCaptures = process.argv.includes("--require-captures");
  const fixtureIds = await readFixtureIds();
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
      /* Before parsing, because this reads the raw bytes including the comment
         lines the tokenizer is about to discard. */
      refuseUrlLiterals(text, shown);
      const document = parseYamlSubset(text, shown);
      const entry = validateSpec(document, shown, file.relative, fixtureIds);
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
   * Live readers still standing on an uncaptured interface. Reported every run,
   * fatal only under --require-captures, and never quietly dropped: this list
   * is the honest answer to "which of these numbers has anybody actually seen".
   */
  /*
   * Closed identifiers are closed across the WHOLE registry, not per file.
   *
   * Each of these names one thing in the Rust routing table: one reader, one
   * destination, one kind of credential. Two specifications claiming the same
   * one would compile without complaint and leave two products believing they
   * own the same address, which the per file checks above cannot see.
   */
  const globallyUnique = new Map();
  for (const entry of compiled) {
    if (entry.collection === null) continue;
    for (const reader of entry.collection.readers) {
      for (const [field, value] of [
        ["reader_id", reader.readerId],
        ["endpoint_id", reader.endpointId],
        ["credential_kind", reader.credentialKind]
      ]) {
        const key = field + " " + value;
        const owner = globallyUnique.get(key);
        if (owner !== undefined && owner !== entry.id) {
          problems.push(
            entry.id + ": " + field + " " + value +
              " is already claimed by " + owner +
              ". A closed identifier names one thing in the whole registry."
          );
        }
        globallyUnique.set(key, entry.id);
      }
    }
  }

  const pending = [];
  for (const entry of compiled) {
    if (entry.collection === null) continue;
    for (const reader of entry.collection.readers) {
      if (reader.evidenceStatus !== "pending_capture") continue;
      pending.push(entry.id + ": live reader " + reader.readerId +
        " ships on a PENDING sanitized capture, so it stays UNVERIFIED");
    }
  }
  for (const sentence of pending) {
    if (requireCaptures) {
      problems.push(sentence);
    } else {
      console.log("WARN " + sentence);
    }
  }

  /*
   * The artifact is only written or compared once every spec validated. Half a
   * registry is worse than a stale one, because a surface reading it would show
   * a shorter support matrix and quietly drop a provider.
   */
  if (problems.length === 0) {
    const wanted = compileRegistry(compiled);
    const desktopWanted = compileDesktopRegistry(wanted);
    for (const target of [...ARTIFACT_FILES, DESKTOP_ARTIFACT_FILE]) {
      const isDesktop = target === DESKTOP_ARTIFACT_FILE;
      const expected = isDesktop ? desktopWanted : wanted;
      const current = await readTarget(target);
      const shown = path.relative(repositoryRoot, target)
        .split(path.sep).join("/");
      if (emit) {
        if (current === expected) {
          console.log("PASS " + shown + " already current");
        } else {
          await writeFile(target, expected, "utf8");
          console.log("WROTE " + shown);
        }
      } else if (current === null) {
        problems.push(shown + " is missing. Run: node " +
          "scripts/validate-provider-specs.mjs --emit");
      } else if (current !== expected) {
        problems.push(shown + " is stale relative to the yaml. Run: node " +
          "scripts/validate-provider-specs.mjs --emit");
      } else {
        console.log("PASS " + shown + " matches the yaml");
      }
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
