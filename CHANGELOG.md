# Changelog

All notable project changes appear in this file.

## [1.3.1] (2026-09-07)

### Added

- Account first flow on the web hub: create your account with GitHub, Google or Microsoft (or a magic link), connect your AI accounts, see your bars. Bars stay free with no account; an account syncs them between devices and unlocks Pro.
- Free sync of current percentages for every signed in device, and a hub that reads them through dedicated functions. History, alerts, the phone and multiple accounts per provider stay Pro.
- Start free trial everywhere it matters (the hub header, the lock card, the alerts popover, the Pro page and a deep link), a three step wizard that turns alerts and push on, and an expiry lock card with a five day countdown and an annual offer of USD 40 for the first year when a trial ends with no purchase.
- Phone: pair from the hub with a QR, keep the pairing alive through a rotating refresh credential held in secure cookies, and install the hub as an app (Android prompt, iOS instructions).
- Terminal: bars inside Claude Code, Grok Build and the Antigravity CLI, Codex's own windows through its built in items, and a shell prompt segment for everything else, all wired by `openlimiter terminal`. The bar reads the way a status line should: short tag, window, ten blocks, percent, reset, and a freshness mark that never hides a bar. Choose which configured providers show with `openlimiter terminal show` and `hide`.
- The CLI acquires quotas itself, so a terminal without the desktop app gets fresh bars: Codex, Gemini CLI, Antigravity, Grok, Kimi and OpenRouter read the login their own tool stored, Claude reads what Claude Code reports, with an opt in poll when Claude Code is closed.
- `openlimiter login` signs a terminal into your account by device code (approve it at openlimiter.com/app/cli), `openlimiter logout` and `openlimiter whoami` end and report that session, `openlimiter sync` uploads its bars, and `openlimiter refresh` acquires fresh readings and syncs them in the same pass when a session is signed in. The CLI ships pointed at the hub with its own publishable key already built in, overridable by `OPENLIMITER_SUPABASE_URL` and `OPENLIMITER_SUPABASE_ANON_KEY`, with `OPENLIMITER_SUPABASE_ANON_KEY=off` switching the hub off entirely for a build that should never reach it.
- Meter from the cloud (Pro): store an API spend key once, encrypted on the server, and the hub and the phone show spend with no device running; connect OpenRouter from the hub with its own sign in.
- Desktop: first run is account, connect, bars; Codex signs in through its device code flow inside the window; every window a provider exposes is drawn, model scoped ones included, with a pace tick on each bar.

### Changed

- Every request to a provider now carries the OpenLimiter identity. The desktop no longer presents itself as the Antigravity CLI or as the Grok client; Antigravity's quota is read from the running Antigravity CLI on this machine, and when none runs the row says so instead of pretending.
- The web hub loads only the strings a route needs and polls on a cadence tied to how fresh the newest reading is.

### Removed

- `openlimiter serve`, the CLI's own local web server, and the LAN QR view it drew a phone pairing code onto. The hub now pairs a phone directly and syncs bars from any signed in device, so a terminal never needs to open a port of its own on the local network.

### Fixed

- Sync never worked end to end: the desktop sent an old envelope the server refused, and the hub read a table that no longer existed. Both sides now share one fixture and one contract, with a per device sequence cursor and stable device ids.
- A phone closed for a day could never renew its pairing.
- A trial could start implicitly from two places; it now starts only from the wizard, once, and a cancelled or refunded subscription never restarts it.
- A discounted checkout could reuse an older full price session; offers now carry their identity through the reservation and are redeemed in the same transaction as the entitlement.

## [1.2.2] (2026-09-06)

### Fixed

- Desktop sign in with GitHub or Google never returned to the window. The window sent an OAuth state of its own, the auth service forwarded that value to the provider unchanged and could not resolve it on the way back, so the browser landed on the website with "OAuth state not found or expired" while the window waited for a callback that never came. The service now mints and resolves its own state, and custody stays proven by the PKCE verifier, which never leaves the machine.
- The web dashboard at /app reloaded itself about once a second. Its service worker registration URL was built from a hash of the page scripts, which Next extends as it prefetches routes, so every load looked like a new worker and each controller change reloaded the page. The key is now one constant per deploy, with a guard that refuses a second reload within thirty seconds.
- Checkout no longer asks Stripe to calculate tax automatically, a setting Stripe does not offer for the seller's country, and the site no longer claims it does.
- The Pro pricing card lists five features with one footnote linking to the full conditions, and the hosted routing context claim is gone from the site until a release pins its verification key.

