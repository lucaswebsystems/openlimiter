//! Rail lane. UI invocation: `plugin:rail|rail_snapshot`.
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[path = "rail/behavior.rs"]
mod behavior;
#[path = "rail/persistence.rs"]
mod persistence;
#[path = "rail/placement.rs"]
mod placement;
#[path = "rail/runtime.rs"]
mod runtime;
#[path = "rail/snapshot.rs"]
mod snapshot;
#[cfg(windows)]
#[path = "rail/windows.rs"]
mod windows;

struct RailState {
    inner: Mutex<Inner>,
    running: AtomicBool,
    snapshot_state_root: Mutex<Option<PathBuf>>,
}

struct Inner {
    preferences: persistence::Preferences,
    behavior: behavior::Behavior,
    path: Option<PathBuf>,
    monitors: Vec<placement::Monitor>,
    available: bool,
}

impl Inner {
    fn persist(&mut self, next: persistence::Preferences) -> Result<(), String> {
        next.validate().map_err(|e| e.to_string())?;
        if let Some(path) = &self.path {
            persistence::save(path, &next).map_err(|e| e.to_string())?;
        }
        self.preferences = next;
        Ok(())
    }
}

struct RailMenu<R: Runtime>(Mutex<Option<tauri::menu::MenuItem<R>>>);

const SNAPSHOT_CACHE_FILE_NAME: &str = "openlimiter-cache.json";

fn read_snapshot_cache(state: &RailState) -> Option<String> {
    let root = state.snapshot_state_root.lock().ok()?.clone();
    match root {
        Some(path) => crate::fsx::bounded_read(&path.join(SNAPSHOT_CACHE_FILE_NAME)),
        None => {
            #[cfg(test)]
            {
                None
            }
            #[cfg(not(test))]
            {
                crate::state::read_cache()
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn set_test_snapshot_root<R: Runtime>(app: &tauri::AppHandle<R>, root: PathBuf) {
    *app.state::<RailState>()
        .snapshot_state_root
        .lock()
        .expect("Rail snapshot root is not poisoned") = Some(root);
}

/// Explicit opt in for unverified macOS/Linux builds without changing Cargo features.
fn enabled() -> bool {
    cfg!(windows) || std::env::var_os("OPENLIMITER_RAIL_PREVIEW").is_some_and(|value| value == "1")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    available: bool,
    preview: bool,
    visible: bool,
    keep_open: bool,
    unfolded: bool,
    suppressed: bool,
    card_open: bool,
    card_anchor: Option<f64>,
    monitor_id: String,
    offset: f64,
    edge: placement::Edge,
}

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
    pub observed_at: Option<String>,
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
    pub sessions: Option<Vec<snapshot::SessionDisplay>>,
    pub window: WindowSnapshot,
}

#[tauri::command]
fn rail_snapshot<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, RailState>,
) -> Result<RailSnapshot, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let sessions =
        crate::activity::display_sessions(&app).map(|records| snapshot::sessions(records, now));
    let accounts = snapshot::accounts(
        crate::native_snapshot::display_snapshots(read_snapshot_cache(&state).as_deref()),
        now,
    );
    let inner = state.inner.lock().map_err(|_| "Rail state unavailable")?;
    let p = &inner.preferences;
    let id = placement::select(&inner.monitors, &p.monitor_id)
        .map(|m| m.id.as_str())
        .unwrap_or(&p.monitor_id);
    Ok(RailSnapshot {
        accounts,
        sessions,
        window: WindowSnapshot {
            available: inner.available,
            preview: !cfg!(windows),
            visible: p.visible,
            keep_open: p.keep_open,
            unfolded: inner.behavior.unfolded,
            suppressed: inner.behavior.suppressed,
            card_open: inner.behavior.card_anchor.is_some(),
            card_anchor: inner.behavior.card_anchor,
            monitor_id: id.into(),
            offset: p.offset(id),
            edge: p.edge,
        },
    })
}

fn set_visible<R: Runtime>(app: &tauri::AppHandle<R>, visible: bool) -> Result<(), String> {
    let state = app.state::<RailState>();
    let mut inner = state.inner.lock().map_err(|_| "Rail state unavailable")?;
    let mut next = inner.preferences.clone();
    next.visible = visible;
    inner.persist(next)?;
    if !visible {
        inner.behavior = behavior::Behavior::default();
    }
    drop(inner);
    update_menu(app, visible);
    Ok(())
}

#[tauri::command]
fn rail_set_visible<R: Runtime>(app: tauri::AppHandle<R>, visible: bool) -> Result<(), String> {
    set_visible(&app, visible)
}

#[tauri::command]
fn rail_set_keep_open(state: tauri::State<'_, RailState>, keep_open: bool) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "Rail state unavailable")?;
    let mut next = inner.preferences.clone();
    next.keep_open = keep_open;
    inner.persist(next)
}

#[tauri::command]
fn rail_move_offset(
    state: tauri::State<'_, RailState>,
    offset: f64,
    monitor_id: Option<String>,
) -> Result<(), String> {
    if !offset.is_finite() || !(0.0..=100000.0).contains(&offset) {
        return Err("invalid Rail offset".into());
    }
    let mut inner = state.inner.lock().map_err(|_| "Rail state unavailable")?;
    let id = monitor_id
        .as_deref()
        .unwrap_or(&inner.preferences.monitor_id);
    if monitor_id.is_some() && !inner.monitors.iter().any(|m| m.id == id) {
        return Err("Rail monitor is not connected".into());
    }
    let monitor = placement::select(&inner.monitors, id).ok_or("no Rail display available")?;
    let mut next = inner.preferences.clone();
    next.monitor_id = monitor.id.clone();
    // Store the actual clamped logical position, retaining other monitors' offsets.
    let r = placement::place(monitor, next.edge, offset, inner.behavior.unfolded);
    let actual = match next.edge {
        placement::Edge::Left => r.y - monitor.work.y,
        _ => r.x - monitor.work.x,
    };
    next.offsets
        .insert(monitor.id.clone(), actual as f64 / monitor.scale);
    inner.persist(next)
}

#[tauri::command]
fn rail_card_open(state: tauri::State<'_, RailState>, anchor: f64) -> Result<(), String> {
    if !anchor.is_finite() || !(0.0..=placement::LENGTH).contains(&anchor) {
        return Err("invalid Rail card anchor".into());
    }
    let mut inner = state.inner.lock().map_err(|_| "Rail state unavailable")?;
    if !inner.preferences.visible || inner.behavior.suppressed {
        return Err("Rail is hidden".into());
    }
    inner.behavior.card_anchor = Some(anchor);
    inner.behavior.unfolded = true;
    Ok(())
}

#[tauri::command]
fn rail_card_close(state: tauri::State<'_, RailState>) -> Result<(), String> {
    state
        .inner
        .lock()
        .map_err(|_| "Rail state unavailable")?
        .behavior
        .close_card();
    Ok(())
}

pub fn visibility_menu_item<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let visible = app
        .state::<RailState>()
        .inner
        .lock()
        .map(|s| s.preferences.visible)
        .unwrap_or(false);
    let item = tauri::menu::MenuItem::with_id(
        app,
        "rail-toggle",
        if visible { "Hide Rail" } else { "Show Rail" },
        enabled(),
        None::<&str>,
    )?;
    if let Ok(mut slot) = app.state::<RailMenu<R>>().0.lock() {
        *slot = Some(item.clone());
    }
    Ok(item)
}

