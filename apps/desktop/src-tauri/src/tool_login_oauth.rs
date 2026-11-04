//! One automatic read for the tools whose saved sign in is a single token:
//! Hermes (Nous Portal), Command Code, Cline, Kilo Code, GitHub Copilot, Amp,
//! Codebuff, Kiro and Crush (Charm Hyper). Each pass takes the login the tool
//! saved on this computer (`tool_logins`), asks that tool's address (and, for
//! Codebuff, its one constant companion) and caches the reply.
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
use crate::net::{
    fetch_endpoint, EndpointOutcome, KiroProfileArn, KiroProfileError, NetError, ProviderEndpoint,
    ReqwestTransport, Transport,
};
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
    Copilot,
    Amp,
    Codebuff,
    Kiro,
    Crush,
}

impl LoginProvider {
    pub const ALL: [Self; 9] = [
        Self::Hermes,
        Self::Commandcode,
        Self::Cline,
        Self::Kilocode,
        Self::Copilot,
        Self::Amp,
        Self::Codebuff,
        Self::Kiro,
        Self::Crush,
    ];
}

/// What a Kiro sign in whose profile lives outside the allowlisted region
/// shows instead of a bar.
pub const KIRO_OTHER_REGION_MESSAGE: &str =
    "Kiro profiles outside the US East (N. Virginia) region are not read yet, so this sign in shows no bar.";

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
        LoginProvider::Copilot => LoginRoute {
            detected: DetectedProviderId::Copilot,
            provider: ProviderId::Copilot,
            credential: CredentialKind::CopilotSession,
        },
        LoginProvider::Amp => LoginRoute {
            detected: DetectedProviderId::Amp,
            provider: ProviderId::Amp,
            credential: CredentialKind::AmpApiKey,
        },
        LoginProvider::Codebuff => LoginRoute {
            detected: DetectedProviderId::Codebuff,
            provider: ProviderId::Codebuff,
            credential: CredentialKind::CodebuffSession,
        },
        LoginProvider::Kiro => LoginRoute {
            detected: DetectedProviderId::Kiro,
            provider: ProviderId::Kiro,
            credential: CredentialKind::KiroSession,
        },
        LoginProvider::Crush => LoginRoute {
            detected: DetectedProviderId::Crush,
            provider: ProviderId::Crush,
            credential: CredentialKind::CrushSession,
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
    /// A login this build finds but does not read yet; no request was made.
    Unsupported,
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

/// One reply read by the shared rules: the body of a success, or the outcome
/// that ends the pass. Every request of a pass, a companion's included, is
/// read by these same rules.
async fn checked_body(
    provider: LoginProvider,
    runtime: &ToolLoginRuntime,
    writer: &Arc<CacheWriter>,
    account_id: &str,
    response: EndpointOutcome,
    now_ms: u64,
) -> Result<Option<String>, LoginOutcome> {
    match response.status {
        200..=299 => Ok(response.body),
        401 => {
            runtime.postpone(provider, account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(Arc::clone(writer), provider, account_id, false, now_ms).await;
            Err(LoginOutcome::reopen(provider, account_id))
        }
        403 | 404 | 410 => {
            runtime.postpone(provider, account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(Arc::clone(writer), provider, account_id, false, now_ms).await;
            Err(LoginOutcome::fallback(account_id, LoginFailure::ProviderBlocked, None))
        }
        429 | 503 if response.status == 429 || response.retry_after_seconds.is_some() => {
            runtime.postpone(provider, account_id, now_ms, 0);
            fallback_report(Arc::clone(writer), provider, account_id, false, now_ms).await;
            Err(LoginOutcome::fallback(
                account_id,
                LoginFailure::RateLimited,
                response.retry_after_seconds,
            ))
        }
        _ => Err(LoginOutcome::failed(account_id, LoginFailure::ProviderResponse)),
    }
}

/// The rows a companion reply adds, or None when its shape is not one this
/// build reads. An explicit "nothing to add" (Codebuff with no subscription)
/// is an empty list; an unreadable reply is drift for the whole read, never an
/// empty success that would drop the previous rows and mark the account ready.
fn companion_rows(
    companion: ProviderEndpoint,
    body: Option<&str>,
    now_ms: u64,
    account_id: &str,
) -> Option<Vec<crate::native_snapshot::Snapshot>> {
    match companion {
        ProviderEndpoint::CodebuffSubscription => {
            crate::native_readers::parse_codebuff_subscription(body?, now_ms, account_id)
        }
        _ => None,
    }
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
    /* Only Kiro's login states a value beside the token: its profile, which
    `fetch_endpoint` validates before it writes the one Kiro body. */
    let beside = secret.provider_account_id.as_deref();
    let response = match fetch_endpoint(transport, endpoint, route.auth, &secret.access_token, beside).await {
        Ok(response) => response,
        Err(error) => return LoginOutcome::failed(account_id, net_failure(error)),
    };
    let body = match checked_body(provider, runtime, &writer, account_id, response, now_ms).await {
        Ok(body) => body,
        Err(outcome) => return outcome,
    };
    let snapshots = body
        .as_deref()
        .and_then(|body| parse_body(route.reader_id, body, now_ms, account_id));
    let Some(mut snapshots) = snapshots else {
        fallback_report(writer, provider, account_id, true, now_ms).await;
        return LoginOutcome::fallback(account_id, LoginFailure::Drift, None);
    };
    if let Some(companion) = endpoint.companion() {
        let response = match fetch_endpoint(transport, companion, route.auth, &secret.access_token, beside).await {
            Ok(response) => response,
            Err(error) => return LoginOutcome::failed(account_id, net_failure(error)),
        };
        let body = match checked_body(provider, runtime, &writer, account_id, response, now_ms).await {
            Ok(body) => body,
            Err(outcome) => return outcome,
        };
        let Some(rows) = companion_rows(companion, body.as_deref(), now_ms, account_id) else {
            fallback_report(writer, provider, account_id, true, now_ms).await;
            return LoginOutcome::fallback(account_id, LoginFailure::Drift, None);
        };
        snapshots.extend(rows);
    }
    if commit_report(writer, provider, account_id.to_string(), CacheReport::Success(snapshots)).await {
        LoginOutcome::CacheCommitted {
            account_id: account_id.to_string(),
        }
    } else {
        LoginOutcome::failed(account_id, LoginFailure::Cache)
    }
}

/// The sentence for a login this build finds but does not read, or None.
/// Today that is a Kiro profile outside us-east-1: its service is not in the
/// allowlist, so its token is sent nowhere.
fn unread_login(provider: LoginProvider, secret: &DetectedSecret) -> Option<&'static str> {
    if login_route(provider).credential != CredentialKind::KiroSession {
        return None;
    }
    match secret.provider_account_id.as_deref().map(KiroProfileArn::parse) {
        Some(Err(KiroProfileError::OtherRegion)) => Some(KIRO_OTHER_REGION_MESSAGE),
        Some(Ok(_)) | Some(Err(KiroProfileError::Malformed)) | None => None,
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
    if let Some(message) = unread_login(provider, &secret) {
        detection.mark_unsupported(detected, &account_id, message);
        return LoginOutcome::fallback(&account_id, LoginFailure::Unsupported, None);
    }
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
            policy.refuse_provider(detected, account_id, now_ms);
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

/// A login this build does not read yet is shown on its own row; it is not a
/// failed refresh, so it does not mark every pass as failed.
fn pass_read_succeeded(outcome: &LoginOutcome) -> bool {
    matches!(
        outcome,
        LoginOutcome::CacheCommitted { .. }
            | LoginOutcome::Cached { .. }
            | LoginOutcome::Fallback { reason: LoginFailure::Unsupported, .. }
    )
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
        AMP_BALANCE_URL, CLINE_USAGE_URL, CODEBUFF_SUBSCRIPTION_URL, CODEBUFF_USAGE_URL,
        COMMANDCODE_CREDITS_URL, COPILOT_USER_URL, CRUSH_CREDITS_URL, HERMES_ACCOUNT_URL,
        KILOCODE_BALANCE_URL, KIRO_USAGE_LIMITS_URL,
    };
    use crate::reader_registry::AuthApplication;
    use crate::test_support::{RecordingTransport, TempDir};
    use zeroize::Zeroizing;

    const NOW_TEXT: &str = "2026-08-07T12:00:00.000Z";

    fn now() -> u64 {
        epoch_ms_from_rfc3339(NOW_TEXT).expect("fixture clock")
    }

    /// A synthetic Kiro profile in the one allowlisted region.
    const KIRO_ARN: &str = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE1";

    fn url(provider: LoginProvider) -> &'static str {
        match provider {
            LoginProvider::Hermes => HERMES_ACCOUNT_URL,
            LoginProvider::Commandcode => COMMANDCODE_CREDITS_URL,
            LoginProvider::Cline => CLINE_USAGE_URL,
            LoginProvider::Kilocode => KILOCODE_BALANCE_URL,
            LoginProvider::Copilot => COPILOT_USER_URL,
            LoginProvider::Amp => AMP_BALANCE_URL,
            LoginProvider::Codebuff => CODEBUFF_USAGE_URL,
            LoginProvider::Kiro => KIRO_USAGE_LIMITS_URL,
            LoginProvider::Crush => CRUSH_CREDITS_URL,
        }
    }

    /// Every address one pass reaches, in order: Codebuff reads its
    /// subscription after its balance; every other tool makes one request.
    fn urls(provider: LoginProvider) -> Vec<&'static str> {
        if provider == LoginProvider::Codebuff {
            vec![CODEBUFF_USAGE_URL, CODEBUFF_SUBSCRIPTION_URL]
        } else {
            vec![url(provider)]
        }
    }

    fn auth(provider: LoginProvider) -> AuthApplication {
        match provider {
            LoginProvider::Copilot => AuthApplication::GithubTokenAuthorization,
            LoginProvider::Kiro => AuthApplication::KiroUsageBearer,
            LoginProvider::Hermes
            | LoginProvider::Commandcode
            | LoginProvider::Cline
            | LoginProvider::Kilocode
            | LoginProvider::Amp
            | LoginProvider::Codebuff
            | LoginProvider::Crush => AuthApplication::BearerAuthorization,
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
            LoginProvider::Copilot => {
                r#"{"copilot_plan":"individual","quota_reset_date":"2026-09-01","quota_snapshots":{"premium_interactions":{"entitlement":300,"remaining":210,"percent_remaining":70,"unlimited":false,"quota_id":"premium_interactions"},"chat":{"entitlement":0,"remaining":0,"percent_remaining":100,"unlimited":true,"quota_id":"chat"}}}"#
            }
            LoginProvider::Amp => {
                r#"{"ok":true,"result":{"displayText":"Signed in as person\nAmp Free: $7.50 / $10 remaining (replenishes +$0.42 / hour)\nIndividual credits: $4.25 remaining"}}"#
            }
            /* One body both Codebuff readers accept: the balance reply and the
            subscription reply the same transport answers with. */
            LoginProvider::Codebuff => {
                r#"{"type":"usage-response","usage":80,"remainingBalance":420,"next_quota_reset":null,"hasSubscription":true,"rateLimit":{"limited":false,"canStartNewBlock":true,"weeklyUsed":30,"weeklyLimit":120,"weeklyResetsAt":"2026-08-10T00:00:00.000Z","weeklyPercentUsed":25}}"#
            }
            LoginProvider::Kiro => {
                r#"{"usageBreakdownList":[{"resourceType":"CREDIT","currentUsageWithPrecision":120,"usageLimitWithPrecision":500,"currentOveragesWithPrecision":0,"nextDateReset":1788220800}],"nextDateReset":1788220800}"#
            }
            LoginProvider::Crush => r#"{"balance":95}"#,
        }
    }

    /// Where `DetectionStore::for_test_home` looks for each tool's login.
    fn login_file(provider: LoginProvider, home: &Path) -> PathBuf {
        match provider {
            LoginProvider::Hermes => home.join(".hermes").join("auth.json"),
            LoginProvider::Commandcode => home.join(".commandcode").join("auth.json"),
            LoginProvider::Cline => home.join(".cline/data/settings/providers.json"),
            LoginProvider::Kilocode => home.join(".local/share/kilo/auth.json"),
            LoginProvider::Copilot => home.join(".config/github-copilot/apps.json"),
            LoginProvider::Amp => home.join(".local/share/amp/secrets.json"),
            LoginProvider::Codebuff => home.join(".config/manicode/credentials.json"),
            LoginProvider::Kiro => home.join(".local/share/kiro-cli/data.sqlite3"),
            LoginProvider::Crush => home.join(".local/share/crush/crush.json"),
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
            LoginProvider::Copilot => format!(
                r#"{{"github.com:Iv1.b507a08c87ecfe98":{{"user":"octo","oauth_token":"{token}","githubAppId":"Iv1.b507a08c87ecfe98"}}}}"#
            ),
            LoginProvider::Amp => format!(r#"{{"apiKey@https://ampcode.com/":"{token}"}}"#),
            LoginProvider::Codebuff => format!(
                r#"{{"default":{{"id":"user-1","name":"","email":"person@example.com","authToken":"{token}","fingerprintId":"never-sent"}}}}"#
            ),
            LoginProvider::Kiro => format!(
                r#"{{"access_token":"{token}","refresh_token":"never-sent","expires_at":"{expires}","region":"us-east-1"}}"#
            ),
            LoginProvider::Crush => format!(
                r#"{{"providers":{{"hyper":{{"api_key":"{token}","oauth":{{"access_token":"{token}","refresh_token":"never-sent","expires_in":3600,"expires_at":{}}}}}}}}}"#,
                epoch_ms_from_rfc3339(expires).unwrap() / 1_000
            ),
        }
    }

    /// The Kiro CLI's state database with one token and one profile.
    fn kiro_database(path: &Path, token_text: &str, arn: &str) {
        let _ = fs::remove_file(path);
        let db = rusqlite::Connection::open(path).unwrap();
        db.execute_batch(
            "CREATE TABLE auth_kv(key TEXT PRIMARY KEY, value TEXT); \
             CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
        db.execute("INSERT INTO auth_kv VALUES ('kirocli:odic:token', ?1)", [token_text]).unwrap();
        let profile = format!(r#"{{"arn":"{arn}","profile_name":"Synthetic"}}"#);
        db.execute("INSERT INTO state VALUES ('api.codewhisperer.profile', ?1)", [profile]).unwrap();
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
        if provider == LoginProvider::Kiro {
            kiro_database(&path, &login_text(provider, token, expires), KIRO_ARN);
        } else {
            fs::write(path, login_text(provider, token, expires)).unwrap();
        }
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

    /// The secret a provider's login yields: Kiro's carries its profile.
    fn secret_for(provider: LoginProvider, token: &str) -> DetectedSecret {
        let mut found = secret(token);
        if provider == LoginProvider::Kiro {
            found.provider_account_id = Some(KIRO_ARN.to_string());
        }
        found
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
            assert_eq!(route.auth, auth(provider), "{provider:?} uses another scheme");
            let endpoint = route.endpoint.expect("an address");
            assert_eq!(endpoint.url(), url(provider));
            assert!(!endpoints.contains(&endpoint), "two tools share an address");
            endpoints.push(endpoint);
            /* A companion is reached only behind its own provider's address. */
            if let Some(companion) = endpoint.companion() {
                assert_eq!(urls(provider), vec![endpoint.url(), companion.url()]);
                assert!(!endpoints.contains(&companion), "a companion is another tool's address");
                endpoints.push(companion);
            } else {
                assert_eq!(urls(provider), vec![endpoint.url()]);
            }
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
        /* And none of these addresses is any other reader's, and no
        companion is reachable as a route of its own. */
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                if let Ok(route) = reader_route(provider, credential) {
                    if let Some(endpoint) = route.endpoint {
                        assert!(
                            ProviderEndpoint::ALL.iter().all(|other| other.companion() != Some(endpoint)),
                            "a companion address is routed on its own"
                        );
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
        assert_eq!(
            ProviderEndpoint::ALL.iter().filter(|endpoint| endpoints.contains(endpoint)).count(),
            LoginProvider::ALL.len() + 1
        );
    }

    #[tokio::test]
    async fn each_saved_login_reaches_only_its_own_address_and_never_the_cache() {
        /* Every tool signed in on one machine, each with a canary token:
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
            let requests = urls(provider).len();
            assert_eq!(transport.recorded_urls(), urls(provider));
            assert_eq!(transport.recorded_secrets(), vec![sent_token(provider, &canary(provider)); requests]);
            assert_eq!(transport.recorded_auths(), vec![auth(provider); requests]);
            assert_eq!(transport.recorded_provider_account_ids(), vec![None; requests]);
            /* No body carries the token; only Kiro's names its profile. */
            for body in transport.recorded_bodies().into_iter().flatten() {
                assert!(!body.contains("CANARY"), "{provider:?} put a token in a body");
                assert!(!body.contains("never-sent"));
                if provider == LoginProvider::Kiro {
                    assert_eq!(body, format!(r#"{{"profileArn":"{KIRO_ARN}"}}"#));
                }
            }
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
        for code in [
            "HERMES", "COMMANDCODE", "CLINE", "KILOCODE", "COPILOT", "AMP", "CODEBUFF", "KIRO", "CRUSH",
        ] {
            assert!(cache.contains(&format!("\"{code}\"")), "{code} rows");
        }
        assert!(!cache.contains("CANARY"));
        assert!(!cache.contains("never-sent"));
        assert!(!cache.contains("123456789012"), "the Kiro profile reached the cache");
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
        for provider in [LoginProvider::Hermes, LoginProvider::Kilocode, LoginProvider::Kiro, LoginProvider::Crush] {
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
                &secret_for(provider, "token"),
                now(),
            )
            .await;
            assert!(
                matches!(outcome, LoginOutcome::Fallback { reason: LoginFailure::Drift, .. }),
                "{provider:?}: {outcome:?}"
            );
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
            /* Kiro's database file holding text is malformed the same way. */
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
        /* Copilot keeps an enterprise host's login beside github.com's, Codebuff
        other profiles beside its default, Crush other providers' keys. */
        fs::write(
            login_file(LoginProvider::Copilot, dir.path()),
            r#"{"github.com:Iv1.b507a08c87ecfe98":{"user":"octo","oauth_token":"active"},"ghe.example.com:Iv1.b507a08c87ecfe98":{"user":"octo","oauth_token":"other"}}"#,
        )
        .unwrap();
        fs::write(
            login_file(LoginProvider::Codebuff, dir.path()),
            r#"{"default":{"id":"user-1","email":"person@example.com","authToken":"active"},"work":{"id":"user-2","email":"other@example.com","authToken":"other"}}"#,
        )
        .unwrap();
        fs::write(
            login_file(LoginProvider::Crush, dir.path()),
            r#"{"providers":{"hyper":{"api_key":"active"},"openai":{"api_key":"other"},"copilot":{"api_key":"other"}}}"#,
        )
        .unwrap();
        let detection = DetectionStore::for_test_home(dir.path(), now());
        for provider in [
            LoginProvider::Hermes,
            LoginProvider::Kilocode,
            LoginProvider::Cline,
            LoginProvider::Copilot,
            LoginProvider::Codebuff,
            LoginProvider::Crush,
        ] {
            let detected = login_route(provider).detected;
            let accounts = detection.account_ids(detected);
            assert_eq!(accounts.len(), 1, "{provider:?}");
            let read = detection.read_credential(detected, &accounts[0]).unwrap();
            assert_eq!(read.access_token.as_str(), sent_token(provider, "active"));
        }
    }

    fn jwt(claims: serde_json::Value) -> String {
        use base64::Engine;
        let encode = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        format!("{}.{}.signature", encode(br#"{"alg":"none"}"#), encode(claims.to_string().as_bytes()))
    }

    /// Save a login for `person`, as each tool states who is signed in: a JWT
    /// subject for Hermes, Cline, Kilo, Amp and Crush, the user id for Command
    /// Code and Codebuff, the `user` for Copilot, the profile for Kiro. The
    /// returned bearer is exactly what the tool's own address must receive.
    fn sign_in(provider: LoginProvider, home: &Path, person: &str, secret: &str) -> String {
        let token = jwt(serde_json::json!({ "sub": person, "jti": secret }));
        let path = login_file(provider, home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let (text, sent) = match provider {
            LoginProvider::Hermes => (
                format!(r#"{{"providers":{{"nous":{{"access_token":"{token}","expires_at":"2099-01-01T00:00:00Z"}}}}}}"#),
                token,
            ),
            LoginProvider::Commandcode => (
                format!(r#"{{"apiKey":"{secret}","userId":"{person}"}}"#),
                secret.to_string(),
            ),
            LoginProvider::Cline => (
                format!(r#"{{"providers":{{"cline":{{"settings":{{"auth":{{"accessToken":"workos:{token}"}}}}}}}}}}"#),
                format!("workos:{token}"),
            ),
            LoginProvider::Kilocode => (
                format!(r#"{{"kilo":{{"type":"oauth","access":"{token}","refresh":"{token}","expires":4070908800000}}}}"#),
                token,
            ),
            LoginProvider::Copilot => (
                format!(r#"{{"github.com:Iv1.b507a08c87ecfe98":{{"user":"{person}","oauth_token":"gho_{secret}"}}}}"#),
                format!("gho_{secret}"),
            ),
            LoginProvider::Amp => (format!(r#"{{"apiKey@https://ampcode.com/":"{token}"}}"#), token),
            LoginProvider::Codebuff => (
                format!(r#"{{"default":{{"id":"{person}","email":"person@example.com","authToken":"{secret}"}}}}"#),
                secret.to_string(),
            ),
            LoginProvider::Kiro => {
                let saved = format!(r#"{{"access_token":"{secret}","expires_at":"2099-01-01T00:00:00Z"}}"#);
                kiro_database(&path, &saved, &format!("arn:aws:codewhisperer:us-east-1:123456789012:profile/{person}"));
                return secret.to_string();
            }
            LoginProvider::Crush => (
                format!(r#"{{"providers":{{"hyper":{{"api_key":"{token}","oauth":{{"access_token":"{token}","expires_at":4070908800}}}}}}}}"#),
                token,
            ),
        };
        fs::write(path, text).unwrap();
        sent
    }

    #[tokio::test]
    async fn an_amp_key_without_a_subject_is_the_one_amp_account_and_is_read_again() {
        let dir = TempDir::new();
        let path = login_file(LoginProvider::Amp, dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"apiKey@https://ampcode.com/":"sgamp-one"}"#).unwrap();
        let detection = DetectionStore::for_test_home(dir.path(), now());
        let account = detection.account_ids(DetectedProviderId::Amp).pop().expect("account");
        let runtime = ToolLoginRuntime::default();
        let transport = RecordingTransport::replying(200, reply(LoginProvider::Amp).as_bytes().to_vec(), None);
        let outcome = collect_account(LoginProvider::Amp, &detection, &runtime, &transport, writer(&dir), account.clone(), now()).await;
        assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{outcome:?}");
        /* A key with no subject is the machine's one Amp account: a new key is
        read again for that account, and a rescan names the same account. */
        fs::write(&path, r#"{"apiKey@https://ampcode.com/":"sgamp-two"}"#).unwrap();
        let outcome =
            collect_account(LoginProvider::Amp, &detection, &runtime, &transport, writer(&dir), account.clone(), now() + 301_000).await;
        assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{outcome:?}");
        assert_eq!(transport.recorded_secrets(), vec!["sgamp-one", "sgamp-two"]);
        let rescanned = DetectionStore::for_test_home(dir.path(), now());
        assert_eq!(rescanned.account_ids(DetectedProviderId::Amp), vec![account]);
    }

    #[tokio::test]
    async fn a_rotated_login_is_read_again_and_a_switched_account_is_a_new_account() {
        for provider in LoginProvider::ALL {
            let dir = TempDir::new();
            let detected = login_route(provider).detected;
            let runtime = ToolLoginRuntime::default();

            let first = sign_in(provider, dir.path(), "person-a", "secret-one");
            let detection = DetectionStore::for_test_home(dir.path(), now());
            let accounts = detection.account_ids(detected);
            assert_eq!(accounts.len(), 1, "{provider:?}");
            let person_a = accounts[0].clone();
            let transport = RecordingTransport::replying(200, reply(provider).as_bytes().to_vec(), None);
            let outcome = collect_account(provider, &detection, &runtime, &transport, writer(&dir), person_a.clone(), now()).await;
            assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{provider:?}: {outcome:?}");

            /* The tool renewed its token: the next pass reads the file again
            and sends the renewed token for the same account. */
            let rotated = sign_in(provider, dir.path(), "person-a", "secret-two");
            let outcome =
                collect_account(provider, &detection, &runtime, &transport, writer(&dir), person_a.clone(), now() + 301_000).await;
            assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{provider:?}: {outcome:?}");
            /* Codebuff's pass asks two addresses with the same token. */
            let requests = urls(provider).len();
            let sent: Vec<String> = [vec![first; requests], vec![rotated; requests]].concat();
            assert_eq!(transport.recorded_secrets(), sent, "{provider:?}");

            /* Another person signed in. Before a rescan the old account's
            reference no longer names the saved login, so nothing is sent under
            the old account; after it the new person is a new account. */
            let switched = sign_in(provider, dir.path(), "person-b", "secret-three");
            let outcome =
                collect_account(provider, &detection, &runtime, &transport, writer(&dir), person_a.clone(), now() + 602_000).await;
            assert!(matches!(outcome, LoginOutcome::ReopenCli { .. }), "{provider:?}: {outcome:?}");
            assert_eq!(transport.recorded_urls().len(), 2 * requests, "{provider:?}");
            let rescanned = DetectionStore::for_test_home(dir.path(), now());
            let accounts = rescanned.account_ids(detected);
            assert_eq!(accounts.len(), 1, "{provider:?}");
            let person_b = accounts[0].clone();
            assert_ne!(person_b, person_a, "{provider:?}");
            assert!(rescanned.read_credential(detected, &person_a).is_err());
            let outcome =
                collect_account(provider, &rescanned, &runtime, &transport, writer(&dir), person_b, now() + 903_000).await;
            assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{provider:?}: {outcome:?}");
            assert_eq!(transport.recorded_secrets().last(), Some(&switched), "{provider:?}");
            assert_eq!(transport.recorded_urls(), urls(provider).repeat(3), "{provider:?}");
        }
    }

    #[tokio::test]
    async fn an_expired_cline_token_is_stale_with_its_sentence_and_never_sent() {
        let dir = TempDir::new();
        let token = jwt(serde_json::json!({ "sub": "person-a", "exp": 1_786_100_000u64 }));
        let path = login_file(LoginProvider::Cline, dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            format!(r#"{{"providers":{{"cline":{{"settings":{{"auth":{{"accessToken":"workos:{token}"}}}}}}}}}}"#),
        )
        .unwrap();
        let detection = DetectionStore::for_test_home(dir.path(), now());
        let report = detection.report();
        let shown = report
            .providers
            .iter()
            .find(|entry| entry.provider_id == DetectedProviderId::Cline)
            .and_then(|entry| entry.accounts.first())
            .expect("the expired login is still an account");
        assert_eq!(shown.auth_state, crate::provider_detection::DetectedAuthState::Stale);
        assert_eq!(shown.message.as_deref(), Some("Open Cline once so it renews its sign in."));
        let transport = RecordingTransport::replying(200, reply(LoginProvider::Cline).as_bytes().to_vec(), None);
        let outcome = collect_account(
            LoginProvider::Cline,
            &detection,
            &ToolLoginRuntime::default(),
            &transport,
            writer(&dir),
            shown.account_id.clone(),
            now(),
        )
        .await;
        assert!(matches!(outcome, LoginOutcome::ReopenCli { .. }), "{outcome:?}");
        assert!(transport.recorded_urls().is_empty());
    }

    async fn restarted(
        provider: LoginProvider,
        detection: &DetectionStore,
        policy: &RequestPolicy,
        dir: &TempDir,
        account: String,
        at: u64,
        transport: &RecordingTransport,
    ) -> (LoginOutcome, bool) {
        collect_account_guarded(
            provider,
            detection,
            &ToolLoginRuntime::default(),
            policy,
            transport,
            writer(dir),
            account,
            at,
        )
        .await
    }

    #[tokio::test]
    async fn a_refusal_holds_the_whole_provider_for_a_day_across_rotation_and_account_change() {
        for provider in LoginProvider::ALL {
            let dir = TempDir::new();
            let detected = login_route(provider).detected;
            let policy = RequestPolicy::at(Some(dir.path().to_path_buf()));
            let refusing = RecordingTransport::replying(403, Vec::new(), None);
            /* Each step starts with an empty in memory throttle, as a restart
            would: only the durable gate stands between the request and the
            address, which is the gate under test. */
            let guarded = |detection, account, at, transport| {
                restarted(provider, detection, &policy, &dir, account, at, transport)
            };

            sign_in(provider, dir.path(), "person-a", "secret-one");
            let detection = DetectionStore::for_test_home(dir.path(), now());
            let person_a = detection.account_ids(detected).pop().unwrap();
            let (outcome, abort) = guarded(&detection, person_a.clone(), now(), &refusing).await;
            assert!(
                matches!(outcome, LoginOutcome::Fallback { reason: LoginFailure::ProviderBlocked, .. }),
                "{provider:?}: {outcome:?}"
            );
            assert!(abort);

            /* A renewed token for the refused account waits out the day. */
            sign_in(provider, dir.path(), "person-a", "secret-two");
            let (outcome, _) = guarded(&detection, person_a, now() + 3_600_000, &refusing).await;
            assert!(matches!(outcome, LoginOutcome::Cached { .. }), "{provider:?}: {outcome:?}");

            /* So does another account of the same provider. */
            sign_in(provider, dir.path(), "person-b", "secret-three");
            let rescanned = DetectionStore::for_test_home(dir.path(), now());
            let person_b = rescanned.account_ids(detected).pop().unwrap();
            let (outcome, _) = guarded(&rescanned, person_b.clone(), now() + 7_200_000, &refusing).await;
            assert!(matches!(outcome, LoginOutcome::Cached { .. }), "{provider:?}: {outcome:?}");
            assert_eq!(refusing.recorded_urls().len(), 1, "{provider:?}: the refusal was stepped around");

            /* The day over, the provider is read again. */
            let answering = RecordingTransport::replying(200, reply(provider).as_bytes().to_vec(), None);
            let (outcome, _) = guarded(&rescanned, person_b, now() + 86_400_000 + 60_000, &answering).await;
            assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{provider:?}: {outcome:?}");
        }
    }

    #[tokio::test]
    async fn a_kiro_profile_outside_us_east_1_is_shown_and_never_sent() {
        let dir = TempDir::new();
        let path = login_file(LoginProvider::Kiro, dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        kiro_database(
            &path,
            &login_text(LoginProvider::Kiro, "eu-token", "2099-01-01T00:00:00Z"),
            "arn:aws:codewhisperer:eu-central-1:123456789012:profile/PROFILE1",
        );
        let detection = DetectionStore::for_test_home(dir.path(), now());
        let account = detection.account_ids(DetectedProviderId::Kiro).pop().expect("account");
        let transport = RecordingTransport::replying(200, reply(LoginProvider::Kiro).as_bytes().to_vec(), None);
        let outcome = collect_account(
            LoginProvider::Kiro,
            &detection,
            &ToolLoginRuntime::default(),
            &transport,
            writer(&dir),
            account,
            now(),
        )
        .await;
        assert!(
            matches!(outcome, LoginOutcome::Fallback { reason: LoginFailure::Unsupported, .. }),
            "{outcome:?}"
        );
        assert!(transport.recorded_urls().is_empty(), "a token reached a region outside the allowlist");
        let report = detection.report();
        let shown = report
            .providers
            .iter()
            .find(|entry| entry.provider_id == DetectedProviderId::Kiro)
            .and_then(|entry| entry.accounts.first())
            .expect("account row");
        assert_eq!(shown.message.as_deref(), Some(KIRO_OTHER_REGION_MESSAGE));
        assert!(!serde_json::to_string(&report).unwrap().contains("eu-token"));
    }

    #[test]
    fn a_copilot_account_is_labelled_with_its_masked_github_user() {
        let dir = TempDir::new();
        write_login(LoginProvider::Copilot, dir.path(), "gho_synthetic", "2099-01-01T00:00:00Z");
        let detection = DetectionStore::for_test_home(dir.path(), now());
        let report = detection.report();
        let shown = report
            .providers
            .iter()
            .find(|entry| entry.provider_id == DetectedProviderId::Copilot)
            .and_then(|entry| entry.accounts.first())
            .expect("account row");
        assert_eq!(shown.label, "GitHub user o***");
        let text = serde_json::to_string(&report).unwrap();
        assert!(!text.contains("octo"), "the GitHub user reached the report unmasked");
        assert!(!text.contains("gho_synthetic"));
    }

    #[tokio::test]
    async fn a_copilot_login_is_sent_with_the_token_scheme_and_no_editor_claim() {
        let dir = TempDir::new();
        let transport = RecordingTransport::replying(200, reply(LoginProvider::Copilot).as_bytes().to_vec(), None);
        let outcome = collect_with_secret(
            LoginProvider::Copilot,
            &ToolLoginRuntime::default(),
            &transport,
            writer(&dir),
            "copilot-account",
            &secret("gho_synthetic"),
            now(),
        )
        .await;
        assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{outcome:?}");
        assert_eq!(transport.recorded_auths(), vec![AuthApplication::GithubTokenAuthorization]);
        assert_eq!(transport.recorded_bodies(), vec![None]);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("\"PREMIUM\""));
        assert!(!cache.contains("\"CHAT\""), "an unlimited snapshot drew a bar");
    }

    #[tokio::test]
    async fn a_codebuff_companion_follows_the_same_rules_and_never_runs_alone() {
        let usage = reply(LoginProvider::Codebuff).as_bytes().to_vec();
        /* A refused balance stops the pass before the companion is asked. */
        let dir = TempDir::new();
        let refused = RecordingTransport::replying(403, Vec::new(), None);
        let outcome = collect_with_secret(
            LoginProvider::Codebuff, &ToolLoginRuntime::default(), &refused, writer(&dir), "cb", &secret("t"), now(),
        )
        .await;
        assert!(matches!(outcome, LoginOutcome::Fallback { reason: LoginFailure::ProviderBlocked, .. }));
        assert_eq!(refused.recorded_urls(), vec![CODEBUFF_USAGE_URL]);
        /* A refused companion is a refusal of the pass, never retried around. */
        let dir = TempDir::new();
        let companion_refused = RecordingTransport::scripted(vec![(200, usage.clone(), None), (403, Vec::new(), None)]);
        let outcome = collect_with_secret(
            LoginProvider::Codebuff, &ToolLoginRuntime::default(), &companion_refused, writer(&dir), "cb", &secret("t"), now(),
        )
        .await;
        assert!(matches!(outcome, LoginOutcome::Fallback { reason: LoginFailure::ProviderBlocked, .. }));
        assert_eq!(companion_refused.recorded_urls(), vec![CODEBUFF_USAGE_URL, CODEBUFF_SUBSCRIPTION_URL]);
        /* No subscription is no weekly bar, and the balance still stands. */
        let dir = TempDir::new();
        let no_plan = RecordingTransport::scripted(vec![
            (200, usage, None),
            (200, br#"{"hasSubscription":false,"fallbackToALaCarte":true}"#.to_vec(), None),
        ]);
        let outcome = collect_with_secret(
            LoginProvider::Codebuff, &ToolLoginRuntime::default(), &no_plan, writer(&dir), "cb", &secret("t"), now(),
        )
        .await;
        assert!(matches!(outcome, LoginOutcome::CacheCommitted { .. }), "{outcome:?}");
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("\"BALANCE\""));
        assert!(!cache.contains("\"SEVEN_DAY\""));
        assert_eq!(
            no_plan.recorded_bodies(),
            vec![Some(crate::net::CODEBUFF_USAGE_BODY.to_string()), None]
        );
    }

    #[tokio::test]
    async fn a_valid_codebuff_balance_with_an_unreadable_subscription_is_drift_never_ready() {
        let dir = TempDir::new();
        write_login(LoginProvider::Codebuff, dir.path(), "cb-token", "2099-01-01T00:00:00Z");
        let detection = DetectionStore::for_test_home(dir.path(), now());
        let account = detection.account_ids(DetectedProviderId::Codebuff).pop().expect("account");
        let transport = RecordingTransport::scripted(vec![
            (200, reply(LoginProvider::Codebuff).as_bytes().to_vec(), None),
            (200, br#"{"plan":"pro","rateLimits":[]}"#.to_vec(), None),
        ]);
        let outcome = collect_account(
            LoginProvider::Codebuff,
            &detection,
            &ToolLoginRuntime::default(),
            &transport,
            writer(&dir),
            account,
            now(),
        )
        .await;
        assert!(matches!(outcome, LoginOutcome::Fallback { reason: LoginFailure::Drift, .. }), "{outcome:?}");
        assert_eq!(transport.recorded_urls(), vec![CODEBUFF_USAGE_URL, CODEBUFF_SUBSCRIPTION_URL]);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("suppressions"), "the read was not marked as drift");
        assert!(!cache.contains("\"BALANCE\""), "a partial read was committed as a success");
        let shown = detection
            .report()
            .providers
            .iter()
            .find(|entry| entry.provider_id == DetectedProviderId::Codebuff)
            .and_then(|entry| entry.accounts.first().cloned())
            .expect("account row");
        assert_ne!(shown.collection_state, crate::provider_detection::DetectedCollectionState::Ready);
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
        assert!(pass_read_succeeded(&LoginOutcome::fallback("a", LoginFailure::Unsupported, None)));
        assert!(!pass_read_succeeded(&LoginOutcome::fallback("a", LoginFailure::Drift, None)));
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
