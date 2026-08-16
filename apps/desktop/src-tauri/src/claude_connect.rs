use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

use crate::fsx;

pub const CLAUDE_INSTALL_COMMAND: &str = "npm install -g openlimiter";
const CLI_CONFIG_ENV: &str = "OPENLIMITER_CLI_PATH";
const STATUSLINE_WRAPPER_FLAG: &str = "OPENLIMITER_CLAUDE_STATUSLINE_WRAPPER";
const CLI_PROBE_TIMEOUT_SECONDS: u64 = 10;
const SETTINGS_TEMP_MARKER: &str = "openlimiter";
const CONNECTION_STATE_FILE: &str = "claude-connect-state.json";
const CONNECTION_STATE_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudePreflightKind {
    Ready,
    WrappableStatusLine,
    CliMissing,
    CliNotWorking,
    SettingsUnknown,
    GuidedManual,
}

fn statusline_wrapper_enabled() -> bool {
    std::env::var(STATUSLINE_WRAPPER_FLAG)
        .ok()
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

/// Typed facts only. No settings value is ever copied into this IPC shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClaudePreflightVerdict {
    pub kind: ClaudePreflightKind,
    pub cli_found: bool,
    pub cli_working: bool,
    pub settings_present: bool,
    pub settings_shape_known: bool,
    pub foreign_status_line: bool,
    pub foreign_user_prompt_submit_hooks: bool,
    pub cli_path: Option<String>,
    pub install_command: &'static str,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeConnectInput {
    #[serde(default)]
    pub configured_cli_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaudeApplyOutcome {
    Applied,
    AlreadyApplied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaudeDisconnectOutcome {
    RestoredExact,
    RemovedOwnedEntries,
    NothingToRemove,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeConnectError {
    CleanPreflightRequired,
    SettingsUnreadable,
    Storage,
}

impl fmt::Display for ClaudeConnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            ClaudeConnectError::CleanPreflightRequired => {
                "Claude Code needs a clean connection check before this change."
            }
            ClaudeConnectError::SettingsUnreadable => {
                "Claude Code settings are not readable in a supported shape."
            }
            ClaudeConnectError::Storage => {
                "Claude Code settings could not be backed up or changed."
            }
        };
        formatter.write_str(sentence)
    }
}

trait CliRuntime {
    fn resolve(&self, configured: Option<&str>) -> Option<PathBuf>;
    fn probe(&self, path: &Path) -> bool;
}

struct SystemCliRuntime;

/// Drop the Windows verbatim prefix that canonicalization adds.
///
/// `std::fs::canonicalize` answers on Windows with an extended length path,
/// `\\?\C:\...`, and the command interpreter cannot run one: it reports that
/// the path does not exist. That matters twice over, because this same string
/// is both what the probe executes and what gets written into the Claude Code
/// settings file, so a verbatim path means the check can never pass and the
/// entry we wrote could never run either. The prefix is removed rather than
/// canonicalization being dropped, because canonicalization is what proves the
/// path is real and resolves every link before anything is written down. The
/// cost is the old length limit, which a command line tool inside the user
/// profile is nowhere near.
fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{share}"));
    }
    match text.strip_prefix(r"\\?\") {
        /* Only a plain drive letter is unwrapped. Anything else keeps the
        prefix, because a device path without it names something different. */
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

/// Hand one already quoted line to the command interpreter, unescaped.
///
/// The interpreter wants a single argument that it parses itself, quotes and
/// all. The ordinary argument path escapes an embedded quote as a backslash
/// quote pair, which the interpreter does not understand: it reads the
/// backslash literally and then cannot find the program. So the line is passed
/// through verbatim on Windows, which is the only platform that reaches here.
#[cfg(windows)]
fn push_interpreter_line(command: &mut Command, line: String) {
    use std::os::windows::process::CommandExt as _;
    command.raw_arg(line);
}

#[cfg(not(windows))]
fn push_interpreter_line(command: &mut Command, line: String) {
    command.arg(line);
}

#[cfg(windows)]
fn suppress_probe_window(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    // Windows preflight probes must never flash a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_probe_window(_command: &mut Command) {}

fn regular_absolute(candidate: &Path) -> Option<PathBuf> {
    let absolute = std::fs::canonicalize(candidate).ok()?;
    if !absolute.is_absolute() || !absolute.metadata().ok()?.is_file() {
        return None;
    }
    let usable = without_verbatim_prefix(absolute);
    if !usable.is_absolute() {
        return None;
    }
    usable.to_str()?;
    Some(usable)
}

fn executable_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["openlimiter.cmd", "openlimiter.exe"]
    } else {
        &["openlimiter"]
    }
}

impl CliRuntime for SystemCliRuntime {
    fn resolve(&self, configured: Option<&str>) -> Option<PathBuf> {
        if let Some(configured) = configured {
            let candidate = PathBuf::from(configured);
            if !candidate.is_absolute() {
                return None;
            }
            return regular_absolute(&candidate);
        }
        if let Some(configured) = std::env::var_os(CLI_CONFIG_ENV) {
            let candidate = PathBuf::from(configured);
            if candidate.is_absolute() {
                if let Some(path) = regular_absolute(&candidate) {
                    return Some(path);
                }
            }
        }
        let mut candidates = Vec::new();
        if let Some(path) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&path) {
                for name in executable_names() {
                    candidates.push(directory.join(name));
                }
            }
        }
        if cfg!(windows) {
            if let Some(app_data) = std::env::var_os("APPDATA") {
                for name in executable_names() {
                    candidates.push(PathBuf::from(&app_data).join("npm").join(name));
                }
            }
        } else {
            for directory in ["/usr/local/bin", "/opt/homebrew/bin"] {
                candidates.push(PathBuf::from(directory).join("openlimiter"));
            }
            if let Some(home) = crate::state::home() {
                candidates.push(home.join(".npm-global").join("bin").join("openlimiter"));
            }
        }
        let mut seen = HashSet::new();
        candidates.into_iter().find_map(|candidate| {
            let path = regular_absolute(&candidate)?;
            if seen.insert(path.clone()) {
                Some(path)
            } else {
                None
            }
        })
    }

    fn probe(&self, path: &Path) -> bool {
        let mut command = if cfg!(windows)
            && matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("cmd" | "bat")
            ) {
            let Some(text) = path.to_str() else {
                return false;
            };
            if text.chars().any(|character| {
                character.is_control()
                    || matches!(character, '"' | '%' | '&' | '|' | '<' | '>' | '^')
            }) {
                return false;
            }
            let mut command =
                Command::new(std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
            command.arg("/d").arg("/s").arg("/c");
            push_interpreter_line(&mut command, format!("\"{text}\" statusline --probe"));
            command
        } else {
            let mut command = Command::new(path);
            command.arg("statusline").arg("--probe");
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        suppress_probe_window(&mut command);
        let Ok(mut child) = command.spawn() else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_secs(CLI_PROBE_TIMEOUT_SECONDS);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                Err(_) => return false,
            }
        }
    }
}

