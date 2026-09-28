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

Other named prerequisite skips are `PERSISTENCE_PROOF_PRO_CHECKOUT_REQUIRED` and `PERSISTENCE_PROOF_SUPABASE_CLI_UNAVAILABLE`. Once a stack starts, setup errors and test failures fail the command; they never become skips. A normal unit test run skips the seven server tests under `PERSISTENCE_PROOF_NOT_CONFIGURED`, but runs the browser adapter regression.

## Request to the Pro workflow owner

Add an on demand persistence step to `.github/workflows/database-proof.yml`. Check out the public client at a pinned commit supplied by a workflow input into `public-client`, install Node 24.15.0 and pnpm 9.15.0, and install the web dependencies with its frozen lockfile. Reuse the workflow's Docker and Supabase CLI setup. From `public-client/apps/web`, run:

```sh
node scripts/persistence-proof.mjs --pro-dir "$GITHUB_WORKSPACE" --require
```

`--require` turns any missing prerequisite into exit code 1, so CI cannot report a skipped proof as success. The runner owns a separate stack and does not reset the workflow's existing database. Allow at least 15 minutes for startup, migrations and 168 real account renewals. Preserve its verbose Vitest output with the client commit, Pro commit and Supabase CLI version in the workflow artifact. The workflow change itself remains Fable's responsibility.

## What is proved

Seven tests use real clients and server responses. Phone provisioning uses the real database pairing operations for desktop approval and the production claim and poll client calls for delivery. The browser to Next route hop runs in process with an expiring cookie jar; every hosted fetch reaches the real local service. No server response or token is fabricated.

1. Phone refresh rotates, keeps the server supplied refresh expiry, and refuses the old credential after its server grace expires.
2. An expired server refresh row ends browser recovery.
3. Revoking the real device grant ends the next read and recovery attempt.
4. A phone reopened after 25 hours of stored age has lost its access cookie, retains its refresh cookie, rotates through the real renewal route, and reads the seeded quota.
5. An account retains its identity through 168 real GoTrue refresh rotations, with a server authenticated user read after each renewal and a fresh client reopen at the end.
6. Logout successfully revokes the departing session before private storage is erased, leaves no live refresh rows, and refuses replay of the departing refresh credential.
7. Account switch meets the same revocation guarantees and the new account can still refresh and authenticate.

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

## L5a.7 failure attribution and verification checkpoint

2026-09-28, Codex. Public baseline reviewed: `d32120239b03208054503d9316be666b7dad15cb`. Pro source reviewed read only: `7caedf2e382c503eac729cdb8c0dd30a5d66a5d3`. CI run `36482755397`, attempt 3, used public `a24850988e67c56e4665d1383f8a725e7e0a6139` and Pro `059cadd59884b19143dab92221d2343487816922`, according to `lanes/out/pro-persistence-proof-run3.txt:22`. That Pro CI object is absent locally (`fatal: bad object 059cadd59884b19143dab92221d2343487816922`), so equivalence to the inspected Pro checkout is not asserted. No remote fetch was performed.

All five observed failures are test defects, severity major because they block the real persistence proof. No product source change is warranted by these failures. R19's server supplied refresh expiry, renewal within 12 hours, and L5a.4's invalidate, revoke, erase order remain intact. Only this document and `tests/persistence-server.test.ts` changed. No runner change was necessary. No secrets, product strings, locale keys, dependencies or lockfiles were added. Vault logging is outside the write allowlist; this dated checkpoint is the handoff.

| Failure | Verdict and evidence | Fix |
| --- | --- | --- |
| Expired refresh returns `empty` instead of `unpaired` | Test defect. The old adapter at baseline line 99 passed jsdom's signal to Node's `NextRequest`. A local reproduction throws `TypeError: RequestInit: Expected signal ("AbortSignal {}") to be an instance of AbortSignal.` The catch in `lib/phone-session.ts:336` becomes status zero and renewal becomes unavailable, before a hosted renewal occurs. | `routeRequest` at line 100 serializes method, headers and body across the simulated HTTP boundary. The test at line 189 also proves the real hosted credential returns 401 before browser recovery. |
| Read before device revocation returns `empty` | Test defect. Same request construction failure, before the read reaches the real server. CI's direct `readPhoneBars` test passed, while the browser adapter failed. `empty` is a transport outcome, not evidence of zero quota rows. | Same adapter fix. The test at line 198 now checks the quota before revocation and the direct hosted 401 afterwards. |
| Reopen after 25 hours returns `empty` | Test defect. Same signal mismatch prevents browser renewal. The stored access and refresh age expectations remain valid. | Same adapter fix. The test at line 210 keeps rotation and cookie lifetime assertions and now checks v3 metadata plus the phone UI decoder. |
| Logout counts 3 requests instead of 1 | Test defect. Baseline teardown only stopped refresh timers; it left two prior clients' auth listeners and broadcast channels alive. The counter counted every `/auth/v1/logout`, regardless of which account authorized it. A synthetic local reproduction using the actual `account-client.ts` and installed SDK produced exactly 3 calls: 2 for the previous account and 1 for the departing account. With disposal it produced 1, for the departing account. | Teardown at line 163 awaits pending cleanup and calls `auth.dispose()`. The test at line 258 scopes successful POST revocations to the departing bearer and checks server state and replay, rather than requiring exactly one HTTP request globally. |
| Account switch counts 4 requests instead of 1 | Test defect. The accumulated clients act as additional tabs. Each retained account listener at `lib/account-client.ts:414` reacts to the switch and revokes its departing token. A synthetic local reproduction with four clients produced exactly 4 revocations; disposing the three abandoned clients reduced it to 1. Multiple tabs may legitimately send idempotent revocations. | Same teardown and scoped assertions. The new account must also successfully rotate its refresh credential and pass `getUser()` after the old account is revoked. |

