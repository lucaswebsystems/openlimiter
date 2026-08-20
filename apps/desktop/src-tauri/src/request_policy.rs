use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::connections::MAX_TIMESTAMP_EPOCH_MS;
use crate::fsx;
use crate::provider_detection::DetectedProviderId;

pub const REQUEST_POLICY_FILE_NAME: &str = "request-policy.json";
const REQUEST_POLICY_VERSION: u8 = 1;
const MAX_ACCOUNTS_PER_PROVIDER: usize = 128;
const PROVIDER_SPACING_SECONDS: u64 = 15;
const PROVISIONAL_REQUEST_SECONDS: u64 = 86_400;
pub const BLOCKED_PROVIDER_SECONDS: u64 = 86_400;
pub const RATE_LIMIT_SECONDS: u64 = 3_600;
const MAX_SERVER_DELAY_SECONDS: u64 = 7 * 86_400;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderPolicyState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocked_until: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_request_at: Option<u64>,
    #[serde(default)]
    accounts: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestPolicyDocument {
    version: u8,
    #[serde(default)]
    providers: BTreeMap<DetectedProviderId, ProviderPolicyState>,
}

impl Default for RequestPolicyDocument {
    fn default() -> Self {
        Self {
            version: REQUEST_POLICY_VERSION,
            providers: BTreeMap::new(),
        }
    }
}

struct PolicyInner {
    document: RequestPolicyDocument,
    healthy: bool,
    active_providers: HashSet<DetectedProviderId>,
}

pub struct RequestPolicy {
    directory: Option<PathBuf>,
    inner: Mutex<PolicyInner>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateRejection {
    Busy,
    Deferred { retry_at: u64 },
    Unavailable,
}

pub struct RequestLease<'a> {
    policy: &'a RequestPolicy,
    provider: DetectedProviderId,
}

impl Drop for RequestLease<'_> {
    fn drop(&mut self) {
        self.policy.release(self.provider);
    }
}

impl RequestPolicy {
    pub fn at_state_directory() -> Self {
        Self::at(crate::state::state_directory())
    }

    pub fn at(directory: Option<PathBuf>) -> Self {
        let loaded = load_document(directory.as_ref());
        let healthy = loaded.is_ok();
        Self {
            directory,
            inner: Mutex::new(PolicyInner {
                document: loaded.unwrap_or_default(),
                healthy,
                active_providers: HashSet::new(),
            }),
        }
    }

    pub fn begin(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
        now_ms: u64,
    ) -> Result<RequestLease<'_>, GateRejection> {
        if !valid_account_id(account_id) || now_ms > MAX_TIMESTAMP_EPOCH_MS {
            return Err(GateRejection::Unavailable);
        }
        let mut inner = self.inner.lock().map_err(|_| GateRejection::Unavailable)?;
        if !inner.healthy {
            return Err(GateRejection::Unavailable);
        }
        if inner.active_providers.contains(&provider) {
            return Err(GateRejection::Busy);
        }
        prune_expired(&mut inner.document, now_ms);
        if let Some(state) = inner.document.providers.get(&provider) {
            if let Some(retry_at) = state.blocked_until.filter(|until| now_ms < *until) {
                return Err(GateRejection::Deferred { retry_at });
            }
            if let Some(retry_at) = state.next_request_at.filter(|until| now_ms < *until) {
                return Err(GateRejection::Deferred { retry_at });
            }
            if let Some(retry_at) = state
                .accounts
                .get(account_id)
                .copied()
                .filter(|until| now_ms < *until)
            {
                return Err(GateRejection::Deferred { retry_at });
            }
            if !state.accounts.contains_key(account_id)
                && state.accounts.len() >= MAX_ACCOUNTS_PER_PROVIDER
            {
                return Err(GateRejection::Unavailable);
            }
        }

