# `@openlimiter/adapters`

Agent adapters that render OpenLimiter quota guidance in supported tools.

The exported `AgentContextAdapterV1` contract renders a bounded `openlimiter_untrusted_data` block and validates every signed hosted context before any agent can receive it. Missing, stale, malformed, revoked, cross account, and cross device context produces no injection and a successful hook exit.

Claude Code and Codex CLI are enabled from the minimum versions in the dated compatibility matrix. Older versions are denied. Newer versions remain enabled and `openlimiter hooks status` reports one warning line. Gemini CLI and Kimi Code CLI stay gated. The installed Antigravity CLI did not fire the documented IDE event shapes, so `agy` injection is excluded. OpenCode is experimental and disabled unless `OPENLIMITER_EXPERIMENTAL_OPENCODE=1`. Grok Build is excluded because its documented `UserPromptSubmit` hook discards successful stdout.

Hosted injection also requires the desktop trust bridge at the platform application configuration directory. The bridge selects only public keys already pinned in the adapter. A missing, linked, broadly readable, malformed, or mismatched trust file produces no hosted injection.

Most users should install the [`openlimiter`](https://www.npmjs.com/package/openlimiter) CLI.

See the [repository](https://github.com/lucaswebsystems/openlimiter) and [OpenLimiter site](https://openlimiter.com).
