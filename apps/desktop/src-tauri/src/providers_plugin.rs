//! Providers lane. UI invocation: `plugin:providers|providers_catalog`.
use serde::Serialize;
use tauri::{plugin::TauriPlugin, Runtime};

/// Provider codes, matching the provider identity used by SurfaceAccountRow.
/// The lane supplies the catalog later; this stub performs no discovery or I/O.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersCatalog {
    pub providers: Vec<String>,
}

#[tauri::command]
fn providers_catalog() -> ProvidersCatalog {
    ProvidersCatalog {
        providers: Vec::new(),
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("providers")
        .invoke_handler(tauri::generate_handler![providers_catalog])
        .build()
}
