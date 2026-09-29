#[cfg(not(windows))]
use super::placement::Monitor;
use super::{
    placement::{self, Edge, Rect},
    RailState,
};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Default)]
struct Applied {
    rail: Option<(Rect, bool)>,
    card: Option<(Rect, bool)>,
    escape_down: bool,
}

pub fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app
        .state::<RailState>()
        .running
        .swap(true, Ordering::Relaxed)
    {
        return Ok(());
    }
    let result = create_windows(app);
    if let Err(error) = result {
        for label in ["rail-card", "rail"] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.destroy();
            }
        }
        app.state::<RailState>()
            .running
            .store(false, Ordering::Relaxed);
        return Err(error);
    }
    app.state::<RailState>()
        .inner
        .lock()
        .map_err(|_| "Rail state unavailable")?
        .available = true;
    let handle = app.clone();
    // Serialized work on the UI thread. At most one tick may be queued. Monitor
    // enumeration every second also repairs placement on resume, hotplug and DPI
    // changes even when the platform misses a window event while asleep.
    std::thread::spawn(move || {
        let applied = std::sync::Arc::new(std::sync::Mutex::new(Applied::default()));
        let mut last_monitors = Instant::now() - Duration::from_secs(2);
        let mut last_topmost = Instant::now() - Duration::from_secs(4);
        while handle.state::<RailState>().running.load(Ordering::Relaxed) {
            let now = Instant::now();
            let refresh = now.duration_since(last_monitors) >= Duration::from_secs(1);
            let reassert = now.duration_since(last_topmost) >= Duration::from_secs(3);
            if refresh {
                last_monitors = now;
            }
            if reassert {
                last_topmost = now;
            }
            let app = handle.clone();
            let previous = applied.clone();
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            if handle
                .run_on_main_thread(move || {
                    if let Ok(mut applied) = previous.lock() {
                        if let Err(error) = tick(&app, &mut applied, refresh, reassert) {
                            eprintln!("Rail update: {error}");
                        }
                    }
                    let _ = sender.send(());
                })
                .is_err()
            {
                break;
            }
            // Do not abandon the worker during sleep; timeouts just check exit.
            loop {
                match receiver.recv_timeout(Duration::from_secs(1)) {
                    Ok(()) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(_) if !handle.state::<RailState>().running.load(Ordering::Relaxed) => {
                        return
                    }
                    Err(_) => {}
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    Ok(())
}

fn create_windows<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    for (label, url, width, height) in [
        ("rail", "rail.html", 20.0, placement::LENGTH),
        ("rail-card", "rail.html?card", 320.0, 240.0),
    ] {
        let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title("OpenLimiter Rail")
            .inner_size(width, height)
            .visible(false)
            .focused(false)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true);
        // macOS offers transparency only behind Tauri's private API feature;
        // the plan ships an opaque, token styled surface there first.
        #[cfg(not(target_os = "macos"))]
        let builder = builder.transparent(cfg!(windows));
        let window = builder
            .shadow(false)
            .on_navigation(|url| {
                matches!(url.scheme(), "tauri" | "http" | "https")
                    && matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
            })
            .build()
            .map_err(|e| e.to_string())?;
        #[cfg(windows)]
        super::windows::configure(hwnd(&window)?);
        // Closing a native surface is a hide, not destruction of the plugin.
        let app = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if label == "rail" {
                    let _ = super::set_visible(&app, false);
                } else if let Ok(mut inner) = app.state::<RailState>().inner.lock() {
                    inner.behavior.close_card();
                }
            }
        });
    }
    Ok(())
}

#[cfg(windows)]
fn hwnd<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<windows_sys::Win32::Foundation::HWND, String> {
    window.hwnd().map(|h| h.0 as _).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn preview_monitors<R: Runtime>(app: &AppHandle<R>) -> Vec<Monitor> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let bounds = Rect {
                x: m.position().x,
                y: m.position().y,
                width: m.size().width as i32,
                height: m.size().height as i32,
            };
            Monitor {
                id: m
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("{},{}", bounds.x, bounds.y)),
                bounds,
                work: bounds,
                scale: m.scale_factor(),
                primary: primary.as_ref() == Some(m.position()),
            }
        })
        .collect()
}

