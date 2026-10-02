use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::connections::MAX_TIMESTAMP_EPOCH_MS;
use crate::fsx;
use crate::provider_detection::DetectedProviderId;

pub const REQUEST_POLICY_FILE_NAME: &str = "request-policy.json";
const REQUEST_POLICY_LOCK_FILE_NAME: &str = "request-policy.lock";
const REQUEST_POLICY_VERSION: u8 = 1;
const MAX_ACCOUNTS_PER_PROVIDER: usize = 128;
const PROVIDER_SPACING_SECONDS: u64 = 15;
const PROVISIONAL_REQUEST_SECONDS: u64 = 60;
pub const BLOCKED_PROVIDER_SECONDS: u64 = 86_400;
pub const RATE_LIMIT_SECONDS: u64 = 60;
const MAX_SERVER_DELAY_SECONDS: u64 = 7 * 86_400;
const LOCK_ACQUIRE_TIMEOUT: Duration = Duration::from_millis(500);
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(10);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderPolicyState {
    #[serde(default)]
    refusal_revisions: BTreeMap<String, String>,
    #[serde(default)]
    attempts: BTreeMap<String, u32>,
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
    credential_revision: Option<String>,
    active_shared: Option<MachineLease>,
    document: RequestPolicyDocument,
    healthy: bool,
    active_provider: Option<DetectedProviderId>,
    active_lock: Option<File>,
}

