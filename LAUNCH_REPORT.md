# OpenLimiter launch report

Updated: 2026-08-20 06:10 BRT

## Verdict

APPROVED TO SHIP, RELEASE IN PROGRESS. One uninterrupted battery and both full history secret scans are green on exact commit `45b0a1781300cfe222e61f3ca5bedb248a7e91b9`. The independent Antigravity traffic verdict is YES. Nothing had been pushed, released, deployed, or published at the time of this update.

## Preservation and ownership

At 04:13 BRT pane 30 accepted sole ownership of the release lane. The inherited dirty workspace was preserved without discarding anything in local commit `37bbd4e` on branch `preserve/pre-takeover-20260820-0413`.

At 04:24 BRT another process changed `LAUNCH_REPORT.md` in that preservation worktree. The unexpected update was reported immediately and preserved in local commit `6769c70`. `main`, its source files, and this clean release worktree were unchanged. Neither preservation commit will be pushed.

## Candidate state

The committed candidate already contains `5c6dc3e` for cross process request locking, `2233022` for shared server backoff, `c6c0ed9` for clean Cargo configuration validation, and `df7aa29` for fresh machine certification. These changes are being independently inspected rather than trusted from their commit messages.

## Verification events

At 04:30 BRT the first clean `cargo test --lib --no-fail-fast` attempt reached its enforced 600 second limit during cold compilation. It exited with code 124. No Rust test executable had started, and no child compiler process remained after termination. This event is a bounded compilation timeout, not a test result and not evidence of a request lock deadlock.

At 04:41 BRT the one permitted retry completed inside its 1200 second hard limit. Compilation took 2 minutes 28 seconds. All 289 Rust library tests then passed in 30.87 seconds with zero failures. The clean worktree had never run `apps/desktop/scripts/build-ui.mjs`, so this also proves the tracked `ui/dist/.gitkeep` fix removes the clean Cargo build order trap.

At 04:53 BRT the authorized public PEM was decoded and compared with the embedded verifier key. The raw 32 byte Ed25519 key matches exactly. The repository already ignores `*.pem`. No private key was read.

The deferred Pro surface is closed when Supabase configuration is absent. `/pro` renders the translated coming soon message, the pricing card renders a noninteractive coming soon chip, and no local checkout route exists. The actual Vercel environment will be inspected before deployment to exclude stale production variables.

The exact Node 24.15.0 runtime was downloaded from the official Node distribution and matched its official SHA256 manifest. Both the root lockfile and the isolated web lockfile were installed with pnpm 9.15.0 under hard time limits.

At 04:57 BRT `pnpm test` failed. All 20 provider specifications passed. All five language catalogs matched. Test compilation passed. Vitest reported 814 passing tests, 6 intentional skips, and 3 failures. The Claude cache read measured 188.8 ms against its required 100 ms ceiling. The eight writer cache merge and one CLI configuration test each exceeded Vitest's 5 second ceiling. No assertion about request policy, parsing, identity, or product output failed.

This is a real red gate. No timeout will be raised and no assertion will be removed. The three failures will be run alone, without sibling test files competing for resources, to distinguish a product performance defect from runner induced timing contamination. Shipping remains held either way until the complete command is green from one committed head.

Pane 29 had created `4e40355` on its separate branch before the handover. Pane 30 reviewed the complete diff and retained it by a fast forward. It changes two independent cache reads from sequential execution to `Promise.all`, while preserving both reads, their validation, and every existing assertion. Pane 29's report claims and generated artifacts were not imported as evidence.

At 05:05 BRT the three affected files ran alone in one Vitest worker while pane 29's installer build was still consuming machine resources. All 73 tests passed. The eight writer merge completed in 1.09 seconds and the CLI configuration case completed in 351 ms. The Claude cache test retained and passed its internal 100 ms assertion. Vitest's displayed 381 ms for that test includes fixture setup and cleanup outside the measured cache read.

