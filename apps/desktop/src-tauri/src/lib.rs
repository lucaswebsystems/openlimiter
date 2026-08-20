mod antigravity_credential;
mod antigravity_oauth;
mod cache_write;
mod claude_connect;
mod claude_detect;
mod claude_oauth;
mod codex_oauth;
mod collector;
mod collector_runtime;
mod collector_schedule;
mod commands;
mod connections;
mod credentials;
mod fsx;
mod gemini_cli_oauth;
mod native_opencode;
mod native_readers;
mod native_snapshot;
mod native_time;
mod net;
mod pro;
mod provider_detection;
mod reader_registry;
mod state;
#[cfg(test)]
mod test_support;
mod tray;
mod updates;

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

/// OpenLimiter for the desktop.
///
/// A window and a tray icon around the engine that already exists. Rust does
/// only what the webview cannot: find the state directory, read and replace
/// state files, keep provider secrets in the operating system credential
/// store, speak HTTPS to a closed allowlist of provider endpoints, and run the
/// durable collector the operating system will not throttle. The webview
/// retains freshness, advice and rendering policy, while native readers close
/// remote collection before any result crosses IPC.
///
/// The webview itself gains nothing: its content security policy and its
/// capabilities are unchanged, every request leaves from this process, and a
/// secret that has entered `connect_provider` can never be read back across
/// the boundary.
/// The snapshot cache as text, or nothing when there is nothing to read.
#[tauri::command]
fn read_cache() -> Option<String> {
    state::read_cache()
}

/// The manual quota document as text, for the one connector that reads a file.
#[tauri::command]
fn read_manual() -> Option<String> {
    state::read_manual()
}

/// Where the cache is looked for, so the window can say so plainly.
#[tauri::command]
fn state_directory() -> Option<String> {
    state::state_directory().map(|path| path.to_string_lossy().into_owned())
}

/// Put the current provider readings on the tray.
///
/// The window sends one normalized percentage per provider. Rust derives the
/// worst headroom, pressure icon, tooltip and native menu from that bounded
/// input, so every shell surface moves together.
#[tauri::command]
fn set_tray_status(app: AppHandle, providers: Vec<tray::ProviderStatus>) -> Result<(), String> {
    tray::update(&app, providers)
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(connections::ConnectionsStore::at_state_directory())
        .manage(credentials::KeyringStore)
        .manage(std::sync::Arc::new(
            cache_write::CacheWriter::at_state_directory(),
        ))
        .manage(net::ReqwestTransport::new())
        .manage(provider_detection::DetectionStore::scan())
        .manage(claude_oauth::ClaudeOauthRuntime::default())
        .manage(codex_oauth::CodexOauthRuntime::default())
        .manage(antigravity_oauth::AntigravityOauthRuntime::default())
        .manage(gemini_cli_oauth::GeminiCliOauthRuntime::default())
        .manage(collector_runtime::CollectorRuntime::default())
        .manage(updates::PendingUpdate::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            read_cache,
            read_manual,
            state_directory,
            set_tray_status,
            commands::connect_provider,
            commands::test_provider,
            commands::refresh_provider,
            commands::collector_status,
            commands::disconnect_provider,
            commands::list_connections,
            commands::update_connection,
            commands::detect_local_tools,
            commands::list_detected_providers,
            commands::rescan_detected_providers,
            commands::refresh_detected_claude,
            commands::claude_connect_preflight,
            pro::pro_status,
            pro::pro_set_session,
            pro::pro_refresh,
            pro::pro_service,
            pro::pro_sync_agent_context,
            pro::pro_sync_hosted,
            pro::pro_disconnect,
            updates::check_for_update,
            updates::install_update
        ])
        .setup(|app| {
            /* The full collector outlives every window. Its schedule, reads,
            parsing and cache commits never depend on a webview receiving an
            event or being allowed to run a timer. */
            collector_runtime::spawn_collector(app.handle().clone());
            pro::spawn_silent_refresh();
            let initial = tray::view(Vec::new()).expect("an empty tray view is valid");
            let menu = tray::menu(app.handle(), &initial)?;
            let icon = tray::icon(&initial)?;

            TrayIconBuilder::with_id(tray::ID)
                .icon(icon)
                .icon_as_template(false)
                .menu(&menu)
                .tooltip("OpenLimiter")
                /* The left click opens the window. Only the right click opens
                the menu, which is what a tray icon does on Windows. */
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "refresh" => {
                        collector_runtime::refresh_all(app.clone());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            /* Closing the window hides it instead of ending the process. The
            native collector and tray continue independently. Quit is on the
            menu. */
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("OpenLimiter could not start");
}
