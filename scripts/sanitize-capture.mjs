#!/usr/bin/env node
/**
 * Turn one raw provider response into a sanitized live fixture.
 *
 *   node scripts/sanitize-capture.mjs --provider codex --in raw.json
 *   node scripts/sanitize-capture.mjs --provider codex --in raw.json --write
 *
 * WHY THIS EXISTS. The three live readers ship on a request contract that was
 * observed against real accounts, and on no captured RESPONSE at all. The
 * registry says so on every run, and `--require-captures` fails because of it.
 * The gap closes by capturing real payloads, and a real payload is exactly the
 * kind of thing nobody should paste into a repository by hand.
 *
 * So this is deliberately LOSSY, and lossy by construction rather than by
 * redaction. It does not scan a payload for things that look like secrets and
 * remove them. It reads the handful of fields a parser needs, throws the entire
 * rest of the document away, and rebuilds a minimal payload from what survived.
 * An account id, an email, a token, a cookie, a plan name, a workspace handle
 * or a field a provider adds next year cannot survive that even in principle,
 * because nothing is copied across unless this file names it.
 *
 * What survives, per provider, and nothing else:
 *
 *   codex        the percentage, the window length in seconds, and the reset
 *                as SECONDS FROM CAPTURE rather than as a wall clock instant
 *   antigravity  per bucket: the pool prefix, the window name, the remaining
 *                fraction, and the reset as seconds from capture
 *   opencode     per window: the label, the percentage, and the countdown in
 *                seconds. The page itself is discarded; a page is rebuilt from
 *                those three numbers when a test needs one
 *
 * Timestamps become DURATIONS on purpose. A wall clock instant dates the
 * capture, and a fixture that pins a real instant either expires or quietly
 * says when somebody was working. Durations replay against any clock.
 *
 * Percentages and fractions are kept as they were. A number is not identifying
 * and a rounded one would stop the fixture proving the parser reads real
 * values. Nothing else is kept.
 *
 * HOW TO RUN IT. Take one raw response, straight from the provider, and put it
 * in a file. Nothing here uploads, logs or transmits anything: it reads a file,
 * prints the reduced object, and with `--write` freezes it into the fixture
 * slot in packages/connectors/src/fixtures.ts with today's date.
 *
 *   Codex        the JSON body of GET chatgpt.com/backend-api/wham/usage
 *   Antigravity  the JSON body of the retrieveUserQuotaSummary POST
 *   OpenCode     the HTML of the logged in workspace page, saved as .html
 *
 * Then read the printed object before writing it. It is small enough to read in
 * full, and that reading is the actual safety mechanism; this script is only
 * what makes the reading short.
 *
 * Zero dependencies, like every other script here.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_FILE = path.join(
  repositoryRoot, "packages", "connectors", "src", "fixtures.ts"
);

/** Longest raw capture accepted, so a wrong file is refused rather than read. */
const MAX_RAW_BYTES = 4 * 1_048_576;

class CaptureError extends Error {}

