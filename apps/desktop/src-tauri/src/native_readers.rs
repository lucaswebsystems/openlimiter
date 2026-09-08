use std::collections::BTreeMap;

use serde_json::{Map, Value};

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
        account_label: None,
        /* The writer is stamped by the one fold every desktop write passes
        through, so a parser never has to know which process it is running in.
        See `native_snapshot::fold`. */
        writer: None,
        provenance: provenance(),
    }
}

fn number(value: Option<&Value>, maximum: f64) -> Option<f64> {
    let value = value?.as_f64()?;
    (value.is_finite() && value >= 0.0 && value <= maximum).then_some(value)
}

fn numeric_text(value: Option<&Value>, maximum: f64) -> Option<f64> {
    let value = value?;
    let number = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
    (number.is_finite() && number >= 0.0 && number <= maximum).then_some(number)
}

fn percent_of(used: f64, limit: f64) -> Option<f64> {
    if limit <= 0.0 || used > limit {
        return None;
    }
    let percent = used / limit * 100.0;
    (percent.is_finite() && (0.0..=100.0).contains(&percent)).then_some(percent)
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

/// The meter code one pool's window earns.
///
/// The client states two pools today, Google's own models and the third party
/// models it resells, and somebody paying for both needs to see both. The
/// Google pool keeps the plain codes it has always had, because every row
/// already on disk under `FIVE_HOUR` and `SEVEN_DAY` belongs to it and
/// renaming them would orphan that history. Every other pool is named after
/// itself, so a pool this build has never seen still renders under a code a
/// reader can print rather than being silently dropped.
fn antigravity_meter(pool: &str, window: &str) -> Option<String> {
    let cadence = match window {
        "5h" => "SESSION",
        "weekly" => "WEEKLY",
        _ => return None,
    };
    if pool == "gemini" {
        return Some(
            if cadence == "SESSION" {
                "FIVE_HOUR"
            } else {
                "SEVEN_DAY"
            }
            .to_string(),
        );
    }
    /* `3p` is the client's own name for the third party pool and it starts
    with a digit, which no meter code may do, so the readable name is used
    instead. Anything else is uppercased into a code shape, and a pool whose
    name cannot become one is dropped rather than guessed at. */
    let named = if pool == "3p" {
        "THIRD_PARTY".to_string()
    } else {
        let upper: String = pool
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        if !upper.starts_with(|character: char| character.is_ascii_uppercase()) {
            return None;
        }
        upper
    };
    Some(format!("{named}_{cadence}"))
}

fn antigravity_windows(
    pool: &str,
    buckets: &[Value],
    now_ms: u64,
) -> Option<Vec<(String, f64, u64, String)>> {
    let mut windows = Vec::new();
    for entry in buckets {
        let bucket = entry.as_object()?;
        let fraction = number(bucket.get("remainingFraction"), 1.0)?;
        let window = bucket.get("window")?.as_str()?.to_ascii_lowercase();
        let seconds = match window.as_str() {
            "5h" => 18_000,
            "weekly" => 604_800,
            _ => return None,
        };
        let meter = antigravity_meter(pool, &window)?;
        let horizon = seconds * 2 + CLOCK_SKEW_SECONDS;
        let reset_at = future_rfc3339(bucket.get("resetTime")?.as_str()?, now_ms, horizon)?;
        let percent = ((1.0 - fraction).clamp(0.0, 1.0) * 1_000.0).round() / 10.0;
        windows.push((meter, percent, seconds, reset_at));
    }
    (!windows.is_empty()).then_some(windows)
}

/// Every window the client states, from every pool it states them for.
///
/// This used to keep the Google pool and discard the rest, which was right
/// while the reading came from Google's own metadata plane and is wrong now
/// that it comes from the client on this machine, which shows a person all of
/// their pools. A group whose buckets disagree about which pool they belong
/// to, or a window this build does not understand, costs the whole response
/// rather than half of one: a bar drawn from half a payload is a bar nobody
/// can act on.
fn parse_antigravity(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let groups = root.get("groups")?.as_array()?;
    let mut tracked: Vec<(String, f64, u64, String)> = Vec::new();
    let mut pools: Vec<&str> = Vec::new();
    for entry in groups {
        let buckets = entry.as_object()?.get("buckets")?.as_array()?;
        let prefixes = pool_prefixes(buckets)?;
        let [pool] = prefixes[..] else {
            return None;
        };
        if pools.contains(&pool) {
            return None;
        }
        pools.push(pool);
        tracked.extend(antigravity_windows(pool, buckets, now_ms)?);
    }
    if tracked.is_empty() {
        return None;
    }
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at = iso_from_epoch_ms(now_ms.saturating_add(60_000))?;
    Some(
        tracked
            .into_iter()
            .map(|(meter, percent, seconds, reset_at)| {
                base_snapshot(
                    "ANTIGRAVITY",
                    &meter,
                    percent,
                    SnapshotWindow {
                        kind: "rolling".to_string(),
                        duration_seconds: Some(seconds),
                    },
                    Some(reset_at),
                    "internal_payload",
                    "estimated",
                    &observed_at,
                    &expires_at,
                    labels("official-local-tool", "internal-endpoint", "high"),
                    account_id,
                )
            })
            .collect(),
    )
}

fn grok_period(
    config: &Map<String, Value>,
    now_ms: u64,
) -> Option<(String, SnapshotWindow, String)> {
    let period = config.get("currentPeriod")?.as_object()?;
    let (meter, duration_seconds) = match period.get("type")?.as_str()? {
        "USAGE_PERIOD_TYPE_WEEKLY" => ("WEEKLY", Some(604_800)),
        "USAGE_PERIOD_TYPE_MONTHLY" => ("MONTHLY", None),
        _ => return None,
    };
    let horizon = duration_seconds
        .unwrap_or(2_678_400u64)
        .saturating_mul(2)
        .saturating_add(CLOCK_SKEW_SECONDS);
    let reset_at = future_rfc3339(period.get("end")?.as_str()?, now_ms, horizon)?;
    Some((
        meter.to_string(),
        SnapshotWindow {
            kind: "fixed".to_string(),
            duration_seconds,
        },
        reset_at,
    ))
}

fn grok_value(object: Option<&Value>) -> Option<f64> {
    let object = object?.as_object()?;
    numeric_text(object.get("val"), 1_000_000_000_000.0)
}

fn parse_grok(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let config = root.get("config")?.as_object()?;
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at = iso_from_epoch_ms(now_ms.saturating_add(60_000))?;
    let connector_labels = labels("official-local-tool", "internal-endpoint", "high");
    let mut snapshots = Vec::new();

    if let Some(percent) = number(config.get("creditUsagePercent"), 100.0) {
        let (meter, window, reset_at) = grok_period(config, now_ms)?;
        snapshots.push(base_snapshot(
            "GROK",
            &meter,
            percent,
            window,
            Some(reset_at),
            "internal_payload",
            "estimated",
            &observed_at,
            &expires_at,
            connector_labels.clone(),
            account_id,
        ));
    } else {
        let limit = grok_value(config.get("monthlyLimit"))?;
        let used = grok_value(config.get("used"))?;
        let percent = percent_of(used, limit)?;
        let reset_at = config
            .get("billingPeriodEnd")
            .and_then(Value::as_str)
            .and_then(|value| {
                future_rfc3339(
                    value,
                    now_ms,
                    2_678_400u64
                        .saturating_mul(2)
                        .saturating_add(CLOCK_SKEW_SECONDS),
                )
            });
        snapshots.push(base_snapshot(
            "GROK",
            "MONTHLY",
            percent,
            SnapshotWindow {
                kind: "fixed".to_string(),
                duration_seconds: None,
            },
            reset_at,
            "internal_payload",
            "estimated",
            &observed_at,
            &expires_at,
            connector_labels.clone(),
            account_id,
        ));
    }

    let cap = grok_value(config.get("onDemandCap"));
    let used = grok_value(config.get("onDemandUsed"));
    match (cap, used) {
        (Some(cap), Some(used)) if cap > 0.0 => {
            snapshots.push(base_snapshot(
                "GROK",
                "ON_DEMAND_MONTHLY",
                percent_of(used, cap)?,
                SnapshotWindow {
                    kind: "fixed".to_string(),
                    duration_seconds: None,
                },
                None,
                "internal_payload",
                "estimated",
                &observed_at,
                &expires_at,
                connector_labels,
                account_id,
            ));
        }
        (None, None) | (Some(0.0), Some(0.0)) => {}
        _ => return None,
    }
    Some(snapshots)
}

fn kimi_window_seconds(window: &Map<String, Value>) -> Option<u64> {
    let duration = window.get("duration")?.as_u64()?;
    if duration == 0 {
        return None;
    }
    let multiplier = match window.get("timeUnit")?.as_str()? {
        "TIME_UNIT_MINUTE" => 60,
        "TIME_UNIT_HOUR" => 3_600,
        "TIME_UNIT_DAY" => 86_400,
        "TIME_UNIT_WEEK" => 604_800,
        _ => return None,
    };
    let seconds = duration.checked_mul(multiplier)?;
    (seconds <= MAX_WINDOW_SECONDS).then_some(seconds)
}

fn kimi_meter(seconds: u64, ordinal: usize) -> Option<String> {
    let base = match seconds {
        300 => "FIVE_MINUTE".to_string(),
        18_000 => "FIVE_HOUR".to_string(),
        86_400 => "DAILY".to_string(),
        604_800 => "SEVEN_DAY".to_string(),
        _ => format!("WINDOW_{seconds}"),
    };
    let meter = if ordinal == 1 {
        base
    } else {
        format!("{base}_{ordinal}")
    };
    safe_meter(&meter).then_some(meter)
}

fn parse_kimi_quota(
    detail: &Map<String, Value>,
    now_ms: u64,
    horizon: u64,
) -> Option<(f64, String)> {
    let used = numeric_text(detail.get("used"), 1_000_000_000_000.0)?;
    let limit = numeric_text(detail.get("limit"), 1_000_000_000_000.0)?;
    let percent = percent_of(used, limit)?;
    let reset_at = future_rfc3339(
        detail.get("resetTime")?.as_str()?,
        now_ms,
        horizon.saturating_mul(2).saturating_add(CLOCK_SKEW_SECONDS),
    )?;
    Some((percent, reset_at))
}

fn parse_kimi(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let usage = root.get("usage")?.as_object()?;
    let (weekly_percent, weekly_reset) = parse_kimi_quota(usage, now_ms, 604_800)?;
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at = iso_from_epoch_ms(now_ms.saturating_add(60_000))?;
    let connector_labels = labels("official-local-tool", "internal-endpoint", "high");
    let mut snapshots = vec![base_snapshot(
        "KIMI",
        "WEEKLY",
        weekly_percent,
        SnapshotWindow {
            kind: "rolling".to_string(),
            duration_seconds: Some(604_800),
        },
        Some(weekly_reset),
        "internal_payload",
        "estimated",
        &observed_at,
        &expires_at,
        connector_labels.clone(),
        account_id,
    )];
    let mut ordinals = BTreeMap::<u64, usize>::new();
    for entry in root
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let entry = entry.as_object()?;
        let detail = match entry.get("detail").and_then(Value::as_object) {
            Some(detail) => detail,
            None => continue,
        };
        let has_quota = ["used", "limit", "resetTime"]
            .iter()
            .any(|field| detail.contains_key(*field));
        if !has_quota {
            continue;
        }
        let seconds = kimi_window_seconds(entry.get("window")?.as_object()?)?;
        let (percent, reset_at) = parse_kimi_quota(detail, now_ms, seconds)?;
        let ordinal = ordinals.entry(seconds).or_default();
        *ordinal += 1;
        snapshots.push(base_snapshot(
            "KIMI",
            &kimi_meter(seconds, *ordinal)?,
            percent,
            SnapshotWindow {
                kind: "rolling".to_string(),
                duration_seconds: Some(seconds),
            },
            Some(reset_at),
            "internal_payload",
            "estimated",
            &observed_at,
            &expires_at,
            connector_labels.clone(),
            account_id,
        ));
    }
    Some(snapshots)
}

