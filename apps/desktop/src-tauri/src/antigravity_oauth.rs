use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::antigravity_local::{
    read_quota_summary, AgyPorts, LocalRead, LoopbackProbe, SystemAgyPorts, SystemLoopbackProbe,
};
use crate::cache_write::CacheWriter;
use crate::native_readers::parse_body;
use crate::native_snapshot::{iso_from_epoch_ms, mirror_provider, write_report, CacheReport};
use crate::net::{fetch_endpoint, NetError, ProviderEndpoint, ReqwestTransport, Transport};
use crate::poll_identity::PollIdentity;
use crate::provider_detection::{
    provider_singleton_account_id, DetectedCredentialError, DetectedProviderId, DetectedSecret,
    DetectionStore,
};
use crate::reader_registry::{AuthApplication, ProviderId, ReaderId};
use crate::request_policy::{GateRejection, RequestPolicy};

/// Fifteen minutes, matching the interval the terminal build polls on.
///
/// It was ten while the reading came from Google's metadata plane. The reading
/// now comes from a client on this machine that has already cached it, and the
/// two surfaces reading the same pool on two different clocks is how a person
/// ends up watching a bar disagree with itself.
pub const REFRESH_SECONDS: u64 = 900;
const RATE_LIMIT_BACKOFF_SECONDS: u64 = 3_600;
const BLOCKED_BACKOFF_SECONDS: u64 = 86_400;
const MAX_THROTTLE_ENTRIES: usize = 128;

/// The account a reading borrowed from the Gemini CLI login is filed under.
///
/// The same string the terminal build uses, so one machine running both does
/// not end up with two rows for one borrowed pool.
pub const SHARED_CODE_ASSIST_ACCOUNT: &str = "gemini-cli-shared";

/// What that account is called where a person can read it.
pub const SHARED_CODE_ASSIST_LABEL: &str = "Shared Google quota, from the Gemini CLI login";

/// What the row says when Google withholds the field the reading needs.
///
/// The same sentence the terminal build shows, so one product does not explain
/// one fact two ways. It states what happened rather than pretending the
/// answer was malformed, because the answer was not malformed: it was correct,
/// and it was addressed to somebody else.
pub const IDENTITY_REFUSED_SENTENCE: &str =
    "Google answers this quota only to its own tools, so it is read here only \
     when another tool on this machine has written it";

/// What the row says when the reading came from the Gemini CLI login.
pub const MIRROR_SENTENCE: &str =
    "Shared Google quota from the Gemini CLI login, not Antigravity's own login";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AntigravityFailure {
    Timeout,
    Connect,
    Tls,
    TooLarge,
    Protocol,
    ProviderResponse,
    RateLimited,
    ProviderBlocked,
    Drift,
    Cache,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AntigravityOutcome {
    CacheCommitted {
        account_id: String,
    },
    Cached {
        account_id: String,
        retry_at: String,
    },
    ReopenCli {
        account_id: String,
        message: String,
    },
    /// The provider answered, and withheld the field the reading needs.
    ///
    /// Measured on 2026-09-07: Google's Code Assist bootstrap answers 200 to a
    /// request identifying as OpenLimiter and returns the tier lists and no
    /// companion project, so there is nothing to scope a quota read to. That is
    /// a well formed answer, so calling it drift would have this build retry it
    /// every fifteen minutes against an answer that cannot change until we
    /// change. It waits a day instead, and the row says why.
    IdentityRefused {
        account_id: String,
        message: String,
    },
    /// The reading was borrowed from the Gemini CLI login for the shared pool.
    Mirrored {
        account_id: String,
        message: String,
    },
    /// Nothing on this machine could answer, which is almost always because
    /// Antigravity is not running.
    NoClient {
        account_id: String,
        message: String,
    },
    Fallback {
        account_id: String,
        reason: AntigravityFailure,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after_seconds: Option<u64>,
    },
    Failed {
        account_id: String,
        reason: AntigravityFailure,
    },
}

impl AntigravityOutcome {
    fn reopen(account_id: &str) -> Self {
        Self::ReopenCli {
            account_id: account_id.to_string(),
            message: "Reopen Antigravity to refresh this login.".to_string(),
        }
    }

    fn identity_refused(account_id: &str) -> Self {
        Self::IdentityRefused {
            account_id: account_id.to_string(),
            message: IDENTITY_REFUSED_SENTENCE.to_string(),
        }
    }

    fn mirrored(account_id: &str) -> Self {
        Self::Mirrored {
            account_id: account_id.to_string(),
            message: MIRROR_SENTENCE.to_string(),
        }
    }

    fn no_client(account_id: &str) -> Self {
        Self::NoClient {
            account_id: account_id.to_string(),
            message: crate::antigravity_local::NO_CLIENT_SENTENCE.to_string(),
        }
    }

    fn fallback(account_id: &str, reason: AntigravityFailure) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason,
            retry_after_seconds: None,
        }
    }

    fn rate_limited(account_id: &str, retry_after_seconds: Option<u64>) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason: AntigravityFailure::RateLimited,
            retry_after_seconds,
        }
    }
}

