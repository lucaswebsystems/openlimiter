# Changelog

All notable project changes appear in this file.

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
