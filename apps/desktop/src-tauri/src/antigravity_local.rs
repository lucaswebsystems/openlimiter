//! Ask the Antigravity client already running on this machine.
//!
//! # Why this exists at all
//!
//! Google's Code Assist metadata plane answers the companion project, and so
//! the quota, only to a request that claims to be one of Google's own clients.
//! This build used to make that claim: `net.rs` pinned
//! `antigravity/cli/1.1.15 <os>/<arch>` and the bar worked. Decision D5 of
//! 2026-09-07 forbids it, and the honest request gets an answer with no
//! project in it, which is a bar that cannot be drawn.
//!
//! So the reading is taken somewhere else. A running `agy` binds two loopback
//! ports, one TLS with a certificate it signed itself and one plain HTTP, and
//! answers its own quota summary route on both with no authorization header,
//! no cross site token and no Google identity of any kind. Verified live on
//! this machine on 2026-09-07: it answered 200 to a request identifying as
//! OpenLimiter. Its own log shows it caching that summary, so this probe reads
//! Antigravity's cache and never Google.
//!
//! # Why that is a different act from the one D5 forbids
//!
//! Nothing here claims to be anybody. The request identifies as OpenLimiter,
//! carries no credential, and never leaves the loopback interface. It reads a
//! number a program on this machine is already showing its own user, which is
//! the same thing the Claude Code status line does and the same thing every
//! reader in this product is allowed to do. There is no vendor client id, no
//! copied user agent, no token, and nothing to intermediate.
//!
//! # The bounds that keep it narrow
//!
//! A process that probes loopback ports is a process that can be pointed at
//! something it should not touch, so it is fenced on every side. A port is
//! addressed only when the process listening on it is running as this user,
//! is called `agy`, and its real executable path sits somewhere software
//! legitimately lives: a name alone is not evidence, because any process can
//! take any name, and that was the whole of the check in the first version of
//! this file. Only the one constant path below is ever requested, with one
//! constant body, and a body that does not parse is treated as no answer
//! rather than as data. Certificate
//! verification is disabled for these requests and only these requests,
//! through a client built here and reachable from nowhere else, because the
//! certificate is one `agy` signed for itself and no certificate authority
//! will ever vouch for it. Sending nothing secret over that connection is what
//! makes turning verification off affordable.
//!
//! # What this does not do
//!
//! It never starts `agy`. A quota reading is not worth launching another
//! company's application behind somebody's back, and a client that is not
//! running is a fact the row states rather than a problem the product solves.

#[cfg(not(windows))]
use std::collections::BTreeMap;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// The one route this module requests, verbatim.
pub const QUOTA_SUMMARY_PATH: &str =
    "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

/// The protocol version header the Connect based service requires.
pub const CONNECT_PROTOCOL_HEADER: &str = "connect-protocol-version";

/// The only value that header ever carries.
pub const CONNECT_PROTOCOL_VERSION: &str = "1";

/// The one body this module sends. The route takes no arguments.
pub const QUOTA_SUMMARY_BODY: &str = "{}";

/// The process name whose listening ports may be addressed.
///
/// The one fence that keeps this from being a port scan: a port nobody named
/// `agy` is listening on is never addressed, whatever else is bound there.
pub const AGY_PROCESS_NAME: &str = if cfg!(windows) { "agy.exe" } else { "agy" };

/// How long one probe may take before it is abandoned.
///
/// This is a request to a program on the same machine that has the answer
/// cached. A whole second is already generous, and four is the point at which
/// waiting longer is worse than reporting that nothing answered.
const PROBE_TIMEOUT_SECONDS: u64 = 4;

/// How long the port enumeration may take before it is abandoned.
const ENUMERATION_TIMEOUT_SECONDS: u64 = 5;

/// The most ports one pass will address.
///
/// A healthy client binds two. The bound exists because the list is built from
/// the output of a program this process does not own, and a list that grew
/// without limit would turn one bad parse into a port scan.
const MAX_PROBE_PORTS: usize = 8;

/// The most output read from an enumeration command.
///
/// A busy machine's connection table is large, and this is read into memory.
const MAX_ENUMERATION_BYTES: usize = 512 * 1024;

/// The most bytes accepted from one quota summary answer.
const MAX_BODY_BYTES: usize = 256 * 1024;

/// How long the whole enumeration may take before it is abandoned.
///
/// Every tool it calls is bounded on its own, but the budget is stated once
/// here as well: this runs on the collector, and a collector that waits on an
/// inventory tool is a tray that stops ticking.
const ENUMERATION_BUDGET_SECONDS: u64 = 8;

/// Where the loopback ports come from.
///
/// Behind a trait so a test states the ports rather than depending on whether
/// an Antigravity happens to be running on the machine running the suite.
/// `Clone` because the answer is fetched on a blocking thread, which needs
/// something it can own.
pub trait AgyPorts: Clone + Send + Sync + 'static {
    /// Ports a verified `agy` is listening on, on the loopback address.
    fn listening(&self) -> Vec<u16>;
}

