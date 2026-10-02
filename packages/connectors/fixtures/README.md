# Frozen provider fixtures

One frozen, redacted sample response per provider. Each file comes from either
a documented response, an observed reader, or the provider's official client
source, with every identifying value removed.
They exist so the parser for each provider can be run offline against a real
shaped response and asserted to produce the right numbers, with no live provider
call and no network.

| File | Provider | Interface | Evidence |
|------|----------|-----------|----------|
| `claude.statusline.json` | Claude | Claude Code statusline payload | documented |
| `openrouter.credits.json` | OpenRouter | Documented credits API | documented |
| `codex.usage.json` | Codex | Documented app server rate limits | documented |
| `antigravity.quota.json` | Antigravity | Internal quota summary | observed against a real account |
| `opencode.workspace.html` | OpenCode | Logged in workspace page (HTML) | scrape of a rendered page |
| `grok.billing.json` | Grok | Internal billing endpoint | response type in the official Grok CLI source |
| `kimi.usages.json` | Kimi | Internal usage endpoint | response type in the official Kimi CLI source |

`manifest.json` names, for each file, the parser that reads it, the clock to
read it against (`captureClock`), and the exact meters a correct parser returns.
The frozen test `test/frozen-fixtures.test.ts` reads the manifest, parses every
file, and asserts those numbers.

## Redaction

Every value that could identify a person, an account or a machine has been
removed or replaced with `REDACTED`: no emails, tokens, cookies, account ids,
usernames, session ids, transcript paths, machine paths, or workspace ids. What
remains is the response **structure** and neutral placeholder numbers chosen so
each reset instant still lands in the future of `captureClock` and inside its
window's plausibility horizon.

## Why absolute timestamps

Each file carries absolute reset instants (Claude and Codex in Unix epoch
seconds, with Antigravity, Grok, and Kimi in RFC3339) because that is what each response carries.
The test does not read them against the wall clock; it reads them against the
fixed `captureClock` in the manifest, so the fixtures are deterministic and
never rot.

## Verification marker

`verification.json` records, per provider, whether its frozen fixture is trusted
enough to call the parser **fixture verified**. This is a statement about the
fixture and the parser only. It is not the honesty `verification` label in
`provider_specs`, which stays `UNVERIFIED` for every provider whose interface the
vendor does not officially publish.

## Shared TypeScript and Rust cases

`cases/<provider>/<case>.json` is the single input corpus. Each case records the
provider, reader, fixed `now`, response status, headers, and either a synthetic
JSON `body` or a `fixture` path relative to this directory. Existing cases refer
to the original files above, so edits to a frozen response reach both suites.
The OpenRouter `key` and `credits` readers are exercised separately.

The TypeScript suite is `test/differential.test.ts`. The Rust suite is
`apps/desktop/src-tauri/src/differential_tests.rs`. Rust calls Claude's
`parse_usage` and the same `parse_body` entry point used by Codex and Kimi OAuth
collection, plus both OpenRouter reader identifiers. Neither suite uses the
network or reads credentials. Both discover every JSON case in each provider
directory and require a matching expected file with no orphan expectations.

### Normalized comparison form

`expected/<provider>/<case>.json` contains an `expected` object with `outcome`
(`readings` or `rejected`) and `readings` (an array, empty for rejection).
Each reading contains exactly these fields:

| Field | Representation |
| --- | --- |
| provider, meter, unit | Parser identifiers, unchanged |
| value | Numeric parser result, with no tolerance or rounding |
| window | Object with `kind` and nullable `durationSeconds` |
| resetAt | UTC ISO timestamp with milliseconds, or null |
| precision, source | Parser values, unchanged |
| kind, availability | Parser values, or null when legacy parsers omit them |
| currency, usedAmount, limitAmount | Stated amounts, or null for each absent field |
| observedAt | The fixed case clock, normalized to UTC ISO with milliseconds |

Readings sort by meter identifier. JSON integers and floats compare numerically
in Rust. Absent fields become null; the projection never infers durations,
percentages, money, availability, or resets. This is a parser comparison, before
cache normalization. Account identity, labels, provenance and expiry scheduling
are outside this projection. Freshness TTL is specified separately in the
policy vectors. All timestamps come from the case clock or the payload, never
the wall clock. The countdown case specifically exercises a relative reset.

For a current disagreement, the same expected file also carries
`knownDivergence` with a reason and exact `typescript` and `rust` answers.
Both suites mark the case visibly and check the corresponding pinned answer;
they never skip it or permit arbitrary differences. The common `expected`
answer remains the L1a target. Every exception must also appear in
[`expected/KNOWN_DIVERGENCES.md`](expected/KNOWN_DIVERGENCES.md).

### Adding cases

1. Add a synthetic case under the correct provider directory. Use the fixed
   clock `2026-08-07T12:00:00.000Z`. Include no token, email or real account id.
2. Add the matching expected file. Derive values from the payload and intended
   contract; never automatically bless parser output as the expected answer.
3. Run both suites. If the implementations disagree, record both exact results
   and their reason in the expected file and add the case to the divergence
   table. Parser fixes belong to L1a.
4. Run root `pnpm test` and `cargo test` in `apps/desktop/src-tauri`. Remove a
   divergence only after both implementations match the common expected file.

Malformed, partial, valid zero, credential expiry and rate limiting cases cover
every provider. Unlimited cases cover OpenRouter key limits and Codex credits;
the existing Claude and Kimi payload contracts expose no unlimited marker.
Error status metadata describes the response; the error body still reaches
each parser and must be rejected. The harness does not claim to exercise the
collector's HTTP response policy.