The counter reproductions used synthetic sessions and local fetch substitutes only to identify the extra callers. They loaded the actual account client through the installed TypeScript compiler and used the installed Supabase SDK and real BroadcastChannel delivery. They are not claims of server persistence verification. The seven disposable server tests still use only server issued credentials and real hosted responses.

The original usage seed was valid, not a missing v3 migration fixture. `supabase/migrations/20260901221608_snapshot_sync_v2.sql:58` permits a null upload device; `20260904095000_meter_contract_v2.sql:4` generates `code`, `percent`, and `resets_at` from the older columns. In `20260929090000_meter_contract_v3.sql:4`, metadata remains nullable for legacy rows. A percentage of 42 satisfies the value constraint, with null availability and retry fields. The phone RPC at line 591 validates the phone's read grant, token issue, entitlement epoch and history feature, then selects usage by `user_id` at line 618. It does not filter usage to the phone device or a particular account ID. Age beyond 15 minutes marks a row stale rather than filtering it out. The account RPC at line 639 likewise reads by owner and left joins the upload device for its label.

The strengthened seed at `tests/persistence-server.test.ts:67` explicitly belongs to the registered desktop and supplies `source=native_payload`, `reading_precision=exact`, `verification=UNVERIFIED`, `kind=quota_percent`, fresh timestamps and null availability/retry fields. Every pairing now proves a real direct read of that row. The server emits wire `precision` and schema version 3 through `pro-service/index.ts:420` and `_shared/sync_contract.ts`'s `wireReadRow`. `expectQuota` at line 89 verifies both that wire response and `meterRowsOf`, the decoder used by the phone UI. This is a numeric quota decode proof; it does not claim that the UI renders availability only rows or all v3 metadata.

The proof now fails explicitly with `PRO_PHONE_READ_FAILED`, `PRO_PHONE_V3_ROW_MISSING`, or `PHONE_V3_DECODE_FAILED` if those boundaries break. No Pro defect was found and no speculative SQL change is requested. Account revocation requires a successful departing session request while private state is still present, zero live refresh rows for that disposable user, refused refresh replay, erased private storage, and a surviving new session on switch. Existing `tests/account-revocation.test.ts` continues to assert exactly one request per isolated client for success, server failure and network failure in both persistence modes.

Verification context: `apps/web`. Each command that could write state ran with HOME, USERPROFILE, LOCALAPPDATA, APPDATA and all five XDG profile directories redirected to a fresh temporary directory. Installed Node is `v24.13.0`, below the declared `24.15.0`; pnpm is `9.15.0`.

| Command or check | Exact result |
| --- | --- |
| `pnpm lint` | Exit 0; no ESLint warnings or errors. pnpm prints the Node engine mismatch warning. |
| `pnpm test` | Exit 1 before collection: `Error: spawn EPERM`, while esbuild loads `vitest.config.mts`. Standard command acceptance is not met locally. |
| `node --check scripts/persistence-proof.mjs` | Exit 0. |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | Exit 0. |
| Programmatic Vitest fallback below | Exit 0, 27 test files passed, 418 tests passed, 7 server tests skipped. Includes the new adapter regression and all 12 existing revocation cases. |
| `node scripts/persistence-proof.mjs --pro-dir ../../../../wt/L0d-pro` | Exit 0 with `SKIP PERSISTENCE_PROOF_DOCKER_UNAVAILABLE: no reachable disposable Docker daemon and no CI database proof runner`. This is a skip, not a successful server proof. |
| `git diff --check` | Exit 0. Only the two allowed test/document paths are modified; Pro status is clean. |

The fallback was run through `node --input-type=module -e $proofScript` in PowerShell, after creating and assigning the isolated profile directories. `$proofScript` contained:

```js
import { startVitest } from 'vitest/node';
import ts from 'typescript';
const ctx = await startVitest('test', [], {
  config: false, environment: 'jsdom', pool: 'threads',
  maxWorkers: 2, minWorkers: 1,
  include: ['tests/**/*.test.ts'], restoreMocks: true,
}, {
  configFile: false, esbuild: false,
  resolve: { preserveSymlinks: true, alias: { '@': process.cwd() } },
  plugins: [{ name: 'isolated-typescript-check', enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?tsx?(?:\?|$)/.test(id) || id.includes('node_modules')) return;
      code = code.replaceAll('process.env.NODE_ENV', JSON.stringify('test'));
      return { code: ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, sourceMap: true },
        fileName: id,
      }).outputText, map: null };
    },
  }],
});
await ctx?.close();
```

This supplements standard verification, not replaces it. Initial fallback attempts also hit `spawn EPERM`: first Vite's Windows realpath optimization (27 unhandled errors, no tests), then its environment define transform (369 tests passed, 7 skipped, 3 suites failed before collection). `preserveSymlinks` and the equivalent test environment literal avoided those subprocesses. No repository config was changed. The first exploratory counter harness had a missing temporary module filename and aborted before running its scenarios; the corrected in memory loader completed all four logout/switch cleanup scenarios described above.

Request to Fable: integrate the two public files, run standard `pnpm test` on the host, push under the existing integration authority, and rerun the Pro database proof against the intended pinned Pro commit. Expect seven server persistence cases plus the local adapter regression to pass. A named Pro request is not justified by the inspected code or these reproductions. Seven real server passes remain unverified until that rerun; the physical seven day soak also remains a separate acceptance requirement.
