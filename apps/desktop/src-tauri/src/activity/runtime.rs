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
