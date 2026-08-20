use crate::commands::{CommandFailure, STATUS_ERROR};
use crate::connections::{
    now_epoch_ms, ConnectionRecord, ConnectionsStore, MAX_CONSECUTIVE_FAILURES,
};
use crate::reader_registry::{CollectionSource, SchedulePolicy};

const BACKOFF_CEILING_SECONDS: u64 = 3_600;
const RETRY_AFTER_CEILING_SECONDS: u64 = 86_400;
const JITTER_RATIO: f64 = 0.2;

fn usable_random(random: f64) -> f64 {
    if random.is_finite() {
        random.clamp(0.0, 1.0)
    } else {
        0.5
    }
}

pub(crate) fn refresh_delay_seconds(
    base_seconds: u64,
    failures: u32,
    retry_after_seconds: Option<u64>,
    random: f64,
) -> u64 {
    let exponent = failures.min(32);
    let multiplier = 1u64.checked_shl(exponent).unwrap_or(u64::MAX);
    let backoff = base_seconds
        .saturating_mul(multiplier)
        .min(BACKOFF_CEILING_SECONDS);
    let jitter = 1.0 + (usable_random(random) * 2.0 - 1.0) * JITTER_RATIO;
    let jittered = ((backoff as f64 * jitter).round().max(1.0) as u64).max(base_seconds);
    retry_after_seconds
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.min(RETRY_AFTER_CEILING_SECONDS))
        .map_or(jittered, |floor| floor.max(jittered))
}

pub(crate) fn scheduled_at(
    source: CollectionSource,
    now_ms: u64,
    failures: u32,
    retry_after_seconds: Option<u64>,
    random: f64,
) -> Option<u64> {
    let SchedulePolicy::Interval { base_seconds } = source.schedule_policy() else {
        return None;
    };
    let delay = refresh_delay_seconds(base_seconds, failures, retry_after_seconds, random);
    Some(now_ms.saturating_add(delay.saturating_mul(1_000)))
}

fn random_unit() -> f64 {
    (now_epoch_ms() % 1_001) as f64 / 1_000.0
}

