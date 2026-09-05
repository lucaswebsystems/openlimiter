# `openlimiter`

A local command line meter for AI quota, usage, and reset times.

## Install

```bash
npm install --global openlimiter
```

## First command

```bash
openlimiter demo
```

The demo uses synthetic data and does not read a provider account.

## Agent context hooks

Install or remove a user scoped hook explicitly:

```bash
openlimiter hooks install codex
openlimiter hooks uninstall codex
openlimiter hooks status codex
openlimiter hooks repair codex
```

Installation preserves unrelated agent configuration, writes a recoverable backup, performs no network request, and refuses a version below the tested minimum or an unsafe configuration path. A newer version remains enabled and `hooks status` prints one warning line. Hook execution reads only the short lived local snapshot and the protected desktop trust bridge, then fails open with no context on any invalid or missing input.

Antigravity CLI injection is excluded because `agy 1.1.23` did not fire the IDE hook shapes in a real prompt fixture. Kimi Code CLI installation stays gated because `1.50.0` fired `UserPromptSubmit` but discarded successful hook stdout instead of adding it to model context.

Grok Build does not currently expose a documented dynamic context surface. Its `UserPromptSubmit` hook discards successful stdout, so OpenLimiter does not install a Grok hook or claim injection support. Use the explicit command instead:

```bash
openlimiter status --agent-context
```

## Provider inputs

| Provider | How data reaches OpenLimiter |
|---|---|
| Claude | Claude Code sends its native statusline JSON to standard input |
| OpenRouter | You supply an explicit API response with `openlimiter ingest --provider openrouter` |
| Codex | You supply an explicit payload with `openlimiter ingest --provider codex` |
| Antigravity | You supply an explicit payload with `openlimiter ingest --provider antigravity` |
| OpenCode | You supply an explicit payload with `openlimiter ingest --provider opencode` |
| Manual | You create `manual.json` in the OpenLimiter state directory or use `openlimiter ingest --provider manual` |

Read the [documentation](https://openlimiter.com/docs) or browse the [repository](https://github.com/lucaswebsystems/openlimiter).
