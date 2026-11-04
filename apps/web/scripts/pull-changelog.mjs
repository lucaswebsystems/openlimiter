import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The changelog page renders the repository's own CHANGELOG.md. The deploy
 * uploads only this directory, so the root file is not guaranteed to reach
 * production: Vercel builds with `apps/web` as its root directory and never
 * sees the repository root.
 *
 * Choice: keep the build-time pull (this script) for environments that do see
 * the root file (the monorepo, CI), AND track the pulled copy
 * (`apps/web/CHANGELOG.md`) in git so a plain deploy that cannot reach the root
 * still ships the current file. The root file stays the single authored source;
 * this copy is a build artifact that is refreshed whenever the root is
 * available and committed alongside the change that touched the changelog. A
 * tracked copy that drifts from the root is caught by the changelog test suite.
 *
 * lib/changelog.ts prefers the root original when it exists and falls back to
 * this copy, so neither environment renders an empty page.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const rootPath = join(here, "..", "..", "..", "CHANGELOG.md");
export const localPath = join(here, "..", "CHANGELOG.md");

export function pullChangelog() {
  if (existsSync(rootPath)) {
    copyFileSync(rootPath, localPath);
    console.log("pull-changelog: copied the root CHANGELOG.md in");
    return "copied";
  } else if (existsSync(localPath)) {
    console.log("pull-changelog: no root file here, keeping the existing copy");
    return "kept";
  } else {
    console.warn("pull-changelog: no CHANGELOG.md found at all, the page will be empty");
    return "missing";
  }
}

// Backwards compatible alias for callers that expect a `run` entry point.
export const run = pullChangelog;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  pullChangelog();
}
