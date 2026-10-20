//! What the desktop around the app provides, asked of a child process with a
//! bounded wait: the login shell's PATH on macOS, and whether Linux draws a
//! tray at all.
//!
//! macOS: an app opened from Finder starts with launchd's PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one a terminal has, so command
//! line clients installed through Homebrew, nvm, Volta, Bun or pnpm look
//! absent and the scripts among them find no `node`. At start, before Tauri
//! starts a thread, the login shell's PATH is imported once: one shell run,
//! read until its marker line or for a bounded wait, then the shell is
//! killed. The one reader thread here only reads the shell's output and never
//! touches the environment. A shell that misbehaves leaves PATH as launchd
//! set it. Detection
//! also searches the package managers' own folders (`provider_detection.rs`),
//! so a failed import still finds them.
//!
//! Linux: a desktop with no tray host (GNOME without its AppIndicator
//! extension) never shows the tray icon, so a window that hides on close
//! would leave the app running where nothing can bring it back. Closing
//! quits there instead (`lib.rs`).

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[cfg(any(target_os = "macos", test))]
use std::{ffi::OsString, path::PathBuf};

/// The most a child may print before its answer is given up on.
const MAX_OUTPUT_BYTES: u64 = 256 * 1024;

/// Run `command` with no input and return the first output line `pick`
/// answers, waiting at most `wait`. The child is killed either way, so one
/// that hangs, prompts or never answers cannot hold the app.
fn first_line<T: Send + 'static>(
    mut command: Command,
    wait: Duration,
    pick: fn(&[u8]) -> Option<T>,
) -> Option<T> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    /* ponytail: a process the child leaves running with this pipe open keeps
    this reader blocked until that process ends; it holds nothing else. */
    std::thread::spawn(move || {
        let found = BufReader::new(stdout.take(MAX_OUTPUT_BYTES))
            .split(b'\n')
            .map_while(Result::ok)
            .find_map(|line| pick(&line));
        let _ = sender.send(found);
    });
    let found = receiver.recv_timeout(wait).ok().flatten();
    let _ = child.kill();
    let _ = child.wait();
    found
}

/* ------------------------------------------------------- macOS, login PATH */

/// Starts the line that carries the shell's PATH, so whatever the user's
/// dotfiles print around it is skipped.
#[cfg(any(target_os = "macos", test))]
const MARK: &str = "__OPENLIMITER_LOGIN_PATH__";

/// Import the login shell's PATH into this process, first thing in `run`.
#[cfg(target_os = "macos")]
pub fn import_login_path() {
    /// The longest wait for the shell: a slower one leaves PATH as it was.
    const WAIT: Duration = Duration::from_secs(3);
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if let Some(path) = first_line(login_shell(std::env::var_os("SHELL")), WAIT, marked)
            .and_then(|login| merged(login, std::env::var_os("PATH")))
        {
            std::env::set_var("PATH", path);
        }
    });
}

/// The person's own shell (`SHELL`, else zsh, the macOS default), started as
/// a terminal starts it: login and interactive, so `.zprofile` (Homebrew) and
/// `.zshrc` (nvm, Volta, Bun, pnpm) each run once, in this one shell. It
/// prints PATH after the marker. Oh My Zsh is asked not to update itself.
#[cfg(any(target_os = "macos", test))]
fn login_shell(shell: Option<OsString>) -> Command {
    let shell = shell
        .map(PathBuf::from)
        .filter(|shell| shell.is_absolute())
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    let mut command = Command::new(shell);
    command
        .args(["-l", "-i", "-c"])
        .arg(format!("printf '\\n{MARK}%s\\n' \"$PATH\""))
        .env("DISABLE_AUTO_UPDATE", "true");
    command
}

/// The absolute folders of a marked line; a relative folder is never taken.
#[cfg(any(target_os = "macos", test))]
fn marked(line: &[u8]) -> Option<Vec<PathBuf>> {
    let text = std::str::from_utf8(line).ok()?.trim_end_matches('\r');
    let folders: Vec<PathBuf> = std::env::split_paths(text.strip_prefix(MARK)?)
        .filter(|folder| folder.is_absolute())
        .collect();
    (!folders.is_empty()).then_some(folders)
}