pub struct RequestPolicy {
    directory: Option<PathBuf>,
    clock: Option<fn() -> u64>,
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
        let mut policy = Self::at(crate::state::state_directory());
        policy.clock = Some(crate::connections::now_epoch_ms);
        policy
    }

    pub fn at(directory: Option<PathBuf>) -> Self {
        let healthy = directory.is_some();
        Self {
            directory,
            clock: None,
            inner: Mutex::new(PolicyInner {
                credential_revision: None,
                document: RequestPolicyDocument::default(),
                healthy,
                active_provider: None,
                active_lock: None,
                active_shared: None,
            }),
        }
    }

    pub fn begin(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
        now_ms: u64,
    ) -> Result<RequestLease<'_>, GateRejection> {
        self.begin_with_revision(provider, account_id, now_ms, None)
    }

    pub(crate) fn begin_with_revision(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
        now_ms: u64,
        revision: Option<&str>,
    ) -> Result<RequestLease<'_>, GateRejection> {
        if !valid_account_id(account_id) || now_ms > MAX_TIMESTAMP_EPOCH_MS {
            return Err(GateRejection::Unavailable);
        }
        {
            let mut inner = self.inner.lock().map_err(|_| GateRejection::Unavailable)?;
            if !inner.healthy {
                return Err(GateRejection::Unavailable);
            }
            if inner.active_provider.is_some() {
                return Err(GateRejection::Busy);
            }
            /* Reserve this authority before waiting for the OS lock so two
            threads in one process cannot race two file handles. */
            inner.active_provider = Some(provider);
        }

        let lock_file = match acquire_document_lock(self.directory.as_ref()) {
            Ok(file) => file,
            Err(rejection) => {
                self.cancel_begin(provider, matches!(rejection, GateRejection::Unavailable));
                return Err(rejection);
            }
        };
        let mut document = match load_document(self.directory.as_ref()) {
            Ok(document) => document,
            Err(()) => {
                let _ = FileExt::unlock(&lock_file);
                self.cancel_begin(provider, true);
                return Err(GateRejection::Unavailable);
            }
        };
        prune_expired(&mut document, now_ms);
        let mut changed_refusal = false;
        if let Some(state) = document.providers.get_mut(&provider) {
            if state
                .refusal_revisions
                .get(account_id)
                .is_some_and(|previous| revision.is_some_and(|current| current != previous))
            {
                changed_refusal = true;
                state.accounts.remove(account_id);
                state.refusal_revisions.remove(account_id);
                state.attempts.remove(account_id);
            }
        }
        if let Some(state) = document.providers.get(&provider) {
            if let Some(retry_at) = state.blocked_until.filter(|until| now_ms < *until) {
                let _ = FileExt::unlock(&lock_file);
                self.cancel_begin(provider, false);
                return Err(GateRejection::Deferred { retry_at });
            }
            if let Some(retry_at) = state.next_request_at.filter(|until| now_ms < *until) {
                let _ = FileExt::unlock(&lock_file);
                self.cancel_begin(provider, false);
                return Err(GateRejection::Deferred { retry_at });
            }
            if let Some(retry_at) = state
                .accounts
                .get(account_id)
                .copied()
                .filter(|until| now_ms < *until)
            {
                let _ = FileExt::unlock(&lock_file);
                self.cancel_begin(provider, false);
                return Err(GateRejection::Deferred { retry_at });
            }
            if !state.accounts.contains_key(account_id)
                && state.accounts.len() >= MAX_ACCOUNTS_PER_PROVIDER
            {
                let _ = FileExt::unlock(&lock_file);
                self.cancel_begin(provider, false);
                return Err(GateRejection::Unavailable);
            }
        }

        let shared_provider = if matches!(
            provider,
            DetectedProviderId::Antigravity | DetectedProviderId::GeminiCli
        ) {
            "code-assist"
        } else {
            provider.slug()
        };
        let shared = match MachineLease::acquire_account_with_refusal_change(
            self.directory.as_ref().unwrap(),
            shared_provider,
            Some(account_id),
            now_ms,
            changed_refusal,
        ) {
            Ok(lease) => lease,
            Err(rejection) => {
                let _ = FileExt::unlock(&lock_file);
                self.cancel_begin(provider, false);
                return Err(rejection);
            }
        };
        let state = document.providers.entry(provider).or_default();
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
        if persist_document(self.directory.as_ref(), &document).is_err() {
            let _ = FileExt::unlock(&lock_file);
            self.cancel_begin(provider, true);
            return Err(GateRejection::Unavailable);
        }
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                let _ = FileExt::unlock(&lock_file);
                return Err(GateRejection::Unavailable);
            }
        };
        if !inner.healthy || inner.active_provider != Some(provider) {
            let _ = FileExt::unlock(&lock_file);
            inner.active_provider = None;
            return Err(GateRejection::Unavailable);
        }
        inner.document = document;
        inner.active_lock = Some(lock_file);
        inner.active_shared = Some(shared);
        inner.credential_revision = revision.map(str::to_string);
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
        let now_ms = self.clock.map_or(now_ms, |clock| clock().max(now_ms));
        let delay = jittered_account_delay(provider, account_id, minimum_seconds.max(1));
        self.complete_shared(now_ms.saturating_add(delay.saturating_mul(1000)), 0);
        self.mutate_durable(|document| {
            document
                .providers
                .entry(provider)
                .or_default()
                .refusal_revisions
                .remove(account_id);
            document
                .providers
                .entry(provider)
                .or_default()
                .attempts
                .remove(account_id);
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

    pub(crate) fn cancel_unstarted(&self, provider: DetectedProviderId, account_id: &str) {
        self.mutate_durable(|document| {
            if let Some(state) = document.providers.get_mut(&provider) {
                state.accounts.remove(account_id);
                state.next_request_at = None;
            }
        });
    }

    pub(crate) fn refuse_account(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
        now_ms: u64,
        denied: bool,
    ) {
        let now_ms = self.clock.map_or(now_ms, |clock| clock().max(now_ms));
        let next = now_ms.saturating_add(BLOCKED_PROVIDER_SECONDS * 1000);
        let revision = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.credential_revision.clone());
        self.complete_shared(next, 0);
        self.mutate_durable(|document| {
            let state = document.providers.entry(provider).or_default();
            state.attempts.remove(account_id);
            state.accounts.insert(account_id.to_string(), next);
            if let Some(revision) = revision {
                state
                    .refusal_revisions
                    .insert(account_id.to_string(), revision);
            }
        });
        if let Some(directory) = &self.directory {
            let writer = crate::cache_write::CacheWriter::at(Some(directory.clone()));
            let _ = writer.record_availability(
                &provider.slug().to_uppercase().replace('-', "_"),
                Some(account_id),
                if denied {
                    "access_denied"
                } else {
                    "expired_credentials"
                },
                None,
                now_ms,
            );
        }
    }

    pub fn block_provider(&self, provider: DetectedProviderId, now_ms: u64, minimum_seconds: u64) {
        let now_ms = self.clock.map_or(now_ms, |clock| clock().max(now_ms));
        let delay = minimum_seconds.max(BLOCKED_PROVIDER_SECONDS);
        let blocked_until = now_ms.saturating_add(delay.saturating_mul(1_000));
        self.complete_shared(blocked_until, 0);
        self.mutate_durable(|document| {
            let state = document.providers.entry(provider).or_default();
            state.blocked_until = Some(
                state
                    .blocked_until
                    .map_or(blocked_until, |current| current.max(blocked_until)),
            );
        });
    }

    pub fn rate_limit_account(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
        now_ms: u64,
        retry_after_seconds: Option<u64>,
    ) {
        self.retry_account(provider, account_id, now_ms, retry_after_seconds, true);
    }

    pub(crate) fn retry_account(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
        now_ms: u64,
        retry_after_seconds: Option<u64>,
        rate_limited: bool,
    ) {
        // Retry-After was measured when the response arrived, not at request start.
        let now_ms = self.clock.map_or(now_ms, |clock| clock().max(now_ms));
        if !valid_account_id(account_id) || now_ms > MAX_TIMESTAMP_EPOCH_MS {
            return;
        }
        let attempts = self
            .inner
            .lock()
            .ok()
            .map(|inner| {
                inner
                    .document
                    .providers
                    .get(&provider)
                    .and_then(|state| state.attempts.get(account_id).copied())
                    .unwrap_or(0)
                    .max(
                        inner
                            .active_shared
                            .as_ref()
                            .map_or(0, |lease| lease.attempts),
                    )
            })
            .unwrap_or(0);
        let decision = retry_decision(
            attempts,
            retry_after_seconds.map(|seconds| now_ms.saturating_add(seconds.saturating_mul(1000))),
            now_ms,
            0,
            MAX_SERVER_DELAY_SECONDS,
        );
        let retry_at = decision.next_allowed_at.min(MAX_TIMESTAMP_EPOCH_MS);
        self.complete_shared(retry_at, attempts.saturating_add(1));
        if let Some(directory) = self.directory.as_ref().filter(|_| rate_limited) {
            let writer = crate::cache_write::CacheWriter::at(Some(directory.clone()));
            let _ = writer.record_availability(
                &provider.slug().to_uppercase().replace('-', "_"),
                Some(account_id),
                "rate_limited",
                Some(retry_at),
                now_ms,
            );
        }
        self.mutate_durable(|document| {
            let state = document.providers.entry(provider).or_default();
            state
                .attempts
                .insert(account_id.to_string(), attempts.saturating_add(1));
            if decision.blocked_until.is_some() {
                state.blocked_until = Some(retry_at);
            }
            /* The account row replaces begin's crash reservation. The provider
            row carries the same deadline so a second account or process does
            not hammer an endpoint that just asked this process to stop. */
            state.accounts.insert(account_id.to_string(), retry_at);
            state.next_request_at = Some(
                state
                    .next_request_at
                    .map_or(retry_at, |current| current.max(retry_at)),
            );
        });
    }

    fn complete_shared(&self, next: u64, attempts: u32) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(lease) = inner.active_shared.as_ref() {
                if lease.complete(next, attempts).is_err() {
                    inner.healthy = false;
                }
            }
        }
    }

    fn mutate_durable(&self, mutate: impl FnOnce(&mut RequestPolicyDocument)) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if !inner.healthy || inner.active_lock.is_none() {
            return;
        }
        /* The OS lock stored in active_lock remains held while this fresh read,
        mutation, and atomic replace run. Never mutate a constructor snapshot:
        another process may have committed a provider row since then. */
        let Ok(mut document) = load_document(self.directory.as_ref()) else {
            inner.healthy = false;
            return;
        };
        mutate(&mut document);
        if persist_document(self.directory.as_ref(), &document).is_err() {
            /* The file still holds the conservative reservation written by
            begin. Keep this process closed too instead of silently falling
            back to an in memory cadence. */
            inner.healthy = false;
        } else {
            inner.document = document;
        }
    }

    fn release(&self, provider: DetectedProviderId) {
        let lock_file = self.inner.lock().ok().and_then(|mut inner| {
            if inner.active_provider != Some(provider) {
                return None;
            }
            inner.active_provider = None;
            inner.active_shared.take();
            inner.active_lock.take()
        });
        if let Some(lock_file) = lock_file {
            let _ = FileExt::unlock(&lock_file);
        }
    }

    fn cancel_begin(&self, provider: DetectedProviderId, unhealthy: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.active_provider == Some(provider) {
                inner.active_provider = None;
            }
            if unhealthy {
                inner.healthy = false;
            }
        }
    }
}

