# Changelog

All notable project changes appear in this file.

## [0.1.0] (2026-08-09)

### Added

- The strict snapshot core: bounded validation, an atomic cache, freshness, forecast, and the advice policy.
- Six read only connectors, every one marked UNVERIFIED, each with synthetic fixtures: Claude Code's native statusline payload, OpenRouter's documented credits API, unofficial internal endpoints for Codex and Antigravity, a session based interface for OpenCode, and manual entry.
- A CLI with eight commands: init, snapshot, statusline, hook, doctor, demo, export, and ingest.
- Three offline ingestion paths: the Claude Code statusline payload on standard input, a manual JSON document on disk, and the generic ingest command.
- A Claude Code adapter: a compact statusline and a UserPromptSubmit hook that injects bounded budget state and routing advice.
- 100 tests, with continuous integration running on Windows and Linux.
- The openlimiter.com site, with documentation.

### Security

- Bounded agent context: the Claude Code hook validates every value again and wraps injected state in an explicit untrusted data boundary. Nothing is injected while every provider is unknown.
- Fail closed unknown handling: missing, expired, malformed, or unrecognized input becomes unknown state. It never becomes zero or exhausted.
- Zero telemetry: no command sends usage, diagnostics, identifiers, prompts, or quota state anywhere.
- No provider file mutation: every connector is read only. OpenLimiter never rewrites, backs up, repairs, or migrates a provider authentication artifact.

### Notes

- The Codex, Antigravity, and OpenCode connectors describe unofficial interfaces that can change or disappear without notice. All three currently accept data only through `openlimiter ingest --provider <id>`.
- The OpenRouter connector uses a documented API, but its credential store driver is intentionally stubbed in this release, so `openlimiter init` cannot store a key yet.
- Desktop, mobile, and encrypted sync are planned, not built. See the roadmap: https://openlimiter.com/docs/roadmap
