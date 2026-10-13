//! Start at sign in (2.1.6): the desktop starts when the person signs in to
//! the computer and stays in the tray, so something keeps the bars current
//! after a restart.
//!
//! The OS entry is OpenLimiter's own: a quoted Run value on Windows, an
//! autostart desktop file on Linux, a LaunchAgent on macOS. This module
//! decides when to write it, from a stored choice: on, off, or nothing
//! recorded yet. A completed first run with nothing recorded writes the entry
//! only when none exists, then records on. The Settings switch turning on
//! writes the entry first, clearing a disable the person set in the OS, then
//! records on; turning it off records off first, then removes the entry, so
//! off survives any failure. Off is final: the app never switches the entry
//! on again by itself. On with the entry gone (an uninstall removes it)
//! registers again at launch without touching an OS disable; an entry that
//! exists is never touched. Every change takes one turn, so a first run
//! report and a Settings toggle never interleave.

// The other OSes' entries compile everywhere, so every OS tests every format.
#![cfg_attr(not(test), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The name every OS entry carries. The NSIS uninstaller removes the Run
/// value under this same name (`${PRODUCTNAME}`) unless it is updating.
pub const APP_NAME: &str = "OpenLimiter";

/// What the OS entry starts the app with: the tray only, no window.
pub const LAUNCH_ARG: &str = "--autostart";

/// The macOS LaunchAgent's label and file name: the bundle identifier.
const LAUNCH_AGENT_LABEL: &str = "com.openlimiter.desktop";

const PREFERENCE_FILE_NAME: &str = "autostart.json";
const DOCUMENT_VERSION: u32 = 1;

/// Left by an update the window installs, so the relaunch shows the window.
const UPDATE_MARK_FILE_NAME: &str = "show-after-update.json";

