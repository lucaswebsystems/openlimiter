use serde_json::Value;

use crate::native_opencode::parse_opencode;
use crate::native_snapshot::{
    future_epoch_seconds, future_rfc3339, iso_from_epoch_ms, ConnectorLabels, Snapshot,
    SnapshotWindow,
};
use crate::reader_registry::ReaderId;

const MAX_WINDOW_SECONDS: u64 = 31_536_000;
const CLOCK_SKEW_SECONDS: u64 = 3_600;

fn labels(origin: &str, interface: &str, risk: &str) -> ConnectorLabels {
    ConnectorLabels {
        credential_origin: origin.to_string(),
        data_interface_status: interface.to_string(),
        automation_risk: risk.to_string(),
        verification: "UNVERIFIED".to_string(),
    }
}

fn provenance() -> Option<Value> {
    Some(serde_json::json!({
        "observedVia": "remote_http",
        "sourceKind": "remote_api"
    }))
}

fn base_snapshot(
    provider: &str,
    meter: &str,
    value: f64,
    window: SnapshotWindow,
    reset_at: Option<String>,
    source: &str,
    precision: &str,
    observed_at: &str,
    expires_at: &str,
    labels: ConnectorLabels,
    account_id: &str,
) -> Snapshot {
    Snapshot {
        provider: provider.to_string(),
        meter: meter.to_string(),
        value,
        unit: "PERCENT".to_string(),
        window,
        reset_at,
        source: source.to_string(),
        precision: precision.to_string(),
        observed_at: observed_at.to_string(),
        expires_at: expires_at.to_string(),
        labels,
        used_amount: None,
        limit_amount: None,
        currency: None,
        account_id: Some(account_id.to_string()),
        provenance: provenance(),
    }
}

fn number(value: Option<&Value>, maximum: f64) -> Option<f64> {
    let value = value?.as_f64()?;
    (value.is_finite() && value >= 0.0 && value <= maximum).then_some(value)
}

fn window_seconds(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_u64()?;
    (value > 0 && value <= MAX_WINDOW_SECONDS).then_some(value)
}

fn safe_meter(value: &str) -> bool {
    value.len() <= 32
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn parse_openrouter(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let data = root.get("data")?.as_object()?;
    let credits = number(data.get("total_credits"), 1_000_000_000_000.0)?;
    let usage = number(data.get("total_usage"), 1_000_000_000_000.0)?;
    if credits <= 0.0 || usage > credits {
        return None;
    }
    let percent = usage / credits * 100.0;
    if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
        return None;
    }
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at = iso_from_epoch_ms(now_ms.saturating_add(60_000))?;
    let mut snapshot = base_snapshot(
        "OPENROUTER",
        "CREDITS",
        percent,
        SnapshotWindow {
            kind: "lifetime".to_string(),
            duration_seconds: None,
        },
        None,
        "documented_api",
        "exact",
        &observed_at,
        &expires_at,
        labels("user-key", "documented-api", "low"),
        account_id,
    );
    snapshot.used_amount = Some(usage);
    snapshot.limit_amount = Some(credits);
    snapshot.currency = Some("USD".to_string());
    Some(vec![snapshot])
}

fn codex_meter_id(length: Option<u64>, key: &str) -> Option<String> {
    let meter = match length {
        Some(18_000) => "FIVE_HOUR".to_string(),
        Some(604_800) => "SEVEN_DAY".to_string(),
        _ => key
            .strip_suffix("_window")
            .unwrap_or(key)
            .to_ascii_uppercase(),
    };
    safe_meter(&meter).then_some(meter)
}

