# L5a.2 persistence proof and integration handoff

Checkpoint: 2026-09-28, Codex, baseline `7f9e992` on the existing L5a worktree. No commit, push, remote workflow or production action was performed. Vault logging is outside this session's writable roots, so this file carries the checkpoint for Fable.

## Run the real server proof

Prerequisites: Node 24.15.0, pnpm 9.15.0, the existing installed web dependencies, a reachable Docker daemon, the Pro workflow's Supabase CLI (2.115.0), and a Pro checkout containing the migrations and Edge Functions to prove.

From `apps/web`:

```sh
node scripts/persistence-proof.mjs --pro-dir /absolute/path/to/openlimiter-pro
```

The runner creates a separate temporary Supabase project with unique ports and project name. It copies only server source and migrations, creates its own signing and network keys, resets that disposable database, serves the real Edge Functions, then runs `tests/persistence-server.test.ts`. It isolates HOME, USERPROFILE, LOCALAPPDATA, APPDATA and XDG directories. It does not use a linked Supabase project or inherited service credentials. Finally it stops its stack without backup and removes its generated signing environment file.

On Windows, `--supabase C:/path/to/supabase.exe` selects an installed binary if the npm binary cannot be found. No dependency or Docker installation is performed by the runner.

The Edge Function serve output is captured in `edge-functions-serve.log` under the runner's temporary directory. Readiness probes `OPTIONS /functions/v1/pro-service` with `Origin: https://127.0.0.1`, matching the generated `APP_ORIGIN`, for up to 300 seconds while the serve process remains alive. Any 2xx response is accepted. An early process exit reports its exit code. A serve failure prints the last received status (or `unavailable`), up to 200 response body characters, and the last 60 log lines. Generated signing and HMAC keys, Supabase anon and service keys, JWT shaped values, and other key or token shaped values are redacted before the body is truncated. If the body cannot be read, the diagnostic says so. The installed Supabase CLI has no separate Edge Runtime preparation command, so the first `functions serve` command performs its own runtime image preparation.

When Docker is unavailable, the local command exits zero with this explicit reason:

```text
SKIP PERSISTENCE_PROOF_DOCKER_UNAVAILABLE: no reachable disposable Docker daemon and no CI database proof runner
```

Other named prerequisite skips are `PERSISTENCE_PROOF_PRO_CHECKOUT_REQUIRED` and `PERSISTENCE_PROOF_SUPABASE_CLI_UNAVAILABLE`. Once a stack starts, setup errors and test failures fail the command; they never become skips. A normal unit test run skips the five server tests under `PERSISTENCE_PROOF_NOT_CONFIGURED`.

## Request to the Pro workflow owner

Add an on demand persistence step to `.github/workflows/database-proof.yml`. Check out the public client at a pinned commit supplied by a workflow input into `public-client`, install Node 24.15.0 and pnpm 9.15.0, and install the web dependencies with its frozen lockfile. Reuse the workflow's Docker and Supabase CLI setup. From `public-client/apps/web`, run:

```sh
node scripts/persistence-proof.mjs --pro-dir "$GITHUB_WORKSPACE" --require
```

`--require` turns any missing prerequisite into exit code 1, so CI cannot report a skipped proof as success. The runner owns a separate stack and does not reset the workflow's existing database. Allow at least 15 minutes for startup, migrations and 168 real account renewals. Preserve its verbose Vitest output with the client commit, Pro commit and Supabase CLI version in the workflow artifact. The workflow change itself remains Fable's responsibility.

## What is proved

Five tests use real clients and server responses. Phone provisioning uses the real database pairing operations for desktop approval and the production claim and poll client calls for delivery. The browser to Next route hop runs in process with an expiring cookie jar; every hosted fetch reaches the real local service. No server response or token is fabricated.

1. Phone refresh rotates, keeps the server supplied refresh expiry, and refuses the old credential after its server grace expires.
2. An expired server refresh row ends browser recovery.
3. Revoking the real device grant ends the next read and recovery attempt.
4. A phone reopened after 25 hours of stored age has lost its access cookie, retains its refresh cookie, rotates through the real renewal route, and reads the seeded quota.
5. An account retains its identity through 168 real GoTrue refresh rotations, with a server authenticated user read after each renewal and a fresh client reopen at the end.

