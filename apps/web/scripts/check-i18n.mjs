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
 * Identical values are counted for visibility. New untranslated prose fails
 * unless it is explicit terminology. Older debt is frozen by locale, key and
 * exact source digest in i18n-legacy-prose.json. That baseline may shrink, but
 * must never be regenerated to admit a new untranslated sentence.
 *
 * Run it from apps/web: `node scripts/check-i18n.mjs`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasForbiddenProseDash, isTechnicalKey, untranslatedProse } from "./i18n-prose.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES = resolve(HERE, "..", "messages");
const SOURCE = "en.json";
const LEGACY_PROSE = JSON.parse(readFileSync(join(HERE, "i18n-legacy-prose.json"), "utf8"));

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
const CODE_ROOTS = [resolve(HERE, "..", "app"), resolve(HERE, "..", "components")];

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

function codeFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...codeFiles(path));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function extractCodeUsage() {
  const exact = new Map();
  const wildcards = new Set();
  const namespacePattern = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*["']([^"']+)["']\s*\)/gu;
  const objectNamespacePattern = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+getTranslations\(\s*\{[^}]*?\bnamespace\s*:\s*["']([^"']+)["'][^}]*\}\s*\)/gu;
  const callPattern = /\b([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)?\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]*)`)/gu;
  const bindingsFor = (bindings, name, position) => bindings
    .filter((binding) => binding.name === name && binding.index < position)
    .sort((left, right) => left.index - right.index)
    .at(-1) ?? bindings.find((binding) => binding.name === name);
  for (const file of CODE_ROOTS.flatMap(codeFiles)) {
    const source = readFileSync(file, "utf8");
    const bindings = [];
    for (const pattern of [namespacePattern, objectNamespacePattern]) {
      for (const match of source.matchAll(pattern)) bindings.push({ name: match[1], namespace: match[2], index: match.index ?? 0 });
    }
    bindings.sort((left, right) => left.index - right.index);
    for (const match of source.matchAll(callPattern)) {
      const binding = bindingsFor(bindings, match[1], match.index ?? 0);
      if (!binding) continue;
      const key = match[2] ?? match[3] ?? match[4] ?? "";
      if (match[4] !== undefined && match[4].includes("${")) {
        wildcards.add(`${binding.namespace}.${key.slice(0, key.indexOf("${"))}`);
      } else {
        exact.set(`${binding.namespace}.${key}`, file);
      }
    }
    for (const binding of bindings) {
      const dynamicCall = new RegExp("\\b" + binding.name + "(?:\\.[A-Za-z_$][\\w$]*)?\\(\\s*(?![\"'`])", "u").test(source);
      if (dynamicCall) wildcards.add(`${binding.namespace}.`);
    }
  }
  return { exact, wildcards };
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
const usage = extractCodeUsage();

for (const [path, file] of usage.exact) {
  if (!sourceLeaves.has(path)) fail(`${file}: code uses missing key ${path}`);
}
for (const prefix of usage.wildcards) {
  if (![...sourceLeaves.keys()].some((path) => path.startsWith(prefix))) {
    fail(`code uses missing translation namespace ${prefix.slice(0, -1)}`);
  }
}

/* The source's own health, checked before anything is compared against it. */
for (const [path, value] of sourceLeaves) {
  if (typeof value !== "string") {
    fail(`${SOURCE}: ${path} is ${Array.isArray(value) ? "an array" : typeof value}, not a string`);
  } else if (value.trim() === "") {
    fail(`${SOURCE}: ${path} is empty`);
  } else if (!isTechnicalKey(path) && hasForbiddenProseDash(value)) {
    fail(`${SOURCE}: ${path} contains a forbidden dash`);
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
    if (!isTechnicalKey(path) && hasForbiddenProseDash(value)) {
      fail(`${file}: ${path} contains a forbidden dash`);
    }
    if (untranslatedProse(file.replace(/\.json$/, ""), path, expected, value, LEGACY_PROSE)) {
      fail(`${file}: ${path} contains untranslated prose`);
    }
  }

  for (const path of leaves.keys()) {
    if (!sourceLeaves.has(path)) fail(`${file}: ${path} is not in ${SOURCE}`);
  }

  identical.set(file, same);
}

const unused = [];
for (const [path] of sourceLeaves) {
  if (![...usage.exact.keys()].includes(path) && ![...usage.wildcards].some((prefix) => path.startsWith(prefix))) {
    unused.push(path);
  }
}

const total = sourceLeaves.size;
console.log(`check-i18n: ${total} messages in ${SOURCE}, ${locales.length} translations`);
for (const file of locales) {
  const same = identical.get(file) ?? 0;
  const translated = total - same;
  const percent = total === 0 ? 0 : Math.round((translated / total) * 100);
  console.log(`  ${file.padEnd(12)} ${translated}/${total} translated (${percent}%)`);
}

if (unused.length > 0) {
  console.warn(`check-i18n: ${unused.length} unused catalog keys`);
  for (const path of unused.slice(0, 60)) console.warn(`  ${SOURCE}: unused key ${path}`);
  if (unused.length > 60) console.warn(`  ... and ${unused.length - 60} more`);
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
