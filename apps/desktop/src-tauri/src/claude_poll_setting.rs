//! Whether OpenLimiter may ask Anthropic for a percentage on its own.
//!
//! # Why this is a switch and not a feature
//!
//! Claude's own status line hands this product the numbers, live, free, and
//! through a documented interface, every time somebody runs Claude Code. That
//! is the source, and it needs no permission from anybody.
//!
//! The other path is a request to `api/oauth/usage` carrying the token Claude
//! Code stored. Every quota monitor makes it, it identifies as OpenLimiter
//! rather than copying Claude Code's user agent, and it exists only for the
//! hours Claude Code is closed. It is also the one read in this product whose
//! standing is genuinely unsettled, so it does not happen unless somebody
//! turns it on, having read a sentence that says plainly what it does.
//!
//! Off is the default and off is what an unreadable or absent setting means.
//! A switch whose failure mode is "on" is not a switch.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Where the answer lives, beside the product's other state.
const SETTING_FILE_NAME: &str = "claude-poll.json";

const DOCUMENT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PollDocument {
    version: u32,
    enabled: bool,
}

/// The switch, read once and kept.
pub struct ClaudePollSetting {
    file: Option<PathBuf>,
    enabled: Mutex<bool>,
}

impl Default for ClaudePollSetting {
    fn default() -> Self {
        Self::at(crate::state::state_directory())
    }
}

impl ClaudePollSetting {
    pub fn at(directory: Option<PathBuf>) -> Self {
        let file = directory.map(|value| value.join(SETTING_FILE_NAME));
        let enabled = file
            .as_ref()
            .and_then(|path| crate::fsx::bounded_read(path))
            .and_then(|text| serde_json::from_str::<PollDocument>(&text).ok())
            .filter(|document| document.version == DOCUMENT_VERSION)
            .is_some_and(|document| document.enabled);
        Self {
            file,
            enabled: Mutex::new(enabled),
        }
    }

    /// Whether the poll may run at all.
    ///
    /// A lock this process cannot take reads as off, for the same reason an
    /// unreadable file does: the safe answer to "may I make this request" is
    /// no.
    pub fn enabled(&self) -> bool {
        self.enabled.lock().map(|value| *value).unwrap_or(false)
    }

    /// Set it, and remember it past this run.
    ///
    /// The durable write happens first and the live answer changes only once
    /// it succeeded. The other order looks harmless and is not: a machine that
    /// cannot write its state directory would start polling Anthropic for the
    /// rest of the session on the strength of a switch that was never saved,
    /// and the next launch would read the file that still says off and have no
    /// idea it had ever happened. A switch that turns on when its own storage
    /// failed is a switch nobody consented to.
    pub fn set(&self, enabled: bool) -> Result<bool, String> {
        let mut held = self.enabled.lock().map_err(|_| storage_error())?;
        let path = self.file.as_ref().ok_or_else(storage_error)?;
        let parent = path.parent().ok_or_else(storage_error)?;
        crate::fsx::ensure_private_dir(parent).map_err(|_| storage_error())?;
        let encoded = serde_json::to_string(&PollDocument {
            version: DOCUMENT_VERSION,
            enabled,
        })
        .map_err(|_| storage_error())?;
        crate::fsx::atomic_write(path, &encoded).map_err(|_| storage_error())?;
        let newly_enabled = enabled && !*held;
        *held = enabled;
        Ok(newly_enabled)
    }

    fn set_and_poll(&self, enabled: bool, poll: impl FnOnce()) -> Result<(), String> {
        if self.set(enabled)? {
            poll();
        }
        Ok(())
    }
}

fn storage_error() -> String {
    "claude_poll_setting_unavailable".to_string()
}

/// Read the switch.
#[tauri::command]
pub fn claude_poll_enabled(setting: tauri::State<'_, ClaudePollSetting>) -> bool {
    setting.enabled()
}

/// Set the switch.
#[tauri::command]
pub fn set_claude_poll_enabled(
    enabled: bool,
    setting: tauri::State<'_, ClaudePollSetting>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    setting.set_and_poll(enabled, || {
        tauri::async_runtime::spawn(async move {
            let multi_account = crate::pro::multi_account_enabled(
                &*app.state::<crate::credentials::KeyringStore>(),
            );
            crate::claude_oauth::run_pass(&app, if multi_account { usize::MAX } else { 1 }).await;
            use tauri::Emitter;
            let _ = app.emit(crate::collector_runtime::COLLECTOR_UPDATED_EVENT, ());
        });
    })?;
    Ok(setting.enabled())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn enabling_polls_immediately_once_and_only_after_persistence() {
        let dir = TempDir::new();
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        let polls = std::cell::Cell::new(0);
        for enabled in [false, true, true, false] {
            setting
                .set_and_poll(enabled, || {
                    assert!(ClaudePollSetting::at(Some(dir.path().to_path_buf())).enabled());
                    polls.set(polls.get() + 1);
                })
                .unwrap();
        }
        assert_eq!(polls.get(), 1);
        let unavailable = ClaudePollSetting::at(None);
        assert!(unavailable.set_and_poll(true, || polls.set(99)).is_err());
        assert_eq!(polls.get(), 1);
    }

    #[test]
    fn a_fresh_machine_does_not_poll_anthropic() {
        let dir = TempDir::new();
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(!setting.enabled());
    }

    #[test]
    fn the_answer_survives_a_restart_in_both_directions() {
        let dir = TempDir::new();
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        setting.set(true).expect("a writable state directory");
        assert!(setting.enabled());
        let reopened = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(reopened.enabled());

        reopened.set(false).expect("a writable state directory");
        let again = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(!again.enabled());
    }

    /// A switch whose failure mode is "on" is not a switch.
    #[test]
    fn an_unreadable_or_foreign_document_reads_as_off() {
        let dir = TempDir::new();
        let path = dir.path().join(SETTING_FILE_NAME);
        for written in [
            "not json",
            "{}",
            "{\"version\":99,\"enabled\":true}",
            "{\"enabled\":true}",
        ] {
            std::fs::write(&path, written).expect("fixture");
            let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
            assert!(!setting.enabled(), "{written} switched the poll on");
        }
        /* And the one document that does mean on. */
        std::fs::write(&path, "{\"version\":1,\"enabled\":true}").expect("fixture");
        assert!(ClaudePollSetting::at(Some(dir.path().to_path_buf())).enabled());
    }

    /// A switch that cannot be saved is a switch that did not move.
    ///
    /// The live answer used to change before the write was attempted, so a
    /// machine that could not write its state directory would poll Anthropic
    /// for the rest of the session on the strength of a setting that was never
    /// stored, and the next launch would read the file that still says off and
    /// have no idea it had happened.
    #[test]
    fn a_failed_write_leaves_the_poll_off() {
        let setting = ClaudePollSetting::at(None);
        assert!(!setting.enabled());
        assert!(setting.set(true).is_err());
        assert!(!setting.enabled(), "a failed write switched the poll on");

        /* And the same holds where the path exists but cannot be written: a
        directory standing where the document belongs refuses every write. */
        let dir = TempDir::new();
        let path = dir.path().join(SETTING_FILE_NAME);
        std::fs::create_dir_all(&path).expect("a directory in the document's place");
        let blocked = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(blocked.set(true).is_err());
        assert!(!blocked.enabled(), "a failed write switched the poll on");
    }

    #[test]
    fn a_machine_with_no_state_directory_never_polls() {
        let setting = ClaudePollSetting::at(None);
        assert!(!setting.enabled());
        /* Setting it still reports the failure rather than pretending. */
        assert!(setting.set(true).is_err());
    }
}
