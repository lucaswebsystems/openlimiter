#[path = "../src/data_rules.rs"]
mod data_rules;
// Exercise production permissions through IPC, without starting shell services.
#[path = "../src/activity.rs"]
mod activity;
#[path = "../src/providers_plugin.rs"]
mod providers_plugin;
#[path = "../src/rail.rs"]
mod rail;
// The Rail reads the production cache boundary even in the mock IPC runtime.
#[path = "../src/antigravity_credential.rs"]
mod antigravity_credential;
#[path = "../src/antigravity_local.rs"]
mod antigravity_local;
#[path = "../src/cache_write.rs"]
mod cache_write;
#[path = "../src/connections.rs"]
mod connections;
#[path = "../src/credentials.rs"]
mod credentials;
#[path = "../src/fsx.rs"]
mod fsx;
#[path = "../src/native_opencode.rs"]
mod native_opencode;
#[path = "../src/native_readers.rs"]
mod native_readers;
#[path = "../src/native_snapshot.rs"]
mod native_snapshot;
#[path = "../src/native_time.rs"]
mod native_time;
#[path = "../src/net.rs"]
mod net;
#[path = "../src/poll_identity.rs"]
mod poll_identity;
#[path = "../src/provider_detection.rs"]
mod provider_detection;
#[path = "../src/provider_switches.rs"]
mod provider_switches;
#[path = "../src/reader_registry.rs"]
mod reader_registry;
#[path = "../src/request_policy.rs"]
mod request_policy;
#[path = "../src/account_identity.rs"]
mod account_identity;
#[path = "../src/config_credentials.rs"]
mod config_credentials;
#[path = "../src/providers/mod.rs"]
mod providers;
#[path = "../src/state.rs"]
mod state;
#[path = "../src/test_support.rs"]
mod test_support;

use serde_json::{json, Value};
use std::{fs, path::Path};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindow, WebviewWindowBuilder,
};

fn app() -> tauri::App<MockRuntime> {
    mock_builder()
        .plugin(activity::init())
        .plugin(rail::init())
        .plugin(providers_plugin::init())
        .build(tauri::generate_context!())
        .expect("production capability context builds")
}

fn app_with_snapshot_root(root: &Path) -> tauri::App<MockRuntime> {
    let app = app();
    rail::set_test_snapshot_root(&app.handle(), root.to_path_buf());
    app
}

fn invoke(window: &WebviewWindow<MockRuntime>, command: &str) -> Result<Value, Value> {
    invoke_body(window, command, InvokeBody::default())
}

fn invoke_body(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: InvokeBody,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body,
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().expect("JSON view model"))
}

fn assert_allowed(label: &str, command: &str, expected: Value) {
    let app = app();
    let window = WebviewWindowBuilder::new(&app, label, Default::default())
        .build()
        .unwrap();
    assert_eq!(invoke(&window, command), Ok(expected.clone()));
    assert_eq!(invoke(&window, command), Ok(expected));
}

fn assert_denied(label: &str, command: &str) {
    let app = app();
    let window = WebviewWindowBuilder::new(&app, label, Default::default())
        .build()
        .unwrap();
    let error = invoke(&window, command).expect_err("window must have an explicit grant");
    let message = error.as_str().expect("ACL error is text");
    assert!(message.contains("not allowed"), "{message}");
    assert!(
        message.contains(command.split('|').nth(1).unwrap()),
        "{message}"
    );
}

#[test]
fn activity_main_allowed() {
    assert_allowed(
        "main",
        "plugin:activity|activity_snapshot",
        json!({"sessions": [], "skippedFiles": 0, "inspectedEntriesLastTick": 0}),
    );
}

#[test]
fn activity_ungranted_window_denied() {
    assert_denied("ungranted", "plugin:activity|activity_snapshot");
}

#[test]
fn activity_sessions_main_allowed() {
    assert_allowed("main", "plugin:activity|activity_sessions", json!([]));
}

#[test]
fn activity_locate_allowed_only_for_agents_and_rail_card() {
    for label in ["main", "rail-card"] {
        let app = app();
        let window = WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .unwrap();
        assert_eq!(
            invoke_body(
                &window,
                "plugin:activity|activity_locate",
                InvokeBody::Json(json!({"sessionId": "unknown"}))
            ),
            Ok(json!("unavailable"))
        );
    }
    for label in ["ungranted", "rail", "tray"] {
        assert_denied(label, "plugin:activity|activity_locate");
    }
}