/// The enumeration, off the async runtime and under a deadline.
///
/// `listening` shells out to the operating system's own inventory tools, which
/// is blocking work measured in hundreds of milliseconds and occasionally in
/// seconds. Running it inline on the collector's runtime stalls every other
/// provider behind it and freezes the tray. A budget that expires yields no
/// ports, which the caller reads as no client running, which is the same
/// honest answer a machine with no Antigravity gives.
pub async fn listening_ports<P: AgyPorts>(ports: &P) -> Vec<u16> {
    let owned = ports.clone();
    let task = tauri::async_runtime::spawn_blocking(move || owned.listening());
    match tokio::time::timeout(Duration::from_secs(ENUMERATION_BUDGET_SECONDS), task).await {
        Ok(Ok(found)) => found,
        _ => Vec::new(),
    }
}

/// The one request this module makes.
///
/// Behind a trait for the same reason `Transport` is: no test opens a socket.
pub trait LoopbackProbe: Send + Sync {
    fn quota_summary(&self, port: u16) -> impl Future<Output = Option<String>> + Send;
}

/// What one pass of the local read found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalRead {
    /// A running client answered, and this is what it said.
    Answered { body: String },
    /// Nothing on this machine answered, which is almost always because
    /// Antigravity is not running.
    NoClient,
}

/// The sentence the row carries when no client answered.
///
/// It names the one action that fixes it and claims nothing about why. We do
/// not start `agy` ourselves, so the person is the only one who can.
pub const NO_CLIENT_SENTENCE: &str = "Open Antigravity once to refresh";

/// Take the first answer the caller can actually read.
///
/// `accept` is the caller's parser, and it is the difference between "an
/// answer" and "an answer worth having". Without it the first body off the
/// first port ended the search, so one port answering with something this
/// build cannot read stopped the loop and the row went stale while the very
/// next port was serving the real summary. A body that does not parse is not
/// data and is not a reason to stop: it is treated as no answer, and the
/// remaining ports are still tried.
pub async fn read_quota_summary<P: AgyPorts, T: LoopbackProbe>(
    ports: &P,
    probe: &T,
    accept: impl Fn(&str) -> bool,
) -> LocalRead {
    let mut listening = listening_ports(ports).await;
    listening.sort_unstable();
    listening.dedup();
    listening.truncate(MAX_PROBE_PORTS);
    for port in listening {
        let Some(body) = probe.quota_summary(port).await else {
            continue;
        };
        if accept(&body) {
            return LocalRead::Answered { body };
        }
    }
    LocalRead::NoClient
}

/// Run one command and read at most a bounded amount of its output.
///
/// The command is an operating system inventory tool with a constant argument
/// list. It is bounded in time as well as in bytes, because this runs on a
/// collector task and a tool that hangs must not take the collector with it.
fn bounded_output(program: &str, arguments: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    suppress_window(&mut command);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    /* Reading on another thread is what makes the deadline real: a child that
    never writes and never exits would otherwise block this thread forever. */
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout
            .by_ref()
            .take(MAX_ENUMERATION_BYTES as u64)
            .read_to_end(&mut buffer);
        let _ = sender.send(buffer);
    });
    let read = receiver.recv_timeout(Duration::from_secs(ENUMERATION_TIMEOUT_SECONDS));
    let _ = child.kill();
    let _ = child.wait();
    String::from_utf8(read.ok()?).ok()
}