        let previous = inner.document.clone();
        let state = inner.document.providers.entry(provider).or_default();
        state.next_request_at =
            Some(now_ms.saturating_add(
                provider_spacing_seconds(provider, account_id).saturating_mul(1_000),
            ));
        /* A crash after the request leaves a conservative reservation. The
        normal completion path shortens it to the provider cadence only after
        the result has been classified and durably written. */
        state.accounts.insert(
            account_id.to_string(),
            now_ms.saturating_add(PROVISIONAL_REQUEST_SECONDS.saturating_mul(1_000)),
        );
        if persist_document(self.directory.as_ref(), &inner.document).is_err() {
            inner.document = previous;
            inner.healthy = false;
            return Err(GateRejection::Unavailable);
        }
        inner.active_providers.insert(provider);
        drop(inner);
        Ok(RequestLease {
            policy: self,
            provider,
        })
    }

    pub fn complete_after(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
        now_ms: u64,
        minimum_seconds: u64,
    ) {
        let delay = jittered_account_delay(provider, account_id, minimum_seconds.max(1));
        self.mutate_durable(|document| {
            document
                .providers
                .entry(provider)
                .or_default()
                .accounts
                .insert(
                    account_id.to_string(),
                    now_ms.saturating_add(delay.saturating_mul(1_000)),
                );
        });
    }

    pub fn block_provider(&self, provider: DetectedProviderId, now_ms: u64, minimum_seconds: u64) {
        let delay = minimum_seconds
            .max(BLOCKED_PROVIDER_SECONDS)
            .min(MAX_SERVER_DELAY_SECONDS);
        let blocked_until = now_ms.saturating_add(delay.saturating_mul(1_000));
        self.mutate_durable(|document| {
            let state = document.providers.entry(provider).or_default();
            state.blocked_until = Some(
                state
                    .blocked_until
                    .map_or(blocked_until, |current| current.max(blocked_until)),
            );
        });
    }

    pub fn rate_limit_provider(
        &self,
        provider: DetectedProviderId,
        now_ms: u64,
        retry_after_seconds: Option<u64>,
    ) {
        let seconds = retry_after_seconds
            .unwrap_or(RATE_LIMIT_SECONDS)
            .max(RATE_LIMIT_SECONDS);
        self.block_provider(provider, now_ms, seconds);
    }

    fn mutate_durable(&self, mutate: impl FnOnce(&mut RequestPolicyDocument)) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if !inner.healthy {
            return;
        }
        let previous = inner.document.clone();
        mutate(&mut inner.document);
        if persist_document(self.directory.as_ref(), &inner.document).is_err() {
            /* The file still holds the conservative reservation written by
            begin. Keep this process closed too instead of silently falling
            back to an in memory cadence. */
            inner.document = previous;
            inner.healthy = false;
        }
    }

    fn release(&self, provider: DetectedProviderId) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.active_providers.remove(&provider);
        }
    }
}

pub const fn provider_interval_seconds(provider: DetectedProviderId) -> u64 {
    match provider {
        DetectedProviderId::Claude | DetectedProviderId::GeminiCli => 900,
        DetectedProviderId::Antigravity => 600,
        DetectedProviderId::Codex
        | DetectedProviderId::Opencode
        | DetectedProviderId::Openrouter
        | DetectedProviderId::Grok
        | DetectedProviderId::Kimi => 300,
    }
}

fn provider_spacing_seconds(provider: DetectedProviderId, account_id: &str) -> u64 {
    PROVIDER_SPACING_SECONDS
        + stable_fraction(provider, account_id, b"provider-spacing")
            % (PROVIDER_SPACING_SECONDS + 1)
}

fn jittered_account_delay(
    provider: DetectedProviderId,
    account_id: &str,
    minimum_seconds: u64,
) -> u64 {
    let spread = (minimum_seconds / 5).max(1);
    minimum_seconds
        .saturating_add(stable_fraction(provider, account_id, b"account-cadence") % (spread + 1))
}

