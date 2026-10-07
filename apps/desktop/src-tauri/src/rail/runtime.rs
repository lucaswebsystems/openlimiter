use super::{
    placement::{self, Edge, Rect},
    RailState,
};
use std::{
    sync::{
        atomic::Ordering,
        mpsc::{Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Sent to the panel whenever it is shown or hidden, with that state.
pub const PANEL_SHOWN_EVENT: &str = "edge-panel-shown";

#[derive(Default)]
struct Applied {
    rail: Option<(Rect, bool)>,
    card: Option<(Rect, bool)>,
    escape_down: bool,
}

pub fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let _ = send.send(linux::supported());
        })
        .map_err(|e| e.to_string())?;
        if !receive.recv().map_err(|e| e.to_string())? {
            // No edge surfaces on Wayland, even when DISPLAY is also present.
            return Ok(());
        }
    }
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
    let (wake_tx, wake_rx) = std::sync::mpsc::sync_channel(1);
    if let Ok(mut waker) = handle.state::<RailState>().waker.lock() {
        *waker = Some(wake_tx);
    }
    std::thread::spawn(move || {
        let applied = std::sync::Arc::new(std::sync::Mutex::new(Applied::default()));
        let running = || handle.state::<RailState>().running.load(Ordering::Relaxed);
        let main_thread_tick = |refresh: bool, reassert: bool| {
            if !running() {
                return None;
            }
            let app = handle.clone();
            let previous = applied.clone();
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            handle
                .run_on_main_thread(move || {
                    let mut is_visible = false;
                    if let Ok(mut applied) = previous.lock() {
                        match tick(&app, &mut applied, refresh, reassert) {
                            Ok(v) => is_visible = v,
                            Err(error) => eprintln!("Rail update: {error}"),
                        }
                    }
                    let _ = sender.send(is_visible);
                })
                .ok()?;
            // Do not abandon the worker during sleep; timeouts just check exit.
            loop {
                match receiver.recv_timeout(Duration::from_secs(1)) {
                    Ok(shown) => return Some(shown),
                    Err(RecvTimeoutError::Disconnected) => return None,
                    Err(_) if !running() => return None,
                    Err(_) => {}
                }
            }
        };
        run(main_thread_tick, &wake_rx, || look(&handle));
    });
    Ok(())
}

/// The worker's loop, apart from the windows it drives: `tick(refresh,
/// reassert)` runs one tick and says whether the tab is shown, or `None` once
/// the runtime stopped. Shown, the tab ticks every 100 ms for the pointer.
/// Hidden, it ticks once a second, and in between only a wake brings the next
/// tick forward: the tab switched on, or a change the worker observes (a
/// fullscreen window gone, the monitors changed). Any early tick enumerates
/// the monitors again, so it never places the tab with the old layout.
fn run(
    mut tick: impl FnMut(bool, bool) -> Option<bool>,
    wake: &Receiver<()>,
    mut look: impl FnMut() -> Option<Look>,
) {
    let mut last_monitors: Option<Instant> = None;
    let mut last_topmost: Option<Instant> = None;
    let mut changed = false;
    loop {
        let now = Instant::now();
        let due = |last: Option<Instant>, every: Duration| {
            last.is_none_or(|at| now.duration_since(at) >= every)
        };
        let refresh = changed || due(last_monitors, Duration::from_secs(1));
        let reassert = due(last_topmost, Duration::from_secs(3));
        if refresh {
            last_monitors = Some(now);
        }
        if reassert {
            last_topmost = Some(now);
        }
        let Some(shown) = tick(refresh, reassert) else {
            return;
        };
        changed = if shown {
            woken(wake, Duration::from_millis(100));
            false
        } else {
            wait_hidden(wake, &mut look)
        };
    }
}

/// A hidden tab's second, ended early by a wake or by a change the worker
/// observes; true when it ended early.
fn wait_hidden(wake: &Receiver<()>, look: &mut impl FnMut() -> Option<Look>) -> bool {
    let deadline = Instant::now() + Duration::from_secs(1);
    let seen = look();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        if woken(wake, left.min(Duration::from_millis(100)))
            || seen
                .as_ref()
                .zip(look())
                .is_some_and(|(before, now)| wakes(before, &now))
        {
            return true;
        }
    }
    false
}