fn update_menu<R: Runtime>(app: &tauri::AppHandle<R>, visible: bool) {
    if let Ok(slot) = app.state::<RailMenu<R>>().0.lock() {
        if let Some(item) = slot.as_ref() {
            let _ = item.set_text(if visible { "Hide Rail" } else { "Show Rail" });
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("rail")
        .setup(|app, _| {
            #[cfg(not(test))]
            let path = app
                .path()
                .app_config_dir()
                .ok()
                .map(|p| p.join("rail.json"));
            #[cfg(test)]
            let path: Option<PathBuf> = None;
            let preferences = path
                .as_deref()
                .and_then(|p| persistence::load(p).ok())
                .unwrap_or_default();
            app.manage(RailState {
                inner: Mutex::new(Inner {
                    preferences,
                    behavior: behavior::Behavior::default(),
                    path,
                    monitors: Vec::new(),
                    available: false,
                }),
                running: AtomicBool::new(false),
                snapshot_state_root: Mutex::new(None),
            });
            app.manage(RailMenu::<R>(Mutex::new(None)));
            Ok(())
        })
        .on_event(|app, event| match event {
            tauri::RunEvent::Ready if enabled() => {
                let app = app.clone();
                // Plugin dispatch holds Tauri's plugin lock; window creation needs it too.
                std::thread::spawn(move || {
                    if let Err(error) = runtime::start(&app) {
                        eprintln!("Rail unavailable: {error}");
                    }
                });
            }
            tauri::RunEvent::Exit => {
                app.state::<RailState>()
                    .running
                    .store(false, Ordering::Relaxed);
            }
            tauri::RunEvent::MenuEvent(event) if event.id().as_ref() == "rail-toggle" => {
                let app = app.clone();
                // Menu updates and window operations must run outside plugin dispatch.
                std::thread::spawn(move || {
                    let visible = app
                        .state::<RailState>()
                        .inner
                        .lock()
                        .map(|s| s.preferences.visible)
                        .unwrap_or(false);
                    if let Err(error) = set_visible(&app, !visible) {
                        eprintln!("Rail visibility: {error}");
                        return;
                    }
                    // An explicit tray selection is the sole keyboard activation path.
                    // Hover, resume, settings visibility and periodic topmost never focus.
                    if !visible {
                        if let Ok(mut inner) = app.state::<RailState>().inner.lock() {
                            inner.behavior.keyboard = true;
                        }
                        if let Some(window) = app.get_webview_window("rail") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            rail_snapshot,
            rail_set_visible,
            rail_set_keep_open,
            rail_move_offset,
            rail_card_open,
            rail_card_close
        ])
        .build()
}
