use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

impl PendingUpdate {
    /// The version an install would bring, for the tray's Install update item.
    pub fn version(&self) -> Option<String> {
        self.0.lock().ok().and_then(|slot| slot.as_ref().map(|update| update.version.clone()))
    }
}

/// Set from the moment an install takes the pending update until it restarts
/// or fails: no second install, and no check that would refill the update
/// while one is being installed.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// One check at a time, whichever window, timer or tray asked.
static CHECKING: AtomicBool = AtomicBool::new(false);

/// How long one check may wait on the release manifest.
const CHECK_DEADLINE: Duration = Duration::from_secs(30);

/// How often the native side checks on its own, window open or not: a hidden
/// window's timers can be suspended, so the window alone is not enough.
pub const CHECK_EVERY: Duration = Duration::from_secs(2 * 60 * 60);

/// Clears a flag when the holder ends, however it ends.
struct Clears(&'static AtomicBool);

impl Drop for Clears {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn claim(flag: &'static AtomicBool) -> Option<Clears> {
    (!flag.swap(true, Ordering::AcqRel)).then(|| Clears(flag))
}

/// Remembers the last version a notification announced, so a check every two
/// hours says it once.
const UPDATE_NOTIFIED_FILE: &str = "update-notified.txt";

/// Whether `version` still needs announcing, given what the marker holds.
pub(crate) fn needs_notice(marker: Option<&str>, version: &str) -> bool {
    marker.map(str::trim) != Some(version)
}

/// One desktop notification per new version, so an update is seen with the
/// window closed. The marker is written only once the notification showed.
fn notify_once(app: &AppHandle, version: &str) {
    let Some(directory) = crate::state::state_directory() else {
        return;
    };
    let marker = directory.join(UPDATE_NOTIFIED_FILE);
    if !needs_notice(crate::fsx::bounded_read(&marker).as_deref(), version) {
        return;
    }
    let shown = app
        .notification()
        .builder()
        .title("OpenLimiter update ready")
        .body(format!("Version {version} is ready. Press Update in OpenLimiter, or Install update in its tray menu."))
        .show()
        .is_ok();
    if shown {
        let _ = crate::fsx::atomic_write(&marker, version);
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateFailure {
    UpdateCheckFailed,
    NoPendingUpdate,
    UpdateInstallFailed,
    UpdateStateUnavailable,
    DownloadPageUnavailable,
}

/// Where a release the manifest has no installer for here (macOS while it is
/// unsigned) is downloaded from.
const DOWNLOAD_PAGE: &str = "https://openlimiter.com/download";

/// Open the download page in the person's browser: the one native action both
/// manual update controls use (Astra 2.1.7, finding 2). It takes no address
/// from the window, so it can open nothing else.
#[tauri::command]
pub fn open_download_page(app: AppHandle) -> Result<(), UpdateFailure> {
    use tauri_plugin_opener::OpenerExt as _;
    open_download_page_with(|url| app.opener().open_url(url, None::<&str>))
}

fn open_download_page_with<E>(open: impl FnOnce(&str) -> Result<(), E>) -> Result<(), UpdateFailure> {
    open(DOWNLOAD_PAGE).map_err(|_| UpdateFailure::DownloadPageUnavailable)
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
    /// True where the manifest has no installer for this platform (macOS
    /// while it is unsigned): the window links to the download page.
    manual: bool,
}

/// A manifest with no installer for this platform still names the newest
/// version (seen by the comparator, with whether it is newer): a newer one is
/// reported for the download page and the same or an older one is current.
/// Any other failure stays a failed check.
fn without_installer(
    error: &tauri_plugin_updater::Error,
    seen: Option<(String, bool)>,
    current: &str,
) -> Result<Option<UpdateMetadata>, UpdateFailure> {
    use tauri_plugin_updater::Error;
    match (error, seen) {
        (Error::TargetNotFound(_) | Error::TargetsNotFound(_), Some((version, newer))) => {
            Ok(newer.then(|| UpdateMetadata {
                version,
                current_version: current.to_string(),
                manual: true,
            }))
        }
        _ => Err(UpdateFailure::UpdateCheckFailed),
    }
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMetadata>, UpdateFailure> {
    check_now(&app, &pending).await
}

/// The native timer: check every two hours for the life of the process, so
/// the tray item and the one notification appear with the window closed.
pub fn spawn_periodic_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CHECK_EVERY).await;
            let pending = app.state::<PendingUpdate>();
            let _ = check_now(&app, &pending).await;
        }
    });
}

