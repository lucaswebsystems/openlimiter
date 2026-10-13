//! Start at sign in (2.1.6): the desktop starts when the person signs in to
//! the computer and stays in the tray, so something keeps the bars current
//! after a restart.
//!
//! The OS entry is the official tauri-plugin-autostart's: a Run value on
//! Windows, a LaunchAgent on macOS, an autostart desktop file on Linux. This
//! module only decides when to write it, from a stored choice: on, off, or
//! nothing recorded yet. Nothing recorded plus a completed first run (every
//! install before this build, and a new one the moment its first run ends)
//! switches it on once, and on is recorded only after the OS accepted the
//! entry. Off is final: the app never switches it on again by itself. On
//! with the entry gone (an uninstall removes it) registers again at launch;
//! an entry that exists is never touched, so one switched off in Task
//! Manager stays off. Every change takes one turn, so a first run report and
//! a Settings toggle never interleave.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The name every OS entry carries. The NSIS uninstaller removes the Run
/// value under this same name (`${PRODUCTNAME}`) unless it is updating.
pub const APP_NAME: &str = "OpenLimiter";

/// What the OS entry starts the app with: the tray only, no window.
pub const LAUNCH_ARG: &str = "--autostart";

const PREFERENCE_FILE_NAME: &str = "autostart.json";
const DOCUMENT_VERSION: u32 = 1;

/// Left by an update the window installs, so the relaunch shows the window.
const UPDATE_MARK_FILE_NAME: &str = "show-after-update.json";

/// The OS login entry, behind a seam so no test ever writes the real one.
pub trait LoginItem: Send + Sync {
    /// The entry exists, whatever the OS shows for it.
    fn registered(&self) -> Result<bool, String>;
    /// What the person sees: the entry exists and the OS has not switched it
    /// off (Task Manager on Windows).
    fn enabled(&self) -> Result<bool, String>;
    fn enable(&self) -> Result<(), String>;
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

    /// A missing or unreadable document is off, the safe answer: the app
    /// never switches the entry on from a choice it cannot read.
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

    /// At launch: on with the entry gone registers it again. An entry that
    /// exists is never touched.
    pub fn at_launch(&self) -> Result<(), String> {
        let _turn = self.turn.lock().map_err(|_| unavailable())?;
        if self.preference() == Preference::On && !self.item.registered()? {
            self.item.enable()?;
        }
        Ok(())
    }

    /// The window finished its first run, now or on an earlier launch. Only
    /// nothing recorded switches the entry on; a recorded choice stays.
    pub fn first_run_complete(&self) -> Result<bool, String> {
        let _turn = self.turn.lock().map_err(|_| unavailable())?;
        if self.preference() == Preference::Unset {
            self.item.enable()?;
            self.record(true)?;
        }
        self.item.enabled()
    }

    /// What the Settings switch shows: the OS's own answer.
    pub fn status(&self) -> Result<bool, String> {
        self.item.enabled()
    }

    /// The Settings switch: the OS entry first, the choice after it.
    pub fn set(&self, enabled: bool) -> Result<bool, String> {
        let _turn = self.turn.lock().map_err(|_| unavailable())?;
        if enabled {
            self.item.enable()?;
        } else if self.item.registered()? {
            self.item.disable()?;
        }
        self.record(enabled)?;
        self.item.enabled()
    }
}

/// The real entry, through the plugin, for the running app only.
pub struct OsLoginItem(pub tauri::AppHandle);

impl OsLoginItem {
    fn manager(
        &self,
    ) -> Result<tauri::State<'_, tauri_plugin_autostart::AutoLaunchManager>, String> {
        use tauri::Manager as _;
        self.0
            .try_state::<tauri_plugin_autostart::AutoLaunchManager>()
            .ok_or_else(unavailable)
    }
}

