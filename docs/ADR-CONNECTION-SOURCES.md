# Connection source decisions

Five architecture decisions the connection layer is built on. The Overclock
Redline research packet requires all five to exist and be reviewed before any
provider adapter is written, and that ordering is deliberate: every one of these
is expensive to reverse once a provider ships against it.

Each records the decision, why, and the strongest argument against it. The
argument against is not decoration. If one of these is ever revisited, the
counter-argument is where the revisit should start.

Status of all five: **accepted 2026-08-16**.

---

## ADR 1: Claude Code quota source

**Decision.** Claude Code's documented `statusLine` payload is the primary and
only source of Claude quota. OpenLimiter never polls an Anthropic endpoint to
learn a subscription's remaining quota.

**Why.** The payload is provider generated and server authoritative. It carries
`rate_limits.five_hour` and `rate_limits.seven_day`, each with
`used_percentage` and a `resets_at` in epoch seconds, and it arrives naturally
after a real Claude response. That means no estimation, no OAuth refresh, no
polling cadence to tune, and no path by which monitoring consumes the quota it
is monitoring. `packages/connectors/src/claude.ts` already parses exactly this
shape.

Both windows are independently optional. When `rate_limits` is absent the reader
keeps the previous observation until its stale TTL expires and **never writes a
zero**, because a missing reading is not an empty quota.

**Argument against.** It is a single point of failure with no fallback: a user
who has not sent a Claude message since connecting sees nothing, and the honest
answer is "waiting for your first Claude response" rather than a number. A
polling source would fill that gap. We accept the gap, because the alternative
is a monitor that spends the user's quota to report on it.

---

## ADR 2: Codex quota source

**Decision.** Move to the Codex app-server JSON-RPC interface: `account/read`,
`account/rateLimits/read`, and rate limit update notifications, over one
supervised child process per connection. The existing Wham path stays as a read
only fallback marked **Experimental**.

**Supersedes** the 2026-08-11 decision that made the Wham usage route plus a
copied session token and account header the Codex source. That decision is not
withdrawn quietly; it is superseded on the record, with Lucas's explicit
agreement, because the app-server is a programmatic interface OpenAI designed
for this and Wham is not.

**Why.** Local rollout and session files carry missing or null rate limit
information and no reliable account identity. The app-server gives structured
account identity, which the multi account model in ADR 3 requires and which the
file path cannot supply. Public Codex issue history also includes rate limit
state crossing between accounts, which makes OpenLimiter side account isolation
load bearing rather than nice to have.

**Rules this adapter is bound by.** A refresh never launches an inference
session. On read failure it backs off, marks the meter stale or errored, and
retries the read surface; it never falls back to asking Codex a question. Raw
protocol messages are never logged unredacted. The child process is supervised
natively, not by the webview.

**Argument against.** A long lived child process is a far larger surface than
reading a file, and the app-server protocol is unversioned and can move without
notice. Wham works today. This is why Wham survives as a fallback and why the
new path does not replace it until parity, version drift, account switch, crash
and hang tests all pass on a real account.

---

## ADR 3: Account identity

**Decision.** An observation is keyed by
`provider_id + product_id + account_id + meter_id`. Never by provider alone.

`account_id` is an **opaque local identifier**. Where a provider exposes an
immutable account or workspace id, that is stored locally and used to derive it.
Where only an email exists, the email is never a primary key: an opaque local id
is derived and stored, and the email is shown masked where it is shown at all.

When a provider CLI switches account, OpenLimiter must detect the identity change
**before** attaching new quota state. New account observations are never merged
into another account's history.

**Why.** Multi account is a property of storage and identity, not a feature. The
schema needs an account identity whether a user has one account or five, so the
only question is whether that identity is explicit or implied. Implied identity
is how one account's remaining quota ends up displayed under another's name.

**This decision has a commercial consequence, and it is intended.** Multiple
accounts per provider cannot be sold, because it is not a switch. That
contradicts nothing: it agrees with the standing rules that nothing local is ever
paywalled and the free tier has no connection cap. The Pro line that sold it was
retired in commit `81ceb9e`.

**Argument against.** It is a schema migration over already shipped data, and no
migration path is written yet. Existing connection ids must be preserved as
opaque local account ids during the migration or every user's history detaches
from its provider.

---

## ADR 4: Source refresh policy

**Decision.** Refresh policy is a property of the **source**, recorded on the
connection, not a global cadence. Three shapes exist and adapters are not forced
into one:

- **Event driven.** Claude's statusLine. No polling at all, no cadence, no timer.
- **Subscription.** Codex app-server notifications, where the protocol offers
  them, with a read on connect and on explicit refresh.
- **Polled.** Documented remote read APIs only, at a cadence the reader declares
  and the UI can never lower.

**Why.** A universal five minute poll is the pattern this design deliberately
does not copy. It wastes battery and provider goodwill on idle accounts, and it
cannot express an event driven source at all except by pretending it is a slow
one.

This **extends** the trusted per reader cadence locked on 2026-08-11 rather than
replacing it. The existing guarantee stands: a cadence lands on the connection
record at connect and list time, and the UI can never lower it. A missing cadence
must never become a default of one second.

**Argument against.** Per source policy is more surface than one number, and the
existing hardcoded cadences already work. It also still lacks a rule for
`429 Retry-After`, which no fixed cadence can respect. That gap is real and is
tracked, not closed by this decision.

---

## ADR 5: statusLine coexistence

**Decision.** Claude Code supports exactly one `statusLine` command. OpenLimiter
**never silently replaces** an existing one.

On detecting a foreign entry, the connect flow offers a **wrapper**: an
OpenLimiter owned dispatcher that receives the payload on stdin, hands a minimal
quota snapshot to the local collector, then invokes the user's previous command
and returns its output unchanged. The user's visible statusline is preserved
exactly.

The wrapper ships **behind a flag**, and guided manual setup remains the default
until the wrapper passes every Claude test in the research packet, including
Windows quoting, previous command timeout, and wrapper failure.

Every connect writes a timestamped backup first, shows the exact configuration
change before making it, and disconnect is digest guarded and surgical. Provider
authentication artifacts are never touched, in either direction.

**Why.** The previous position, guided manual only when a foreign statusLine
exists, is safe but gives up: it hands the user a config file to edit by hand at
exactly the moment they were promised one click. The wrapper is the only way to
have both, and it is a documented pattern rather than an invention.

**Argument against.** The wrapper means shell quoting and command chaining across
Windows, macOS and Linux, and when it breaks it breaks the user's terminal
prompt. A missing quota number is invisible; a broken prompt is not. That
asymmetry is the entire reason it ships behind a flag with manual as the default.