/// Whether a wake arrived within `limit`. A closed channel waits the whole
/// limit, so the loop never spins.
fn woken(wake: &Receiver<()>, limit: Duration) -> bool {
    match wake.recv_timeout(limit) {
        Ok(()) => true,
        Err(RecvTimeoutError::Timeout) => false,
        Err(RecvTimeoutError::Disconnected) => {
            std::thread::sleep(limit);
            false
        }
    }
}

/// What the worker observes between ticks: whether a window of another
/// process covers the tab's monitor, and the monitor layout.
struct Look {
    fullscreen: bool,
    monitors: Vec<placement::Monitor>,
}

/// Windows answers both off the main thread.
#[cfg(windows)]
fn look<R: Runtime>(_app: &AppHandle<R>) -> Option<Look> {
    let monitors = super::windows::monitors();
    let fullscreen = placement::select(&monitors, "").is_some_and(|monitor| {
        placement::covers_monitor(super::windows::foreign_foreground(), monitor.bounds)
    });
    Some(Look {
        fullscreen,
        monitors,
    })
}

/// Elsewhere the monitors and the foreground window are read on the main
/// thread, so the worker asks it for exactly that and nothing more.
#[cfg(not(windows))]
fn look<R: Runtime>(app: &AppHandle<R>) -> Option<Look> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = send.send(main_thread_look());
    })
    .ok()?;
    receive.recv_timeout(Duration::from_secs(1)).ok().flatten()
}

#[cfg(target_os = "macos")]
fn main_thread_look() -> Option<Look> {
    let monitors = macos::monitors();
    let fullscreen =
        placement::select(&monitors, "").is_some_and(|monitor| macos::observe(monitor).1);
    Some(Look {
        fullscreen,
        monitors,
    })
}

#[cfg(target_os = "linux")]
fn main_thread_look() -> Option<Look> {
    let monitors = linux::monitors();
    let fullscreen =
        placement::select(&monitors, "").is_some_and(|monitor| linux::observe(monitor).1);
    Some(Look {
        fullscreen,
        monitors,
    })
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn main_thread_look() -> Option<Look> {
    None
}

/// A change the hidden tab answers at once rather than at its next tick.
fn wakes(before: &Look, now: &Look) -> bool {
    (before.fullscreen && !now.fullscreen) || before.monitors != now.monitors
}

fn create_windows<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    for (label, url, width, height) in [
        (
            "rail",
            "edge-tab.html",
            placement::TAB_WIDTH,
            placement::LENGTH,
        ),
        (
            "rail-card",
            "edge-panel.html",
            placement::PANEL_WIDTH,
            placement::PANEL_HEIGHT,
        ),
    ] {
        let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title("OpenLimiter")
            .inner_size(width, height)
            .visible(false)
            .focused(false)
            .focusable(false)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true);
        // macOS webview transparency requires a Tauri feature not enabled by
        // this crate. GTK selects an RGBA visual where compositing is supported.
        #[cfg(not(target_os = "macos"))]
        let builder = builder.transparent(true);
        let window = builder
            .shadow(false)
            .on_navigation(|url| {
                matches!(url.scheme(), "tauri" | "http" | "https")
                    && matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
            })
            .build()
            .map_err(|e| e.to_string())?;
        #[cfg(windows)]
        super::windows::configure(hwnd(&window)?)?;
        #[cfg(target_os = "macos")]
        {
            let native = window.ns_window().map_err(|e| e.to_string())? as usize;
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            app.run_on_main_thread(move || {
                let _ = send.send(macos::configure(label, native));
            })
            .map_err(|e| e.to_string())?;
            receive.recv().map_err(|e| e.to_string())??;
        }
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

fn tick<R: Runtime>(
    app: &AppHandle<R>,
    applied: &mut Applied,
    refresh: bool,
    reassert: bool,
) -> Result<bool, String> {
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
        #[cfg(target_os = "macos")]
        {
            inner.monitors = macos::monitors();
        }
        #[cfg(target_os = "linux")]
        {
            inner.monitors = linux::monitors();
        }
    }
    let Some(monitor) = placement::select(&inner.monitors, &inner.preferences.monitor_id).cloned()
    else {
        drop(inner);
        apply(&rail, Rect::default(), false)?;
        apply(&card, Rect::default(), false)?;
        applied.rail = None;
        announce(app, applied.card.take().map(|(_, shown)| shown), false);
        return Ok(false);
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
    let height = inner.card_height;
    let old_card = inner
        .behavior
        .card_anchor
        .map(|a| placement::card(&monitor, edge, old_rail, a, height));
    #[cfg(windows)]
    let (pointer, fullscreen, escape) = (
        super::windows::cursor(),
        placement::covers_monitor(
            super::windows::foreground(&[hwnd(&rail)?, hwnd(&card)?]),
            monitor.bounds,
        ),
        super::windows::escape_down(),
    );
    #[cfg(target_os = "macos")]
    let (pointer, fullscreen, escape) = macos::observe(&monitor);
    #[cfg(target_os = "linux")]
    let (pointer, fullscreen, escape) = linux::observe(&monitor);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let (pointer, fullscreen, escape) = (None::<(i32, i32)>, false, false);
    let inside = pointer.is_some_and(|(x, y)| placement::inside(old_rail, old_card, x, y));
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
        height,
    );
    let card_visible = visible && inner.behavior.card_anchor.is_some();
    drop(inner);
    if reassert || applied.rail != Some((bounds, visible)) {
        apply(&rail, bounds, visible)?;
        applied.rail = Some((bounds, visible));
    }
    let was_shown = applied.card.map(|(_, shown)| shown);
    if reassert || applied.card != Some((card_bounds, card_visible)) {
        apply(&card, card_bounds, card_visible)?;
        applied.card = Some((card_bounds, card_visible));
    }
    announce(app, was_shown, card_visible);
    Ok(visible)
}