## [1.2.1] (2026-09-05)

The first public release of the 1.2 line. 1.2.0 was built as a draft and never published.

### Changed

- Sign in on the desktop and on the web is redrawn: official GitHub and Google marks, one centred composition, email as the quiet secondary path, an honest Not now because the free product needs no account, designed working, error and success states, and a plain sentence when a provider is not switched on yet.
- A control boundary token gives secondary buttons a legible edge in both themes; the paying page keeps its chrome quiet so nothing covers the sign in card at phone width.
- The workspace test suite passes on every CI runner, the updater manifest check accepts this repository's release asset host, and the npm publish steps read the registry credential from the repository configuration.

## [1.2.0] (2026-09-04)

The single public launch: every provider bar in one place, a free product that needs no account, and a Pro layer that can be paid for.

### Added

- Every Claude bucket the usage API returns is now its own bar, including model specific weekly windows such as Fable 5, extra usage credits and any bucket Anthropic adds later; both the desktop reader and the TypeScript engine parse what arrives instead of a fixed list, and a bucket named by the server renders under its own name.
- Phone access by QR: the desktop shows a pairing code, the phone claims it, the desktop approves, and the phone receives a read only device token that can be revoked from the device list.
- Pro checkout and billing management from the desktop and the web portal, with GitHub and Google sign in and a magic link fallback; the trial starts on the server at first sign in.
- API spend meters for OpenAI, Anthropic and xAI plus a Moonshot balance, free up to USD 100 per calendar month per source and capped with a hatched "100 plus" state above that without Pro; the real figure never leaks into a capped payload.
- Contract suites for Gemini CLI, Grok Build and Kimi, a connection lifecycle on every reader (detected, connected, stale with an instruction, error), and a live smoke harness that only runs on request and writes sanitized evidence.
- A macOS universal build in the release workflow, unsigned, with the documented open anyway steps.

- A privacy policy at `/privacy`, in all five published languages, written from the real data map rather than from a template: what local mode collects, which fields sync carries, every retention window, the processors involved, and the deletion path.
- Subscription terms: billing through Stripe with automatic tax, cancellation at period end through the Stripe Customer Portal, a full refund on request within 14 days of any charge, and one fixed 72 hour grace after a first failed payment that retries never extend.
- The agent context documentation now lists every agent the hook installer knows, with the state a live fixture recorded on a real machine rather than the state a roadmap hoped for, plus the OpenCode kill switch and the reason Grok Build cannot be injected into.
- A public macOS download, unsigned, with the exact first run steps: open it once, then System Settings, Privacy and Security, Open Anyway.

### Changed

- First run shows the detected providers and real bars first; the account is optional and offered afterwards for phone access, sync and Pro, and sync is on once signed in.
- Every notification is Pro: desktop toasts, email and phone push at 60, 80, 90 percent and on reset; a free machine never raises a toast and the bell says so.
- Free keeps one active account per provider; existing multi account setups are grandfathered; a second account without Pro is refused and stores nothing.
- Grok Build is named correctly everywhere and its requests carry the client version and mode headers only when the installed client's version is known.
- Kimi Code detection no longer accepts any executable called kimi.
- The OpenCode reader tolerates renamed headings and fails soft to a reconnect state instead of dropping every bar.
- Overspent amounts survive normalisation on both the desktop and the web path beside a capped percent.
- Node 24.13 or any newer 24.x release is accepted instead of one pinned patch version.
- Release workflows pass inputs through the environment, every action is pinned to a commit, dependabot has a seven day cooldown, and the dependency audit is clean.