#[derive(Default)]
pub struct AntigravityOauthRuntime {
    next_allowed: Mutex<BTreeMap<String, u64>>,
}

impl AntigravityOauthRuntime {
    fn begin(&self, account_id: &str, now_ms: u64) -> Result<(), u64> {
        let mut entries = self.next_allowed.lock().map_err(|_| now_ms)?;
        if let Some(next) = entries.get(account_id).copied() {
            if now_ms < next {
                return Err(next);
            }
        }
        if entries.len() >= MAX_THROTTLE_ENTRIES {
            entries.retain(|_, next| *next > now_ms);
        }
        if entries.len() >= MAX_THROTTLE_ENTRIES {
            if let Some(first) = entries.keys().next().cloned() {
                entries.remove(&first);
            }
        }
        entries.insert(
            account_id.to_string(),
            now_ms.saturating_add(REFRESH_SECONDS.saturating_mul(1_000)),
        );
        Ok(())
    }

    fn postpone(&self, account_id: &str, now_ms: u64, seconds: u64) {
        if let Ok(mut entries) = self.next_allowed.lock() {
            entries.insert(
                account_id.to_string(),
                now_ms.saturating_add(seconds.saturating_mul(1_000)),
            );
        }
    }
}

fn net_failure(error: NetError) -> AntigravityFailure {
    match error {
        NetError::Timeout => AntigravityFailure::Timeout,
        NetError::Connect => AntigravityFailure::Connect,
        NetError::Tls => AntigravityFailure::Tls,
        NetError::TooLarge => AntigravityFailure::TooLarge,
        NetError::Protocol => AntigravityFailure::Protocol,
    }
}

async fn commit_report(writer: Arc<CacheWriter>, account_id: String, report: CacheReport) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "ANTIGRAVITY", Some(&account_id), report)
    })
    .await
    .is_ok_and(|result| result.is_ok())
}

async fn fallback_report(writer: Arc<CacheWriter>, account_id: &str, drift: bool, now_ms: u64) {
    let report = if drift {
        CacheReport::Drift {
            observed_at: iso_from_epoch_ms(now_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        }
    } else {
        CacheReport::Unavailable
    };
    let _ = commit_report(writer, account_id.to_string(), report).await;
}

/// The legacy path: Google's own endpoint, reached honestly.
///
/// The cadence gate is not here any more. It moved up to `collect_account`,
/// which is the one place that decides whether this account may be read at all
/// this pass, so a fallback attempt cannot buy itself a second reservation.
async fn collect_with_secret<T: Transport>(
    runtime: &AntigravityOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: &str,
    secret: &DetectedSecret,
    now_ms: u64,
) -> AntigravityOutcome {
    let response = match fetch_endpoint(
        transport,
        ProviderEndpoint::AntigravityQuota,
        AuthApplication::AntigravitySessionBearer,
        &secret.access_token,
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return AntigravityOutcome::Failed {
                account_id: account_id.to_string(),
                reason: net_failure(error),
            }
        }
    };
    match response.status {
        200..=299 => {
            let snapshots = response
                .body
                .as_deref()
                .and_then(|body| parse_body(ReaderId::AntigravityQuota, body, now_ms, account_id));
            let Some(snapshots) = snapshots else {
                /* A 200 with nothing readable in it used to be drift, which was
                right while this request claimed to be Google's own client and
                therefore expected a full answer. It identifies as OpenLimiter
                now, and the answer it gets back is a correct one addressed to
                somebody else. Retrying that every fifteen minutes is ninety six
                pointless requests a day, so it waits a day and the row says
                what happened. */
                runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
                fallback_report(writer, account_id, false, now_ms).await;
                return AntigravityOutcome::identity_refused(account_id);
            };
            if commit_report(
                writer,
                account_id.to_string(),
                CacheReport::Success(snapshots),
            )
            .await
            {
                AntigravityOutcome::CacheCommitted {
                    account_id: account_id.to_string(),
                }
            } else {
                AntigravityOutcome::Failed {
                    account_id: account_id.to_string(),
                    reason: AntigravityFailure::Cache,
                }
            }
        }
        401 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            AntigravityOutcome::reopen(account_id)
        }
        403 | 404 | 410 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            AntigravityOutcome::fallback(account_id, AntigravityFailure::ProviderBlocked)
        }
        429 | 503 if response.status == 429 || response.retry_after_seconds.is_some() => {
            let retry_after_seconds = response.retry_after_seconds;
            let seconds = response
                .retry_after_seconds
                .unwrap_or(0)
                .max(RATE_LIMIT_BACKOFF_SECONDS)
                .min(BLOCKED_BACKOFF_SECONDS);
            runtime.postpone(account_id, now_ms, seconds);
            fallback_report(writer, account_id, false, now_ms).await;
            AntigravityOutcome::rate_limited(account_id, retry_after_seconds)
        }
        _ => AntigravityOutcome::Failed {
            account_id: account_id.to_string(),
            reason: AntigravityFailure::ProviderResponse,
        },
    }
}

