//! Whether OpenLimiter may ask Anthropic for Claude usage on its own.
//!
//! # Why this is a switch and not a feature
//!
//! Claude's own status line hands this product the numbers, live, free, and
//! through a documented interface, every time somebody runs Claude Code. That
//! is the source while this switch is off.
//!
//! The other path is a request to `api/oauth/usage` carrying the token Claude
//! Code stored. It identifies as OpenLimiter rather than copying Claude Code's
//! user agent, and Anthropic's policy for tools like this is unresolved, so it
//! is off unless the person turned it on, and nothing asks or nudges. While it
//! is on it is the only source of every Claude bar (`state::read_cache`).
//!
//! `claude-poll.json` is the one store of truth both runtimes read at every
//! pass; the command line tool's setter writes it too. A missing document means
//! no choice has been recorded. Every other read failure means invalid and
//! stays off. A switch whose failure mode is "on" is not a switch.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Where the answer lives, beside the product's other state.
#[cfg(test)]
const SETTING_FILE_NAME: &str = crate::state::CLAUDE_POLL_FILE_NAME;

const DOCUMENT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PollDocument {
    version: u32,
    enabled: bool,
}

fn write_document(directory: &Path, enabled: bool) -> Result<(), String> {
    let encoded = serde_json::to_string(&PollDocument { version: DOCUMENT_VERSION, enabled })
        .map_err(|_| storage_error())?;
    crate::fsx::atomic_write(&directory.join(crate::state::CLAUDE_POLL_FILE_NAME), &encoded)
        .map_err(|_| storage_error())
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PollStatus {
    Missing,
    Enabled,
    Disabled,
    Invalid,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PollStatusView {
    state: PollStatus,
    enabled: bool,
    /// The last change from this window stands, and the copy a 2.1.5 runtime
    /// reads could not be written.
    mirror_failed: bool,
}

/// The switch. Nothing about its value is kept here: every answer is read
/// from the one store of truth, so a change the command line tool made is
/// seen at the next pass.
pub struct ClaudePollSetting {
    directory: Option<PathBuf>,
    mirror_failed: AtomicBool,
}

impl Default for ClaudePollSetting {
    fn default() -> Self {
        Self::at(crate::state::state_directory())
    }
}

impl ClaudePollSetting {
    pub fn at(directory: Option<PathBuf>) -> Self {
        Self { directory, mirror_failed: AtomicBool::new(false) }
    }

    /// Whether the poll may run at all. Anything but a recorded on is off.
    pub fn enabled(&self) -> bool {
        self.status() == PollStatus::Enabled
    }

    /// The switch as it stands now, read fresh.
    ///
    /// The first 2.1.7 run moves a choice the command line tool recorded on in
    /// its legacy keys into the store of truth, when that holds no choice yet.
    /// Off needs no move: no document already reads as off. Both facts are
    /// read again inside the shared lock, so a 2.1.5 setter that saved off
    /// while this waited wins. TypeScript twin: config.ts
    /// migrateLegacyClaudePoll.
    pub fn status(&self) -> PollStatus {
        let read = || crate::state::read_claude_poll(self.directory.as_deref());
        if let Some(directory) = self.directory.as_deref() {
            let due = || read() == Ok(None) && crate::cli_config::legacy_claude_poll(directory);
            if due() {
                let _ = crate::cli_config::with_lock(directory, |held| {
                    if due() && held.owned() {
                        let _ = write_document(directory, true);
                    }
                });
            }
        }
        match read() {
            Ok(Some(true)) => PollStatus::Enabled,
            Ok(Some(false)) => PollStatus::Disabled,
            Ok(None) => PollStatus::Missing,
            Err(()) => PollStatus::Invalid,
        }
    }

    fn view(&self) -> PollStatusView {
        let state = self.status();
        PollStatusView {
            state,
            enabled: state == PollStatus::Enabled,
            mirror_failed: self.mirror_failed.load(Ordering::Relaxed),
        }
    }

    /// Set it in the one store of truth, and mirror it into the legacy keys a
    /// 2.1.5 runtime still installed reads. `Ok(true)` when this turned it on.
    ///
    /// Both writes happen under the state lock the command line tool's setter
    /// takes too, so concurrent changes end in one state, and each is fenced
    /// on that lock still being this setter's: one reclaimed before the store
    /// of truth fails the set, and one reclaimed before the mirror leaves the
    /// other writer's mirror alone. The store of truth is written first and
    /// the answer changes only once it succeeded: a switch that turns on when
    /// its own storage failed is a switch nobody consented to. A mirror not
    /// written leaves the switch as set and is reported through the view.
    /// TypeScript twin: config.ts setClaudePoll.
    pub fn set(&self, enabled: bool) -> Result<bool, String> {
        let directory = self.directory.as_deref().ok_or_else(storage_error)?;
        let (newly_enabled, mirrored) = crate::cli_config::with_lock(directory, |held| {
            let was_enabled = crate::state::read_claude_poll(Some(directory)) == Ok(Some(true));
            #[cfg(test)]
            pause("store");
            if !held.owned() {
                return Err(storage_error());
            }
            write_document(directory, enabled)?;
            #[cfg(test)]
            pause("mirror");
            let mirrored = held.owned() && crate::cli_config::mirror_claude_poll(directory, enabled).is_ok();
            Ok::<_, String>((enabled && !was_enabled, mirrored))
        })
        .map_err(|_| storage_error())??;
        self.mirror_failed.store(!mirrored, Ordering::Relaxed);
        Ok(newly_enabled)
    }

    fn set_and_poll(&self, enabled: bool, poll: impl FnOnce()) -> Result<(), String> {
        if self.set(enabled)? {
            poll();
        }
        Ok(())
    }
}

#[cfg(test)]
thread_local! {
    /// A test's stand in for this setter pausing before a write.
    static PAUSE: std::cell::RefCell<Option<Box<dyn FnMut(&str)>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn pause(step: &str) {
    PAUSE.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(step);
        }
    });
}

