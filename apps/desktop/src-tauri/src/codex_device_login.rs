//! The one sign in this product spawns, and the reasons it is the only one.
//!
//! # What this is
//!
//! `codex login --device-auth` prints a short user code and an address, then
//! waits. Somebody opens the address on any device, types the code, and the
//! Codex client writes its own `auth.json` and exits. This module runs that
//! command with `CODEX_HOME` pointed at a folder OpenLimiter owns, shows the
//! code and the address inside our own window, and watches that folder for the
//! file the client writes.
//!
//! # Why Codex and nothing else
//!
//! Decision D5 of 2026-09-07. The vendor's binary signing somebody in is the
//! vendor's own flow; what is not licensed is reusing the credential it wrote,
//! and Anthropic says so in writing, so Claude gets no spawn here at any
//! price. Google runs no headless login at all. Grok and Kimi would qualify
//! and neither client is installed on the machine this was written on, so
//! their rows say `Verified on install` instead of offering an action nobody
//! has been able to try. That leaves Codex, whose client is Apache licensed
//! and whose device flow is a documented subcommand.
//!
//! # The four things that keep it honest
//!
//! No console window: the code and the address are read from the child's own
//! output and drawn in our window, so nobody is handed a terminal and left to
//! work out what to do with it. A visible cancel that really kills the child.
//! A hard deadline, because a login nobody finished must not leave a process
//! waiting forever. And a version floor, because the subcommand does not exist
//! in older clients and offering an action that cannot work is worse than not
//! offering it.
//!
//! Nothing here ever reads, copies, moves or rewrites a credential file. The
//! only thing this module looks for is whether one appeared.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::cache_write::CacheWriter;
use crate::codex_oauth::CodexOauthRuntime;
use crate::net::ReqwestTransport;
use crate::provider_detection::DetectionStore;
use crate::request_policy::RequestPolicy;

/// The client release that first carried `--device-auth`.
///
/// Measured on this machine on 2026-09-07 against 0.153.3. Below this the
/// subcommand is not there, and a spawn would end in an unreadable error a
/// person cannot act on, so the row offers an upgrade instead.
pub const MINIMUM_CODEX_VERSION: (u64, u64, u64) = (0, 153, 3);

/// How long a login may stay open before it is abandoned.
pub const LOGIN_TIMEOUT_SECONDS: u64 = 180;

/// How long the client has to print its code before it is given up on.
///
/// Much shorter than the login's own deadline, and a different question. The
/// three minutes are for the person walking to another device; this is for the
/// client, which prints its code within a second of starting. Waiting longer
/// only means the command that started it waits longer.
pub const START_TIMEOUT_SECONDS: u64 = 20;

/// The file the client writes when the login succeeded.
const CREDENTIAL_FILE: &str = "auth.json";

/// The most output lines read while waiting for the code and the address.
///
/// The child's output is another product's, so it is read in bounded amounts
/// and only two things are ever taken out of it.
const MAX_SCANNED_LINES: usize = 64;

/// The most characters of one output line kept.
const MAX_LINE_BYTES: usize = 512;

/// What went wrong, in closed kinds a window can render.
///
/// No variant carries a path, a command line or a line of the child's output.
/// A person who cannot sign in needs to know which of these five things
/// happened, and nothing from inside another product's stderr helps them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceLoginFailure {
    /// No Codex client was found on this machine.
    NotInstalled,
    /// The installed client is older than the one that has this subcommand.
    TooOld,
    /// The managed folder could not be created.
    Storage,
    /// The client could not be started.
    Spawn,
    /// The client started and never printed a code.
    NoCode,
}

/// How a login ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeviceLoginState {
    /// Still waiting for somebody to finish at the address.
    Pending,
    /// The client wrote its credential into the managed folder.
    Complete,
    /// Somebody pressed cancel.
    Cancelled,
    /// Nobody finished inside the deadline.
    TimedOut,
    /// The client stopped without writing anything.
    Failed { reason: DeviceLoginFailure },
}

/// What the window draws while a login is open.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginStart {
    /// The short code somebody types at the address.
    pub user_code: String,
    /// Where they type it.
    pub verification_url: String,
    /// How long is left, so the window can count down rather than guess.
    pub expires_in_seconds: u64,
}

/// Whether a version string clears the floor.
///
/// Read off a client this process does not own, so anything that is not three
/// numbers is refused rather than interpreted generously. A client that will
/// not say its version is treated as too old, because the alternative is
/// offering an action that fails in a way nobody can read.
pub fn version_is_supported(value: &str) -> bool {
    let trimmed = value.trim().trim_start_matches('v');
    let head = trimmed
        .split(['-', '+', ' '])
        .next()
        .unwrap_or_default();
    let mut parts = head.split('.');
    let Some(Ok(major)) = parts.next().map(str::parse::<u64>) else {
        return false;
    };
    let Some(Ok(minor)) = parts.next().map(str::parse::<u64>) else {
        return false;
    };
    let Some(Ok(patch)) = parts.next().map(str::parse::<u64>) else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    (major, minor, patch) >= MINIMUM_CODEX_VERSION
}

