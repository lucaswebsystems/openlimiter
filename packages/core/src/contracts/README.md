# Wire contract v3

2026-09-28: contract v3.1, Cursor added to the local provider vocabulary,
experimental maturity aligned with the existing registry schema. Wire version remains 3.

This folder freezes a future sync contract. `WIRE_SCHEMA_VERSION_V3` is 3.
The envelope keeps the v2 identity, sequence, timestamps, usage array and API
spend array. Its `schema_version` is 3. No existing emitter uses this module.
`wire-v3.schema.json` uses JSON Schema draft 2020-12; the root describes an
envelope and `#/$defs/sample` describes one usage sample. Objects are closed,
including evidence, forecast input and API spend samples.

## Local and wire schemas

`Snapshot` is the full local connector reading. `WireSampleV3` is the sync
projection. It preserves the v2 sample allowlist: `account_id`, `provider`,
`meter`, `code`, `window_id`, `usage_percent`, `percent`, `reset_at`,
`resets_at`, `observed_at`, `stale`, `amount`, `currency`, `source_period`.
The seven optional additions are `source`, `precision`, `verification`,
`verification_evidence`, `kind`, `availability`, `retry_at`. Their closed
value sets come from the local contract, including `USD` and `CNY` currency.
Evidence uses `provider_version`, `account_shape`, `os`, `date`; only
`VERIFIED_LIVE` may carry it. Live evidence remains optional.

`toWireSampleV3(snapshot)` copies declared metadata. Like the existing CLI,
it uses `accountId ?? "default"` and the meter as `window_id`. The meter
contract (`meterReading` in `data-rules.ts`) decides the numbers: a used share
becomes `usage_percent`, and its money pair's `usedAmount` becomes `amount`, in
its original currency; any other measure (a balance, a spend, a count) becomes
its own value as `amount` in its stated currency, with `kind` carrying its
direction. An amount with no currency has no v3 representation until the
contract carries its unit, and is refused rather than guessed; unit alone never
determines kind or currency. Availability suppresses numeric percent,
including a placeholder zero. `retry_at` is only
valid with `rate_limited`. Staleness is evaluated at conversion time
(`expiresAt <= now`); the optional second argument supplies an explicit
clock for deterministic tests and senders.

The wire cannot represent a full `Snapshot`: expiry, window duration, unit,
limit amount, account label, provenance, writer and other connector labels
are absent. `readWireSample` therefore returns `LocalWireSample`, a lossless
camelCase projection, rather than inventing a complete snapshot. It retains
aliases and nulls; paired aliases must agree. Passing that projection back
to `toWireSampleV3` preserves every received field. Full snapshot equality
is deliberately not promised for fields the v2 shape cannot carry.

## Unknown metadata and validation

Samples have no version tag; the envelope owns the version. The reader
accepts either sample vocabulary. V2 metadata stays absent and therefore
reads as `undefined`. There are no defaults for source, precision,
verification, evidence, kind, availability or retry time. A v3 sample may
also omit all metadata. Zero is a valid reading and is never absence.

The standalone reader requires explicit account, provider, window,
observation time and stale state. Legacy server requests relying on an
envelope timestamp or server stale default must first supply those values
from their envelope context. Unknown keys, wrong types, invalid enums,
incomplete money pairs and invalid metadata combinations throw `TypeError`
with a field and reason. Instants use canonical millisecond UTC ISO strings.
The reader additionally checks actual calendar dates, alias equality and
source period ordering, relationships JSON Schema cannot fully express.

## Negotiation and shared fixtures

`chooseWireVersion(serverAccepted)` returns 3 only when the list explicitly
contains 3. Empty, missing support represented as `[]`, v2 only and unknown
future versions all select 2. This function neither sends nor downgrades a
sample. Existing v2 emitters remain unchanged until integration.

L4 adds server advertisement and validates envelopes plus the samples in
`packages/core/fixtures/wire/` against this schema and its server decoder.
Each fixture contains `schema_version`, `sample`, and either the expected
`local` projection or an `error` substring. These wrappers are test data,
not sync envelopes. L5 runs the same fixtures through the browser decoder,
asserts unknown metadata on v2, rejects the invalid samples, and checks
`local -> v3 -> local` equality before enabling negotiated v3 uploads.
Neither layer may upgrade verification, infer kind from unit, convert CNY,
or render an unavailable row as a numeric percent.

## Policy vectors for L1a

`policy-vectors.json` contains shared retry, acquisition lease and freshness
vectors, plus their embedded JSON schema. The differential TypeScript suite
checks that schema only. L1a must connect production implementations to these
answers; this unit introduces no policy implementation.

