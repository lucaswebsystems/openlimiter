//! Activity spool consumer. Native notification handoff: `activity-transition`.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[path = "activity/contract.rs"]
mod contract;
#[path = "activity/engine.rs"]
pub mod engine;
#[path = "activity/locate.rs"]
mod locate;
#[path = "activity/notify.rs"]
mod notify;
#[path = "activity/process.rs"]
mod process;
#[path = "activity/runtime.rs"]
mod runtime;
pub(crate) use runtime::display_sessions;
#[path = "activity/spool.rs"]
mod spool;
#[path = "activity/storage.rs"]
mod storage;
#[cfg(test)]
#[path = "activity/tests.rs"]
mod tests;

#[derive(Default)]
struct ActivityState {
    sessions: Mutex<Vec<ActivityDisplayRecord>>,
    targets: Mutex<std::collections::BTreeMap<String, contract::Process>>,
    running: AtomicBool,
    skipped_files: AtomicUsize,
    inspected_entries: AtomicUsize,
}

#[tauri::command]
fn activity_locate(
    session_id: String,
    state: tauri::State<'_, ActivityState>,
) -> locate::LocateResult {
    let target = state
        .targets
        .lock()
        .ok()
        .and_then(|targets| targets.get(&session_id).cloned());
    locate::locate(target.as_ref())
}

#[tauri::command]
fn activity_notification_preferences() -> Result<notify::Preferences, String> {
    notify::load().map_err(|_| "activity_preferences_unavailable".into())
}

#[tauri::command]
fn activity_set_notification_preferences(preferences: notify::Preferences) -> Result<(), String> {
    notify::save(&preferences).map_err(|_| "activity_preferences_unavailable".into())
}

/// Mirrors ActivityDisplayRecord, never the local ActivitySession or process identity.
#[derive(Clone, Debug, Serialize)]
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
    pub skipped_files: usize,
    pub inspected_entries_last_tick: usize,
}

#[tauri::command(async)]
async fn activity_snapshot<R: Runtime>(app: tauri::AppHandle<R>) -> Result<ActivitySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ActivityState>();
        Ok(ActivitySnapshot {
            sessions: state.sessions.lock().map(|s| s.clone()).unwrap_or_default(),
            skipped_files: state.skipped_files.load(Ordering::Relaxed),
            inspected_entries_last_tick: state.inspected_entries.load(Ordering::Relaxed),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
async fn activity_sessions<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<ActivityDisplayRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ActivityState>();
        Ok(state.sessions.lock().map(|s| s.clone()).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("activity")
        .setup(|app, _| {
            app.manage(ActivityState::default());
            Ok(())
        })
        .on_event(|app, event| match event {
            tauri::RunEvent::Ready => runtime::start(app),
            tauri::RunEvent::Exit => {
                app.state::<ActivityState>()
                    .running
                    .store(false, Ordering::Relaxed);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            activity_snapshot,
            activity_sessions,
            activity_locate,
            activity_notification_preferences,
            activity_set_notification_preferences
        ])
        .build()
}
