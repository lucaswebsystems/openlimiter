use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::cache_write::{CacheWriteError, CacheWriter};
pub use crate::native_time::{
    epoch_ms_from_rfc3339, future_epoch_seconds, future_rfc3339, iso_from_epoch_ms,
};

pub const MAX_CACHE_ENTRIES: usize = 64;
const MAX_AMOUNT: f64 = 1_000_000.0;
const MAX_VALUE: f64 = 1_000_000_000_000.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotWindow {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorLabels {
    pub credential_origin: String,
    pub data_interface_status: String,
    pub automation_risk: String,
    pub verification: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub provider: String,
    pub meter: String,
    pub value: f64,
    pub unit: String,
    pub window: SnapshotWindow,
    pub reset_at: Option<String>,
    pub source: String,
    pub precision: String,
    pub observed_at: String,
    pub expires_at: String,
    pub labels: ConnectorLabels,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Suppression {
    provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    reason: String,
    suppressed_at: String,
}

#[derive(Clone)]
pub enum CacheReport {
    Success(Vec<Snapshot>),
    Drift { observed_at: String },
    Unavailable,
}

fn safe_identifier(value: &str, uppercase: bool, maximum: usize) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    let valid_first = if uppercase {
        first.is_ascii_uppercase()
    } else {
        first.is_ascii_lowercase() || first.is_ascii_digit()
    };
    valid_first
        && value.len() <= maximum
        && bytes.all(|byte| {
            if uppercase {
                byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
            } else {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
            }
        })
}

fn is_canonical_iso(value: &str) -> bool {
    epoch_ms_from_rfc3339(value)
        .and_then(iso_from_epoch_ms)
        .is_some_and(|canonical| canonical == value)
}

fn normalize_snapshot(mut row: Snapshot) -> Option<Snapshot> {
    let provider_ok = [
        "CLAUDE",
        "OPENROUTER",
        "CODEX",
        "ANTIGRAVITY",
        "OPENCODE",
        "MANUAL",
    ]
    .contains(&row.provider.as_str());
    let window_ok = ["rolling", "fixed", "lifetime", "unknown"].contains(&row.window.kind.as_str())
        && row
            .window
            .duration_seconds
            .is_none_or(|seconds| (1..=31_536_000).contains(&seconds));
    let labels_ok = [
        "official-local-tool",
        "user-key",
        "browser-session",
        "user-entered",
    ]
    .contains(&row.labels.credential_origin.as_str())
        && [
            "native-statusline-payload",
            "documented-api",
            "internal-endpoint",
            "authenticated-scrape",
            "manual",
        ]
        .contains(&row.labels.data_interface_status.as_str())
        && ["low", "high"].contains(&row.labels.automation_risk.as_str())
        && row.labels.verification == "UNVERIFIED";
    let basic = provider_ok
        && safe_identifier(&row.meter, true, 32)
        && row.value.is_finite()
        && row.value >= 0.0
        && row.value <= MAX_VALUE
        && ["PERCENT", "CREDITS", "TOKENS", "REQUESTS"].contains(&row.unit.as_str())
        && (row.unit != "PERCENT" || row.value <= 100.0)
        && window_ok
        && row.reset_at.as_deref().is_none_or(is_canonical_iso)
        && [
            "native_payload",
            "documented_api",
            "internal_payload",
            "authenticated_page",
            "manual_entry",
        ]
        .contains(&row.source.as_str())
        && ["exact", "estimated", "manual"].contains(&row.precision.as_str())
        && is_canonical_iso(&row.observed_at)
        && is_canonical_iso(&row.expires_at)
        && epoch_ms_from_rfc3339(&row.expires_at)? >= epoch_ms_from_rfc3339(&row.observed_at)?
        && row
            .account_id
            .as_deref()
            .is_none_or(|account| safe_identifier(account, false, 64))
        && labels_ok;
    if !basic {
        return None;
    }
    let amounts_ok = match (&row.used_amount, &row.limit_amount, &row.currency) {
        (None, None, None) => true,
        (Some(used), Some(limit), Some(currency)) => {
            used.is_finite()
                && limit.is_finite()
                && *used >= 0.0
                && *used <= *limit
                && *limit <= MAX_AMOUNT
                && currency == "USD"
        }
        _ => false,
    };
    if !amounts_ok {
        row.used_amount = None;
        row.limit_amount = None;
        row.currency = None;
    }
    if row.provenance.as_ref().is_some_and(|value| {
        let source_kind = value.get("sourceKind").and_then(Value::as_str);
        let observed_via = value.get("observedVia").and_then(Value::as_str);
        ![
            "statusline_payload",
            "explicit_ingest",
            "manual_document",
            "remote_api",
            "unknown",
        ]
        .contains(&source_kind.unwrap_or_default())
            || ![
                "claude_code_statusline",
                "ingest_command",
                "manual_json",
                "local_event",
                "local_file",
                "local_command",
                "remote_http",
                "user_entry",
                "unknown",
            ]
            .contains(&observed_via.unwrap_or_default())
    }) {
        row.provenance = Some(serde_json::json!({
            "observedVia": "unknown",
            "sourceKind": "unknown"
        }));
    }
    Some(row)
}

fn read_document(text: Option<&str>) -> Result<(Vec<Snapshot>, Vec<Suppression>), CacheWriteError> {
    let root = text
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let rows = root
        .get("snapshots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<Snapshot>(value.clone()).ok())
        .filter_map(normalize_snapshot)
        .collect();
    let suppressions = match root.get("suppressions") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(entries)) if entries.len() <= MAX_CACHE_ENTRIES => {
            let mut read = Vec::with_capacity(entries.len());
            for entry in entries {
                let suppression: Suppression =
                    serde_json::from_value(entry.clone()).map_err(|_| CacheWriteError::NotJson)?;
                let valid = suppression.reason == "drift"
                    && [
                        "CLAUDE",
                        "OPENROUTER",
                        "CODEX",
                        "ANTIGRAVITY",
                        "OPENCODE",
                        "MANUAL",
                    ]
                    .contains(&suppression.provider.as_str())
                    && is_canonical_iso(&suppression.suppressed_at)
                    && suppression
                        .account_id
                        .as_deref()
                        .is_none_or(|account| safe_identifier(account, false, 64));
                if !valid {
                    return Err(CacheWriteError::NotJson);
                }
                read.push(suppression);
            }
            read
        }
        Some(_) => return Err(CacheWriteError::NotJson),
    };
    Ok((rows, suppressions))
}

