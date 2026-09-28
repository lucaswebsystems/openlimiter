# Known parser divergences

Reviewed against commit `0dfc86edcde694130fc16db39b809a13d178af3c`.
L1a owns parser changes. Both suites execute every case, including these cases.
There are no skipped cases and no blanket expected failures.

Each linked JSON file contains the common `expected` answer plus exact
`knownDivergence.typescript` and `knownDivergence.rust` results. Both suites
assert their current result exactly. A new difference or a resolved divergence
fails until the contract and this list are deliberately updated.

| Provider and case | TypeScript result | Rust result | L1a issue |
| --- | --- | --- | --- |
| claude/existing | Six readings, including EXTRA_USAGE at 62.35 percent with USD 12.47 of 20 and an August 27 reset | Five readings, missing EXTRA_USAGE | [Extra usage field aliases and enable flag](claude/existing.json) |
| claude/extra-enabled | EXTRA_USAGE, unknown window | Same value and amounts, fixed window | [Billing window kind](claude/extra-enabled.json) |
| claude/unknown-weekly | SEVEN_DAY_HAIKU, rolling 604800 seconds | Same reading, unknown window and null duration | [New weekly bucket duration](claude/unknown-weekly.json) |
| codex/partial | FIVE_HOUR at 25 percent; malformed sibling dropped | Rejected | [Partial window recovery](codex/partial.json) |
| codex/countdown | FIVE_HOUR at 25 percent, reset at 12:10 UTC from supplied clock | Rejected | [Countdown reset support](codex/countdown.json) |
| codex/missing-reset | FIVE_HOUR at 25 percent, null reset | Rejected | [Missing reset handling](codex/missing-reset.json) |
| kimi/malformed-limits | Rejected | WEEKLY at 10.44921875 percent | [Malformed limits must reject](kimi/malformed-limits.json) |
| kimi/empty-used | WEEKLY at zero percent | Rejected | [Empty numeric strings must reject](kimi/empty-used.json) |

For partial Codex payloads and Claude bucket metadata, the common target keeps
the usable TypeScript reading. For malformed Kimi fields, the common target
rejects the document. These choices are recorded in `expected`, independently
of the pinned current results.

## Shared limitations

Both OpenRouter readers reject the key response shape, including valid zero and
a null (unlimited) limit. Both Codex readers reject a document containing only
unlimited credits and absent usage windows. These are visible shared support
gaps, not language divergences and not a claim that the provider responses are
invalid. No zero percentage is invented for an unlimited allowance.

The status 401 and 429 cases exercise each real parser on synthetic error bodies
and expect rejection. They do not test HTTP transport, credential refresh,
collector state transitions, or retry scheduling. Those belong to L1a and the
policy vectors.
