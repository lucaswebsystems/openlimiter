use crate::connections::ConnectionRecord;
use crate::credentials::{parse_codex_session_v1, SecretStore};
use sha2::{Digest, Sha256};

use crate::provider_detection::{
    opaque_account_id, resolved_credential_account_id, DetectedProviderId,
};
use crate::reader_registry::ProviderId;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PollIdentity {
    provider_id: ProviderId,
    account_id: String,
}

impl PollIdentity {
    pub(crate) fn detected(provider_id: ProviderId, account_id: String) -> Self {
        Self {
            provider_id,
            account_id,
        }
    }

    pub(crate) fn unique(record: &ConnectionRecord) -> Self {
        Self {
            provider_id: record.provider_id,
            account_id: format!("connection:{}", record.id),
        }
    }

    pub(crate) const fn provider_id(&self) -> ProviderId {
        self.provider_id
    }
}

/* The wildcard is intentionally unreachable for the current closed enum. It
stays here so a provider added by another lane receives credential bound
deduplication until its richer detected identity is wired. */
#[allow(unreachable_patterns)]
fn detected_provider(provider_id: ProviderId) -> Option<DetectedProviderId> {
    match provider_id {
        ProviderId::Openrouter => Some(DetectedProviderId::Openrouter),
        ProviderId::Codex => Some(DetectedProviderId::Codex),
        ProviderId::Antigravity => Some(DetectedProviderId::Antigravity),
        ProviderId::Opencode => Some(DetectedProviderId::Opencode),
        _ => None,
    }
}

fn credential_digest(credential: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(credential.as_bytes());
    format!("{:x}", digest.finalize())
}

pub(crate) fn resolve_connection(
    record: &ConnectionRecord,
    secrets: &impl SecretStore,
) -> Option<PollIdentity> {
    let account_id = if record.provider_id == ProviderId::Codex {
        let provider_account_id = record.codex_account_id.clone().or_else(|| {
            let stored = secrets.read_secret(&record.id).ok()?;
            parse_codex_session_v1(&stored)
                .ok()
                .map(|session| session.account_id.to_string())
        })?;
        opaque_account_id(DetectedProviderId::Codex, &provider_account_id)
    } else {
        let stored = secrets.read_secret(&record.id).ok()?;
        detected_provider(record.provider_id).map_or_else(
            || credential_digest(&stored),
            |detected| resolved_credential_account_id(detected, &stored),
        )
    };
    Some(PollIdentity {
        provider_id: record.provider_id,
        account_id,
    })
}
