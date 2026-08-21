# Changelog

All notable project changes appear in this file.

## [Unreleased]

## [1.0.1] (2026-08-21)

### Changed

Codex and Antigravity detection is proven against live authenticated accounts on
Windows. OpenCode now preserves its rolling, weekly, and monthly values instead
of collapsing them into one row. Claude emits optional Opus and Sonnet weekly
family windows when its usage response supplies them.

Gemini CLI now has a frozen official source fixture and the same fail closed
payload contract as the native collector. Grok and Kimi now reach the tray along
with every other supported provider.

### Distribution

This patch ships unsigned Windows and Linux desktop packages. macOS remains
absent until signing exists. The npm command line package remains unpublished.

## [1.0.0] (2026-08-20)

### Added

The desktop application now discovers Claude Code, Codex, Antigravity, Grok,
Kimi, Gemini CLI, OpenCode and OpenRouter from the tools and logins already
present on Windows, macOS and Linux. Every provider is shown as present,
installed but logged out, or absent. Separate local profiles stay separate
accounts, so two accounts no longer collapse into one.

Claude Code usage can now be read from the existing local OAuth login. It reports
the five hour session and seven day windows, caches provider responses, respects
rate limits, and tells the user to reopen Claude Code when that login is stale.
The Claude Code statusline remains available as a fallback.

The public site now states the hosted service price as 5 dollars per month or 50
dollars per year, with the first 30 days free. It also states the permanent
boundary clearly: the local meter and every local feature remain free and open
source. Payment buys only hosted threshold alerts, history and forecasts, and
agent routing.

The downloads page now lists Windows, macOS and Linux artifacts with direct
installation instructions. It explains the unsigned Windows and macOS warnings
before download and gives the exact safe recovery steps instead of hiding them.

The documentation now explains automatic discovery, multiple accounts, every
supported provider reading, the local privacy boundary and the recovery path for
an unknown reading.

### Changed

An unexpected provider response now becomes a visible unknown reading. It never
becomes zero and never keeps a plausible number from a contract the provider has
changed.

Codex keeps a quota percentage when the provider omits the reset time. OpenCode
remains explicitly unverified until a capture proves its current page layout.

### Distribution

The desktop release produces unsigned AppImage, deb and rpm packages for Linux,
plus unsigned NSIS and MSI installers for Windows. macOS and automatic updates
remain unavailable until signing is in place. The npm CLI package is not part
of this release.

## [0.4.0] (2026-08-11)

Connect and See. This release turns OpenLimiter from a technical ingestion tool
into what it was always trying to be: connect your AI tools, see your limits
instantly. Nothing you could do before has been removed; the technical surfaces
moved to an Advanced area where developers expect them.

### Changed

- **First launch opens Connections; a returning launch opens Home.** With
  nothing connected the app shows detected local tools first and the provider
  catalogue beneath, one truthful status and one obvious action per row, and no
  JSON, terminal command, or ingestion surface anywhere on that path. With
  connections present the app opens on Home, most constrained meter first, exact
  continuous bar, reset countdown, then the other windows that source actually
  reports, then freshness and provenance. The web dashboard follows the same
  shape. Paste, import, agent context and diagnostics live under Advanced.
- **The snapshot table grew a source column and sharper bars.** Every row now
  names how its numbers reached this machine, rows sort most constrained first,
  and on terminals that can draw them the table bar gains eighth block
  resolution so 91 and 97 no longer share a picture. NO_COLOR and plain
  terminals keep the exact ASCII rendering of before. Scripts should parse
  `openlimiter export`, not the table; the table is for people.
- **The docs read in the order a person arrives**: why, connections, providers
  first; configuration, cli, ingestion and agent context grouped as the
  advanced area. No page changed its address.
- The site and README stop describing the product this release replaced, in all
  five languages. Local mode keeps its zero telemetry sentence, scoped
  honestly; a live connection is described as talking only to that provider's
  own endpoint; and the announce bar now says plainly that Pro is a founding
  price, coming soon, instead of dressing that up as a discount.

### Added

- **One click Claude Code connect, under a strict protocol.** The card first
  proves the CLI actually runs (an absolute path is resolved and executed
  before anything else), reads your settings without following symlinks, and
  refuses outright when a statusline or hook it did not write is present,
  offering the guided manual path instead. With your explicit consent it then
  writes exactly two entries, after a timestamped backup, atomically. Disconnect
  proves the file still matches what was installed and restores it byte for
  byte, or removes only its own entries and says so. Provider authentication
  files are never touched, in any flow, ever.
- **A seventeen provider catalogue with honest states.** Five providers are
  connectable today and say exactly how (Antigravity: Windows experimental,
  macOS and Linux manual; OpenCode: manual everywhere). Twelve more are
  Planned, and a planned row is structurally incapable of claiming Connected.
