//! macOS: an app opened from Finder starts with launchd's PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one a terminal has, so command
//! line clients installed through Homebrew, nvm, Volta, Bun or pnpm look
//! absent and the scripts among them find no `node`. At start, while this
//! process has one thread, the login shell's PATH is imported once: one shell
//! run, read until its marker line or for a bounded wait, then the shell is
//! killed. A shell that misbehaves leaves PATH as launchd set it. Detection
//! also searches the package managers' own folders (`provider_detection.rs`),
//! so a failed import still finds them.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// Starts the line that carries the shell's PATH, so whatever the user's
/// dotfiles print around it is skipped.
const MARK: &str = "__OPENLIMITER_LOGIN_PATH__";

/// The most a shell may print before its PATH line is given up on.
const MAX_OUTPUT_BYTES: u64 = 256 * 1024;

/// Import the login shell's PATH into this process, first thing in `run`.
#[cfg(target_os = "macos")]
pub fn import() {
    /// The longest wait for the shell: a slower one leaves PATH as it was.
    const WAIT: Duration = Duration::from_secs(3);
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let shell = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|shell| shell.is_absolute())
            .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
        let mut command = Command::new(shell);
        /* Login and interactive, as a terminal starts it, so `.zprofile`
        (Homebrew) and `.zshrc` (nvm, Volta, Bun, pnpm) each run once, in this
        one shell. Oh My Zsh is asked not to update itself on the way. */
        command
            .args(["-l", "-i", "-c"])
            .arg(format!("printf '\\n{MARK}%s\\n' \"$PATH\""))
            .env("DISABLE_AUTO_UPDATE", "true");
        if let Some(path) = login_path(command, WAIT).and_then(|login| merged(login, std::env::var_os("PATH"))) {
            std::env::set_var("PATH", path);
        }
    });
}

/// Run `command` with no input and return the folders of the first output
/// line that starts with the marker, waiting at most `wait`. The child is
/// killed either way, so a shell that hangs, prompts or never prints the
/// marker cannot hold the app.
fn login_path(mut command: Command, wait: Duration) -> Option<Vec<PathBuf>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    /* ponytail: a process a dotfile leaves running with this pipe open keeps
    this reader blocked until that process ends; it holds nothing else. */
    std::thread::spawn(move || {
        let found = BufReader::new(stdout.take(MAX_OUTPUT_BYTES))
            .split(b'\n')
            .map_while(Result::ok)
            .find_map(|line| marked(&line));
        let _ = sender.send(found);
    });
    let found = receiver.recv_timeout(wait).ok().flatten();
    let _ = child.kill();
    let _ = child.wait();
    found
}

/// The absolute folders of a marked line; a relative folder is never taken.
fn marked(line: &[u8]) -> Option<Vec<PathBuf>> {
    let text = std::str::from_utf8(line).ok()?.trim_end_matches('\r');
    let folders: Vec<PathBuf> = std::env::split_paths(text.strip_prefix(MARK)?)
        .filter(|folder| folder.is_absolute())
        .collect();
    (!folders.is_empty()).then_some(folders)
}

/// The login shell's folders first, then those this process already had,
/// each folder once.
fn merged(login: Vec<PathBuf>, current: Option<OsString>) -> Option<OsString> {
    let mut folders = login;
    for folder in current.iter().flat_map(std::env::split_paths) {
        if !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    std::env::join_paths(folders).ok()
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

    #[test]
    fn the_marked_line_gives_its_absolute_folders_and_nothing_else_does() {
        let folders = vec![absolute("homebrew-bin"), absolute("usr-bin")];
        assert_eq!(marked(&line(&folders)), Some(folders.clone()));
        assert_eq!(marked(b"Welcome back, Lucas"), None);
        assert_eq!(marked(MARK.as_bytes()), None, "an empty PATH is no PATH");
        let with_relative = std::env::join_paths([PathBuf::from("."), folders[0].clone()]).expect("PATH");
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
        assert_eq!(std::env::split_paths(&path).collect::<Vec<_>>(), vec![brew, usr, sbin]);
    }

    /// A shell that prints the marker and then stays: the folders arrive at
    /// once and the shell is killed.
    fn lingering_shell(folders: &[PathBuf]) -> Command {
        let path = std::env::join_paths(folders).expect("PATH");
        if cfg!(windows) {
            let mut command = Command::new(crate::windows_system_tool::tool(&["cmd.exe"]));
            // No space before `&`: cmd's echo would print it.
            command.args(["/d", "/c"]).arg(format!(
                "echo Welcome& echo {MARK}{}& ping -n 6 127.0.0.1 >nul",
                path.to_string_lossy()
            ));
            command
        } else {
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg(format!(
                "echo Welcome; printf '{MARK}%s\\n' '{}'; exec sleep 30",
                path.to_string_lossy()
            ));
            command
        }
    }

    /// A shell that never prints the marker and never ends on its own.
    fn hanging_shell() -> Command {
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
    fn the_shell_is_read_until_its_marker_and_never_waited_on_past_the_bound() {
        let folders = vec![absolute("homebrew-bin"), absolute("usr-bin")];
        let started = Instant::now();
        assert_eq!(login_path(lingering_shell(&folders), Duration::from_secs(4)), Some(folders));
        assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());

        let started = Instant::now();
        assert_eq!(login_path(hanging_shell(), Duration::from_millis(500)), None);
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());

        // A shell that is not there changes nothing either.
        assert_eq!(login_path(Command::new(absolute("no-such-shell")), Duration::from_millis(500)), None);
    }
}
