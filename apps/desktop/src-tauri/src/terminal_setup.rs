//! One click setup: the setup panels' Set up button runs the same pinned
//! installer commands the panels otherwise ask a person to paste into a
//! terminal, so connecting Claude Code or Antigravity is one press.
//!
//! Every argument is a constant of this build. The webview names only the
//! host, from a closed set, and the version is this binary's own, never one the
//! window sends. Output is not read: a step either exits 0 or the panel keeps
//! showing the commands to run by hand, which is also the path when Node is
//! missing.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// How long one installer step may take. npx fetches the package on a cold
/// cache, so this is generous; a step past it is ended and reported failed.
const STEP_LIMIT: Duration = Duration::from_secs(180);

/// One setup at a time: a second press, or a window redrawn mid run, is refused
/// rather than starting a second installer over the same settings files.
static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupHost {
    Claude,
    Antigravity,
}

/// The installer steps for one host, in order. Claude Code's prompt hook has
/// its own installer, so it is a second step.
pub(crate) fn steps(host: SetupHost) -> &'static [&'static [&'static str]] {
    match host {
        SetupHost::Claude => &[&["terminal", "install", "claude"], &["hooks", "install", "claude"]],
        SetupHost::Antigravity => &[&["terminal", "install", "antigravity"]],
    }
}

/// The full argument list after the launcher for one step.
pub(crate) fn npx_arguments(step: &[&str], version: &str) -> Vec<String> {
    let mut arguments = vec!["-y".to_string(), format!("openlimiter@{version}")];
    arguments.extend(step.iter().map(|part| part.to_string()));
    arguments
}

fn command_for(step: &[&str]) -> Command {
    let arguments = npx_arguments(step, env!("CARGO_PKG_VERSION"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new("npx.cmd");
        command.args(&arguments).creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        /* An app opened from the dock or a launcher has no terminal PATH, so
        the person's login shell finds Node. The line is built from constants
        and plain tokens only. */
        let shell = std::env::var("SHELL").ok().filter(|value| value.starts_with('/')).unwrap_or_else(|| "/bin/sh".to_string());
        use std::os::unix::process::CommandExt;
        let mut command = Command::new(shell);
        /* 127 is the shell's own "not found", read below as missing Node. */
        command.arg("-lc").arg(format!("command -v npx >/dev/null 2>&1 || exit 127; exec npx {}", arguments.join(" ")));
        /* Its own process group, so a timeout ends npx and every node under it. */
        command.process_group(0);
        command
    }
}

/// End a step and everything it started: npx runs node under a shell or
/// `cmd`, and killing only the first process would leave the installer
/// writing settings after the panel already said it failed.
fn end_tree(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_step(step: &[&str]) -> Result<(), String> {
    let mut command = command_for(step);
    /* From the person's home, never wherever the app was started: a project
    folder's own npm configuration or local packages must not decide what
    this runs. */
    if let Some(home) = crate::cli_config::runtime_home() {
        command.current_dir(home);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "setup_unavailable".to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) if status.code() == Some(127) => return Err("setup_unavailable".to_string()),
            Ok(Some(_)) => return Err("setup_failed".to_string()),
            Ok(None) if started.elapsed() > STEP_LIMIT => {
                end_tree(&mut child);
                return Err("setup_failed".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(_) => return Err("setup_failed".to_string()),
        }
    }
}

/// Held while a setup runs. Released by the worker itself when its last step
/// ends, even if the window that asked has gone or the worker panicked.
struct Release;

impl Drop for Release {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

fn claim() -> Option<Release> {
    /* Lazily: a refused claim must never build, and so drop, a `Release`,
    which would free the lock the running setup still holds. */
    (!RUNNING.swap(true, Ordering::AcqRel)).then(|| Release)
}

/// Run every installer step for one host, stopping at the first failure.
#[tauri::command]
pub async fn run_terminal_setup(host: SetupHost) -> Result<(), String> {
    let Some(release) = claim() else {
        return Err("setup_busy".to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _release = release;
        steps(host).iter().try_for_each(|step| run_step(step))
    })
    .await
    .map_err(|_| "setup_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_runs_the_status_line_then_the_hook_installer_pinned_to_this_build() {
        let all: Vec<Vec<String>> = steps(SetupHost::Claude).iter().map(|step| npx_arguments(step, "9.9.9")).collect();
        assert_eq!(all, vec![
            vec!["-y", "openlimiter@9.9.9", "terminal", "install", "claude"],
            vec!["-y", "openlimiter@9.9.9", "hooks", "install", "claude"],
        ]);
    }

    #[test]
    fn antigravity_runs_one_step() {
        assert_eq!(npx_arguments(steps(SetupHost::Antigravity)[0], "1.2.3"), vec!["-y", "openlimiter@1.2.3", "terminal", "install", "antigravity"]);
    }

    #[test]
    fn only_one_setup_runs_at_a_time_and_the_lock_always_comes_back() {
        let first = claim().expect("free");
        assert!(claim().is_none(), "a second setup is refused while one runs");
        assert!(claim().is_none(), "and a refusal does not free the lock for a third");
        drop(first);
        let again = claim().expect("released when the worker ends");
        drop(again);
    }

    #[test]
    fn the_window_names_a_host_from_a_closed_set() {
        assert!(serde_json::from_str::<SetupHost>("\"claude\"").is_ok());
        assert!(serde_json::from_str::<SetupHost>("\"antigravity\"").is_ok());
        assert!(serde_json::from_str::<SetupHost>("\"claude; rm -rf /\"").is_err());
    }
}
