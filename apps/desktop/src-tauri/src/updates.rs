use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("OPENLIMITER_UPDATER_PUBLIC_KEY");

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateFailure {
    UpdaterUnconfigured,
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
    if UPDATE_PUBLIC_KEY.is_none() {
        return Err(UpdateFailure::UpdaterUnconfigured);
    }

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

#[tauri::command]
pub async fn install_update(pending: State<'_, PendingUpdate>) -> Result<(), UpdateFailure> {
    let update = {
        let mut slot = pending
            .0
            .lock()
            .map_err(|_| UpdateFailure::UpdateStateUnavailable)?;
        slot.take().ok_or(UpdateFailure::NoPendingUpdate)?
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| UpdateFailure::UpdateInstallFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

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