/// The OS login entry, behind a seam so no test ever writes the real one.
pub trait LoginItem: Send + Sync {
    /// The entry exists, whatever the OS shows for it.
    fn registered(&self) -> Result<bool, String>;
    /// What the person sees: the entry exists and the OS has not switched it
    /// off (Task Manager on Windows, the desktop's startup settings on Linux).
    fn enabled(&self) -> Result<bool, String>;
    /// Write the entry. Only the Settings switch turning on passes
    /// `clear_os_disable`, so an automatic enable never undoes an OS disable.
    fn enable(&self, clear_os_disable: bool) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preference {
    Unset,
    On,
    Off,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreferenceDocument {
    version: u32,
    enabled: bool,
}

pub struct Autostart {
    file: Option<PathBuf>,
    item: Box<dyn LoginItem>,
    turn: Mutex<()>,
}

fn unavailable() -> String {
    "autostart_unavailable".to_string()
}

impl Autostart {
    pub fn new(directory: Option<PathBuf>, item: Box<dyn LoginItem>) -> Self {
        Self {
            file: directory.map(|path| path.join(PREFERENCE_FILE_NAME)),
            item,
            turn: Mutex::new(()),
        }
    }

    /// A missing document is nothing recorded yet. An unreadable one, or no
    /// state directory at all, is off, the safe answer: the app never
    /// switches the entry on from a choice it cannot read.
    fn preference(&self) -> Preference {
        let Some(path) = self.file.as_ref() else {
            return Preference::Off;
        };
        match crate::fsx::bounded_read_result(path, crate::fsx::MAX_STATE_FILE_BYTES) {
            Err(crate::fsx::ReadFailure::Missing) => Preference::Unset,
            Err(_) => Preference::Off,
            Ok(text) => match serde_json::from_str::<PreferenceDocument>(&text) {
                Ok(document) if document.version == DOCUMENT_VERSION && document.enabled => {
                    Preference::On
                }
                _ => Preference::Off,
            },
        }
    }

    fn record(&self, enabled: bool) -> Result<(), String> {
        let path = self.file.as_ref().ok_or_else(unavailable)?;
        let parent = path.parent().ok_or_else(unavailable)?;
        crate::fsx::ensure_private_dir(parent).map_err(|_| unavailable())?;
        let encoded = serde_json::to_string(&PreferenceDocument {
            version: DOCUMENT_VERSION,
            enabled,
        })
        .map_err(|_| unavailable())?;
        crate::fsx::atomic_write(path, &encoded).map_err(|_| unavailable())
    }

    /// At launch: on with the entry gone registers it again, leaving an OS
    /// disable as it is. An entry that exists is never touched.
    pub fn at_launch(&self) -> Result<(), String> {
        let _turn = self.turn.lock().map_err(|_| unavailable())?;
        if self.preference() == Preference::On && !self.item.registered()? {
            self.item.enable(false)?;
        }
        Ok(())
    }

    /// The window finished its first run, now or on an earlier launch. With
    /// nothing recorded the entry is written only when none exists, then on
    /// is recorded; a recorded choice stays as it is.
    pub fn first_run_complete(&self) -> Result<bool, String> {
        let _turn = self.turn.lock().map_err(|_| unavailable())?;
        if self.preference() == Preference::Unset {
            if !self.item.registered()? {
                self.item.enable(false)?;
            }
            self.record(true)?;
        }
        self.item.enabled()
    }

    /// What the Settings switch shows: the OS's own answer.
    pub fn status(&self) -> Result<bool, String> {
        self.item.enabled()
    }

    /// The Settings switch. On writes the entry, clearing an OS disable, then
    /// records on; off records off, then removes the entry.
    pub fn set(&self, enabled: bool) -> Result<bool, String> {
        let _turn = self.turn.lock().map_err(|_| unavailable())?;
        if enabled {
            self.item.enable(true)?;
            self.record(true)?;
        } else {
            self.record(false)?;
            if self.item.registered()? {
                self.item.disable()?;
            }
        }
        self.item.enabled()
    }
}

/// The Run value's data: the executable quoted, so a path with spaces names
/// one program, then the sign in argument. A path holding a quote or a
/// control character cannot be carried and gets no entry.
pub fn windows_run_command(exe: &Path) -> Option<String> {
    let text = exe.to_str()?;
    if text.is_empty() || text.contains('"') || text.chars().any(char::is_control) {
        return None;
    }
    Some(format!("\"{text}\" {LAUNCH_ARG}"))
}

/// Whether Task Manager leaves an entry on, from its StartupApproved bytes:
/// none at all is on; otherwise the low bit of the first byte marks it off
/// (02 on; 03 off, followed by the time it was switched off).
pub fn startup_approved(bytes: Option<&[u8]>) -> bool {
    bytes
        .and_then(|bytes| bytes.first())
        .is_none_or(|flag| flag & 1 == 0)
}

/// One Exec argument per the Desktop Entry specification: a literal percent
/// doubled, the argument quoted with its quote, backtick, dollar and
/// backslash escaped, then every backslash escaped once more as the general
/// string rule requires. A control character cannot be carried: None.
pub fn desktop_exec_argument(argument: &str) -> Option<String> {
    if argument.is_empty() || argument.chars().any(char::is_control) {
        return None;
    }
    let mut quoted = String::from("\"");
    for character in argument.replace('%', "%%").chars() {
        if matches!(character, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.push('"');
    Some(quoted.replace('\\', "\\\\"))
}

/// The Linux autostart desktop file for this executable.
pub fn desktop_entry(exe: &Path) -> Option<String> {
    let exec = desktop_exec_argument(exe.to_str()?)?;
    Some(format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME}\nExec={exec} {LAUNCH_ARG}\nTerminal=false\n"
    ))
}

/// Whether a desktop file starts at sign in: a [Desktop Entry] group that is
/// not Hidden and not switched off through X-GNOME-Autostart-enabled.
pub fn desktop_entry_enabled(text: &str) -> bool {
    let mut in_entry = false;
    let mut found = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            found |= in_entry;
            continue;
        }
        if let (true, Some((key, value))) = (in_entry, line.split_once('=')) {
            if matches!(
                (key.trim(), value.trim()),
                ("Hidden", "true") | ("X-GNOME-Autostart-enabled", "false")
            ) {
                return false;
            }
        }
    }
    found
}

fn xml_text(text: &str) -> Option<String> {
    if text.chars().any(char::is_control) {
        return None;
    }
    Some(
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;"),
    )
}

/// The macOS LaunchAgent for this executable. AbandonProcessGroup keeps the
/// copy an update relaunches alive when the first one exits.
pub fn launch_agent_plist(exe: &Path) -> Option<String> {
    let program = xml_text(exe.to_str()?)?;
    Some(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{program}</string>
    <string>{LAUNCH_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
"#
    ))
}

