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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMetadata>, UpdateFailure> {
    let update = app
        .updater()
        .map_err(|_| UpdateFailure::UpdateCheckFailed)?
        .check()
        .await
        .map_err(|_| UpdateFailure::UpdateCheckFailed)?;

    let metadata = update.as_ref().map(|available| UpdateMetadata {
        version: available.version.clone(),
        current_version: available.current_version.clone(),
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
        })
        .expect("metadata");
        assert_eq!(
            value,
            serde_json::json!({
                "version": "1.0.1",
                "currentVersion": "1.0.0"
            })
        );
    }
}