The runner now executes test files sequentially. No test timeout, performance budget, assertion, fixture, or product behavior was changed. This removes sibling suite workload from real wall clock measurements while continuing to test the same product paths under their original ceilings.

At 05:08 BRT the complete root `pnpm test` command passed on `387f5a0`. All 20 provider specifications passed. All five language catalogs matched. TypeScript test compilation passed. Vitest passed 817 tests with 6 intentional skips across all 32 files. The command ran on exact Node 24.15.0 and pnpm 9.15.0 while pane 29's separate installer build was still active.

At 05:12 BRT `cargo fmt --check` passed and the complete `cargo test --no-fail-fast` command passed. The library ran 289 tests with zero failures. The binary and documentation targets ran zero tests and completed successfully. The command had a 900 second process tree limit.

Workspace type checking passed after rebuilding all five internal declaration surfaces. Every workspace package completed `tsc --noEmit` successfully on Node 24.15.0.

The workspace production build passed. The desktop UI assembled 26 compiled modules, one token sheet, and 8 window files. All 11 first run tests passed. The standalone Next 15.5.21 production build compiled successfully and generated all 96 static pages with Supabase variables explicitly absent.

Pane 29 later created `70b9658` on its separate branch. Pane 30 reviewed it against the locally installed updater plugin source and retained it as `45b0a17`. The updater configuration has no endpoint and no signing key, which makes the deliberately unsigned launch start with a typed unconfigured update state and no update network request.

At 05:32 BRT one uninterrupted, individually bounded battery passed on exact commit `45b0a1781300cfe222e61f3ca5bedb248a7e91b9`. It passed Cargo formatting, 289 Rust library tests, binary and documentation targets, 20 provider specifications, all five language catalogs, test compilation, 817 Vitest tests with 6 intentional skips, workspace type checking, workspace build, desktop icon generation, desktop UI assembly, 11 first run tests, all 96 Next static pages, and final worktree hygiene. No tracked file changed during the battery.

At 05:34 BRT Gitleaks 8.30.1 scanned the complete public history of 243 commits and the complete private Pro history of 13 commits. Both scans found no leaks. `git ls-files "*.pem"` returned no tracked PEM file.

At 05:40 BRT the first independent Antigravity audit of exact commit `45b0a1781300cfe222e61f3ca5bedb248a7e91b9` exited with code 1 because the `agy` client reached its default five minute print wait. It returned no verdict. This is not a YES, so every release operation remains held. The client documents `--print-timeout`; one focused retry will use a 30 minute client wait inside a separate 31 minute process tree limit.

At 05:43 BRT the first retry wrapper encountered a local PowerShell API compatibility error before it passed any audit argument. It started `agy` without a prompt, so pane 30 immediately interrupted that child. No audit ran and no verdict was produced. The corrected wrapper uses an encoded child process, redirected output, and the same 31 minute process tree limit.

At 05:55 BRT the corrected independent Antigravity audit exited successfully inside both limits. It audited exact commit `45b0a1781300cfe222e61f3ca5bedb248a7e91b9`, ran `cargo test --lib` from a clean worktree, and returned YES. Its complete standard output is preserved verbatim below, including the duplicated answer emitted by the client.

