# Wire contract v3

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
it uses `accountId ?? "default"` and the meter as `window_id`. A percent
reading becomes `usage_percent`, and `usedAmount` becomes `amount`, in its
original currency. A nonpercent reading needs an explicit amount or
availability; unit alone never determines its kind or currency. Availability
suppresses numeric percent, including a placeholder zero. `retry_at` is only
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