async fn check_now(app: &AppHandle, pending: &PendingUpdate) -> Result<Option<UpdateMetadata>, UpdateFailure> {
    /* While an install runs, nothing may refill the update it took. */
    if INSTALLING.load(Ordering::Acquire) {
        return Err(UpdateFailure::UpdateCheckFailed);
    }
    let Some(_checking) = claim(&CHECKING) else {
        return Err(UpdateFailure::UpdateCheckFailed);
    };
    /* The comparator reads the manifest's version before the plugin looks
    for this platform's download, which is how macOS, left out of the
    manifest while it is unsigned, learns of a newer release: the same one
    request, nothing new on the wire (2.1.7). */
    let seen = std::sync::Arc::new(Mutex::new(None::<(String, bool)>));
    let witness = seen.clone();
    let checked = app
        .updater_builder()
        .timeout(CHECK_DEADLINE)
        .version_comparator(move |current, release| {
            let newer = release.version > current;
            if let Ok(mut slot) = witness.lock() {
                *slot = Some((release.version.to_string(), newer));
            }
            newer
        })
        .build()
        .map_err(|_| UpdateFailure::UpdateCheckFailed)?
        .check()
        .await;
    let update = match checked {
        Ok(update) => update,
        Err(error) => {
            let seen = seen.lock().ok().and_then(|slot| slot.clone());
            let outcome = without_installer(&error, seen, &app.package_info().version.to_string())?;
            // Nothing this app could install is left pending.
            *pending
                .0
                .lock()
                .map_err(|_| UpdateFailure::UpdateStateUnavailable)? = None;
            return Ok(outcome);
        }
    };

    let metadata = update.as_ref().map(|available| UpdateMetadata {
        version: available.version.clone(),
        current_version: available.current_version.clone(),
        manual: false,
    });

    let mut slot = pending
        .0
        .lock()
        .map_err(|_| UpdateFailure::UpdateStateUnavailable)?;
    *slot = update;
    drop(slot);
    if let Some(found) = &metadata {
        notify_once(app, &found.version);
    }
    Ok(metadata)
}

