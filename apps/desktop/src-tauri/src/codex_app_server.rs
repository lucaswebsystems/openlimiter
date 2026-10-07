use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::provider_detection::{opaque_account_id, DetectedProviderId};

const MAX_STDIO_BYTES: usize = 1_048_576;
pub const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppServerFailure {
    NeedsSignIn,
    IdentityMismatch,
    Timeout,
    Unavailable,
    MissingExecutable,
    RateLimited(Option<u64>),
    Protocol,
}

#[derive(Debug)]
pub struct RateLimitsPayload {
    pub body: String,
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
    error.get("code").and_then(Value::as_i64) == Some(-32600)
        && matches!(
            error.get("message").and_then(Value::as_str),
            Some("chatgpt authentication required to read rate limits")
                | Some("codex account authentication required to read rate limits")
        )
}

fn valid_account_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

/// Read the documented Codex rate limit RPC over newline delimited JSON stdio.
/// Protocol pinned 2026-10-01: https://learn.chatgpt.com/docs/app-server
pub fn read_rate_limits_for_home(
    executable: &Path,
    codex_home: &Path,
    expected_account_id: &str,
) -> Result<RateLimitsPayload, AppServerFailure> {
    read_rate_limits_with(
        executable,
        &[],
        &[],
        codex_home,
        expected_account_id,
        TIMEOUT,
    )
}

fn read_rate_limits_with(
    executable: &Path,
    argument_prefix: &[&str],
    environment: &[(&str, &str)],
    codex_home: &Path,
    expected_account_id: &str,
    timeout: Duration,
) -> Result<RateLimitsPayload, AppServerFailure> {
    if executable.as_os_str().is_empty()
        || codex_home.as_os_str().is_empty()
        || !valid_account_id(expected_account_id)
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
        .envs(environment.iter().copied())
        .env("CODEX_HOME", codex_home);
    suppress_window(&mut command);
    let mut child = OwnedChild(command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppServerFailure::MissingExecutable
        } else {
            AppServerFailure::Unavailable
        }
    })?);
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
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(line).map_err(|_| AppServerFailure::Protocol)?;
        if message.get("id").and_then(Value::as_i64) == Some(0) {
            if message.get("error").is_some()
                || !message.get("result").is_some_and(Value::is_object)
            {
                return Err(AppServerFailure::Protocol);
            }
            initialized = true;
            send(
                &mut stdin,
                &json!({ "method": "initialized", "params": {} }),
            )?;
            send(
                &mut stdin,
                &json!({ "method": "account/rateLimits/read", "id": 1 }),
            )?;
            continue;
        }
        if message.get("id").and_then(Value::as_i64) != Some(1) || !initialized {
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
        if let Some(account_id) = result.get("accountId").filter(|value| !value.is_null()) {
            let account_id = account_id.as_str().ok_or(AppServerFailure::Protocol)?;
            if !valid_account_id(account_id) {
                return Err(AppServerFailure::Protocol);
            }
            if opaque_account_id(DetectedProviderId::Codex, account_id) != expected_account_id {
                return Err(AppServerFailure::IdentityMismatch);
            }
        }
        return Ok(RateLimitsPayload {
            body: serde_json::to_string(result).map_err(|_| AppServerFailure::Protocol)?,
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

    fn fixture_read(
        scenario: &str,
        timeout: Duration,
    ) -> Result<RateLimitsPayload, AppServerFailure> {
        let expected = opaque_account_id(DetectedProviderId::Codex, "synthetic-chatgpt-account");
        read_rate_limits_with(
            Path::new("node"),
            &[fixture().to_str().expect("fixture path")],
            &[("OPENLIMITER_FAKE_CODEX_SCENARIO", scenario)],
            Path::new("synthetic-codex-home"),
            &expected,
            timeout,
        )
    }

    #[test]
    fn fixture_speaks_the_documented_exchange() {
        let result = fixture_read("success", Duration::from_secs(2)).expect("documented response");
        assert!(result.body.contains("rateLimitsByLimitId"));
    }

    #[test]
    fn empty_line_head_probe_ignores_blank_lines() {
        let result = fixture_read("empty-line", Duration::from_secs(2)).expect("documented response");
        assert!(result.body.contains("rateLimitsByLimitId"));
    }

    #[test]
    fn missing_or_null_response_identity_uses_the_resolved_home_identity() {
        for scenario in ["missing-identity", "null-identity"] {
            assert!(
                fixture_read(scenario, Duration::from_secs(2)).is_ok(),
                "{scenario}"
            );
        }
    }

    #[test]
    fn response_identity_mismatch_is_refused() {
        assert_eq!(
            fixture_read("identity-mismatch", Duration::from_secs(2)).unwrap_err(),
            AppServerFailure::IdentityMismatch
        );
    }

    #[test]
    fn documented_signed_out_errors_are_needs_sign_in() {
        for scenario in ["signed-out", "signed-out-codex"] {
            assert_eq!(
                fixture_read(scenario, Duration::from_secs(2)).unwrap_err(),
                AppServerFailure::NeedsSignIn,
                "{scenario}"
            );
        }
    }

    #[test]
    fn output_without_a_newline_is_bounded_before_line_assembly() {
        assert_eq!(
            fixture_read("oversized-no-newline", Duration::from_secs(2)).unwrap_err(),
            AppServerFailure::Protocol
        );
    }

    #[test]
    fn missing_binary_is_distinct_from_transport_unavailability() {
        assert_eq!(
            read_rate_limits_for_home(
                Path::new("definitely-missing-codex-binary"),
                Path::new("synthetic-codex-home"),
                &opaque_account_id(DetectedProviderId::Codex, "synthetic-chatgpt-account")
            )
            .unwrap_err(),
            AppServerFailure::MissingExecutable
        );
    }

    #[test]
    fn silent_server_is_killed_at_the_deadline() {
        assert_eq!(
            fixture_read("timeout", Duration::from_millis(100)).unwrap_err(),
            AppServerFailure::Timeout
        );
    }

    #[test]
    fn protocol_errors_are_distinct_from_signed_out() {
        assert_eq!(
            fixture_read("protocol-error", Duration::from_secs(2)).unwrap_err(),
            AppServerFailure::Protocol
        );
    }
}