```text
I will find the `OpenLimiter` repository in your system and then perform the requested audit on the specified commit. I'm currently scanning your home directory for the repository.
YES

**Exact Commit Audited**
`45b0a1781300cfe222e61f3ca5bedb248a7e91b9`

**Tests Run**
`cargo test --lib` inside `apps/desktop/src-tauri` from a clean worktree. The test suite successfully completed without requiring `apps/desktop/scripts/build-ui.mjs` because `apps/desktop/ui/dist/.gitkeep` is tracked in the repository, safely bypassing the missing `frontendDist` panic in Tauri's builder.

**Hard Request Numbers (For Two Resolved Accounts)**
*   **Claude:** 8 requests per hour (15m interval, 1 hop).
*   **Codex:** 24 requests per hour (5m interval, 1 hop).
*   **Antigravity:** 24 requests per hour (10m interval, 2 hops per fetch: bootstrap + quota).
*   **OpenCode:** 48 requests per hour (5m interval, 2 hops per fetch: auth + workspace).
*   **Grok:** 24 requests per hour (5m interval, 1 hop).
*   **Kimi:** 24 requests per hour (5m interval, 1 hop).
*   **Gemini CLI:** 8 steady-state requests per hour (15m interval, 1 hop). Takes 1 extra bootstrap hop per account on a cold launch.
*   **OpenRouter:** 24 requests per hour (5m interval, 1 hop).

**Concurrency & Burst Behavior**
*   **Cold Launch Burst:** Up to 8 providers queried sequentially per process. Gemini CLI and Antigravity will perform their extra bootstrap hop.
*   **Wake / Recovery Burst:** Up to 8 sequential queries, but Gemini CLI skips the bootstrap hop since the companion project is held in memory (`GeminiCliOauthRuntime`).
*   **Maximum Outbound Concurrency:** Exactly 1 concurrent provider request per process. Cross-process concurrency is limited to 1 concurrent request per provider at a time, governed by the `request-policy.lock` file lock and the `next_request_at` spacing mechanism.

**Blast Radius & Provider Blocking**
If Anthropic blocks Claude tomorrow, only the `Claude` entry in the `request-policy.json` document receives a `blocked_until` deadline. The shared policy file isolates provider states perfectly. Codex, Antigravity, OpenCode, Grok, Kimi, Gemini CLI, and OpenRouter will continue polling without interruption, and the rest of the application will remain fully functional.

**Remaining Risk**
*   **Process Death Freeze:** If the application hard-crashes during an active fetch, the OS drops the file lock immediately (unfreezing the queue), but the conservative 24-hour `PROVISIONAL_REQUEST_SECONDS` reservation left in `state.accounts` will prevent that specific account from being retried until the next day unless it is manually overridden.
*   **Multi-hop Automation:** Antigravity and OpenCode always require 2 hops per fetch. This doubles their HTTP footprint and slightly elevates the risk of triggering strict anti-automation defenses on those endpoints.
*   **503 Without Retry-After:** A `503 Service Unavailable` response missing a `Retry-After` header falls through to the standard interval rather than the 1-hour `RATE_LIMIT_SECONDS` backoff applied to 429s.
YES

**Exact Commit Audited**
`45b0a1781300cfe222e61f3ca5bedb248a7e91b9`

**Tests Run**
`cargo test --lib` inside `apps/desktop/src-tauri` from a clean worktree. The test suite successfully completed in 17.25 seconds without requiring `apps/desktop/scripts/build-ui.mjs` because the `apps/desktop/ui/dist/.gitkeep` file is tracked in the repository. This safely bypasses the missing `frontendDist` directory panic in Tauri's builder and fulfills the clean build requirement.

**Hard Request Numbers (For Two Resolved Accounts)**
*   **Claude:** 8 requests per hour (15m interval, 1 hop).
*   **Codex:** 24 requests per hour (5m interval, 1 hop).
*   **Antigravity:** 24 requests per hour (10m interval, 2 hops per fetch: bootstrap + quota).
*   **OpenCode:** 48 requests per hour (5m interval, 2 hops per fetch: auth + workspace).
*   **Grok:** 24 requests per hour (5m interval, 1 hop).
*   **Kimi:** 24 requests per hour (5m interval, 1 hop).
*   **Gemini CLI:** 8 steady-state requests per hour (15m interval, 1 hop). Takes 1 extra bootstrap hop per account exclusively on a cold launch.
*   **OpenRouter:** 24 requests per hour (5m interval, 1 hop).

**Concurrency & Burst Behavior**
*   **Cold Launch Burst:** Up to 8 providers queried sequentially per process. Gemini CLI and Antigravity will perform their extra bootstrap hop.
*   **Wake / Recovery Burst:** Up to 8 sequential queries, but Gemini CLI skips the bootstrap hop since its companion project is held in memory (`GeminiCliOauthRuntime`).
*   **Maximum Outbound Concurrency:** Exactly 1 concurrent provider request per process. Cross-process concurrency is strictly limited to 1 concurrent request per provider at a time, governed by the `request-policy.lock` file lock and the `next_request_at` shared spacing mechanism.
*   **Two Hop Behavior:** Antigravity and OpenCode always do 2 hops per fetch. Gemini CLI only does 2 hops on cold launch/missing cache and 1 hop otherwise.

**Blast Radius & Provider Blocking**
If Anthropic blocks Claude tomorrow, only the `Claude` entry in the `request-policy.json` document receives a `blocked_until` deadline. The shared policy file isolates provider states perfectly. Codex, Antigravity, OpenCode, Grok, Kimi, Gemini CLI, and OpenRouter will continue polling without interruption, and the rest of the application will remain fully functional.

**Remaining Risk**
*   **Process Death Freeze:** If the application hard-crashes during an active fetch, the OS drops the file lock immediately (unfreezing the queue), but the conservative 24-hour `PROVISIONAL_REQUEST_SECONDS` reservation left in `state.accounts` will prevent that specific account from being retried until the next day unless it is manually overridden.
*   **Multi-hop Automation:** Antigravity and OpenCode always require 2 hops per fetch. This doubles their HTTP footprint and slightly elevates the risk of triggering strict anti-automation defenses on those endpoints.
*   **503 Without Retry-After:** A `503 Service Unavailable` response missing a `Retry-After` header falls through to the standard interval rather than the 1-hour `RATE_LIMIT_SECONDS` backoff uniformly applied to 429s.
```

