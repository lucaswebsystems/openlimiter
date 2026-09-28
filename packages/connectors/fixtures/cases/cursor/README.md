# Cursor fixture provenance

All data here is synthetic. Shape facts come from the Cursor recipe in
`launch-2026-10-relaunch/research/01-codenotch-harvest.md`, dated September 28, 2026.
No live account, credential, email or provider response was read to build these cases.
No upstream implementation was copied or translated.

The fixed observation clock is August 7, 2026 at 12:00 UTC. The plan runs from
August 1 to September 1 (2,678,400 seconds). Auto and API percentages are reported
independently. Included usage derives its percentage from used divided by limit.
Over limit readings saturate the quota bar at 100, as required by the frozen
snapshot contract. Missing meters never become zero.
Unlimited has an explicit availability state; its numeric placeholder is not a quota.

The 15 cases cover an individual plan, near limit, over limit, team included
usage, team over limit, zero, partial availability, unlimited, 401, 403, 429
with Retry After, schema drift, malformed percentages, a missing billing window
and an invalid limit. Expected outputs were calculated independently of both parsers.

Both differential suites use these pinned cases and expected results. Acquisition
tests use a disposable SQLite database with an active WAL and a mock transport.
They do not establish live endpoint compatibility. The only permitted label is:

Experimental: parser tested on fixtures; live acquisition unverified

## Round 1 checkpoint, September 28, 2026, superseded

The approved round 2 integration supersedes the blockers below. See
`ROUND2-REPORT.md` for current verification and the generated file handoff.

Base reviewed: `800edcb2078c8de5f09e2dc60fc8dd9a6bdb0fa3`, branch
`relaunch/l1b1-cursor`. The unit is incomplete and is not ready to integrate.

Both parsers match all 15 pinned cases. The TypeScript differential suite passes
65 tests. Rust passes 539 unit tests and 23 integration tests; cargo build passes.
Both SQLite
readers pass the active WAL preservation test. No real credentials or live
provider endpoint were accessed. Every command used disposable HOME,
USERPROFILE, APPDATA, LOCALAPPDATA and XDG directories.

Root build and typecheck fail because the shared ProviderCode vocabulary lacks
CURSOR. ConnectorMaturity also lacks experimental. The focused acquisition
suite passes 8 tests and fails 8 successful reading cases because core
normalization rejects the provider. Authentication refusal, rate limit,
schema drift, WAL preservation, path and request boundary checks pass.

Root test and isolated registry generation stop at unknown reader_id
cursor_usage. The registry also needs cursor_session, synthetic evidence and
VERIFIED_FIXTURES support. No generated mirror was changed.

Requests to other owners, or changes requiring an expanded allowlist:

1. Add CURSOR and experimental to `packages/core/src/types.ts`, then complete
   provider recognition and CLI dispatch in `packages/cli/src/cli.ts`.
2. Extend `scripts/validate-provider-specs.mjs` for the Cursor route and honest
   fixture verification. Generate mirrors for Fable to land.
3. Finish native routing and acquisition: registry variants, endpoint and cookie
   handling in `net.rs`, local discovery in `provider_detection.rs`, mapping in
   `poll_identity.rs`, policy and scheduler wiring, and `collector_runtime.rs`.
   Add CURSOR to the native snapshot allowlist. Reuse the supplied session
   reader and parser; do not copy the database or bypass the shared lease.
4. Wire the exact Experimental label into setup and details, plus translations
   through L7. The current constant and spec comment do not constitute UI proof.

The strict lane allowlist prevented those shared integration edits. Approval
questions remain pending. Vault logging was not saved because the vault is
outside the writable workspace; this checkpoint is the local handoff.
