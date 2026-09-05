/**
 * `pnpm smoke:live` — read this machine's real providers, once, on purpose.
 *
 * The default path is deliberately the cheap one: with no OPENLIMITER_LIVE=1 in
 * the environment this prints a note and exits zero WITHOUT loading the build,
 * so the command is safe to wire into any script and safe to run by accident.
 * Only the live path needs `pnpm build`, and it says so rather than failing
 * with a module resolution error nobody can act on.
 *
 * The harness itself lives in packages/cli/src/smoke.ts, where it is
 * typechecked and unit tested. This file is the entry point and nothing else.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..");

if (process.env["OPENLIMITER_LIVE"] !== "1") {
  process.stdout.write(
    "openlimiter smoke: skipped. Set OPENLIMITER_LIVE=1 to read this " +
      "machine's real providers.\n"
  );
  process.exit(0);
}

const built = path.join(REPOSITORY, "packages", "cli", "dist", "smoke.js");
let smoke;
try {
  smoke = await import(pathToFileURL(built).href);
} catch {
  process.stderr.write(
    "openlimiter smoke: the packages are not built. Run pnpm build first.\n"
  );
  process.exit(1);
}

process.exitCode = await smoke.smokeMain(REPOSITORY);