/// Tell the panel it was shown or hidden, only when that changed. Called on
/// the main thread after the lock is released; it creates nothing.
fn announce<R: Runtime>(app: &AppHandle<R>, before: Option<bool>, shown: bool) {
    if before.unwrap_or(false) != shown {
        let _ = app.emit_to(EventTarget::webview_window("rail-card"), PANEL_SHOWN_EVENT, shown);
    }
}

fn apply<R: Runtime>(window: &WebviewWindow<R>, bounds: Rect, visible: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        super::windows::apply(hwnd(window)?, bounds, visible)
    }
    #[cfg(target_os = "macos")]
    {
        macos::apply(window.label(), bounds, visible)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
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

#[cfg(target_os = "macos")]
mod macos {
    use super::super::placement::{covers_monitor, Monitor, Rect};
    use objc2::{class, define_class, msg_send, rc::Retained, runtime::AnyObject, MainThreadOnly};
    use objc2_app_kit::{
        NSEvent, NSPanel, NSScreen, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use objc2_foundation::{ns_string, MainThreadMarker, NSArray, NSPoint, NSRect, NSSize};
    use std::{cell::RefCell, collections::BTreeMap};

    define_class!(
        // Own a real NSPanel, initialized as nonactivating. Changing the class
        // or style of Tao's already initialized NSWindow leaves activation tags stale.
        #[unsafe(super = NSPanel)]
        #[thread_kind = MainThreadOnly]
        struct EdgePanel;
        impl EdgePanel {
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key(&self) -> bool { false }
            #[unsafe(method(canBecomeMainWindow))]
            fn can_become_main(&self) -> bool { false }
        }
    );

    thread_local! {
        static PANELS: RefCell<BTreeMap<String, Retained<EdgePanel>>> = RefCell::new(BTreeMap::new());
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> *mut NSArray<AnyObject>;
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    }

    pub fn configure(label: &str, native: usize) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("Edge panel requires the main thread")?;
        // The hidden Tauri window retains its delegate and webview lifecycle;
        // only its content view is hosted in our independently retained panel.
        let source = unsafe { &*(native as *const NSWindow) };
        let content = source.contentView().ok_or("Edge content view missing")?;
        let panel: Retained<EdgePanel> = unsafe {
            msg_send![EdgePanel::alloc(mtm),
            initWithContentRect: source.frame(),
            styleMask: NSWindowStyleMask::NonactivatingPanel,
            backing: objc2_app_kit::NSBackingStoreType::Buffered,
            defer: false]
        };
        panel.setBecomesKeyOnlyIfNeeded(true);
        panel.setHidesOnDeactivate(false);
        panel.setLevel(3);
        panel.setHasShadow(false);
        panel.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces);
        unsafe {
            panel.setReleasedWhenClosed(false);
        }
        source.setContentView(None);
        panel.setContentView(Some(&content));
        PANELS.with(|panels| panels.borrow_mut().insert(label.into(), panel));
        Ok(())
    }

    // AppKit coordinates are points with a bottom origin. Convert each screen
    // into physical coordinates and use that screen's scale for the inverse.
    fn physical(rect: NSRect, desktop_top: f64, scale: f64) -> Rect {
        Rect {
            x: (rect.origin.x * scale).round() as i32,
            y: ((desktop_top - rect.origin.y - rect.size.height) * scale).round() as i32,
            width: (rect.size.width * scale).round() as i32,
            height: (rect.size.height * scale).round() as i32,
        }
    }

    pub fn monitors() -> Vec<Monitor> {
        let Some(mtm) = MainThreadMarker::new() else {
            return vec![];
        };
        let screens = NSScreen::screens(mtm);
        let Some(primary) = screens.firstObject() else {
            return vec![];
        };
        let top = primary.frame().origin.y + primary.frame().size.height;
        screens
            .iter()
            .enumerate()
            .map(|(index, screen)| {
                let scale = screen.backingScaleFactor();
                Monitor {
                    id: format!("screen-{index}"),
                    bounds: physical(screen.frame(), top, scale),
                    work: physical(screen.visibleFrame(), top, scale),
                    scale,
                    primary: index == 0,
                }
            })
            .collect()
    }

    pub fn apply(label: &str, bounds: Rect, visible: bool) -> Result<(), String> {
        let monitor = monitors()
            .into_iter()
            .find(|m| m.primary)
            .ok_or("No primary display")?;
        PANELS.with(|panels| {
            let panels = panels.borrow();
            let panel = panels.get(label).ok_or("Edge panel missing")?;
            if !visible {
                panel.orderOut(None);
                return Ok(());
            }
            let s = monitor.scale;
            panel.setFrame_display(
                NSRect::new(
                    NSPoint::new(
                        bounds.x as f64 / s,
                        (monitor.bounds.height - bounds.y - bounds.height) as f64 / s,
                    ),
                    NSSize::new(bounds.width as f64 / s, bounds.height as f64 / s),
                ),
                true,
            );
            panel.orderFrontRegardless();
            Ok(())
        })
    }

    pub fn observe(monitor: &Monitor) -> (Option<(i32, i32)>, bool, bool) {
        let point = NSEvent::mouseLocation();
        let pointer = Some((
            (point.x * monitor.scale).round() as i32,
            monitor.bounds.height - (point.y * monitor.scale).round() as i32,
        ));
        (pointer, fullscreen(monitor), unsafe {
            CGEventSourceKeyState(1, 53)
        })
    }

    fn fullscreen(monitor: &Monitor) -> bool {
        // Window metadata only, no screen capture or Accessibility permission.
        // If macOS withholds metadata, leave suppression unavailable.
        unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let front: *mut AnyObject = msg_send![workspace, frontmostApplication];
            if front.is_null() {
                return false;
            }
            let pid: i32 = msg_send![front, processIdentifier];
            if pid == std::process::id() as i32 {
                return false;
            }
            let Some(windows) = Retained::from_raw(CGWindowListCopyWindowInfo(1 | 16, 0)) else {
                return false;
            };
            for window in windows.iter() {
                let owner: *mut AnyObject =
                    msg_send![&*window, objectForKey: ns_string!("kCGWindowOwnerPID")];
                let layer: *mut AnyObject =
                    msg_send![&*window, objectForKey: ns_string!("kCGWindowLayer")];
                if owner.is_null() || layer.is_null() {
                    continue;
                }
                let owner: i32 = msg_send![owner, intValue];
                let layer: i32 = msg_send![layer, intValue];
                if owner != pid || layer != 0 {
                    continue;
                }
                let bounds: *mut AnyObject =
                    msg_send![&*window, objectForKey: ns_string!("kCGWindowBounds")];
                if bounds.is_null() {
                    continue;
                }
                let mut values = [0.0; 4];
                for (i, key) in [
                    ns_string!("X"),
                    ns_string!("Y"),
                    ns_string!("Width"),
                    ns_string!("Height"),
                ]
                .iter()
                .enumerate()
                {
                    let number: *mut AnyObject = msg_send![bounds, objectForKey: *key];
                    if !number.is_null() {
                        values[i] = msg_send![number, doubleValue];
                    }
                }
                let [x, y, width, height] = values.map(|v| (v * monitor.scale).round() as i32);
                if covers_monitor(
                    Some(Rect {
                        x,
                        y,
                        width,
                        height,
                    }),
                    monitor.bounds,
                ) {
                    return true;
                }
            }
            false
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn panel_style_and_coordinate_conversion() {
            assert_eq!(NSWindowStyleMask::NonactivatingPanel.0, 1 << 7);
            let rect = physical(
                NSRect::new(NSPoint::new(-100.0, 20.0), NSSize::new(100.0, 80.0)),
                100.0,
                2.0,
            );
            assert_eq!(
                rect,
                Rect {
                    x: -200,
                    y: 0,
                    width: 200,
                    height: 160
                }
            );
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::super::placement::{Monitor, Rect};
    use std::{
        ffi::{c_char, c_int, c_long, c_uchar, c_ulong, c_void},
        ptr,
    };

    #[repr(C)]
    #[derive(Default)]
    struct GdkRect {
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
    }

    // Use the GTK backend actually opened by Tao, never environment guesses.
    // These libraries already belong to the Tauri GTK runtime.
    #[link(name = "gdk-3")]
    extern "C" {
        fn gdk_display_get_default() -> *mut c_void;
        fn gdk_x11_display_get_type() -> usize;
        fn gdk_x11_display_get_xdisplay(display: *mut c_void) -> *mut c_void;
        fn gdk_display_get_n_monitors(display: *mut c_void) -> c_int;
        fn gdk_display_get_monitor(display: *mut c_void, index: c_int) -> *mut c_void;
        fn gdk_display_get_primary_monitor(display: *mut c_void) -> *mut c_void;
        fn gdk_monitor_get_geometry(monitor: *mut c_void, rect: *mut GdkRect);
        fn gdk_monitor_get_workarea(monitor: *mut c_void, rect: *mut GdkRect);
        fn gdk_monitor_get_scale_factor(monitor: *mut c_void) -> c_int;
        fn gdk_x11_display_error_trap_push(display: *mut c_void);
        fn gdk_x11_display_error_trap_pop_ignored(display: *mut c_void);
    }
    #[link(name = "gobject-2.0")]
    extern "C" {
        fn g_type_check_instance_is_a(instance: *mut c_void, kind: usize) -> c_int;
    }
    #[link(name = "X11")]
    extern "C" {
        fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
        fn XInternAtom(display: *mut c_void, name: *const c_char, only_exists: c_int) -> c_ulong;
        fn XGetWindowProperty(
            display: *mut c_void,
            window: c_ulong,
            property: c_ulong,
            offset: c_long,
            length: c_long,
            delete: c_int,
            requested: c_ulong,
            actual: *mut c_ulong,
            format: *mut c_int,
            count: *mut c_ulong,
            after: *mut c_ulong,
            data: *mut *mut c_uchar,
        ) -> c_int;
        fn XFree(data: *mut c_void) -> c_int;
        fn XQueryPointer(
            display: *mut c_void,
            window: c_ulong,
            root: *mut c_ulong,
            child: *mut c_ulong,
            x: *mut c_int,
            y: *mut c_int,
            wx: *mut c_int,
            wy: *mut c_int,
            mask: *mut u32,
        ) -> c_int;
        fn XQueryKeymap(display: *mut c_void, keys: *mut c_char) -> c_int;
        fn XKeysymToKeycode(display: *mut c_void, symbol: c_ulong) -> u8;
    }

    pub fn supported() -> bool {
        unsafe {
            let display = gdk_display_get_default();
            !display.is_null()
                && g_type_check_instance_is_a(display, gdk_x11_display_get_type()) != 0
        }
    }

    pub fn monitors() -> Vec<Monitor> {
        if !supported() {
            return vec![];
        }
        unsafe {
            let display = gdk_display_get_default();
            let primary = gdk_display_get_primary_monitor(display);
            (0..gdk_display_get_n_monitors(display))
                .filter_map(|index| {
                    let monitor = gdk_display_get_monitor(display, index);
                    if monitor.is_null() {
                        return None;
                    }
                    let scale = gdk_monitor_get_scale_factor(monitor).max(1);
                    let convert = |r: GdkRect| Rect {
                        x: r.x * scale,
                        y: r.y * scale,
                        width: r.width * scale,
                        height: r.height * scale,
                    };
                    let mut bounds = GdkRect::default();
                    let mut work = GdkRect::default();
                    gdk_monitor_get_geometry(monitor, &mut bounds);
                    gdk_monitor_get_workarea(monitor, &mut work);
                    Some(Monitor {
                        id: format!("x11-{index}"),
                        bounds: convert(bounds),
                        work: convert(work),
                        scale: scale as f64,
                        primary: monitor == primary || (primary.is_null() && index == 0),
                    })
                })
                .collect()
        }
    }

    unsafe fn property(
        display: *mut c_void,
        window: c_ulong,
        name: &std::ffi::CStr,
    ) -> Vec<c_ulong> {
        let atom = XInternAtom(display, name.as_ptr(), 1);
        if atom == 0 {
            return vec![];
        }
        let (mut actual, mut format, mut count, mut after) = (0, 0, 0, 0);
        let mut data = ptr::null_mut();
        let status = XGetWindowProperty(
            display,
            window,
            atom,
            0,
            256,
            0,
            0,
            &mut actual,
            &mut format,
            &mut count,
            &mut after,
            &mut data,
        );
        let result = if status == 0 && format == 32 && count <= 256 && !data.is_null() {
            std::slice::from_raw_parts(data.cast::<c_ulong>(), count as usize).to_vec()
        } else {
            vec![]
        };
        if !data.is_null() {
            XFree(data.cast());
        }
        result
    }

    pub fn observe(_monitor: &Monitor) -> (Option<(i32, i32)>, bool, bool) {
        if !supported() {
            return (None, false, false);
        }
        unsafe {
            let gdk = gdk_display_get_default();
            let display = gdk_x11_display_get_xdisplay(gdk);
            if display.is_null() {
                return (None, false, false);
            }
            gdk_x11_display_error_trap_push(gdk);
            let root = XDefaultRootWindow(display);
            let (mut r, mut child, mut x, mut y, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0, 0, 0);
            let pointer = (XQueryPointer(
                display, root, &mut r, &mut child, &mut x, &mut y, &mut wx, &mut wy, &mut mask,
            ) != 0)
                .then_some((x, y));
            let active = property(display, root, c"_NET_ACTIVE_WINDOW")
                .first()
                .copied()
                .unwrap_or(0);
            let fullscreen_atom = XInternAtom(display, c"_NET_WM_STATE_FULLSCREEN".as_ptr(), 1);
            // EWMH knows the foreground app even while our nonfocusable tab is above it.
            let fullscreen = active != 0
                && fullscreen_atom != 0
                && property(display, active, c"_NET_WM_STATE").contains(&fullscreen_atom);
            let mut keys = [0 as c_char; 32];
            XQueryKeymap(display, keys.as_mut_ptr());
            let escape = XKeysymToKeycode(display, 0xff1b) as usize;
            let escape_down = escape != 0 && (keys[escape / 8] as u8 & (1 << (escape % 8))) != 0;
            gdk_x11_display_error_trap_pop_ignored(gdk);
            (pointer, fullscreen, escape_down)
        }
    }
}

#[cfg(test)]
mod wake_tests {
    use super::*;

    fn seen(fullscreen: bool, width: i32) -> Look {
        let bounds = Rect {
            x: 0,
            y: 0,
            width,
            height: 1080,
        };
        Look {
            fullscreen,
            monitors: vec![placement::Monitor {
                id: "primary".into(),
                bounds,
                work: bounds,
                scale: 1.0,
                primary: true,
            }],
        }
    }

    #[test]
    fn a_hidden_tab_wakes_when_fullscreen_ends_or_the_monitors_change() {
        assert!(!wakes(&seen(false, 1920), &seen(false, 1920)), "nothing changed");
        assert!(wakes(&seen(true, 1920), &seen(false, 1920)), "fullscreen ended");
        assert!(
            !wakes(&seen(false, 1920), &seen(true, 1920)),
            "fullscreen began: the tab stays hidden"
        );
        assert!(wakes(&seen(false, 1920), &seen(false, 2560)), "the monitors changed");
    }

    /// The real loop with a hidden tab: `observed(n)` is what the nth look
    /// sees. Each tick is recorded with when it came and whether it
    /// enumerated the monitors.
    fn hidden_ticks(
        wake: &Receiver<()>,
        mut observed: impl FnMut(usize) -> Look,
        ticks: usize,
    ) -> Vec<(Duration, bool)> {
        let started = Instant::now();
        let mut recorded = Vec::new();
        let mut looks = 0;
        run(
            |refresh, _reassert| {
                recorded.push((started.elapsed(), refresh));
                (recorded.len() < ticks).then_some(false)
            },
            wake,
            || {
                looks += 1;
                Some(observed(looks))
            },
        );
        recorded
    }

    #[test]
    fn a_monitor_change_while_hidden_ticks_at_once_with_the_new_layout() {
        let (_wake, woken) = std::sync::mpsc::sync_channel(1);
        // The layout changes on the third look, about 200 ms into the second.
        let width = |look| if look < 3 { 1920 } else { 2560 };
        let ticks = hidden_ticks(&woken, |look| seen(false, width(look)), 2);
        assert!(ticks[1].0 < Duration::from_millis(900), "the change waited for the timer");
        assert!(ticks[1].1, "the early tick placed the tab with the old monitors");
    }

    #[test]
    fn fullscreen_ending_while_hidden_ticks_at_once() {
        let (_wake, woken) = std::sync::mpsc::sync_channel(1);
        let ticks = hidden_ticks(&woken, |look| seen(look < 3, 1920), 2);
        assert!(ticks[1].0 < Duration::from_millis(900), "fullscreen exit waited");
    }

    #[test]
    fn switching_the_tab_on_ends_the_hidden_second_at_once() {
        let (wake, woken) = std::sync::mpsc::sync_channel(1);
        // What `set_visible(true)` sends.
        wake.send(()).expect("wake queued");
        let ticks = hidden_ticks(&woken, |_| seen(false, 1920), 2);
        assert!(ticks[1].0 < Duration::from_millis(500), "the wake waited for the timer");
        assert!(ticks[1].1);
    }

    #[test]
    fn a_quiet_hidden_tab_ticks_once_a_second() {
        let (_wake, woken) = std::sync::mpsc::sync_channel(1);
        let ticks = hidden_ticks(&woken, |_| seen(false, 1920), 2);
        assert!(ticks[1].0 >= Duration::from_millis(950), "it ticked early for nothing");
        assert!(ticks[1].1, "a second on, the timer enumerates the monitors");
    }

    #[test]
    fn a_shown_tab_ticks_every_tenth_of_a_second_and_enumerates_once_a_second() {
        let (_wake, woken) = std::sync::mpsc::sync_channel(1);
        let started = Instant::now();
        let mut ticks = Vec::new();
        run(
            |refresh, _reassert| {
                ticks.push((started.elapsed(), refresh));
                (ticks.len() < 3).then_some(true)
            },
            &woken,
            || -> Option<Look> { panic!("a shown tab is observed by its own ticks") },
        );
        assert!(ticks[2].0 < Duration::from_millis(600));
        let refreshed: Vec<bool> = ticks.iter().map(|tick| tick.1).collect();
        assert_eq!(refreshed, [true, false, false]);
    }
}