fn credential_failure(account_id: &str, error: DetectedCredentialError) -> AntigravityOutcome {
    match error {
        DetectedCredentialError::Stale
        | DetectedCredentialError::NotFound
        | DetectedCredentialError::Unreadable => AntigravityOutcome::reopen(account_id),
    }
}

/// Write what the running client answered, or say it answered nothing usable.
async fn commit_local(
    writer: Arc<CacheWriter>,
    account_id: &str,
    body: &str,
    now_ms: u64,
) -> AntigravityOutcome {
    let Some(snapshots) = parse_body(ReaderId::AntigravityQuota, body, now_ms, account_id) else {
        fallback_report(writer, account_id, true, now_ms).await;
        return AntigravityOutcome::fallback(account_id, AntigravityFailure::Drift);
    };
    if commit_report(
        writer,
        account_id.to_string(),
        CacheReport::Success(snapshots),
    )
    .await
    {
        AntigravityOutcome::CacheCommitted {
            account_id: account_id.to_string(),
        }
    } else {
        AntigravityOutcome::Failed {
            account_id: account_id.to_string(),
            reason: AntigravityFailure::Cache,
        }
    }
}

/// Borrow the Gemini CLI reading for the shared pool, if there is one.
async fn mirror_shared(writer: Arc<CacheWriter>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        mirror_provider(
            &writer,
            "GEMINI_CLI",
            "ANTIGRAVITY",
            SHARED_CODE_ASSIST_ACCOUNT,
            SHARED_CODE_ASSIST_LABEL,
        )
    })
    .await
    .is_ok_and(|result| result.unwrap_or(false))
}

