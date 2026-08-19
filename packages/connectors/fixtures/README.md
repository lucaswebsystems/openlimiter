# Frozen provider fixtures

One frozen, redacted sample response per provider. These are the real response
**shapes** a working reader observed, recorded in
`Product Idea/reference-implementation`, with every identifying value removed.
They exist so the parser for each provider can be run offline against a real
shaped response and asserted to produce the right numbers, with no live provider
call and no network.

| File | Provider | Interface | Evidence |
|------|----------|-----------|----------|
| `claude.statusline.json` | Claude | Claude Code statusline payload | documented |
| `openrouter.credits.json` | OpenRouter | Documented credits API | documented |
| `codex.usage.json` | Codex | Internal usage endpoint | observed against a real account |
| `antigravity.quota.json` | Antigravity | Internal quota summary | observed against a real account |
| `opencode.workspace.html` | OpenCode | Logged in workspace page (HTML) | scrape of a rendered page |

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
seconds, Antigravity in RFC3339) because that is what a real response carries.
The test does not read them against the wall clock; it reads them against the
fixed `captureClock` in the manifest, so the fixtures are deterministic and
never rot.

## Verification marker

`verification.json` records, per provider, whether its frozen fixture is trusted
enough to call the parser **fixture verified**. This is a statement about the
fixture and the parser only. It is not the honesty `verification` label in
`provider_specs`, which stays `UNVERIFIED` for every provider whose interface the
vendor does not officially publish.
