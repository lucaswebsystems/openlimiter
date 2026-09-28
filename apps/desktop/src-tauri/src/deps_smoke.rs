//! Link proofs for the native dependencies added before the G1 freeze.
//!
//! No product code uses these crates yet. Each test names the APIs the later
//! lanes rely on, so a crate feature missing from Cargo.toml fails here, on
//! the CI runner for that OS, instead of inside a lane after the freeze.

use crate::test_support::TempDir;

/// Bundled SQLite compiles and links with this toolchain, and a read only
/// connection reads a WAL mode database while a writer holds it open, which is
/// how the Cursor, Codex and Kiro readers will meet those files.
#[test]
fn bundled_sqlite_reads_a_wal_database_while_a_writer_holds_it() {
    use rusqlite::{Connection, OpenFlags};

    let dir = TempDir::new();
    let path = dir.path().join("state.vscdb");
    let writer = Connection::open(&path).expect("the writer opens");
    let mode: String = writer
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .expect("the journal mode switches");
    assert_eq!(mode, "wal");
    writer
        .execute_batch(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
             INSERT INTO ItemTable VALUES ('smoke', 'present');",
        )
        .expect("the writer seeds a row");

    let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("the reader opens read only");
    let value: String = reader
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'smoke'",
            [],
            |row| row.get(0),
        )
        .expect("the reader sees the committed row");
    assert_eq!(value, "present");
    assert!(
        reader.execute("DELETE FROM ItemTable", []).is_err(),
        "a read only connection cannot write"
    );
}

/// tauri's test feature reaches test builds, so IPC tests can use the mock
/// runtime. No mock app is built here: on Windows that pulls comctl32 v6
/// imports into the lib test binary, which then fails to load with
/// STATUS_ENTRYPOINT_NOT_FOUND until it carries the Common Controls v6
/// manifest that tauri-build links into binaries only.
#[test]
fn tauri_mock_runtime_is_available_to_tests() {
    let _assets = tauri::test::noop_assets();
    assert!(!tauri::test::INVOKE_KEY.is_empty());
}

/// The process calls run against this test process. The window calls need a
/// desktop session, so for them the test takes addresses, which the linker has
/// to resolve.
#[cfg(windows)]
#[test]
fn windows_process_identity_answers_and_window_apis_link() {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, FlashWindowEx, GetWindowLongPtrW, SetForegroundWindow,
        SetWindowLongPtrW, SetWindowPos, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let pid = std::process::id();
    let parent = unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        assert_ne!(
            snapshot, INVALID_HANDLE_VALUE,
            "a process snapshot is available"
        );
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut parent = None;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.th32ProcessID == pid {
                parent = Some(entry.th32ParentProcessID);
                break;
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        parent
    };
    assert!(
        parent.is_some(),
        "the snapshot lists this process and its parent"
    );

    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    let answered = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    assert_ne!(answered, 0, "the process times are readable");
    assert_ne!(
        (created.dwHighDateTime, created.dwLowDateTime),
        (0, 0),
        "a creation time identifies the process"
    );

    let window_apis = [
        AllowSetForegroundWindow as *const (),
        FlashWindowEx as *const (),
        GetDpiForMonitor as *const (),
        GetDpiForWindow as *const (),
        GetMonitorInfoW as *const (),
        GetWindowLongPtrW as *const (),
        MonitorFromWindow as *const (),
        SetForegroundWindow as *const (),
        SetWindowLongPtrW as *const (),
        SetWindowPos as *const (),
    ];
    assert!(std::hint::black_box(window_apis)
        .iter()
        .all(|api| !api.is_null()));
    assert_eq!(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, 0x0800_0080);
}

/// Compiled on macOS only, so the macos-latest CI job is what runs it: the
/// panel class resolves, the pid based NSRunningApplication methods exist
/// (they need objc2-app-kit's libc feature), and proc_pidinfo reports this
/// process's parent and start time.
#[cfg(target_os = "macos")]
#[test]
fn macos_panel_activation_and_process_identity_apis_resolve() {
    use objc2::{sel, ClassType};
    use objc2_app_kit::{
        NSPanel, NSRunningApplication, NSStatusWindowLevel, NSTrackingAreaOptions,
        NSWindowCollectionBehavior, NSWindowStyleMask,
    };

    assert!(NSPanel::class().responds_to(sel!(setBecomesKeyOnlyIfNeeded:)));
    let _lookup = NSRunningApplication::runningApplicationWithProcessIdentifier;
    let _pid = NSRunningApplication::processIdentifier;
    assert_ne!(NSWindowStyleMask::NonactivatingPanel.0, 0);
    assert_ne!(NSWindowCollectionBehavior::CanJoinAllSpaces.0, 0);
    assert_ne!(NSTrackingAreaOptions::ActiveAlways.0, 0);
    assert!(NSStatusWindowLevel > 0);

    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            std::process::id() as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    assert_eq!(written, size, "proc_pidinfo fills the whole record");
    assert_eq!(info.pbi_ppid, std::os::unix::process::parent_id());
    assert!(
        info.pbi_start_tvsec > 0,
        "a start time identifies the process"
    );
}
