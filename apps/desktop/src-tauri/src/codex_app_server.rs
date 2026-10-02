use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const MAX_STDIO_BYTES: usize = 1_048_576;
pub const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppServerFailure {
    NeedsSignIn,
    Timeout,
    Unavailable,
    Protocol,
}

#[derive(Debug)]
pub struct RateLimitsPayload {
    pub body: String,
    pub provider_account_id: Option<String>,
}

struct OwnedChild(Child);

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn send(stdin: &mut impl Write, message: &Value) -> Result<(), AppServerFailure> {
    serde_json::to_writer(&mut *stdin, message).map_err(|_| AppServerFailure::Protocol)?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|_| AppServerFailure::Unavailable)
}

fn authentication_required(error: &Value) -> bool {
    matches!(
        error.get("message").and_then(Value::as_str),
        Some("chatgpt authentication required to read rate limits")
            | Some("codex account authentication required to read rate limits")
    )
}

/// Read the documented Codex account and rate limit RPCs over newline delimited
/// JSON stdio.
/// Protocol pinned 2026-10-01:
/// https://learn.chatgpt.com/docs/app-server
/// https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol
pub fn read_rate_limits(executable: &Path) -> Result<RateLimitsPayload, AppServerFailure> {
    read_rate_limits_for_home(executable, None)
}

pub fn read_rate_limits_for_home(
    executable: &Path,
    codex_home: Option<&Path>,
) -> Result<RateLimitsPayload, AppServerFailure> {
    read_rate_limits_with(executable, &[], &[], codex_home, TIMEOUT)
}

fn read_rate_limits_with(
    executable: &Path,
    argument_prefix: &[&str],
    environment: &[(&str, &str)],
    codex_home: Option<&Path>,
    timeout: Duration,
) -> Result<RateLimitsPayload, AppServerFailure> {
    if executable.as_os_str().is_empty()
        || executable.extension().is_some_and(|extension| {
            matches!(
                extension.to_string_lossy().to_ascii_lowercase().as_str(),
                "cmd" | "bat"
            )
        })
    {
        return Err(AppServerFailure::Unavailable);
    }
    let mut command = Command::new(executable);
    command
        .args(argument_prefix)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .envs(environment.iter().copied());
    if let Some(home) = codex_home {
        command.env("CODEX_HOME", home);
    }
    suppress_window(&mut command);
    let mut child = OwnedChild(command.spawn().map_err(|_| AppServerFailure::Unavailable)?);
    let mut stdin = child.0.stdin.take().ok_or(AppServerFailure::Unavailable)?;
    let stdout = child.0.stdout.take().ok_or(AppServerFailure::Unavailable)?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = stdout;
        let mut total = 0usize;
        let mut buffered = Vec::new();
        let mut chunk = [0_u8; 8_192];
        loop {
            let read = match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            total = total.saturating_add(read);
            if total > MAX_STDIO_BYTES || buffered.len().saturating_add(read) > MAX_STDIO_BYTES {
                let _ = sender.send(Err(AppServerFailure::Protocol));
                return;
            }
            buffered.extend_from_slice(&chunk[..read]);
            while let Some(newline) = buffered.iter().position(|byte| *byte == b'\n') {
                let mut bytes: Vec<u8> = buffered.drain(..=newline).collect();
                bytes.pop();
                if bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
                let Ok(line) = String::from_utf8(bytes) else {
                    let _ = sender.send(Err(AppServerFailure::Protocol));
                    return;
                };
                if sender.send(Ok(line)).is_err() {
                    return;
                }
            }
        }
        let _ = sender.send(Err(AppServerFailure::Unavailable));
    });

    send(
        &mut stdin,
        &json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "openlimiter",
                    "title": "OpenLimiter",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }
        }),
    )?;

    let deadline = Instant::now() + timeout;
    let mut initialized = false;
    let mut workspace_account_id = None;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(AppServerFailure::Timeout)?;
        let line = receiver
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => AppServerFailure::Timeout,
                mpsc::RecvTimeoutError::Disconnected => AppServerFailure::Unavailable,
            })??;
        let message: Value = serde_json::from_str(&line).map_err(|_| AppServerFailure::Protocol)?;
        if message.get("id").and_then(Value::as_i64) == Some(0) {
            if message.get("error").is_some() || !message.get("result").is_some_and(Value::is_object)
            {
                return Err(AppServerFailure::Protocol);
            }
            initialized = true;
            send(&mut stdin, &json!({ "method": "initialized", "params": {} }))?;
            send(
                &mut stdin,
                &json!({
                    "method": "account/read",
                    "id": 1,
                    "params": { "refreshToken": false }
                }),
            )?;
            continue;
        }
        if message.get("id").and_then(Value::as_i64) == Some(1) && initialized {
            if message.get("error").is_some() {
                return Err(AppServerFailure::Protocol);
            }
            let result = message
                .get("result")
                .and_then(Value::as_object)
                .ok_or(AppServerFailure::Protocol)?;
            let account = result.get("account").ok_or(AppServerFailure::Protocol)?;
            if !account.is_null() {
                let _account = account.as_object().ok_or(AppServerFailure::Protocol)?;
            }
            workspace_account_id = result
                .get("workspaceRouting")
                .and_then(Value::as_object)
                .and_then(|routing| routing.get("chatgptAccountId"))
                .and_then(Value::as_str)
                .filter(|value| {
                    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
                })
                .map(str::to_string);
            send(
                &mut stdin,
                &json!({ "method": "account/rateLimits/read", "id": 2 }),
            )?;
            continue;
        }
        if message.get("id").and_then(Value::as_i64) != Some(2) || !initialized {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(if authentication_required(error) {
                AppServerFailure::NeedsSignIn
            } else {
                AppServerFailure::Protocol
            });
        }
        let result = message
            .get("result")
            .filter(|value| value.get("rateLimits").is_some_and(Value::is_object))
            .ok_or(AppServerFailure::Protocol)?;
        /* Main 342f8cc hashed auth.json tokens.account_id. The documented
        rate limit response calls the same ChatGPT account material accountId,
        so the opaque id remains byte identical without opening auth.json. */
        let provider_account_id = result
            .get("accountId")
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
            })
            .map(str::to_string)
            .or(workspace_account_id);
        return Ok(RateLimitsPayload {
            body: serde_json::to_string(result).map_err(|_| AppServerFailure::Protocol)?,
            provider_account_id,
        });
    }
}

