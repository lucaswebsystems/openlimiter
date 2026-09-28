//! The same case and expected files consumed by the TypeScript suite.
//! No network, credentials, current clock, or parser reimplementation.
use crate::native_readers::parse_body;
use crate::native_snapshot::{epoch_ms_from_rfc3339, Snapshot};
use crate::reader_registry::ReaderId;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn fixture_root() -> PathBuf {
    // Same repository-relative traversal as kimi_oauth's include_str! fixture.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/connectors/fixtures")
}

fn json_file(path: &std::path::Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("shared fixture file"))
        .expect("shared fixture JSON")
}

fn names(path: &std::path::Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(path)
        .expect("fixture directory")
        .map(|entry| {
            entry
                .expect("fixture entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    names
}

fn normalize(rows: Option<Vec<Snapshot>>) -> Value {
    let Some(rows) = rows else {
        return json!({"outcome": "rejected", "readings": []});
    };
    let mut readings: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "provider": row.provider,
                "meter": row.meter,
                "value": row.value,
                "unit": row.unit,
                "window": {"kind": row.window.kind, "durationSeconds": row.window.duration_seconds},
                "resetAt": row.reset_at,
                "precision": row.precision,
                "source": row.source,
                "kind": row.kind,
                "availability": row.availability,
                "currency": row.currency,
                "usedAmount": row.used_amount,
                "limitAmount": row.limit_amount,
                "observedAt": row.observed_at
            })
        })
        .collect();
    readings.sort_by(|a, b| a["meter"].as_str().cmp(&b["meter"].as_str()));
    json!({"outcome": "readings", "readings": readings})
}

// serde_json distinguishes 0 from 0.0. Compare JSON numbers by their numeric
// value, with no rounding or tolerance; all other values and keys stay exact.
fn assert_json(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{path}"),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: length");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_json(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}: keys"
            );
            for (key, value) in a {
                assert_json(value, &b[key], &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

fn run_provider(provider: &str) {
    let root = fixture_root();
    let case_dir = root.join("cases").join(provider);
    let expected_dir = root.join("expected").join(provider);
    let cases = names(&case_dir);
    assert!(!cases.is_empty(), "{provider}: no cases");
    assert_eq!(
        cases,
        names(&expected_dir),
        "{provider}: orphan expectations"
    );
    let divergences = fs::read_to_string(root.join("expected/KNOWN_DIVERGENCES.md"))
        .expect("visible known divergence list");
    for name in cases {
        let spec = json_file(&case_dir.join(&name));
        let answer = json_file(&expected_dir.join(&name));
        let case = spec["case"].as_str().expect("case name");
        let id = format!("{provider}/{case}");
        assert_eq!(name, format!("{case}.json"));
        assert_eq!(spec["provider"], provider);
        assert_eq!(spec["now"], "2026-08-07T12:00:00.000Z");
        let now = epoch_ms_from_rfc3339(spec["now"].as_str().expect("fixed clock"))
            .expect("valid fixed clock");
        let status = spec["status"].as_u64().expect("HTTP status");
        assert!([200, 401, 429].contains(&status));
        assert_eq!(
            spec["headers"],
            if status == 429 {
                json!({"retry-after": "120"})
            } else {
                json!({})
            }
        );
        assert_ne!(spec.get("fixture").is_some(), spec.get("body").is_some());
        let body = match spec["fixture"].as_str() {
            Some(file) => fs::read_to_string(root.join(file)).expect("original frozen fixture"),
            None => serde_json::to_string(&spec["body"]).expect("synthetic body"),
        };
        // Error bodies still reach the real parser; status never manufactures rejection.
        let rows = match (provider, spec["reader"].as_str().expect("reader")) {
            ("claude", "usage") => crate::claude_oauth::parse_usage(&body, now, "synthetic-parity"),
            ("codex", "usage") => parse_body(ReaderId::CodexUsage, &body, now, "synthetic-parity"),
            ("kimi", "usage") => parse_body(ReaderId::KimiUsage, &body, now, "synthetic-parity"),
            ("openrouter", "credits") => {
                parse_body(ReaderId::OpenrouterCredits, &body, now, "synthetic-parity")
            }
            ("openrouter", "key") => {
                parse_body(ReaderId::OpenrouterKey, &body, now, "synthetic-parity")
            }
            _ => panic!("{id}: unsupported reader"),
        };
        let actual = normalize(rows);
        assert!(divergences.trim().is_empty(), "{id}: stale divergence list");
        assert_json(&actual, &answer["expected"], &id);
        if status != 200 {
            assert_json(
                &actual,
                &json!({"outcome": "rejected", "readings": []}),
                &id,
            );
        }
    }
}

#[test]
fn claude_shared_corpus() {
    run_provider("claude");
}
#[test]
fn codex_shared_corpus() {
    run_provider("codex");
}
#[test]
fn openrouter_shared_corpus() {
    run_provider("openrouter");
}
#[test]
fn kimi_shared_corpus() {
    run_provider("kimi");
}