/// An entry that is one file in a directory: the Linux desktop file or the
/// macOS LaunchAgent. `check` reads whether the file as it stands is on.
pub struct FileEntry {
    pub path: PathBuf,
    pub contents: String,
    pub check: fn(&str) -> bool,
}

impl LoginItem for FileEntry {
    fn registered(&self) -> Result<bool, String> {
        match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(unavailable()),
        }
    }
    fn enabled(&self) -> Result<bool, String> {
        if !self.registered()? {
            return Ok(false);
        }
        crate::fsx::bounded_read(&self.path)
            .map(|text| (self.check)(&text))
            .ok_or_else(unavailable)
    }
    /// Writing our own file is what clears an OS disable, so the automatic
    /// paths, which never call this over an existing entry, clear nothing.
    fn enable(&self, _clear_os_disable: bool) -> Result<(), String> {
        let parent = self.path.parent().ok_or_else(unavailable)?;
        std::fs::create_dir_all(parent).map_err(|_| unavailable())?;
        crate::fsx::atomic_write(&self.path, &self.contents).map_err(|_| unavailable())
    }
    fn disable(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(unavailable()),
        }
    }
}

/// The HKCU Run value and Task Manager's switch for it.
#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

#[cfg(windows)]
struct WindowsRun {
    command: String,
    run_key: &'static str,
    approved_key: &'static str,
}

#[cfg(windows)]
impl LoginItem for WindowsRun {
    fn registered(&self) -> Result<bool, String> {
        registry::exists(self.run_key, APP_NAME)
    }
    fn enabled(&self) -> Result<bool, String> {
        Ok(self.registered()?
            && startup_approved(registry::binary(self.approved_key, APP_NAME)?.as_deref()))
    }
    fn enable(&self, clear_os_disable: bool) -> Result<(), String> {
        registry::set_string(self.run_key, APP_NAME, &self.command)?;
        if clear_os_disable {
            registry::delete(self.approved_key, APP_NAME)?;
        }
        Ok(())
    }
    fn disable(&self) -> Result<(), String> {
        registry::delete(self.run_key, APP_NAME)
    }
}

/// HKCU values through windows-sys, and nothing more.
#[cfg(windows)]
mod registry {
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_ANY,
        RRF_RT_REG_BINARY,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }

    /// Whether a value exists, read only.
    pub(super) fn exists(key: &str, name: &str) -> Result<bool, String> {
        let (key, name) = (wide(key), wide(name));
        // SAFETY: both names are NUL terminated and outlive the call, and no
        // buffer is passed, so the call only reports whether the value exists.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_ANY,
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        match status {
            ERROR_SUCCESS => Ok(true),
            ERROR_FILE_NOT_FOUND => Ok(false),
            _ => Err(super::unavailable()),
        }
    }

    /// A binary value's bytes, or None when it is not there.
    pub(super) fn binary(key: &str, name: &str) -> Result<Option<Vec<u8>>, String> {
        let (key, name) = (wide(key), wide(name));
        let mut buffer = [0u8; 64];
        let mut size = buffer.len() as u32;
        // SAFETY: the buffer and `size` describe the same writable memory.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_BINARY,
                null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match status {
            ERROR_SUCCESS => Ok(Some(buffer[..(size as usize).min(buffer.len())].to_vec())),
            ERROR_FILE_NOT_FOUND => Ok(None),
            _ => Err(super::unavailable()),
        }
    }

    pub(super) fn set_string(key: &str, name: &str, value: &str) -> Result<(), String> {
        let (key, name, data) = (wide(key), wide(name), wide(value));
        let bytes = u32::try_from(data.len() * 2).map_err(|_| super::unavailable())?;
        // SAFETY: `data` holds `bytes` bytes, its NUL included, as REG_SZ requires.
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                data.as_ptr().cast(),
                bytes,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(super::unavailable())
        }
    }

    /// Remove a value; one already gone is fine.
    pub(super) fn delete(key: &str, name: &str) -> Result<(), String> {
        let (key, name) = (wide(key), wide(name));
        // SAFETY: both names are NUL terminated and outlive the call.
        match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) } {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            _ => Err(super::unavailable()),
        }
    }
}

/// No entry can be written: the OS gave no executable path or home.
struct Unavailable;

