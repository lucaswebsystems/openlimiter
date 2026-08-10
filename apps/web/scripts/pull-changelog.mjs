import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The changelog page renders the repository root CHANGELOG.md, but the deploy
 * uploads only this directory, so the root file never reaches production and
 * the page rendered empty there since launch. This runs before every build and
 * pulls the file in; lib/changelog.ts prefers the root original when it exists
 * and falls back to this copy. The copy is gitignored: the root file stays the
 * single authored source.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "CHANGELOG.md");
const local = join(here, "..", "CHANGELOG.md");

if (existsSync(root)) {
  copyFileSync(root, local);
  console.log("pull-changelog: copied the root CHANGELOG.md in");
} else if (existsSync(local)) {
  console.log("pull-changelog: no root file here, keeping the existing copy");
} else {
  console.warn("pull-changelog: no CHANGELOG.md found at all, the page will be empty");
}