Retry attempt zero waits 60 seconds, doubling to 900 seconds before additive
nonnegative jitter. The next allowed time is the later of that local deadline
and the server Retry-After deadline. The collector ceiling is 24 hours and the
policy ceiling is 7 days. A later server date is retained as both the next
allowed time and a blocking deadline, never shortened to the ceiling.

A live acquisition lease excludes desktop and CLI, including duplicate work by
the same owner. Expiry equality permits acquisition. Replacing an expired lease
owned by the other process is a takeover. Freshness expires at TTL equality;
a future observation is unavailable.

The 60 second lease and TTLs (native_payload 60 seconds, documented_api,
internal_payload and local_file 300 seconds) are explicit proposed values pending
plan confirmation, because the allowed source files do not specify these policy
values. The JSON decisions field records that status. Resolve it before L1a
uses these vectors as approved product policy.

## Activity, notification, tray and Rail contracts (L0a3.1)

`activity/contract`, `contracts/notify` and `contracts/surfaces` are public
package subpaths and root exports. They contain only types, constants,
validators and pure functions. No surface, collector or delivery path is wired.
L2 owns adapters and spool consumption, L3 consumes the display and surface
records, and L5 consumes upload records and remote notification decisions.

### Activity v1

`ACTIVITY_EVENT_VERSION` is 1. Event ids and the exact opaque payload session
id are local identifiers. Sequence is a nonnegative safe integer, monotonically
increasing within a session across all sources. L2 must coordinate sequences
before using this reducer; independent per source counters are not compatible.
The closed agent, state, outcome, source and confidence vocabularies are in
`activity/contract.ts`. Timestamps are canonical millisecond UTC ISO instants.
Optional structural signals distinguish a question, Claude Stop, vanished
process and ended session without retaining any question or approval text.
An inferred completion is invalid; failure and cancellation are outcomes, never
successful completion. SessionEnd becomes unknown.

`readActivityEvent(serialized, now, origin)` enforces original UTF8 byte size,
shape and age. `isActivityEvent` validates parsed values. Both default to the
hook boundary: only hook source and optional ppid are allowed; pid and startedAt
are rejected. The desktop boundary allows other sources and a paired pid and
startedAt, resolved by the desktop consumer. A changed process identity makes
the session unknown and clears its target. No process data leaves projections.

Frozen limits: 8 KiB per serialized event, 16 MiB spool, maximum event age
24 hours, live session cap 64 (the proposed value selected for v1), idle and
ended retirement at 24 hours. Events exactly 24 hours old are allowed; older
events and future observations are rejected. Retirement occurs at equality.
These constants do not implement filesystem ownership, spool pruning, live
session admission or bounded scanning. L2 owns those operations. Retirement
uses stateChangedAt or endedAt so repeated idle or terminal polls cannot delay it.

`nextSessionState(previous, event)` takes validated events and returns session,
notification kind or null, and a decision reason. Rules run in this order:

| Condition | State result | Notification |
| --- | --- | --- |
| Different session or agent | Keep previous | None |
| Seen event id or equal sequence | Keep previous | None |
| Lower sequence or older observation time | Keep previous | None |
| Sidechain attributed to parent | Keep parent, advance dedupe | None |
| Vanished, ended or changed process identity | Unknown, inferred, ended | None |
| Previous explicit, incoming inferred | Keep winning evidence, advance dedupe | None |
| Explicit user question | Waiting, remember pending question | Waiting on transition |
| Claude Stop after pending question | Waiting | None if already waiting |
| Explicit busy | Busy, clear pending question | None |
| Other accepted evidence | Incoming state and confidence | Explicit waiting or done transition only |
| First observation (overrides every notification rule) | Establish baseline | None |

A child with its own session id is handled as its own session; passing it to
its parent's reducer is a no op. `isSidechain` marks a child observation using
the parent id and suppresses its state update. A failure or cancellation always
suppresses success notification. Equal confidence uses later ordered evidence.
Liveness loss is the deliberate exception to explicit evidence precedence.
Fresh inferred observations alone cannot release explicit waiting; an explicit
event or liveness loss must do that. A later explicit busy clears the N2 question.

`dedupeActivityEvents` provides batch dedupe by global event id and by the tuple
(session id, sequence). The reducer also retains event ids and a sequence high
water mark per session. L2 persists baselines and dedupe across restart and
reconnect; it must apply the spool and retirement bounds to retained history.
The pure reducer does not store or send anything, nor does it bound that history
on behalf of the consumer. Event ids must be unique across sessions.

