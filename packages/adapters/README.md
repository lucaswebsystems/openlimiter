# `@openlimiter/adapters`

Agent adapters that render OpenLimiter quota guidance in supported tools.

The exported `AgentContextAdapterV1` contract renders a bounded `openlimiter_untrusted_data` block and validates every signed hosted context before any agent can receive it. Missing, stale, malformed, revoked, cross account, and cross device context produces no injection and a successful hook exit.

Claude Code and Codex CLI are enabled only for versions in the dated compatibility matrix. Gemini CLI, Antigravity, and Kimi Code CLI stay gated until a live Windows fixture passes. OpenCode is experimental, version pinned, and disabled unless `OPENLIMITER_EXPERIMENTAL_OPENCODE=1`. Grok Build is excluded because its documented `UserPromptSubmit` hook discards successful stdout.

Most users should install the [`openlimiter`](https://www.npmjs.com/package/openlimiter) CLI.

See the [repository](https://github.com/lucaswebsystems/openlimiter) and [OpenLimiter site](https://openlimiter.com).