pub(crate) fn schedule_after(
    connections: &ConnectionsStore,
    id: &str,
    succeeded: bool,
    count_downstream_failure: bool,
    retry_after_seconds: Option<u64>,
) -> Result<(), CommandFailure> {
    let now = now_epoch_ms();
    connections.update(id, |record| {
        if count_downstream_failure {
            record.consecutive_failures = record
                .consecutive_failures
                .saturating_add(1)
                .min(MAX_CONSECUTIVE_FAILURES);
            record.status = STATUS_ERROR.to_string();
        }
        let failures = if succeeded {
            0
        } else {
            record.consecutive_failures.max(1)
        };
        record.next_refresh_at = scheduled_at(
            CollectionSource::Reader(record.reader_id),
            now,
            failures,
            retry_after_seconds,
            random_unit(),
        );
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::ConnectionRecord;
    use crate::credentials::MASK_DOTS;
    use crate::reader_registry::{
        CollectionSource, CredentialKind, ProviderId, ReaderId, SchedulePolicy,
    };
    use crate::test_support::TempDir;

    const NOW: u64 = 1_787_000_000_000;

    fn record(id: &str, reader_id: ReaderId, next_refresh_at: Option<u64>) -> ConnectionRecord {
        let (provider_id, credential_kind) = match reader_id {
            ReaderId::OpenrouterKey => (
                ProviderId::Openrouter,
                CredentialKind::OpenrouterInferenceKey,
            ),
            ReaderId::OpenrouterCredits => (
                ProviderId::Openrouter,
                CredentialKind::OpenrouterManagementKey,
            ),
            ReaderId::CodexUsage => (ProviderId::Codex, CredentialKind::CodexSession),
            ReaderId::AntigravityQuota => {
                (ProviderId::Antigravity, CredentialKind::AntigravitySession)
            }
            ReaderId::OpencodeUsage => {
                (ProviderId::Opencode, CredentialKind::OpencodeBrowserSession)
            }
        };
        ConnectionRecord {
            id: id.to_string(),
            provider_id,
            reader_id,
            credential_kind,
            account_alias: "test".to_string(),
            codex_account_id: (provider_id == ProviderId::Codex)
                .then(|| "account-for-schedule-test".to_string()),
            masked_label: MASK_DOTS.to_string(),
            created_at: NOW,
            base_seconds: reader_id.base_seconds(),
            next_refresh_at,
            last_attempt_at: None,
            last_success_at: None,
            attempt_generation: 0,
            body_delivered_generation: None,
            last_completion_at: None,
            ever_connected: true,
            consecutive_failures: 0,
            status: "CONNECTED".to_string(),
        }
    }

    #[test]
    fn schedule_honours_every_reader_cadence() {
        let cases = [
            (ReaderId::OpenrouterKey, Some(300)),
            (ReaderId::OpenrouterCredits, Some(300)),
            (ReaderId::CodexUsage, Some(300)),
            (ReaderId::AntigravityQuota, Some(600)),
            (ReaderId::OpencodeUsage, None),
        ];
        for (reader, expected_seconds) in cases {
            let next = scheduled_at(CollectionSource::Reader(reader), NOW, 0, None, 0.5);
            assert_eq!(
                next.map(|instant| (instant - NOW) / 1_000),
                expected_seconds
            );
        }
    }

    #[test]
    fn failures_back_off_and_never_lower_the_reader_floor() {
        assert_eq!(refresh_delay_seconds(300, 0, None, 0.5), 300);
        assert_eq!(refresh_delay_seconds(300, 0, None, 0.0), 300);
        assert_eq!(refresh_delay_seconds(300, 1, None, 0.5), 600);
        assert_eq!(refresh_delay_seconds(300, 2, None, 0.5), 1_200);
        assert_eq!(refresh_delay_seconds(300, 32, None, 0.5), 3_600);
        assert_eq!(refresh_delay_seconds(300, 1, Some(10_000), 0.5), 10_000);
    }

    #[test]
    fn event_driven_claude_never_receives_a_poll() {
        let policy = CollectionSource::ClaudeStatusline.schedule_policy();
        assert_eq!(policy, SchedulePolicy::EventDriven);
        assert_eq!(policy.interval_seconds(), None);
        assert_eq!(
            scheduled_at(CollectionSource::ClaudeStatusline, NOW, 0, None, 0.5),
            None
        );
    }

    #[test]
    fn durable_schedule_survives_a_simulated_webview_reload() {
        let dir = TempDir::new();
        let next = NOW + 300_000;
        {
            let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
            store
                .insert(record("reload-safe", ReaderId::OpenrouterKey, Some(next)))
                .expect("stored schedule");
        }
        let after_reload = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        assert!(due_records(&after_reload, NOW)
            .expect("before due")
            .is_empty());
        let due = due_records(&after_reload, next).expect("at due");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].next_refresh_at, Some(next));
    }
}

pub(crate) fn scheduled(record: &ConnectionRecord) -> bool {
    matches!(
        record.status.as_str(),
        "READY_TO_ENABLE" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "STALE" | "ERROR"
    ) && CollectionSource::Reader(record.reader_id)
        .schedule_policy()
        .interval_seconds()
        .is_some()
}

pub(crate) fn eligible(record: &ConnectionRecord, now_ms: u64) -> bool {
    scheduled(record) && record.next_refresh_at.is_none_or(|next| now_ms >= next)
}

pub(crate) fn due_records(
    connections: &ConnectionsStore,
    now_ms: u64,
) -> Result<Vec<ConnectionRecord>, CommandFailure> {
    Ok(connections
        .list()?
        .into_iter()
        .filter(|record| eligible(record, now_ms))
        .collect())
}