/// One account, in the order the evidence puts these sources in.
///
/// 1. The Antigravity client running on this machine, over loopback, which has
///    the answer cached and hands it to anybody who asks. No credential, no
///    identity, no network.
/// 2. Google's own endpoint with the credential Antigravity stored. It is
///    reached honestly, so it is expected to withhold the field the reading
///    needs, and that outcome buys a day of quiet rather than a retry loop.
/// 3. The Gemini CLI reading, mirrored, because both draw on one Code Assist
///    pool. Filed under its own account so nothing mistakes it for a login
///    somebody made to Antigravity.
///
/// When none of the three answers, the row says the one thing that fixes it.
/// This never starts Antigravity: a quota reading is not worth launching
/// another company's application behind somebody's back.
#[allow(clippy::too_many_arguments)]
pub async fn collect_account<P: AgyPorts, L: LoopbackProbe, T: Transport>(
    detection: &DetectionStore,
    runtime: &AntigravityOauthRuntime,
    ports: &P,
    probe: &L,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> AntigravityOutcome {
    if let Err(retry_ms) = runtime.begin(&account_id, now_ms) {
        return AntigravityOutcome::Cached {
            account_id,
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    /* The parser is the acceptance test, so a port answering with something
    this build cannot read is passed over and the next one is still tried. A
    body that does not parse is not data. */
    let accept =
        |body: &str| parse_body(ReaderId::AntigravityQuota, body, now_ms, &account_id).is_some();
    let outcome = match read_quota_summary(ports, probe, accept).await {
        LocalRead::Answered { body } => {
            commit_local(Arc::clone(&writer), &account_id, &body, now_ms).await
        }
        LocalRead::NoClient => {
            match detection.read_credential(DetectedProviderId::Antigravity, &account_id) {
                Ok(secret) => {
                    collect_with_secret(
                        runtime,
                        transport,
                        Arc::clone(&writer),
                        &account_id,
                        &secret,
                        now_ms,
                    )
                    .await
                }
                Err(error) => {
                    detection.mark_stale(DetectedProviderId::Antigravity, &account_id);
                    credential_failure(&account_id, error)
                }
            }
        }
    };
    /* The mirror is the last thing tried and only when nothing above wrote a
    row, so a machine with both logins does not pay for two readings of one
    pool. */
    let outcome = match outcome {
        AntigravityOutcome::CacheCommitted { .. } | AntigravityOutcome::Cached { .. } => outcome,
        other => {
            if mirror_shared(Arc::clone(&writer)).await {
                AntigravityOutcome::mirrored(SHARED_CODE_ASSIST_ACCOUNT)
            } else if matches!(other, AntigravityOutcome::ReopenCli { .. }) {
                /* No client running and no credential to fall back on is not a
                stale login, it is a client that is closed. */
                AntigravityOutcome::no_client(&account_id)
            } else {
                other
            }
        }
    };
    match &outcome {
        AntigravityOutcome::CacheCommitted { .. } | AntigravityOutcome::Mirrored { .. } => {
            detection.mark_ready(DetectedProviderId::Antigravity, &account_id)
        }
        AntigravityOutcome::ReopenCli { .. } => {
            detection.mark_stale(DetectedProviderId::Antigravity, &account_id)
        }
        AntigravityOutcome::Fallback { .. } | AntigravityOutcome::IdentityRefused { .. } => {
            detection.mark_fallback(DetectedProviderId::Antigravity, &account_id)
        }
        AntigravityOutcome::Cached { .. }
        | AntigravityOutcome::NoClient { .. }
        | AntigravityOutcome::Failed { .. } => {}
    }
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn collect_account_guarded<P: AgyPorts, L: LoopbackProbe, T: Transport>(
    detection: &DetectionStore,
    runtime: &AntigravityOauthRuntime,
    policy: &RequestPolicy,
    ports: &P,
    probe: &L,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> (AntigravityOutcome, bool) {
    let _lease = match policy.begin(DetectedProviderId::Antigravity, &account_id, now_ms) {
        Ok(lease) => lease,
        Err(GateRejection::Deferred { retry_at }) => {
            return (
                AntigravityOutcome::Cached {
                    account_id,
                    retry_at: iso_from_epoch_ms(retry_at)
                        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
                },
                false,
            )
        }
        Err(GateRejection::Busy | GateRejection::Unavailable) => {
            return (
                AntigravityOutcome::Failed {
                    account_id,
                    reason: AntigravityFailure::Protocol,
                },
                false,
            )
        }
    };
    let outcome = collect_account(
        detection,
        runtime,
        ports,
        probe,
        transport,
        writer,
        account_id.clone(),
        now_ms,
    )
    .await;
    let abort_provider = match &outcome {
        AntigravityOutcome::Fallback {
            reason: AntigravityFailure::ProviderBlocked,
            ..
        } => {
            policy.block_provider(
                DetectedProviderId::Antigravity,
                now_ms,
                BLOCKED_BACKOFF_SECONDS,
            );
            true
        }
        AntigravityOutcome::Fallback {
            reason: AntigravityFailure::RateLimited,
            retry_after_seconds,
            ..
        } => {
            policy.rate_limit_account(
                DetectedProviderId::Antigravity,
                &account_id,
                now_ms,
                *retry_after_seconds,
            );
            true
        }
        AntigravityOutcome::ReopenCli { .. } => {
            policy.complete_after(
                DetectedProviderId::Antigravity,
                &account_id,
                now_ms,
                BLOCKED_BACKOFF_SECONDS,
            );
            false
        }
        other => {
            policy.complete_after(
                DetectedProviderId::Antigravity,
                &account_id,
                now_ms,
                completion_backoff_seconds(other),
            );
            false
        }
    };
    (outcome, abort_provider)
}

/// How long the durable gate holds this account after an outcome.
///
/// The distinction this exists for: an answer that cannot change until we
/// change earns a day, and everything else is back in a quarter of an hour.
/// It used to be decided inline, and the identity refusal fell through to the
/// ordinary branch, so the day of quiet lived only in the in memory throttle
/// and died with the process. A machine restarted twice a day went back to
/// asking Google a question whose answer was already known.
fn completion_backoff_seconds(outcome: &AntigravityOutcome) -> u64 {
    match outcome {
        AntigravityOutcome::ReopenCli { .. } | AntigravityOutcome::IdentityRefused { .. } => {
            BLOCKED_BACKOFF_SECONDS
        }
        _ => REFRESH_SECONDS,
    }
}

fn uncovered_account_ids(
    detected_account_ids: Vec<String>,
    covered: &HashSet<PollIdentity>,
) -> Vec<String> {
    /* The vendor vault exposes one current Antigravity login, with no stable
    provider account id beside the rotating access token. If any saved
    Antigravity connection exists, fail closed to that one path instead of
    risking a second request from the automatic path after token rotation. */
    if covered
        .iter()
        .any(|identity| identity.provider_id() == ProviderId::Antigravity)
    {
        return Vec::new();
    }
    detected_account_ids
        .into_iter()
        .filter(|account_id| {
            !covered.contains(&PollIdentity::detected(
                ProviderId::Antigravity,
                account_id.clone(),
            ))
        })
        .collect()
}

pub async fn run_pass(
    app: &AppHandle,
    covered: &HashSet<PollIdentity>,
    automatic_account_limit: usize,
) {
    let detected_account_ids = app
        .state::<DetectionStore>()
        .account_ids(DetectedProviderId::Antigravity);
    let mut account_ids = uncovered_account_ids(detected_account_ids, covered);
    /* The reading no longer needs a credential, so a machine where detection
    found no Antigravity login still has a pass to run: the client may be open
    right now, and a Gemini login may be there to mirror. The singleton
    identifier is the same one the credential only path uses, so the local read
    and a later login file their rows under one account rather than two. */
    if account_ids.is_empty()
        && !covered
            .iter()
            .any(|identity| identity.provider_id() == ProviderId::Antigravity)
    {
        account_ids.push(provider_singleton_account_id(
            DetectedProviderId::Antigravity,
        ));
    }
    account_ids.truncate(automatic_account_limit);
    let ports = SystemAgyPorts;
    let probe = SystemLoopbackProbe::new();
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<AntigravityOauthRuntime>();
        let policy = app.state::<RequestPolicy>();
        let transport = app.state::<ReqwestTransport>();
        let writer = app.state::<Arc<CacheWriter>>();
        let (_, abort_provider) = collect_account_guarded(
            &detection,
            &runtime,
            &policy,
            &ports,
            &probe,
            &*transport,
            Arc::clone(&writer),
            account_id,
            crate::connections::now_epoch_ms(),
        )
        .await;
        if abort_provider {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::cache_write::CACHE_FILE_NAME;
    use crate::net::{HttpMethod, ANTIGRAVITY_QUOTA_BODY, ANTIGRAVITY_QUOTA_URL};
    use crate::test_support::{RecordingTransport, TempDir};
    use zeroize::Zeroizing;

    const NOW: u64 = 1_787_136_000_000;
    const TOKEN: &str = "antigravity-access-token-for-tests-only";
    const ACCOUNT: &str = "antigravity-test-account";

    #[test]
    fn a_connected_account_has_only_one_collection_path_per_cadence() {
        let covered = HashSet::from([PollIdentity::detected(
            ProviderId::Antigravity,
            ACCOUNT.to_string(),
        )]);
        let automatic = uncovered_account_ids(vec![ACCOUNT.to_string()], &covered);

        assert!(automatic.is_empty());
    }

    #[test]
    fn a_rotated_vault_token_still_cannot_create_a_second_path() {
        let covered = HashSet::from([PollIdentity::detected(
            ProviderId::Antigravity,
            "credential-bound-old-token".to_string(),
        )]);
        let automatic = uncovered_account_ids(vec![ACCOUNT.to_string()], &covered);

        assert!(automatic.is_empty());
    }

    fn valid_body() -> Vec<u8> {
        br#"{
            "groups":[{
                "buckets":[
                    {"bucketId":"gemini-primary","remainingFraction":0.72,"window":"5h","resetTime":"2026-08-19T15:00:00Z"},
                    {"bucketId":"gemini-weekly","remainingFraction":0.44,"window":"weekly","resetTime":"2026-08-24T12:00:00Z"}
                ]
            }]
        }"#
        .to_vec()
    }

    fn secret(revision: &str) -> DetectedSecret {
        DetectedSecret {
            access_token: Zeroizing::new(TOKEN.to_string()),
            provider_account_id: None,
            credential_revision: revision.to_string(),
        }
    }

    fn writer(dir: &TempDir) -> Arc<CacheWriter> {
        Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())))
    }

    fn quota_transport(body: Vec<u8>) -> RecordingTransport {
        RecordingTransport::replying(200, body, None)
    }

    /// A scrubbed capture of what the running client answers.
    ///
    /// Two pools, four buckets, and not one identity anywhere in it: the route
    /// carries no account, no token and no email, which is part of why it can
    /// be read at all. The reset times are stated relative to the fixture
    /// clock so the parser's future horizon check is exercised rather than
    /// dodged.
    fn local_summary() -> String {
        let session = iso_from_epoch_ms(NOW + 4 * 3_600_000).expect("session reset");
        let weekly = iso_from_epoch_ms(NOW + 5 * 86_400_000).expect("weekly reset");
        format!(
            r#"{{"groups":[{{"displayName":"Gemini Models","buckets":[{{"bucketId":"gemini-5h","displayName":"5 hour","window":"5h","remainingFraction":0.62,"resetTime":"{session}"}},{{"bucketId":"gemini-weekly","displayName":"Weekly","window":"weekly","remainingFraction":0.31,"resetTime":"{weekly}"}}]}},{{"displayName":"Claude and GPT models","buckets":[{{"bucketId":"3p-5h","displayName":"5 hour","window":"5h","remainingFraction":0.9,"resetTime":"{session}"}},{{"bucketId":"3p-weekly","displayName":"Weekly","window":"weekly","remainingFraction":0.5,"resetTime":"{weekly}"}}]}}]}}"#
        )
    }

    #[derive(Clone)]
    struct StubPorts(Vec<u16>);

    impl AgyPorts for StubPorts {
        fn listening(&self) -> Vec<u16> {
            self.0.clone()
        }
    }

    struct StubProbe {
        answering: Option<(u16, String)>,
        asked: Mutex<Vec<u16>>,
    }

    impl StubProbe {
        fn answering(port: u16, body: String) -> Self {
            Self {
                answering: Some((port, body)),
                asked: Mutex::new(Vec::new()),
            }
        }

        fn silent() -> Self {
            Self {
                answering: None,
                asked: Mutex::new(Vec::new()),
            }
        }

        fn asked(&self) -> Vec<u16> {
            self.asked.lock().expect("asked").clone()
        }
    }

    impl LoopbackProbe for StubProbe {
        async fn quota_summary(&self, port: u16) -> Option<String> {
            if let Ok(mut asked) = self.asked.lock() {
                asked.push(port);
            }
            self.answering
                .as_ref()
                .filter(|(answering, _)| *answering == port)
                .map(|(_, body)| body.clone())
        }
    }

    #[tokio::test]
    async fn automatic_read_uses_the_observed_endpoint_method_and_body() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let transport = quota_transport(valid_body());
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("one"),
            NOW,
        )
        .await;
        assert!(matches!(outcome, AntigravityOutcome::CacheCommitted { .. }));
        assert_eq!(transport.recorded_urls(), vec![ANTIGRAVITY_QUOTA_URL]);
        assert_eq!(transport.recorded_methods(), vec![HttpMethod::Post]);
        assert_eq!(
            transport.recorded_auths(),
            vec![AuthApplication::AntigravitySessionBearer]
        );
        assert_eq!(
            transport.recorded_bodies(),
            vec![Some(ANTIGRAVITY_QUOTA_BODY.to_string())]
        );
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("ANTIGRAVITY"));
        assert!(!cache.contains(TOKEN));
    }

    /// A running client, its own summary, and a bar without a credential.
    ///
    /// The whole point of the local read: the account has no Antigravity login
    /// stored at all, and the row still fills, because the client on this
    /// machine already has the answer. Nothing is sent anywhere.
    #[tokio::test]
    async fn the_running_client_fills_the_row_and_no_request_leaves_the_machine() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        let transport = quota_transport(valid_body());
        let outcome = collect_account(
            &detection,
            &runtime,
            &StubPorts(vec![52123]),
            &StubProbe::answering(52123, local_summary()),
            &transport,
            writer(&dir),
            ACCOUNT.to_string(),
            NOW,
        )
        .await;

        assert!(matches!(outcome, AntigravityOutcome::CacheCommitted { .. }));
        assert!(transport.recorded_urls().is_empty());
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        /* Both pools, because the client shows a person both. */
        for meter in [
            "FIVE_HOUR",
            "SEVEN_DAY",
            "THIRD_PARTY_SESSION",
            "THIRD_PARTY_WEEKLY",
        ] {
            assert!(cache.contains(meter), "{meter} was not written");
        }
        assert!(cache.contains("\"writer\":\"desktop\""));
    }

    /// The cadence gate is one per account per pass, wherever the reading
    /// came from. A rotated credential is still the same account.
    #[tokio::test]
    async fn a_second_pass_inside_the_cadence_reads_nothing_at_all() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        let transport = quota_transport(valid_body());
        let ports = StubPorts(vec![52123]);
        let probe = StubProbe::answering(52123, local_summary());
        let _ = collect_account(
            &detection,
            &runtime,
            &ports,
            &probe,
            &transport,
            writer(&dir),
            ACCOUNT.to_string(),
            NOW,
        )
        .await;
        let second = collect_account(
            &detection,
            &runtime,
            &ports,
            &probe,
            &transport,
            writer(&dir),
            ACCOUNT.to_string(),
            NOW + 1_000,
        )
        .await;

        assert!(matches!(second, AntigravityOutcome::Cached { .. }));
        assert_eq!(probe.asked(), vec![52123]);
    }

    /// No client, no credential, no Gemini login: one sentence, no invention.
    #[tokio::test]
    async fn a_closed_client_says_so_and_never_writes_a_number() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        let transport = quota_transport(valid_body());
        let outcome = collect_account(
            &detection,
            &runtime,
            &StubPorts(Vec::new()),
            &StubProbe::silent(),
            &transport,
            writer(&dir),
            ACCOUNT.to_string(),
            NOW,
        )
        .await;

        let AntigravityOutcome::NoClient { message, .. } = outcome else {
            panic!("a closed client is its own outcome");
        };
        assert_eq!(message, crate::antigravity_local::NO_CLIENT_SENTENCE);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).unwrap_or_default();
        assert!(!cache.contains("\"value\":0"));
    }

    /// A body this build cannot read is no answer, and never data.
    ///
    /// It used to be drift, which is the wrong word for it and had a real
    /// cost: a suppression written from an unreadable body is this build
    /// deciding that something it could not read was a reading. Nothing on
    /// loopback proved it came from Antigravity at all, so the honest answer
    /// is the same one a closed client gets. The remaining ports are still
    /// tried first, which is the other half of the fix.
    #[tokio::test]
    async fn an_unreadable_local_answer_is_no_answer_and_never_a_reading() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        let transport = quota_transport(valid_body());
        let probe = StubProbe::answering(52123, r#"{"groups":[]}"#.to_string());
        let outcome = collect_account(
            &detection,
            &runtime,
            &StubPorts(vec![52123, 52124]),
            &probe,
            &transport,
            writer(&dir),
            ACCOUNT.to_string(),
            NOW,
        )
        .await;

        let AntigravityOutcome::NoClient { message, .. } = outcome else {
            panic!("an unreadable body is no answer");
        };
        assert_eq!(message, crate::antigravity_local::NO_CLIENT_SENTENCE);
        /* The second port was still tried after the first said nothing
        readable. */
        assert_eq!(probe.asked(), vec![52123, 52124]);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).unwrap_or_default();
        assert!(!cache.contains("\"value\":0"));
        assert!(!cache.contains("drift"));
    }

    /// The port that answers second still fills the row.
    #[tokio::test]
    async fn a_readable_answer_on_a_later_port_still_fills_the_row() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        let probe = StubProbe::answering(52124, local_summary());
        let outcome = collect_account(
            &detection,
            &runtime,
            &StubPorts(vec![52123, 52124]),
            &probe,
            &quota_transport(valid_body()),
            writer(&dir),
            ACCOUNT.to_string(),
            NOW,
        )
        .await;

        assert!(matches!(outcome, AntigravityOutcome::CacheCommitted { .. }));
        assert_eq!(probe.asked(), vec![52123, 52124]);
    }

    /// Google answering correctly, to somebody else, is its own outcome.
    ///
    /// A 200 with the companion project withheld used to be drift, which had
    /// this build retry it every cadence against an answer that cannot change.
    /// It now waits a day and the row states the fact.
    #[tokio::test]
    async fn a_withheld_field_is_identity_refused_and_buys_a_day_of_quiet() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let transport = quota_transport(
            br#"{"allowedTiers":[{"id":"free-tier","isDefault":true}],"ineligibleTiers":[]}"#
                .to_vec(),
        );
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("identity"),
            NOW,
        )
        .await;

        let AntigravityOutcome::IdentityRefused { message, .. } = outcome else {
            panic!("a withheld field is not drift");
        };
        assert_eq!(message, IDENTITY_REFUSED_SENTENCE);
        /* A whole day, so ninety six requests a day become one. */
        let next = runtime
            .next_allowed
            .lock()
            .expect("throttle")
            .get(ACCOUNT)
            .copied()
            .expect("a postponement");
        assert_eq!(next, NOW + BLOCKED_BACKOFF_SECONDS * 1_000);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).unwrap_or_default();
        assert!(!cache.contains("\"value\":0"));
    }

    /// The Gemini reading is borrowed only when nothing else answered, and it
    /// is filed under an account of its own so nothing mistakes it for a login
    /// somebody made to Antigravity.
    #[tokio::test]
    async fn the_shared_gemini_reading_is_mirrored_under_its_own_account() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        let cache_writer = writer(&dir);
        let gemini = parse_body(
            ReaderId::AntigravityQuota,
            &local_summary(),
            NOW,
            "gemini-account",
        )
        .expect("readable summary")
        .into_iter()
        .map(|row| crate::native_snapshot::Snapshot {
            provider: "GEMINI_CLI".to_string(),
            ..row
        })
        .collect();
        write_report(
            &cache_writer,
            "GEMINI_CLI",
            Some("gemini-account"),
            CacheReport::Success(gemini),
        )
        .expect("gemini rows");

        let outcome = collect_account(
            &detection,
            &runtime,
            &StubPorts(Vec::new()),
            &StubProbe::silent(),
            &quota_transport(valid_body()),
            Arc::clone(&cache_writer),
            ACCOUNT.to_string(),
            NOW,
        )
        .await;

        let AntigravityOutcome::Mirrored { account_id, message } = outcome else {
            panic!("a borrowed reading is its own outcome");
        };
        assert_eq!(account_id, SHARED_CODE_ASSIST_ACCOUNT);
        assert_eq!(message, MIRROR_SENTENCE);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains(SHARED_CODE_ASSIST_ACCOUNT));
        assert!(cache.contains(SHARED_CODE_ASSIST_LABEL));
        /* The Gemini rows it was borrowed from are untouched. */
        assert!(cache.contains("GEMINI_CLI"));
    }

    /// The outcome that earns a day of quiet is named, not assumed.
    #[test]
    fn identity_refused_earns_the_same_day_of_quiet_a_dead_login_does() {
        assert_eq!(
            completion_backoff_seconds(&AntigravityOutcome::identity_refused(ACCOUNT)),
            BLOCKED_BACKOFF_SECONDS
        );
        assert_eq!(
            completion_backoff_seconds(&AntigravityOutcome::reopen(ACCOUNT)),
            BLOCKED_BACKOFF_SECONDS
        );
        /* Everything else is back in a quarter of an hour. */
        for ordinary in [
            AntigravityOutcome::no_client(ACCOUNT),
            AntigravityOutcome::mirrored(ACCOUNT),
            AntigravityOutcome::CacheCommitted {
                account_id: ACCOUNT.to_string(),
            },
        ] {
            assert_eq!(completion_backoff_seconds(&ordinary), REFRESH_SECONDS);
        }
    }

    /// The day of quiet outlives the process that earned it.
    ///
    /// The in memory throttle held it and died with the process, so a machine
    /// restarted twice a day went back to asking Google a question whose
    /// answer cannot change until we change. A second policy reading the same
    /// directory is what a restart looks like.
    #[test]
    fn the_day_of_quiet_survives_a_restart() {
        let dir = TempDir::new();
        let policy = RequestPolicy::at(Some(dir.path().to_path_buf()));
        {
            /* The durable gate is only writable while this pass holds its
            lease, which is exactly how the collector calls it. */
            let _lease = policy
                .begin(DetectedProviderId::Antigravity, ACCOUNT, NOW)
                .expect("a first pass");
            policy.complete_after(
                DetectedProviderId::Antigravity,
                ACCOUNT,
                NOW,
                completion_backoff_seconds(&AntigravityOutcome::identity_refused(ACCOUNT)),
            );
        }

        let restarted = RequestPolicy::at(Some(dir.path().to_path_buf()));
        let a_quarter_hour_later = NOW + (REFRESH_SECONDS + 60) * 1_000;
        assert!(
            matches!(
                restarted.begin(DetectedProviderId::Antigravity, ACCOUNT, a_quarter_hour_later),
                Err(GateRejection::Deferred { .. })
            ),
            "the day of quiet did not survive the restart"
        );

        /* And it does end. A backoff that never lifts is a provider this build
        stopped reading and never told anybody about. */
        let a_day_and_a_bit_later = NOW + (BLOCKED_BACKOFF_SECONDS * 2) * 1_000;
        assert!(RequestPolicy::at(Some(dir.path().to_path_buf()))
            .begin(
                DetectedProviderId::Antigravity,
                ACCOUNT,
                a_day_and_a_bit_later
            )
            .is_ok());
    }

    /// Neither sentence a person reads may carry a dash of any kind.
    #[test]
    fn the_row_sentences_are_written_the_way_this_product_writes() {
        for sentence in [
            IDENTITY_REFUSED_SENTENCE,
            MIRROR_SENTENCE,
            SHARED_CODE_ASSIST_LABEL,
            crate::antigravity_local::NO_CLIENT_SENTENCE,
        ] {
            assert!(!sentence.contains('-'), "{sentence} carries a dash");
            assert!(!sentence.contains('\u{2013}'));
            assert!(!sentence.contains('\u{2014}'));
        }
    }

    #[tokio::test]
    async fn expired_session_names_the_only_recovery_without_leaking_the_token() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let transport = RecordingTransport::replying(401, Vec::new(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("stale"),
            NOW,
        )
        .await;
        let wire = serde_json::to_string(&outcome).expect("wire");
        assert!(wire.contains("reopen_cli"));
        assert!(wire.contains("Reopen Antigravity to refresh this login."));
        assert!(!wire.contains(TOKEN));
    }

    #[tokio::test]
    async fn service_retry_after_reaches_the_shared_policy_boundary() {
        let dir = TempDir::new();
        let outcome = collect_with_secret(
            &AntigravityOauthRuntime::default(),
            &RecordingTransport::replying(503, Vec::new(), Some(7_200)),
            writer(&dir),
            ACCOUNT,
            &secret("service-backoff"),
            NOW,
        )
        .await;
        assert!(matches!(
            outcome,
            AntigravityOutcome::Fallback {
                reason: AntigravityFailure::RateLimited,
                retry_after_seconds: Some(7_200),
                ..
            }
        ));
    }
}