fn tick<R: Runtime>(
    app: &AppHandle<R>,
    applied: &mut Applied,
    refresh: bool,
    reassert: bool,
) -> Result<(), String> {
    let rail = app
        .get_webview_window("rail")
        .ok_or("Rail window missing")?;
    let card = app
        .get_webview_window("rail-card")
        .ok_or("Rail card window missing")?;
    let state = app.state::<RailState>();
    let mut inner = state.inner.lock().map_err(|_| "Rail state unavailable")?;
    if refresh {
        #[cfg(windows)]
        {
            inner.monitors = super::windows::monitors();
        }
        #[cfg(not(windows))]
        {
            inner.monitors = preview_monitors(app);
        }
    }
    let Some(monitor) = placement::select(&inner.monitors, &inner.preferences.monitor_id).cloned()
    else {
        apply(&rail, Rect::default(), false)?;
        apply(&card, Rect::default(), false)?;
        applied.rail = None;
        applied.card = None;
        return Ok(());
    };
    // Top/bottom geometry is tested but secondary edges remain disabled in this unit.
    let edge = Edge::Left;
    inner.preferences.edge = edge;
    let p = inner.preferences.clone();
    let old_rail = placement::place(
        &monitor,
        edge,
        p.offset(&monitor.id),
        inner.behavior.unfolded,
    );
    let old_card = inner
        .behavior
        .card_anchor
        .map(|a| placement::card(&monitor, edge, old_rail, a));
    #[cfg(windows)]
    let (pointer, fullscreen, escape) = (
        super::windows::cursor(),
        placement::covers_monitor(
            super::windows::foreground(&[hwnd(&rail)?, hwnd(&card)?]),
            monitor.bounds,
        ),
        super::windows::escape_down(),
    );
    #[cfg(not(windows))]
    let (pointer, fullscreen, escape) = (
        rail.cursor_position()
            .ok()
            .map(|p| (p.x as i32, p.y as i32)),
        false,
        false,
    );
    let inside = pointer.is_some_and(|(x, y)| {
        old_rail.contains(x, y) || old_card.is_some_and(|r| r.contains(x, y))
    });
    if escape && !applied.escape_down {
        inner.behavior.close_card();
    }
    applied.escape_down = escape;
    inner
        .behavior
        .tick(Instant::now(), inside, fullscreen, p.visible, p.keep_open);
    let bounds = placement::place(
        &monitor,
        edge,
        p.offset(&monitor.id),
        inner.behavior.unfolded,
    );
    let visible = p.visible && !fullscreen;
    let card_bounds = placement::card(
        &monitor,
        edge,
        bounds,
        inner.behavior.card_anchor.unwrap_or_default(),
    );
    let card_visible = visible && inner.behavior.card_anchor.is_some();
    drop(inner);
    if reassert || applied.rail != Some((bounds, visible)) {
        apply(&rail, bounds, visible)?;
        applied.rail = Some((bounds, visible));
    }
    if reassert || applied.card != Some((card_bounds, card_visible)) {
        apply(&card, card_bounds, card_visible)?;
        applied.card = Some((card_bounds, card_visible));
    }
    Ok(())
}

fn apply<R: Runtime>(window: &WebviewWindow<R>, bounds: Rect, visible: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        super::windows::apply(hwnd(window)?, bounds, visible)
    }
    #[cfg(not(windows))]
    {
        if !visible {
            return window.hide().map_err(|e| e.to_string());
        }
        window
            .set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::PhysicalSize::new(
                bounds.width as u32,
                bounds.height as u32,
            ))
            .map_err(|e| e.to_string())?;
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())
    }
}