impl LoginItem for OsLoginItem {
    fn registered(&self) -> Result<bool, String> {
        #[cfg(windows)]
        return run_value_exists(APP_NAME);
        #[cfg(not(windows))]
        self.enabled()
    }
    fn enabled(&self) -> Result<bool, String> {
        self.manager()?.is_enabled().map_err(|_| unavailable())
    }
    fn enable(&self) -> Result<(), String> {
        self.manager()?.enable().map_err(|_| unavailable())
    }
    fn disable(&self) -> Result<(), String> {
        self.manager()?.disable().map_err(|_| unavailable())
    }
}

/// Whether the Run value exists, read only. The plugin's own answer also
/// counts Task Manager's switch, which must never read as a missing entry.
#[cfg(windows)]
fn run_value_exists(name: &str) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_ANY};
    let key: Vec<u16> = r"Software\Microsoft\Windows\CurrentVersion\Run"
        .encode_utf16()
        .chain([0])
        .collect();
    let value: Vec<u16> = name.encode_utf16().chain([0]).collect();
    // SAFETY: both names are NUL terminated and outlive the call, and no
    // buffer is passed, so the call only reports whether the value exists.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_ANY,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    match status {
        ERROR_SUCCESS => Ok(true),
        ERROR_FILE_NOT_FOUND => Ok(false),
        _ => Err(unavailable()),
    }
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

/// Mark an update the window is about to install.
pub fn mark_update(directory: Option<&Path>) -> bool {
    directory.is_some_and(|directory| {
        crate::fsx::ensure_private_dir(directory).is_ok()
            && crate::fsx::atomic_write(&directory.join(UPDATE_MARK_FILE_NAME), "{}").is_ok()
    })
}

/// Forget an update mark, saying whether there was one.
pub fn take_update_mark(directory: Option<&Path>) -> bool {
    directory.is_some_and(|directory| std::fs::remove_file(directory.join(UPDATE_MARK_FILE_NAME)).is_ok())
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
        /// As tauri-plugin-autostart 2.5.1 on Windows: writes the Run value and
        /// marks the entry approved again.
        fn enable(&self) -> Result<(), String> {
            self.call(|fake| {
                if fake.refuse {
                    return Err("refused".into());
                }
                fake.registered = true;
                fake.switched_off = false;
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
        assert_eq!(recorded(&dir).as_deref(), Some(r#"{"version":1,"enabled":true}"#));
        /* Every later launch reports the first run again; nothing is rewritten. */
        assert_eq!(start.first_run_complete(), Ok(true));
        start.at_launch().expect("launch");
        assert_eq!(fake.with(|fake| fake.enables), 1);
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
        assert_eq!(recorded(&dir).as_deref(), Some(r#"{"version":1,"enabled":false}"#));
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
        assert_eq!(recorded(&dir).as_deref(), Some(r#"{"version":1,"enabled":true}"#));
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
        assert_eq!(fake.with(|fake| (fake.registered, fake.disables)), (false, 1));
        assert_eq!(recorded(&dir).as_deref(), Some(r#"{"version":1,"enabled":false}"#));
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
        assert!(!starts_visible(&args(&["OpenLimiter.exe", LAUNCH_ARG]), false));
        /* An update installed from the window relaunches with the old
        arguments; the window comes back. */
        assert!(starts_visible(&args(&["OpenLimiter.exe", LAUNCH_ARG]), true));
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
        assert!(invoke("autostart_first_run_complete", serde_json::json!({})));
        assert!(!invoke("set_autostart", serde_json::json!({ "enabled": false })));
        assert!(!invoke("autostart_first_run_complete", serde_json::json!({})));
        assert!(app.state::<Autostart>().status() == Ok(false));
        assert_eq!(fake.with(|fake| (fake.enables, fake.disables)), (1, 1));
    }

    /// Read only: a value nobody wrote is reported missing.
    #[cfg(windows)]
    #[test]
    fn a_run_value_nobody_wrote_reads_as_missing() {
        let name = format!("OpenLimiterTest{}", uuid::Uuid::new_v4().simple());
        assert_eq!(run_value_exists(&name), Ok(false));
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
