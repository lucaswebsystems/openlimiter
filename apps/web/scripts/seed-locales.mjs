#!/usr/bin/env node
/**
 * Seeds a locale catalog from `en.json`, for a language nobody has translated yet.
 *
 * WHY THIS EXISTS
 * ---------------
 * The four translations land in a later wave. Until they do, a locale file has to
 * exist and has to carry exactly the keys English carries, or the site cannot be
 * built at all: a missing key renders its own path to a reader, and the staleness
 * gate would fail the build first. So each locale starts as a copy of English,
 * which is honest about being untranslated and correct about its shape.
 *
 * It is also the tool for the wave after this one. A new key added in English is
 * a key four catalogs are missing, and running this with `--fill` copies the
 * English value into every locale that lacks it while leaving every translated
 * value exactly as it is.
 *
 *   node scripts/seed-locales.mjs          create any missing catalog, whole
 *   node scripts/seed-locales.mjs --fill   add only the keys a catalog lacks
 *
 * The `_status` note at the top of a seeded file says out loud that it is not a
 * translation. A translator removes it when the file stops being one, and the
 * gate ignores that key by name.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES = resolve(HERE, "..", "messages");

/** Mirrors LOCALES in i18n/locales.ts, minus the source language. */
const TARGETS = ["pt-BR", "es", "de", "ja"];

const STATUS =
  "UNTRANSLATED PLACEHOLDER. Every value below is still English, copied from " +
  "en.json so the site builds and the key check passes. Read messages/GLOSSARY.md " +
  "before translating, and delete this note when the file is done.";

const fill = process.argv.includes("--fill");
const source = JSON.parse(readFileSync(join(MESSAGES, "en.json"), "utf8"));

/**
 * The English tree, with any value the target already translated kept in place.
 *
 * It walks English rather than the target on purpose: the result carries exactly
 * English's keys, so a key English has dropped disappears from the target too and
 * a key English has gained arrives in it. That is the whole contract the gate
 * enforces, applied rather than merely checked.
 */
function merge(from, existing) {
  const out = {};
  for (const [key, value] of Object.entries(from)) {
    const current = existing === undefined ? undefined : existing[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = merge(value, typeof current === "object" && current !== null ? current : undefined);
    } else {
      out[key] = typeof current === "string" ? current : value;
    }
  }
  return out;
}

for (const locale of TARGETS) {
  const path = join(MESSAGES, `${locale}.json`);
  const exists = existsSync(path);

  if (exists && !fill) {
    console.log(`seed-locales: ${locale}.json exists, left alone`);
    continue;
  }

  const existing = exists ? JSON.parse(readFileSync(path, "utf8")) : {};
  const merged = merge(source, existing);

  /* The note goes first, so it is the first thing anybody opening the file
     reads, and it survives a fill until somebody deletes it deliberately. */
  const body = existing._status === undefined && !exists ? { _status: STATUS, ...merged } : merged;
  if (exists && existing._status !== undefined) body._status = existing._status;

  const ordered = {};
  if (body._status !== undefined) ordered._status = body._status;
  for (const [key, value] of Object.entries(body)) {
    if (key !== "_status") ordered[key] = value;
  }

  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  console.log(`seed-locales: ${exists ? "filled" : "created"} ${locale}.json`);
}
