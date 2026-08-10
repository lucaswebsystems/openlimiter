# Changelog

All notable project changes appear in this file.

## [0.2.0] (2026-08-10)

### Changed

- **Breaking, statusline format.** `openlimiter statusline` now renders one compact cell per provider, `NAME bar percent`, with a five block bar, led by the overall reason code and the routing recommendation. The previous release printed one plain line of names and percentages with no bars. Anything parsing that line should either read the new shape or set `openlimiter config set statusline.bars false`, which returns the 0.1.0 line byte for byte and is covered by a test that pins the exact string.
- Subscription providers now come first in the statusline and credit or API providers last, so a window that refills on a clock is never read next to a balance that does not. Within a provider the meters order session, daily, weekly, monthly, credits, and the statusline shows the meter closest to its cap. The full set stays in `openlimiter snapshot`.
- A line wider than its budget stacks onto a second row instead of being truncated. Rows break between cells, never inside one. Past two rows the worst providers that fit are kept and the last row ends with a `+N more` cell.
- Every meter bar, in the snapshot table and in the statusline alike, is now drawn on a four band colour scale instead of three: green below 60, yellow from 60, orange from 80, red from 90. Orange opens at the reading the engine already calls `NEAR_CAP`, so the colour a person sees and the point an agent stops routing to a provider are the same number, while red stays deliberately later. Orange uses the 256 colour palette where `TERM` or `COLORTERM` says there is one and falls back to the yellow of the band below where there is not, so a plain terminal loses the distinction rather than the reading. `NO_COLOR` and output that is not a terminal print the same plain bars as before.

### Added

- A statusline section in the state directory configuration file, written by `openlimiter init`: `order`, `meters`, `width`, `rows`, `bars`, and `color`. Re running init keeps whatever is configured there.
- `openlimiter config get statusline[.<key>]` and `openlimiter config set statusline.<key> <value>`. Statusline keys are the only thing this command mutates; every other key, and every value a key cannot use, exits 2 and names what was expected.
- `statusline.color always`, for a host that captures the command's output rather than handing it a terminal, which is where colour would otherwise never appear. `NO_COLOR` still beats it.
- `scripts/capture-cli.mjs`, which reseeds a scratch state directory from the synthetic fixtures and reprints every capture the documentation pastes in.

### Notes

- The Claude Code hook and the agent context block are untouched. The snapshot and demo table keeps its eight columns and its ten block bar; the only thing that changed there is the band colour those blocks are painted in.
- A statusline configuration this version cannot read falls back to the defaults key by key rather than refusing to draw. The statusline runs inside another tool and never breaks its host.
- The synthetic Codex demo fixture moved from 51 percent to 84, so the demo set now lands one meter in each of the four bands and `openlimiter demo` teaches the whole scale. Nothing else about the demo changed: the policy stops recommending a provider at 80, so Codex drops out of the running and the demo still advises PREFER ANTIGRAVITY. Every capture in the README and on the site was regenerated from that same run.

## [0.1.0] (2026-08-09)

### Added

- The strict snapshot core: bounded validation, an atomic cache, freshness, forecast, and the advice policy.
- Six read only bounded payload parsers, every one marked UNVERIFIED and covered by synthetic fixtures. Claude arrives through native statusline input. Manual arrives from a local document or explicit ingest. OpenRouter, Codex, Antigravity, and OpenCode currently arrive only through explicit ingest payloads.
- A CLI with nine commands: init, snapshot, statusline, hook, doctor, demo, export, ingest, and serve.
- Three offline ingestion paths: the Claude Code statusline payload on standard input, a manual JSON document on disk, and the generic ingest command.
- A Claude Code adapter: a compact statusline and a UserPromptSubmit hook that injects bounded budget state and routing advice.
- The full test suite runs in continuous integration on Windows and Linux for pull requests and pushes to `main`.
- The openlimiter.com site, with documentation.

### Security

- Bounded agent context: the Claude Code hook validates every value again and wraps injected state in an explicit untrusted data boundary. Nothing is injected while every provider is unknown.
- Fail closed unknown handling: missing, expired, malformed, or unrecognized input becomes unknown state. It never becomes zero or exhausted.
- Zero telemetry: no command sends usage, diagnostics, identifiers, prompts, or quota state anywhere.
- No provider file mutation: every connector is read only. OpenLimiter never rewrites, backs up, repairs, or migrates a provider authentication artifact.

### Notes

- The Codex, Antigravity, and OpenCode connectors describe unofficial interfaces that can change or disappear without notice. They currently accept data only through `openlimiter ingest --provider <id>`.
- The OpenRouter connector parses its documented API response, but no API client or local reader ships. It currently accepts data only through `openlimiter ingest --provider openrouter`.
- Desktop, mobile, and encrypted sync are planned, not built. See the roadmap: https://openlimiter.com/docs/roadmap
