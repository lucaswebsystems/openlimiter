mod state;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// OpenLimiter for the desktop.
///
/// A window and a tray icon around the engine that already exists. Rust does
/// the three things only Rust can do here: find the state directory, read the
/// cache file, and talk to the operating system's tray. Every rule about what
/// the numbers mean stays in the TypeScript engine that the command line tool
/// and the web application both use, so there is exactly one implementation of
/// freshness, validation and advice in the whole project.
///
/// It reads. It never writes to the state directory, never touches a provider
/// credential, and never opens a socket.
/// The identifier the tray is registered under, so a command can find it again.
const TRAY_ID: &str = "openlimiter-tray";

/// The event the webview listens for when the tray asks for a refresh.
const REFRESH_EVENT: &str = "openlimiter://refresh";

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

/// Put the current pressure on the tray.
///
/// The webview works out what the highest pressure provider is, using the same
/// advice engine as the statusline, and hands the finished line here. On macOS
/// it also becomes the text beside the menu bar icon.
#[tauri::command]
fn set_tray_status(app: AppHandle, tooltip: String, title: String) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_tooltip(Some(tooltip)).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    tray.set_title(Some(title)).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = title;
    Ok(())
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
        .invoke_handler(tauri::generate_handler![
            read_cache,
            read_manual,
            state_directory,
            set_tray_status
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &quit])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(
                    app.default_window_icon()
                        .expect("the bundle always carries a window icon")
                        .clone(),
                )
                .menu(&menu)
                .tooltip("OpenLimiter")
                /* The left click opens the window. Only the right click opens
                the menu, which is what a tray icon does on Windows. */
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "refresh" => {
                        let _ = app.emit(REFRESH_EVENT, ());
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
            webview stays alive, which is what keeps the tray reading current
            while the application sits behind the clock. Quit is on the menu. */
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("OpenLimiter could not start");
}