Time compression subtracts elapsed time from disposable database timestamps and client expiry metadata. It leaves server issued JWTs and refresh credentials intact. This exercises real storage, rotation and refusal contracts without waiting seven days. It does not simulate seven days of operating system suspension, server clock changes, signed JWT aging or browser scheduling, and does not replace the required physical soak after the Oct 7 freeze.

## Runtime boundary

`createAccountSessionRuntime()` owns client construction, identity generations, coalesced reads, quota, spend and entitlement results, cached live snapshots, private cleanup, visible polling and storage handover. The dashboard subscribes to `current()` state and forwards refresh, sync preference, logout and storage preference actions. Trial completion publishes through an identity checked runtime method. The existing phone runtime and pairing pages keep their interface.

Cadence stays 60 seconds while visible, with an immediate read on visibility, network recovery and focus. Phone renewal stays due within 12 hours of the real access expiry. The server supplied refresh expiry remains uncapped, per R19.

## Verification checkpoint


The optional check config uses the installed TypeScript compiler in process and worker threads because the managed Windows sandbox blocks esbuild subprocess creation. Reproduce from `apps/web`, with the required profile variables redirected to a fresh temporary directory:

```sh
```

The authoritative `pnpm test` still fails before collection with `Error: spawn EPERM`. `pnpm build` compiles the production bundle successfully, then fails during Next validation with `[Error: spawn EPERM] { errno: -4048, code: 'EPERM', syscall: 'spawn' }`. Fable must rerun the standard lint, test and build commands on the host. The real proof locally skipped because Docker's Linux daemon was unavailable. These limitations prevent declaring the freeze acceptance gates fully green.

No new product strings or locale keys were introduced. All tracked edits remain inside the lane allowlist plus the explicitly permitted proof script. No existing hub test, dependency or lockfile changed.

## Additional contract observation for Fable

The inspected Pro source was `launch-2026-10-relaunch/wt/L0d-pro`. Its migration `20260908180000_public_surface_invariants.sql:3` drops the zero argument `public.read_current_usage_v1()` RPC. The web client still calls that RPC without arguments in `lib/synced-usage.ts:249`; the real Pro `pro-service` handler offers the authenticated `read_usage` action instead. Confirm this against the Pro commit selected for integration and assign the quota transport repair to its owner, since `synced-usage.ts` is outside this lane's allowlist. The account persistence proof deliberately verifies each renewed session through real `auth.getUser()`; it does not claim to prove that separate quota RPC contract. The phone proof does verify a real quota read.

## L5a.6 local function configuration checkpoint

2026-09-28, Codex. Public baseline: `16f86c5d75c04be1f30559df929d8bf0638a913f`. Pro source inspected read only: `7caedf2e382c503eac729cdb8c0dd30a5d66a5d3`. Only this document and `scripts/persistence-proof.mjs` changed. No commit, push or remote action was performed. Vault logging remains outside the write allowlist; this checkpoint is the handoff.

The observed readiness loop has a concrete cause in `_shared/http.ts:29`: `corsPreflight` requires an exact Origin match, and the previous probe supplied no Origin. The default was the production web origin. The runner now supplies a synthetic HTTPS loopback origin in both the generated function env file and the probe. HTTPS is required by `_shared/http.ts:3`; this value is only a CORS header and does not require a local TLS listener. The Supabase API connection remains HTTP on its disposable loopback port.

The inspected graph contains `pro-service`, `pair-device`, and eleven shared modules: `http`, `entitlement`, `encoding`, `price_contract`, `canonical_json`, `hosted_context`, `notification_policy`, `service_policy`, `sync_contract`, `network_policy`, and `pairing`. These modules do not require environment settings at module evaluation. The complete environment inventory, including dormant branches, follows. References are relative to the Pro `supabase/functions` directory.