#[test]
fn activity_preferences_are_main_only() {
    for label in ["ungranted", "rail", "rail-card", "tray"] {
        for command in [
            "activity_notification_preferences",
            "activity_set_notification_preferences",
        ] {
            assert_denied(label, &format!("plugin:activity|{command}"));
        }
    }
    let app = app();
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    // Invalid preferences reach deserialization, never touch disk.
    let error = invoke_body(
        &window,
        "plugin:activity|activity_set_notification_preferences",
        InvokeBody::Json(json!({"preferences": {}})),
    )
    .unwrap_err();
    assert!(!error.as_str().unwrap().contains("not allowed"));
}

#[test]
fn activity_sessions_ungranted_windows_denied() {
    for label in ["ungranted", "rail", "tray"] {
        assert_denied(label, "plugin:activity|activity_sessions");
    }
}

#[test]
fn rail_main_allowed() {
    assert_rail_snapshot("main");
}

#[test]
fn rail_future_window_allowed() {
    assert_rail_snapshot("rail");
}

fn assert_rail_snapshot(label: &str) {
    let root = test_support::TempDir::new();
    let app = app_with_snapshot_root(root.path());
    let window = WebviewWindowBuilder::new(&app, label, Default::default())
        .build()
        .unwrap();
    let snapshot = invoke(&window, "plugin:rail|rail_snapshot").unwrap();
    assert_eq!(snapshot["accounts"], json!([]));
    assert_eq!(snapshot["sessions"], json!([]));
    assert_eq!(snapshot.as_object().unwrap().len(), 4);
    assert_eq!(snapshot["window"]["visible"], true);
    assert_eq!(snapshot["window"]["edge"], "left");
    assert_eq!(snapshot["window"]["keepOpen"], false);
}

#[test]
fn rail_card_window_allowed() {
    assert_rail_snapshot("rail-card");
}

#[test]
fn rail_snapshot_reads_seeded_cache_from_test_root() {
    let observed = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let root = test_support::TempDir::new();
    fs::write(
        root.path().join("openlimiter-cache.json"),
        json!({
            "version": 2,
            "snapshots": [{
                "provider": "CLAUDE",
                "meter": "FIVE_HOUR",
                "accountId": "fixture-account",
                "value": 82,
                "unit": "PERCENT",
                "kind": "quota_percent",
                "window": { "kind": "rolling", "durationSeconds": 18000 },
                "resetAt": "2099-09-28T15:00:00.000Z",
                "observedAt": observed,
                "expiresAt": "2099-09-28T15:00:00.000Z",
                "precision": "exact",
                "source": "internal_payload",
                "labels": {
                    "credentialOrigin": "official-local-tool",
                    "dataInterfaceStatus": "internal-endpoint",
                    "automationRisk": "high",
                    "verification": "UNVERIFIED"
                },
                "accountLabel": "private fixture label",
                "privateMetadata": "private fixture path"
            }]
        })
        .to_string(),
    )
    .expect("the fixture cache is writable");
    let app = app_with_snapshot_root(root.path());
    let window = WebviewWindowBuilder::new(&app, "rail", Default::default())
        .build()
        .unwrap();

    let snapshot = invoke(&window, "plugin:rail|rail_snapshot").unwrap();
    assert_eq!(
        snapshot["accounts"],
        json!([{
            "provider": "CLAUDE",
            "account": "fixture-account",
            "headlineMeterId": "session_5h",
            "kind": "quota_percent",
            "value": 82.0,
            "meaning": "used",
            "windowLabel": "Current session",
            "resetAt": "2099-09-28T15:00:00.000Z",
            "observedAt": observed,
            "freshness": "fresh",
            "availability": "available",
            "band": "orange",
            "precision": "exact",
            "fidelityMarker": null,
            "sessions": {
                "busy": 0,
                "waiting": 0,
                "done": 0,
                "idle": 0,
                "unknown": 0
            }
        }])
    );
    assert!(!snapshot.to_string().contains("private fixture"));
}

#[test]
fn rail_controls_allowed_through_production_acl() {
    for label in ["main", "rail", "rail-card"] {
        let root = test_support::TempDir::new();
        let app = app_with_snapshot_root(root.path());
        let window = WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .unwrap();
        for (command, args) in [
            ("rail_set_keep_open", json!({"keepOpen": false})),
            ("rail_card_open", json!({"anchor": 24})),
            ("rail_card_close", json!({})),
            ("rail_set_visible", json!({"visible": false})),
        ] {
            assert_eq!(
                invoke_body(
                    &window,
                    &format!("plugin:rail|{command}"),
                    InvokeBody::Json(args)
                ),
                Ok(Value::Null)
            );
        }
        let snapshot = invoke(&window, "plugin:rail|rail_snapshot").unwrap();
        assert_eq!(snapshot["window"]["visible"], false);
        assert_eq!(snapshot["window"]["keepOpen"], false);
        assert_eq!(snapshot["window"]["cardOpen"], false);
        // This reaches validation, proving the ACL granted it; no real monitor
        // is queried or window shown by the mock application.
        assert_eq!(
            invoke_body(
                &window,
                "plugin:rail|rail_move_offset",
                InvokeBody::Json(json!({"offset": -1}))
            ),
            Err(json!("The edge tab is fixed to the primary display"))
        );
        assert_eq!(
            invoke_body(
                &window,
                "plugin:rail|rail_set_keep_open",
                InvokeBody::Json(json!({"keepOpen": true}))
            ),
            Err(json!("The edge panel closes when the pointer leaves"))
        );
    }
}

