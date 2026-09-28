// Run from apps/web: node scripts/persistence-proof.mjs --pro-dir <Pro checkout>
// CI adds --require: an unavailable prerequisite then fails instead of skipping.
// No linked project, inherited credentials, existing stack or production endpoint is used.
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const required = args.includes("--require");
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const skip = (reason) => {
  console.log(`${required ? "FAIL" : "SKIP"} PERSISTENCE_PROOF_${reason}`);
  process.exit(required ? 1 : 0);
};
const proDir = value("--pro-dir");
if (!proDir) skip("PRO_CHECKOUT_REQUIRED: pass --pro-dir with the server checkout to test");
const source = join(resolve(proDir), "supabase");
if (!existsSync(join(source, "migrations")) || !existsSync(join(source, "functions", "pro-service", "index.ts"))) {
  throw new Error("Pro checkout must contain migrations and the real Edge Functions");
}
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "ol-persistence-proof-"));
const profile = join(root, "profile");
mkdirSync(profile);
const serveLog = join(root, "edge-functions-serve.log");
const logSecrets = [];
const rememberSecret = (secret) => {
  if (typeof secret === "string" && secret.length >= 8) logSecrets.push(secret);
};
const redact = (value) => {
  let safe = value;
  for (const secret of logSecrets) safe = safe.replaceAll(secret, "[REDACTED]");
  return safe
    .replace(/\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g, "[REDACTED_JWT]")
    .replace(/((?:api|access|refresh|service[_ -]?role|anon|jwt|hmac|private|secret|token|key|password)[A-Za-z0-9_ -]*\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED]");
};
const printServeLogTail = () => {
  let contents;
  try { contents = readFileSync(serveLog, "utf8"); }
  catch { contents = "(serve log unavailable)"; }
  const lines = contents.split(/\r?\n/).slice(-60).map(redact);
  console.error(`Serve log, last ${Math.min(lines.length, 60)} lines:`);
  console.error(lines.join("\n"));
};
// Do not inherit production API keys, linked project credentials or user profiles.
const env = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "CI"]) {
  if (process.env[key]) env[key] = process.env[key];
}
for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) env[key] = profile;
env.NEXT_TELEMETRY_DISABLED = "1";
function run(binary, argv, cwd = root) {
  return execFileSync(binary, argv, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
}
try { run("docker", ["info", "--format", "{{.ServerVersion}}"]); }
catch { skip("DOCKER_UNAVAILABLE: no reachable disposable Docker daemon and no CI database proof runner"); }
let supabase = value("--supabase") ?? "supabase";
if (process.platform === "win32" && supabase === "supabase") {
  // npm's shell shims cannot be execFile targets on Windows. Use its installed binary.
  try {
    const shim = run("where.exe", ["supabase.cmd"]).trim().split(/\r?\n/)[0];
    supabase = join(dirname(shim), "node_modules", "supabase", "bin", "supabase.exe");
  } catch { skip("SUPABASE_CLI_UNAVAILABLE: pass --supabase with the installed binary"); }
}
try { run(supabase, ["--version"]); }
catch { skip("SUPABASE_CLI_UNAVAILABLE: install the Pro workflow pinned CLI or pass --supabase"); }

const project = `ol-persistence-${randomBytes(6).toString("hex")}`;
const port = 55000 + Math.floor(Math.random() * 500) * 10;
mkdirSync(join(root, "supabase"));
const safeCopy = (from, to) => cpSync(from, to, { recursive: true, filter: (path) => {
  const name = basename(path);
  return !name.startsWith(".") && name !== "node_modules" && name !== "_secrets";
} });
safeCopy(join(source, "migrations"), join(root, "supabase", "migrations"));
safeCopy(join(source, "functions"), join(root, "supabase", "functions"));
// Preserve real server code and migration contents. Only the disposable service
// configuration differs: isolated ports, no external integrations, generous test rate budget.
const functions = readdirSync(join(root, "supabase", "functions"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, "supabase", "functions", entry.name, "index.ts")))
  .map((entry) => `[functions.${entry.name}]\nverify_jwt = false`).join("\n");