function fail(message) {
  throw new CaptureError(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${what} is missing or is not a number, so this capture cannot be reduced`);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * The three reducers
 * ------------------------------------------------------------------ */

/**
 * Codex, reduced.
 *
 * `reset_at` is epoch seconds in the observed payload, so the difference
 * against the capture instant is the countdown, which is what is kept.
 */
function reduceCodex(raw, capturedAtSeconds) {
  const root = isRecord(raw) ? raw : fail("the capture is not a JSON object");
  const limit = isRecord(root["rate_limit"])
    ? root["rate_limit"]
    : fail("no rate_limit block: is this the wham/usage response?");
  const primary = isRecord(limit["primary_window"])
    ? limit["primary_window"]
    : fail("no rate_limit.primary_window block");
  const usedPercent = finiteNumber(primary["used_percent"], "used_percent");
  const resetAt = finiteNumber(primary["reset_at"], "reset_at");
  const length = primary["limit_window_seconds"];
  return {
    usedPercent,
    resetsInSeconds: Math.round(resetAt - capturedAtSeconds),
    limitWindowSeconds:
      typeof length === "number" && Number.isFinite(length) ? Math.round(length) : null
  };
}

/**
 * Antigravity, reduced.
 *
 * The bucket id is cut down to its PREFIX. The prefix is what the parser
 * matches on, and the rest of the id names a model and a plan.
 */
function reduceAntigravity(raw, capturedAtSeconds) {
  const root = isRecord(raw) ? raw : fail("the capture is not a JSON object");
  const groups = Array.isArray(root["groups"])
    ? root["groups"]
    : fail("no groups list: is this the retrieveUserQuotaSummary response?");
  const reduced = [];
  for (const entry of groups) {
    if (!isRecord(entry) || !Array.isArray(entry["buckets"])) continue;
    const buckets = [];
    for (const rawBucket of entry["buckets"]) {
      if (!isRecord(rawBucket)) continue;
      const id = rawBucket["bucketId"];
      if (typeof id !== "string" || !id.includes("-")) continue;
      const window = rawBucket["window"];
      if (typeof window !== "string") continue;
      const fraction = finiteNumber(rawBucket["remainingFraction"], "remainingFraction");
      const reset = rawBucket["resetTime"];
      const resetSeconds = typeof reset === "string"
        ? Math.round(Date.parse(reset) / 1_000 - capturedAtSeconds)
        : null;
      buckets.push({
        poolPrefix: id.slice(0, id.indexOf("-")),
        window,
        remainingFraction: fraction,
        resetsInSeconds: Number.isFinite(resetSeconds) ? resetSeconds : null
      });
    }
    if (buckets.length > 0) reduced.push({ buckets });
  }
  if (reduced.length === 0) fail("no readable buckets survived the reduction");
  return { groups: reduced };
}

/** The window labels the OpenCode page renders, in the parser's own order. */
const OPENCODE_LABELS = ["Rolling Usage", "Weekly Usage", "Monthly Usage"];
const UNITS = { day: 86_400, hour: 3_600, minute: 60, second: 1 };

function flatten(fragment) {
  return fragment.replace(/<!--[\s\S]*?-->|<[^>]*>/gu, " ").split(/\s+/u)
    .filter(Boolean).join(" ");
}

/**
 * OpenCode, reduced.
 *
 * The page is thrown away entirely. Three labels, three percentages and three
 * countdowns come out, and a page is rebuilt from those when a test wants one.
 * A saved workspace page carries the account's name, its workspace handle, its
 * billing and its history; none of that can survive being reduced to numbers.
 */
function reduceOpencode(raw) {
  if (typeof raw !== "string") fail("the OpenCode capture must be the page as text");
  const found = [];
  for (const label of OPENCODE_LABELS) {
    const at = raw.indexOf(label);
    if (at < 0) fail(`the page does not contain "${label}", so it cannot be reduced`);
    found.push({ at, label });
  }
  found.sort((left, right) => left.at - right.at);
  const windows = [];
  for (let index = 0; index < found.length; index += 1) {
    const next = found[index + 1];
    const segment = flatten(
      raw.slice(found[index].at, next === undefined ? raw.length : next.at)
    );
    const percent = /(\d{1,3})\s*%/u.exec(segment);
    if (percent === null) fail(`no percentage under "${found[index].label}"`);
    const countdown = /Resets in\s+((?:\d{1,6}\s*(?:day|hour|minute|second)s?\s*)+)/iu
      .exec(segment);
    let seconds = null;
    if (countdown !== null) {
      seconds = 0;
      for (const [, count, unit] of countdown[1]
        .matchAll(/(\d{1,6})\s*(day|hour|minute|second)s?/giu)) {
        seconds += Number.parseInt(count, 10) * UNITS[unit.toLowerCase()];
      }
    }
    windows.push({
      label: found[index].label,
      percent: Number.parseInt(percent[1], 10),
      resetsInSeconds: seconds
    });
  }
  return { windows };
}

/*
 * Every name spelled out rather than derived from another one.
 *
 * The first version of this table built the rebuilder's name by cutting a
 * suffix off the constant's, which produced `rebuildcodexCapture` and emitted
 * TypeScript that did not compile. Clever derivation of identifiers buys
 * nothing here and costs a broken write, so each name is written once.
 */
const PROVIDERS = {
  codex: {
    reduce: reduceCodex,
    json: true,
    connector: "codex",
    constant: "codexSanitizedLive",
    rebuilder: "rebuildCodexCapture",
    fixtureId: "codex.sanitized_live.usage"
  },
  antigravity: {
    reduce: reduceAntigravity,
    json: true,
    connector: "antigravity",
    constant: "antigravitySanitizedLive",
    rebuilder: "rebuildAntigravityCapture",
    fixtureId: "antigravity.sanitized_live.quota"
  },
  opencode: {
    reduce: reduceOpencode,
    json: false,
    connector: "opencode",
    constant: "opencodeSanitizedLive",
    rebuilder: "rebuildOpencodeCapture",
    fixtureId: "opencode.sanitized_live.usage"
  }
};

/* ------------------------------------------------------------------ *
 * The refusal that matters
 * ------------------------------------------------------------------ */

/**
 * Prove the reduction kept nothing but numbers and known words.
 *
 * The reduction is already lossy by construction, so this cannot fail unless
 * somebody edits a reducer badly. That is exactly when it should fail: it is
 * the check that a future change to this file did not start copying a field
 * across. Every string that survives must be one this script chose.
 */
function refuseAnythingButNumbersAndKnownWords(reduced, allowedStrings) {
  const problems = [];
  const walk = (value, at) => {
    if (typeof value === "number" || value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (!allowedStrings.has(value)) {
        problems.push(`${at} carries the string ${JSON.stringify(value)}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${at}[${String(index)}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`);
      return;
    }
    problems.push(`${at} is a value this reduction does not produce`);
  };
  walk(reduced, "capture");
  if (problems.length > 0) {
    fail(
      "the reduction kept something that is not a number:\n  " +
        problems.join("\n  ") +
        "\nA reducer must never copy a provider string across."
    );
  }
}

function allowedStringsFor(provider, reduced) {
  if (provider === "antigravity") {
    /* Pool prefixes and window names are closed vocabularies the parser
       matches on, so they have to survive. Nothing else may. */
    const allowed = new Set(["gemini", "3p", "5h", "weekly"]);
    for (const group of reduced.groups) {
      for (const bucket of group.buckets) {
        if (!allowed.has(bucket.poolPrefix)) {
          fail(
            `pool prefix ${JSON.stringify(bucket.poolPrefix)} is not one this ` +
              "build knows. Add it to the parser deliberately, or drop the bucket."
          );
        }
        if (!allowed.has(bucket.window)) {
          fail(`window ${JSON.stringify(bucket.window)} is not one this build knows.`);
        }
      }
    }
    return allowed;
  }
  if (provider === "opencode") return new Set(OPENCODE_LABELS);
  return new Set();
}

/* ------------------------------------------------------------------ *
 * Freezing it into the fixture slot
 * ------------------------------------------------------------------ */

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Replace one pending slot with a captured one.
 *
 * Matched on the constant's own declaration, and refused unless the slot is
 * still pending: overwriting a capture that already exists should be a
 * deliberate act with a diff, not a side effect of running this twice.
 */
function freeze(source, spec, reduced) {
  const declaration = `export const ${spec.constant}: SanitizedLiveFixture = {`;
  const start = source.indexOf(declaration);
  if (start < 0) fail(`cannot find ${spec.constant} in fixtures.ts`);
  const end = source.indexOf("\n};", start);
  if (end < 0) fail(`cannot find the end of ${spec.constant}`);
  const block = source.slice(start, end + 3);
  if (!block.includes('status: "pending_capture"')) {
    fail(
      `${spec.constant} already holds a capture. Replacing one is a deliberate ` +
        "edit with a reviewed diff, not something this script does for you."
    );
  }
  const payload = JSON.stringify(reduced, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : "  " + line))
    .join("\n");
  const replacement = [
    `export const ${spec.constant}: SanitizedLiveFixture = {`,
    `  id: ${JSON.stringify(spec.fixtureId)},`,
    `  connector: ${JSON.stringify(spec.connector)},`,
    `  status: "captured",`,
    `  capturedAt: ${JSON.stringify(today())},`,
    `  providerVersion: null,`,
    `  skipReason: null,`,
    `  expectedMeters: 1,`,
    `  /* Reduced by scripts/sanitize-capture.mjs. Numbers and closed vocabulary`,
    `     words only: every other field of the real response was discarded rather`,
    `     than redacted, so nothing identifying can be present even in principle.`,
    `     Resets are seconds from capture, never instants, so this replays against`,
    `     any clock and dates nobody's working day. */`,
    `  capture: ${payload},`,
    `  build: (now) => ${spec.rebuilder}(${spec.constant}.capture, now)`,
    `};`
  ].join("\n");
  return source.slice(0, start) + replacement + source.slice(end + 3);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function argument(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}

async function main() {
  const provider = argument("--provider");
  const input = argument("--in");
  const write = process.argv.includes("--write");
  if (provider === null || input === null) {
    process.stderr.write(
      "usage: node scripts/sanitize-capture.mjs --provider <codex|antigravity|" +
        "opencode> --in <file> [--write]\n"
    );
    process.exitCode = 1;
    return;
  }
  const spec = PROVIDERS[provider];
  if (spec === undefined) {
    process.stderr.write(`FAIL unknown provider ${provider}\n`);
    process.exitCode = 1;
    return;
  }
  const raw = await readFile(input, "utf8");
  if (raw.length > MAX_RAW_BYTES) {
    process.stderr.write("FAIL the capture is larger than this script will read\n");
    process.exitCode = 1;
    return;
  }
  const capturedAtSeconds = Math.floor(Date.now() / 1_000);
  let reduced;
  try {
    const parsed = spec.json ? JSON.parse(raw) : raw;
    reduced = spec.reduce(parsed, capturedAtSeconds);
    refuseAnythingButNumbersAndKnownWords(reduced, allowedStringsFor(provider, reduced));
  } catch (error) {
    process.stderr.write(
      "FAIL " + (error instanceof CaptureError ? error.message : String(error)) + "\n"
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "This is everything that survived. Read all of it before writing it.\n\n" +
      JSON.stringify(reduced, null, 2) +
      "\n\n"
  );
  if (!write) {
    process.stdout.write(
      "Nothing was written. Re run with --write to freeze it into " +
        `${spec.constant} in packages/connectors/src/fixtures.ts.\n`
    );
    return;
  }
  const source = await readFile(FIXTURES_FILE, "utf8");
  let updated;
  try {
    updated = freeze(source, spec, reduced);
  } catch (error) {
    process.stderr.write(
      "FAIL " + (error instanceof CaptureError ? error.message : String(error)) + "\n"
    );
    process.exitCode = 1;
    return;
  }
  await writeFile(FIXTURES_FILE, updated, "utf8");
  process.stdout.write(
    `WROTE ${spec.constant} in packages/connectors/src/fixtures.ts, dated ${today()}.\n` +
      "Next: set evidence_status to captured and last_verified_at to that date in\n" +
      "the provider's spec, then run:\n" +
      "  node scripts/validate-provider-specs.mjs --emit\n" +
      "  node scripts/validate-provider-specs.mjs --require-captures\n" +
      "  pnpm test\n"
  );
}

await main();