#[test]
fn rail_controls_denied_to_ungranted_and_tray_windows() {
    for label in ["ungranted", "tray"] {
        for command in [
            "rail_set_visible",
            "rail_set_keep_open",
            "rail_move_offset",
            "rail_card_open",
            "rail_card_close",
        ] {
            assert_denied(label, &format!("plugin:rail|{command}"));
        }
    }
}

#[test]
fn rail_ungranted_window_denied() {
    assert_denied("ungranted", "plugin:rail|rail_snapshot");
}

#[test]
fn providers_main_allowed() {
    assert_allowed(
        "main",
        "plugin:providers|providers_catalog",
        json!({"providers": []}),
    );
}

#[test]
fn providers_ungranted_window_denied() {
    assert_denied("ungranted", "plugin:providers|providers_catalog");
}

#[test]
fn rail_window_cannot_read_activity() {
    for label in ["rail", "rail-card"] {
        for command in ["activity_snapshot", "activity_sessions"] {
            assert_denied(label, &format!("plugin:activity|{command}"));
        }
    }
}

#[test]
fn rail_window_cannot_read_providers() {
    assert_denied("rail", "plugin:providers|providers_catalog");
}

#[test]
fn activity_display_uses_contract_keys_and_omits_absent_optionals() {
    let record = activity::ActivityDisplayRecord {
        session_id: "a".repeat(64),
        agent: "codex".into(),
        state: "idle".into(),
        confidence: "inferred".into(),
        first_observed_at: "2026-09-28T12:00:00.000Z".into(),
        observed_at: "2026-09-28T12:00:00.000Z".into(),
        state_changed_at: "2026-09-28T12:00:00.000Z".into(),
        user_project_label: None,
        outcome: None,
    };
    assert_eq!(
        serde_json::to_value(&record).unwrap(),
        json!({
            "sessionId": "a".repeat(64), "agent": "codex", "state": "idle",
            "confidence": "inferred", "firstObservedAt": "2026-09-28T12:00:00.000Z",
            "observedAt": "2026-09-28T12:00:00.000Z", "stateChangedAt": "2026-09-28T12:00:00.000Z"
        })
    );
    let labelled = activity::ActivityDisplayRecord {
        user_project_label: Some("project".into()),
        outcome: Some("cancelled".into()),
        ..record
    };
    let value = serde_json::to_value(labelled).unwrap();
    assert_eq!(value["userProjectLabel"], "project");
    assert_eq!(value["outcome"], "cancelled");
}

#[test]
fn rail_account_uses_contract_keys_and_preserves_nulls() {
    let row = rail::RailAccountViewModel {
        provider: "codex".into(),
        account: None,
        headline_meter_id: "quota".into(),
        kind: "unknown".into(),
        value: None,
        meaning: "used".into(),
        window_label: "Unknown".into(),
        reset_at: None,
        observed_at: Some("2026-09-28T11:57:00.000Z".into()),
        freshness: "unknown".into(),
        availability: "available".into(),
        band: "stale".into(),
        precision: "unknown".into(),
        fidelity_marker: Some("unknown".into()),
        sessions: rail::SessionsSummary {
            busy: 0,
            waiting: 0,
            done: 0,
            idle: 0,
            unknown: 0,
        },
    };
    assert_eq!(
        serde_json::to_value(row).unwrap(),
        json!({
            "provider": "codex", "account": null, "headlineMeterId": "quota", "kind": "unknown",
            "value": null, "meaning": "used", "windowLabel": "Unknown", "resetAt": null,
            "observedAt": "2026-09-28T11:57:00.000Z",
            "freshness": "unknown", "availability": "available", "band": "stale",
            "precision": "unknown", "fidelityMarker": "unknown",
            "sessions": { "busy": 0, "waiting": 0, "done": 0, "idle": 0, "unknown": 0 }
        })
    );
}
