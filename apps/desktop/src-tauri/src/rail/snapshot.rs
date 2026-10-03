use crate::activity::ActivityDisplayRecord;
use crate::native_snapshot::Snapshot;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

use super::{RailAccountViewModel, SessionsSummary};

pub(super) const MAX_SESSIONS: usize = 64;

fn registry() -> &'static serde_json::Value {
    static REGISTRY: OnceLock<serde_json::Value> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../provider_specs/provider-specs.json"
        ))
        .expect("checked provider registry")
    })
}

fn claude_presentation() -> &'static serde_json::Value {
    static CONTRACT: OnceLock<serde_json::Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../packages/core/src/contracts/claude-presentation.json"
        ))
        .expect("checked Claude presentation contract")
    })
}

fn claude_model_name(meter: &str) -> Option<String> {
    let contract = claude_presentation();
    let prefix = contract["modelWeekly"]["prefix"].as_str()?;
    let parts: Vec<_> = meter.strip_prefix(prefix)?.split('_').filter(|part| !part.is_empty()).collect();
    let mut words: Vec<String> = Vec::new();
    for part in parts {
        if part.bytes().all(|byte| byte.is_ascii_digit())
            && words
                .last()
                .is_some_and(|word| word.chars().last().is_some_and(|ch| ch.is_ascii_digit()))
        {
            words.last_mut()?.push('.');
            words.last_mut()?.push_str(part);
        } else if part.eq_ignore_ascii_case("oauth") {
            words.push("OAuth".into());
        } else if part.eq_ignore_ascii_case("api") {
            words.push("API".into());
        } else {
            let mut chars = part.chars();
            let first = chars.next()?.to_ascii_uppercase();
            words.push(first.to_string() + &chars.as_str().to_ascii_lowercase());
        }
    }
    (!words.is_empty()).then(|| words.join(" "))
}

fn claude_window_label(provider: &str, meter: &str) -> Option<String> {
    if provider != "CLAUDE" {
        return None;
    }
    let contract = claude_presentation();
    for entry in contract["fixed"].as_object()?.values() {
        if entry["meters"]
            .as_array()?
            .iter()
            .any(|candidate| candidate.as_str() == Some(meter))
        {
            let key = entry["labelKey"].as_str()?;
            return contract["copy"][key].as_str().map(str::to_string);
        }
    }
    let model = claude_model_name(meter)?;
    let model_contract = &contract["modelWeekly"];
    let fable_prefix = model_contract["fablePrefix"].as_str()?;
    let key = if model == fable_prefix || model.starts_with(&format!("{fable_prefix} ")) {
        model_contract["fableLabelKey"].as_str()?
    } else {
        model_contract["labelKey"].as_str()?
    };
    contract["copy"][key]
        .as_str()
        .map(|template| template.replace("{model}", &model))
}

fn spec_id(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "CODEX" => "openai/codex",
        "CLAUDE" => "anthropic/claude-code",
        "GEMINI_CLI" => "google/gemini-cli",
        "ANTIGRAVITY" => "google/antigravity",
        "GROK" => "xai/grok-cli",
        "KIMI" => "moonshot/kimi-code",
        "OPENCODE" => "opencode/opencode",
        "OPENROUTER" => "openrouter/api",
        "CURSOR" => "cursor/editor",
        "MANUAL" => "openlimiter/manual",
        _ => return None,
    })
}

/// The name every surface shows for a provider code: the registry directory's
/// label, else its display name. The window's names.js reads the same fields,
/// so the tray, the edge panel and Home never name one provider two ways.
pub(crate) fn display_name(provider: &str) -> Option<&'static str> {
    let id = spec_id(provider)?;
    let spec = registry()["providers"]
        .as_array()?
        .iter()
        .find(|spec| spec["id"] == id)?;
    spec["directory"]["label"]
        .as_str()
        .or_else(|| spec["displayName"].as_str())
}