`toDisplayRecord` and `toUploadRecord` construct allowlisted objects. Both carry
a stable SHA256 pseudonym of the domain separated agent and payload session id,
agent, state, confidence and observation/state timestamps. Local aliases, raw
event and session ids, parent ids, process identity and terminal handles are
absent. Display additionally permits the closed outcome enum. Upload permits
no event content or outcomes. A userProjectLabel is copied only from a separate
user preference on the session; event input cannot set it. It must never be
derived from a path, prompt or transcript. Hashing is pseudonymization, not an
authorization boundary or a promise of unlinkability. F17 tests poison all free
text event fields and inject sensitive payload fields, then verify neither
projection contains the marker. Unknown payload fields are rejected at ingress
and never copied by the reducer. Enum and timestamp fields are validated data,
not free text. The SHA256 implementation is browser compatible and tested
against Node's independent implementation on multiple block lengths and UTF8.
`isActivityDisplayRecord` and `isActivityUploadRecord` validate these public
boundaries, including closed fields, pseudonym shape, enum values and ordered
timestamps. An upload carrying a process block, local alias or outcome is invalid.

### Notification decisions

Submissions have kind, dedupeKey, provider, account (null for the unnamed
account), localChannel (popup or none), and a remoteChannel flag. Dedupe keys
accept the existing provider codes plus MUSE and CURSOR, so activity support
does not depend on having a quota connector. The same set applies to mute lists.
The keys
use disjoint `threshold:` and `activity:` namespaces with canonical JSON tuples
to avoid delimiter collisions. Threshold keys scope provider, account, meter,
persisted cycle, kind and threshold (60, 80 or 90); activity keys scope provider,
account, sanitized session id, transition sequence and kind. Validation checks
the namespace and identity match the submission.

`shouldNotifyLocally` never accepts or reads entitlement. R2 local popups remain
free. `shouldSendRemote` additionally requires remoteNotifications entitlement.
Each uses its own channel's enabled flag, quiet hours, snooze and provider mute.
Quiet hours include their start and exclude their end; they may cross midnight,
and equal endpoints disable the interval. The caller supplies the UTC offset
at now to handle timezone and DST. Snooze expires at equality. Invalid values
fail closed. Preferences on one channel never suppress the other channel.

These are eligibility decisions, not delivery or threshold transition engines.
Consumers must retain baselines and dedupe across restart, suppress initial,
stale and account switch alerts, coalesce threshold jumps, and never replay a
delivery on phone reconnect. Those behaviors remain with the existing notifier.

### Tray and Rail models

`SurfaceAccountRow` is shared by the Tray and Rail aliases. A row keeps provider,
account, headlineMeterId, kind, value, explicit used or remaining meaning,
windowLabel, its own resetAt, freshness, availability, band, precision,
fidelityMarker and state counts. Nonexact precision requires the corresponding
estimated, manual or unknown marker. Unavailable and unlimited rows carry null
values. Session counts must be nonnegative integers and total at most 64.

Bands use the UI thresholds: below 60 green, 60 to below 80 yellow, 80 to below
90 orange, 90 through 100 red. Bands always measure used percent. Remaining
values are converted before assigning a band. Stale, unknown, unavailable and
nonquota rows have the stale band and retain their distinguishing fields.

`traySummary(rows)` selects the highest used percent among fresh, available,
valid quota rows; it never sums or averages unrelated accounts. This is the
frozen selection policy. Ties preserve caller order. The summary says used
explicitly and retains the entire selected row, including its original meaning,
provider, account, window and same meter reset. Money balances, spend, token
counts, runtime info, unknown kind, unlimited, unavailable, stale and unknown
freshness rows are excluded from numeric selection. Zero remains numeric.
When no numeric quota remains the result is unknown with null value and no
selected row. Included and excluded counts preserve partial availability;
partial is true only when both sets are nonempty. Callers keep the input rows
for account detail even when excluded from the summary.

Codex checkpoint, 2026-09-28: L0a3.1 contracts and tests are confined to the
requested allowlist. No behavior or production action was added. Vault logging
is not saved because this unit restricts reads and writes to the named files.
Final verification: root `pnpm build`, `pnpm typecheck` and `pnpm test` each
exited 0. The full suite passed 68 files and 1,832 tests, with 8 skipped
(1,840 total). The new suites passed 54 activity, 37 notification and 49 surface
tests (140 total). Existing Windows fallback tests had timing/output failures
in early runs and passed in the final two full runs without edits to those files.
All three package subpaths loaded successfully. `git diff --check` passed.
Base commit: `5eef78a605b2f94249f65a414d5fbba1074b4fd8`. Changes remain uncommitted.
