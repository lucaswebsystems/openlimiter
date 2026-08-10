use std::path::Path;

use serde::Serialize;

use crate::fsx;

/// Boolean only detection of the Claude Code wiring.
///
/// The one question this module answers is whether `~/.claude/settings.json`
/// wires the openlimiter statusline command, and it answers in booleans and
/// nothing else. The settings file belongs to another product and can contain
/// anything at all, so not one character of it ever crosses this boundary:
/// not the command line, not a path, not an error message quoting a line.
/// Nothing is ever written; the guided enable flow copies a command for the
/// person to run, exactly as the design decided for v1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LocalToolDetection {
    /// `~/.claude/settings.json` exists and was readable as a regular file.
    pub claude_settings_present: bool,
    /// The statusline command runs openlimiter.
    pub statusline_wired: bool,
    /// A UserPromptSubmit hook runs the openlimiter hook verb.
    pub hook_wired: bool,
}

const NOTHING: LocalToolDetection = LocalToolDetection {
    claude_settings_present: false,
    statusline_wired: false,
    hook_wired: false,
};

/// Detect against the real home directory.
pub fn detect() -> LocalToolDetection {
    match crate::state::home() {
        Some(home) => detect_in_home(&home),
        None => NOTHING,
    }
}

/// Whether this command line runs openlimiter with the given verb. The
/// documented wirings are `openlimiter <verb>` on a global install and
/// `node <path>/packages/cli/dist/bin.js <verb>` on a clone, and both carry
/// the product name and the verb as plain words.
fn runs_openlimiter(command: &str, verb: &str) -> bool {
    let lowered = command.to_lowercase();
    lowered.contains("openlimiter") && lowered.contains(verb)
}

fn statusline_wired(settings: &serde_json::Value) -> bool {
    let Some(statusline) = settings.get("statusLine") else {
        return false;
    };
    let command_type = statusline.get("type").and_then(serde_json::Value::as_str);
    let command = statusline
        .get("command")
        .and_then(serde_json::Value::as_str);
    matches!((command_type, command), (Some("command"), Some(line)) if runs_openlimiter(line, "statusline"))
}

fn hook_wired(settings: &serde_json::Value) -> bool {
    let Some(entries) = settings
        .get("hooks")
        .and_then(|hooks| hooks.get("UserPromptSubmit"))
        .and_then(serde_json::Value::as_array)
    else {
        return false;
    };
    entries
        .iter()
        .filter_map(|entry| entry.get("hooks").and_then(serde_json::Value::as_array))
        .flatten()
        .filter_map(|hook| hook.get("command").and_then(serde_json::Value::as_str))
        .any(|command| runs_openlimiter(command, "hook"))
}

/// Detect against an explicit home directory, which is what tests use.
pub(crate) fn detect_in_home(home: &Path) -> LocalToolDetection {
    let settings_file = home.join(".claude").join("settings.json");
    let Some(text) = fsx::bounded_read(&settings_file) else {
        return NOTHING;
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&text) else {
        /* The file exists but is not JSON this build can read. Present is a
        fact; wired cannot be established. */
        return LocalToolDetection {
            claude_settings_present: true,
            statusline_wired: false,
            hook_wired: false,
        };
    };
    LocalToolDetection {
        claude_settings_present: true,
        statusline_wired: statusline_wired(&settings),
        hook_wired: hook_wired(&settings),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn write_settings(dir: &TempDir, text: &str) {
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).expect("dir");
        std::fs::write(claude.join("settings.json"), text).expect("write");
    }

    #[test]
    fn missing_settings_detects_nothing() {
        let dir = TempDir::new();
        assert_eq!(detect_in_home(dir.path()), NOTHING);
    }

    #[test]
    fn wired_settings_detect_both() {
        let dir = TempDir::new();
        write_settings(
            &dir,
            r#"{
                "statusLine": {
                    "type": "command",
                    "command": "node /work/openlimiter/packages/cli/dist/bin.js statusline"
                },
                "hooks": {
                    "UserPromptSubmit": [
                        {
                            "hooks": [
                                {
                                    "type": "command",
                                    "command": "node /work/openlimiter/packages/cli/dist/bin.js hook"
                                }
                            ]
                        }
                    ]
                }
            }"#,
        );
        assert_eq!(
            detect_in_home(dir.path()),
            LocalToolDetection {
                claude_settings_present: true,
                statusline_wired: true,
                hook_wired: true,
            }
        );
    }

    #[test]
    fn foreign_statusline_is_present_but_not_wired() {
        let dir = TempDir::new();
        write_settings(
            &dir,
            r#"{"statusLine":{"type":"command","command":"some-other-statusline"}}"#,
        );
        assert_eq!(
            detect_in_home(dir.path()),
            LocalToolDetection {
                claude_settings_present: true,
                statusline_wired: false,
                hook_wired: false,
            }
        );
    }

    #[test]
    fn global_install_wiring_is_recognised() {
        let dir = TempDir::new();
        write_settings(
            &dir,
            r#"{"statusLine":{"type":"command","command":"openlimiter statusline"}}"#,
        );
        assert!(detect_in_home(dir.path()).statusline_wired);
    }

    #[test]
    fn malformed_settings_are_present_and_nothing_more() {
        let dir = TempDir::new();
        write_settings(&dir, "{ this is not json");
        assert_eq!(
            detect_in_home(dir.path()),
            LocalToolDetection {
                claude_settings_present: true,
                statusline_wired: false,
                hook_wired: false,
            }
        );
    }

    #[test]
    fn detection_type_holds_booleans_only() {
        /* The compile time shape is the guarantee; this test states it where
        a reader looks. Three booleans, nothing else, and serializing yields
        no strings from the settings file. */
        let serialized = serde_json::to_string(&NOTHING).expect("serializable");
        assert_eq!(
            serialized,
            r#"{"claude_settings_present":false,"statusline_wired":false,"hook_wired":false}"#
        );
    }
}
