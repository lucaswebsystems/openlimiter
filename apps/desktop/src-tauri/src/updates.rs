use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateFailure {
    UpdateCheckFailed,
    NoPendingUpdate,
    UpdateInstallFailed,
    UpdateStateUnavailable,
    DownloadPageUnavailable,
}

/// Stub with today's behaviour: nothing native opens the download page.
fn open_download_page_with<E>(open: impl FnOnce(&str) -> Result<(), E>) -> Result<(), UpdateFailure> {
    let _ = open;
    Ok(())
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
    /* The comparator reads the manifest's version before the plugin looks
    for this platform's download, which is how macOS, left out of the
    manifest while it is unsigned, learns of a newer release: the same one
    request, nothing new on the wire (2.1.7). */
    let seen = std::sync::Arc::new(Mutex::new(None::<(String, bool)>));
    let witness = seen.clone();
    let checked = app
        .updater_builder()
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
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), UpdateFailure> {
    let directory = crate::state::state_directory();
    mark_install(directory.as_deref())?;
    let taken = pending
        .0
        .lock()
        .map(|mut slot| slot.take())
        .map_err(|_| UpdateFailure::UpdateStateUnavailable)
        .and_then(|update| update.ok_or(UpdateFailure::NoPendingUpdate));
    let installed = match taken {
        Ok(update) => update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|_| UpdateFailure::UpdateInstallFailed),
        Err(failure) => Err(failure),
    };
    if let Err(failure) = installed {
        crate::autostart::take_update_mark(directory.as_deref());
        return Err(failure);
    }
    app.restart();
}

#[cfg(test)]
mod tests {
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
