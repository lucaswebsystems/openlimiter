// Exercise production permissions through IPC, without starting shell services.
#[path = "../src/activity.rs"]
mod activity;
#[path = "../src/providers_plugin.rs"]
mod providers_plugin;
#[path = "../src/rail.rs"]
mod rail;

use serde_json::{json, Value};
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
    let app = app();
    let window = WebviewWindowBuilder::new(&app, label, Default::default())
        .build()
        .unwrap();
    let snapshot = invoke(&window, "plugin:rail|rail_snapshot").unwrap();
    assert_eq!(snapshot["accounts"], json!([]));
    assert_eq!(snapshot["window"]["visible"], true);
    assert_eq!(snapshot["window"]["edge"], "left");
    assert_eq!(snapshot["window"]["keepOpen"], false);
}

#[test]
fn rail_card_window_allowed() {
    assert_rail_snapshot("rail-card");
}

#[test]
fn rail_controls_allowed_through_production_acl() {
    for label in ["main", "rail", "rail-card"] {
        let app = app();
        let window = WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .unwrap();
        for (command, args) in [
            ("rail_set_keep_open", json!({"keepOpen": true})),
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
        assert_eq!(snapshot["window"]["keepOpen"], true);
        assert_eq!(snapshot["window"]["cardOpen"], false);
        // This reaches validation, proving the ACL granted it; no real monitor
        // is queried or window shown by the mock application.
        assert_eq!(
            invoke_body(
                &window,
                "plugin:rail|rail_move_offset",
                InvokeBody::Json(json!({"offset": -1}))
            ),
            Err(json!("invalid Rail offset"))
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
    assert_denied("rail", "plugin:activity|activity_snapshot");
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
            "freshness": "unknown", "availability": "available", "band": "stale",
            "precision": "unknown", "fidelityMarker": "unknown",
            "sessions": { "busy": 0, "waiting": 0, "done": 0, "idle": 0, "unknown": 0 }
        })
    );
}