fn account_matches(existing: Option<&str>, target: Option<&str>) -> bool {
    existing == target || (target.is_some() && existing.is_none())
}

fn identity(row: &Snapshot) -> String {
    format!(
        "{} {}{}",
        row.provider,
        row.meter,
        row.account_id
            .as_deref()
            .map(|account| format!(" {account}"))
            .unwrap_or_default()
    )
}

fn fold(
    text: Option<&str>,
    provider: &str,
    account_id: Option<&str>,
    report: &CacheReport,
) -> Result<String, CacheWriteError> {
    let (mut rows, mut suppressions) = read_document(text)?;
    let belongs = |existing: Option<&str>| match report {
        CacheReport::Unavailable => existing == account_id,
        CacheReport::Success(_) | CacheReport::Drift { .. } => {
            account_matches(existing, account_id)
        }
    };
    rows.retain(|row| row.provider != provider || !belongs(row.account_id.as_deref()));
    suppressions
        .retain(|entry| entry.provider != provider || !belongs(entry.account_id.as_deref()));
    match report {
        CacheReport::Success(incoming) => {
            rows.extend(incoming.iter().cloned().filter_map(normalize_snapshot))
        }
        CacheReport::Drift { observed_at } => suppressions.push(Suppression {
            provider: provider.to_string(),
            account_id: account_id.map(str::to_string),
            reason: "drift".to_string(),
            suppressed_at: observed_at.clone(),
        }),
        CacheReport::Unavailable => {}
    }
    let mut by_identity = BTreeMap::new();
    for row in rows {
        by_identity.insert(identity(&row), row);
    }
    let mut rows: Vec<Snapshot> = by_identity.into_values().collect();
    if rows.len() > MAX_CACHE_ENTRIES {
        rows.sort_by(|left, right| {
            let left_ms = epoch_ms_from_rfc3339(&left.observed_at).unwrap_or(0);
            let right_ms = epoch_ms_from_rfc3339(&right.observed_at).unwrap_or(0);
            right_ms
                .cmp(&left_ms)
                .then_with(|| identity(left).cmp(&identity(right)))
        });
        rows.truncate(MAX_CACHE_ENTRIES);
        rows.sort_by_key(identity);
    }
    if suppressions.len() > MAX_CACHE_ENTRIES {
        suppressions.sort_by(|left, right| {
            let left_ms = epoch_ms_from_rfc3339(&left.suppressed_at).unwrap_or(0);
            let right_ms = epoch_ms_from_rfc3339(&right.suppressed_at).unwrap_or(0);
            right_ms.cmp(&left_ms).then(Ordering::Equal)
        });
        suppressions.truncate(MAX_CACHE_ENTRIES);
    }
    let mut document = Map::new();
    document.insert(
        "snapshots".to_string(),
        serde_json::to_value(rows).map_err(|_| CacheWriteError::Io)?,
    );
    if !suppressions.is_empty() {
        document.insert(
            "suppressions".to_string(),
            serde_json::to_value(suppressions).map_err(|_| CacheWriteError::Io)?,
        );
    }
    document.insert("version".to_string(), Value::from(2));
    serde_json::to_string(&Value::Object(document)).map_err(|_| CacheWriteError::Io)
}

