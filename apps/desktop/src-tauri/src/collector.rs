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
    },
}

impl CollectionOutcome {
    fn failed(connection_id: &str, reason: CollectorFailure, status: Option<u16>) -> Self {
        CollectionOutcome::Failed {
            connection_id: connection_id.to_string(),
            reason,
            status,
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
    let (generation, reader, status, body, retry_after) = match outcome {
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
            ));
        }
        ProbeOutcome::Response {
            attempt_generation,
            reader_id,
            status,
            body,
            retry_after_seconds,
            ..
        } => (
            attempt_generation,
            reader_id,
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
        ));
    }
    let Some(body) = body.filter(|body| !body.is_empty()) else {
        schedule_after(connections, &connection_id, false, true, retry_after)?;
        return Ok(CollectionOutcome::failed(
            &connection_id,
            CollectorFailure::EmptyBody,
            Some(status),
        ));
    };
    let observed_ms = now_epoch_ms();
    let Some(snapshots) = parse_body(reader, &body, observed_ms, &record.id) else {
        let observed_at = iso_from_epoch_ms(observed_ms).ok_or(CommandFailure::Protocol)?;
        let suppressed = if matches!(mode, CollectionMode::Refresh) {
            commit_report(
                writer,
                record.provider_id.code().to_string(),
                record.id.clone(),
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
        record.id.clone(),
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
        CollectionOutcome::failed(&connection_id, CollectorFailure::Cache, Some(status))
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
        assert!(cache.contains("PRIMARY"));
        assert!(cache.contains("92.0"));
    }
}