/// Project validated local rows, never credentials, labels or arbitrary cache metadata.
pub(super) fn accounts(rows: Vec<Snapshot>, now: i64) -> Vec<RailAccountViewModel> {
    let specs = registry()["providers"].as_array().expect("provider list");
    let mut groups: BTreeMap<_, Vec<Snapshot>> = BTreeMap::new();
    for row in rows
        .into_iter()
        .filter(|row| crate::data_rules::reason(row, now).is_none())
    {
        let Some(spec) =
            spec_id(&row.provider).and_then(|id| specs.iter().find(|spec| spec["id"] == id))
        else {
            continue;
        };
        // The main window uses directory order, then absent account, then account id.
        // Providers without directory entries follow the registered directory.
        let order = spec["directory"]["order"].as_u64().unwrap_or(u64::MAX);
        groups
            .entry((order, row.provider.clone(), row.account_id.clone()))
            .or_default()
            .push(row);
    }
    groups
        .into_iter()
        .take(MAX_SESSIONS)
        .map(|((_, provider, account), rows)| {
            let spec = specs
                .iter()
                .find(|spec| Some(spec["id"].as_str().unwrap_or_default()) == spec_id(&provider))
                .unwrap();
            // Collapse repeated observations of one window before choosing the tightest.
            let mut latest = BTreeMap::<&str, &Snapshot>::new();
            for row in &rows {
                if latest
                    .get(row.meter.as_str())
                    .is_none_or(|old| row.observed_at > old.observed_at)
                {
                    latest.insert(&row.meter, row);
                }
            }
            let selected = latest.values().copied().max_by(|left, right| {
                (left.unit == "PERCENT")
                    .cmp(&(right.unit == "PERCENT"))
                    .then_with(|| left.value.total_cmp(&right.value))
                    .then_with(|| right.meter.cmp(&left.meter))
            });
            let meter = selected.and_then(|row| {
                spec["meters"]
                    .as_array()?
                    .iter()
                    .find(|meter| meter["meterCode"] == row.meter)
            });
            let headline = meter
                .and_then(|meter| meter["id"].as_str())
                .or_else(|| selected.map(|row| row.meter.as_str()))
                .unwrap_or("usage");
            let unavailable = rows
                .iter()
                .filter(|row| row.availability.is_some())
                .max_by_key(|row| &row.observed_at);
            let reading = selected.or(unavailable);
            let availability = reading
                .and_then(|row| row.availability.as_deref())
                .unwrap_or(if selected.is_some() {
                    "available"
                } else {
                    "quota_unavailable"
                });
            let observed = reading.and_then(|row| {
                instant(&row.observed_at)
                    .filter(|at| *at <= now)
                    .map(|_| row.observed_at.clone())
            });
            let freshness = match (reading, observed.as_ref()) {
                (Some(row), Some(_)) if crate::data_rules::reason(row, now).is_none() => "fresh",
                (Some(_), Some(_)) => "stale",
                _ => "unknown",
            };
            let balance = selected.is_some_and(|row| {
                matches!(
                    (row.provider.as_str(), row.meter.as_str()),
                    ("OPENROUTER", "ACCOUNT_BALANCE") | ("CODEX", "CREDITS")
                )
            });
            // Legacy measured rows may lack a kind. Eligibility has already rejected
            // availability placeholders before interpreting their numeric unit.
            let kind = selected
                .and_then(|row| row.kind.as_deref())
                .unwrap_or_else(|| {
                    if balance {
                        "money_balance"
                    } else if meter.is_some_and(|meter| meter["unit"] == "percent_used")
                        || selected.is_some_and(|row| row.unit == "PERCENT")
                    {
                        "quota_percent"
                    } else if selected.is_some_and(|row| row.unit == "CREDITS") {
                        "money_balance"
                    } else {
                        "token_count"
                    }
                });
            let value = selected
                .filter(|_| availability == "available" && observed.is_some() && kind != "unknown")
                .map(|row| {
                    if balance {
                        row.limit_amount
                            .zip(row.used_amount)
                            .map(|(limit, used)| (limit - used).max(0.0))
                            .unwrap_or(row.value)
                    } else {
                        row.value
                    }
                })
                .filter(|value| {
                    value.is_finite()
                        && *value >= 0.0
                        && (kind != "quota_percent" || *value <= 100.0)
                });
            let band = match value {
                Some(value) if kind == "quota_percent" && freshness == "fresh" => {
                    if value >= 90.0 {
                        "red"
                    } else if value >= 80.0 {
                        "orange"
                    } else if value >= 60.0 {
                        "yellow"
                    } else {
                        "green"
                    }
                }
                _ => "stale",
            };
            let precision = reading
                .map(|row| row.precision.as_str())
                .unwrap_or("unknown");
            let window_label = meter
                .and_then(|meter| meter["label"].as_str())
                .map(str::to_string)
                .or_else(|| {
                    selected.and_then(|row| claude_window_label(&provider, &row.meter))
                })
                .or_else(|| {
                    selected.map(|row| match row.meter.as_str() {
                        "FIVE_HOUR" => "Five hours",
                        "SEVEN_DAY" => "Weekly usage",
                        _ => "Usage",
                    }.to_string())
                })
                .unwrap_or_else(|| "Usage".into());
            RailAccountViewModel {
                provider,
                account,
                headline_meter_id: headline.into(),
                kind: kind.into(),
                value,
                meaning: if kind == "money_balance" {
                    "remaining"
                } else {
                    "used"
                }
                .into(),
                window_label,
                reset_at: selected.and_then(|row| row.reset_at.clone()),
                observed_at: observed,
                freshness: freshness.into(),
                availability: availability.into(),
                band: band.into(),
                precision: precision.into(),
                fidelity_marker: (precision != "exact").then(|| precision.into()),
                sessions: SessionsSummary {
                    busy: 0,
                    waiting: 0,
                    done: 0,
                    idle: 0,
                    unknown: 0,
                },
            }
        })
        .collect()
}