/// The login shell's folders first, then those this process already had,
/// each folder once.
#[cfg(any(target_os = "macos", test))]
fn merged(login: Vec<PathBuf>, current: Option<OsString>) -> Option<OsString> {
    let mut folders = login;
    for folder in current.iter().flat_map(std::env::split_paths) {
        if !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    std::env::join_paths(folders).ok()
}

/* --------------------------------------------------------- Linux, the tray */

/// Whether a desktop on Linux shows the tray icon: a status notifier host is
/// registered on the session bus, asked through `gdbus`, else `dbus-send`.
/// No answer at all reads as no tray, so closing never leaves the app
/// running out of sight. ponytail: a bar that draws only the older XEmbed
/// tray (i3bar) also reads as no tray, so there closing quits too.
#[cfg(target_os = "linux")]
pub fn tray_present() -> bool {
    tray_answer(tray_probes(), Duration::from_secs(2))
}

/// The two ways a desktop's session bus is asked, by the tool it may have.
#[cfg(any(target_os = "linux", test))]
fn tray_probes() -> [Command; 2] {
    let mut gdbus = Command::new("gdbus");
    gdbus.args([
        "call",
        "--session",
        "--timeout",
        "1",
        "--dest",
        "org.kde.StatusNotifierWatcher",
        "--object-path",
        "/StatusNotifierWatcher",
        "--method",
        "org.freedesktop.DBus.Properties.Get",
        "org.kde.StatusNotifierWatcher",
        "IsStatusNotifierHostRegistered",
    ]);
    let mut dbus_send = Command::new("dbus-send");
    dbus_send.args([
        "--session",
        "--print-reply=literal",
        "--reply-timeout=1000",
        "--dest=org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        "org.freedesktop.DBus.Properties.Get",
        "string:org.kde.StatusNotifierWatcher",
        "string:IsStatusNotifierHostRegistered",
    ]);
    [gdbus, dbus_send]
}

/// The first probe that answers decides; none answering is no tray.
#[cfg(any(target_os = "linux", test))]
fn tray_answer(probes: impl IntoIterator<Item = Command>, wait: Duration) -> bool {
    probes
        .into_iter()
        .find_map(|probe| first_line(probe, wait, reports))
        .unwrap_or(false)
}

/// `(<true>,)` from gdbus, `variant boolean true` from dbus-send.
#[cfg(any(target_os = "linux", test))]
fn reports(line: &[u8]) -> Option<bool> {
    let words = std::str::from_utf8(line).ok()?;
    let mut words = words.split(|c: char| !c.is_ascii_alphanumeric());
    words.find_map(|word| match word {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn absolute(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    fn line(folders: &[PathBuf]) -> Vec<u8> {
        let path = std::env::join_paths(folders).expect("PATH");
        format!("{MARK}{}\r", path.to_string_lossy()).into_bytes()
    }

    /// A child that prints `text` as one line, then stays: the line arrives
    /// at once and the child is killed.
    fn printing(text: &str) -> Command {
        if cfg!(windows) {
            let mut command = Command::new(crate::windows_system_tool::tool(&["cmd.exe"]));
            // No space before `&`: cmd's echo would print it.
            command
                .args(["/d", "/c"])
                .arg(format!("echo Welcome& echo {text}& ping -n 6 127.0.0.1 >nul"));
            command
        } else {
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg(format!(
                "echo Welcome; printf '%s\\n' '{text}'; exec sleep 30"
            ));
            command
        }
    }

    /// A child that never answers and never ends on its own.
    fn hanging() -> Command {
        if cfg!(windows) {
            let mut command = Command::new(crate::windows_system_tool::tool(&["cmd.exe"]));
            command.args(["/d", "/c", "ping -n 6 127.0.0.1 >nul"]);
            command
        } else {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "exec sleep 30"]);
            command
        }
    }

    #[test]
    fn the_marked_line_gives_its_absolute_folders_and_nothing_else_does() {
        let folders = vec![absolute("homebrew-bin"), absolute("usr-bin")];
        assert_eq!(marked(&line(&folders)), Some(folders.clone()));
        assert_eq!(marked(b"Welcome back, Lucas"), None);
        assert_eq!(marked(MARK.as_bytes()), None, "an empty PATH is no PATH");
        let with_relative =
            std::env::join_paths([PathBuf::from("."), folders[0].clone()]).expect("PATH");
        assert_eq!(
            marked(format!("{MARK}{}", with_relative.to_string_lossy()).as_bytes()),
            Some(vec![folders[0].clone()])
        );
    }

    #[test]
    fn the_login_folders_lead_and_none_is_named_twice() {
        let (brew, usr, sbin) = (absolute("brew"), absolute("usr"), absolute("sbin"));
        let current = std::env::join_paths([usr.clone(), sbin.clone()]).expect("PATH");
        let path = merged(vec![brew.clone(), usr.clone()], Some(current)).expect("joined");
        assert_eq!(
            std::env::split_paths(&path).collect::<Vec<_>>(),
            vec![brew, usr, sbin]
        );
    }

    #[test]
    fn a_child_is_read_until_its_answer_and_never_waited_on_past_the_bound() {
        let folders = vec![absolute("homebrew-bin"), absolute("usr-bin")];
        let path = std::env::join_paths(&folders).expect("PATH");
        let started = Instant::now();
        assert_eq!(
            first_line(
                printing(&format!("{MARK}{}", path.to_string_lossy())),
                Duration::from_secs(4),
                marked
            ),
            Some(folders)
        );
        assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());

        let started = Instant::now();
        assert_eq!(first_line(hanging(), Duration::from_millis(500), marked), None);
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());

        // A program that is not there changes nothing either.
        assert_eq!(
            first_line(Command::new(absolute("no-such-shell")), Duration::from_millis(500), marked),
            None
        );
    }

    #[test]
    fn the_login_shell_is_the_persons_own_started_as_a_terminal_starts_it() {
        let fish = absolute("fish");
        let shell = login_shell(Some(fish.clone().into_os_string()));
        assert_eq!(shell.get_program(), fish.as_os_str());
        let args: Vec<_> = shell.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(args[..3], ["-l", "-i", "-c"]);
        assert_eq!(args[3], format!("printf '\\n{MARK}%s\\n' \"$PATH\""));
        assert_eq!(login_shell(None).get_program(), "/bin/zsh");
        assert_eq!(login_shell(Some("fish".into())).get_program(), "/bin/zsh", "a relative SHELL is never run");
    }

    #[test]
    fn the_tray_is_asked_of_the_status_notifier_watcher_by_either_tool() {
        let [gdbus, dbus_send] = tray_probes();
        assert_eq!(gdbus.get_program(), "gdbus");
        assert!(gdbus.get_args().any(|arg| arg == "IsStatusNotifierHostRegistered"));
        assert_eq!(dbus_send.get_program(), "dbus-send");
        assert!(dbus_send.get_args().any(|arg| arg == "string:IsStatusNotifierHostRegistered"));
    }

    #[test]
    fn the_bus_answer_decides_and_no_answer_is_no_tray() {
        assert_eq!(reports(b"(<true>,)"), Some(true));
        assert_eq!(reports(b"   variant       boolean true"), Some(true));
        assert_eq!(reports(b"(<false>,)"), Some(false));
        assert_eq!(reports(b"Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown"), None);

        // The children print dbus-send's shape: cmd would read gdbus's < and > as redirections.
        let wait = Duration::from_secs(4);
        assert!(tray_answer([printing("variant boolean true")], wait));
        assert!(!tray_answer([printing("variant boolean false"), printing("variant boolean true")], wait));
        // Neither tool there, or one that says nothing: no tray, so closing quits.
        assert!(!tray_answer([Command::new(absolute("no-gdbus")), Command::new(absolute("no-dbus-send"))], wait));
        assert!(tray_answer([Command::new(absolute("no-gdbus")), printing("variant boolean true")], wait));
        assert!(!tray_answer([hanging()], Duration::from_millis(500)));
    }
}