#[cfg(windows)]
fn suppress_window(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    /* An inventory probe must never flash a console window at somebody who is
    working. */
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_window(_command: &mut Command) {}

/// Whether a socket address names the loopback interface, and on which port.
///
/// Only loopback is accepted. A client that bound a routable address is not
/// something this product reads over the network, and the whole argument for
/// disabling certificate verification below is that the connection never
/// leaves the machine.
pub(crate) fn loopback_port(address: &str) -> Option<u16> {
    let (host, port) = address.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host != "127.0.0.1" && host != "::1" {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    (port != 0).then_some(port)
}

/// Directories a real Antigravity may have been installed into.
///
/// # Why a list of roots and not a list of exact paths
///
/// The honest position is that this repository has no verified install path
/// for the vendor's client. Writing one down from memory would be a guess that
/// breaks the reader on every machine that installed it somewhere else, which
/// is worse than the problem it is meant to solve. What can be stated without
/// guessing is where software legitimately lives on this operating system, so
/// that is the fence: a binary called `agy` sitting in a program directory or
/// a package manager's bin directory is plausibly the vendor's, and one
/// sitting in a downloads folder, a temporary directory or a shared drive is
/// not something this process starts talking to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TargetPlatform {
    Windows,
    Macos,
    Linux,
}

impl TargetPlatform {
    pub(crate) fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

pub(crate) fn roots_for_platform(
    platform: TargetPlatform,
    home: Option<&Path>,
    local_app_data: Option<&Path>,
    /* %APPDATA% itself is never a root: see the comment on the Windows arm
    below. The parameter stays, unused, rather than reshaping every call site
    (including `install_roots` and this file's own tests) around its removal. */
    _app_data: Option<&Path>,
    program_files: &[Option<&Path>],
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    match platform {
        TargetPlatform::Windows => {
            /* The bare %LOCALAPPDATA% and %APPDATA% roots are refused on
            purpose: both are where a browser download, an archive extraction
            or an installer's own temp files land too, not only where software
            legitimately lives. Their `Programs` subfolder is the actual
            install location and stays; the two broad parents around it do
            not, so an executable planted anywhere else under either one is
            never mistaken for the real client. */
            if let Some(lad) = local_app_data {
                roots.push(lad.join("Programs"));
            }
            for pf in program_files.iter().flatten() {
                roots.push(pf.to_path_buf());
            }
            if let Some(h) = home {
                roots.push(h.join("bin"));
                roots.push(h.join("Applications"));
            }
        }
        TargetPlatform::Macos => {
            if let Some(h) = home {
                roots.push(h.join("Applications"));
                roots.push(h.join("bin"));
                roots.push(h.join(".local"));
                roots.push(h.join(".nvm"));
            }
            for fixed in ["/Applications", "/usr/bin", "/usr/local", "/opt"] {
                roots.push(PathBuf::from(fixed));
            }
        }
        TargetPlatform::Linux => {
            if let Some(h) = home {
                roots.push(h.join(".local").join("bin"));
                roots.push(h.join("bin"));
                roots.push(h.join("Applications"));
                roots.push(h.join(".local"));
                roots.push(h.join(".nvm"));
            }
            for fixed in ["/opt", "/usr/local", "/usr/bin", "/snap"] {
                roots.push(PathBuf::from(fixed));
            }
        }
    }
    roots
}

fn install_roots() -> Vec<PathBuf> {
    let home = crate::state::home();
    let local_app_data = crate::state::non_empty("LOCALAPPDATA");
    let app_data = crate::state::non_empty("APPDATA");
    let pf1 = crate::state::non_empty("ProgramFiles");
    let pf2 = crate::state::non_empty("ProgramFiles(x86)");
    let pf3 = crate::state::non_empty("ProgramW6432");
    let pfs = [pf1.as_deref(), pf2.as_deref(), pf3.as_deref()];
    roots_for_platform(
        TargetPlatform::current(),
        home.as_deref(),
        local_app_data.as_deref(),
        app_data.as_deref(),
        &pfs,
    )
}

/// Whether this executable path may be talked to.
///
/// Two questions, both cheap: is the file actually named after the vendor's
/// client, and does it live somewhere software lives. A process is free to
/// call itself `agy.exe` from anywhere, and the name alone was the whole of
/// the check before this, so anything that could start a process could have
/// this build POST to a port of its choosing on loopback.
pub(crate) fn trusted_agy_executable(path: &Path, roots: &[PathBuf]) -> bool {
    let named = path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("agy") || value.eq_ignore_ascii_case("agy.exe")
        });
    if !named {
        return false;
    }
    /* A relative path is a path this build cannot reason about, and a path
    with a parent traversal in it is one somebody wrote to get past exactly
    this check. */
    if !(path.is_absolute() || path.has_root())
        || path.components().any(|part| part.as_os_str() == "..")
    {
        return false;
    }
    roots.iter().any(|root| path.starts_with(root))
}

/// Loopback ports a `netstat` report shows those processes listening on.
///
/// # Why not the state word
///
/// This used to require the protocol column to read `TCP` and the state column
/// to read `LISTENING`. Both are translated: a Windows installed in Portuguese
/// says `ESCUTANDO`, a German one says `ABHOEREN`, and on either of those this
/// found nothing at all and the row said Antigravity was closed while it was
/// running. The columns that are not translated are the numbers, so those are
/// what the parse leans on: a listening row is the one with five columns whose
/// foreign address is the wildcard and whose owning process is one of ours.
/// A row in any other state names a real peer there instead.
#[cfg(windows)]
pub(crate) fn netstat_ports(report: &str, pids: &[u32]) -> Vec<u16> {
    let mut ports = Vec::new();
    for line in report.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        /* Protocol, local address, foreign address, state, owning process.
        A UDP row has four columns and no state, so the count alone rules it
        out without reading the protocol word. */
        if fields.len() != 5 {
            continue;
        }
        let Ok(owner) = fields[4].parse::<u32>() else {
            continue;
        };
        if !pids.contains(&owner) {
            continue;
        }
        /* The wildcard peer is what "nobody is connected to this yet" looks
        like in every language, and it is the only shape a listener has. */
        if !matches!(fields[2], "0.0.0.0:0" | "[::]:0" | "*:*") {
            continue;
        }
        if let Some(port) = loopback_port(fields[1]) {
            ports.push(port);
        }
    }
    ports
}

