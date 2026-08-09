# `@openlimiter/connectors`

Provider connectors that collect quota and usage data for OpenLimiter.

Most users should install the [`openlimiter`](https://www.npmjs.com/package/openlimiter) CLI.

## Inputs

Connectors are bounded payload parsers. Only Claude and Manual have local input paths in the CLI. The other four require an explicit ingest payload.

| Provider | Input path |
|---|---|
| Claude | Native Claude Code statusline JSON on standard input |
| OpenRouter | Explicit documented API response passed through `ingest --provider openrouter`; no API client or local reader ships |
| Codex | Explicit payload passed through `ingest --provider codex`; no local reader ships |
| Antigravity | Explicit payload passed through `ingest --provider antigravity`; no local reader ships |
| OpenCode | Explicit payload passed through `ingest --provider opencode`; no browser automation or local reader ships |
| Manual | `manual.json` in the OpenLimiter state directory, or an explicit payload passed through `ingest --provider manual` |

Every connector is UNVERIFIED. Unknown, missing, stale, or malformed input never becomes available quota.

See the [repository](https://github.com/lucaswebsystems/openlimiter) and [OpenLimiter site](https://openlimiter.com).
