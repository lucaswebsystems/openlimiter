//! Rail lane. UI invocation: `plugin:rail|rail_snapshot`.
use serde::Serialize;
use tauri::{plugin::TauriPlugin, Runtime};

/// Mirrors SessionsSummary from contracts/surfaces.ts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSummary {
    pub busy: u32,
    pub waiting: u32,
    pub done: u32,
    pub idle: u32,
    pub unknown: u32,
}

/// Mirrors RailAccountViewModel (SurfaceAccountRow), including explicit nulls.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailAccountViewModel {
    pub provider: String,
    pub account: Option<String>,
    pub headline_meter_id: String,
    pub kind: String,
    pub value: Option<f64>,
    pub meaning: String,
    pub window_label: String,
    pub reset_at: Option<String>,
    pub freshness: String,
    pub availability: String,
    pub band: String,
    pub precision: String,
    pub fidelity_marker: Option<String>,
    pub sessions: SessionsSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailSnapshot {
    pub accounts: Vec<RailAccountViewModel>,
}

#[tauri::command]
fn rail_snapshot() -> RailSnapshot {
    RailSnapshot {
        accounts: Vec::new(),
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("rail")
        .invoke_handler(tauri::generate_handler![rail_snapshot])
        .build()
}
