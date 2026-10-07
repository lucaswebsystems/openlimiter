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
  assert.match(quiet, /\.q-compact\s*\{[^}]*grid-template-columns:\s*minmax\(9rem,\s*1fr\)[^}]*max-content\s+max-content/su);
  assert.match(quiet, /\.q-compact \.q-rst\s*\{[^}]*white-space:\s*normal/su);
  assert.match(quiet, /\.q-limits\s*\{[^}]*grid-template-columns:\s*minmax\(9rem,\s*max-content\)/su);
  assert.match(quiet, /\.settings \.q-card\s*\{[^}]*padding:\s*var\(--ol-space-3\)\s+var\(--ol-space-4\)\s+0\.625rem/su);
  assert.match(surfaces, /\.plan-card\s*\{[^}]*padding:\s*var\(--ol-space-3\)\s+var\(--ol-space-4\)\s+0\.625rem/su);
  assert.match(quiet, /\.chrome \.strip\s*\{[^}]*padding-inline:\s*max\([\s\S]*?--window-column/su);
  assert.match(quiet, /\.chrome \.strip-top\s*\{[^}]*width:\s*min\(100%,\s*46rem\)/su);
  assert.doesNotMatch(quiet, /\.chrome \.strip-top,\s*\.chrome \.tabs/su);
  assert.match(surfaces, /\.chrome \.tabs\s*\{[^}]*width:\s*auto[^}]*max-width:\s*none[^}]*margin-inline:\s*0/su);
  assert.match(quiet, /\.settings \.q-card\s*\{[^}]*display:\s*grid[^}]*gap:\s*var\(--ol-space-3\)/su);
  assert.match(quiet, /\.settings \.q-card\s*>\s*button\s*\{[^}]*justify-self:\s*start/su);
  assert.match(quiet, /\.settings \.q-card:has\(> #menu-update\)\s*\{[^}]*grid-template-columns:\s*max-content\s+1fr/su);
  assert.match(quiet, /\.settings \.q-card:has\(> #menu-update\)\s*>\s*:not\(#menu-update, #menu-whats-new\)\s*\{[^}]*grid-column:\s*1 \/ -1/su);
  assert.doesNotMatch(quiet, /\.settings \.q-card\s*\{[^}]*max-width:\s*36rem/su);
  assert.match(quiet, /\.q-row\s*>\s*\.q-val\s*\{[^}]*grid-column:\s*3/su);
  assert.match(quiet, /\.q-row\s*>\s*\.q-rst\s*\{[^}]*grid-column:\s*4/su);
  assert.match(quiet, /\.q-tools \.q-group ~ \.q-group\s*\{[^}]*border-top/su);
  assert.match(surfaces, /\.chrome\s+\.tabs[^}]*padding-inline:\s*max\(/su);
  assert.match(surfaces, /\.chrome \.actions\s*\{[^}]*margin-right:\s*calc\(-1 \* var\(--ol-space-2\)\)/su);
  assert.doesNotMatch(surfaces, /@media\s*\(min-width:\s*1100px\)/su);
});