fn storage_error() -> String {
    "claude_poll_setting_unavailable".to_string()
}

/// Read the switch.
#[tauri::command]
pub fn claude_poll_enabled(setting: tauri::State<'_, ClaudePollSetting>) -> PollStatusView {
    setting.view()
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
    fn a_fresh_machine_waits_for_disclosure_before_polling_anthropic() {
        let dir = TempDir::new();
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(!setting.enabled());
        assert_eq!(setting.status(), PollStatus::Missing);
    }

    #[test]
    fn the_answer_survives_a_restart_in_both_directions() {
        let dir = TempDir::new();
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        setting.set(true).expect("a writable state directory");
        assert!(setting.enabled());
        let reopened = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(reopened.enabled());
        assert_eq!(reopened.status(), PollStatus::Enabled);

        reopened.set(false).expect("a writable state directory");
        let again = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(!again.enabled());
        assert_eq!(again.status(), PollStatus::Disabled);
    }

    /// A switch whose failure mode is "on" is not a switch.
    #[test]
    fn every_invalid_document_reads_as_invalid_and_off() {
        let dir = TempDir::new();
        let path = dir.path().join(SETTING_FILE_NAME);
        for written in [
            "not json",
            "{}",
            "{\"version\":99,\"enabled\":true}",
            "{\"enabled\":true}",
            "{\"version\":1,\"enabled\":\"true\"}",
        ] {
            std::fs::write(&path, written).expect("fixture");
            let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
            assert!(!setting.enabled(), "{written} switched the poll on");
            assert_eq!(setting.status(), PollStatus::Invalid);
        }
        /* And the one document that does mean on. */
        std::fs::write(&path, "{\"version\":1,\"enabled\":true}").expect("fixture");
        assert!(ClaudePollSetting::at(Some(dir.path().to_path_buf())).enabled());
    }

    #[test]
    fn unsafe_and_oversized_documents_stay_invalid_and_off() {
        let dir = TempDir::new();
        let path = dir.path().join(SETTING_FILE_NAME);
        std::fs::create_dir_all(&path).expect("directory fixture");
        let unsafe_setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert_eq!(unsafe_setting.status(), PollStatus::Invalid);
        assert!(!unsafe_setting.enabled());
        std::fs::remove_dir(&path).expect("remove fixture");
        std::fs::write(&path, "x".repeat(crate::fsx::MAX_STATE_FILE_BYTES as usize + 1))
            .expect("oversized fixture");
        let oversized = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert_eq!(oversized.status(), PollStatus::Invalid);
        assert!(!oversized.enabled());
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_setting_symlink_is_invalid_and_off() {
        let dir = TempDir::new();
        let path = dir.path().join(SETTING_FILE_NAME);
        std::os::unix::fs::symlink(dir.path().join("missing.json"), &path).expect("symlink");
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert_eq!(setting.status(), PollStatus::Invalid);
        assert!(!setting.enabled());
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

    fn json(path: &std::path::Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).expect("document")).expect("json")
    }

    /// 2.1.7, plan item 1: one store of truth, read at every pass. The other
    /// runtime's change is seen at the next call, and this switch writes the
    /// store of truth and mirrors the legacy keys a 2.1.5 runtime reads.
    /// TypeScript twin: refresh.test.ts, "either setter changes both runtimes
    /// at their next pass".
    #[test]
    fn either_setter_changes_both_runtimes_at_their_next_pass() {
        let dir = TempDir::new();
        let config = dir.path().join("openlimiter-config.json");
        std::fs::write(
            &config,
            r#"{"version":1,"connectors":[],"statusline":{"captions":"tagged"},"providers":{"claude":{"poll":false,"recorded":true}}}"#,
        )
        .expect("fixture");
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(!setting.enabled());
        // What `openlimiter config set providers.claude.poll true` writes.
        std::fs::write(dir.path().join(SETTING_FILE_NAME), r#"{"enabled":true,"version":1}"#).expect("fixture");
        assert!(setting.enabled(), "the switch was read from a cached copy");
        for enabled in [false, true] {
            setting.set(enabled).expect("a writable state directory");
            assert_eq!(json(&dir.path().join(SETTING_FILE_NAME))["enabled"], enabled);
            let mirrored = json(&config);
            assert_eq!(mirrored["providers"]["claude"], serde_json::json!({"poll": enabled, "recorded": true}));
            assert_eq!(mirrored["statusline"]["captions"], "tagged", "the rest of the document stays");
        }
        assert!(!setting.view().mirror_failed);
    }

    #[test]
    fn a_failed_mirror_write_keeps_the_switch_and_is_reported() {
        let dir = TempDir::new();
        let config = dir.path().join("openlimiter-config.json");
        std::fs::create_dir_all(&config).expect("a directory in the legacy document's place");
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert!(setting.set(true).is_ok(), "the store of truth was written");
        assert!(setting.enabled());
        assert!(setting.view().mirror_failed);
        std::fs::remove_dir(&config).expect("remove fixture");
        std::fs::write(&config, r#"{"version":1,"providers":{"claude":{"poll":true,"recorded":true}}}"#).expect("fixture");
        setting.set(false).expect("a writable state directory");
        assert!(!setting.view().mirror_failed);
    }

    #[test]
    fn concurrent_changes_end_in_one_state() {
        let dir = TempDir::new();
        let config = dir.path().join("openlimiter-config.json");
        std::fs::write(&config, r#"{"version":1,"providers":{"claude":{"poll":false,"recorded":true}}}"#).expect("fixture");
        let root = dir.path().to_path_buf();
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let root = root.clone();
                std::thread::spawn(move || ClaudePollSetting::at(Some(root)).set(index % 2 == 0).expect("written"))
            })
            .collect();
        for writer in writers {
            writer.join().expect("writer");
        }
        let switched = json(&dir.path().join(SETTING_FILE_NAME))["enabled"].clone();
        assert_eq!(json(&config)["providers"]["claude"], serde_json::json!({"poll": switched, "recorded": true}));
    }

    /// The first 2.1.7 run moves a choice recorded on in the command line
    /// tool's legacy keys into the store of truth, when it holds no choice yet.
    #[test]
    fn a_recorded_cli_on_moves_into_the_store_of_truth_once() {
        let dir = TempDir::new();
        let config = dir.path().join("openlimiter-config.json");
        // A 2.0.3 boolean predates the recorded marker and is still a choice.
        std::fs::write(&config, r#"{"version":1,"providers":{"claude":{"poll":true}}}"#).expect("fixture");
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        assert_eq!(setting.status(), PollStatus::Enabled);
        assert_eq!(json(&dir.path().join(SETTING_FILE_NAME))["enabled"], true);
        for (legacy, stored, expected) in [
            (r#"{"version":1,"providers":{"claude":{"poll":true,"recorded":false}}}"#, None, PollStatus::Missing),
            (r#"{"version":1,"providers":{"claude":{"poll":false,"recorded":true}}}"#, None, PollStatus::Missing),
            (
                r#"{"version":1,"providers":{"claude":{"poll":true,"recorded":true}}}"#,
                Some(r#"{"version":1,"enabled":false}"#),
                PollStatus::Disabled,
            ),
        ] {
            let _ = std::fs::remove_file(dir.path().join(SETTING_FILE_NAME));
            std::fs::write(&config, legacy).expect("fixture");
            if let Some(text) = stored {
                std::fs::write(dir.path().join(SETTING_FILE_NAME), text).expect("fixture");
            }
            assert_eq!(setting.status(), expected, "{legacy}");
        }
    }

    /// Astra fix round, finding 3: a 2.1.5 setter that saves off while the
    /// move waits for the shared lock wins, because the move rereads the
    /// legacy choice and the store of truth inside the lock. TypeScript twin:
    /// refresh.test.ts, "never moves a legacy on that a setter turned off
    /// while the move waited for the lock".
    #[test]
    fn a_legacy_off_saved_while_the_move_waits_wins() {
        let dir = TempDir::new();
        let config = dir.path().join("openlimiter-config.json");
        std::fs::write(&config, r#"{"version":1,"providers":{"claude":{"poll":true,"recorded":true}}}"#).expect("fixture");
        let root = dir.path().to_path_buf();
        // This thread holds the shared lock, as a 2.1.5 setter does while it saves.
        let mover = crate::cli_config::with_lock(dir.path(), |_| {
            let mover = std::thread::spawn(move || ClaudePollSetting::at(Some(root)).status());
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::fs::write(&config, r#"{"version":1,"providers":{"claude":{"poll":false,"recorded":true}}}"#)
                .expect("the setter saves off");
            mover
        })
        .expect("lock");
        assert_eq!(mover.join().expect("mover"), PollStatus::Missing);
        assert!(!dir.path().join(SETTING_FILE_NAME).exists(), "the move wrote a stale on");
    }

    /// Astra fix round, finding 5: a setter whose lock was reclaimed while it
    /// paused (a lock held past sixty seconds is reclaimed even from a live
    /// owner) writes nothing more over the writer that took it, and says so.
    /// TypeScript twin: refresh.test.ts, "a setter that lost the lock before
    /// a write writes nothing more and says so".
    #[test]
    fn a_setter_that_lost_the_lock_writes_nothing_more_and_says_so() {
        let dir = TempDir::new();
        let config = dir.path().join("openlimiter-config.json");
        let legacy_off = r#"{"version":1,"providers":{"claude":{"poll":false,"recorded":true}}}"#;
        std::fs::write(&config, legacy_off).expect("fixture");
        let lock = dir.path().join("openlimiter.lock");
        let setting = ClaudePollSetting::at(Some(dir.path().to_path_buf()));
        for paused in ["mirror", "store"] {
            let (root, lock_dir) = (dir.path().to_path_buf(), lock.clone());
            PAUSE.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move |step: &str| {
                    if step != paused {
                        return;
                    }
                    // The lock was reclaimed, and another setter saved off in both places.
                    let owner = serde_json::json!({"pid": std::process::id(), "startedAt": 4_102_444_800_000_u64, "token": "another-setter"});
                    std::fs::write(lock_dir.join("owner.json"), owner.to_string()).expect("owner");
                    std::fs::write(root.join(SETTING_FILE_NAME), r#"{"enabled":false,"version":1}"#).expect("store");
                    std::fs::write(root.join("openlimiter-config.json"), legacy_off).expect("mirror");
                }));
            });
            let result = setting.set(true);
            PAUSE.with(|hook| *hook.borrow_mut() = None);
            if paused == "mirror" {
                assert!(result.is_ok(), "the store of truth was written before the lock was lost");
                assert!(setting.view().mirror_failed, "the lost mirror is reported");
            } else {
                assert!(result.is_err(), "a set that lost the lock before its first write fails");
            }
            assert_eq!(json(&dir.path().join(SETTING_FILE_NAME))["enabled"], false, "{paused}");
            assert_eq!(json(&config)["providers"]["claude"], serde_json::json!({"poll": false, "recorded": true}), "{paused}");
            let _ = std::fs::remove_dir_all(&lock);
        }
    }

    #[test]
    fn a_machine_with_no_state_directory_never_polls() {
        let setting = ClaudePollSetting::at(None);
        assert!(!setting.enabled());
        /* Setting it still reports the failure rather than pretending. */
        assert!(setting.set(true).is_err());
    }
}