fn parse_codex(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let limits = root.get("rate_limit")?.as_object()?;
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at = iso_from_epoch_ms(now_ms.saturating_add(60_000))?;
    let mut snapshots = Vec::new();
    for (key, value) in limits {
        if !key.ends_with("_window") {
            continue;
        }
        if value.is_null() {
            continue;
        }
        let window = value.as_object()?;
        let percent = number(window.get("used_percent"), 100.0)?;
        let length = match window.get("limit_window_seconds") {
            Some(value) => Some(window_seconds(Some(value))?),
            None => None,
        };
        let max_ahead =
            length.map(|seconds| seconds.saturating_mul(2).saturating_add(CLOCK_SKEW_SECONDS));
        let reset_value = window.get("reset_at")?.as_f64()?;
        let reset_at = future_epoch_seconds(reset_value, now_ms, max_ahead)?;
        let meter = codex_meter_id(length, key)?;
        snapshots.push(base_snapshot(
            "CODEX",
            &meter,
            percent,
            SnapshotWindow {
                kind: if length.is_some() {
                    "rolling"
                } else {
                    "unknown"
                }
                .to_string(),
                duration_seconds: length,
            },
            Some(reset_at),
            "internal_payload",
            "estimated",
            &observed_at,
            &expires_at,
            labels("official-local-tool", "internal-endpoint", "high"),
            account_id,
        ));
    }
    (!snapshots.is_empty()).then_some(snapshots)
}

fn pool_prefixes(buckets: &[Value]) -> Option<Vec<&str>> {
    let mut prefixes = Vec::new();
    for entry in buckets {
        let id = entry.as_object()?.get("bucketId")?.as_str()?;
        let (prefix, _) = id.split_once('-')?;
        if prefix.is_empty() {
            return None;
        }
        if !prefixes.contains(&prefix) {
            prefixes.push(prefix);
        }
    }
    Some(prefixes)
}

fn antigravity_windows(buckets: &[Value], now_ms: u64) -> Option<Vec<(f64, u64, String)>> {
    let mut windows = Vec::new();
    for entry in buckets {
        let bucket = entry.as_object()?;
        let fraction = number(bucket.get("remainingFraction"), 1.0)?;
        let seconds = match bucket
            .get("window")?
            .as_str()?
            .to_ascii_lowercase()
            .as_str()
        {
            "5h" => 18_000,
            "weekly" => 604_800,
            _ => return None,
        };
        let horizon = seconds * 2 + CLOCK_SKEW_SECONDS;
        let reset_at = future_rfc3339(bucket.get("resetTime")?.as_str()?, now_ms, horizon)?;
        let percent = ((1.0 - fraction).clamp(0.0, 1.0) * 1_000.0).round() / 10.0;
        windows.push((percent, seconds, reset_at));
    }
    (!windows.is_empty()).then_some(windows)
}

fn parse_antigravity(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let groups = root.get("groups")?.as_array()?;
    let mut tracked: Option<Vec<(f64, u64, String)>> = None;
    for entry in groups {
        let buckets = entry.as_object()?.get("buckets")?.as_array()?;
        let prefixes = pool_prefixes(buckets)?;
        if !prefixes.contains(&"gemini") {
            continue;
        }
        if tracked.is_some() {
            return None;
        }
        tracked = Some(antigravity_windows(buckets, now_ms)?);
    }
    let tracked = tracked?;
    let binding = tracked
        .into_iter()
        .max_by(|left, right| left.0.total_cmp(&right.0))?;
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at = iso_from_epoch_ms(now_ms.saturating_add(60_000))?;
    Some(vec![base_snapshot(
        "ANTIGRAVITY",
        "PRIMARY",
        binding.0,
        SnapshotWindow {
            kind: "rolling".to_string(),
            duration_seconds: Some(binding.1),
        },
        Some(binding.2),
        "internal_payload",
        "estimated",
        &observed_at,
        &expires_at,
        labels("official-local-tool", "internal-endpoint", "high"),
        account_id,
    )])
}