- The documentation lists all nine connectors. Gemini CLI, Grok and Kimi join the table with the labels their parsers declare.
- The pricing page states the six Pro lines honestly, labels the API spend meters a beta, names the organisation admin or management key they need, says a project key will not work, and shows Moonshot as balance rather than spend.
- The free plan states its cap of one active account per provider, which Pro raises.
- The website counts page views without cookies through Vercel Web Analytics. The application still sends nothing, and the two claims are now stated separately instead of as one.
- Claims that no OpenLimiter server and no account exist are scoped to local mode, which is where they are true, now that a free account, sync and Pro exist.
- `llms.txt` rewritten for 1.2.0: nine connectors, the account, the six Pro features, checkout through Stripe, and the agent adapter states.
- The site promise is now that everything you can see is free, and that alerts, history, phone access, extra accounts and spend tracking above 100 US dollars a calendar month for each source are Pro. Pro is six features, four hosted and two local, rather than six hosted services.
- Sync is on from the moment you sign in, because moving your own percentages between your own devices is what signing in is for. Every public statement about the default now says so.
- Moonshot is described as a balance with three components in the provider's own currency, never as spend, a forecast or a budget alert.
- Hosted routing context is described as a signed envelope the release build verifies, which is the path that ships, rather than as the same advice on every device.
- The privacy page names seven services rather than four, adding GitHub and Google for sign in and the browser and operating system push services that deliver an alert, and the retention introduction names its local, backup and legal billing exceptions.

### Distribution

- Desktop builds for Windows, macOS and Linux. Windows and macOS are unsigned and each states its one time allow step.
- macOS ships as one unsigned universal disk image, `OpenLimiter_1.2.0_universal.dmg`, which runs on Apple silicon and on Intel. The site used to advertise a separate Apple silicon image and an Intel image, and neither has ever been attached to a release.
- macOS is excluded from the update manifest until signed and notarised builds exist, so until then a new version is a new download.

## [1.1.0] (2026-08-24)

### Added

The desktop now begins with a free OpenLimiter account sign in. Google, GitHub,
and email are available when their Supabase providers are configured. A cached
session keeps local meters usable while the backend is unreachable, and local
collection never waits for the network.

Free native desktop notifications cover the 60, 75, and 90 percent transitions.
The Home bell lists recent events. Reset notices stay off by default. The signed
release channel now has the official Tauri updater, including launch checks,
manual checks, an install banner, signed artifacts, and `latest.json`.

The public repository now includes an evidence led README, contribution rules,
and focused issue forms for bugs, provider requests, and features.

### Changed

Home and the tray show only providers the user configured. Each configured
provider renders every trusted window as a separate line. Subscription windows
use semantic percentage bars. API providers use spend against a known ceiling,
or a neutral spent and remaining credit line when the service exposes no cap.

Configuration contains providers only. Account details, sync, update checks,
about, and sign out live in the menu. Sync starts on after sign in, sends only
bounded usage display data, and has a clear off switch.

The canonical pre redesign lockup is frozen across 87 generated web, PWA,
desktop, installer, package, and tray outputs. Shared tokens now control spacing,
type, radius, color, motion, and bar styling across shipped surfaces.

### Pro status

Email, phone push, custom thresholds, quiet hours, and a daily digest are
implemented locally behind the existing entitlement boundary. Hosted activation
and end to end delivery proof remain required before checkout can open. Pro
themes, multiple subscription gating, heavy API usage features, and the history
and forecast view do not ship in this release.

### Distribution

Windows and Linux remain the supported desktop targets. They are unsigned.
macOS remains excluded. The planned Pro price now matches the executable Stripe
contract at 5 dollars per month or 50 dollars per year.

## [1.0.2] (2026-08-23)

### Added

The web dashboard can show bounded quota snapshots from the optional hosted sync
service after sign in. Web and desktop account surfaces now make sign in and
account creation explicit, while every local feature still works without an
account.

### Changed

Desktop and web now render one compact line per quota window under each provider
heading. Every line contains only its window name, continuous bar, percentage,
and reset time. The visible provider catalogue is limited to the eight sources
that have collectors.

Antigravity now reads the authenticated quota summary directly with the same
request contract used by the installed client. The site keeps the video hero,
uses restrained motion with a reduced motion fallback, and updates returning
web application clients when a new build is deployed.

The download page now selects the current operating system automatically and
keeps other platforms behind one quiet link. Pricing states that local use and
sync are free, and lists the planned Pro service boundaries without claiming
those features ship today.

### Distribution

This patch ships unsigned Windows and Linux desktop packages. Both packages are
installed and launch tested by the release workflow. macOS remains excluded.
The npm command line package remains unpublished.

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