/// Which process is listening on which loopback port, per `lsof`.
///
/// The report is grouped: a `p` record opens a process and the `n` records
/// after it belong to that process until the next `p`. `lsof` has no field for
/// an executable path, so the pairing is what matters here and the executable
/// is resolved separately, per process, below. It matched on a command name,
/// which any process can take, so nothing is trusted on the strength of it.
#[cfg(not(windows))]
pub(crate) fn lsof_pid_ports(report: &str) -> Vec<(u32, u16)> {
    let mut found = Vec::new();
    let mut current: Option<u32> = None;
    for line in report.lines() {
        if let Some(pid) = line.strip_prefix('p') {
            current = pid.trim().parse::<u32>().ok();
            continue;
        }
        let Some(name) = line.strip_prefix('n') else {
            continue;
        };
        let Some(pid) = current else {
            continue;
        };
        if let Some(port) = loopback_port(name.trim()) {
            found.push((pid, port));
        }
    }
    found
}

/// The real executable behind a process identifier.
///
/// Linux states it in the process table itself, which costs nothing and cannot
/// be spoofed by the process. Everywhere else it is asked for by name, and a
/// machine that will not answer yields nothing, which refuses the process
/// rather than trusting it.
#[cfg(target_os = "linux")]
fn executable_of(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn executable_of(pid: u32) -> Option<PathBuf> {
    let report = bounded_output("ps", &["-o", "comm=", "-p", &pid.to_string()])?;
    let line = report.lines().next()?.trim();
    (!line.is_empty()).then(|| PathBuf::from(line))
}

/// The real enumeration, asking the operating system what is listening.
#[derive(Clone, Copy)]
pub struct SystemAgyPorts;

/// Process identifiers and executable paths from the owned process report.
///
/// One record per line, `pid|path`, which is the shape the query below is
/// asked to print. A line this build cannot read costs that process and
/// nothing else.
#[cfg(windows)]
pub(crate) fn owned_agy_pids(report: &str, roots: &[PathBuf]) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in report.lines() {
        let Some((pid, path)) = line.trim().split_once('|') else {
            continue;
        };
        let Ok(pid) = pid.trim().parse::<u32>() else {
            continue;
        };
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        if trusted_agy_executable(Path::new(path), roots) {
            pids.push(pid);
        }
    }
    pids
}

#[cfg(windows)]
impl AgyPorts for SystemAgyPorts {
    fn listening(&self) -> Vec<u16> {
        /*
         * The processes worth talking to, and only those.
         *
         * Three questions in one query, because all three are load bearing and
         * `tasklist` answers none of them. It filters by image name, which is
         * a name any process can take, so a process called `agy.exe` started
         * from anywhere used to be enough to have this build POST to a
         * loopback port of somebody else's choosing.
         *
         * The query names the image, reads the real executable path, and asks
         * the process for its owner so a service or another account's session
         * on a shared machine is not addressed. The output shape is fixed and
         * numeric, so no part of this depends on the language Windows was
         * installed in.
         */
        let query = concat!(
            "$ErrorActionPreference='SilentlyContinue';",
            "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name;",
            "Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | ForEach-Object {",
            "$owner=(Invoke-CimMethod -InputObject $_ -MethodName GetOwner);",
            "if ($owner -and $owner.User -and ",
            "(\"$($owner.Domain)\\$($owner.User)\" -eq $me)) {",
            "\"$($_.ProcessId)|$($_.ExecutablePath)\" } }"
        );
        let Some(report) = bounded_output(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", query],
        ) else {
            return Vec::new();
        };
        let pids = owned_agy_pids(&report, &install_roots());
        if pids.is_empty() {
            return Vec::new();
        }
        let Some(connections) = bounded_output("netstat", &["-ano", "-p", "TCP"]) else {
            return Vec::new();
        };
        netstat_ports(&connections, &pids)
    }
}

#[cfg(not(windows))]
impl AgyPorts for SystemAgyPorts {
    fn listening(&self) -> Vec<u16> {
        /* `lsof` is the one tool that answers this question in a single call on
        both macOS and Linux. A machine without it enumerates nothing, which is
        the same answer as a machine with no Antigravity running, and the row
        says the same honest thing either way.

        Scoped to this user where the machine states one, so another account's
        session on a shared machine is never addressed. */
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .ok()
            .filter(|value| !value.is_empty());
        let mut arguments: Vec<&str> = vec![
            "-nP",
            "-iTCP",
            "-sTCP:LISTEN",
            "-a",
            "-c",
            AGY_PROCESS_NAME,
            "-F",
            "pn",
        ];
        if let Some(user) = user.as_deref() {
            arguments.push("-u");
            arguments.push(user);
        }
        let Some(report) = bounded_output("lsof", &arguments) else {
            return Vec::new();
        };
        /* `lsof` matched a command name, which any process can take, so every
        process it named is asked what it actually is before its ports are
        addressed. One resolution per process, not per port. */
        let roots = install_roots();
        let mut verified: BTreeMap<u32, bool> = BTreeMap::new();
        let mut ports = Vec::new();
        for (pid, port) in lsof_pid_ports(&report) {
            let trusted = *verified.entry(pid).or_insert_with(|| {
                executable_of(pid)
                    .is_some_and(|path| trusted_agy_executable(&path, &roots))
            });
            if trusted {
                ports.push(port);
            }
        }
        ports
    }
}

