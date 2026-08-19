use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::cache_write::CacheWriter;
use crate::collector::{collect_core, CollectionMode, CollectionOutcome, CollectorFailure};
use crate::collector_schedule::{due_records, schedule_after};
use crate::commands::CommandFailure;
use crate::connections::{now_epoch_ms, ConnectionsStore};
use crate::credentials::{KeyringStore, SecretStore};
use crate::net::{ReqwestTransport, Transport};

pub const COLLECTOR_UPDATED_EVENT: &str = "collector-updated";
const COLLECTOR_INTERVAL_SECONDS: u64 = 60;

#[derive(Clone, Debug, Serialize)]
pub struct CollectorStatus {
    pub ticks: u64,
    pub last_pass_at: Option<u64>,
    pub last_failure: Option<CollectorFailure>,
}

#[derive(Default)]
struct RuntimeInner {
    active: HashSet<String>,
    ticks: u64,
    last_pass_at: Option<u64>,
    last_failure: Option<CollectorFailure>,
}

#[derive(Default)]
pub struct CollectorRuntime {
    inner: Mutex<RuntimeInner>,
}

impl CollectorRuntime {
    fn begin(&self, id: &str) -> bool {
        self.inner
            .lock()
            .map(|mut inner| inner.active.insert(id.to_string()))
            .unwrap_or(false)
    }

    fn finish(&self, id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.active.remove(id);
        }
    }

    pub fn record_pass(&self, failure: Option<CollectorFailure>, attempted: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.ticks = inner.ticks.wrapping_add(1);
            inner.last_pass_at = Some(now_epoch_ms());
            if failure.is_some() || attempted {
                inner.last_failure = failure;
            }
        }
    }

    pub fn status(&self) -> CollectorStatus {
        self.inner
            .lock()
            .map(|inner| CollectorStatus {
                ticks: inner.ticks,
                last_pass_at: inner.last_pass_at,
                last_failure: inner.last_failure,
            })
            .unwrap_or(CollectorStatus {
                ticks: 0,
                last_pass_at: None,
                last_failure: Some(CollectorFailure::Internal),
            })
    }
}

pub async fn run_guarded<T: Transport>(
    runtime: &CollectorRuntime,
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    writer: Arc<CacheWriter>,
    connection_id: String,
    mode: CollectionMode,
) -> Result<CollectionOutcome, CommandFailure> {
    if !runtime.begin(&connection_id) {
        return Ok(CollectionOutcome::Failed {
            connection_id,
            reason: CollectorFailure::Busy,
            status: None,
        });
    }
    let outcome = collect_core(
        connections,
        secrets,
        transport,
        writer,
        connection_id.clone(),
        mode,
    )
    .await;
    if outcome.is_err() {
        let _ = schedule_after(connections, &connection_id, false, true, None);
    }
    runtime.finish(&connection_id);
    outcome
}

async fn run_pass(app: &AppHandle, explicit: bool) {
    let connections = app.state::<ConnectionsStore>();
    let records = if explicit {
        connections.list().map_err(CommandFailure::from)
    } else {
        due_records(&connections, now_epoch_ms())
    };
    let mut last_failure = None;
    let mut attempted = false;
    match records {
        Ok(records) => {
            for record in records {
                attempted = true;
                let runtime = app.state::<CollectorRuntime>();
                let secrets = app.state::<KeyringStore>();
                let transport = app.state::<ReqwestTransport>();
                let writer = app.state::<Arc<CacheWriter>>();
                match run_guarded(
                    &runtime,
                    &connections,
                    &*secrets,
                    &*transport,
                    Arc::clone(&writer),
                    record.id,
                    CollectionMode::Refresh,
                )
                .await
                {
                    Ok(outcome) => {
                        if outcome.failure().is_some() {
                            last_failure = outcome.failure();
                        }
                    }
                    Err(_) => last_failure = Some(CollectorFailure::Internal),
                }
            }
        }
        Err(_) => last_failure = Some(CollectorFailure::Internal),
    }
    crate::claude_oauth::run_pass(app).await;
    let runtime = app.state::<CollectorRuntime>();
    runtime.record_pass(last_failure, attempted);
    let _ = app.emit(COLLECTOR_UPDATED_EVENT, runtime.status());
}

pub fn spawn_collector(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(COLLECTOR_INTERVAL_SECONDS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            run_pass(&app, false).await;
        }
    });
}

pub fn refresh_all(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_pass(&app, true).await;
    });
}
