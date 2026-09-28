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