fn stable_fraction(provider: DetectedProviderId, account_id: &str, domain: &[u8]) -> u64 {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update([0]);
    digest.update(provider.slug().as_bytes());
    digest.update([0]);
    digest.update(account_id.as_bytes());
    let bytes = digest.finalize();
    u64::from(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn valid_account_id(account_id: &str) -> bool {
    !account_id.is_empty()
        && account_id.len() <= 128
        && account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn prune_expired(document: &mut RequestPolicyDocument, now_ms: u64) {
    for state in document.providers.values_mut() {
        if state.blocked_until.is_some_and(|until| until <= now_ms) {
            state.blocked_until = None;
        }
        if state.next_request_at.is_some_and(|until| until <= now_ms) {
            state.next_request_at = None;
        }
        state.accounts.retain(|_, until| *until > now_ms);
    }
}

fn load_document(directory: Option<&PathBuf>) -> Result<RequestPolicyDocument, ()> {
    let directory = directory.ok_or(())?;
    let file = directory.join(REQUEST_POLICY_FILE_NAME);
    let Some(text) = fsx::bounded_read(&file) else {
        return match std::fs::symlink_metadata(&file) {
            Ok(_) => Err(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(RequestPolicyDocument::default())
            }
            Err(_) => Err(()),
        };
    };
    let document: RequestPolicyDocument = serde_json::from_str(&text).map_err(|_| ())?;
    validate_document(&document)?;
    Ok(document)
}

fn validate_document(document: &RequestPolicyDocument) -> Result<(), ()> {
    if document.version != REQUEST_POLICY_VERSION
        || document.providers.len() > DetectedProviderId::ALL.len()
    {
        return Err(());
    }
    for state in document.providers.values() {
        if state.accounts.len() > MAX_ACCOUNTS_PER_PROVIDER
            || state
                .blocked_until
                .is_some_and(|value| value > MAX_TIMESTAMP_EPOCH_MS)
            || state
                .next_request_at
                .is_some_and(|value| value > MAX_TIMESTAMP_EPOCH_MS)
            || state.accounts.iter().any(|(account, until)| {
                !valid_account_id(account) || *until > MAX_TIMESTAMP_EPOCH_MS
            })
        {
            return Err(());
        }
    }
    Ok(())
}

fn persist_document(
    directory: Option<&PathBuf>,
    document: &RequestPolicyDocument,
) -> Result<(), ()> {
    let directory = directory.ok_or(())?;
    validate_document(document)?;
    fsx::ensure_private_dir(directory).map_err(|_| ())?;
    let text = serde_json::to_string(document).map_err(|_| ())?;
    fsx::atomic_write(&directory.join(REQUEST_POLICY_FILE_NAME), &text).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const NOW: u64 = 1_787_136_000_000;

    fn policy(dir: &TempDir) -> RequestPolicy {
        RequestPolicy::at(Some(dir.path().to_path_buf()))
    }

    #[test]
    fn account_cadence_survives_a_process_restart() {
        let dir = TempDir::new();
        {
            let first = policy(&dir);
            let lease = first
                .begin(DetectedProviderId::Codex, "codex-account-one", NOW)
                .expect("first request");
            first.complete_after(
                DetectedProviderId::Codex,
                "codex-account-one",
                NOW,
                provider_interval_seconds(DetectedProviderId::Codex),
            );
            drop(lease);
        }
        let restarted = policy(&dir);
        assert!(matches!(
            restarted.begin(DetectedProviderId::Codex, "codex-account-one", NOW + 1_000),
            Err(GateRejection::Deferred { .. })
        ));
    }

    #[test]
    fn provider_breaker_survives_restart_and_stops_another_account() {
        let dir = TempDir::new();
        {
            let first = policy(&dir);
            let lease = first
                .begin(DetectedProviderId::Grok, "grok-account-one", NOW)
                .expect("first request");
            first.block_provider(DetectedProviderId::Grok, NOW, BLOCKED_PROVIDER_SECONDS);
            drop(lease);
        }
        let restarted = policy(&dir);
        let decision = restarted.begin(DetectedProviderId::Grok, "grok-account-two", NOW + 60_000);
        assert!(matches!(decision, Err(GateRejection::Deferred { .. })));
    }

    #[test]
    fn concurrent_refreshes_for_one_provider_collapse() {
        let dir = TempDir::new();
        let policy = policy(&dir);
        let lease = policy
            .begin(DetectedProviderId::Kimi, "kimi-account-one", NOW)
            .expect("first request");
        assert!(matches!(
            policy.begin(DetectedProviderId::Kimi, "kimi-account-two", NOW),
            Err(GateRejection::Busy)
        ));
        drop(lease);
        assert!(matches!(
            policy.begin(DetectedProviderId::Kimi, "kimi-account-two", NOW),
            Err(GateRejection::Deferred { .. })
        ));
    }

    #[test]
    fn updating_one_account_preserves_unrelated_schedule_rows() {
        let dir = TempDir::new();
        let current = policy(&dir);
        let first = current
            .begin(DetectedProviderId::Codex, "codex-account-one", NOW)
            .expect("first account");
        current.complete_after(DetectedProviderId::Codex, "codex-account-one", NOW, 300);
        drop(first);
        let later = NOW + 60_000;
        let second = current
            .begin(DetectedProviderId::Codex, "codex-account-two", later)
            .expect("second account");
        current.complete_after(DetectedProviderId::Codex, "codex-account-two", later, 300);
        drop(second);

        let restarted = policy(&dir);
        let inner = restarted.inner.lock().expect("policy state");
        let accounts = &inner
            .document
            .providers
            .get(&DetectedProviderId::Codex)
            .expect("codex state")
            .accounts;
        assert!(accounts.contains_key("codex-account-one"));
        assert!(accounts.contains_key("codex-account-two"));
    }

    #[test]
    fn corrupt_policy_fails_closed() {
        let dir = TempDir::new();
        std::fs::write(dir.path().join(REQUEST_POLICY_FILE_NAME), "not json")
            .expect("corrupt fixture");
        assert!(matches!(
            policy(&dir).begin(DetectedProviderId::Claude, "claude-account", NOW),
            Err(GateRejection::Unavailable)
        ));
    }

    #[test]
    fn every_provider_uses_the_same_durable_account_gate() {
        for provider in DetectedProviderId::ALL {
            let dir = TempDir::new();
            {
                let first = policy(&dir);
                let lease = first
                    .begin(provider, "stable-account", NOW)
                    .expect("first request");
                first.complete_after(
                    provider,
                    "stable-account",
                    NOW,
                    provider_interval_seconds(provider),
                );
                drop(lease);
            }
            let restarted = policy(&dir);
            assert!(matches!(
                restarted.begin(provider, "stable-account", NOW + 1_000),
                Err(GateRejection::Deferred { .. })
            ));
        }
    }

    #[test]
    fn every_provider_aborts_other_accounts_after_a_block_response() {
        for provider in DetectedProviderId::ALL {
            let dir = TempDir::new();
            {
                let first = policy(&dir);
                let lease = first
                    .begin(provider, "first-account", NOW)
                    .expect("first request");
                first.block_provider(provider, NOW, BLOCKED_PROVIDER_SECONDS);
                drop(lease);
            }
            let restarted = policy(&dir);
            assert!(matches!(
                restarted.begin(provider, "remaining-account", NOW + 60_000),
                Err(GateRejection::Deferred { .. })
            ));
        }
    }

    #[test]
    fn server_retry_after_can_only_extend_the_provider_breaker() {
        let dir = TempDir::new();
        let policy = policy(&dir);
        let lease = policy
            .begin(DetectedProviderId::GeminiCli, "google-account", NOW)
            .expect("first request");
        policy.rate_limit_provider(
            DetectedProviderId::GeminiCli,
            NOW,
            Some(BLOCKED_PROVIDER_SECONDS + 60),
        );
        drop(lease);
        let retry_at =
            match policy.begin(DetectedProviderId::GeminiCli, "other-google-account", NOW) {
                Err(rejection) => rejection,
                Ok(_) => panic!("provider breaker was bypassed"),
            };
        assert_eq!(
            retry_at,
            GateRejection::Deferred {
                retry_at: NOW + (BLOCKED_PROVIDER_SECONDS + 60) * 1_000
            }
        );
    }
}