/// The real probe.
///
/// Two clients, both built here and reachable from nowhere else. The plain one
/// is ordinary. The TLS one has certificate verification off, which is stated
/// plainly rather than buried: the certificate belongs to a program on this
/// machine that signed it for itself, no authority will ever vouch for it, and
/// the connection carries no credential in either direction.
pub struct SystemLoopbackProbe {
    secure: Option<reqwest::Client>,
    plain: Option<reqwest::Client>,
}

impl Default for SystemLoopbackProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemLoopbackProbe {
    pub fn new() -> Self {
        let timeout = Duration::from_secs(PROBE_TIMEOUT_SECONDS);
        Self {
            secure: reqwest::Client::builder()
                .timeout(timeout)
                .danger_accept_invalid_certs(true)
                .build()
                .ok(),
            plain: reqwest::Client::builder().timeout(timeout).build().ok(),
        }
    }

    async fn ask(client: Option<&reqwest::Client>, url: &str) -> Option<String> {
        let response = client?
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(CONNECT_PROTOCOL_HEADER, CONNECT_PROTOCOL_VERSION)
            .header(reqwest::header::USER_AGENT, crate::net::OPENLIMITER_USER_AGENT)
            .header(reqwest::header::ACCEPT, "application/json")
            .body(QUOTA_SUMMARY_BODY)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        if bytes.len() > MAX_BODY_BYTES {
            return None;
        }
        String::from_utf8(bytes.to_vec()).ok()
    }
}