/// The relaunch an update starts carries this process's arguments, the sign
/// in entry's included, so the install starts only once the mark that brings
/// the window back is written.
fn mark_install(directory: Option<&std::path::Path>) -> Result<(), UpdateFailure> {
    if crate::autostart::mark_update(directory) {
        Ok(())
    } else {
        Err(UpdateFailure::UpdateStateUnavailable)
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), UpdateFailure> {
    install_pending(&app).await
}

/// Download and install the update a check left pending, then restart: the
/// window's Update button and the tray's Install update item both land here.
pub async fn install_pending(app: &AppHandle) -> Result<(), UpdateFailure> {
    /* Ownership first: a second click, from the window or the tray, is
    refused before it can touch the update or the restart mark. */
    let Some(_installing) = claim(&INSTALLING) else {
        return Err(UpdateFailure::NoPendingUpdate);
    };
    let pending = app.state::<PendingUpdate>();
    let update = pending
        .0
        .lock()
        .map(|mut slot| slot.take())
        .map_err(|_| UpdateFailure::UpdateStateUnavailable)
        .and_then(|update| update.ok_or(UpdateFailure::NoPendingUpdate))?;
    let directory = crate::state::state_directory();
    mark_install(directory.as_deref())?;
    if update.download_and_install(|_, _| {}, || {}).await.is_err() {
        crate::autostart::take_update_mark(directory.as_deref());
        return Err(UpdateFailure::UpdateInstallFailed);
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    #[test]
    fn one_install_and_one_check_at_a_time() {
        let first = super::claim(&super::INSTALLING).expect("free");
        assert!(super::claim(&super::INSTALLING).is_none());
        assert!(super::claim(&super::INSTALLING).is_none(), "a refusal does not free it");
        drop(first);
        assert!(super::claim(&super::INSTALLING).is_some());
    }

    #[test]
    fn a_version_is_announced_once() {
        assert!(super::needs_notice(None, "2.1.15"));
        assert!(super::needs_notice(Some("2.1.14"), "2.1.15"));
        assert!(!super::needs_notice(Some("2.1.15\n"), "2.1.15"));
    }

    use super::*;

    /// The relaunch keeps the sign in argument, so without the mark that
    /// brings the window back the install does not start.
    #[test]
    fn an_install_starts_only_after_its_mark_is_written() {
        assert!(matches!(
            mark_install(None),
            Err(UpdateFailure::UpdateStateUnavailable)
        ));
        let dir = crate::test_support::TempDir::new();
        assert!(mark_install(Some(dir.path())).is_ok());
        assert!(crate::autostart::take_update_mark(Some(dir.path())));
    }

    #[test]
    fn failures_cross_ipc_as_closed_kinds() {
        let value = serde_json::to_value(UpdateFailure::UpdateCheckFailed).expect("failure");
        assert_eq!(value, serde_json::json!({ "kind": "update_check_failed" }));
    }

    #[test]
    fn metadata_contains_no_endpoint_notes_or_signature() {
        let value = serde_json::to_value(UpdateMetadata {
            version: "1.0.1".to_string(),
            current_version: "1.0.0".to_string(),
            manual: false,
        })
        .expect("metadata");
        assert_eq!(
            value,
            serde_json::json!({
                "version": "1.0.1",
                "currentVersion": "1.0.0",
                "manual": false
            })
        );
    }

    /// Astra 2.1.7, finding 2: both manual update controls open the download
    /// page through this one native action, which takes no address from the
    /// window and opens exactly one.
    #[test]
    fn the_download_page_is_the_one_address_this_action_opens() {
        let mut opened = Vec::new();
        assert!(open_download_page_with(|url| {
            opened.push(url.to_string());
            Ok::<(), ()>(())
        })
        .is_ok());
        assert_eq!(opened, ["https://openlimiter.com/download"]);
        assert!(matches!(
            open_download_page_with(|_| Err::<(), ()>(())),
            Err(UpdateFailure::DownloadPageUnavailable)
        ));
    }

    /// macOS is left out of the manifest while it is unsigned (2.1.7): the
    /// check still learns the newest version and sends the window to the
    /// download page, instead of saying the check is unavailable.
    #[test]
    fn a_platform_without_an_installer_learns_the_version_for_the_download_page() {
        use tauri_plugin_updater::Error;
        let missing = Error::TargetsNotFound(vec!["darwin-aarch64-app".into(), "darwin-aarch64".into()]);
        assert_eq!(
            without_installer(&missing, Some(("2.1.7".into(), true)), "2.1.6").expect("checked"),
            Some(UpdateMetadata {
                version: "2.1.7".to_string(),
                current_version: "2.1.6".to_string(),
                manual: true,
            })
        );
        assert_eq!(
            without_installer(&Error::TargetNotFound("darwin-x86_64".into()), Some(("2.1.7".into(), true)), "2.1.6")
                .expect("checked")
                .map(|update| update.manual),
            Some(true)
        );
        // The same or an older version is current.
        assert_eq!(without_installer(&missing, Some(("2.1.6".into(), false)), "2.1.6").expect("checked"), None);
        // No manifest read, or any other failure, is still a failed check.
        assert!(matches!(without_installer(&missing, None, "2.1.6"), Err(UpdateFailure::UpdateCheckFailed)));
        assert!(matches!(
            without_installer(&Error::ReleaseNotFound, Some(("2.1.7".into(), true)), "2.1.6"),
            Err(UpdateFailure::UpdateCheckFailed)
        ));
    }
}
