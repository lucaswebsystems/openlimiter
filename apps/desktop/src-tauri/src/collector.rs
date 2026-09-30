use std::sync::Arc;

use serde::Serialize;

use crate::cache_write::CacheWriter;
use crate::collector_schedule::schedule_after;
use crate::commands::{
    self, AttemptDisposition, CommandFailure, CompleteAttemptInput, ProbeFailure, ProbeInput,
    ProbeOutcome,
};
use crate::connections::{now_epoch_ms, ConnectionsStore};
use crate::credentials::SecretStore;
use crate::native_readers::parse_body;
use crate::native_snapshot::{iso_from_epoch_ms, write_report, CacheReport};
use crate::net::Transport;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectorFailure {
    Timeout,
    Connect,
    Tls,
    Oversize,
    InvalidUtf8,
    ProviderResponse,
    EmptyBody,
    Drift,
    Cache,
    Busy,
    Internal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CollectionOutcome {
    Tested {
        connection_id: String,
    },
    CacheCommitted {
        connection_id: String,
    },
    Failed {
        connection_id: String,
        reason: CollectorFailure,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after_seconds: Option<u64>,
    },
}

impl CollectionOutcome {
    fn failed(
        connection_id: &str,
        reason: CollectorFailure,
        status: Option<u16>,
        retry_after_seconds: Option<u64>,
    ) -> Self {
        CollectionOutcome::Failed {
            connection_id: connection_id.to_string(),
            reason,
            status,
            retry_after_seconds,
        }
    }

    pub(crate) fn failure(&self) -> Option<CollectorFailure> {
        match self {
            CollectionOutcome::Failed { reason, .. } => Some(*reason),
            CollectionOutcome::Tested { .. } | CollectionOutcome::CacheCommitted { .. } => None,
        }
    }

    pub(crate) fn status(&self) -> Option<u16> {
        match self {
            CollectionOutcome::Failed { status, .. } => *status,
            CollectionOutcome::Tested { .. } | CollectionOutcome::CacheCommitted { .. } => None,
        }
    }

    pub(crate) fn retry_after_seconds(&self) -> Option<u64> {
        match self {
            CollectionOutcome::Failed {
                retry_after_seconds,
                ..
            } => *retry_after_seconds,
            CollectionOutcome::Tested { .. } | CollectionOutcome::CacheCommitted { .. } => None,
        }
    }
}

fn probe_failure(failure: ProbeFailure) -> CollectorFailure {
    match failure {
        ProbeFailure::Timeout => CollectorFailure::Timeout,
        ProbeFailure::Connect => CollectorFailure::Connect,
        ProbeFailure::Tls => CollectorFailure::Tls,
        ProbeFailure::Oversize => CollectorFailure::Oversize,
        ProbeFailure::InvalidUtf8 => CollectorFailure::InvalidUtf8,
    }
}

async fn commit_report(
    writer: Arc<CacheWriter>,
    provider: String,
    account_id: String,
    report: CacheReport,
) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, &provider, Some(&account_id), report)
    })
    .await
    .is_ok_and(|result| result.is_ok())
}

#[derive(Clone, Copy)]
pub enum CollectionMode {
    Test,
    Refresh,
}

