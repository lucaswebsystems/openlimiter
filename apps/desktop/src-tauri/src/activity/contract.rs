//! Rust mirror of packages/core/src/activity/contract.ts, version 1.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const EVENT_BYTES: usize = 8 * 1024;
pub const SPOOL_BYTES: u64 = 16 * 1024 * 1024;
pub const DAY: i64 = 86_400_000;
pub const LIVE_SESSIONS: usize = 64;
pub const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Process {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ppid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub version: u8,
    pub event_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_alias: Option<String>,
    pub observed_at: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    pub source: String,
    pub confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<Process>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_sidechain: Option<bool>,
}

pub fn instant(value: &str) -> Option<i64> {
    let parsed = DateTime::parse_from_rfc3339(value).ok()?;
    (parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        == value
        && value.len() == 24)
        .then(|| parsed.timestamp_millis())
}

pub fn timestamp(now: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(now)
        .expect("OS timestamp")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 256
        && !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

pub fn provider(agent: &str) -> Option<&'static str> {
    Some(match agent {
        "claude_code" => "CLAUDE",
        "codex" => "CODEX",
        "muse" => "MUSE",
        "gemini_cli" => "GEMINI_CLI",
        "cursor" => "CURSOR",
        "kimi" => "KIMI",
        "grok" => "GROK",
        "antigravity" => "ANTIGRAVITY",
        _ => return None,
    })
}

impl Event {
    pub fn read(bytes: &[u8], now: i64) -> Option<Self> {
        if bytes.len() > EVENT_BYTES {
            return None;
        }
        // Optional means absent, not JSON null, in the frozen TS validator.
        let mut value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
        if value.as_object()?.values().any(serde_json::Value::is_null) {
            return None;
        }
        if let Some(p) = value.get("process") {
            if p.as_object()?.values().any(serde_json::Value::is_null) {
                return None;
            }
        }
        // JSON has one number type. TS accepts 1.0 and 1e3 as safe integers.
        fn number(value: &mut serde_json::Value) -> Option<()> {
            let number = value.as_f64()?;
            if !number.is_finite()
                || number < 0.0
                || number > SAFE_INTEGER as f64
                || number.fract() != 0.0
            {
                return None;
            }
            *value = serde_json::Value::from(number as u64);
            Some(())
        }
        number(value.get_mut("version")?)?;
        number(value.get_mut("sequence")?)?;
        if let Some(p) = value.get_mut("process") {
            for key in ["pid", "ppid"] {
                if let Some(v) = p.get_mut(key) {
                    number(v)?;
                }
            }
        }
        let event: Self = serde_json::from_value(value).ok()?;
        event.valid(now).then_some(event)
    }

    pub fn valid(&self, now: i64) -> bool {
        let Some(at) = instant(&self.observed_at) else {
            return false;
        };
        if self.version != 1
            || !identifier(&self.event_id)
            || !identifier(&self.session_id)
            || self.sequence > SAFE_INTEGER
            || provider(&self.agent).is_none()
            || !["busy", "waiting", "done", "idle", "unknown"].contains(&self.state.as_str())
            || !["hook", "registry", "transcript", "rollout", "editor_state"]
                .contains(&self.source.as_str())
            || !["explicit", "inferred"].contains(&self.confidence.as_str())
            || !(0..=DAY).contains(&now.saturating_sub(at))
        {
            return false;
        }
        if self
            .account_alias
            .as_deref()
            .is_some_and(|v| !identifier(v))
            || self
                .parent_session_id
                .as_deref()
                .is_some_and(|v| !identifier(v) || v == self.session_id)
            || self.signal.as_deref().is_some_and(|v| {
                ![
                    "observation",
                    "user_question",
                    "claude_stop",
                    "process_vanished",
                    "session_ended",
                ]
                .contains(&v)
            })
            || (self.signal.as_deref() == Some("claude_stop") && self.agent != "claude_code")
            || self
                .outcome
                .as_deref()
                .is_some_and(|v| !["cancelled", "failed"].contains(&v) || self.state == "done")
            || ((self.state == "done"
                || matches!(
                    self.signal.as_deref(),
                    Some("user_question" | "claude_stop")
                ))
                && self.confidence != "explicit")
        {
            return false;
        }
        if let Some(p) = &self.process {
            if p.ppid.is_some_and(|v| v == 0 || v > SAFE_INTEGER)
                || p.pid.is_some_and(|v| v == 0 || v > SAFE_INTEGER)
                || p.pid.is_some() != p.started_at.is_some()
                || p.started_at
                    .as_deref()
                    .is_some_and(|v| instant(v).is_none_or(|start| start > at))
                || (self.source == "hook"
                    && (p.ppid.is_none() || p.pid.is_some() || p.started_at.is_some()))
            {
                return false;
            }
        }
        true
    }
}

pub fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

pub fn session_key(agent: &str, session: &str) -> String {
    digest(&serde_json::to_vec(&["openlimiter.activity.v1", agent, session]).unwrap())
}
