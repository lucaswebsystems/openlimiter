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
