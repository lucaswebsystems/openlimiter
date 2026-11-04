//! One automatic read for the tools whose saved sign in is a single bearer
//! token: Hermes (Nous Portal), Command Code, Cline and Kilo Code. Each pass
//! takes the login the tool saved on this computer (`tool_logins`), asks that
//! tool's one address and caches the reply.
//!
//! The orchestration is shared; the destination is not. `login_route` is an
//! exhaustive match with no wildcard arm, and it names only who a login
//! belongs to. The address and the way the token is written come from
//! `reader_route` alone, so a token can reach its own issuer and nothing else,
//! and adding a tool fails the build until its pairing is decided in review.
//!
//! A sign in is never refreshed here and the tool is never run. A rejected one
//! (401) marks the account stale with the tool's own reopen sentence; a refusal
//! (403) backs off a day and is shown, never retried around; 429 and a 503 that
//! names a wait follow the shared request policy.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cache_write::CacheWriter;
use crate::native_readers::parse_body;
use crate::native_snapshot::{iso_from_epoch_ms, write_report, CacheReport};
use crate::net::{fetch_endpoint, NetError, ReqwestTransport, Transport};
use crate::poll_identity::PollIdentity;
use crate::provider_detection::{
    reopen_message, DetectedCredentialError, DetectedProviderId, DetectedSecret, DetectionStore,
};
use crate::reader_registry::{reader_route, CredentialKind, ProviderId};
use crate::request_policy::{GateRejection, RequestPolicy};

pub const REFRESH_SECONDS: u64 = 300;
const BLOCKED_BACKOFF_SECONDS: u64 = 86_400;
const MAX_THROTTLE_ENTRIES: usize = 128;

/// The tools this module reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LoginProvider {
    Hermes,
    Commandcode,
    Cline,
    Kilocode,
}

impl LoginProvider {
    pub const ALL: [Self; 4] = [Self::Hermes, Self::Commandcode, Self::Cline, Self::Kilocode];
}

/// Who a saved login belongs to, in every vocabulary that names it. There is
/// no address and no header here: those are `reader_route`'s alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoginRoute {
    pub detected: DetectedProviderId,
    pub provider: ProviderId,
    pub credential: CredentialKind,
}

