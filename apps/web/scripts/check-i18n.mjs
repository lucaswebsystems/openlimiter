#!/usr/bin/env node
/**
 * The staleness gate for the message catalogs.
 *
 * WHAT IT IS FOR
 * --------------
 * `messages/en.json` is the source of truth for every word on the marketing site
 * and the documentation. The other four catalogs are translations of it. The
 * failure this script exists to catch is the quiet one: somebody edits a sentence
 * in English, ships it, and four languages keep saying the old thing, or worse, a
 * new key is added in English and the other four render a raw key path to a
 * reader. Neither breaks a build on its own. Both are bugs a visitor sees.
 *
 * So a copy change that skips retranslation goes red here, the same way a
 * provider specification that drifts from its schema goes red in
 * scripts/validate-provider-specs.mjs at the root of the repository.
 *
 * WHAT MAKES IT FAIL
 * ------------------
 *   a locale is missing a key that `en.json` has;
 *   a locale carries a key `en.json` does not have;
 *   a leaf in one catalog is an object in another, which is a key path that
 *     means two different things depending on the language;
 *   any value is empty, or is not a string;
 *   a message's ICU arguments do not match the English message's, because a
 *     translation that drops `{count}` renders a sentence with a hole in it and a
 *     translation that invents an argument throws at render time.
 *
 * WHAT IT ONLY REPORTS
 * --------------------
 * How many values are still identical to English. That is not a failure: a
 * placeholder catalog is exactly what an untranslated locale should be, and a
 * word like OpenLimiter is meant to be identical in all five. It is printed so
 * the translation lane can see its own progress at a glance.
 *
 * Run it from apps/web: `node scripts/check-i18n.mjs`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES = resolve(HERE, "..", "messages");
const SOURCE = "en.json";

/**
 * The locales the site publishes, mirroring `LOCALES` in i18n/locales.ts.
 *
 * Written out rather than derived from the directory listing, because the failure
 * worth catching is a catalog that is not there at all: a deleted file would make
 * a derived list shorter and the comparison would pass with nothing to compare.
 * A locale added to the application and not here is caught by the same rule from
 * the other side, since its file would be an extra catalog nobody asked for.
 */
const EXPECTED = ["en", "pt-BR", "es", "de", "ja"];

/** Keys whose value is deliberately not a message. */
const RESERVED = new Set(["_status"]);

function read(name) {
  const raw = readFileSync(join(MESSAGES, name), "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${name} is not valid JSON: ${error.message}`);
    return null;
  }
}

const problems = [];

function fail(message) {
  problems.push(message);
}

/**
 * Every leaf in the catalog, as a dotted path to its string.
 *
 * The shape matters as much as the set of paths: a key that is a sentence in one
 * language and a group of sentences in another is a bug that only shows up on the
 * page, so the walk records what it found rather than only that it found
 * something.
 */
function flatten(node, prefix, out) {
  for (const [key, value] of Object.entries(node)) {
    if (prefix === "" && RESERVED.has(key)) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/**
 * The ICU arguments a message uses, as a sorted list.
 *
 * A deliberately shallow read: the opening name of every `{...}` group, which
 * covers a plain argument, a plural and a select alike, plus every `<tag>` the
 * rich text renderer will be asked to supply. It is not a parser and does not
 * need to be. It answers one question: does this translation ask for the same
 * things the English one asks for.
 */
function icuArguments(value) {
  if (typeof value !== "string") return [];
  const names = new Set();
  for (const match of value.matchAll(/\{\s*([A-Za-z0-9_]+)/g)) names.add(match[1]);
  for (const match of value.matchAll(/<\s*([A-Za-z0-9_]+)\s*>/g)) names.add(`<${match[1]}>`);
  return [...names].sort();
}

const files = readdirSync(MESSAGES).filter((name) => name.endsWith(".json"));
if (!files.includes(SOURCE)) {
  console.error(`check-i18n: ${SOURCE} is missing from messages/`);
  process.exit(1);
}

for (const locale of EXPECTED) {
  if (!files.includes(`${locale}.json`)) fail(`messages/${locale}.json does not exist`);
}
for (const file of files) {
  if (!EXPECTED.includes(file.replace(/\.json$/, ""))) {
    fail(`messages/${file} is not one of the published locales`);
  }
}

const source = read(SOURCE);
const sourceLeaves = flatten(source, "", new Map());

/* The source's own health, checked before anything is compared against it. */
for (const [path, value] of sourceLeaves) {
  if (typeof value !== "string") {
    fail(`${SOURCE}: ${path} is ${Array.isArray(value) ? "an array" : typeof value}, not a string`);
  } else if (value.trim() === "") {
    fail(`${SOURCE}: ${path} is empty`);
  }
}

const locales = files.filter((name) => name !== SOURCE).sort();
const identical = new Map();

for (const file of locales) {
  const catalog = read(file);
  if (catalog === null) continue;

  const leaves = flatten(catalog, "", new Map());
  let same = 0;

  for (const [path, expected] of sourceLeaves) {
    if (!leaves.has(path)) {
      fail(`${file}: missing key ${path}`);
      continue;
    }

    const value = leaves.get(path);

    if (typeof value !== "string") {
      fail(`${file}: ${path} is ${typeof value}, not a string`);
      continue;
    }
    if (value.trim() === "") {
      fail(`${file}: ${path} is empty`);
      continue;
    }

    const wanted = icuArguments(expected).join(", ");
    const got = icuArguments(value).join(", ");
    if (wanted !== got) {
      fail(`${file}: ${path} uses [${got}] but ${SOURCE} uses [${wanted}]`);
    }

    if (value === expected) same += 1;
  }

  for (const path of leaves.keys()) {
    if (!sourceLeaves.has(path)) fail(`${file}: ${path} is not in ${SOURCE}`);
  }

  identical.set(file, same);
}

const total = sourceLeaves.size;
console.log(`check-i18n: ${total} messages in ${SOURCE}, ${locales.length} translations`);
for (const file of locales) {
  const same = identical.get(file) ?? 0;
  const translated = total - same;
  const percent = total === 0 ? 0 : Math.round((translated / total) * 100);
  console.log(`  ${file.padEnd(12)} ${translated}/${total} translated (${percent}%)`);
}

if (problems.length > 0) {
  console.error(`\ncheck-i18n: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  for (const problem of problems.slice(0, 60)) console.error(`  ${problem}`);
  if (problems.length > 60) console.error(`  ... and ${problems.length - 60} more`);
  console.error(
    "\nEvery catalog has to carry exactly the keys en.json carries. Add the missing\n" +
      "keys to the locale files, or remove the ones English no longer has.",
  );
  process.exit(1);
}

console.log("check-i18n: every catalog matches en.json");