At 05:58 BRT the authenticated GitHub target was confirmed as public repository `lucaswebsystems/openlimiter`, with `main` as its default branch and `workflow` scope available. No `v1.0.0` tag or release exists. The desktop configuration is version 1.0.0 and the release workflow excludes macOS.

At 06:00 BRT the release workflow gained a 90 minute job limit plus ephemeral install and launch smoke tests. Windows installs the unsigned NSIS package into the runner temporary directory, verifies the installed executable remains alive for ten seconds, then stops it. Linux installs the generated deb package, verifies the installed executable remains alive under a virtual display for fifteen seconds, then lets the bounded smoke command stop it. A failed smoke leaves only a draft release and blocks publication.

The release consistency check also found that the web download generator still points to version 0.4.0 while the desktop candidate is 1.0.0. That would send launch visitors to obsolete files. The version metadata and changelog will be corrected before any push.

At 06:02 BRT the reviewed launch narrative commit `374666a` was retained as `8dfaf82`. It explicitly says every automatic reader remains unverified, private provider interfaces can change or be blocked, Windows is unsigned, macOS is unavailable, and Pro is coming soon. Its changes replaced claims that Pro was already purchasable.

At 06:03 BRT commit `b312699` aligned the web download generator and dated changelog with version 1.0.0. The generated download page now contains 15 references to release `v1.0.0` and zero references to `v0.4.0`.

At 06:04 BRT the production Vercel project was confirmed under account `lucas-teixeira`. It has no production environment variables and its configured cloud runtime is Node 24.x. No Supabase or Stripe configuration can activate on this deploy.

At 06:08 BRT the affected release web gates passed on exact Node 24.15.0. All 790 English message keys matched every one of the four translations. The standalone Next 15.5.21 production build compiled, type checked, and generated all 96 static pages with Supabase variables absent. Generated Pro and pricing HTML contains zero checkout, Stripe, or Supabase links, zero rendered monthly or yearly checkout controls, and 39 coming soon messages. Existing lint and metadata warnings did not fail the build.

At 06:10 BRT `origin/main` was fetched without prompts. It has not diverged and remains 80 commits behind the release branch. Gitleaks 8.30.1 then scanned all 247 public commits and 9.86 MB of committed history with no leaks. The clean index contains no tracked PEM file.

## Next step

Push `main` without force and require the pushed branch checks to pass before creating and pushing tag `v1.0.0`.