fn acquire_document_lock(directory: Option<&PathBuf>) -> Result<File, GateRejection> {
    let directory = directory.ok_or(GateRejection::Unavailable)?;
    fsx::ensure_private_dir(directory).map_err(|_| GateRejection::Unavailable)?;
    let lock_path = directory.join(REQUEST_POLICY_LOCK_FILE_NAME);
    fsx::reject_symlink(&lock_path).map_err(|_| GateRejection::Unavailable)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock_file = options
        .open(&lock_path)
        .map_err(|_| GateRejection::Unavailable)?;
    let metadata = lock_file
        .metadata()
        .map_err(|_| GateRejection::Unavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(GateRejection::Unavailable);
    }
    let started = Instant::now();
    loop {
        match lock_file.try_lock_exclusive() {
            Ok(()) => return Ok(lock_file),
            Err(_) if started.elapsed() < LOCK_ACQUIRE_TIMEOUT => {
                std::thread::sleep(LOCK_RETRY_DELAY);
            }
            Err(_) => return Err(GateRejection::Busy),
        }
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct RetryDecision {
    pub local_delay_seconds: u64,
    pub server_deadline: Option<u64>,
    pub next_allowed_at: u64,
    pub blocked_until: Option<u64>,
}

pub(crate) fn retry_decision(
    attempt: u32,
    server: Option<u64>,
    now: u64,
    jitter: u64,
    ceiling: u64,
) -> RetryDecision {
    let local = (RATE_LIMIT_SECONDS << attempt.min(4))
        .min(900)
        .saturating_add(jitter);
    let limit = now.saturating_add(ceiling.saturating_mul(1000));
    let capped_server = server.map(|date| date.min(limit));
    RetryDecision {
        local_delay_seconds: local,
        server_deadline: capped_server,
        next_allowed_at: now
            .saturating_add(local.saturating_mul(1000))
            .max(capped_server.unwrap_or(0)),
        blocked_until: server.filter(|date| *date > limit).map(|_| limit),
    }
}

pub(crate) fn server_deadline(header: &str, now: u64) -> Option<u64> {
    let raw = header.trim();
    if !raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return raw
            .parse::<u64>()
            .ok()
            .map(|seconds| now.saturating_add(seconds.saturating_mul(1000)));
    }
    httpdate::parse_http_date(raw)
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

pub(crate) fn lease_decision(
    now: u64,
    requester: &str,
    owner: Option<&str>,
    expires: u64,
    seconds: u64,
) -> (bool, bool, String, u64) {
    let acquired = owner.is_none() || now >= expires;
    (
        acquired,
        acquired && owner.is_some_and(|owner| owner != requester),
        if acquired { requester } else { owner.unwrap() }.to_string(),
        if acquired {
            now.saturating_add(seconds.saturating_mul(1000))
        } else {
            expires
        },
    )
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineState {
    #[serde(default)]
    last_account: Option<String>,
    owner: Option<String>,
    expires_at: u64,
    token: String,
    next_allowed_at: u64,
    attempts: u32,
}

struct MachineLease {
    directory: PathBuf,
    file: PathBuf,
    token: String,
    attempts: u32,
    stop: std::sync::mpsc::Sender<()>,
}

impl MachineLease {
    fn read(file: &std::path::Path) -> Result<MachineState, ()> {
        match fsx::bounded_read(file) {
            Some(text) => serde_json::from_str(&text).map_err(|_| ()),
            None if !file.exists() => Ok(MachineState::default()),
            None => Err(()),
        }
    }

    fn acquire(
        directory: &std::path::Path,
        provider: &str,
        now: u64,
    ) -> Result<Self, GateRejection> {
        Self::acquire_account(directory, provider, None, now)
    }

    fn acquire_account(
        directory: &std::path::Path,
        provider: &str,
        account: Option<&str>,
        now: u64,
    ) -> Result<Self, GateRejection> {
        Self::acquire_account_with_refusal_change(directory, provider, account, now, false)
    }

    fn acquire_account_with_refusal_change(
        directory: &std::path::Path,
        provider: &str,
        account: Option<&str>,
        now: u64,
        changed_refusal: bool,
    ) -> Result<Self, GateRejection> {
        let file = directory.join(format!("acquisition-{provider}.json"));
        let token = uuid::Uuid::new_v4().to_string();
        let mut rejection = GateRejection::Unavailable;
        let mut attempts = 0;
        crate::cache_write::CacheWriter::policy_transaction(directory, || {
            fsx::reject_symlink(&file).map_err(|_| ())?;
            let mut state = Self::read(&file)?;
            let (acquired, _, _, expires) =
                lease_decision(now, "desktop", state.owner.as_deref(), state.expires_at, 60);
            if !acquired {
                rejection = GateRejection::Busy;
                return Err(());
            }
            let same_account =
                state.last_account.is_none() || account == state.last_account.as_deref();
            // Only the local refusal revision can release its shared deadline.
            // The CLI computes its revision from different source metadata.
            if same_account && changed_refusal {
                state.next_allowed_at = 0;
                state.attempts = 0;
            }
            attempts = if same_account { state.attempts } else { 0 };
            if now < state.next_allowed_at
                && (account.is_none()
                    || state.last_account.is_none()
                    || account == state.last_account.as_deref())
            {
                rejection = GateRejection::Deferred {
                    retry_at: state.next_allowed_at,
                };
                return Err(());
            }
            state.owner = Some("desktop".to_string());
            state.expires_at = expires;
            state.token = token.clone();
            state.last_account = account.map(str::to_string);
            if !same_account {
                state.next_allowed_at = 0;
                state.attempts = 0;
            }
            fsx::atomic_write(&file, &serde_json::to_string(&state).map_err(|_| ())?)
                .map_err(|_| ())
        })
        .map_err(|_| rejection)?;
        let (stop, receiver) = std::sync::mpsc::channel();
        let heartbeat_directory = directory.to_path_buf();
        let heartbeat_file = file.clone();
        let heartbeat_token = token.clone();
        let started = Instant::now();
        std::thread::spawn(move || {
            while matches!(
                receiver.recv_timeout(Duration::from_secs(20)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                let at = now.saturating_add(started.elapsed().as_millis() as u64);
                let result = crate::cache_write::CacheWriter::policy_transaction(
                    &heartbeat_directory,
                    || {
                        let mut state = Self::read(&heartbeat_file)?;
                        if state.token != heartbeat_token
                            || state.owner.as_deref() != Some("desktop")
                            || at >= state.expires_at
                        {
                            return Err(());
                        }
                        state.expires_at = at.saturating_add(60_000);
                        fsx::atomic_write(
                            &heartbeat_file,
                            &serde_json::to_string(&state).map_err(|_| ())?,
                        )
                        .map_err(|_| ())
                    },
                );
                if result.is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            directory: directory.to_path_buf(),
            file,
            token,
            attempts,
            stop,
        })
    }

    fn mutate(&self, action: impl FnOnce(&mut MachineState)) -> Result<(), ()> {
        crate::cache_write::CacheWriter::policy_transaction(&self.directory, || {
            let mut state = Self::read(&self.file)?;
            if state.token != self.token {
                return Err(());
            }
            action(&mut state);
            fsx::atomic_write(&self.file, &serde_json::to_string(&state).map_err(|_| ())?)
                .map_err(|_| ())
        })
    }

    fn complete(&self, next: u64, attempts: u32) -> Result<(), ()> {
        self.mutate(|state| {
            state.next_allowed_at = state.next_allowed_at.max(next);
            state.attempts = attempts;
        })
    }
}

impl Drop for MachineLease {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        let _ = self.mutate(|state| {
            state.owner = None;
            state.expires_at = 0;
        });
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
        | DetectedProviderId::Kimi
        | DetectedProviderId::Cursor => 300,
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
        state
            .refusal_revisions
            .retain(|account, _| state.accounts.contains_key(account));
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
            || state.refusal_revisions.len() > MAX_ACCOUNTS_PER_PROVIDER
            || state.refusal_revisions.iter().any(|(account, revision)| {
                !state.accounts.contains_key(account) || revision.len() > 256
            })
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

    fn millis(value: &serde_json::Value) -> u64 {
        chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap())
            .unwrap()
            .timestamp_millis() as u64
    }

    #[test]
    fn refusal_revision_survives_restart_and_unchanged_waits_exactly_a_day() {
        for changed in [false, true] {
            let dir = TempDir::new();
            let first = policy(&dir);
            let lease = first
                .begin_with_revision(
                    DetectedProviderId::Claude,
                    "account-one",
                    NOW,
                    Some("revision-one"),
                )
                .unwrap();
            first.refuse_account(DetectedProviderId::Claude, "account-one", NOW, false);
            drop(lease);
            drop(first);
            let restarted = policy(&dir);
            let revision = if changed {
                "revision-two"
            } else {
                "revision-one"
            };
            let at = NOW + 60_000;
            let attempt = restarted.begin_with_revision(
                DetectedProviderId::Claude,
                "account-one",
                at,
                Some(revision),
            );
            if changed {
                assert!(attempt.is_ok());
            } else {
                assert!(
                    matches!(attempt, Err(GateRejection::Deferred { retry_at }) if retry_at == NOW + 86_400_000)
                );
                assert!(restarted
                    .begin_with_revision(
                        DetectedProviderId::Claude,
                        "account-one",
                        NOW + 86_400_000,
                        Some(revision)
                    )
                    .is_ok());
            }
        }
    }

    #[test]
    fn refusal_and_rate_limit_availability_only_change_the_failing_account() {
        for denied in [None, Some(false), Some(true)] {
            let dir = TempDir::new();
            let writer = crate::cache_write::CacheWriter::at(Some(dir.path().to_path_buf()));
            writer
                .record_availability("CODEX", Some("healthy-account"), "fresh", None, NOW)
                .unwrap();
            let file = dir.path().join(crate::cache_write::CACHE_FILE_NAME);
            let before: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            let policy = policy(&dir);
            let _lease = policy
                .begin_with_revision(
                    DetectedProviderId::Codex,
                    "failing-account",
                    NOW,
                    Some("revision-one"),
                )
                .unwrap();
            if let Some(denied) = denied {
                policy.refuse_account(DetectedProviderId::Codex, "failing-account", NOW, denied);
            } else {
                policy.rate_limit_account(DetectedProviderId::Codex, "failing-account", NOW, None);
            }
            let after: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
            let rows = after["snapshots"].as_array().unwrap();
            assert_eq!(
                rows.iter()
                    .find(|row| row["accountId"] == "healthy-account")
                    .unwrap(),
                &before["snapshots"][0]
            );
            let failed = rows
                .iter()
                .find(|row| row["accountId"] == "failing-account")
                .unwrap();
            assert_eq!(
                failed["availability"],
                match denied {
                    None => "rate_limited",
                    Some(false) => "expired_credentials",
                    Some(true) => "access_denied",
                }
            );
            assert_eq!(failed.get("retryAt").is_some(), denied.is_none());
        }
    }

    #[test]
    fn a_second_account_does_not_inherit_the_first_accounts_attempts() {
        let dir = TempDir::new();
        let policy = policy(&dir);
        let lease = policy
            .begin(DetectedProviderId::Codex, "account-one", NOW)
            .unwrap();
        policy.rate_limit_account(DetectedProviderId::Codex, "account-one", NOW, None);
        drop(lease);
        let at = NOW + 60_000;
        let _lease = policy
            .begin(DetectedProviderId::Codex, "account-two", at)
            .unwrap();
        policy.rate_limit_account(DetectedProviderId::Codex, "account-two", at, None);
        let document = load_document(Some(&dir.path().to_path_buf())).unwrap();
        assert_eq!(
            document.providers[&DetectedProviderId::Codex].accounts["account-two"],
            at + 60_000
        );
    }

    #[test]
    fn every_shared_policy_vector() {
        use crate::cache_write::{freshness_policy, policy_iso};
        let document: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/contracts/policy-vectors.json"
        ))
        .unwrap();
        let vectors = &document["vectors"];
        for vector in vectors["retry"].as_array().unwrap() {
            let input = &vector["input"];
            let now = millis(&input["now"]);
            let decision = retry_decision(
                input["attemptCount"].as_u64().unwrap() as u32,
                input["retryAfter"]
                    .as_str()
                    .and_then(|header| server_deadline(header, now)),
                now,
                input["jitterSeconds"].as_u64().unwrap(),
                if input["layer"] == "collector" {
                    86400
                } else {
                    604800
                },
            );
            let actual = serde_json::json!({ "localDelaySeconds": decision.local_delay_seconds,
                "serverDeadline": decision.server_deadline.map(policy_iso), "nextAllowedAt": policy_iso(decision.next_allowed_at),
                "blockedUntil": decision.blocked_until.map(policy_iso) });
            assert_eq!(actual, vector["expected"], "{}", vector["id"]);
        }
        for vector in vectors["lease"].as_array().unwrap() {
            let input = &vector["input"];
            let (acquired, takeover, owner, expires) = lease_decision(
                millis(&input["now"]),
                input["requester"].as_str().unwrap(),
                input["owner"].as_str(),
                if input["expiresAt"].is_null() {
                    0
                } else {
                    millis(&input["expiresAt"])
                },
                input["leaseSeconds"].as_u64().unwrap(),
            );
            assert_eq!(
                serde_json::json!({"acquired": acquired, "takeover": takeover, "owner": owner, "expiresAt": policy_iso(expires)}),
                vector["expected"],
                "{}",
                vector["id"]
            );
        }
        for vector in vectors["freshness"].as_array().unwrap() {
            let input = &vector["input"];
            let (ttl, expires, availability) = freshness_policy(
                input["sourceClass"].as_str().unwrap(),
                millis(&input["observedAt"]) as i64,
                millis(&input["now"]) as i64,
            );
            assert_eq!(
                serde_json::json!({"ttlSeconds": ttl, "expiresAt": policy_iso(expires as u64), "availability": availability}),
                vector["expected"],
                "{}",
                vector["id"]
            );
        }
    }

    #[test]
    fn shared_cli_lease_takeover_and_stale_owner_fencing() {
        let dir = TempDir::new();
        let file = dir.path().join("acquisition-claude.json");
        std::fs::write(&file, serde_json::json!({"owner": "cli", "expiresAt": NOW + 1, "token": "cli-instance", "nextAllowedAt": 0, "attempts": 2}).to_string()).unwrap();
        assert!(matches!(
            MachineLease::acquire(dir.path(), "claude", NOW),
            Err(GateRejection::Busy)
        ));
        let first = MachineLease::acquire(dir.path(), "claude", NOW + 1).unwrap();
        assert!(matches!(
            MachineLease::acquire(dir.path(), "claude", NOW + 1),
            Err(GateRejection::Busy)
        ));
        let second = MachineLease::acquire(dir.path(), "claude", NOW + 60_001).unwrap();
        assert!(first.complete(NOW, 0).is_err());
        drop(first);
        assert_eq!(MachineLease::read(&file).unwrap().token, second.token);
        second.complete(NOW + 900_000, 3).unwrap();
        drop(second);
        assert!(matches!(
            MachineLease::acquire(dir.path(), "claude", NOW + 100_000),
            Err(GateRejection::Deferred { .. })
        ));
    }

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

        let document = load_document(Some(&dir.path().to_path_buf())).expect("policy state");
        let accounts = &document
            .providers
            .get(&DetectedProviderId::Codex)
            .expect("codex state")
            .accounts;
        assert!(accounts.contains_key("codex-account-one"));
        assert!(accounts.contains_key("codex-account-two"));
    }

    #[test]
    fn independent_authorities_cannot_overlap_one_request() {
        let dir = TempDir::new();
        let first = policy(&dir);
        let lease = first
            .begin(DetectedProviderId::Codex, "codex-account-one", NOW)
            .expect("first authority reserves the shared policy");
        let second = policy(&dir);
        let started = Instant::now();
        assert!(matches!(
            second.begin(DetectedProviderId::Codex, "codex-account-two", NOW),
            Err(GateRejection::Busy)
        ));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "lock contention must fail closed without hanging a scan"
        );
        first.complete_after(DetectedProviderId::Codex, "codex-account-one", NOW, 300);
        drop(lease);

        assert!(matches!(
            second.begin(DetectedProviderId::Codex, "codex-account-two", NOW),
            Err(GateRejection::Deferred { .. })
        ));
    }

    #[test]
    fn independent_authorities_preserve_each_others_provider_rows() {
        let dir = TempDir::new();
        let first = policy(&dir);
        let first_lease = first
            .begin(DetectedProviderId::Codex, "codex-account", NOW)
            .expect("first provider request");
        first.complete_after(DetectedProviderId::Codex, "codex-account", NOW, 300);
        drop(first_lease);

        let second = policy(&dir);
        let second_lease = second
            .begin(DetectedProviderId::Grok, "grok-account", NOW + 60_000)
            .expect("second provider request");
        second.block_provider(
            DetectedProviderId::Grok,
            NOW + 60_000,
            BLOCKED_PROVIDER_SECONDS,
        );
        drop(second_lease);

        let document = load_document(Some(&dir.path().to_path_buf())).expect("shared policy");
        assert!(document.providers.contains_key(&DetectedProviderId::Codex));
        assert!(document.providers.contains_key(&DetectedProviderId::Grok));
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
    fn server_retry_after_is_shared_for_the_account_and_provider() {
        let dir = TempDir::new();
        let policy = policy(&dir);
        let lease = policy
            .begin(DetectedProviderId::GeminiCli, "google-account", NOW)
            .expect("first request");
        policy.rate_limit_account(
            DetectedProviderId::GeminiCli,
            "google-account",
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

    #[test]
    fn missing_retry_uses_local_delay_and_absurd_retry_blocks_to_seven_day_ceiling() {
        for (retry_after, expected_seconds) in [(None, 60), (Some(999_999), 7 * 86400)] {
            let dir = TempDir::new();
            let policy = policy(&dir);
            let lease = policy
                .begin(DetectedProviderId::Claude, "claude-account", NOW)
                .expect("request");
            policy.rate_limit_account(
                DetectedProviderId::Claude,
                "claude-account",
                NOW,
                retry_after,
            );
            drop(lease);
            let document = load_document(Some(&dir.path().to_path_buf())).expect("policy");
            let state = document
                .providers
                .get(&DetectedProviderId::Claude)
                .expect("Claude state");
            assert_eq!(
                state.accounts.get("claude-account"),
                Some(&(NOW + expected_seconds * 1_000))
            );
            assert_eq!(state.next_request_at, Some(NOW + expected_seconds * 1_000));
        }
    }
}