/// The one pairing per tool, exhaustive and without a wildcard arm.
pub const fn login_route(provider: LoginProvider) -> LoginRoute {
    match provider {
        LoginProvider::Hermes => LoginRoute {
            detected: DetectedProviderId::Hermes,
            provider: ProviderId::Hermes,
            credential: CredentialKind::HermesSession,
        },
        LoginProvider::Commandcode => LoginRoute {
            detected: DetectedProviderId::Commandcode,
            provider: ProviderId::Commandcode,
            credential: CredentialKind::CommandcodeApiKey,
        },
        LoginProvider::Cline => LoginRoute {
            detected: DetectedProviderId::Cline,
            provider: ProviderId::Cline,
            credential: CredentialKind::ClineSession,
        },
        LoginProvider::Kilocode => LoginRoute {
            detected: DetectedProviderId::Kilocode,
            provider: ProviderId::Kilocode,
            credential: CredentialKind::KilocodeSession,
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginFailure {
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
pub enum LoginOutcome {
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
    Fallback {
        account_id: String,
        reason: LoginFailure,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after_seconds: Option<u64>,
    },
    Failed {
        account_id: String,
        reason: LoginFailure,
    },
}

impl LoginOutcome {
    fn reopen(provider: LoginProvider, account_id: &str) -> Self {
        Self::ReopenCli {
            account_id: account_id.to_string(),
            message: reopen_message(login_route(provider).detected),
        }
    }

    fn fallback(account_id: &str, reason: LoginFailure, retry_after_seconds: Option<u64>) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason,
            retry_after_seconds,
        }
    }

    fn failed(account_id: &str, reason: LoginFailure) -> Self {
        Self::Failed {
            account_id: account_id.to_string(),
            reason,
        }
    }
}

#[derive(Default)]
pub struct ToolLoginRuntime {
    next_allowed: Mutex<BTreeMap<(LoginProvider, String), u64>>,
}

impl ToolLoginRuntime {
    fn begin(&self, provider: LoginProvider, account_id: &str, now_ms: u64) -> Result<(), u64> {
        let mut entries = self.next_allowed.lock().map_err(|_| now_ms)?;
        let key = (provider, account_id.to_string());
        if let Some(next) = entries.get(&key).copied() {
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
        entries.insert(key, now_ms.saturating_add(REFRESH_SECONDS.saturating_mul(1_000)));
        Ok(())
    }

    fn postpone(&self, provider: LoginProvider, account_id: &str, now_ms: u64, seconds: u64) {
        if let Ok(mut entries) = self.next_allowed.lock() {
            entries.insert(
                (provider, account_id.to_string()),
                now_ms.saturating_add(seconds.saturating_mul(1_000)),
            );
        }
    }
}

fn net_failure(error: NetError) -> LoginFailure {
    match error {
        NetError::Timeout => LoginFailure::Timeout,
        NetError::Connect => LoginFailure::Connect,
        NetError::Tls => LoginFailure::Tls,
        NetError::TooLarge => LoginFailure::TooLarge,
        NetError::Protocol => LoginFailure::Protocol,
    }
}

async fn commit_report(
    writer: Arc<CacheWriter>,
    provider: LoginProvider,
    account_id: String,
    report: CacheReport,
) -> bool {
    let code = login_route(provider).provider.code();
    tauri::async_runtime::spawn_blocking(move || write_report(&writer, code, Some(&account_id), report))
        .await
        .is_ok_and(|result| result.is_ok())
}

async fn fallback_report(
    writer: Arc<CacheWriter>,
    provider: LoginProvider,
    account_id: &str,
    drift: bool,
    now_ms: u64,
) {
    let report = if drift {
        CacheReport::Drift {
            observed_at: iso_from_epoch_ms(now_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        }
    } else {
        CacheReport::Unavailable
    };
    let _ = commit_report(writer, provider, account_id.to_string(), report).await;
}

async fn collect_with_secret<T: Transport>(
    provider: LoginProvider,
    runtime: &ToolLoginRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: &str,
    secret: &DetectedSecret,
    now_ms: u64,
) -> LoginOutcome {
    let identity = login_route(provider);
    let Ok(route) = reader_route(identity.provider, identity.credential) else {
        return LoginOutcome::failed(account_id, LoginFailure::Protocol);
    };
    let Some(endpoint) = route.endpoint else {
        return LoginOutcome::failed(account_id, LoginFailure::Protocol);
    };
    if let Err(retry_ms) = runtime.begin(provider, account_id, now_ms) {
        return LoginOutcome::Cached {
            account_id: account_id.to_string(),
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    let response = match fetch_endpoint(transport, endpoint, route.auth, &secret.access_token, None).await {
        Ok(response) => response,
        Err(error) => return LoginOutcome::failed(account_id, net_failure(error)),
    };
    match response.status {
        200..=299 => {
            let snapshots = response
                .body
                .as_deref()
                .and_then(|body| parse_body(route.reader_id, body, now_ms, account_id));
            let Some(snapshots) = snapshots else {
                fallback_report(writer, provider, account_id, true, now_ms).await;
                return LoginOutcome::fallback(account_id, LoginFailure::Drift, None);
            };
            if commit_report(writer, provider, account_id.to_string(), CacheReport::Success(snapshots)).await {
                LoginOutcome::CacheCommitted {
                    account_id: account_id.to_string(),
                }
            } else {
                LoginOutcome::failed(account_id, LoginFailure::Cache)
            }
        }
        401 => {
            runtime.postpone(provider, account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, provider, account_id, false, now_ms).await;
            LoginOutcome::reopen(provider, account_id)
        }
        403 | 404 | 410 => {
            runtime.postpone(provider, account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, provider, account_id, false, now_ms).await;
            LoginOutcome::fallback(account_id, LoginFailure::ProviderBlocked, None)
        }
        429 | 503 if response.status == 429 || response.retry_after_seconds.is_some() => {
            runtime.postpone(provider, account_id, now_ms, 0);
            fallback_report(writer, provider, account_id, false, now_ms).await;
            LoginOutcome::fallback(account_id, LoginFailure::RateLimited, response.retry_after_seconds)
        }
        _ => LoginOutcome::failed(account_id, LoginFailure::ProviderResponse),
    }
}

pub async fn collect_account<T: Transport>(
    provider: LoginProvider,
    detection: &DetectionStore,
    runtime: &ToolLoginRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> LoginOutcome {
    let detected = login_route(provider).detected;
    let secret = match detection.read_credential(detected, &account_id) {
        Ok(secret) => secret,
        Err(DetectedCredentialError::NotFound | DetectedCredentialError::Stale | DetectedCredentialError::Unreadable) => {
            detection.mark_stale(detected, &account_id);
            return LoginOutcome::reopen(provider, &account_id);
        }
    };
    let outcome = collect_with_secret(provider, runtime, transport, writer, &account_id, &secret, now_ms).await;
    match &outcome {
        LoginOutcome::CacheCommitted { .. } => detection.mark_ready(detected, &account_id),
        LoginOutcome::ReopenCli { .. } => detection.mark_stale(detected, &account_id),
        LoginOutcome::Fallback { .. } => detection.mark_fallback(detected, &account_id),
        LoginOutcome::Cached { .. } | LoginOutcome::Failed { .. } => {}
    }
    outcome
}

async fn collect_account_guarded<T: Transport>(
    provider: LoginProvider,
    detection: &DetectionStore,
    runtime: &ToolLoginRuntime,
    policy: &RequestPolicy,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> (LoginOutcome, bool) {
    let detected = login_route(provider).detected;
    let revision = detection
        .read_credential(detected, &account_id)
        .map(|secret| secret.credential_revision)
        .unwrap_or_else(|_| "unavailable".to_string());
    let _lease = match policy.begin_with_revision(detected, &account_id, now_ms, Some(&revision)) {
        Ok(lease) => lease,
        Err(GateRejection::Deferred { retry_at }) => {
            return (
                LoginOutcome::Cached {
                    account_id,
                    retry_at: iso_from_epoch_ms(retry_at)
                        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
                },
                false,
            )
        }
        Err(GateRejection::Busy | GateRejection::Unavailable) => {
            return (LoginOutcome::failed(&account_id, LoginFailure::Protocol), false)
        }
    };
    // The durable gate owns retry timing, including after a process restart.
    runtime.postpone(provider, &account_id, now_ms, 0);
    let outcome = collect_account(provider, detection, runtime, transport, writer, account_id.clone(), now_ms).await;
    let abort_provider = complete_outcome(detected, policy, &account_id, now_ms, &outcome);
    (outcome, abort_provider)
}

fn complete_outcome(
    detected: DetectedProviderId,
    policy: &RequestPolicy,
    account_id: &str,
    now_ms: u64,
    outcome: &LoginOutcome,
) -> bool {
    match outcome {
        LoginOutcome::Cached { .. } => false,
        LoginOutcome::Failed { .. } => {
            policy.retry_account(detected, account_id, now_ms, None, false);
            false
        }
        LoginOutcome::Fallback {
            reason: LoginFailure::ProviderBlocked,
            ..
        } => {
            policy.refuse_account(detected, account_id, now_ms, true);
            true
        }
        LoginOutcome::Fallback {
            reason: LoginFailure::RateLimited,
            retry_after_seconds,
            ..
        } => {
            policy.rate_limit_account(detected, account_id, now_ms, *retry_after_seconds);
            true
        }
        LoginOutcome::ReopenCli { .. } => {
            policy.refuse_account(detected, account_id, now_ms, false);
            false
        }
        LoginOutcome::CacheCommitted { .. } | LoginOutcome::Fallback { .. } => {
            policy.complete_after(detected, account_id, now_ms, REFRESH_SECONDS);
            false
        }
    }
}

fn uncovered_account_ids(
    provider: LoginProvider,
    detected_account_ids: Vec<String>,
    covered: &HashSet<PollIdentity>,
) -> Vec<String> {
    let provider_id = login_route(provider).provider;
    detected_account_ids
        .into_iter()
        .filter(|account_id| !covered.contains(&PollIdentity::detected(provider_id, account_id.clone())))
        .collect()
}

fn pass_read_succeeded(outcome: &LoginOutcome) -> bool {
    matches!(outcome, LoginOutcome::CacheCommitted { .. } | LoginOutcome::Cached { .. })
}

pub async fn run_pass(
    app: &AppHandle,
    provider: LoginProvider,
    covered: &HashSet<PollIdentity>,
    automatic_account_limit: usize,
) -> bool {
    let detected = login_route(provider).detected;
    let mut account_ids = uncovered_account_ids(
        provider,
        app.state::<DetectionStore>().account_ids(detected),
        covered,
    );
    account_ids.truncate(automatic_account_limit);
    let mut succeeded = true;
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<ToolLoginRuntime>();
        let policy = app.state::<RequestPolicy>();
        let transport = app.state::<ReqwestTransport>();
        let writer = app.state::<Arc<CacheWriter>>();
        let (outcome, abort_provider) = collect_account_guarded(
            provider,
            &detection,
            &runtime,
            &policy,
            &*transport,
            Arc::clone(&writer),
            account_id,
            crate::connections::now_epoch_ms(),
        )
        .await;
        succeeded &= pass_read_succeeded(&outcome);
        if abort_provider {
            break;
        }
    }
    succeeded
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::cache_write::CACHE_FILE_NAME;
    use crate::native_snapshot::epoch_ms_from_rfc3339;
    use crate::net::{
        ProviderEndpoint, CLINE_USAGE_URL, COMMANDCODE_CREDITS_URL,
        HERMES_ACCOUNT_URL, KILOCODE_BALANCE_URL,
    };
    use crate::reader_registry::AuthApplication;
    use crate::test_support::{RecordingTransport, TempDir};
    use zeroize::Zeroizing;

    const NOW_TEXT: &str = "2026-08-07T12:00:00.000Z";

    fn now() -> u64 {
        epoch_ms_from_rfc3339(NOW_TEXT).expect("fixture clock")
    }

    fn url(provider: LoginProvider) -> &'static str {
        match provider {
            LoginProvider::Hermes => HERMES_ACCOUNT_URL,
            LoginProvider::Commandcode => COMMANDCODE_CREDITS_URL,
            LoginProvider::Cline => CLINE_USAGE_URL,
            LoginProvider::Kilocode => KILOCODE_BALANCE_URL,
        }
    }

    /// A reply each tool's own source types describe, synthetic throughout.
    fn reply(provider: LoginProvider) -> &'static str {
        match provider {
            LoginProvider::Hermes => {
                r#"{"subscription":{"plan":"Plus","monthly_credits":20,"credits_remaining":14,"current_period_end":"2026-08-30T00:00:00+00:00"},"paid_service_access":{"allowed":true,"purchased_credits_remaining":7.5}}"#
            }
            LoginProvider::Commandcode => {
                r#"{"credits":{"monthlyCredits":12.5,"purchasedCredits":2,"freeCredits":0.5,"planId":"individual-pro"},"windowLimits":{"fiveHour":{"used":3,"cap":12,"resetAt":1786114800000},"weekly":{"used":30,"cap":60,"resetAt":1786406400000}}}"#
            }
            LoginProvider::Cline => {
                r#"{"success":true,"data":{"limits":[{"type":"five_hour","percentUsed":12,"resetsAt":"2026-08-07T15:00:00.000Z"},{"type":"weekly","percentUsed":40,"resetsAt":"2026-08-10T00:00:00.000Z"},{"type":"monthly","percentUsed":20,"resetsAt":"2026-08-30T00:00:00.000Z"}]}}"#
            }
            LoginProvider::Kilocode => r#"{"balance":18.25}"#,
        }
    }

    /// Where `DetectionStore::for_test_home` looks for each tool's login.
    fn login_file(provider: LoginProvider, home: &Path) -> PathBuf {
        match provider {
            LoginProvider::Hermes => home.join(".hermes").join("auth.json"),
            LoginProvider::Commandcode => home.join(".commandcode").join("auth.json"),
            LoginProvider::Cline => home.join(".cline/data/settings/providers.json"),
            LoginProvider::Kilocode => home.join(".local/share/kilo/auth.json"),
        }
    }

    fn login_text(provider: LoginProvider, token: &str, expires: &str) -> String {
        match provider {
            LoginProvider::Hermes => format!(
                r#"{{"providers":{{"nous":{{"access_token":"{token}","refresh_token":"never-sent","expires_at":"{expires}"}}}}}}"#
            ),
            LoginProvider::Commandcode => format!(r#"{{"apiKey":"{token}","userId":"user-1"}}"#),
            LoginProvider::Cline => format!(
                r#"{{"providers":{{"cline":{{"settings":{{"auth":{{"accessToken":"workos:{token}"}}}}}}}}}}"#
            ),
            LoginProvider::Kilocode => format!(
                r#"{{"kilo":{{"type":"oauth","access":"{token}","refresh":"{token}","expires":{}}}}}"#,
                epoch_ms_from_rfc3339(expires).unwrap()
            ),
        }
    }

    fn sent_token(provider: LoginProvider, token: &str) -> String {
        if provider == LoginProvider::Cline {
            format!("workos:{token}")
        } else {
            token.to_string()
        }
    }

    fn write_login(provider: LoginProvider, home: &Path, token: &str, expires: &str) {
        let path = login_file(provider, home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, login_text(provider, token, expires)).unwrap();
    }

    fn writer(dir: &TempDir) -> Arc<CacheWriter> {
        Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())))
    }

    fn secret(token: &str) -> DetectedSecret {
        DetectedSecret {
            access_token: Zeroizing::new(token.to_string()),
            provider_account_id: None,
            credential_revision: "one".to_string(),
        }
    }

    #[test]
    fn each_login_is_paired_with_its_own_route_and_every_other_pairing_is_refused() {
        let mut endpoints = Vec::new();
        for provider in LoginProvider::ALL {
            let identity = login_route(provider);
            assert_eq!(identity.credential.provider(), identity.provider);
            assert_eq!(crate::poll_identity::detected_provider(identity.provider), identity.detected);
            let route = reader_route(identity.provider, identity.credential).expect("own route");
            assert_eq!(route.reader_id.provider(), identity.provider);
            assert_eq!(route.auth, AuthApplication::BearerAuthorization);
            let endpoint = route.endpoint.expect("an address");
            assert_eq!(endpoint.url(), url(provider));
            assert!(!endpoints.contains(&endpoint), "two tools share an address");
            endpoints.push(endpoint);
            for credential in CredentialKind::ALL {
                assert_eq!(
                    reader_route(identity.provider, credential).is_ok(),
                    credential == identity.credential,
                    "{provider:?} accepted a credential that is not its own"
                );
            }
            for other in ProviderId::ALL {
                if other != identity.provider {
                    assert!(
                        reader_route(other, identity.credential).is_err(),
                        "{provider:?}'s token reached {other:?}"
                    );
                }
            }
        }
        /* And none of the four addresses is any other reader's. */
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                if let Ok(route) = reader_route(provider, credential) {
                    if let Some(endpoint) = route.endpoint {
                        if endpoints.contains(&endpoint) {
                            assert!(LoginProvider::ALL.iter().any(|login| {
                                let identity = login_route(*login);
                                identity.provider == provider && identity.credential == credential
                            }));
                        }
                    }
                }
            }
        }
        assert!(ProviderEndpoint::ALL.iter().filter(|endpoint| endpoints.contains(endpoint)).count() == 4);
    }

    #[tokio::test]
    async fn each_saved_login_reaches_only_its_own_address_and_never_the_cache() {
        /* All four tools signed in on one machine, each with a canary token:
        every pass sends exactly its own tool's token to exactly its own
        address, and no canary reaches the cache, the outcome sent over IPC,
        the detection report or the request policy file. */
        let dir = TempDir::new();
        let canary = |provider: LoginProvider| format!("CANARY-{provider:?}-do-not-echo");
        for provider in LoginProvider::ALL {
            write_login(provider, dir.path(), &canary(provider), "2099-01-01T00:00:00Z");
        }
        let detection = DetectionStore::for_test_home(dir.path(), now());
        let policy = RequestPolicy::at(Some(dir.path().to_path_buf()));
        let runtime = ToolLoginRuntime::default();
        for provider in LoginProvider::ALL {
            let detected = login_route(provider).detected;
            let accounts = detection.account_ids(detected);
            assert_eq!(accounts.len(), 1, "{provider:?}: one saved login, one account");
            let transport = RecordingTransport::replying(200, reply(provider).as_bytes().to_vec(), None);
            let (outcome, _) = collect_account_guarded(
                provider,
                &detection,
                &runtime,
                &policy,
                &transport,
                writer(&dir),
                accounts[0].clone(),
                now(),
            )
            .await;
            assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{provider:?}: {outcome:?}");
            assert_eq!(transport.recorded_urls(), vec![url(provider)]);
            assert_eq!(transport.recorded_secrets(), vec![sent_token(provider, &canary(provider))]);
            assert_eq!(transport.recorded_auths(), vec![AuthApplication::BearerAuthorization]);
            assert_eq!(transport.recorded_provider_account_ids(), vec![None]);
            let ipc = serde_json::to_string(&outcome).unwrap();
            let debug = format!("{outcome:?}");
            let report = serde_json::to_string(&detection.report()).unwrap();
            for text in [&ipc, &debug, &report] {
                for login in LoginProvider::ALL {
                    assert!(!text.contains("CANARY"), "{login:?} canary escaped: {text}");
                }
            }
        }
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        for code in ["HERMES", "COMMANDCODE", "CLINE", "KILOCODE"] {
            assert!(cache.contains(code), "{code} rows");
        }
        assert!(!cache.contains("CANARY"));
        assert!(!cache.contains("never-sent"));
        let policy_file = fs::read_to_string(dir.path().join(crate::request_policy::REQUEST_POLICY_FILE_NAME)).unwrap();
        assert!(!policy_file.contains("CANARY"));
    }

    #[tokio::test]
    async fn a_rejected_login_is_stale_with_its_own_sentence_and_no_retry() {
        for provider in LoginProvider::ALL {
            let dir = TempDir::new();
            write_login(provider, dir.path(), "rejected-token", "2099-01-01T00:00:00Z");
            let detection = DetectionStore::for_test_home(dir.path(), now());
            let detected = login_route(provider).detected;
            let account = detection.account_ids(detected).pop().expect("account");
            let runtime = ToolLoginRuntime::default();
            let transport = RecordingTransport::replying(401, Vec::new(), None);
            let outcome =
                collect_account(provider, &detection, &runtime, &transport, writer(&dir), account.clone(), now()).await;
            let LoginOutcome::ReopenCli { message, .. } = &outcome else {
                panic!("{provider:?}: {outcome:?}");
            };
            assert_eq!(message, &reopen_message(detected));
            let report = detection.report();
            let shown = report
                .providers
                .iter()
                .find(|entry| entry.provider_id == detected)
                .and_then(|entry| entry.accounts.first())
                .expect("account row");
            assert_eq!(shown.message.as_deref(), Some(message.as_str()));
            assert_eq!(shown.auth_state, crate::provider_detection::DetectedAuthState::Stale);
            let again =
                collect_account(provider, &detection, &runtime, &transport, writer(&dir), account, now() + 1_000).await;
            assert!(matches!(again, LoginOutcome::Cached { .. }), "{again:?}");
            assert_eq!(transport.recorded_urls().len(), 1);
        }
        assert_eq!(
            reopen_message(DetectedProviderId::Hermes),
            "Open Hermes once so it renews its sign in."
        );
    }

    #[tokio::test]
    async fn an_expired_login_is_never_sent() {
        for provider in [LoginProvider::Hermes, LoginProvider::Kilocode] {
            let dir = TempDir::new();
            write_login(provider, dir.path(), "expired-token", "2026-08-07T11:00:00Z");
            let detection = DetectionStore::for_test_home(dir.path(), now());
            let detected = login_route(provider).detected;
            let account = detection.account_ids(detected).pop().expect("account");
            let transport = RecordingTransport::replying(200, reply(provider).as_bytes().to_vec(), None);
            let outcome = collect_account(
                provider,
                &detection,
                &ToolLoginRuntime::default(),
                &transport,
                writer(&dir),
                account,
                now(),
            )
            .await;
            assert!(matches!(outcome, LoginOutcome::ReopenCli { .. }), "{provider:?}: {outcome:?}");
            assert!(transport.recorded_urls().is_empty());
        }
    }

    #[tokio::test]
    async fn a_refusal_backs_off_a_day_and_stops_the_provider() {
        for provider in LoginProvider::ALL {
            let dir = TempDir::new();
            write_login(provider, dir.path(), "refused-token", "2099-01-01T00:00:00Z");
            let detection = DetectionStore::for_test_home(dir.path(), now());
            let account = detection.account_ids(login_route(provider).detected).pop().unwrap();
            let policy = RequestPolicy::at(Some(dir.path().to_path_buf()));
            let runtime = ToolLoginRuntime::default();
            let transport = RecordingTransport::replying(403, Vec::new(), None);
            let (outcome, abort) = collect_account_guarded(
                provider, &detection, &runtime, &policy, &transport, writer(&dir), account.clone(), now(),
            )
            .await;
            assert!(matches!(
                outcome,
                LoginOutcome::Fallback { reason: LoginFailure::ProviderBlocked, .. }
            ));
            assert!(abort, "a refusal is never retried around");
            let (later, _) = collect_account_guarded(
                provider, &detection, &runtime, &policy, &transport, writer(&dir), account, now() + 3_600_000,
            )
            .await;
            assert!(matches!(later, LoginOutcome::Cached { .. }), "{later:?}");
            assert_eq!(transport.recorded_urls().len(), 1);
        }
    }

    #[tokio::test]
    async fn rate_limits_and_service_waits_follow_the_shared_policy() {
        let dir = TempDir::new();
        for (status, retry) in [(429, None), (503, Some(7_200))] {
            let outcome = collect_with_secret(
                LoginProvider::Cline,
                &ToolLoginRuntime::default(),
                &RecordingTransport::replying(status, Vec::new(), retry),
                writer(&dir),
                "cline-account",
                &secret("token"),
                now(),
            )
            .await;
            assert_eq!(
                outcome,
                LoginOutcome::Fallback {
                    account_id: "cline-account".into(),
                    reason: LoginFailure::RateLimited,
                    retry_after_seconds: retry,
                }
            );
        }
    }

    #[tokio::test]
    async fn drift_suppresses_previous_rows_without_inventing_zero() {
        for provider in LoginProvider::ALL {
            let dir = TempDir::new();
            let transport = RecordingTransport::replying(200, br#"{"unexpected":true}"#.to_vec(), None);
            let outcome = collect_with_secret(
                provider,
                &ToolLoginRuntime::default(),
                &transport,
                writer(&dir),
                "account",
                &secret("token"),
                now(),
            )
            .await;
            assert!(matches!(outcome, LoginOutcome::Fallback { reason: LoginFailure::Drift, .. }));
            let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
            assert!(cache.contains("suppressions"));
            assert!(!cache.contains("\"value\":0"));
        }
    }

    #[test]
    fn no_folder_a_malformed_file_and_a_second_login_beside_the_active_one() {
        let dir = TempDir::new();
        let detection = DetectionStore::for_test_home(dir.path(), now());
        for provider in LoginProvider::ALL {
            assert!(detection.account_ids(login_route(provider).detected).is_empty());
        }
        for provider in LoginProvider::ALL {
            let path = login_file(provider, dir.path());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "{ not json").unwrap();
        }
        let detection = DetectionStore::for_test_home(dir.path(), now());
        let report = detection.report();
        for provider in LoginProvider::ALL {
            let detected = login_route(provider).detected;
            assert!(detection.account_ids(detected).is_empty());
            let entry = report.providers.iter().find(|entry| entry.provider_id == detected).unwrap();
            assert_eq!(entry.state, crate::provider_detection::ProviderPresence::InstalledLoggedOut);
        }
        /* Hermes keeps other providers and a credential pool beside its Nous
        login, Kilo keeps other providers' logins, Cline keeps a ClinePass
        entry: only the tool's own active login is an account. */
        fs::write(
            login_file(LoginProvider::Hermes, dir.path()),
            r#"{"providers":{"nous":{"access_token":"active"},"openai":{"access_token":"other"}},"credential_pool":{"nous":[{"access_token":"pooled"}]}}"#,
        )
        .unwrap();
        fs::write(
            login_file(LoginProvider::Kilocode, dir.path()),
            r#"{"kilo":{"type":"oauth","access":"active","refresh":"active","expires":0},"openai":{"type":"oauth","access":"other","refresh":"other","expires":1}}"#,
        )
        .unwrap();
        fs::write(
            login_file(LoginProvider::Cline, dir.path()),
            r#"{"providers":{"cline":{"settings":{"auth":{"accessToken":"workos:active"}}},"cline-pass":{"settings":{"auth":{"accessToken":"workos:other"}}}}}"#,
        )
        .unwrap();
        let detection = DetectionStore::for_test_home(dir.path(), now());
        for provider in [LoginProvider::Hermes, LoginProvider::Kilocode, LoginProvider::Cline] {
            let detected = login_route(provider).detected;
            let accounts = detection.account_ids(detected);
            assert_eq!(accounts.len(), 1, "{provider:?}");
            let read = detection.read_credential(detected, &accounts[0]).unwrap();
            assert_eq!(read.access_token.as_str(), sent_token(provider, "active"));
        }
    }

    #[test]
    fn generic_and_detected_paths_dedupe_by_account_identity() {
        let account_id = "hermes-account".to_string();
        let covered = HashSet::from([PollIdentity::detected(ProviderId::Hermes, account_id.clone())]);
        assert!(uncovered_account_ids(LoginProvider::Hermes, vec![account_id.clone()], &covered).is_empty());
        assert_eq!(uncovered_account_ids(LoginProvider::Cline, vec![account_id], &covered).len(), 1);
    }

    #[test]
    fn home_refresh_reports_a_committed_read_and_a_login_failure() {
        assert!(pass_read_succeeded(&LoginOutcome::CacheCommitted { account_id: "a".into() }));
        assert!(!pass_read_succeeded(&LoginOutcome::reopen(LoginProvider::Kilocode, "a")));
    }

    #[test]
    fn the_login_route_carries_no_wildcard_arm() {
        let source = include_str!("tool_login_oauth.rs");
        let body = source
            .split("pub const fn login_route")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .expect("the route function");
        assert!(body.contains("LoginProvider::Kilocode =>"));
        assert!(!body.contains("_ =>"));
        assert!(!body.contains("_ if"));
    }
}