writeFileSync(join(root, "supabase", "config.toml"), `project_id = "${project}"
[api]
enabled = true
port = ${port}
schemas = ["public"]
extra_search_path = ["public", "extensions"]
[db]
port = ${port + 1}
shadow_port = ${port + 2}
major_version = 17
[db.seed]
enabled = false
[studio]
enabled = false
[inbucket]
enabled = false
[analytics]
enabled = false
[edge_runtime]
inspector_port = ${port + 3}
[auth]
enabled = true
site_url = "http://127.0.0.1:${port}"
enable_signup = true
jwt_expiry = 3600
[auth.rate_limit]
token_refresh = 10000
${functions}
`);
const { privateKey } = generateKeyPairSync("ed25519");
const entitlementPrivateKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
const networkHmacKey = randomBytes(32).toString("hex");
rememberSecret(entitlementPrivateKey);
rememberSecret(networkHmacKey);
// Pro requires an HTTPS CORS origin. This is a header value, not a TLS endpoint.
const appOrigin = "https://127.0.0.1";
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are reserved CLI settings, injected
// for this disposable stack with its container gateway URL and local service key.
const functionEnv = join(root, "disposable-functions.env");
writeFileSync(functionEnv, `APP_ORIGIN=${appOrigin}
ENTITLEMENT_ED25519_KEY_ID=persistence-proof
ENTITLEMENT_ED25519_PRIVATE_KEY=${entitlementPrivateKey}
NETWORK_RATE_HMAC_KEY=${networkHmacKey}
`, { mode: 0o600 });
let server;
let serveLogHandle;
let serveAttempted = false;
let started = false;
let phase = "start disposable Supabase";
let lastReadinessStatus;
let lastReadinessBody = "(no response received)";
try {
  console.log("Starting disposable Supabase for persistence proof");
  started = true;
  run(supabase, ["start"]);
  phase = "reset disposable migrations";
  run(supabase, ["db", "reset", "--local"]);
  phase = "read disposable connection details";
  const status = JSON.parse(run(supabase, ["status", "-o", "json"]));
  const api = status.API_URL;
  if (!api || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(api).hostname)) throw new Error("Loopback required");
  const db = run("docker", ["ps", "--filter", `name=^supabase_db_${project}$`, "--format", "{{.ID}}" ]).trim();
  if (!/^[a-f0-9]{12,64}$/.test(db)) throw new Error("Exactly one disposable database required");
  for (const [key, value] of Object.entries(status)) {
    if (/key|token|secret|jwt|password/i.test(key)) rememberSecret(value);
  }
  phase = "configure disposable proof feature switches";
  // These switches live in Postgres, not PRO_ENABLED or other function env flags.
  run("docker", ["exec", db, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
    "update public.feature_kill_switches set enabled = feature in ('sync_current','history','token_issue');"]);
  phase = "serve real Edge Functions";
  serveLogHandle = openSync(serveLog, "w");
  serveAttempted = true;
  server = spawn(supabase, ["functions", "serve", "--no-verify-jwt", "--env-file", functionEnv], { cwd: root, env, stdio: ["ignore", serveLogHandle, serveLogHandle], windowsHide: true });
  let serverError;
  server.on("error", (error) => { serverError = error; });
  let ready = false;
  const deadline = Date.now() + 300_000;
  while (!ready) {
    if (serverError) throw new Error(`Edge Functions serve failed to start: ${serverError.code ?? serverError.message}`);
    if (server.exitCode !== null || server.signalCode !== null) {
      const status = server.exitCode === null ? `signal ${server.signalCode}` : `exit code ${server.exitCode}`;
      throw new Error(`Edge Functions process exited before readiness with ${status}`);
    }
    if (Date.now() >= deadline) throw new Error("Edge Functions not ready after 300 seconds");
    try {
      const response = await fetch(`${api}/functions/v1/pro-service`, {
        method: "OPTIONS", headers: { origin: appOrigin }, signal: AbortSignal.timeout(1000),
      });
      lastReadinessStatus = response.status;
      lastReadinessBody = "(response body unavailable)";
      if (response.status >= 200 && response.status < 300) ready = true;
      // Redact before truncation so a secret crossing the limit cannot leak a prefix.
      lastReadinessBody = redact(await response.text()).slice(0, 200);
    } catch { /* The local gateway may still be starting. */ }
    if (!ready) await new Promise((done) => setTimeout(done, Math.min(1000, deadline - Date.now())));
  }
  phase = "run persistence client tests";
  Object.assign(env, {
    OL_PERSISTENCE_PROOF: "disposable-local", OL_PROOF_SERVICE_KEY: status.SERVICE_ROLE_KEY,
    OL_PROOF_DB_CONTAINER: db, NEXT_PUBLIC_SUPABASE_URL: api,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY, NEXT_PUBLIC_PRO_ENABLED: "true",
  });
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const test = spawn(process.execPath, [vitest, "run", "tests/persistence-server.test.ts", "--reporter=verbose"], { cwd: web, env, stdio: "inherit", windowsHide: true });
  const code = await new Promise((done, reject) => { test.on("error", reject); test.on("exit", done); });
  process.exitCode = code === 0 ? 0 : 1;
} catch (error) {
  // Subprocess errors can include generated credentials; report only the phase.
  console.error(`FAIL PERSISTENCE_PROOF: ${phase}`);
  if (error instanceof Error && error.message) console.error(`Reason: ${redact(error.message)}`);
  if (serveAttempted) {
    console.error(`Last readiness response: status ${lastReadinessStatus ?? "unavailable"}; body ${JSON.stringify(lastReadinessBody)}`);
    printServeLogTail();
  }
  process.exitCode = 1;
} finally {
  server?.kill();
  if (serveLogHandle !== undefined) {
    try { closeSync(serveLogHandle); }
    catch { /* The child may already have closed the inherited descriptor. */ }
  }
  if (started) {
    try { run(supabase, ["stop", "--no-backup"]); }
    catch { console.error("FAIL PERSISTENCE_PROOF: disposable stack cleanup failed"); process.exitCode = 1; }
  }
  if (existsSync(functionEnv)) unlinkSync(functionEnv);
}