impl LoginItem for Unavailable {
    fn registered(&self) -> Result<bool, String> {
        Err(unavailable())
    }
    fn enabled(&self) -> Result<bool, String> {
        Err(unavailable())
    }
    fn enable(&self, _clear_os_disable: bool) -> Result<(), String> {
        Err(unavailable())
    }
    fn disable(&self) -> Result<(), String> {
        Err(unavailable())
    }
}

#[cfg(windows)]
fn os_entry() -> Option<Box<dyn LoginItem>> {
    Some(Box::new(WindowsRun {
        command: windows_run_command(&std::env::current_exe().ok()?)?,
        run_key: RUN_KEY,
        approved_key: APPROVED_KEY,
    }))
}

/// `$XDG_CONFIG_HOME/autostart`, else `~/.config/autostart`; an AppImage
/// starts from its own path.
#[cfg(target_os = "linux")]
fn os_entry() -> Option<Box<dyn LoginItem>> {
    let exe = crate::state::non_empty("APPIMAGE").or_else(|| std::env::current_exe().ok())?;
    let config = crate::state::non_empty("XDG_CONFIG_HOME")
        .filter(|path| path.is_absolute())
        .or_else(|| crate::state::home().map(|home| home.join(".config")))?;
    Some(Box::new(FileEntry {
        path: config.join("autostart").join(format!("{APP_NAME}.desktop")),
        contents: desktop_entry(&exe)?,
        check: desktop_entry_enabled,
    }))
}

