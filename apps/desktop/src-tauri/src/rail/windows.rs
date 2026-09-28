//! Native operations are confined here. No window procedure or global hotkey.
use super::placement::{Monitor, Rect};
use std::mem::size_of;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, POINT, RECT},
    Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
    },
    UI::{
        HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
        WindowsAndMessaging::*,
    },
};

// The existing windows-sys feature set does not include KeyboardAndMouse.
// Sample Escape only while a card is open; do not register or intercept a key.
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vkey: i32) -> i16;
}

fn rect(r: RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

unsafe extern "system" fn enumerate(handle: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> i32 {
    let mut info: MONITORINFOEXW = std::mem::zeroed();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(handle, &mut info as *mut _ as *mut MONITORINFO) == 0 {
        return 1;
    }
    let mut dpi_x = 96;
    let mut dpi_y = 96;
    let _ = GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
    let end = info
        .szDevice
        .iter()
        .position(|v| *v == 0)
        .unwrap_or(info.szDevice.len());
    let monitors = &mut *(data as *mut Vec<Monitor>);
    monitors.push(Monitor {
        id: String::from_utf16_lossy(&info.szDevice[..end]),
        bounds: rect(info.monitorInfo.rcMonitor),
        work: rect(info.monitorInfo.rcWork),
        scale: dpi_x.max(96) as f64 / 96.0,
        primary: info.monitorInfo.dwFlags & 1 != 0,
    });
    1
}

pub fn monitors() -> Vec<Monitor> {
    let mut result = Vec::new();
    // Synchronous enumeration owns result for the entire callback lifetime.
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(enumerate),
            &mut result as *mut _ as LPARAM,
        );
    }
    result
}

pub fn cursor() -> Option<(i32, i32)> {
    let mut point = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

pub fn foreground(exclude: &[HWND]) -> Option<Rect> {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null()
            || exclude.contains(&window)
            || window == GetShellWindow()
            || window == GetDesktopWindow()
            || IsWindowVisible(window) == 0
            || IsIconic(window) != 0
        {
            return None;
        }
        let mut bounds: RECT = std::mem::zeroed();
        (GetWindowRect(window, &mut bounds) != 0).then(|| rect(bounds))
    }
}

pub fn escape_down() -> bool {
    unsafe { GetAsyncKeyState(0x1b) < 0 }
}

pub fn configure(window: HWND) {
    unsafe {
        let style = GetWindowLongPtrW(window, GWL_EXSTYLE);
        SetWindowLongPtrW(
            window,
            GWL_EXSTYLE,
            (style | WS_EX_TOOLWINDOW as isize | WS_EX_NOACTIVATE as isize)
                & !(WS_EX_APPWINDOW as isize),
        );
        SetWindowPos(
            window,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

pub fn apply(window: HWND, bounds: Rect, visible: bool) -> Result<(), String> {
    unsafe {
        if !visible {
            ShowWindow(window, SW_HIDE);
            return Ok(());
        }
        // Resize, place, show and reassert topmost without activating in one call.
        if SetWindowPos(
            window,
            HWND_TOPMOST,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}
