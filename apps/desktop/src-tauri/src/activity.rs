//! Agents lane. UI invocation: `plugin:activity|activity_snapshot`.
use serde::Serialize;
use tauri::{plugin::TauriPlugin, Runtime};

/// Mirrors ActivityDisplayRecord, never the local ActivitySession or process identity.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDisplayRecord {
    pub session_id: String,
    pub agent: String,
    pub state: String,
    pub confidence: String,
    pub first_observed_at: String,
    pub observed_at: String,
    pub state_changed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_project_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub sessions: Vec<ActivityDisplayRecord>,
}

#[tauri::command]
fn activity_snapshot() -> ActivitySnapshot {
    ActivitySnapshot {
        sessions: Vec::new(),
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("activity")
        .invoke_handler(tauri::generate_handler![activity_snapshot])
        .build()
}