/// A Rail specific display projection. The opaque id is only a locate key.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDisplay {
    session_id: String,
    agent: String,
    state: String,
    confidence: String,
    observed_at: Option<String>,
    elapsed_seconds: Option<u64>,
    computer: &'static str,
    outcome: Option<String>,
}

fn instant(value: &str) -> Option<i64> {
    if value.len() > 32 {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.timestamp_millis())
}

pub(super) fn sessions(records: Vec<ActivityDisplayRecord>, now: i64) -> Vec<SessionDisplay> {
    records
        .into_iter()
        .take(MAX_SESSIONS)
        .filter_map(|record| {
            // The engine hashes identities. Refuse an unexpected identifier rather
            // than passing through a path or a raw provider session id.
            if record.session_id.len() != 64
                || !record.session_id.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return None;
            }
            let agent = match record.agent.as_str() {
                "claude_code" | "codex" | "muse" | "cursor" | "gemini_cli" | "kimi" | "grok"
                | "antigravity" => record.agent,
                _ => "unknown".into(),
            };
            let state = match record.state.as_str() {
                "busy" | "waiting" | "done" | "idle" => record.state,
                _ => "unknown".into(),
            };
            let confidence = match record.confidence.as_str() {
                "explicit" | "inferred" => record.confidence,
                _ => "unknown".into(),
            };
            let outcome = record
                .outcome
                .filter(|value| matches!(value.as_str(), "cancelled" | "failed"));
            Some(SessionDisplay {
                session_id: record.session_id,
                agent,
                state: if outcome.is_some() && state == "done" {
                    "unknown".into()
                } else {
                    state
                },
                confidence,
                observed_at: instant(&record.observed_at)
                    .filter(|at| *at <= now)
                    .map(|_| record.observed_at),
                elapsed_seconds: instant(&record.first_observed_at)
                    .filter(|at| *at <= now)
                    .map(|at| now.saturating_sub(at) as u64 / 1000),
                computer: "local",
                outcome,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-09-28T12:00:00.000Z";

    fn quota(provider: &str, meter: &str, account: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "provider": provider, "meter": meter, "accountId": account,
            "value": 82, "unit": "PERCENT", "kind": "quota_percent",
            "window": { "kind": "rolling", "durationSeconds": 18000 },
            "resetAt": "2026-09-28T15:00:00.000Z",
            "observedAt": "2026-09-28T11:57:00.000Z", "expiresAt": NOW,
            "precision": "exact", "source": "internal_payload",
            "labels": { "credentialOrigin": "official-local-tool", "dataInterfaceStatus": "internal-endpoint",
                "automationRisk": "high", "verification": "UNVERIFIED" },
            "accountLabel": "private account text", "privateMetadata": "private path"
        })
    }

    fn project(rows: Vec<serde_json::Value>, now: &str) -> serde_json::Value {
        let document = serde_json::json!({ "version": 2, "snapshots": rows }).to_string();
        serde_json::to_value(accounts(
            crate::native_snapshot::display_snapshots(Some(&document)),
            instant(now).unwrap(),
        ))
        .unwrap()
    }

    #[test]
    fn account_shape_uses_registry_headline_and_sanitized_cache_reading() {
        let value = project(vec![quota("CLAUDE", "FIVE_HOUR", Some("fixture"))], NOW);
        assert_eq!(
            value[0],
            serde_json::json!({
                "provider": "CLAUDE", "account": "fixture", "headlineMeterId": "session_5h",
                "kind": "quota_percent", "value": 82.0, "meaning": "used", "windowLabel": "Current session",
                "resetAt": "2026-09-28T15:00:00.000Z", "observedAt": "2026-09-28T11:57:00.000Z",
                "freshness": "fresh", "availability": "available", "band": "orange", "precision": "exact", "fidelityMarker": null,
                "sessions": { "busy": 0, "waiting": 0, "done": 0, "idle": 0, "unknown": 0 }
            })
        );
        assert!(!value.to_string().contains("private"));
    }

    #[test]
    fn accounts_are_unique_bounded_and_in_main_window_order() {
        let mut rows = vec![
            quota("CLAUDE", "FIVE_HOUR", None),
            quota("CODEX", "FIVE_HOUR", Some("z")),
            quota("CODEX", "FIVE_HOUR", Some("a")),
            quota("CODEX", "SEVEN_DAY", Some("a")),
            quota("CODEX", "FIVE_HOUR", None),
        ];
        rows.extend(
            (0..100)
                .rev()
                .map(|i| quota("KIMI", "WEEKLY", Some(&format!("fixture{i:03}")))),
        );
        let value = project(rows, NOW);
        assert_eq!(value.as_array().unwrap().len(), MAX_SESSIONS);
        assert_eq!(value[0]["provider"], "CODEX");
        assert!(value[0]["account"].is_null());
        assert_eq!(value[1]["account"], "a");
        assert_eq!(value[2]["account"], "z");
        assert_eq!(value[3]["provider"], "CLAUDE");
        assert_eq!(value[4]["account"], "fixture000");
        assert_eq!(value[63]["account"], "fixture059");
        assert!(value.to_string().len() < 64 * 1024);
    }

    #[test]
    fn headline_uses_tightest_measured_window_and_latest_observation() {
        let mut old = quota("CLAUDE", "FIVE_HOUR", None);
        old["observedAt"] = "2026-09-28T11:50:00.000Z".into();
        old["value"] = 10.into();
        let value = project(
            vec![
                quota("CLAUDE", "SEVEN_DAY", None),
                quota("CLAUDE", "FIVE_HOUR", None),
                old,
            ],
            NOW,
        );
        assert_eq!(value.as_array().unwrap().len(), 1);
        assert_eq!(value[0]["value"], 82.0);
        let value = project(vec![quota("CODEX", "SEVEN_DAY", None)], NOW);
        assert_eq!(value[0]["headlineMeterId"], "SEVEN_DAY");
        assert_eq!(value[0]["availability"], "available");
        assert_eq!(value[0]["value"], 82.0);
        assert_ne!(value[0]["windowLabel"], "Unknown");
    }

    #[test]
    fn claude_model_scoped_headlines_use_the_shared_presentation_contract() {
        let value = project(
            vec![quota("CLAUDE", "SEVEN_DAY_FABLE_5_1", None)],
            NOW,
        );

        assert_eq!(value[0]["windowLabel"], "Weekly, Fable");
    }

    #[test]
    fn stale_age_keeps_original_observation_and_future_reading_is_unknown() {
        let rows = vec![quota("CODEX", "FIVE_HOUR", None)];
        let value = project(rows.clone(), "2026-09-28T13:00:00.000Z");
        assert_eq!(value, serde_json::json!([]));
        let value = project(rows, "2026-09-28T11:00:00.000Z");
        assert_eq!(value, serde_json::json!([]));
    }

    #[test]
    fn unavailable_and_balance_accounts_never_get_quota_bands() {
        for availability in [
            "missing_credentials",
            "unlimited",
            "quota_unavailable",
            "rate_limited",
        ] {
            let mut row = quota("CLAUDE", "FIVE_HOUR", None);
            row["availability"] = availability.into();
            row["value"] = 0.into();
            let value = project(vec![row], NOW);
            assert_eq!(value, serde_json::json!([]));
        }
        let mut row = quota("OPENROUTER", "ACCOUNT_BALANCE", None);
        row["kind"] = "money_balance".into();
        row["unit"] = "CREDITS".into();
        let value = project(vec![row], NOW);
        assert_eq!(value[0]["meaning"], "remaining");
        assert_eq!(value[0]["band"], "stale");
        assert_eq!(value[0]["value"], 82.0);
    }

    #[test]
    fn legacy_headlines_use_registry_semantics_and_preserve_zero_and_bands() {
        for (percent, band) in [
            (0, "green"),
            (59, "green"),
            (60, "yellow"),
            (80, "orange"),
            (90, "red"),
            (100, "red"),
        ] {
            let mut row = quota("CLAUDE", "FIVE_HOUR", None);
            row.as_object_mut().unwrap().remove("kind");
            row["value"] = percent.into();
            let value = project(vec![row], NOW);
            assert_eq!(value[0]["kind"], "quota_percent");
            assert_eq!(value[0]["value"], f64::from(percent));
            assert_eq!(value[0]["band"], band);
            assert_eq!(value[0]["meaning"], "used");
        }
    }

    #[test]
    fn cache_suppressions_and_invalid_rows_do_not_become_rail_meters() {
        let mut invalid = quota("CLAUDE", "FIVE_HOUR", Some("fixture/path"));
        invalid["value"] = 500.into();
        assert_eq!(project(vec![invalid], NOW), serde_json::json!([]));
        let document =
            serde_json::json!({ "version": 2, "snapshots": [quota("CLAUDE", "FIVE_HOUR", None)],
            "suppressions": [{ "provider": "CLAUDE", "reason": "drift", "suppressedAt": NOW }] })
            .to_string();
        assert!(crate::native_snapshot::display_snapshots(Some(&document)).is_empty());
        let document = serde_json::json!({ "version": 999, "snapshots": [quota("CLAUDE", "FIVE_HOUR", None)] }).to_string();
        assert!(crate::native_snapshot::display_snapshots(Some(&document)).is_empty());
        let document = serde_json::json!({ "version": 2, "snapshots": [quota("CLAUDE", "FIVE_HOUR", None)], "suppressions": "invalid" }).to_string();
        assert!(crate::native_snapshot::display_snapshots(Some(&document)).is_empty());
    }

    fn record() -> ActivityDisplayRecord {
        ActivityDisplayRecord {
            session_id: "a".repeat(64),
            agent: "codex".into(),
            state: "waiting".into(),
            confidence: "explicit".into(),
            first_observed_at: "2026-09-28T11:00:00.000Z".into(),
            observed_at: "2026-09-28T11:57:00.000Z".into(),
            state_changed_at: "2026-09-28T11:56:00.000Z".into(),
            user_project_label: Some("private project text".into()),
            outcome: None,
        }
    }

    #[test]
    fn session_shape_is_bounded_and_drops_local_metadata() {
        let now = instant("2026-09-28T12:00:00Z").unwrap();
        let value = serde_json::to_value(sessions(vec![record(); 1000], now)).unwrap();
        assert_eq!(value.as_array().unwrap().len(), MAX_SESSIONS);
        assert_eq!(
            value[0],
            serde_json::json!({
                "sessionId": "a".repeat(64), "agent": "codex", "state": "waiting", "confidence": "explicit",
                "observedAt": "2026-09-28T11:57:00.000Z", "elapsedSeconds": 3600, "computer": "local", "outcome": null
            })
        );
        assert!(!value.to_string().contains("private"));
        assert!(value.to_string().len() < 32 * 1024);
    }

    #[test]
    fn malformed_display_fields_never_leak_or_claim_success() {
        let mut row = record();
        row.session_id = "fixture/path".into();
        assert!(sessions(vec![row.clone()], 0).is_empty());
        row.session_id = "a".repeat(64);
        row.agent = "private text".repeat(1000);
        row.confidence = row.agent.clone();
        row.state = "done".into();
        row.outcome = Some("failed".into());
        let value = serde_json::to_value(sessions(vec![row], 0)).unwrap();
        assert_eq!(value[0]["agent"], "unknown");
        assert_eq!(value[0]["state"], "unknown");
        assert_eq!(value[0]["confidence"], "unknown");
        assert!(value[0]["elapsedSeconds"].is_null());
        assert!(value[0]["observedAt"].is_null());
    }
}