- **Trusted per reader refresh cadences.** Every connection carries its
  reader's own base cadence (OpenRouter and Codex five minutes, Antigravity ten,
  OpenCode manual refresh only, Claude event driven), the UI can never lower
  one, and a record without a cadence gets its reader's default rather than a
  runaway poll.
- The Codex connection reads the local Codex login, sends the account header
  the API actually requires, and stores only the access token in the operating
  system credential store, with the account identifier on the connection record
  where an identifier belongs.

### Fixed

- Three Windows defects that would have made one click connect fail on every
  Windows machine: the resolved CLI path arrived in a form cmd.exe cannot
  execute, the probe's quoting never survived the spawn, and the detection
  answer used a word the window did not accept.
- The Codex credential no longer exceeds what the Windows credential store can
  hold.
- The web app's file import button now works from the Advanced tab, not only
  from Connections.
- next 15.5.21 plus forced postcss and sharp patches close every advisory the
  dependency audit reported, and the audit now reports none.

### Changed

- The desktop application's OpenAI Codex tile draws the official OpenAI mark, matching the website, instead of an initials tile.

## [0.3.0] (2026-08-10)

### Fixed

- **The Claude connector could not parse a real Claude Code payload.** The previous release read a field named `utilization` and reset instants as ISO date strings. Anthropic's statusline documentation states `used_percentage` and reset instants as Unix epoch seconds, and no Claude Code release is known to have ever emitted the old shape; only this project's own fixture ever agreed with it. The parser now reads the documented shape. Each of the two windows, five hour and seven day, is independently optional, absent entirely for a free account or before the first API response of a session, and a window with an implausible reset for its own length is dropped on its own rather than trusted, leaving the other window to still count.

### Changed

- Every meter bar, on the web dashboard and the desktop application alike, is now continuous rather than stepped. The previous bar drew ten blocks with a half step every five percent, which rendered a 91 and a 97 identically; the bar now draws the exact reading, decimals included, as its own width.
- Sample data moved behind Settings, then Demo mode, and became its own isolated store rather than a flag on the real one. Entering demo mode cannot merge with or overwrite a real reading, and leaving it cannot touch what was real either. A persistent watermark marks every synthetic surface while demo mode is on, and pasting a document is refused outright while it is active rather than silently mixed in.
- `openlimiter serve` now carries its token in the URL fragment rather than the query string, moves it into the tab's own session storage and cleans the address bar on first load, and sends it as an `Authorization: Bearer` header on every refetch after that. An address printed by the previous release, with the token as a query parameter, still answers for this one release. The startup banner now says plainly that anyone who can see the screen, or a photograph of it, can read the quota for as long as the command keeps running, and that the port must never be forwarded or opened on a firewall.

### Added

- **The desktop application gains a Connections tab.** A live OpenRouter connection can be connected, tested, refreshed and disconnected from the application itself, and the key lives in the operating system's credential store under a masked label, never in a file. Every endpoint the connection can call is named in a closed allowlist, and a Claude card explains the statusline wiring with a copy block and a verify step. When the Rust backend is absent, the tab says so honestly instead of pretending.
- The connection subsystem underneath that tab, written in Rust: `connections.json` owned and fully validated by the Rust side behind a document version gate, cache writes holding the lock from begin through commit, and a sixty second refresh metronome whose policy stays entirely in TypeScript. Seventy two tests cover it, plus fifteen regression tests from the security review.
- A connection state vocabulary and the source chips built on it. `packages/core/src/connection-state.ts` names thirteen connection states with one honest sentence each, so a connection's state is a value the whole product agrees on rather than a sentence each surface invents. The dashboard now shows a source chip on every provider drawn from it: Local CLI for Claude's statusline data, Import only for OpenRouter, Codex, Antigravity and OpenCode, Manual for manual entries.
- A scheduling module, `packages/core/src/schedule.ts`: exponential backoff with jitter for when a connection may next ask its provider a question, honouring a provider's own `Retry-After` as a floor under our own backoff, never a reduction of it.
- `provider_specs/`, a YAML capability registry, one file per provider and product, naming what its payload can state, where each meter and its reset are read from, and when its documentation was last checked against it. `scripts/validate-provider-specs.mjs` validates every entry with a small YAML reader of its own and is wired into `pnpm test`, so a malformed or disagreeing spec fails the build rather than shipping.
- `accountId` and `provenance` fields on the snapshot schema, for a future reading that names its own account and states how it was observed. Both are added unpopulated: no connector sets either field yet, so their absence today means exactly what it always meant, one unnamed account, provenance unknown.

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