pub fn parse_body(
    reader: ReaderId,
    body: &str,
    now_ms: u64,
    account_id: &str,
) -> Option<Vec<Snapshot>> {
    let mut rows = match reader {
        ReaderId::OpenrouterKey | ReaderId::OpenrouterCredits => {
            parse_openrouter(body, now_ms, account_id)
        }
        ReaderId::CodexUsage => parse_codex(body, now_ms, account_id),
        ReaderId::AntigravityQuota => parse_antigravity(body, now_ms, account_id),
        ReaderId::OpencodeUsage => parse_opencode(body, now_ms, account_id),
        ReaderId::GrokUsage => parse_grok(body, now_ms, account_id),
        ReaderId::KimiUsage => parse_kimi(body, now_ms, account_id),
    }?;
    // A reading remains live for its provider cadence, not a one minute
    // repaint budget. Explicit only readers retain their existing expiry.
    if reader.base_seconds() > 0 {
        let expires = iso_from_epoch_ms(now_ms.saturating_add(reader.base_seconds() * 1_000))?;
        for row in &mut rows {
            row.expires_at = expires.clone();
        }
    }
    Some(rows)
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
                epoch_ms_from_rfc3339(&row.expires_at)
                    == Some(now() + reader.base_seconds() * 1_000)
            }));
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
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|row| {
            row.provider == "OPENCODE" && row.account_id.as_deref() == Some(ACCOUNT)
        }));
        assert!(rows
            .iter()
            .any(|row| row.meter == "FIVE_HOUR" && row.value == 10.0));
        assert!(rows
            .iter()
            .any(|row| row.meter == "SEVEN_DAY" && row.value == 20.0));
        assert!(rows
            .iter()
            .any(|row| row.meter == "MONTHLY" && row.value == 30.0));
    }

    #[test]
    fn antigravity_keeps_session_and_weekly_as_separate_windows() {
        let now_ms = now();
        let five_hour_reset = iso_from_epoch_ms(now_ms + 18_000_000).expect("reset");
        let weekly_reset = iso_from_epoch_ms(now_ms + 604_800_000).expect("reset");
        let body = format!(
            r#"{{"groups":[{{"buckets":[{{"bucketId":"gemini-main","remainingFraction":0.75,"window":"5h","resetTime":"{five_hour_reset}"}},{{"bucketId":"gemini-weekly","remainingFraction":0.4,"window":"weekly","resetTime":"{weekly_reset}"}}]}}]}}"#
        );
        let rows =
            parse_body(ReaderId::AntigravityQuota, &body, now_ms, ACCOUNT).expect("readable quota");
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|row| row.meter == "FIVE_HOUR" && row.value == 25.0));
        assert!(rows
            .iter()
            .any(|row| row.meter == "SEVEN_DAY" && row.value == 60.0));
    }

    /// Both pools reach the cache, and the Google one keeps its old codes.
    ///
    /// The client shows a Google pool and a third party pool and somebody
    /// paying for both needs to see both. The Google pool must keep
    /// `FIVE_HOUR` and `SEVEN_DAY` or every row already on disk is orphaned.
    #[test]
    fn antigravity_renders_every_pool_the_client_states() {
        let now_ms = now();
        let five_hour_reset = iso_from_epoch_ms(now_ms + 18_000_000).expect("reset");
        let weekly_reset = iso_from_epoch_ms(now_ms + 604_800_000).expect("reset");
        let body = format!(
            r#"{{"groups":[{{"displayName":"Gemini Models","buckets":[{{"bucketId":"gemini-5h","window":"5h","remainingFraction":0.75,"resetTime":"{five_hour_reset}"}},{{"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.4,"resetTime":"{weekly_reset}"}}]}},{{"displayName":"Claude and GPT models","buckets":[{{"bucketId":"3p-5h","window":"5h","remainingFraction":0.9,"resetTime":"{five_hour_reset}"}},{{"bucketId":"3p-weekly","window":"weekly","remainingFraction":0.5,"resetTime":"{weekly_reset}"}}]}}]}}"#
        );
        let rows =
            parse_body(ReaderId::AntigravityQuota, &body, now_ms, ACCOUNT).expect("readable quota");
        assert_eq!(rows.len(), 4);
        for (meter, value) in [
            ("FIVE_HOUR", 25.0),
            ("SEVEN_DAY", 60.0),
            ("THIRD_PARTY_SESSION", 10.0),
            ("THIRD_PARTY_WEEKLY", 50.0),
        ] {
            assert!(
                rows.iter()
                    .any(|row| row.meter == meter && row.value == value),
                "{meter} at {value} was not written"
            );
        }
    }

    /// A pool this build has never seen still renders, under its own name.
    #[test]
    fn an_unknown_pool_is_named_rather_than_dropped() {
        let now_ms = now();
        let weekly_reset = iso_from_epoch_ms(now_ms + 604_800_000).expect("reset");
        let body = format!(
            r#"{{"groups":[{{"buckets":[{{"bucketId":"vision-weekly","window":"weekly","remainingFraction":0.25,"resetTime":"{weekly_reset}"}}]}}]}}"#
        );
        let rows =
            parse_body(ReaderId::AntigravityQuota, &body, now_ms, ACCOUNT).expect("readable quota");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].meter, "VISION_WEEKLY");
        assert_eq!(rows[0].value, 75.0);
    }

    /// A pool named the same twice, and a group whose buckets disagree about
    /// which pool they belong to, are both shapes this build does not
    /// understand. Half a payload is worse than none.
    #[test]
    fn a_confused_pool_costs_the_whole_response() {
        let now_ms = now();
        let weekly_reset = iso_from_epoch_ms(now_ms + 604_800_000).expect("reset");
        for body in [
            format!(
                r#"{{"groups":[{{"buckets":[{{"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.25,"resetTime":"{weekly_reset}"}}]}},{{"buckets":[{{"bucketId":"gemini-5h","window":"weekly","remainingFraction":0.25,"resetTime":"{weekly_reset}"}}]}}]}}"#
            ),
            format!(
                r#"{{"groups":[{{"buckets":[{{"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.25,"resetTime":"{weekly_reset}"}},{{"bucketId":"3p-weekly","window":"weekly","remainingFraction":0.25,"resetTime":"{weekly_reset}"}}]}}]}}"#
            ),
        ] {
            assert!(parse_body(ReaderId::AntigravityQuota, &body, now_ms, ACCOUNT).is_none());
        }
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
