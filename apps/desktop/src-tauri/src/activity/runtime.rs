use super::{
    engine::{Engine, Transition},
    process::{self, Probe},
    spool::Reader,
    ActivityDisplayRecord, ActivityState,
};
use std::{
    io,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

// Rust consumers receive only the engine's display projection, never targets.
// No command or webview permission is added for this read.
pub(crate) fn display_sessions<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<Vec<ActivityDisplayRecord>> {
    let state = app.try_state::<ActivityState>()?;
    let sessions = state.sessions.lock().ok()?;
    Some(
        sessions
            .iter()
            .take(super::contract::LIVE_SESSIONS)
            .cloned()
            .collect(),
    )
}

#[cfg(test)]
mod rail_tests {
    use super::*;
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_builder, INVOKE_KEY},
        webview::InvokeRequest,
        WebviewWindowBuilder,
    };

    #[test]
    fn rail_snapshot_reads_bounded_native_display_state_through_ipc() {
        let app = mock_builder()
            .plugin(crate::activity::init())
            .plugin(crate::rail::init())
            .build(tauri::generate_context!())
            .unwrap();
        let record = ActivityDisplayRecord {
            session_id: "a".repeat(64),
            agent: "codex".into(),
            state: "busy".into(),
            confidence: "explicit".into(),
            first_observed_at: "2026-01-01T00:00:00.000Z".into(),
            observed_at: "2026-01-01T00:01:00.000Z".into(),
            state_changed_at: "2026-01-01T00:00:00.000Z".into(),
            user_project_label: Some("private project".into()),
            outcome: None,
        };
        *app.state::<ActivityState>().sessions.lock().unwrap() = vec![record; 1000];
        for label in ["rail", "rail-card"] {
            let window = WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap();
            let response = get_ipc_response(
                &window,
                InvokeRequest {
                    cmd: "plugin:rail|rail_snapshot".into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();
            assert_eq!(response["sessions"].as_array().unwrap().len(), 64);
            assert_eq!(response["sessions"][0]["agent"], "codex");
            assert_eq!(response["sessions"][0]["state"], "busy");
            assert_eq!(response["sessions"][0]["computer"], "local");
            assert!(response["sessions"][0]["elapsedSeconds"].is_u64());
            assert!(!response.to_string().contains("private project"));
        }
    }
}

pub(super) struct Consumer {
    root: PathBuf,
    reader: Reader,
    engine: Option<Engine>,
}
pub(super) struct Tick {
    pub sessions: Vec<ActivityDisplayRecord>,
    pub targets: std::collections::BTreeMap<String, super::contract::Process>,
    pub transitions: Vec<Transition>,
    pub skipped: Option<usize>,
    pub inspected: usize,
}

impl Consumer {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            reader: Reader::new(root),
            engine: None,
        }
    }

    pub fn tick(&mut self, now: i64, probe: &impl Fn(u64) -> Probe) -> io::Result<Tick> {
        if self.engine.is_none() {
            self.engine = Some(Engine::load(&self.root, now)?);
        }
        let current = self.engine.as_mut().unwrap();
        let scan = self.reader.tick(now);
        let mut next = current.clone();
        let transitions = if scan.complete {
            next.apply(scan.events, now, probe)
        } else {
            next.maintain(now, probe);
            Vec::new()
        };
        // Commit before handing off. A crash after this point can lose a
        // notification, but cannot announce the same transition twice.
        if next != *current {
            next.save(&self.root)?;
        }
        *current = next;
        Ok(Tick {
            sessions: current.displays(),
            targets: current
                .sessions
                .iter()
                .filter_map(|(key, session)| {
                    ((session.ended_at.is_none() || session.state == "done")
                        && !session.identity_lost)
                        .then(|| {
                            session
                                .process
                                .clone()
                                .map(|process| (key.clone(), process))
                        })
                        .flatten()
                })
                .collect(),
            transitions,
            skipped: scan.complete.then_some(scan.skipped),
            inspected: scan.inspected,
        })
    }
}

pub(super) fn publish<R: Runtime>(app: &AppHandle<R>, tick: Tick) {
    let state = app.state::<ActivityState>();
    if let Ok(mut targets) = state.targets.lock() {
        *targets = tick.targets;
    }
    state
        .inspected_entries
        .store(tick.inspected, Ordering::Relaxed);
    if let Some(skipped) = tick.skipped {
        state.skipped_files.store(skipped, Ordering::Relaxed);
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        *sessions = tick.sessions;
    }
    for transition in tick.transitions {
        super::notify::submit(app, &transition.notification);
        // App is the Rust listener target. No raw local metadata is broadcast
        // to webviews lacking the activity capability.
        let _ = app.emit_to(tauri::EventTarget::App, "activity-transition", transition);
    }
}

// Mirrors state::state_directory; kept independent so production ACL tests can
// include just this plugin, without starting any shell or credential service.
pub(super) fn state_root() -> Option<PathBuf> {
    let variable = |key| {
        std::env::var_os(key)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let home = || variable("HOME").or_else(|| variable("USERPROFILE"));
    if cfg!(windows) {
        return Some(variable("LOCALAPPDATA").or_else(home)?.join("openlimiter"));
    }
    if cfg!(target_os = "macos") {
        return Some(home()?.join("Library/Application Support/openlimiter"));
    }
    Some(
        variable("XDG_STATE_HOME")
            .or_else(|| home().map(|v| v.join(".local/state")))?
            .join("openlimiter"),
    )
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if app
        .state::<ActivityState>()
        .running
        .swap(true, Ordering::Relaxed)
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(root) = state_root() else {
            return;
        };
        let mut consumer = Consumer::new(&root);
        while app.state::<ActivityState>().running.load(Ordering::Relaxed) {
            let now = chrono::Utc::now().timestamp_millis();
            // Missing roots retry after hook installation. Unsafe checkpoints
            // fail closed instead of replaying saved completions.
            if let Ok(tick) = consumer.tick(now, &process::probe) {
                publish(&app, tick);
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