/// The user code and the address, taken out of the client's own output.
///
/// Both are bounded and validated: the code is short and alphanumeric with
/// hyphens, and the address must be an https URL. A line that carries neither
/// is passed over. A line that carries something claiming to be a URL over
/// plain HTTP is refused outright, because a device code typed into an
/// unencrypted page is a device code somebody else can read.
pub fn scan_line(line: &str, code: &mut Option<String>, url: &mut Option<String>) {
    let line = line.get(..MAX_LINE_BYTES).unwrap_or(line);
    for token in line.split_whitespace() {
        let token = token.trim_matches(|character: char| {
            matches!(character, '"' | '\'' | ',' | '.' | ')' | '(' | ':')
        });
        if url.is_none() && token.starts_with("https://") && token.len() <= 256 {
            *url = Some(token.to_string());
            continue;
        }
        if code.is_none() && is_user_code(token) {
            *code = Some(token.to_string());
        }
    }
}

/// Whether a token looks like a device user code.
///
/// Short, uppercase letters and digits with optional hyphens, and at least one
/// letter, which is what keeps a version number or a port from being mistaken
/// for a code.
fn is_user_code(token: &str) -> bool {
    let length = token.chars().count();
    if !(6..=16).contains(&length) {
        return false;
    }
    let mut letters = 0_usize;
    for character in token.chars() {
        if character.is_ascii_uppercase() {
            letters += 1;
        } else if !character.is_ascii_digit() && character != '-' {
            return false;
        }
    }
    letters > 0
}

/// Where one managed login keeps the client's own configuration.
///
/// Under the product's own state directory, one folder per login, so a login
/// made here can never write into the folder the person's own Codex uses. The
/// identifier is minted by this process and is not accepted from a caller.
pub fn managed_home(session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.len() > 64
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return None;
    }
    Some(
        crate::state::state_directory()?
            .join("accounts")
            .join("codex")
            .join(session_id),
    )
}

/// Whether the client has written its credential into this folder yet.
fn credential_written(home: &Path) -> bool {
    home.join(CREDENTIAL_FILE)
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

/// Where every managed login lives, and the boundary none may leave.
fn accounts_root() -> Option<PathBuf> {
    Some(
        crate::state::state_directory()?
            .join("accounts")
            .join("codex"),
    )
}

/// Whether this path is a reparse point on Windows.
///
/// A junction is not a symbolic link and `is_symlink` has not always reported
/// one, so the attribute itself is read. A folder that redirects somewhere
/// else is refused whichever kind of redirection it is.
#[cfg(windows)]
fn is_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

#[cfg(not(windows))]
fn is_reparse_point(_path: &Path) -> bool {
    false
}

/// Create the folder this login owns, or refuse to.
///
/// The client is about to be told to write a credential here, so the one
/// question worth asking is whether "here" is really here. A folder that
/// already exists as a link, a junction or anything else that redirects is
/// refused rather than followed: somebody who can plant one of those at this
/// path can have the vendor's own client write its credential wherever they
/// like. The real path is resolved after creation and required to sit inside
/// the accounts root, which catches a redirection planted higher up the tree
/// as well as one planted here.
fn prepare_managed_home(home: &Path) -> Result<(), DeviceLoginFailure> {
    let root = accounts_root().ok_or(DeviceLoginFailure::Storage)?;
    if is_reparse_point(home) {
        return Err(DeviceLoginFailure::Storage);
    }
    crate::fsx::ensure_private_dir(home).map_err(|_| DeviceLoginFailure::Storage)?;
    if is_reparse_point(home) {
        return Err(DeviceLoginFailure::Storage);
    }
    let resolved = std::fs::canonicalize(home).map_err(|_| DeviceLoginFailure::Storage)?;
    let resolved_root = std::fs::canonicalize(&root).map_err(|_| DeviceLoginFailure::Storage)?;
    if !resolved.starts_with(&resolved_root) {
        return Err(DeviceLoginFailure::Storage);
    }
    Ok(())
}

/// How the child process is started, behind a trait so no test spawns one.
pub trait DeviceLoginRunner: Send + Sync + 'static {
    /// Start the client's device login with this configuration folder.
    fn start(&self, home: &Path) -> Result<Box<dyn DeviceLoginChild>, DeviceLoginFailure>;
}

/// A running login, from the caller's side.
pub trait DeviceLoginChild: Send {
    /// The next line the client printed, or nothing once the deadline passes
    /// or it stops printing.
    ///
    /// The deadline is the whole reason this takes an argument. A client that
    /// starts and then says nothing is not a client that will say something
    /// later, and waiting on it forever blocks the command that started it.
    fn next_line(&mut self, deadline: Instant) -> Option<String>;
    /// Whether the child has exited.
    fn finished(&mut self) -> bool;
    /// Stop it, whatever it is doing.
    fn stop(&mut self);
}

/// One login in progress.
pub struct DeviceLoginSession {
    home: PathBuf,
    child: Mutex<Box<dyn DeviceLoginChild>>,
    deadline: Instant,
    cancelled: Mutex<bool>,
}

