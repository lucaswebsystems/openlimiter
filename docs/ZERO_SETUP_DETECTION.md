# Zero setup detection contract

The desktop performs this scan when the native process starts. No window must
be open and no click is required. The scan reads bounded local files without
following symbolic links. It never starts a provider CLI.

## API

`list_detected_providers` returns the launch report.

`rescan_detected_providers` repeats the scan after a person signs in or changes
profiles.

`refresh_detected_claude` accepts one opaque `account_id`. It can only reach the
fixed Claude OAuth usage endpoint. It cannot accept a URL, header, token or file
path.

Every provider has one of three states.

1. `present` means at least one supported local credential file was decoded.
2. `installed_logged_out` means an executable or configuration marker exists,
   but no supported credential could be decoded.
3. `absent` means neither evidence exists.

Every account carries an opaque local identifier, a masked label, credential
freshness, collection state, recovery action and an optional fixed message.
Tokens, provider account identifiers and file paths are never serialized.

## Candidate path families

The default home paths are always checked. Bounded sibling profiles named with
`.claude_`, `.claude-`, `.codex_` or `.codex-` are checked too. This is how two
accounts of the same provider remain separate.

Windows checks these roots:

```text
%USERPROFILE%\.claude
%USERPROFILE%\.codex
%USERPROFILE%\.antigravity
%USERPROFILE%\.openrouter
%APPDATA%\Claude
%APPDATA%\OpenAI\Codex
%APPDATA%\Antigravity
%APPDATA%\opencode
%APPDATA%\OpenRouter
%LOCALAPPDATA%\Claude
%LOCALAPPDATA%\OpenAI\Codex
%LOCALAPPDATA%\Antigravity
%LOCALAPPDATA%\opencode
%LOCALAPPDATA%\OpenRouter
```

macOS checks the same home folders plus these roots:

```text
~/Library/Application Support/Claude
~/Library/Application Support/Claude Code
~/Library/Application Support/Codex
~/Library/Application Support/Antigravity
~/Library/Application Support/opencode
~/Library/Application Support/OpenRouter
```

Linux checks the same home folders plus the configured XDG roots and their
standard defaults:

```text
$XDG_CONFIG_HOME
$XDG_DATA_HOME
~/.config
~/.local/share
```

Each XDG root is checked for provider folders named `claude`, `claude-code`,
`codex`, `antigravity`, `opencode` and `openrouter` as applicable. An explicit
`CODEX_HOME` is checked before the default Codex home.

The executable scan checks `claude`, `codex`, `antigravity`, `opencode` and
`openrouter` in the inherited executable path. Windows also checks the ordinary
`.exe`, `.cmd` and `.bat` forms.

macOS Keychain is intentionally not read. If Claude Code keeps a login only in
Keychain, the provider is reported as installed without a readable login and
manual entry remains available. OpenLimiter never asks for a Keychain prompt.

## Identity and secrets

Account identity uses a provider account identifier when the local document
supplies one. A JWT subject is the next choice. If neither exists, a digest of
the credential keeps different accounts apart without exposing the credential.
The public identifier is a provider scoped SHA 256 digest.

Claude account metadata in `.claude.json` supplies a stable identity and masked
email when available. Codex account identifiers and JWT claims remain private
inputs to the digest. A token is read again from its original file immediately
before a request, then its owned buffer is cleared on drop.

OpenLimiter does not copy a detected token into Windows Credential Manager,
macOS Keychain or Linux Secret Service. It never mints a token, refreshes one or
sends telemetry.

## Claude collection policy

The primary request uses the Claude Code bearer token, an honest OpenLimiter
user agent, JSON acceptance and the fixed OAuth beta contract header. Redirects
remain disabled and the transport can reach only compile time addresses.

Successful responses must contain both `five_hour` and `seven_day`. Each must
carry `utilization` from zero through one hundred and a plausible RFC 3339
`resets_at`. Anything else becomes visible unknown and enables fallback.

One account can make at most one request every fifteen minutes. A response with
status 429 waits at least one hour and at most one day. Status 403, 404 or 410
waits one day. Status 401 produces the fixed message telling the person to
reopen Claude Code. A new credential revision bypasses the old wait, so reopening
the CLI recovers immediately.

Current OAuth data suppresses only the anonymous Claude statusline row for the
same meter. A statusline event observed after OAuth expiry is accepted again.
Manual entry remains available if both sources fail.
