// Run from apps/web: node scripts/persistence-proof.mjs --pro-dir <Pro checkout>
// CI adds --require: an unavailable prerequisite then fails instead of skipping.
// No linked project, inherited credentials, existing stack or production endpoint is used.
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
const functionEnv = join(root, "disposable-functions.env");
writeFileSync(functionEnv, `ENTITLEMENT_ED25519_KEY_ID=persistence-proof
ENTITLEMENT_ED25519_PRIVATE_KEY=${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}
NETWORK_RATE_HMAC_KEY=${randomBytes(32).toString("hex")}
`, { mode: 0o600 });
let server;
let started = false;
let phase = "start disposable Supabase";
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
  phase = "serve real Edge Functions";
  server = spawn(supabase, ["functions", "serve", "--no-verify-jwt", "--env-file", functionEnv], { cwd: root, env, stdio: "ignore", windowsHide: true });
  let serverError = false;
  server.on("error", () => { serverError = true; });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (serverError || server.exitCode !== null) break;
    try {
      const response = await fetch(`${api}/functions/v1/pro-service`, { method: "OPTIONS", signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* The local gateway may still be starting. */ }
    await new Promise((done) => setTimeout(done, 1000));
  }
  if (!ready) throw new Error("Edge Functions not ready");
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
} catch {
  // Subprocess errors can include generated credentials; report only the phase.
  console.error(`FAIL PERSISTENCE_PROOF: ${phase}`);
  process.exitCode = 1;
} finally {
  server?.kill();
  if (started) {
    try { run(supabase, ["stop", "--no-backup"]); }
    catch { console.error("FAIL PERSISTENCE_PROOF: disposable stack cleanup failed"); process.exitCode = 1; }
  }
  if (existsSync(functionEnv)) unlinkSync(functionEnv);
}