impl DeviceLoginSession {
    /// Start a login and read the code and the address out of its output.
    ///
    /// A client that starts and never prints a code is stopped rather than
    /// left running: it is not going to become useful later, and a process
    /// waiting on a login nobody can complete is a process nobody knows about.
    pub fn start<R: DeviceLoginRunner>(
        runner: &R,
        session_id: &str,
        now: Instant,
    ) -> Result<(Arc<Self>, DeviceLoginStart), DeviceLoginFailure> {
        Self::start_with_timeout(
            runner,
            session_id,
            now,
            Duration::from_secs(LOGIN_TIMEOUT_SECONDS),
        )
    }

    /// `start`, with the deadline itself an argument.
    ///
    /// Tests shrink it to observe, in milliseconds, the backend timer that
    /// enforces it; the public `start` above always passes the real three
    /// minutes.
    fn start_with_timeout<R: DeviceLoginRunner>(
        runner: &R,
        session_id: &str,
        now: Instant,
        timeout: Duration,
    ) -> Result<(Arc<Self>, DeviceLoginStart), DeviceLoginFailure> {
        let home = managed_home(session_id).ok_or(DeviceLoginFailure::Storage)?;
        prepare_managed_home(&home)?;
        let mut child = runner.start(&home)?;
        /* A separate, much shorter deadline than the login's own. The client
        prints its code within a second of starting, so twenty is generous, and
        the alternative is the command that started it waiting on a child that
        will never speak. The three minute deadline is for the person at the
        other device, not for this. */
        let startup = Instant::now() + Duration::from_secs(START_TIMEOUT_SECONDS);
        let mut code = None;
        let mut url = None;
        for _ in 0..MAX_SCANNED_LINES {
            let Some(line) = child.next_line(startup) else {
                break;
            };
            scan_line(&line, &mut code, &mut url);
            if code.is_some() && url.is_some() {
                break;
            }
        }
        /* Every way out of that loop that is not both values kills the child:
        a startup timeout, a stream that closed, output this build could not
        read, and output that ran past the line bound. A client left running
        with nothing watching it is a process nobody knows about. */
        let (Some(user_code), Some(verification_url)) = (code, url) else {
            child.stop();
            return Err(DeviceLoginFailure::NoCode);
        };
        let session = Arc::new(Self {
            home,
            child: Mutex::new(child),
            deadline: now + timeout,
            cancelled: Mutex::new(false),
        });
        arm_deadline_timer(&session, timeout);
        Ok((
            session,
            DeviceLoginStart {
                user_code,
                verification_url,
                expires_in_seconds: timeout.as_secs(),
            },
        ))
    }

    /// Where this login is asked how it is going.
    ///
    /// Success is one thing only: the credential file appeared in the folder
    /// this login owns. Not an exit code, which another product is free to
    /// change, and not a line of output, which is another product's prose.
    pub fn state(&self, now: Instant) -> DeviceLoginState {
        if self.cancelled.lock().is_ok_and(|value| *value) {
            return DeviceLoginState::Cancelled;
        }
        if credential_written(&self.home) {
            self.stop_child();
            return DeviceLoginState::Complete;
        }
        if now >= self.deadline {
            self.cancel();
            return DeviceLoginState::TimedOut;
        }
        let finished = self
            .child
            .lock()
            .map(|mut child| child.finished())
            .unwrap_or(true);
        if finished {
            /* The client stopped and wrote nothing. Checked once more first,
            because it writes the file and exits in that order and this can
            land between the two. */
            if credential_written(&self.home) {
                self.stop_child();
                return DeviceLoginState::Complete;
            }
            return DeviceLoginState::Failed {
                reason: DeviceLoginFailure::NoCode,
            };
        }
        DeviceLoginState::Pending
    }

    /// Stop the login and say so from here on.
    pub fn cancel(&self) {
        if let Ok(mut cancelled) = self.cancelled.lock() {
            *cancelled = true;
        }
        self.stop_child();
    }

    /// Stop the client without marking this login as somebody's own
    /// cancellation.
    ///
    /// Called the moment the credential file is seen, because the client's
    /// own job is done at that point and a process nobody is watching for
    /// its own exit is a process that outlives its usefulness. `cancel`
    /// above is a different ending: it also flips the flag a later poll reads
    /// before it ever checks the credential file, and a completed login must
    /// keep answering Complete on every poll after this one, not Cancelled.
    fn stop_child(&self) {
        if let Ok(mut child) = self.child.lock() {
            child.stop();
        }
    }

    /// The folder this login owns, for the reader that will use it later.
    ///
    /// Nothing in the product build asks yet: the reader picks the folder up
    /// through ordinary detection on the next pass, exactly as it picks up a
    /// login somebody made themselves. It is here because the session is what
    /// knows the answer, and the tests hold it to that.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn home(&self) -> &Path {
        &self.home
    }
}

/// End a login on its own once its deadline passes, whether or not the
/// webview ever asks this session how it is going again.
///
/// The deadline used to fire only as a side effect of `codex_device_login_status`
/// being polled: close the window, or lose the tab, and nothing was left
/// checking the clock, so the client kept running past its own three minutes.
/// One thread, parked for exactly as long as the deadline allows, holding
/// only a weak reference so a login that already ended cannot be kept alive
/// by its own timer. Calling `state` is enough: it already knows how to tell
/// a credential that arrived in time from one that never did, and how to stop
/// the client either way.
fn arm_deadline_timer(session: &Arc<DeviceLoginSession>, timeout: Duration) {
    let session = Arc::downgrade(session);
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        if let Some(session) = session.upgrade() {
            let _ = session.state(Instant::now());
        }
    });
}