pub fn write_report(
    writer: &CacheWriter,
    provider: &str,
    account_id: Option<&str>,
    report: CacheReport,
) -> Result<(), CacheWriteError> {
    for round in 0..2 {
        let begun = writer.begin()?;
        let text = match fold(begun.text.as_deref(), provider, account_id, &report) {
            Ok(text) => text,
            Err(error) => {
                writer.abort(begun.generation);
                return Err(error);
            }
        };
        match writer.commit(&text, begun.generation) {
            Ok(()) => return Ok(()),
            Err(CacheWriteError::Busy | CacheWriteError::StaleGeneration) if round == 0 => {}
            Err(error) => return Err(error),
        }
    }
    Err(CacheWriteError::Busy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_readers::parse_body;
    use crate::reader_registry::ReaderId;

    #[test]
    fn native_fold_commits_a_read_and_drift_never_writes_zero() {
        let now = epoch_ms_from_rfc3339("2026-08-16T12:00:00.000Z").expect("fixture clock");
        let account = "native-snapshot-test";
        let rows = parse_body(
            ReaderId::OpenrouterCredits,
            r#"{"data":{"total_credits":20,"total_usage":5}}"#,
            now,
            account,
        )
        .expect("readable fixture");
        let committed = fold(
            None,
            "OPENROUTER",
            Some(account),
            &CacheReport::Success(rows),
        )
        .expect("success fold");
        assert!(committed.contains("25.0"));
        let drifted = fold(
            Some(&committed),
            "OPENROUTER",
            Some(account),
            &CacheReport::Drift {
                observed_at: iso_from_epoch_ms(now + 1_000).expect("drift clock"),
            },
        )
        .expect("drift fold");
        let document: Value = serde_json::from_str(&drifted).expect("cache document");
        assert_eq!(document["snapshots"].as_array().map(Vec::len), Some(0));
        assert_eq!(document["suppressions"].as_array().map(Vec::len), Some(1));
        assert!(!drifted.contains("\"value\":0"));
    }

    #[test]
    fn unavailable_removes_only_the_scoped_remote_rows() {
        let now = epoch_ms_from_rfc3339("2026-08-16T12:00:00.000Z").expect("fixture clock");
        let mut scoped = parse_body(
            ReaderId::OpenrouterCredits,
            r#"{"data":{"total_credits":20,"total_usage":5}}"#,
            now,
            "work",
        )
        .expect("scoped fixture");
        let mut fallback = scoped[0].clone();
        fallback.account_id = None;
        scoped.push(fallback);
        let existing = fold(
            None,
            "OPENROUTER",
            Some("work"),
            &CacheReport::Success(scoped),
        )
        .expect("initial fold");
        let result = fold(
            Some(&existing),
            "OPENROUTER",
            Some("work"),
            &CacheReport::Unavailable,
        )
        .expect("unavailable fold");
        let document: Value = serde_json::from_str(&result).expect("cache document");
        let rows = document["snapshots"].as_array().expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("accountId"), None);
    }
}
