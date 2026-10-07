import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const quiet = readFileSync(new URL("./dist/quiet.css", import.meta.url), "utf8");
const surfaces = readFileSync(new URL("./dist/surfaces.css", import.meta.url), "utf8");

test("built desktop CSS carries the responsive tab shell and narrow rows", () => {
  assert.match(quiet, /\.chrome\s*\{[^}]*position:\s*sticky/su);
  assert.match(quiet, /\.q-tools[^}]*overflow:\s*clip/su);
  assert.match(quiet, /@media\s*\(max-width:\s*34rem\)/su);
  assert.match(quiet, /\.q-tnote[^}]*white-space:\s*normal/su);
  assert.match(surfaces, /\.chrome\s+\.tabs[^}]*padding-inline:\s*max\(/su);
  assert.doesNotMatch(surfaces, /@media\s*\(min-width:\s*1100px\)/su);
});
