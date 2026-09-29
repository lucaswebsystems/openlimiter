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

const PLACE_FLAGS: u32 = SWP_NOACTIVATE | SWP_SHOWWINDOW;

fn passive_style(style: isize) -> isize {
    (style | WS_EX_TOOLWINDOW as isize | WS_EX_NOACTIVATE as isize) & !(WS_EX_APPWINDOW as isize)
}

pub fn configure(window: HWND) -> Result<(), String> {
    unsafe {
        let style = GetWindowLongPtrW(window, GWL_EXSTYLE);
        SetWindowLongPtrW(window, GWL_EXSTYLE, passive_style(style));
        let actual = GetWindowLongPtrW(window, GWL_EXSTYLE);
        if actual & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) as isize
            != (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) as isize
            || actual & WS_EX_APPWINDOW as isize != 0
        {
            return Err("Edge window nonactivation flags were not applied".into());
        }
        if SetWindowPos(
            window,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
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
            PLACE_FLAGS,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_surfaces_are_nonactivating_tool_windows() {
        for existing in [0, WS_EX_APPWINDOW as isize, WS_EX_LAYERED as isize] {
            let style = passive_style(existing);
            assert_ne!(style & WS_EX_NOACTIVATE as isize, 0);
            assert_ne!(style & WS_EX_TOOLWINDOW as isize, 0);
            assert_eq!(style & WS_EX_APPWINDOW as isize, 0);
            assert_eq!(
                style & WS_EX_LAYERED as isize,
                existing & WS_EX_LAYERED as isize
            );
        }
        assert_ne!(PLACE_FLAGS & SWP_NOACTIVATE, 0);
        assert_ne!(PLACE_FLAGS & SWP_SHOWWINDOW, 0);
    }
}