/// The real runner.
pub struct SystemDeviceLoginRunner {
    executable: PathBuf,
}

impl SystemDeviceLoginRunner {
    pub fn new(executable: PathBuf) -> Self {
        Self { executable }
    }
}

fn device_login_command(executable: &Path) -> Command {
    #[cfg(windows)]
    if executable.extension().is_some_and(|extension| {
        matches!(
            extension.to_string_lossy().to_ascii_lowercase().as_str(),
            "cmd" | "bat"
        )
    }) {
        /* npm exposes Windows command shims as `.cmd` or `.bat` files. They
           are not direct executables, so route them through cmd.exe while
           keeping the discovered launcher and its arguments bounded. */
        let mut command = Command::new("cmd.exe");
        command
            .args(["/d", "/s", "/c"])
            .arg(format!("\"{}\" login --device-auth", executable.display()));
        return command;
    }

    let mut command = Command::new(executable);
    command.args(["login", "--device-auth"]);
    command
}

/// Send one stream's lines until it ends or nobody is listening.
///
/// Bounded on both counts: a line longer than the bound is truncated rather
/// than held in memory, and the loop stops the moment the receiver is gone,
/// which is what a killed child leaves behind.
fn forward_lines<R: std::io::Read>(stream: R, sender: &std::sync::mpsc::Sender<String>) {
    for line in BufReader::new(stream).lines().map_while(Result::ok) {
        let bounded = line.get(..MAX_LINE_BYTES).unwrap_or(&line).to_string();
        if sender.send(bounded).is_err() {
            return;
        }
    }
}

struct SystemChild {
    child: Child,
    lines: std::sync::mpsc::Receiver<String>,
}

impl Drop for SystemChild {
    /// `std::process::Child`'s own drop forgets the handle and nothing else:
    /// it does not kill the process, which is exactly backwards for a child
    /// this product spawned and nobody outside this file can reach. Every
    /// path that ends a login already calls `stop`, but a session dropped
    /// some other way, a panic unwinding through it included, must not leave
    /// the client running in the background either.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl DeviceLoginChild for SystemChild {
    fn next_line(&mut self, deadline: Instant) -> Option<String> {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        self.lines.recv_timeout(remaining).ok()
    }