pub async fn collect_core<T: Transport>(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    writer: Arc<CacheWriter>,
    connection_id: String,
    mode: CollectionMode,
) -> Result<CollectionOutcome, CommandFailure> {
    let record = connections.get(&connection_id)?;
    let outcome = commands::probe_core(
        connections,
        secrets,
        transport,
        ProbeInput {
            connection_id: connection_id.clone(),
        },
    )
    .await?;
    let (generation, reader, account_id, status, body, retry_after) = match outcome {
        ProbeOutcome::TransportFailure {
            attempt_generation: _,
            failure,
            ..
        } => {
            schedule_after(connections, &connection_id, false, false, None)?;
            return Ok(CollectionOutcome::failed(
                &connection_id,
                probe_failure(failure),
                None,
                None,
            ));
        }
        ProbeOutcome::Response {
            attempt_generation,
            reader_id,
            account_id,
            status,
            body,
            retry_after_seconds,
            ..
        } => (
            attempt_generation,
            reader_id,
            account_id,
            status,
            body,
            retry_after_seconds,
        ),
    };
    if !(200..=299).contains(&status) {
        schedule_after(connections, &connection_id, false, false, retry_after)?;
        return Ok(CollectionOutcome::failed(
            &connection_id,
            CollectorFailure::ProviderResponse,
            Some(status),
            retry_after,
        ));
    }
    let Some(body) = body.filter(|body| !body.is_empty()) else {
        schedule_after(connections, &connection_id, false, true, retry_after)?;
        return Ok(CollectionOutcome::failed(
            &connection_id,
            CollectorFailure::EmptyBody,
            Some(status),
            retry_after,
        ));
    };
    let observed_ms = now_epoch_ms();
    /* Filed under the identity of the credential this request sent, the one
    projection treats as the saved connection's account, never under the
    connection's own id. */
    let Some(snapshots) = parse_body(reader, &body, observed_ms, &account_id) else {
        let observed_at = iso_from_epoch_ms(observed_ms).ok_or(CommandFailure::Protocol)?;
        let suppressed = if matches!(mode, CollectionMode::Refresh) {
            commit_report(
                writer,
                record.provider_id.code().to_string(),
                account_id.clone(),
                CacheReport::Drift { observed_at },
            )
            .await
        } else {
            true
        };
        commands::complete_attempt_core(
            connections,
            CompleteAttemptInput {
                connection_id: connection_id.clone(),
                attempt_generation: generation,
                disposition: AttemptDisposition::Drift,
            },
        )?;
        schedule_after(connections, &connection_id, false, true, retry_after)?;
        return Ok(CollectionOutcome::failed(
            &connection_id,
            if suppressed {
                CollectorFailure::Drift
            } else {
                CollectorFailure::Cache
            },
            Some(status),
            retry_after,
        ));
    };
    if matches!(mode, CollectionMode::Test) {
        commands::complete_attempt_core(
            connections,
            CompleteAttemptInput {
                connection_id: connection_id.clone(),
                attempt_generation: generation,
                disposition: AttemptDisposition::ParsedTest,
            },
        )?;
        schedule_after(connections, &connection_id, true, false, None)?;
        return Ok(CollectionOutcome::Tested { connection_id });
    }
    let committed = commit_report(
        writer,
        record.provider_id.code().to_string(),
        account_id,
        CacheReport::Success(snapshots),
    )
    .await;
    commands::complete_attempt_core(
        connections,
        CompleteAttemptInput {
            connection_id: connection_id.clone(),
            attempt_generation: generation,
            disposition: if committed {
                AttemptDisposition::CacheCommitted
            } else {
                AttemptDisposition::CacheFailure
            },
        },
    )?;
    schedule_after(
        connections,
        &connection_id,
        committed,
        !committed,
        retry_after,
    )?;
    Ok(if committed {
        CollectionOutcome::CacheCommitted { connection_id }
    } else {
        CollectionOutcome::failed(
            &connection_id,
            CollectorFailure::Cache,
            Some(status),
            retry_after,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::cache_write::CACHE_FILE_NAME;
    use crate::commands::{connect_core, ConnectProviderInput};
    use crate::connections::ConnectionsStore;
    use crate::reader_registry::{CredentialKind, ProviderId};
    use crate::test_support::{InMemorySecrets, RecordingTransport, TempDir};

    const FIXTURE_SECRET: &str = "fixture-credential-never-cache";

    async fn collect_fixture(
        provider_id: ProviderId,
        credential_kind: CredentialKind,
        response: &[u8],
    ) -> (Vec<String>, Vec<String>, String) {
        let dir = TempDir::new();
        let connections = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let secrets = InMemorySecrets::new();
        let record = connect_core(
            &connections,
            &secrets,
            ConnectProviderInput {
                provider_id,
                credential_kind,
                account_alias: "fixture account".to_string(),
                secret: FIXTURE_SECRET.to_string(),
            },
        )
        .expect("fixture connection");
        let transport = RecordingTransport::replying(200, response.to_vec(), None);
        let writer = Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())));
        let outcome = collect_core(
            &connections,
            &secrets,
            &transport,
            writer,
            record.id.clone(),
            CollectionMode::Refresh,
        )
        .await
        .expect("fixture collection");
        assert_eq!(
            outcome,
            CollectionOutcome::CacheCommitted {
                connection_id: record.id
            }
        );
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("fixture cache");
        assert!(!cache.contains(FIXTURE_SECRET));
        (
            transport.recorded_urls(),
            transport.recorded_secrets(),
            cache,
        )
    }

    #[test]
    fn collection_outcomes_never_serialize_provider_bodies() {
        let outcomes = [
            CollectionOutcome::Tested {
                connection_id: "test-id".to_string(),
            },
            CollectionOutcome::CacheCommitted {
                connection_id: "test-id".to_string(),
            },
            CollectionOutcome::Failed {
                connection_id: "test-id".to_string(),
                reason: CollectorFailure::Drift,
                status: Some(200),
                retry_after_seconds: None,
            },
        ];
        for outcome in outcomes {
            let wire = serde_json::to_string(&outcome).expect("serializable");
            assert!(!wire.contains("body"));
            assert!(!wire.contains("payload"));
            assert!(!wire.contains("SECRET-MARKER"));
        }
    }

    #[tokio::test]
    async fn openrouter_fixture_covers_key_request_parse_and_cache() {
        let (urls, secrets, cache) = collect_fixture(
            ProviderId::Openrouter,
            CredentialKind::OpenrouterManagementKey,
            include_bytes!("../../../../packages/connectors/fixtures/openrouter.credits.json"),
        )
        .await;
        assert_eq!(urls, vec![crate::net::OPENROUTER_CREDITS_URL]);
        assert_eq!(secrets, vec![FIXTURE_SECRET]);
        assert!(cache.contains("OPENROUTER"));
        assert!(cache.contains("CREDITS"));
        assert!(cache.contains("12.47"));
    }

    #[tokio::test]
    async fn opencode_fixture_covers_cookie_two_hops_parse_and_cache() {
        let (urls, secrets, cache) = collect_fixture(
            ProviderId::Opencode,
            CredentialKind::OpencodeBrowserSession,
            include_bytes!("../../../../packages/connectors/fixtures/opencode.workspace.html"),
        )
        .await;
        assert_eq!(
            urls,
            vec![
                crate::net::OPENCODE_AUTH_URL.to_string(),
                "https://opencode.ai/workspace/wrk_testworkspace/go".to_string()
            ]
        );
        assert_eq!(secrets, vec![FIXTURE_SECRET, FIXTURE_SECRET]);
        assert!(cache.contains("OPENCODE"));
        assert!(cache.contains("FIVE_HOUR"));
        assert!(cache.contains("SEVEN_DAY"));
        assert!(cache.contains("MONTHLY"));
        assert!(cache.contains("40.0"));
        assert!(cache.contains("92.0"));
        assert!(cache.contains("15.0"));
    }

    #[tokio::test]
    async fn saved_key_readings_and_drift_are_filed_under_the_request_credential_identity() {
        /* The identity a saved key polls under is the one projection treats as
        active. Filing the rows under the connection's own id made every saved
        key reading `account_not_connected`. */
        let dir = TempDir::new();
        let connections = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let secrets = InMemorySecrets::new();
        let record = connect_core(
            &connections,
            &secrets,
            ConnectProviderInput {
                provider_id: ProviderId::Openrouter,
                credential_kind: CredentialKind::OpenrouterManagementKey,
                account_alias: "fixture account".to_string(),
                secret: FIXTURE_SECRET.to_string(),
            },
        )
        .expect("fixture connection");
        let identity = crate::poll_identity::resolve_connection(&record, &secrets);
        let writer = Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())));
        async fn collect(
            connections: &ConnectionsStore,
            secrets: &InMemorySecrets,
            writer: &Arc<CacheWriter>,
            id: &str,
            body: &[u8],
        ) {
            let transport = RecordingTransport::replying(200, body.to_vec(), None);
            collect_core(
                connections,
                secrets,
                &transport,
                Arc::clone(writer),
                id.to_string(),
                CollectionMode::Refresh,
            )
            .await
            .expect("fixture collection");
        }
        collect(
            &connections,
            &secrets,
            &writer,
            &record.id,
            include_bytes!("../../../../packages/connectors/fixtures/openrouter.credits.json"),
        )
        .await;
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("fixture cache");
        let rows = crate::native_snapshot::display_snapshots(Some(&cache));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].account_id.as_deref(), Some(identity.account_id()));
        let active = crate::data_rules::ActiveAccounts::from([(
            "OPENROUTER".to_string(),
            std::collections::BTreeSet::from([identity.account_id().to_string()]),
        )]);
        let projection = crate::data_rules::project(
            rows,
            now_epoch_ms() as i64,
            &active,
            &std::collections::BTreeSet::new(),
        );
        assert_eq!(projection.snapshots.len(), 1, "{:?}", projection.flags);
        /* A drift is suppressed under the same identity, so it silences the
        rows it is about and nothing else. */
        /* The completion rate bound is about real round trips; this test makes
        a second one at once on purpose. */
        connections
            .update(&record.id, |it| it.last_completion_at = None)
            .expect("reset the completion clock");
        collect(&connections, &secrets, &writer, &record.id, br#"{"data":{}}"#).await;
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("fixture cache");
        let document: serde_json::Value = serde_json::from_str(&cache).expect("cache document");
        assert_eq!(
            document["suppressions"][0]["accountId"].as_str(),
            Some(identity.account_id())
        );
    }

    #[tokio::test]
    async fn saved_connections_carry_429_and_503_retry_after() {
        for status in [429, 503] {
            let dir = TempDir::new();
            let connections = ConnectionsStore::at(Some(dir.path().to_path_buf()));
            let secrets = InMemorySecrets::new();
            let record = connect_core(
                &connections,
                &secrets,
                ConnectProviderInput {
                    provider_id: ProviderId::Openrouter,
                    credential_kind: CredentialKind::OpenrouterManagementKey,
                    account_alias: "retry fixture".to_string(),
                    secret: FIXTURE_SECRET.to_string(),
                },
            )
            .expect("fixture connection");
            let outcome = collect_core(
                &connections,
                &secrets,
                &RecordingTransport::replying(status, Vec::new(), Some(7_200)),
                Arc::new(CacheWriter::at(Some(dir.path().to_path_buf()))),
                record.id,
                CollectionMode::Refresh,
            )
            .await
            .expect("fixture collection");
            assert_eq!(outcome.status(), Some(status));
            assert_eq!(outcome.retry_after_seconds(), Some(7_200));
        }
    }
}