#[cfg(target_os = "macos")]
fn os_entry() -> Option<Box<dyn LoginItem>> {
    let exe = std::env::current_exe().ok()?;
    let agents = crate::state::home()?.join("Library").join("LaunchAgents");
    Some(Box::new(FileEntry {
        path: agents.join(format!("{LAUNCH_AGENT_LABEL}.plist")),
        contents: launch_agent_plist(&exe)?,
        check: |_| true,
    }))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn os_entry() -> Option<Box<dyn LoginItem>> {
    None
}

/// This OS's entry for the running executable.
pub fn os_login_item() -> Box<dyn LoginItem> {
    os_entry().unwrap_or_else(|| Box::new(Unavailable))
}

/// The Settings switch's state, read from the OS.
#[tauri::command(async)]
pub fn autostart_status(autostart: tauri::State<'_, Autostart>) -> Result<bool, String> {
    autostart.status()
}

/// The Settings switch.
#[tauri::command(async)]
pub fn set_autostart(
    enabled: bool,
    autostart: tauri::State<'_, Autostart>,
) -> Result<bool, String> {
    autostart.set(enabled)
}

/// The window reports a completed first run, at its end and on every launch
/// after it.
#[tauri::command(async)]
pub fn autostart_first_run_complete(
    autostart: tauri::State<'_, Autostart>,
) -> Result<bool, String> {
    autostart.first_run_complete()
}

/// Whether the sign in entry started this process.
pub fn from_sign_in(args: &[String]) -> bool {
    args.iter().any(|arg| arg == LAUNCH_ARG)
}

/// Whether this launch shows the main window: every launch but the sign in
/// entry's, and that one too when an update the window installed relaunched
/// it with the old arguments.
pub fn starts_visible(args: &[String], after_update: bool) -> bool {
    after_update || !from_sign_in(args)
}

/// A second launch brings the running window forward, unless the sign in
/// entry made it.
pub fn on_second_launch(args: &[String], show: impl FnOnce()) {
    if !from_sign_in(args) {
        show();
    }
}

/// Mark an update the window is about to install.
pub fn mark_update(directory: Option<&Path>) -> bool {
    directory.is_some_and(|directory| {
        crate::fsx::ensure_private_dir(directory).is_ok()
            && crate::fsx::atomic_write(&directory.join(UPDATE_MARK_FILE_NAME), "{}").is_ok()
    })
}

/// Forget an update mark, saying whether there was one.
pub fn take_update_mark(directory: Option<&Path>) -> bool {
    directory.is_some_and(|directory| {
        std::fs::remove_file(directory.join(UPDATE_MARK_FILE_NAME)).is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::sync::Arc;

    #[derive(Default)]
    struct Fake {
        registered: bool,
        /// Switched off in the OS (Task Manager) while the entry stays.
        switched_off: bool,
        refuse: bool,
        enables: u32,
        clears: u32,
        disables: u32,
        busy: bool,
        overlapped: bool,
    }

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Fake>>);

    impl Shared {
        fn with<T>(&self, change: impl FnOnce(&mut Fake) -> T) -> T {
            change(&mut self.0.lock().expect("fake"))
        }
        /// One OS call, slow enough that two unserialized ones overlap.
        fn call(&self, change: impl FnOnce(&mut Fake) -> Result<(), String>) -> Result<(), String> {
            self.with(|fake| {
                fake.overlapped |= fake.busy;
                fake.busy = true;
            });
            std::thread::sleep(std::time::Duration::from_millis(2));
            self.with(|fake| {
                fake.busy = false;
                change(fake)
            })
        }
    }

    impl LoginItem for Shared {
        fn registered(&self) -> Result<bool, String> {
            Ok(self.with(|fake| fake.registered))
        }
        fn enabled(&self) -> Result<bool, String> {
            Ok(self.with(|fake| fake.registered && !fake.switched_off))
        }
        /// Writes the entry; only a clearing enable undoes an OS disable.
        fn enable(&self, clear_os_disable: bool) -> Result<(), String> {
            self.call(|fake| {
                if fake.refuse {
                    return Err("refused".into());
                }
                fake.registered = true;
                if clear_os_disable {
                    fake.switched_off = false;
                    fake.clears += 1;
                }
                fake.enables += 1;
                Ok(())
            })
        }
        /// As the plugin on Windows: deleting a value that is not there fails.
        fn disable(&self) -> Result<(), String> {
            self.call(|fake| {
                if !fake.registered {
                    return Err("missing".into());
                }
                fake.registered = false;
                fake.disables += 1;
                Ok(())
            })
        }
    }

    fn autostart(dir: &TempDir, fake: &Shared) -> Autostart {
        Autostart::new(Some(dir.path().to_path_buf()), Box::new(fake.clone()))
    }

    fn recorded(dir: &TempDir) -> Option<String> {
        std::fs::read_to_string(dir.path().join(PREFERENCE_FILE_NAME)).ok()
    }

    #[test]
    fn a_completed_first_run_with_nothing_recorded_enables_once_and_records_on() {
        let dir = TempDir::new();
        let fake = Shared::default();
        let start = autostart(&dir, &fake);
        assert_eq!(start.first_run_complete(), Ok(true));
        assert_eq!(
            recorded(&dir).as_deref(),
            Some(r#"{"version":1,"enabled":true}"#)
        );
        /* Every later launch reports the first run again; nothing is rewritten. */
        assert_eq!(start.first_run_complete(), Ok(true));
        start.at_launch().expect("launch");
        assert_eq!(fake.with(|fake| fake.enables), 1);
    }

    #[test]
    fn a_first_run_never_enables_an_existing_entry() {
        let dir = TempDir::new();
        let fake = Shared::default();
        fake.with(|fake| {
            fake.registered = true;
            fake.switched_off = true;
        });
        let start = autostart(&dir, &fake);
        assert_eq!(start.first_run_complete(), Ok(false));
        assert_eq!(fake.with(|fake| (fake.enables, fake.switched_off)), (0, true));
        assert_eq!(
            recorded(&dir).as_deref(),
            Some(r#"{"version":1,"enabled":true}"#)
        );
    }

    /// A directory where the choice belongs, so recording it fails.
    fn unwritable(dir: &TempDir) {
        std::fs::create_dir_all(dir.path().join(PREFERENCE_FILE_NAME).join("occupied"))
            .expect("blocker");
    }

    #[test]
    fn off_is_recorded_before_the_entry_goes() {
        let dir = TempDir::new();
        let fake = Shared::default();
        fake.with(|fake| fake.registered = true);
        unwritable(&dir);
        assert!(autostart(&dir, &fake).set(false).is_err());
        assert_eq!(fake.with(|fake| (fake.registered, fake.disables)), (true, 0));
    }

    #[test]
    fn on_writes_the_entry_first_and_then_records_on() {
        let dir = TempDir::new();
        let fake = Shared::default();
        unwritable(&dir);
        assert!(autostart(&dir, &fake).set(true).is_err());
        assert_eq!(fake.with(|fake| (fake.registered, fake.enables)), (true, 1));
        assert_eq!(recorded(&dir), None);
    }

    #[test]
    fn only_the_switch_clears_an_os_disable() {
        let dir = TempDir::new();
        let fake = Shared::default();
        let start = autostart(&dir, &fake);
        assert_eq!(start.set(true), Ok(true));
        /* An uninstall removed the entry; the OS kept its off. */
        fake.with(|fake| {
            fake.registered = false;
            fake.switched_off = true;
        });
        start.at_launch().expect("launch");
        assert_eq!(fake.with(|fake| (fake.registered, fake.switched_off)), (true, true));
        assert_eq!(start.status(), Ok(false));
        assert_eq!(start.set(true), Ok(true));
        assert_eq!(fake.with(|fake| fake.clears), 2);
    }

    #[test]
    fn the_windows_entry_quotes_its_executable() {
        assert_eq!(
            windows_run_command(Path::new(
                r"C:\Users\John Smith\AppData\Local\OpenLimiter\OpenLimiter.exe"
            ))
            .as_deref(),
            Some(r#""C:\Users\John Smith\AppData\Local\OpenLimiter\OpenLimiter.exe" --autostart"#)
        );
        assert_eq!(windows_run_command(Path::new(r#"C:\odd"name\OpenLimiter.exe"#)), None);
    }

    #[test]
    fn task_manager_s_switch_reads_from_its_bytes() {
        assert!(startup_approved(None));
        assert!(startup_approved(Some(&[0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        /* Task Manager's off: 03, then the time it was switched off. */
        assert!(!startup_approved(Some(&[
            0x03, 0, 0, 0, 0x10, 0x6b, 0x2a, 0x4f, 0x9e, 0x58, 0xdb, 0x01
        ])));
    }

    #[test]
    fn the_linux_entry_quotes_its_executable_per_the_desktop_entry_spec() {
        assert_eq!(
            desktop_exec_argument("/home/a b/OpenLimiter.AppImage").as_deref(),
            Some(r#""/home/a b/OpenLimiter.AppImage""#)
        );
        assert_eq!(
            desktop_exec_argument(r#"/opt/x$y/back\slash/100%/q"uote`"#).as_deref(),
            Some(r#""/opt/x\\$y/back\\\\slash/100%%/q\\"uote\\`""#)
        );
        assert_eq!(desktop_exec_argument("/tmp/line\nbreak"), None);
        let entry = desktop_entry(Path::new("/home/a b/OpenLimiter.AppImage")).expect("entry");
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("\nExec=\"/home/a b/OpenLimiter.AppImage\" --autostart\n"));
        assert!(desktop_entry_enabled(&entry));
        assert!(!desktop_entry_enabled(&format!("{entry}Hidden=true\n")));
        assert!(!desktop_entry_enabled(&format!(
            "{entry}X-GNOME-Autostart-enabled = false\n"
        )));
        assert!(desktop_entry_enabled(&format!(
            "{entry}X-GNOME-Autostart-enabled=true\n[Other]\nHidden=true\n"
        )));
    }

    #[test]
    fn the_macos_entry_is_a_launch_agent_that_abandons_its_process_group() {
        let plist = launch_agent_plist(Path::new(
            "/Applications/Open & Limiter.app/Contents/MacOS/OpenLimiter",
        ))
        .expect("plist");
        for part in [
            "<key>Label</key>\n  <string>com.openlimiter.desktop</string>",
            "<string>/Applications/Open &amp; Limiter.app/Contents/MacOS/OpenLimiter</string>\n    <string>--autostart</string>",
            "<key>RunAtLoad</key>\n  <true/>",
            "<key>AbandonProcessGroup</key>\n  <true/>",
        ] {
            assert!(plist.contains(part), "{part}");
        }
        assert_eq!(launch_agent_plist(Path::new("/tmp/a\u{7}b")), None);
    }

    #[test]
    fn a_file_entry_is_written_read_and_removed_in_its_own_directory() {
        let dir = TempDir::new();
        let entry = FileEntry {
            path: dir.path().join("autostart").join("OpenLimiter.desktop"),
            contents: desktop_entry(Path::new("/opt/OpenLimiter/openlimiter")).expect("entry"),
            check: desktop_entry_enabled,
        };
        assert_eq!((entry.registered(), entry.enabled()), (Ok(false), Ok(false)));
        entry.enable(false).expect("enable");
        assert_eq!((entry.registered(), entry.enabled()), (Ok(true), Ok(true)));
        /* The desktop's own startup settings hide it: still there, not on. */
        std::fs::write(&entry.path, format!("{}Hidden=true\n", entry.contents)).expect("hide");
        assert_eq!((entry.registered(), entry.enabled()), (Ok(true), Ok(false)));
        entry.enable(true).expect("switch on");
        assert_eq!(entry.enabled(), Ok(true));
        entry.disable().expect("disable");
        assert_eq!(entry.registered(), Ok(false));
        entry.disable().expect("a second removal is fine");
    }

    #[test]
    fn nothing_is_enabled_before_the_first_run_completes() {
        let dir = TempDir::new();
        let fake = Shared::default();
        autostart(&dir, &fake).at_launch().expect("launch");
        assert_eq!(fake.with(|fake| fake.enables), 0);
        assert_eq!(recorded(&dir), None);
    }

    #[test]
    fn off_is_final() {
        let dir = TempDir::new();
        let fake = Shared::default();
        let start = autostart(&dir, &fake);
        assert_eq!(start.set(false), Ok(false));
        assert_eq!(fake.with(|fake| fake.disables), 0, "nothing to remove");
        assert_eq!(start.first_run_complete(), Ok(false));
        start.at_launch().expect("launch");
        assert_eq!(fake.with(|fake| fake.enables), 0);
        assert_eq!(
            recorded(&dir).as_deref(),
            Some(r#"{"version":1,"enabled":false}"#)
        );
    }

    #[test]
    fn on_is_recorded_only_after_the_os_accepted_the_entry() {
        let dir = TempDir::new();
        let fake = Shared::default();
        let start = autostart(&dir, &fake);
        fake.with(|fake| fake.refuse = true);
        assert!(start.first_run_complete().is_err());
        assert!(start.set(true).is_err());
        assert_eq!(recorded(&dir), None);
        fake.with(|fake| fake.refuse = false);
        assert_eq!(start.first_run_complete(), Ok(true));
        assert_eq!(
            recorded(&dir).as_deref(),
            Some(r#"{"version":1,"enabled":true}"#)
        );
    }

    #[test]
    fn a_missing_entry_registers_again_and_an_existing_one_is_never_touched() {
        let dir = TempDir::new();
        let fake = Shared::default();
        let start = autostart(&dir, &fake);
        start.first_run_complete().expect("first run");
        /* An uninstall removed the Run value; the choice is still on. */
        fake.with(|fake| fake.registered = false);
        start.at_launch().expect("launch");
        assert_eq!(fake.with(|fake| (fake.registered, fake.enables)), (true, 2));
        /* Switched off in Task Manager: the entry stays, and so does the off. */
        fake.with(|fake| fake.switched_off = true);
        start.at_launch().expect("launch");
        assert_eq!(fake.with(|fake| fake.enables), 2);
        assert_eq!(start.status(), Ok(false));
    }

    #[test]
    fn the_switch_reads_and_writes_the_os_entry() {
        let dir = TempDir::new();
        let fake = Shared::default();
        let start = autostart(&dir, &fake);
        fake.with(|fake| {
            fake.registered = true;
            fake.switched_off = true;
        });
        assert_eq!(start.status(), Ok(false));
        assert_eq!(start.set(true), Ok(true));
        assert_eq!(start.status(), Ok(true));
        assert_eq!(start.set(false), Ok(false));
        assert_eq!(
            fake.with(|fake| (fake.registered, fake.disables)),
            (false, 1)
        );
        assert_eq!(
            recorded(&dir).as_deref(),
            Some(r#"{"version":1,"enabled":false}"#)
        );
    }

    #[test]
    fn an_unreadable_choice_counts_as_off() {
        let dir = TempDir::new();
        std::fs::write(dir.path().join(PREFERENCE_FILE_NAME), "not json").expect("write");
        let fake = Shared::default();
        assert_eq!(autostart(&dir, &fake).first_run_complete(), Ok(false));
        assert_eq!(fake.with(|fake| fake.enables), 0);
    }

    #[test]
    fn first_run_reports_and_toggles_take_turns() {
        let dir = TempDir::new();
        let fake = Shared::default();
        let start = Arc::new(autostart(&dir, &fake));
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    let _ = match index % 3 {
                        0 => start.first_run_complete(),
                        1 => start.set(true),
                        _ => start.set(false),
                    };
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("worker");
        }
        assert!(!fake.with(|fake| fake.overlapped));
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn only_the_sign_in_entry_starts_hidden() {
        /* First launch, and every launch a person makes. */
        assert!(starts_visible(&args(&["OpenLimiter.exe"]), false));
        /* The sign in entry: the tray only. */
        assert!(!starts_visible(
            &args(&["OpenLimiter.exe", LAUNCH_ARG]),
            false
        ));
        /* An update installed from the window relaunches with the old
        arguments; the window comes back. */
        assert!(starts_visible(
            &args(&["OpenLimiter.exe", LAUNCH_ARG]),
            true
        ));
        /* A second launch: shown, unless the sign in entry made it. */
        assert!(!from_sign_in(&args(&["OpenLimiter.exe"])));
        assert!(from_sign_in(&args(&["OpenLimiter.exe", LAUNCH_ARG])));
    }

    /// The window's three calls, through their registered commands.
    #[test]
    fn the_window_reaches_the_choice_through_its_commands() {
        use tauri::{
            ipc::{CallbackFn, InvokeBody},
            test::{get_ipc_response, mock_builder, INVOKE_KEY},
            webview::InvokeRequest,
            Manager as _, WebviewWindowBuilder,
        };
        let dir = TempDir::new();
        let fake = Shared::default();
        let app = mock_builder()
            .manage(autostart(&dir, &fake))
            .invoke_handler(tauri::generate_handler![
                autostart_status,
                set_autostart,
                autostart_first_run_complete
            ])
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let window = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("window");
        let invoke = |cmd: &str, body: serde_json::Value| -> bool {
            get_ipc_response(
                &window,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .expect("origin"),
                    body: InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .expect("the command succeeded")
            .deserialize::<bool>()
            .expect("a boolean")
        };
        assert!(!invoke("autostart_status", serde_json::json!({})));
        assert!(invoke(
            "autostart_first_run_complete",
            serde_json::json!({})
        ));
        assert!(!invoke(
            "set_autostart",
            serde_json::json!({ "enabled": false })
        ));
        assert!(!invoke(
            "autostart_first_run_complete",
            serde_json::json!({})
        ));
        assert!(app.state::<Autostart>().status() == Ok(false));
        assert_eq!(fake.with(|fake| (fake.enables, fake.disables)), (1, 1));
    }

    /// Read only: a value nobody wrote is reported missing.
    #[cfg(windows)]
    #[test]
    fn a_run_value_nobody_wrote_reads_as_missing() {
        let name = format!("OpenLimiterTest{}", uuid::Uuid::new_v4().simple());
        assert_eq!(registry::exists(RUN_KEY, &name), Ok(false));
    }

    /// The NSIS uninstaller removes the Run value named after the product
    /// (${PRODUCTNAME}); the entry must carry that same name.
    #[test]
    fn the_entry_carries_the_name_the_uninstaller_removes() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("config");
        assert_eq!(config["productName"], APP_NAME);
        assert_eq!(config["app"]["windows"][0]["visible"], false);
    }

    #[test]
    fn a_second_launch_shows_the_window_unless_the_sign_in_entry_made_it() {
        let shown = std::cell::Cell::new(0);
        on_second_launch(&args(&["OpenLimiter.exe"]), || shown.set(shown.get() + 1));
        assert_eq!(shown.get(), 1);
        on_second_launch(&args(&["OpenLimiter.exe", LAUNCH_ARG]), || {
            shown.set(shown.get() + 1)
        });
        assert_eq!(shown.get(), 1);
    }

    /// The single instance plugin goes first, so a second copy hands over
    /// and exits before any other plugin or the collector starts.
    #[test]
    fn one_running_copy_is_registered_before_every_other_plugin() {
        let source = include_str!("lib.rs");
        let single = source
            .find(".plugin(tauri_plugin_single_instance::init(")
            .expect("the single instance plugin is registered");
        let first = source.find(".plugin(").expect("plugins are registered");
        assert_eq!(single, first);
    }

    #[test]
    fn an_update_mark_is_taken_once() {
        let dir = TempDir::new();
        assert!(!take_update_mark(Some(dir.path())));
        assert!(mark_update(Some(dir.path())));
        assert!(take_update_mark(Some(dir.path())));
        assert!(!take_update_mark(Some(dir.path())));
        assert!(!mark_update(None));
        assert!(!take_update_mark(None));
    }
}