    fn finished(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl DeviceLoginRunner for SystemDeviceLoginRunner {
    fn start(&self, home: &Path) -> Result<Box<dyn DeviceLoginChild>, DeviceLoginFailure> {
        let mut command = device_login_command(&self.executable);
        command
            /* The client's own configuration variable, pointed at a folder
            this product owns. The person's own Codex home is never named and
            never touched. */
            .env("CODEX_HOME", home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        suppress_window(&mut command);
        let mut child = command.spawn().map_err(|_| DeviceLoginFailure::Spawn)?;
        /*
         * Both streams, read at the same time.
         *
         * A client is free to print its instructions to either and this build
         * does not get to decide which. These used to be chained, one after
         * the other, which reads as "try stdout, then stderr" and behaves as
         * "block on stdout until it closes". A client that prints its code to
         * stderr and holds stdout open while it waits, which is what waiting
         * for a login looks like, would never have its code read: the command
         * that started it would sit there, and the three minute deadline would
         * never get a chance to fire, because nothing was checking it.
         *
         * One thread per stream, one channel, whoever speaks first is heard.
         * Both threads end on their own when their stream closes, and killing
         * the child closes both.
         */
        let (sender, lines) = std::sync::mpsc::channel();
        if let Some(out) = child.stdout.take() {
            let sender = sender.clone();
            std::thread::spawn(move || forward_lines(out, &sender));
        }
        if let Some(err) = child.stderr.take() {
            let sender = sender.clone();
            std::thread::spawn(move || forward_lines(err, &sender));
        }
        /* The original is dropped so the channel really does end once both
        streams have, rather than staying open on a sender nobody holds. */
        drop(sender);
        Ok(Box::new(SystemChild { child, lines }))
    }
}

#[cfg(windows)]
fn suppress_window(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    /* The code and the address are drawn in our own window, so the client
    itself never needs a console and must never flash one. */
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_window(_command: &mut Command) {}

/// The one login this process holds at a time.
///
/// One, because a second concurrent device login would leave two children
/// waiting on two codes and no way for a person to tell which window belongs
/// to which. Starting a second one ends the first.
#[derive(Default)]
pub struct OpenDeviceLogin {
    open: Mutex<Option<(String, Arc<DeviceLoginSession>)>>,
}

impl OpenDeviceLogin {
    /// Stop whatever login this process is holding, regardless of its id.
    ///
    /// Called from the application's own exit path (`RunEvent::ExitRequested`
    /// in `lib.rs`), where there is no particular session id in scope, only
    /// the fact that the app is going away and a spawned client must not
    /// outlive it.
    pub fn cancel_open(&self) {
        if let Ok(mut held) = self.open.lock() {
            if let Some((_, session)) = held.take() {
                session.cancel();
            }
        }
    }
}

/// Start a Codex device login and hand the window the code and the address.
#[tauri::command]
pub fn codex_device_login_start(
    detection: tauri::State<'_, crate::provider_detection::DetectionStore>,
    open: tauri::State<'_, OpenDeviceLogin>,
) -> Result<serde_json::Value, DeviceLoginFailure> {
    use crate::provider_detection::DetectedProviderId;
    let executable = detection
        .client_executable(DetectedProviderId::Codex)
        .ok_or(DeviceLoginFailure::NotInstalled)?;
    /* A client that will not say its version reads as too old, because the
    subcommand is not there in every build and an action that fails with
    another product's error message is worse than an action that is not
    offered. */
    let stated = detection.client_version(DetectedProviderId::Codex);
    if !stated.as_deref().is_some_and(version_is_supported) {
        return Err(DeviceLoginFailure::TooOld);
    }
    let session_id = uuid::Uuid::new_v4().simple().to_string();
    let runner = SystemDeviceLoginRunner::new(executable);
    let (session, start) = DeviceLoginSession::start(&runner, &session_id, Instant::now())?;
    if let Ok(mut held) = open.open.lock() {
        if let Some((_, previous)) = held.take() {
            previous.cancel();
        }
        *held = Some((session_id.clone(), session));
    }
    let mut payload = serde_json::to_value(&start).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(object) = payload.as_object_mut() {
        object.insert("sessionId".to_string(), serde_json::Value::from(session_id));
    }
    Ok(payload)
}

/// How the open login is going.
#[tauri::command]
pub async fn codex_device_login_status(
    session_id: String,
    detection: State<'_, DetectionStore>,
    open: State<'_, OpenDeviceLogin>,
    runtime: State<'_, CodexOauthRuntime>,
    policy: State<'_, RequestPolicy>,
    transport: State<'_, ReqwestTransport>,
    writer: State<'_, Arc<CacheWriter>>,
) -> Result<DeviceLoginState, DeviceLoginFailure> {
    let held = open
        .open
        .lock()
        .ok()
        .and_then(|held| held.as_ref().filter(|(id, _)| *id == session_id).cloned());
    match held {
        Some((_, session)) => {
            let state = session.state(Instant::now());
            if state == DeviceLoginState::Complete {
                let account_id = detection
                    .register_managed_account(session.home())
                    .ok_or(DeviceLoginFailure::Storage)?;
                let _ = crate::codex_oauth::collect_account_guarded(
                    &detection,
                    &runtime,
                    &policy,
                    &*transport,
                    Arc::clone(&writer),
                    account_id,
                    crate::connections::now_epoch_ms(),
                )
                .await;
            }
            Ok(state)
        }
        /* A login this process is not holding is one that already ended. */
        None => Ok(DeviceLoginState::Cancelled),
    }
}

/// Stop the open login.
#[tauri::command]
pub fn codex_device_login_cancel(session_id: String, open: tauri::State<'_, OpenDeviceLogin>) {
    if let Ok(mut held) = open.open.lock() {
        if held.as_ref().is_some_and(|(id, _)| *id == session_id) {
            if let Some((_, session)) = held.take() {
                session.cancel();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct StubRunner {
        lines: Vec<String>,
        writes_credential: bool,
        /// A client that starts and then says nothing, ever.
        silent: bool,
        stopped: Arc<AtomicBool>,
    }

    struct StubChild {
        lines: std::vec::IntoIter<String>,
        home: PathBuf,
        writes_credential: bool,
        silent: bool,
        stopped: Arc<AtomicBool>,
        exhausted: bool,
    }

    impl DeviceLoginChild for StubChild {
        fn next_line(&mut self, deadline: Instant) -> Option<String> {
            /* The silent client is the whole point of the deadline: it is
            running, it is not going to speak, and the caller must not wait on
            it. Nothing here sleeps, so the suite stays fast. */
            if self.silent || Instant::now() >= deadline {
                return None;
            }
            let next = self.lines.next();
            if next.is_none() {
                self.exhausted = true;
                if self.writes_credential {
                    std::fs::write(self.home.join(CREDENTIAL_FILE), "{\"stub\":true}")
                        .expect("stub credential");
                }
            }
            next
        }

        fn finished(&mut self) -> bool {
            self.exhausted
        }

        fn stop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
        }
    }

    impl DeviceLoginRunner for StubRunner {
        fn start(&self, home: &Path) -> Result<Box<dyn DeviceLoginChild>, DeviceLoginFailure> {
            Ok(Box::new(StubChild {
                lines: self.lines.clone().into_iter(),
                home: home.to_path_buf(),
                writes_credential: self.writes_credential,
                silent: self.silent,
                stopped: Arc::clone(&self.stopped),
                exhausted: false,
            }))
        }
    }

    fn runner(lines: &[&str], writes_credential: bool) -> StubRunner {
        StubRunner {
            lines: lines.iter().map(|line| line.to_string()).collect(),
            writes_credential,
            silent: false,
            stopped: Arc::new(AtomicBool::new(false)),
        }
    }

    fn silent_runner() -> StubRunner {
        StubRunner {
            lines: Vec::new(),
            writes_credential: false,
            silent: true,
            stopped: Arc::new(AtomicBool::new(false)),
        }
    }

    fn started_lines() -> [&'static str; 2] {
        [
            "Open https://auth.openai.com/device",
            "Your code is BDXK-9QTZ",
        ]
    }

    fn session_id() -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }

    #[test]
    fn only_a_client_new_enough_to_have_the_subcommand_is_offered_it() {
        for supported in ["0.153.3", "0.153.4", "0.154.0", "1.0.0", "v0.153.3"] {
            assert!(version_is_supported(supported), "{supported} was refused");
        }
        for refused in [
            "0.153.2", "0.152.9", "0.1.0", "", "0.153", "not a version", "0.153.3.1",
        ] {
            assert!(!version_is_supported(refused), "{refused} was accepted");
        }
    }

    #[test]
    fn the_code_and_the_address_are_the_only_things_taken_from_the_output() {
        let mut code = None;
        let mut url = None;
        scan_line("Open https://auth.openai.com/device and enter", &mut code, &mut url);
        scan_line("Your code is BDXK-9QTZ", &mut code, &mut url);
        assert_eq!(url.as_deref(), Some("https://auth.openai.com/device"));
        assert_eq!(code.as_deref(), Some("BDXK-9QTZ"));
    }

    /// A code typed into an unencrypted page is a code somebody else can read,
    /// and a version number is not a code.
    #[test]
    fn plain_http_and_lookalikes_are_refused() {
        let mut code = None;
        let mut url = None;
        scan_line("Open http://auth.openai.com/device", &mut code, &mut url);
        scan_line("codex 0.153.3 starting", &mut code, &mut url);
        scan_line("listening on 127.0.0.1:1455", &mut code, &mut url);
        assert_eq!(url, None);
        assert_eq!(code, None);
    }

    #[test]
    fn a_managed_home_is_never_the_persons_own_codex_folder() {
        let id = session_id();
        let home = managed_home(&id).expect("a managed home");
        assert!(home.ends_with(Path::new("accounts").join("codex").join(&id)));
        /* An identifier this process did not mint never becomes a path. */
        for hostile in ["", "..", "../codex", "A", "with space", &"a".repeat(65)] {
            assert_eq!(managed_home(hostile), None, "{hostile} became a path");
        }
    }

    /// A client that starts and says nothing must not hold the caller.
    ///
    /// The startup deadline is separate from the login's own three minutes,
    /// and it exists because the command that starts a login is synchronous:
    /// waiting on a silent child there hangs the window, and the three minute
    /// deadline never fires because nothing is checking it.
    #[test]
    fn a_client_that_never_speaks_is_given_up_on_and_killed() {
        let stub = silent_runner();
        let stopped = Arc::clone(&stub.stopped);
        let error = DeviceLoginSession::start(&stub, &session_id(), Instant::now())
            .err()
            .expect("a silent client is a failure");
        assert_eq!(error, DeviceLoginFailure::NoCode);
        assert!(stopped.load(Ordering::SeqCst));
        /* Twenty seconds for the client, three minutes for the person. */
        assert_eq!(START_TIMEOUT_SECONDS, 20);
        assert_eq!(LOGIN_TIMEOUT_SECONDS, 180);
    }

    /// Spawning a child can be slow; the 20 second startup timer starts after
    /// the child process has spawned, not before, so a slow spawn does not
    /// eat into the client's startup budget.
    #[test]
    fn a_slow_spawn_starts_the_startup_timer_after_the_child_has_spawned() {
        struct SlowRunner {
            inner: StubRunner,
            observed_deadline: Arc<Mutex<Option<Instant>>>,
            spawned_at: Arc<Mutex<Option<Instant>>>,
        }
        struct SlowChild {
            inner: Box<dyn DeviceLoginChild>,
            observed_deadline: Arc<Mutex<Option<Instant>>>,
        }
        impl DeviceLoginChild for SlowChild {
            fn next_line(&mut self, deadline: Instant) -> Option<String> {
                if let Ok(mut slot) = self.observed_deadline.lock() {
                    *slot = Some(deadline);
                }
                self.inner.next_line(deadline)
            }
            fn finished(&mut self) -> bool {
                self.inner.finished()
            }
            fn stop(&mut self) {
                self.inner.stop();
            }
        }
        impl DeviceLoginRunner for SlowRunner {
            fn start(&self, home: &Path) -> Result<Box<dyn DeviceLoginChild>, DeviceLoginFailure> {
                std::thread::sleep(Duration::from_millis(20));
                if let Ok(mut slot) = self.spawned_at.lock() {
                    *slot = Some(Instant::now());
                }
                let child = self.inner.start(home)?;
                Ok(Box::new(SlowChild {
                    inner: child,
                    observed_deadline: Arc::clone(&self.observed_deadline),
                }))
            }
        }

        let observed_deadline = Arc::new(Mutex::new(None));
        let spawned_at = Arc::new(Mutex::new(None));
        let stub = SlowRunner {
            inner: runner(&started_lines(), false),
            observed_deadline: Arc::clone(&observed_deadline),
            spawned_at: Arc::clone(&spawned_at),
        };
        let before_spawn = Instant::now() - Duration::from_secs(START_TIMEOUT_SECONDS + 5);
        let (_session, start) = DeviceLoginSession::start(&stub, &session_id(), before_spawn)
            .expect("a started login even when pre-spawn instant is old");
        assert_eq!(start.user_code, "BDXK-9QTZ");
        let spawned = spawned_at.lock().unwrap().expect("spawned time");
        let deadline = observed_deadline.lock().unwrap().expect("observed deadline");
        assert!(deadline >= spawned + Duration::from_secs(START_TIMEOUT_SECONDS));
    }

    /// Output this build cannot read is output it stops for.
    #[test]
    fn output_that_carries_neither_value_kills_the_client() {
        let stub = runner(
            &[
                "codex 0.153.3 starting",
                "Open http://auth.openai.com/device",
                "listening on 127.0.0.1:1455",
            ],
            false,
        );
        let stopped = Arc::clone(&stub.stopped);
        let error = DeviceLoginSession::start(&stub, &session_id(), Instant::now())
            .err()
            .expect("unreadable output is a failure");
        assert_eq!(error, DeviceLoginFailure::NoCode);
        assert!(stopped.load(Ordering::SeqCst));
    }

    /// A folder that redirects somewhere else is refused, not followed.
    ///
    /// Somebody who can plant a link or a junction at this path can have the
    /// vendor's own client write its credential wherever they like, so the
    /// path is checked before the client is ever started.
    #[test]
    fn a_managed_home_that_redirects_is_refused() {
        let dir = TempDir::new();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).expect("a target");
        let id = session_id();
        let home = managed_home(&id).expect("a managed home");
        std::fs::create_dir_all(home.parent().expect("the accounts root")).expect("the root");

        let linked = link_dir(&elsewhere, &home);
        if !linked {
            /* This machine does not let this process create one, which is
            itself a machine on which the attack does not exist. The path
            checks are still exercised by the tests above and below. */
            return;
        }
        assert!(is_reparse_point(&home));
        assert_eq!(
            prepare_managed_home(&home).err(),
            Some(DeviceLoginFailure::Storage)
        );
        let stub = runner(&started_lines(), false);
        assert_eq!(
            DeviceLoginSession::start(&stub, &id, Instant::now()).err(),
            Some(DeviceLoginFailure::Storage),
            "a redirected home still started the client"
        );
        assert!(
            !stub.stopped.load(Ordering::SeqCst),
            "the client was started before the path was checked"
        );
        let _ = std::fs::remove_dir(&home);
    }

    /// Create a directory link, and say whether this machine allowed it.
    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/d", "/s", "/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
    }

    #[cfg(not(windows))]
    fn link_dir(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    /// A prepared home is private, and inside the accounts root.
    #[test]
    fn a_prepared_home_is_owner_only_and_inside_the_accounts_root() {
        let id = session_id();
        let home = managed_home(&id).expect("a managed home");
        prepare_managed_home(&home).expect("a preparable home");
        assert!(home.is_dir());
        let root = accounts_root().expect("an accounts root");
        assert!(std::fs::canonicalize(&home)
            .expect("a real path")
            .starts_with(std::fs::canonicalize(&root).expect("a real root")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&home).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_login_that_prints_no_code_is_stopped_rather_than_left_running() {
        let stub = runner(&["starting", "please wait"], false);
        let stopped = Arc::clone(&stub.stopped);
        let error = DeviceLoginSession::start(&stub, &session_id(), Instant::now())
            .err()
            .expect("no code is a failure");
        assert_eq!(error, DeviceLoginFailure::NoCode);
        assert!(stopped.load(Ordering::SeqCst));
    }

    #[test]
    fn success_is_the_credential_appearing_and_nothing_else() {
        let stub = runner(
            &[
                "Open https://auth.openai.com/device",
                "Your code is BDXK-9QTZ",
            ],
            true,
        );
        let stopped = Arc::clone(&stub.stopped);
        let (session, start) = DeviceLoginSession::start(&stub, &session_id(), Instant::now())
            .expect("a started login");
        assert_eq!(start.user_code, "BDXK-9QTZ");
        assert_eq!(start.verification_url, "https://auth.openai.com/device");
        assert_eq!(start.expires_in_seconds, LOGIN_TIMEOUT_SECONDS);
        /* Nothing has been written yet, so it is still waiting. */
        assert_eq!(session.state(Instant::now()), DeviceLoginState::Pending);
        std::fs::write(session.home().join(CREDENTIAL_FILE), "{\"stub\":true}")
            .expect("stub credential");
        assert_eq!(session.state(Instant::now()), DeviceLoginState::Complete);
        /* Complete stops the client on its own: nobody had to cancel it for
        that to happen. */
        assert!(stopped.load(Ordering::SeqCst));
        /* And a completed login stays completed on a later poll, rather than
        reading as the person's own cancellation because stopping the client
        happens to share code with `cancel`. */
        assert_eq!(session.state(Instant::now()), DeviceLoginState::Complete);
    }

    #[test]
    fn cancel_stops_the_client_and_the_state_says_so() {
        let stub = runner(
            &[
                "Open https://auth.openai.com/device",
                "Your code is BDXK-9QTZ",
            ],
            false,
        );
        let stopped = Arc::clone(&stub.stopped);
        let (session, _) = DeviceLoginSession::start(&stub, &session_id(), Instant::now())
            .expect("a started login");
        session.cancel();
        assert!(stopped.load(Ordering::SeqCst));
        assert_eq!(session.state(Instant::now()), DeviceLoginState::Cancelled);
    }

    /// A login nobody finished must not leave a process waiting forever.
    #[test]
    fn the_deadline_ends_it_and_takes_the_client_with_it() {
        let stub = runner(
            &[
                "Open https://auth.openai.com/device",
                "Your code is BDXK-9QTZ",
            ],
            false,
        );
        let stopped = Arc::clone(&stub.stopped);
        let started = Instant::now();
        let (session, _) =
            DeviceLoginSession::start(&stub, &session_id(), started).expect("a started login");
        let after = started + Duration::from_secs(LOGIN_TIMEOUT_SECONDS + 1);
        assert_eq!(session.state(after), DeviceLoginState::TimedOut);
        assert!(stopped.load(Ordering::SeqCst));
        assert_eq!(LOGIN_TIMEOUT_SECONDS, 180);
    }

    /// A credential that arrives right on the deadline still counts. The
    /// alternative is telling somebody who just finished that they did not.
    #[test]
    fn a_credential_written_at_the_deadline_still_counts() {
        let stub = runner(
            &[
                "Open https://auth.openai.com/device",
                "Your code is BDXK-9QTZ",
            ],
            false,
        );
        let started = Instant::now();
        let (session, _) =
            DeviceLoginSession::start(&stub, &session_id(), started).expect("a started login");
        std::fs::write(session.home().join(CREDENTIAL_FILE), "{\"stub\":true}")
            .expect("stub credential");
        let after = started + Duration::from_secs(LOGIN_TIMEOUT_SECONDS + 1);
        assert_eq!(session.state(after), DeviceLoginState::Complete);
    }

    /// The whole point of the backend timer: a login nobody polls again must
    /// still end on its own, because closing the window is not a poll.
    #[test]
    fn the_backend_timer_ends_a_login_nobody_polls_again() {
        let stub = runner(
            &[
                "Open https://auth.openai.com/device",
                "Your code is BDXK-9QTZ",
            ],
            false,
        );
        let stopped = Arc::clone(&stub.stopped);
        let (session, _) = DeviceLoginSession::start_with_timeout(
            &stub,
            &session_id(),
            Instant::now(),
            Duration::from_millis(20),
        )
        .expect("a started login");
        /* Nothing here ever calls session.state() again: the timer is the
        only thing watching the clock from here on. */
        std::thread::sleep(Duration::from_millis(200));
        assert!(stopped.load(Ordering::SeqCst));
        drop(session);
    }

    /// A credential that beat the timer to it is still a success: the timer
    /// calls the same `state` a poll would, and `state` checks the file
    /// before it ever checks the clock.
    #[test]
    fn the_backend_timer_leaves_a_completed_login_completed() {
        let stub = runner(
            &[
                "Open https://auth.openai.com/device",
                "Your code is BDXK-9QTZ",
            ],
            false,
        );
        let (session, _) = DeviceLoginSession::start_with_timeout(
            &stub,
            &session_id(),
            Instant::now(),
            Duration::from_millis(20),
        )
        .expect("a started login");
        std::fs::write(session.home().join(CREDENTIAL_FILE), "{\"stub\":true}")
            .expect("stub credential");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(session.state(Instant::now()), DeviceLoginState::Complete);
    }

    #[test]
    fn cancel_open_stops_whatever_is_open_with_no_session_id_in_hand() {
        let stub = runner(
            &[
                "Open https://auth.openai.com/device",
                "Your code is BDXK-9QTZ",
            ],
            false,
        );
        let stopped = Arc::clone(&stub.stopped);
        let (session, _) = DeviceLoginSession::start(&stub, &session_id(), Instant::now())
            .expect("a started login");
        let open = OpenDeviceLogin {
            open: Mutex::new(Some(("whatever-id".to_string(), session))),
        };
        /* The app's own exit path, which has no session id to pass, exactly
        the case codex_device_login_cancel cannot serve on its own. */
        open.cancel_open();
        assert!(stopped.load(Ordering::SeqCst));
        assert!(open.open.lock().unwrap().is_none());
    }

    #[test]
    fn every_failure_kind_crosses_the_boundary_closed_and_payload_free() {
        let _ = TempDir::new();
        for failure in [
            DeviceLoginFailure::NotInstalled,
            DeviceLoginFailure::TooOld,
            DeviceLoginFailure::Storage,
            DeviceLoginFailure::Spawn,
            DeviceLoginFailure::NoCode,
        ] {
            let rendered = serde_json::to_string(&failure).expect("a closed kind");
            assert!(!rendered.contains('/'), "{rendered} carries a path");
            assert!(!rendered.contains('\\'), "{rendered} carries a path");
        }
        assert_eq!(
            serde_json::to_value(DeviceLoginState::Failed {
                reason: DeviceLoginFailure::TooOld
            })
            .expect("a closed state"),
            serde_json::json!({ "kind": "failed", "reason": "too_old" })
        );
    }
}
