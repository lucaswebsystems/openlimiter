# Agent adapters

The Claude Code adapter reads the local cache only. It never refreshes a connector from the statusline or hook path.

Add this wiring to settings.json.

    {
      "statusLine": {
        "type": "command",
        "command": "openlimiter statusline"
      },
      "hooks": {
        "UserPromptSubmit": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "openlimiter hook"
              }
            ]
          }
        ]
      }
    }

The injected block is explicitly marked as untrusted data. It contains only bounded numbers, enum codes, and timestamps.

Codex CLI and OpenCode adapters are planned for P2. Their interfaces are present, but their renderers intentionally return an empty string.