#[cfg(windows)]
fn suppress_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/core/test/fixtures/fake-codex-app-server.mjs")
    }

    #[test]
    fn fixture_speaks_the_documented_handshake_and_rate_limit_rpc() {
        let result = read_rate_limits_with(
            Path::new("node"),
            &[fixture().to_str().expect("fixture path")],
            &[("OPENLIMITER_FAKE_CODEX_SCENARIO", "success")],
            None,
            Duration::from_secs(2),
        )
        .expect("documented response");
        assert_eq!(
            result.provider_account_id.as_deref(),
            Some("synthetic-chatgpt-account")
        );
        assert_eq!(
            crate::provider_detection::opaque_account_id(
                crate::provider_detection::DetectedProviderId::Codex,
                result.provider_account_id.as_deref().unwrap()
            ),
            "codex-824c7eddd1cf39d1d49b3ee8"
        );
        assert!(result.body.contains("rateLimitsByLimitId"));
    }

    #[test]
    fn documented_signed_out_error_is_needs_sign_in() {
        let result = read_rate_limits_with(
            Path::new("node"),
            &[fixture().to_str().expect("fixture path")],
            &[("OPENLIMITER_FAKE_CODEX_SCENARIO", "signed-out")],
            None,
            Duration::from_secs(2),
        );
        assert_eq!(result.unwrap_err(), AppServerFailure::NeedsSignIn);
    }

    #[test]
    fn workspace_routing_supplies_identity_when_rate_limits_omit_it() {
        let result = read_rate_limits_with(
            Path::new("node"),
            &[fixture().to_str().expect("fixture path")],
            &[("OPENLIMITER_FAKE_CODEX_SCENARIO", "workspace-identity")],
            None,
            Duration::from_secs(2),
        )
        .expect("documented response");
        assert_eq!(
            result.provider_account_id.as_deref(),
            Some("synthetic-workspace-account")
        );
    }

    #[test]
    fn missing_identity_stays_missing() {
        let result = read_rate_limits_with(
            Path::new("node"),
            &[fixture().to_str().expect("fixture path")],
            &[("OPENLIMITER_FAKE_CODEX_SCENARIO", "missing-identity")],
            None,
            Duration::from_secs(2),
        )
        .expect("documented response");
        assert_eq!(result.provider_account_id, None);
    }

    #[test]
    fn output_without_a_newline_is_bounded_before_line_assembly() {
        let result = read_rate_limits_with(
            Path::new("node"),
            &[fixture().to_str().expect("fixture path")],
            &[("OPENLIMITER_FAKE_CODEX_SCENARIO", "oversized-no-newline")],
            None,
            Duration::from_secs(2),
        );
        assert_eq!(result.unwrap_err(), AppServerFailure::Protocol);
    }

    #[test]
    fn missing_binary_is_unavailable() {
        assert_eq!(
            read_rate_limits(Path::new("definitely-missing-codex-binary")).unwrap_err(),
            AppServerFailure::Unavailable
        );
    }

    #[test]
    fn silent_server_is_killed_at_the_deadline() {
        let result = read_rate_limits_with(
            Path::new("node"),
            &[fixture().to_str().expect("fixture path")],
            &[("OPENLIMITER_FAKE_CODEX_SCENARIO", "timeout")],
            None,
            Duration::from_millis(100),
        );
        assert_eq!(result.unwrap_err(), AppServerFailure::Timeout);
    }
}