struct SettingsRead {
    file: PathBuf,
    text: Zeroizing<String>,
    present: bool,
}

fn settings_in_home(home: &Path) -> Result<SettingsRead, ClaudeConnectError> {
    let directory = home.join(".claude");
    let file = directory.join("settings.json");
    fsx::reject_symlink(&directory).map_err(|_| ClaudeConnectError::SettingsUnreadable)?;
    match std::fs::symlink_metadata(&file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SettingsRead {
            file,
            text: Zeroizing::new("{}".to_string()),
            present: false,
        }),
        Err(_) => Err(ClaudeConnectError::SettingsUnreadable),
        Ok(_) => fsx::bounded_read(&file)
            .map(|text| SettingsRead {
                file,
                text: Zeroizing::new(text),
                present: true,
            })
            .ok_or(ClaudeConnectError::SettingsUnreadable),
    }
}

fn quoted_command(path: &Path, verb: &str) -> Option<String> {
    let text = path.to_str()?;
    if text.chars().any(char::is_control) {
        return None;
    }
    let escaped = if cfg!(windows) {
        if text.contains('"') {
            return None;
        }
        text.to_string()
    } else {
        text.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`")
    };
    Some(format!("\"{escaped}\" {verb}"))
}

fn base64url_encode(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bytes = text.as_bytes();
    let mut output = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        output.push(ALPHABET[(first >> 2) as usize] as char);
        let second = chunk.get(1).copied();
        output.push(ALPHABET[(((first & 0b11) << 4) | second.unwrap_or(0) >> 4) as usize] as char);
        let Some(second) = second else {
            continue;
        };
        let third = chunk.get(2).copied();
        output
            .push(ALPHABET[(((second & 0b1111) << 2) | third.unwrap_or(0) >> 6) as usize] as char);
        if let Some(third) = third {
            output.push(ALPHABET[(third & 0b11_1111) as usize] as char);
        }
    }
    output
}

fn wrapped_statusline_command(path: &Path, original: &str) -> Option<String> {
    if original.is_empty() || original.contains('\0') {
        return None;
    }
    quoted_command(
        path,
        &format!("statusline --wrap {}", base64url_encode(original)),
    )
}

fn current_wrapper_command(command: &str, cli_path: &Path) -> bool {
    let Some(prefix) = quoted_command(cli_path, "statusline --wrap ") else {
        return false;
    };
    let Some(encoded) = command.strip_prefix(&prefix) else {
        return false;
    };
    !encoded.is_empty()
        && encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn legacy_owned_command(command: &str, verb: &str) -> bool {
    let words: Vec<&str> = command.split_whitespace().collect();
    matches!(words.as_slice(), ["openlimiter", found] if *found == verb)
        || matches!(words.as_slice(), ["node", path, found] if path.contains("openlimiter") && *found == verb)
}

fn owned_command(command: &str, verb: &str, cli_path: &Path) -> bool {
    quoted_command(cli_path, verb).as_deref() == Some(command)
        || legacy_owned_command(command, verb)
}

fn exact_command_object(value: &serde_json::Value, verb: &str, cli_path: &Path) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 2
        || object.get("type").and_then(serde_json::Value::as_str) != Some("command")
    {
        return false;
    }
    object
        .get("command")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|command| owned_command(command, verb, cli_path))
}

fn exact_hook_entry(value: &serde_json::Value, cli_path: &Path) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 1 {
        return false;
    }
    let Some(hooks) = object.get("hooks").and_then(serde_json::Value::as_array) else {
        return false;
    };
    hooks.len() == 1 && exact_command_object(&hooks[0], "hook", cli_path)
}

struct SettingsAnalysis {
    shape_known: bool,
    foreign_status_line: bool,
    foreign_user_prompt_submit_hooks: bool,
    wrappable_status_line_command: Option<Zeroizing<String>>,
}

fn wrappable_status_line_command(
    value: &serde_json::Value,
    cli_path: &Path,
) -> Option<Zeroizing<String>> {
    let object = value.as_object()?;
    if object.get("type").and_then(serde_json::Value::as_str) != Some("command") {
        return None;
    }
    let command = object.get("command").and_then(serde_json::Value::as_str)?;
    if command.is_empty()
        || command.contains('\0')
        || owned_command(command, "statusline", cli_path)
        || current_wrapper_command(command, cli_path)
    {
        return None;
    }
    Some(Zeroizing::new(command.to_string()))
}

fn analyze_settings(text: &str, cli_path: &Path) -> SettingsAnalysis {
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(text) else {
        return SettingsAnalysis {
            shape_known: false,
            foreign_status_line: false,
            foreign_user_prompt_submit_hooks: false,
            wrappable_status_line_command: None,
        };
    };
    let Some(root) = settings.as_object() else {
        return SettingsAnalysis {
            shape_known: false,
            foreign_status_line: false,
            foreign_user_prompt_submit_hooks: false,
            wrappable_status_line_command: None,
        };
    };
    let foreign_status_line = root
        .get("statusLine")
        .is_some_and(|value| !exact_command_object(value, "statusline", cli_path));
    let wrappable_status_line_command = root
        .get("statusLine")
        .and_then(|value| wrappable_status_line_command(value, cli_path));
    let Some(hooks) = root.get("hooks") else {
        return SettingsAnalysis {
            shape_known: true,
            foreign_status_line,
            foreign_user_prompt_submit_hooks: false,
            wrappable_status_line_command,
        };
    };
    let Some(hooks) = hooks.as_object() else {
        return SettingsAnalysis {
            shape_known: false,
            foreign_status_line,
            foreign_user_prompt_submit_hooks: false,
            wrappable_status_line_command,
        };
    };
    let Some(entries) = hooks.get("UserPromptSubmit") else {
        return SettingsAnalysis {
            shape_known: true,
            foreign_status_line,
            foreign_user_prompt_submit_hooks: false,
            wrappable_status_line_command,
        };
    };
    let Some(entries) = entries.as_array() else {
        return SettingsAnalysis {
            shape_known: false,
            foreign_status_line,
            foreign_user_prompt_submit_hooks: false,
            wrappable_status_line_command,
        };
    };
    SettingsAnalysis {
        shape_known: true,
        foreign_status_line,
        foreign_user_prompt_submit_hooks: entries
            .iter()
            .any(|entry| !exact_hook_entry(entry, cli_path)),
        wrappable_status_line_command,
    }
}

struct PreparedPreflight {
    verdict: ClaudePreflightVerdict,
    cli_path: Option<PathBuf>,
    settings: Option<SettingsRead>,
}

fn prepare_preflight(
    home: Option<&Path>,
    configured: Option<&str>,
    runtime: &impl CliRuntime,
    wrapper_feature_enabled: bool,
) -> PreparedPreflight {
    let cli_path = runtime.resolve(configured);
    let cli_working = cli_path.as_deref().is_some_and(|path| runtime.probe(path));
    let fallback_path = if cfg!(windows) {
        Path::new("C:\\openlimiter-missing.exe")
    } else {
        Path::new("/openlimiter-missing")
    };
    let analysis_path = cli_path.as_deref().unwrap_or(fallback_path);
    let settings = home.and_then(|home| settings_in_home(home).ok());
    let settings_present = settings.as_ref().is_some_and(|value| value.present);
    let analysis = settings
        .as_ref()
        .map(|value| analyze_settings(&value.text, analysis_path))
        .unwrap_or(SettingsAnalysis {
            shape_known: false,
            foreign_status_line: false,
            foreign_user_prompt_submit_hooks: false,
            wrappable_status_line_command: None,
        });
    let kind = if cli_path.is_none() {
        ClaudePreflightKind::CliMissing
    } else if !cli_working {
        ClaudePreflightKind::CliNotWorking
    } else if !analysis.shape_known {
        ClaudePreflightKind::SettingsUnknown
    } else if analysis.foreign_user_prompt_submit_hooks {
        ClaudePreflightKind::GuidedManual
    } else if analysis.foreign_status_line {
        if wrapper_feature_enabled && analysis.wrappable_status_line_command.is_some() {
            ClaudePreflightKind::WrappableStatusLine
        } else {
            ClaudePreflightKind::GuidedManual
        }
    } else {
        ClaudePreflightKind::Ready
    };
    let wire_path = cli_path
        .as_ref()
        .and_then(|path| path.to_str())
        .map(str::to_string);
    PreparedPreflight {
        verdict: ClaudePreflightVerdict {
            kind,
            cli_found: cli_path.is_some(),
            cli_working,
            settings_present,
            settings_shape_known: analysis.shape_known,
            foreign_status_line: analysis.foreign_status_line,
            foreign_user_prompt_submit_hooks: analysis.foreign_user_prompt_submit_hooks,
            cli_path: wire_path,
            install_command: CLAUDE_INSTALL_COMMAND,
        },
        cli_path,
        settings,
    }
}

pub fn preflight(input: ClaudeConnectInput) -> ClaudePreflightVerdict {
    let home = crate::state::home();
    prepare_preflight(
        home.as_deref(),
        input.configured_cli_path.as_deref(),
        &SystemCliRuntime,
        statusline_wrapper_enabled(),
    )
    .verdict
}

pub fn unavailable_preflight() -> ClaudePreflightVerdict {
    ClaudePreflightVerdict {
        kind: ClaudePreflightKind::SettingsUnknown,
        cli_found: false,
        cli_working: false,
        settings_present: false,
        settings_shape_known: false,
        foreign_status_line: false,
        foreign_user_prompt_submit_hooks: false,
        cli_path: None,
        install_command: CLAUDE_INSTALL_COMMAND,
    }
}

#[derive(Clone)]
struct MemberSpan {
    key: String,
    key_start: usize,
    value_start: usize,
    value_end: usize,
}

struct ObjectLayout {
    open: usize,
    members: Vec<MemberSpan>,
}

#[derive(Clone, Copy)]
struct ValueSpan {
    start: usize,
    end: usize,
}

struct ArrayLayout {
    elements: Vec<ValueSpan>,
}

fn skip_space(bytes: &[u8], mut at: usize) -> usize {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    at
}

fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut at = start + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => return Some(at + 1),
            b'\\' => {
                at += 2;
            }
            byte if byte < 0x20 => return None,
            _ => at += 1,
        }
    }
    None
}

fn compound_end(bytes: &[u8], start: usize) -> Option<usize> {
    let expected = match bytes.get(start)? {
        b'{' => b'}',
        b'[' => b']',
        _ => return None,
    };
    let mut stack = vec![expected];
    let mut at = start + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => at = string_end(bytes, at)?,
            b'{' => {
                stack.push(b'}');
                at += 1;
            }
            b'[' => {
                stack.push(b']');
                at += 1;
            }
            b'}' | b']' => {
                if stack.pop()? != bytes[at] {
                    return None;
                }
                at += 1;
                if stack.is_empty() {
                    return Some(at);
                }
            }
            _ => at += 1,
        }
    }
    None
}

fn value_end(bytes: &[u8], start: usize) -> Option<usize> {
    match bytes.get(start)? {
        b'"' => string_end(bytes, start),
        b'{' | b'[' => compound_end(bytes, start),
        _ => {
            let mut at = start;
            while at < bytes.len()
                && !bytes[at].is_ascii_whitespace()
                && !matches!(bytes[at], b',' | b'}' | b']')
            {
                at += 1;
            }
            (at > start).then_some(at)
        }
    }
}

fn object_layout(text: &str, start: usize) -> Option<ObjectLayout> {
    let bytes = text.as_bytes();
    let open = skip_space(bytes, start);
    if bytes.get(open) != Some(&b'{') {
        return None;
    }
    let mut at = skip_space(bytes, open + 1);
    let mut members = Vec::new();
    if bytes.get(at) == Some(&b'}') {
        return Some(ObjectLayout { open, members });
    }
    loop {
        let key_start = at;
        let key_end = string_end(bytes, key_start)?;
        let key: String = serde_json::from_str(&text[key_start..key_end]).ok()?;
        at = skip_space(bytes, key_end);
        if bytes.get(at) != Some(&b':') {
            return None;
        }
        let value_start = skip_space(bytes, at + 1);
        let end = value_end(bytes, value_start)?;
        members.push(MemberSpan {
            key,
            key_start,
            value_start,
            value_end: end,
        });
        at = skip_space(bytes, end);
        match bytes.get(at) {
            Some(b',') => {
                at = skip_space(bytes, at + 1);
            }
            Some(b'}') => {
                return Some(ObjectLayout { open, members });
            }
            _ => return None,
        }
    }
}

fn array_layout(text: &str, start: usize) -> Option<ArrayLayout> {
    let bytes = text.as_bytes();
    let open = skip_space(bytes, start);
    if bytes.get(open) != Some(&b'[') {
        return None;
    }
    let mut at = skip_space(bytes, open + 1);
    let mut elements = Vec::new();
    if bytes.get(at) == Some(&b']') {
        return Some(ArrayLayout { elements });
    }
    loop {
        let end = value_end(bytes, at)?;
        elements.push(ValueSpan { start: at, end });
        at = skip_space(bytes, end);
        match bytes.get(at) {
            Some(b',') => at = skip_space(bytes, at + 1),
            Some(b']') => return Some(ArrayLayout { elements }),
            _ => return None,
        }
    }
}

fn set_object_member(text: &str, object_start: usize, key: &str, value: &str) -> Option<String> {
    let layout = object_layout(text, object_start)?;
    if let Some(member) = layout.members.iter().find(|member| member.key == key) {
        let mut output = String::with_capacity(text.len() + value.len());
        output.push_str(&text[..member.value_start]);
        output.push_str(value);
        output.push_str(&text[member.value_end..]);
        return Some(output);
    }
    let key = serde_json::to_string(key).ok()?;
    let insertion = format!("{key}:{value}");
    let (at, insertion) = match layout.members.last() {
        Some(last) => (last.value_end, format!(",{insertion}")),
        None => (layout.open + 1, insertion),
    };
    let mut output = String::with_capacity(text.len() + insertion.len());
    output.push_str(&text[..at]);
    output.push_str(&insertion);
    output.push_str(&text[at..]);
    Some(output)
}

fn remove_object_member(text: &str, object_start: usize, key: &str) -> Option<(String, bool)> {
    let layout = object_layout(text, object_start)?;
    let Some(index) = layout.members.iter().position(|member| member.key == key) else {
        return Some((text.to_string(), false));
    };
    let member = &layout.members[index];
    let (start, end) = if let Some(next) = layout.members.get(index + 1) {
        (member.key_start, next.key_start)
    } else if let Some(previous) = index.checked_sub(1).and_then(|at| layout.members.get(at)) {
        (previous.value_end, member.value_end)
    } else {
        (member.key_start, member.value_end)
    };
    let mut output = String::with_capacity(text.len() - (end - start));
    output.push_str(&text[..start]);
    output.push_str(&text[end..]);
    Some((output, true))
}

fn remove_array_element(text: &str, array_start: usize, index: usize) -> Option<String> {
    let layout = array_layout(text, array_start)?;
    let element = layout.elements.get(index)?;
    let (start, end) = if let Some(next) = layout.elements.get(index + 1) {
        (element.start, next.start)
    } else if let Some(previous) = index.checked_sub(1).and_then(|at| layout.elements.get(at)) {
        (previous.end, element.end)
    } else {
        (element.start, element.end)
    };
    let mut output = String::with_capacity(text.len() - (end - start));
    output.push_str(&text[..start]);
    output.push_str(&text[end..]);
    Some(output)
}

fn serialized_command_value(command: &str) -> Option<String> {
    serde_json::to_string(&serde_json::json!({
        "type": "command",
        "command": command,
    }))
    .ok()
}

fn command_value(path: &Path, verb: &str) -> Option<String> {
    serialized_command_value(&quoted_command(path, verb)?)
}

fn hook_entry_value(path: &Path) -> Option<String> {
    let command: serde_json::Value = serde_json::from_str(&command_value(path, "hook")?).ok()?;
    serde_json::to_string(&serde_json::json!({ "hooks": [command] })).ok()
}

fn apply_surgical(
    text: &str,
    cli_path: &Path,
    original_statusline_command: Option<&str>,
) -> Option<(String, bool)> {
    let mut output = match original_statusline_command {
        Some(original) => {
            let wrapper =
                serde_json::to_string(&wrapped_statusline_command(cli_path, original)?).ok()?;
            let root = object_layout(text, 0)?;
            let status_line = root
                .members
                .iter()
                .find(|member| member.key == "statusLine")?;
            set_object_member(text, status_line.value_start, "command", &wrapper)?
        }
        None => {
            let status_line = command_value(cli_path, "statusline")?;
            set_object_member(text, 0, "statusLine", &status_line)?
        }
    };
    let hook_entry = hook_entry_value(cli_path)?;
    let user_prompt_submit = format!("[{hook_entry}]");
    let root = object_layout(&output, 0)?;
    let inserted_hooks_container = root.members.iter().all(|member| member.key != "hooks");
    if inserted_hooks_container {
        let hooks = format!("{{\"UserPromptSubmit\":{user_prompt_submit}}}");
        output = set_object_member(&output, 0, "hooks", &hooks)?;
    } else {
        let root = object_layout(&output, 0)?;
        let hooks = root.members.iter().find(|member| member.key == "hooks")?;
        output = set_object_member(
            &output,
            hooks.value_start,
            "UserPromptSubmit",
            &user_prompt_submit,
        )?;
    }
    serde_json::from_str::<serde_json::Value>(&output).ok()?;
    Some((output, inserted_hooks_container))
}

fn exact_serialized_command_object(value: &serde_json::Value, command: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == 2
        && object.get("type").and_then(serde_json::Value::as_str) == Some("command")
        && object.get("command").and_then(serde_json::Value::as_str) == Some(command)
}

fn command_object_runs(value: &serde_json::Value, command: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("type").and_then(serde_json::Value::as_str) == Some("command")
        && object.get("command").and_then(serde_json::Value::as_str) == Some(command)
}

fn exact_current_command_object(value: &serde_json::Value, verb: &str, cli_path: &Path) -> bool {
    quoted_command(cli_path, verb)
        .as_deref()
        .is_some_and(|command| exact_serialized_command_object(value, command))
}

fn exact_current_hook_entry(value: &serde_json::Value, cli_path: &Path) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(hooks) = object.get("hooks").and_then(serde_json::Value::as_array) else {
        return false;
    };
    object.len() == 1
        && hooks.len() == 1
        && exact_current_command_object(&hooks[0], "hook", cli_path)
}

fn remove_owned_entries(
    text: &str,
    cli_path: &Path,
    inserted_hooks_container: bool,
    original_settings: Option<&str>,
) -> Option<(String, bool)> {
    let mut output = text.to_string();
    let mut changed = false;
    let root = object_layout(&output, 0)?;
    if let Some(hooks_member) = root.members.iter().find(|member| member.key == "hooks") {
        let hooks_layout = object_layout(&output, hooks_member.value_start)?;
        if let Some(prompt_member) = hooks_layout
            .members
            .iter()
            .find(|member| member.key == "UserPromptSubmit")
        {
            let array = array_layout(&output, prompt_member.value_start)?;
            let mut owned = Vec::new();
            for (index, span) in array.elements.iter().enumerate() {
                let value: serde_json::Value =
                    serde_json::from_str(&output[span.start..span.end]).ok()?;
                if exact_current_hook_entry(&value, cli_path) {
                    owned.push(index);
                }
            }
            for index in owned.into_iter().rev() {
                let root = object_layout(&output, 0)?;
                let hooks = root.members.iter().find(|member| member.key == "hooks")?;
                let hooks_layout = object_layout(&output, hooks.value_start)?;
                let prompt = hooks_layout
                    .members
                    .iter()
                    .find(|member| member.key == "UserPromptSubmit")?;
                output = remove_array_element(&output, prompt.value_start, index)?;
                changed = true;
            }
            let root = object_layout(&output, 0)?;
            let hooks = root.members.iter().find(|member| member.key == "hooks")?;
            let hooks_layout = object_layout(&output, hooks.value_start)?;
            if let Some(prompt) = hooks_layout
                .members
                .iter()
                .find(|member| member.key == "UserPromptSubmit")
            {
                if array_layout(&output, prompt.value_start)?
                    .elements
                    .is_empty()
                {
                    let (next, removed) =
                        remove_object_member(&output, hooks.value_start, "UserPromptSubmit")?;
                    output = next;
                    changed |= removed;
                }
            }
        }
    }
    if inserted_hooks_container {
        let root = object_layout(&output, 0)?;
        if let Some(hooks) = root.members.iter().find(|member| member.key == "hooks") {
            if object_layout(&output, hooks.value_start)?
                .members
                .is_empty()
            {
                let (next, removed) = remove_object_member(&output, 0, "hooks")?;
                output = next;
                changed |= removed;
            }
        }
    }
    let root = object_layout(&output, 0)?;
    if let Some(status) = root
        .members
        .iter()
        .find(|member| member.key == "statusLine")
    {
        let value: serde_json::Value =
            serde_json::from_str(&output[status.value_start..status.value_end]).ok()?;
        if let Some(original_settings) = original_settings {
            let original_root = object_layout(original_settings, 0)?;
            let original = original_root
                .members
                .iter()
                .find(|member| member.key == "statusLine")?;
            let original_value = &original_settings[original.value_start..original.value_end];
            let original_status_line = object_layout(original_settings, original.value_start)?;
            let original_command_value = original_status_line
                .members
                .iter()
                .find(|member| member.key == "command")
                .map(|member| &original_settings[member.value_start..member.value_end])?;
            let parsed: serde_json::Value = serde_json::from_str(original_value).ok()?;
            let original_command = wrappable_status_line_command(&parsed, cli_path)?;
            let expected = wrapped_statusline_command(cli_path, &original_command)?;
            if command_object_runs(&value, &expected) {
                output = set_object_member(
                    &output,
                    status.value_start,
                    "command",
                    original_command_value,
                )?;
                changed = true;
            }
        } else if exact_current_command_object(&value, "statusline", cli_path) {
            let (next, removed) = remove_object_member(&output, 0, "statusLine")?;
            output = next;
            changed |= removed;
        }
    }
    serde_json::from_str::<serde_json::Value>(&output).ok()?;
    Some((output, changed))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaudeConnectionState {
    version: u8,
    cli_path: String,
    backup_file_name: String,
    before_digest: String,
    after_digest: String,
    inserted_hooks_container: bool,
    #[serde(default)]
    wrapped_status_line: bool,
}

fn digest_text(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_backup_name(value: &str) -> bool {
    value.starts_with("settings.json.openlimiter-backup-")
        && value.ends_with(".json")
        && !value.contains(['/', '\\'])
}

fn state_file(state_directory: &Path) -> PathBuf {
    state_directory.join(CONNECTION_STATE_FILE)
}

fn read_connection_state(
    state_directory: &Path,
) -> Result<Option<ClaudeConnectionState>, ClaudeConnectError> {
    let file = state_file(state_directory);
    let Some(text) = fsx::bounded_read(&file) else {
        return match std::fs::symlink_metadata(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => Err(ClaudeConnectError::Storage),
        };
    };
    let state: ClaudeConnectionState =
        serde_json::from_str(&text).map_err(|_| ClaudeConnectError::Storage)?;
    if state.version != CONNECTION_STATE_VERSION
        || !Path::new(&state.cli_path).is_absolute()
        || !valid_backup_name(&state.backup_file_name)
        || !valid_digest(&state.before_digest)
        || !valid_digest(&state.after_digest)
    {
        return Err(ClaudeConnectError::Storage);
    }
    Ok(Some(state))
}

fn write_connection_state(
    state_directory: &Path,
    state: &ClaudeConnectionState,
) -> Result<(), ClaudeConnectError> {
    fsx::ensure_private_dir(state_directory).map_err(|_| ClaudeConnectError::Storage)?;
    let text = serde_json::to_string(state).map_err(|_| ClaudeConnectError::Storage)?;
    fsx::atomic_write(&state_file(state_directory), &text).map_err(|_| ClaudeConnectError::Storage)
}

fn remove_connection_state(state_directory: &Path) -> Result<(), ClaudeConnectError> {
    let file = state_file(state_directory);
    fsx::reject_symlink(&file).map_err(|_| ClaudeConnectError::Storage)?;
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ClaudeConnectError::Storage),
    }
}

fn cleanup_stale_temporaries(settings_file: &Path) -> Result<(), ClaudeConnectError> {
    let Some(directory) = settings_file.parent() else {
        return Err(ClaudeConnectError::Storage);
    };
    let prefix = format!(
        "{}.{}.",
        settings_file
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or(ClaudeConnectError::Storage)?,
        SETTINGS_TEMP_MARKER
    );
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(ClaudeConnectError::Storage),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(&prefix) || !name.ends_with(".tmp") {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_file() && !metadata.file_type().is_symlink() {
            std::fs::remove_file(path).map_err(|_| ClaudeConnectError::Storage)?;
        }
    }
    Ok(())
}

fn backup_name() -> String {
    format!(
        "settings.json.openlimiter-backup-{}-{}.json",
        crate::connections::now_epoch_ms(),
        uuid::Uuid::new_v4()
    )
}

fn backup_before_change<T>(
    backup: impl FnOnce() -> Result<(), ClaudeConnectError>,
    change: impl FnOnce() -> Result<T, ClaudeConnectError>,
) -> Result<T, ClaudeConnectError> {
    backup()?;
    change()
}

fn apply_with_runtime(
    home: &Path,
    state_directory: &Path,
    input: ClaudeConnectInput,
    runtime: &impl CliRuntime,
    wrapper_feature_enabled: bool,
) -> Result<ClaudeApplyOutcome, ClaudeConnectError> {
    let prepared = prepare_preflight(
        Some(home),
        input.configured_cli_path.as_deref(),
        runtime,
        wrapper_feature_enabled,
    );
    let wrapped_status_line = prepared.verdict.kind == ClaudePreflightKind::WrappableStatusLine;
    if prepared.verdict.kind != ClaudePreflightKind::Ready && !wrapped_status_line {
        return Err(ClaudeConnectError::CleanPreflightRequired);
    }
    let cli_path = prepared
        .cli_path
        .ok_or(ClaudeConnectError::CleanPreflightRequired)?;
    let settings = prepared
        .settings
        .ok_or(ClaudeConnectError::SettingsUnreadable)?;
    cleanup_stale_temporaries(&settings.file)?;
    if let Some(existing) = read_connection_state(state_directory)? {
        if existing.after_digest == digest_text(&settings.text) {
            return Ok(ClaudeApplyOutcome::AlreadyApplied);
        }
        return Err(ClaudeConnectError::CleanPreflightRequired);
    }
    let parent = settings.file.parent().ok_or(ClaudeConnectError::Storage)?;
    fsx::ensure_private_dir(parent).map_err(|_| ClaudeConnectError::Storage)?;
    let backup_file_name = backup_name();
    let backup = parent.join(&backup_file_name);
    let (after, inserted_hooks_container) = backup_before_change(
        || fsx::atomic_write(&backup, &settings.text).map_err(|_| ClaudeConnectError::Storage),
        || {
            let original_statusline_command = if wrapped_status_line {
                Some(
                    analyze_settings(&settings.text, &cli_path)
                        .wrappable_status_line_command
                        .ok_or(ClaudeConnectError::CleanPreflightRequired)?,
                )
            } else {
                None
            };
            let result = apply_surgical(
                &settings.text,
                &cli_path,
                original_statusline_command
                    .as_ref()
                    .map(|command| command.as_str()),
            )
            .ok_or(ClaudeConnectError::SettingsUnreadable)?;
            fsx::atomic_write_with_marker(&settings.file, &result.0, SETTINGS_TEMP_MARKER)
                .map_err(|_| ClaudeConnectError::Storage)?;
            Ok(result)
        },
    )?;
    let state = ClaudeConnectionState {
        version: CONNECTION_STATE_VERSION,
        cli_path: cli_path
            .to_str()
            .ok_or(ClaudeConnectError::Storage)?
            .to_string(),
        backup_file_name,
        before_digest: digest_text(&settings.text),
        after_digest: digest_text(&after),
        inserted_hooks_container,
        wrapped_status_line,
    };
    if let Err(error) = write_connection_state(state_directory, &state) {
        let _ = fsx::atomic_write_with_marker(&settings.file, &settings.text, SETTINGS_TEMP_MARKER);
        return Err(error);
    }
    Ok(ClaudeApplyOutcome::Applied)
}

pub fn apply(input: ClaudeConnectInput) -> Result<ClaudeApplyOutcome, ClaudeConnectError> {
    let home = crate::state::home().ok_or(ClaudeConnectError::Storage)?;
    let state_directory = crate::state::state_directory().ok_or(ClaudeConnectError::Storage)?;
    apply_with_runtime(
        &home,
        &state_directory,
        input,
        &SystemCliRuntime,
        statusline_wrapper_enabled(),
    )
}

fn disconnect_in(
    home: &Path,
    state_directory: &Path,
) -> Result<ClaudeDisconnectOutcome, ClaudeConnectError> {
    let Some(state) = read_connection_state(state_directory)? else {
        return Ok(ClaudeDisconnectOutcome::NothingToRemove);
    };
    let settings = settings_in_home(home)?;
    cleanup_stale_temporaries(&settings.file)?;
    let current_digest = digest_text(&settings.text);
    let before = if current_digest == state.after_digest || state.wrapped_status_line {
        let backup = settings
            .file
            .parent()
            .ok_or(ClaudeConnectError::Storage)?
            .join(&state.backup_file_name);
        let before = fsx::bounded_read(&backup).ok_or(ClaudeConnectError::Storage)?;
        if digest_text(&before) != state.before_digest {
            return Err(ClaudeConnectError::Storage);
        }
        Some(Zeroizing::new(before))
    } else {
        None
    };
    let next = if current_digest == state.after_digest {
        let before = before.as_ref().ok_or(ClaudeConnectError::Storage)?;
        let restored = remove_owned_entries(
            &settings.text,
            Path::new(&state.cli_path),
            state.inserted_hooks_container,
            state.wrapped_status_line.then_some(before.as_str()),
        )
        .ok_or(ClaudeConnectError::SettingsUnreadable)?
        .0;
        if restored != **before {
            return Err(ClaudeConnectError::Storage);
        }
        (before.to_string(), ClaudeDisconnectOutcome::RestoredExact)
    } else {
        let (edited, changed) = remove_owned_entries(
            &settings.text,
            Path::new(&state.cli_path),
            state.inserted_hooks_container,
            if state.wrapped_status_line {
                Some(before.as_ref().ok_or(ClaudeConnectError::Storage)?.as_str())
            } else {
                None
            },
        )
        .ok_or(ClaudeConnectError::SettingsUnreadable)?;
        (
            edited,
            if changed {
                ClaudeDisconnectOutcome::RemovedOwnedEntries
            } else {
                ClaudeDisconnectOutcome::NothingToRemove
            },
        )
    };
    if next.0 != *settings.text {
        fsx::atomic_write_with_marker(&settings.file, &next.0, SETTINGS_TEMP_MARKER)
            .map_err(|_| ClaudeConnectError::Storage)?;
    }
    remove_connection_state(state_directory)?;
    Ok(next.1)
}

pub fn disconnect() -> Result<ClaudeDisconnectOutcome, ClaudeConnectError> {
    let home = crate::state::home().ok_or(ClaudeConnectError::Storage)?;
    let state_directory = crate::state::state_directory().ok_or(ClaudeConnectError::Storage)?;
    disconnect_in(&home, &state_directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const SETTINGS_CANARY: &str = "settings-secret-canary-never-export-123456";

    struct FakeRuntime {
        path: Option<PathBuf>,
        works: bool,
    }

    impl FakeRuntime {
        fn working(path: PathBuf) -> Self {
            Self {
                path: Some(path),
                works: true,
            }
        }
    }

    impl CliRuntime for FakeRuntime {
        fn resolve(&self, _configured: Option<&str>) -> Option<PathBuf> {
            self.path.clone()
        }

        fn probe(&self, path: &Path) -> bool {
            self.works && self.path.as_deref() == Some(path)
        }
    }

    fn absolute_cli(dir: &TempDir) -> PathBuf {
        dir.path().join(if cfg!(windows) {
            "npm/openlimiter.cmd"
        } else {
            "npm/bin/openlimiter"
        })
    }

    fn write_settings(dir: &TempDir, text: &str) -> PathBuf {
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).expect("directory");
        let file = claude.join("settings.json");
        std::fs::write(&file, text).expect("settings");
        file
    }

    #[test]
    fn a_resolved_path_never_keeps_the_verbatim_prefix() {
        /* The command interpreter refuses a verbatim path outright, so a
        resolved tool carrying one would fail its own probe and would also be
        written into the settings file as an entry that can never run. */
        assert_eq!(
            without_verbatim_prefix(PathBuf::from(r"\\?\C:\tools\openlimiter.cmd")),
            PathBuf::from(r"C:\tools\openlimiter.cmd")
        );
        assert_eq!(
            without_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\openlimiter.cmd")),
            PathBuf::from(r"\\server\share\openlimiter.cmd")
        );
        /* A path that never had the prefix is returned exactly as it came. */
        assert_eq!(
            without_verbatim_prefix(PathBuf::from("/usr/local/bin/openlimiter")),
            PathBuf::from("/usr/local/bin/openlimiter")
        );
    }

    #[test]
    #[cfg(windows)]
    fn a_real_resolved_tool_is_runnable_by_the_command_interpreter() {
        /* The regression this closes: a canonicalized path that the probe
        cannot execute made every Windows machine report the tool as broken. */
        let dir = TempDir::new();
        let bin = dir.path().join("npm");
        std::fs::create_dir_all(&bin).expect("directory");
        let file = bin.join("openlimiter.cmd");
        std::fs::write(&file, "@echo off\r\nexit /b 0\r\n").expect("tool");
        let resolved = regular_absolute(&file).expect("resolved");
        assert!(
            !resolved.to_str().expect("text").starts_with(r"\\?\"),
            "a resolved tool path must not carry the verbatim prefix"
        );
        assert!(
            SystemCliRuntime.probe(&resolved),
            "the probe refused a runnable tool at {}",
            resolved.display()
        );
    }

    #[test]
    fn preflight_refuses_a_foreign_status_line() {
        let dir = TempDir::new();
        write_settings(
            &dir,
            r#"{"statusLine":{"type":"command","command":"other meter"}}"#,
        );
        let runtime = FakeRuntime::working(absolute_cli(&dir));
        let verdict = prepare_preflight(Some(dir.path()), None, &runtime, false).verdict;
        assert_eq!(verdict.kind, ClaudePreflightKind::GuidedManual);
        assert!(verdict.cli_found);
        assert!(verdict.cli_working);
        assert!(verdict.settings_shape_known);
        assert!(verdict.foreign_status_line);
        assert!(!verdict.foreign_user_prompt_submit_hooks);
    }

    #[test]
    fn enabled_flag_offers_a_readable_foreign_status_line_wrapper() {
        let dir = TempDir::new();
        write_settings(
            &dir,
            r#"{"statusLine":{"type":"command","command":"other meter"}}"#,
        );
        let runtime = FakeRuntime::working(absolute_cli(&dir));
        let verdict = prepare_preflight(Some(dir.path()), None, &runtime, true).verdict;
        assert_eq!(verdict.kind, ClaudePreflightKind::WrappableStatusLine);
        assert!(verdict.foreign_status_line);
        assert!(!verdict.foreign_user_prompt_submit_hooks);
    }

    #[test]
    fn enabled_flag_still_refuses_a_foreign_prompt_hook() {
        let dir = TempDir::new();
        write_settings(
            &dir,
            concat!(
                r#"{"statusLine":{"type":"command","command":"other meter"},"#,
                r#""hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"other hook"}]}]}}"#,
            ),
        );
        let runtime = FakeRuntime::working(absolute_cli(&dir));
        let verdict = prepare_preflight(Some(dir.path()), None, &runtime, true).verdict;
        assert_eq!(verdict.kind, ClaudePreflightKind::GuidedManual);
        assert!(verdict.foreign_status_line);
        assert!(verdict.foreign_user_prompt_submit_hooks);
    }

    #[test]
    fn enabled_flag_refuses_an_unreadable_status_line_command() {
        let dir = TempDir::new();
        write_settings(&dir, r#"{"statusLine":{"type":"command","command":42}}"#);
        let runtime = FakeRuntime::working(absolute_cli(&dir));
        let verdict = prepare_preflight(Some(dir.path()), None, &runtime, true).verdict;
        assert_eq!(verdict.kind, ClaudePreflightKind::GuidedManual);
        assert!(verdict.foreign_status_line);
    }

    #[test]
    fn enabled_flag_never_wraps_an_existing_wrapper_again() {
        let dir = TempDir::new();
        let cli = absolute_cli(&dir);
        let wrapper = wrapped_statusline_command(&cli, "foreign status").expect("wrapper");
        let settings = serde_json::to_string(&serde_json::json!({
            "statusLine": {
                "type": "command",
                "command": wrapper
            }
        }))
        .expect("settings");
        write_settings(&dir, &settings);
        let runtime = FakeRuntime::working(cli);
        let verdict = prepare_preflight(Some(dir.path()), None, &runtime, true).verdict;
        assert_eq!(verdict.kind, ClaudePreflightKind::GuidedManual);
        assert!(verdict.foreign_status_line);
    }

    #[test]
    fn preflight_refuses_a_foreign_user_prompt_submit_hook() {
        let dir = TempDir::new();
        write_settings(
            &dir,
            r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"other hook"}]}]}}"#,
        );
        let runtime = FakeRuntime::working(absolute_cli(&dir));
        let verdict = prepare_preflight(Some(dir.path()), None, &runtime, false).verdict;
        assert_eq!(verdict.kind, ClaudePreflightKind::GuidedManual);
        assert!(!verdict.foreign_status_line);
        assert!(verdict.foreign_user_prompt_submit_hooks);
    }

    #[test]
    fn cli_missing_has_the_one_copyable_install_command() {
        let dir = TempDir::new();
        write_settings(&dir, "{}");
        let runtime = FakeRuntime {
            path: None,
            works: false,
        };
        let verdict = prepare_preflight(Some(dir.path()), None, &runtime, false).verdict;
        assert_eq!(verdict.kind, ClaudePreflightKind::CliMissing);
        assert!(!verdict.cli_found);
        assert!(!verdict.cli_working);
        assert_eq!(verdict.install_command, "npm install -g openlimiter");
    }

    #[test]
    fn apply_then_disconnect_is_byte_identical() {
        let dir = TempDir::new();
        let original = concat!(
            "{\r\n",
            "  \"canary\" : \"keep this byte for byte\",\n",
            "  \"hooks\": { \"OtherEvent\" : [ {\"value\":1} ] },\r\n",
            "  \"tail\" : true\n",
            "}\r\n"
        );
        let file = write_settings(&dir, original);
        let state = dir.path().join("state");
        let cli = absolute_cli(&dir);
        let runtime = FakeRuntime::working(cli);
        assert_eq!(
            apply_with_runtime(
                dir.path(),
                &state,
                ClaudeConnectInput::default(),
                &runtime,
                false,
            ),
            Ok(ClaudeApplyOutcome::Applied)
        );
        assert_ne!(std::fs::read_to_string(&file).expect("applied"), original);
        assert_eq!(
            disconnect_in(dir.path(), &state),
            Ok(ClaudeDisconnectOutcome::RestoredExact)
        );
        assert_eq!(std::fs::read_to_string(file).expect("restored"), original);
    }

    #[test]
    fn wrapper_transport_encodes_every_shell_quoting_landmine() {
        let dir = TempDir::new();
        let cli = absolute_cli(&dir);
        let original = r#""C:\Program Files\meter\status.cmd" "double quoted" 'single quoted' C:\Users\Name\file & 100%"#;
        let encoded = base64url_encode(original);
        assert_eq!(
            encoded,
            "IkM6XFByb2dyYW0gRmlsZXNcbWV0ZXJcc3RhdHVzLmNtZCIgImRvdWJsZSBxdW90ZWQiICdzaW5nbGUgcXVvdGVkJyBDOlxVc2Vyc1xOYW1lXGZpbGUgJiAxMDAl"
        );
        assert!(encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
        let wrapped = wrapped_statusline_command(&cli, original).expect("wrapper");
        assert!(wrapped.ends_with(&format!("statusline --wrap {encoded}")));
        assert!(!wrapped.contains(original));
    }

    #[test]
    fn wrapper_connect_then_disconnect_restores_the_original_command_exactly() {
        let dir = TempDir::new();
        let original_command = r#""C:\Program Files\meter\status.cmd" "double quoted" 'single quoted' C:\Users\Name\file & 100%"#;
        let original_settings = serde_json::to_string(&serde_json::json!({
            "statusLine": {
                "type": "command",
                "command": original_command,
                "padding": 0
            },
            "keep": true
        }))
        .expect("settings");
        let file = write_settings(&dir, &original_settings);
        let state = dir.path().join("state");
        let cli = absolute_cli(&dir);
        let runtime = FakeRuntime::working(cli.clone());
        assert_eq!(
            apply_with_runtime(
                dir.path(),
                &state,
                ClaudeConnectInput::default(),
                &runtime,
                true,
            ),
            Ok(ClaudeApplyOutcome::Applied)
        );
        let applied_text = std::fs::read_to_string(&file).expect("applied");
        let applied: serde_json::Value = serde_json::from_str(&applied_text).expect("json");
        assert_eq!(
            applied["statusLine"]["command"],
            wrapped_statusline_command(&cli, original_command).expect("wrapper command")
        );
        let claude = file.parent().expect("claude directory");
        let backups: Vec<PathBuf> = std::fs::read_dir(claude)
            .expect("backups")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(valid_backup_name)
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read_to_string(&backups[0]).expect("backup"),
            original_settings
        );
        assert_eq!(
            disconnect_in(dir.path(), &state),
            Ok(ClaudeDisconnectOutcome::RestoredExact)
        );
        assert_eq!(
            std::fs::read_to_string(file).expect("restored"),
            original_settings
        );
    }

    #[test]
    fn modified_disconnect_restores_only_the_original_status_line() {
        let dir = TempDir::new();
        let original_command = "foreign status --value exact";
        let original_settings = serde_json::to_string(&serde_json::json!({
            "statusLine": {
                "type": "command",
                "command": original_command,
                "padding": 0
            },
            "keep": 1
        }))
        .expect("settings");
        let file = write_settings(&dir, &original_settings);
        let state = dir.path().join("state");
        let cli = absolute_cli(&dir);
        let runtime = FakeRuntime::working(cli);
        apply_with_runtime(
            dir.path(),
            &state,
            ClaudeConnectInput::default(),
            &runtime,
            true,
        )
        .expect("apply");
        let applied = std::fs::read_to_string(&file).expect("applied");
        let mut modified: serde_json::Value = serde_json::from_str(&applied).expect("json");
        let root = modified.as_object_mut().expect("object");
        root.insert("keep".to_string(), serde_json::json!(2));
        root.insert("foreign".to_string(), serde_json::json!(true));
        root.get_mut("statusLine")
            .and_then(serde_json::Value::as_object_mut)
            .expect("status line")
            .insert("padding".to_string(), serde_json::json!(7));
        std::fs::write(
            &file,
            serde_json::to_string(&modified).expect("modified settings"),
        )
        .expect("user edit");
        assert_eq!(
            disconnect_in(dir.path(), &state),
            Ok(ClaudeDisconnectOutcome::RemovedOwnedEntries)
        );
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(file).expect("after")).expect("json");
        assert_eq!(after["statusLine"]["command"], original_command);
        assert_eq!(after["statusLine"]["padding"], 7);
        assert_eq!(after["keep"], 2);
        assert_eq!(after["foreign"], true);
        assert!(after.get("hooks").is_none());
    }

    #[test]
    fn backup_primitive_runs_before_any_change() {
        use std::cell::RefCell;

        let events = RefCell::new(Vec::new());
        let value = backup_before_change(
            || {
                events.borrow_mut().push("backup");
                Ok(())
            },
            || {
                assert_eq!(&*events.borrow(), &["backup"]);
                events.borrow_mut().push("change");
                Ok(42)
            },
        )
        .expect("ordered");
        assert_eq!(value, 42);
        assert_eq!(&*events.borrow(), &["backup", "change"]);
    }

    #[test]
    fn apply_writes_the_absolute_cli_path_to_both_commands() {
        let dir = TempDir::new();
        let file = write_settings(&dir, "{}");
        let state = dir.path().join("state");
        let cli = absolute_cli(&dir);
        let runtime = FakeRuntime::working(cli.clone());
        apply_with_runtime(
            dir.path(),
            &state,
            ClaudeConnectInput::default(),
            &runtime,
            false,
        )
        .expect("apply");
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(file).expect("settings")).expect("json");
        let expected_status = quoted_command(&cli, "statusline").expect("command");
        let expected_hook = quoted_command(&cli, "hook").expect("command");
        assert_eq!(settings["statusLine"]["command"], expected_status);
        assert_eq!(
            settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
            expected_hook
        );
        assert!(cli.is_absolute());
    }

    #[test]
    fn modified_disconnect_removes_only_our_entries() {
        let dir = TempDir::new();
        let file = write_settings(&dir, r#"{"keep":1}"#);
        let state = dir.path().join("state");
        let cli = absolute_cli(&dir);
        let runtime = FakeRuntime::working(cli);
        apply_with_runtime(
            dir.path(),
            &state,
            ClaudeConnectInput::default(),
            &runtime,
            false,
        )
        .expect("apply");
        let applied = std::fs::read_to_string(&file).expect("applied");
        let modified = applied.replacen("\"keep\":1", "\"keep\":2,\"newForeignKey\":true", 1);
        std::fs::write(&file, modified).expect("user edit");
        assert_eq!(
            disconnect_in(dir.path(), &state),
            Ok(ClaudeDisconnectOutcome::RemovedOwnedEntries)
        );
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(file).expect("after")).expect("json");
        assert_eq!(after["keep"], 2);
        assert_eq!(after["newForeignKey"], true);
        assert!(after.get("statusLine").is_none());
        assert!(after.get("hooks").is_none());
    }

    #[test]
    fn settings_canary_never_reaches_an_ipc_error_or_debug_payload() {
        let dir = TempDir::new();
        write_settings(
            &dir,
            &format!(r#"{{"unrelatedSecret":"{SETTINGS_CANARY}"}}"#),
        );
        let runtime = FakeRuntime::working(absolute_cli(&dir));
        let prepared = prepare_preflight(Some(dir.path()), None, &runtime, false);
        let payload = serde_json::to_string(&prepared.verdict).expect("wire");
        let outcomes = format!(
            "{:?}{:?}{:?}",
            ClaudeApplyOutcome::Applied,
            ClaudeDisconnectOutcome::RestoredExact,
            ClaudeConnectError::SettingsUnreadable
        );
        let errors = [
            ClaudeConnectError::CleanPreflightRequired,
            ClaudeConnectError::SettingsUnreadable,
            ClaudeConnectError::Storage,
        ]
        .map(|error| error.to_string())
        .join(" ");
        for exported in [payload, outcomes, errors] {
            assert!(!exported.contains(SETTINGS_CANARY));
        }
        let source = include_str!("claude_connect.rs");
        for forbidden in [["print", "ln!"], ["eprint", "ln!"]] {
            assert!(!source.contains(&forbidden.concat()));
        }
    }

    #[test]
    fn a_crash_temporary_is_cleaned_while_the_real_file_stays_intact() {
        let dir = TempDir::new();
        let original = r#"{"real":"intact"}"#;
        let file = write_settings(&dir, original);
        let temporary = file.with_file_name("settings.json.openlimiter.crash.tmp");
        std::fs::write(&temporary, r#"{"partial":true}"#).expect("temporary");
        cleanup_stale_temporaries(&file).expect("cleanup");
        assert!(!temporary.exists());
        assert_eq!(std::fs::read_to_string(file).expect("real"), original);
    }
}
