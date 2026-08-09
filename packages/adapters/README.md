# Agent adapters

The Claude Code adapter renders bounded advice. The hook path reads the local cache only and never refreshes a connector.

Add this wiring to settings.json, using the absolute path to your clone.

    {
      "statusLine": {
        "type": "command",
        "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js statusline"
      },
      "hooks": {
        "UserPromptSubmit": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js hook"
              }
            ]
          }
        ]
      }
    }

Claude Code writes a JSON object describing the session to the statusline command on standard input. When that object carries a rate limit block, the statusline validates it, folds it into the cache, and renders the fresh numbers. That is the only path here that writes. It performs no network access, and it falls back to the cache and reports unknown whenever standard input carries nothing usable.

The injected block is explicitly marked as untrusted data. It contains only bounded numbers, enum codes, and timestamps.

Usage percentages are truncated for display, never rounded upward, so the statusline cannot claim a cap that was not reached.

Codex CLI and OpenCode adapters are planned for P2. Their interfaces are present, but their renderers intentionally return an empty string.
