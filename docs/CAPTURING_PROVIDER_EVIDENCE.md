# Capturing provider evidence

Three live readers ship on a request contract observed against real accounts on
2026-08-07, and on no captured **response** at all. The registry says so on
every run, `node scripts/validate-provider-specs.mjs --require-captures` fails
because of it, and each provider's contract test prints its own skip reason.
That is the correct shippable state, not an oversight. This document is how it
stops being the state.

**Nobody should paste a raw provider response into this repository.** Run it
through the reducer instead.

## The rule

A capture is reduced **by construction, not by redaction**. The reducer does not
scan a payload for things that look like secrets and remove them. It reads the
handful of fields a parser needs, discards the entire rest of the document, and
rebuilds a minimal payload from what survived. An account id, an email, a token,
a cookie value, a plan name, a workspace handle, or a field a provider adds next
year cannot survive that even in principle, because nothing is copied across
unless `scripts/sanitize-capture.mjs` names it.

What survives, and nothing else:

| Provider | Kept |
|---|---|
| Codex | the percentage, the window length in seconds, the reset as **seconds from capture** |
| Antigravity | per bucket: the pool prefix (`gemini` or `3p`), the window name, the remaining fraction, the reset as seconds from capture |
| OpenCode | per window: the label, the percentage, the countdown in seconds. The page itself is discarded |

Resets become **durations**, never instants. A wall clock instant dates the
capture, so a fixture pinning one either expires or quietly records when
somebody was working. Durations replay against any clock.

Percentages and fractions are kept exactly as they were. A number is not
identifying, and a rounded one would stop the fixture proving the parser reads
real values.

**Every number must also pass the bound its production parser applies.** A
percentage must be 0 to 100, a fraction 0 to 1, a countdown between one second
and a year, and a reset must be in the future. This is not a formality. Refusing
arbitrary strings while accepting arbitrary numbers is only privacy-preserving
because nobody looked: anything the provider put where a percentage belongs, an
account identifier, an invoice figure, a byte count, would have come through as
a number. A value that is not the meter it claims to be is refused rather than
reduced, and the message says which field and what range a real one occupies.

The OpenCode reduction stops 2,000 characters past the last window label, the
same bound the parser uses. It used to read to the end of the saved page, so any
percentage below the monthly label, an invoice line, a discount, a storage bar,
would have been captured as the monthly reading and frozen into a fixture.

The reducer also refuses to emit anything that is not a bounded number or a word
from a closed vocabulary. If a future edit to a reducer starts copying a provider
string across, or emits a number that skipped its bound, the run fails and says
which field.

## Getting the raw payload

Save one raw response to a file. Nothing is uploaded, logged or transmitted:
the script reads a file and prints to your terminal.

- **Codex** — the JSON body of `GET https://chatgpt.com/backend-api/wham/usage`,
  authorised with the session the Codex client already holds. Save as `.json`.
- **Antigravity** — the JSON body of the
  `POST .../v1internal:retrieveUserQuotaSummary` call, empty `{}` body, bearer
  token, and a **non empty** User-Agent (the same valid token is answered 403
  without one). Save as `.json`.
- **OpenCode** — the HTML of the logged in workspace page,
  `https://opencode.ai/workspace/<handle>/go`. Save as `.html`.

## Running it

```
node scripts/sanitize-capture.mjs --provider codex --in raw-codex.json
```

It prints everything that survived. **Read all of it.** It is a handful of
numbers, and that reading is the actual safety mechanism; the script only makes
the reading short. Then:

```
node scripts/sanitize-capture.mjs --provider codex --in raw-codex.json --write
```

which freezes it into the fixture slot in `packages/connectors/src/fixtures.ts`,
dated today, and flips its status from `pending_capture` to `captured`. It
refuses to overwrite a slot that already holds a capture: replacing one is a
deliberate edit with a reviewed diff.

Then set that reader's `evidence_status` to `captured` and its
`last_verified_at` to the same date in the provider's spec under
`provider_specs/`, and run:

```
node scripts/validate-provider-specs.mjs --emit
node scripts/validate-provider-specs.mjs --require-captures
pnpm test
```

The provider's contract test switches automatically: it asserts the captured
branch instead of the pending one, and parses the rebuilt payload.

## What a capture does not buy

`verification: UNVERIFIED` does not move, and neither do the honesty labels. A
capture proves OpenLimiter observed a shape. It does not turn an internal
endpoint into a documented API, and it does not make OpenCode's authenticated
page anything other than a scrape. Those labels describe the **method**, not the
amount of evidence gathered about it.