pub fn parse_body(
    reader: ReaderId,
    body: &str,
    now_ms: u64,
    account_id: &str,
) -> Option<Vec<Snapshot>> {
    match reader {
        ReaderId::OpenrouterKey | ReaderId::OpenrouterCredits => {
            parse_openrouter(body, now_ms, account_id)
        }
        ReaderId::CodexUsage => parse_codex(body, now_ms, account_id),
        ReaderId::AntigravityQuota => parse_antigravity(body, now_ms, account_id),
        ReaderId::OpencodeUsage => parse_opencode(body, now_ms, account_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_snapshot::{epoch_ms_from_rfc3339, iso_from_epoch_ms};

    const NOW_TEXT: &str = "2026-08-16T12:00:00.000Z";
    const ACCOUNT: &str = "reader-test-account";

    fn now() -> u64 {
        epoch_ms_from_rfc3339(NOW_TEXT).expect("fixture clock")
    }

    #[test]
    fn native_json_readers_produce_bounded_remote_snapshots() {
        let reset_seconds = (now() + 3_600_000) / 1_000;
        let reset_text = iso_from_epoch_ms(now() + 3_600_000).expect("reset");
        let cases = [
            (
                ReaderId::OpenrouterCredits,
                r#"{"data":{"total_credits":20,"total_usage":5}}"#.to_string(),
                "OPENROUTER",
            ),
            (
                ReaderId::CodexUsage,
                serde_json::json!({
                    "rate_limit": {
                        "primary_window": {
                            "used_percent": 25,
                            "limit_window_seconds": 18_000,
                            "reset_at": reset_seconds
                        }
                    }
                })
                .to_string(),
                "CODEX",
            ),
            (
                ReaderId::AntigravityQuota,
                format!(
                    r#"{{"groups":[{{"buckets":[{{"bucketId":"gemini-main","remainingFraction":0.75,"window":"5h","resetTime":"{reset_text}"}}]}}]}}"#
                ),
                "ANTIGRAVITY",
            ),
        ];
        for (reader, body, provider) in cases {
            let rows = parse_body(reader, &body, now(), ACCOUNT).expect("readable fixture");
            assert!(!rows.is_empty());
            assert!(rows.iter().all(|row| {
                row.provider == provider
                    && row.account_id.as_deref() == Some(ACCOUNT)
                    && row.provenance.as_ref().is_some_and(|value| {
                        value["sourceKind"] == "remote_api" && value["observedVia"] == "remote_http"
                    })
            }));
        }
    }

    #[test]
    fn explicit_opencode_reader_stays_text_only_and_bounded() {
        let body = concat!(
            "<main>",
            "<section><h2>Rolling Usage</h2><b>10%</b><p>Resets in 1 hour</p></section>",
            "<section><h2>Weekly Usage</h2><b>20%</b><p>Resets in 1 day</p></section>",
            "<section><h2>Monthly Usage</h2><b>30%</b><p>Resets in 5 days</p></section>",
            "</main>"
        );
        let rows =
            parse_body(ReaderId::OpencodeUsage, body, now(), ACCOUNT).expect("readable page");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider, "OPENCODE");
        assert_eq!(rows[0].value, 30.0);
        assert_eq!(rows[0].account_id.as_deref(), Some(ACCOUNT));
    }

    #[test]
    fn missing_is_never_turned_into_zero() {
        for reader in ReaderId::ALL {
            assert!(parse_body(reader, "{}", now(), ACCOUNT).is_none());
        }
    }

    #[test]
    fn one_malformed_codex_window_rejects_the_whole_response() {
        let reset_seconds = (now() + 3_600_000) / 1_000;
        let body = serde_json::json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 25,
                    "limit_window_seconds": 18_000,
                    "reset_at": reset_seconds
                },
                "secondary_window": {
                    "used_percent": "unknown",
                    "limit_window_seconds": 604_800,
                    "reset_at": reset_seconds
                }
            }
        })
        .to_string();
        assert!(parse_body(ReaderId::CodexUsage, &body, now(), ACCOUNT).is_none());
    }

    #[test]
    fn an_explicitly_absent_codex_secondary_window_is_not_drift() {
        let reset_seconds = (now() + 3_600_000) / 1_000;
        let body = serde_json::json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 25,
                    "limit_window_seconds": 18_000,
                    "reset_at": reset_seconds
                },
                "secondary_window": null
            }
        })
        .to_string();
        let rows = parse_body(ReaderId::CodexUsage, &body, now(), ACCOUNT).expect("usage");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].meter, "FIVE_HOUR");
    }
}