| Variable | Read site and requirement | Local value policy |
| --- | --- | --- |
| `APP_ORIGIN` | `_shared/http.ts:4`, every response and OPTIONS | Generated env: `https://127.0.0.1`; matching probe Origin. |
| `SUPABASE_URL` | `_shared/http.ts:40`, handler entry, including OPTIONS | Reserved setting injected by `supabase functions serve` for the disposable container gateway. Do not override with host loopback inside the container or put reserved `SUPABASE_` names in the env file. |
| `SUPABASE_SERVICE_ROLE_KEY` | `_shared/http.ts:41`, handler entry, including OPTIONS | Reserved setting injected by the CLI for this disposable stack only. Never inherited from the parent process or copied from the Pro checkout. |
| `ENTITLEMENT_ED25519_KEY_ID` | `_shared/entitlement.ts:72`, phone delivery, renewal and verification | Generated env: `persistence-proof`. |
| `ENTITLEMENT_ED25519_PRIVATE_KEY` | `_shared/entitlement.ts:73`, phone delivery, renewal and verification | Generated env: fresh Ed25519 private key per run, PKCS8 DER encoded as base64url; redacted from diagnostics. |
| `NETWORK_RATE_HMAC_KEY` | `pair-device/index.ts:31`, pairing requests | Generated env: 32 random bytes encoded as hex per run; redacted from diagnostics. |
| `CONTEXT_ED25519_KEY_ID` | `pro-service/index.ts:386`, only hosted context signing | Unset. Persistence tests do not request hosted context; routing is disabled in the disposable database. |
| `CONTEXT_ED25519_PRIVATE_KEY` | `pro-service/index.ts:387`, only hosted context signing | Unset for the same reason. No hosted context signer is initialized at module load. |
| `STRIPE_MODE` | `_shared/price_contract.ts:41`, only `readPriceCatalog` | Unset. The graph imports the product constant, never calls this catalog reader. |
| `STRIPE_PRICE_MONTHLY_ID` | `_shared/price_contract.ts:42`, only `readPriceCatalog` | Unset. Checkout and billing are disabled and untested. |
| `STRIPE_PRICE_YEARLY_ID` | `_shared/price_contract.ts:43`, only `readPriceCatalog` | Unset for the same reason. |

Neither `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, nor `PRO_ENABLED` is read by this graph. No Stripe or Resend placeholder is needed, and no provider client is initialized. `NEXT_PUBLIC_PRO_ENABLED=true` remains a setting of the web test process. Server feature switches come from `public.feature_kill_switches`, not environment flags (`_shared/service_policy.ts:34`). Before serving, the runner enables only `sync_current`, `history`, and `token_issue` in its disposable database and disables every other existing switch. The existing test setup also enables these same three surfaces.

No exercised function needs a hosted service to initialize or execute these paths. Supabase Auth, Postgres and the gateway are supplied by the disposable stack. There is consequently no hosted dependency rejection to add. Missing Docker and CLI retain their existing named prerequisite results; startup and readiness failures retain the phase, process exit information, response diagnostic and redacted serve log.

Validation in `apps/web`, with all profile directories redirected to fresh temporary directories:

1. `node --check scripts/persistence-proof.mjs`: exit 0.
2. `node scripts/persistence-proof.mjs --pro-dir C:/Users/lucas/Desktop/Claude/Personal/OpenLimiter/launch-2026-10-relaunch/wt/L0d-pro`: exit 0, `SKIP PERSISTENCE_PROOF_DOCKER_UNAVAILABLE: no reachable disposable Docker daemon and no CI database proof runner`.
3. `pnpm lint`: exit 0, no ESLint warnings or errors. pnpm reported the existing engine mismatch: required Node `24.15.0`, installed `v24.13.0`; pnpm is `9.15.0`.
4. An in memory harness passed via standard input to `node --experimental-vm-modules --input-type=module`: six CORS checks against the actual Pro handlers, covering missing, matching and wrong origins for both functions. Thirteen actual local modules loaded with only the Supabase SDK client factory substituted. No provider network requests were made.
5. The same harness executed the actual runner with synthetic subprocess, filesystem, clock and fetch boundaries: seven scenarios passed, covering 200, 204, 299, persistent 403, persistent 503, connection failure and early process exit. Assertions checked generated key validity, matching Origin, feature switch SQL, profile isolation, status diagnostics, secret redaction, the 200 character body limit, stack cleanup and env file removal. Node printed its expected experimental VM modules warning. This harness validates runner control flow, not the database persistence contract.

Fable must push the reviewed public changes and rerun the Pro database proof against the intended Pro commit. Docker is unavailable here, so the five real persistence tests and the CLI supplied container settings remain unverified in a live stack during this unit. No product strings, locale keys, dependencies or lockfiles changed.