impl LoopbackProbe for SystemLoopbackProbe {
    async fn quota_summary(&self, port: u16) -> Option<String> {
        /* TLS first, because that is the port the client prefers, and plain
        second. Both addresses are built here from a validated port number and
        one constant path, so no caller ever chooses a URL. */
        let secure = format!("https://127.0.0.1:{port}{QUOTA_SUMMARY_PATH}");
        if let Some(body) = Self::ask(self.secure.as_ref(), &secure).await {
            return Some(body);
        }
        let plain = format!("http://127.0.0.1:{port}{QUOTA_SUMMARY_PATH}");
        Self::ask(self.plain.as_ref(), &plain).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Clone)]
    struct StubPorts(Vec<u16>);

    impl AgyPorts for StubPorts {
        fn listening(&self) -> Vec<u16> {
            self.0.clone()
        }
    }

    struct StubProbe {
        answering: Option<u16>,
        /// Ports that answer with something the caller cannot read.
        noise: Vec<u16>,
        asked: Mutex<Vec<u16>>,
    }

    impl StubProbe {
        fn new(answering: Option<u16>) -> Self {
            Self {
                answering,
                noise: Vec::new(),
                asked: Mutex::new(Vec::new()),
            }
        }

        fn with_noise(answering: Option<u16>, noise: Vec<u16>) -> Self {
            Self {
                answering,
                noise,
                asked: Mutex::new(Vec::new()),
            }
        }
    }

    impl LoopbackProbe for StubProbe {
        async fn quota_summary(&self, port: u16) -> Option<String> {
            if let Ok(mut asked) = self.asked.lock() {
                asked.push(port);
            }
            if self.noise.contains(&port) {
                return Some("this is not a quota summary".to_string());
            }
            (self.answering == Some(port)).then(|| FIXTURE.to_string())
        }
    }

    /// The caller's acceptance test, stood in for by the shape of the fixture.
    fn readable(body: &str) -> bool {
        body.contains("remainingFraction")
    }

    /// A scrubbed capture of the shape the running client answers with.
    ///
    /// Two pools, four buckets. No identity of any kind: the route carries no
    /// account, no token and no email, which is one of the reasons it is
    /// readable at all.
    pub(crate) const FIXTURE: &str = r#"{"groups":[{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini-5h","displayName":"5 hour","description":"","window":"5h","remainingFraction":0.62,"resetTime":"2026-09-07T16:00:00Z"},{"bucketId":"gemini-weekly","displayName":"Weekly","description":"","window":"weekly","remainingFraction":0.31,"resetTime":"2026-09-12T00:00:00Z"}]},{"displayName":"Claude and GPT models","buckets":[{"bucketId":"3p-5h","displayName":"5 hour","description":"","window":"5h","remainingFraction":0.9,"resetTime":"2026-09-07T16:00:00Z"},{"bucketId":"3p-weekly","displayName":"Weekly","description":"","window":"weekly","remainingFraction":0.5,"resetTime":"2026-09-12T00:00:00Z"}]}]}"#;

    #[test]
    fn only_loopback_addresses_yield_a_port() {
        assert_eq!(loopback_port("127.0.0.1:52123"), Some(52123));
        assert_eq!(loopback_port("[::1]:52123"), Some(52123));
        for hostile in [
            "0.0.0.0:52123",
            "192.168.1.9:52123",
            "10.0.0.4:80",
            "127.0.0.1:0",
            "127.0.0.1:notaport",
            "127.0.0.1",
            "",
        ] {
            assert_eq!(loopback_port(hostile), None, "{hostile} was accepted");
        }
    }

    #[tokio::test]
    async fn the_first_answering_port_wins_and_the_rest_are_left_alone() {
        let ports = StubPorts(vec![52124, 52123, 52123]);
        let probe = StubProbe::new(Some(52124));
        let read = read_quota_summary(&ports, &probe, readable).await;
        assert!(matches!(read, LocalRead::Answered { .. }));
        /* Sorted, deduplicated, and stopped at the first answer. */
        assert_eq!(*probe.asked.lock().expect("asked"), vec![52123, 52124]);
    }

    #[tokio::test]
    async fn no_running_client_is_a_stated_fact_and_not_a_failure() {
        let ports = StubPorts(Vec::new());
        let probe = StubProbe::new(None);
        assert_eq!(
            read_quota_summary(&ports, &probe, readable).await,
            LocalRead::NoClient
        );
        assert!(probe.asked.lock().expect("asked").is_empty());
    }

    #[tokio::test]
    async fn a_client_that_answers_nothing_usable_is_the_same_as_none() {
        let ports = StubPorts(vec![52123, 52124]);
        let probe = StubProbe::new(None);
        assert_eq!(
            read_quota_summary(&ports, &probe, readable).await,
            LocalRead::NoClient
        );
        assert_eq!(*probe.asked.lock().expect("asked"), vec![52123, 52124]);
    }

    #[tokio::test]
    async fn the_port_list_is_bounded_however_long_the_enumeration_was() {
        let ports = StubPorts((1000..1100).collect());
        let probe = StubProbe::new(None);
        assert_eq!(
            read_quota_summary(&ports, &probe, readable).await,
            LocalRead::NoClient
        );
        assert_eq!(probe.asked.lock().expect("asked").len(), MAX_PROBE_PORTS);
    }

    #[cfg(windows)]
    #[test]
    fn only_the_listening_loopback_rows_of_the_named_process_become_ports() {
        let pids = [4812_u32, 9001];
        let report = concat!(
            "  Proto  Local Address          Foreign Address        State           PID\n",
            "  TCP    127.0.0.1:52123        0.0.0.0:0              LISTENING       4812\n",
            "  TCP    127.0.0.1:52124        0.0.0.0:0              LISTENING       9001\n",
            /* Somebody else's port, an outward facing bind, and a live
            connection rather than a listener. None of the three is ours. */
            "  TCP    127.0.0.1:52125        0.0.0.0:0              LISTENING       7777\n",
            "  TCP    0.0.0.0:52126          0.0.0.0:0              LISTENING       4812\n",
            "  TCP    127.0.0.1:52127        127.0.0.1:9999         ESTABLISHED     4812\n",
        );
        assert_eq!(netstat_ports(report, &pids), vec![52123, 52124]);
    }

    #[cfg(windows)]
    #[test]
    fn a_report_this_build_cannot_read_yields_no_ports() {
        assert!(netstat_ports("garbage", &[4812]).is_empty());
        assert!(netstat_ports("", &[4812]).is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn only_the_loopback_names_of_an_lsof_report_become_ports() {
        let report = "p4812\nn127.0.0.1:52123\nn*:52126\nn192.168.1.9:52127\nn[::1]:52124\n";
        assert_eq!(
            lsof_pid_ports(report)
                .into_iter()
                .map(|(_, port)| port)
                .collect::<Vec<u16>>(),
            vec![52123, 52124]
        );
        assert!(lsof_pid_ports("").is_empty());
    }

    /// A body this build cannot read is not data and does not end the search.
    ///
    /// One port answering with something unreadable used to stop the loop and
    /// leave the row stale while the very next port was serving the real
    /// summary. Every port gets its turn until one answers with something the
    /// caller can actually parse.
    #[tokio::test]
    async fn an_unreadable_answer_is_passed_over_and_the_next_port_is_tried() {
        let ports = StubPorts(vec![52123, 52124]);
        let probe = StubProbe::with_noise(Some(52124), vec![52123]);
        let read = read_quota_summary(&ports, &probe, readable).await;
        assert!(matches!(read, LocalRead::Answered { .. }));
        assert_eq!(*probe.asked.lock().expect("asked"), vec![52123, 52124]);
    }

    /// Unreadable everywhere is no client, never data.
    #[tokio::test]
    async fn nothing_readable_anywhere_is_no_client() {
        let ports = StubPorts(vec![52123, 52124]);
        let probe = StubProbe::with_noise(None, vec![52123, 52124]);
        assert_eq!(
            read_quota_summary(&ports, &probe, readable).await,
            LocalRead::NoClient
        );
    }

    /// A name is not evidence.
    ///
    /// Any process can call itself `agy`, and the name alone was the whole of
    /// the check in the first version of this file, so anything that could
    /// start a process could have this build POST to a loopback port of its
    /// choosing.
    #[test]
    fn a_process_called_agy_from_anywhere_is_not_trusted() {
        let roots = vec![PathBuf::from(if cfg!(windows) {
            r"C:\Program Files"
        } else {
            "/usr/local"
        })];
        let inside = if cfg!(windows) {
            r"C:\Program Files\Antigravity\agy.exe"
        } else {
            "/usr/local/bin/agy"
        };
        assert!(trusted_agy_executable(Path::new(inside), &roots));

        for hostile in if cfg!(windows) {
            vec![
                r"C:\Users\someone\Downloads\agy.exe",
                r"C:\Temp\agy.exe",
                r"C:\Program Files\Antigravity\notagy.exe",
                r"C:\Program Files\..\Temp\agy.exe",
                r"agy.exe",
            ]
        } else {
            vec![
                "/tmp/agy",
                "/home/someone/Downloads/agy",
                "/usr/local/bin/notagy",
                "/usr/local/../tmp/agy",
                "agy",
            ]
        } {
            assert!(
                !trusted_agy_executable(Path::new(hostile), &roots),
                "{hostile} was trusted"
            );
        }
    }

    /// The real install roots are directories, never the whole disk.
    #[test]
    fn the_install_roots_are_real_places_and_never_the_root_of_the_disk() {
        for root in install_roots() {
            assert!(root.is_absolute(), "{} is not absolute", root.display());
            assert!(
                root.components().count() > 1,
                "{} is the whole disk",
                root.display()
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn only_a_verified_executable_of_this_user_contributes_a_process() {
        let roots = vec![PathBuf::from(r"C:\Program Files")];
        let report = concat!(
            "4812|C:\\Program Files\\Antigravity\\agy.exe\n",
            /* Right name, wrong place. */
            "9001|C:\\Users\\someone\\Downloads\\agy.exe\n",
            /* No path at all, which is what a process this query could not
            open looks like. */
            "9002|\n",
            "garbage\n",
        );
        assert_eq!(owned_agy_pids(report, &roots), vec![4812]);
        assert!(owned_agy_pids("", &roots).is_empty());
    }

    /// The connection table is read by its numbers, not by its words.
    ///
    /// A Windows installed in another language translates the protocol and
    /// state columns, and keying on the English ones found nothing at all:
    /// the row said Antigravity was closed while it was running.
    #[cfg(windows)]
    #[test]
    fn a_localized_connection_table_still_yields_its_ports() {
        let pids = [4812_u32];
        let english = concat!(
            "  Proto  Local Address          Foreign Address        State           PID\n",
            "  TCP    127.0.0.1:52123        0.0.0.0:0              LISTENING       4812\n",
            "  TCP    127.0.0.1:52127        127.0.0.1:9999         ESTABLISHED     4812\n",
        );
        let portuguese = concat!(
            "  Proto  Endere\u{e7}o Local        Endere\u{e7}o Externo      Estado          PID\n",
            "  TCP    127.0.0.1:52123        0.0.0.0:0              ESCUTANDO       4812\n",
            "  TCP    127.0.0.1:52127        127.0.0.1:9999         ESTABELECIDO    4812\n",
        );
        let german = concat!(
            "  Proto  Lokale Adresse         Remoteadresse          Status          PID\n",
            "  TCP    127.0.0.1:52123        0.0.0.0:0              ABH\u{d6}REN         4812\n",
            "  TCP    127.0.0.1:52127        127.0.0.1:9999         HERGESTELLT     4812\n",
        );
        for report in [english, portuguese, german] {
            assert_eq!(netstat_ports(report, &pids), vec![52123]);
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn an_lsof_report_pairs_every_port_with_the_process_that_holds_it() {
        let report = "p4812\nn127.0.0.1:52123\nn[::1]:52124\np9001\nn127.0.0.1:52125\n";
        assert_eq!(
            lsof_pid_ports(report),
            vec![(4812, 52123), (4812, 52124), (9001, 52125)]
        );
        /* A name with no process in front of it belongs to nobody. */
        assert!(lsof_pid_ports("n127.0.0.1:52123\n").is_empty());
        assert!(lsof_pid_ports("").is_empty());
    }

    #[test]
    fn the_request_shape_is_the_one_that_was_measured() {
        assert_eq!(
            QUOTA_SUMMARY_PATH,
            "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
        );
        assert_eq!(CONNECT_PROTOCOL_HEADER, "connect-protocol-version");
        assert_eq!(CONNECT_PROTOCOL_VERSION, "1");
        assert_eq!(QUOTA_SUMMARY_BODY, "{}");
        /* Nothing in the request names a vendor client, and nothing in it is a
        credential. Both are the whole argument for reading this way. */
        assert!(!QUOTA_SUMMARY_BODY.contains("antigravity/cli"));
    }

    #[test]
    fn the_sentence_names_the_one_action_that_fixes_it() {
        assert_eq!(NO_CLIENT_SENTENCE, "Open Antigravity once to refresh");
        assert!(!NO_CLIENT_SENTENCE.contains('-'));
    }

    #[test]
    fn install_roots_accept_and_refuse_per_platform() {
        // Windows: %LOCALAPPDATA%\Programs, user profile's bin and Applications
        let win_roots = roots_for_platform(
            TargetPlatform::Windows,
            Some(Path::new(r"C:\Users\someone")),
            Some(Path::new(r"C:\Users\someone\AppData\Local")),
            Some(Path::new(r"C:\Users\someone\AppData\Roaming")),
            &[Some(Path::new(r"C:\Program Files"))],
        );
        let win_accepted_programs =
            Path::new(r"C:\Users\someone\AppData\Local\Programs\Antigravity\agy.exe");
        let win_accepted_bin = Path::new(r"C:\Users\someone\bin\agy.exe");
        let win_accepted_apps = Path::new(r"C:\Users\someone\Applications\agy.exe");
        let win_refused = Path::new(r"C:\Users\someone\Downloads\agy.exe");
        assert!(trusted_agy_executable(win_accepted_programs, &win_roots));
        assert!(trusted_agy_executable(win_accepted_bin, &win_roots));
        assert!(trusted_agy_executable(win_accepted_apps, &win_roots));
        assert!(!trusted_agy_executable(win_refused, &win_roots));

        /* The bare %LOCALAPPDATA% and %APPDATA% roots are refused: only their
        Programs subfolder is where software legitimately lives, and the two
        broad parents around it are exactly where a browser download or an
        archive extraction lands too. */
        let win_refused_bare_local =
            Path::new(r"C:\Users\someone\AppData\Local\Temp\agy.exe");
        let win_refused_bare_roaming =
            Path::new(r"C:\Users\someone\AppData\Roaming\Downloads\agy.exe");
        assert!(!trusted_agy_executable(win_refused_bare_local, &win_roots));
        assert!(!trusted_agy_executable(win_refused_bare_roaming, &win_roots));

        // macOS: ~/Applications, ~/bin, /Applications
        let mac_roots = roots_for_platform(
            TargetPlatform::Macos,
            Some(Path::new("/Users/someone")),
            None,
            None,
            &[],
        );
        let mac_accepted_user_apps = Path::new("/Users/someone/Applications/Antigravity/agy");
        let mac_accepted_bin = Path::new("/Users/someone/bin/agy");
        let mac_accepted_sys_apps = Path::new("/Applications/Antigravity.app/Contents/MacOS/agy");
        let mac_refused = Path::new("/Users/someone/Downloads/agy");
        assert!(trusted_agy_executable(mac_accepted_user_apps, &mac_roots));
        assert!(trusted_agy_executable(mac_accepted_bin, &mac_roots));
        assert!(trusted_agy_executable(mac_accepted_sys_apps, &mac_roots));
        assert!(!trusted_agy_executable(mac_refused, &mac_roots));

        // Linux: ~/.local/bin, ~/bin, ~/Applications, /opt, /usr/local
        let linux_roots = roots_for_platform(
            TargetPlatform::Linux,
            Some(Path::new("/home/someone")),
            None,
            None,
            &[],
        );
        let linux_accepted_local_bin = Path::new("/home/someone/.local/bin/agy");
        let linux_accepted_bin = Path::new("/home/someone/bin/agy");
        let linux_accepted_apps = Path::new("/home/someone/Applications/agy");
        let linux_accepted_opt = Path::new("/opt/antigravity/bin/agy");
        let linux_accepted_usr_local = Path::new("/usr/local/bin/agy");
        let linux_refused = Path::new("/home/someone/Downloads/agy");
        assert!(trusted_agy_executable(linux_accepted_local_bin, &linux_roots));
        assert!(trusted_agy_executable(linux_accepted_bin, &linux_roots));
        assert!(trusted_agy_executable(linux_accepted_apps, &linux_roots));
        assert!(trusted_agy_executable(linux_accepted_opt, &linux_roots));
        assert!(trusted_agy_executable(linux_accepted_usr_local, &linux_roots));
        assert!(!trusted_agy_executable(linux_refused, &linux_roots));
    }
}
