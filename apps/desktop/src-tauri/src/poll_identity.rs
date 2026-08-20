use crate::connections::ConnectionRecord;
use crate::credentials::{parse_codex_session_v1, SecretStore};
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

fn detected_provider(provider_id: ProviderId) -> DetectedProviderId {
    match provider_id {
        ProviderId::Openrouter => DetectedProviderId::Openrouter,
        ProviderId::Codex => DetectedProviderId::Codex,
        ProviderId::Antigravity => DetectedProviderId::Antigravity,
        ProviderId::Opencode => DetectedProviderId::Opencode,
    }
}

pub(crate) fn resolve_connection(
    record: &ConnectionRecord,
    secrets: &impl SecretStore,
) -> Option<PollIdentity> {
    let detected = detected_provider(record.provider_id);
    let account_id = if record.provider_id == ProviderId::Codex {
        let provider_account_id = record.codex_account_id.clone().or_else(|| {
            let stored = secrets.read_secret(&record.id).ok()?;
            parse_codex_session_v1(&stored)
                .ok()
                .map(|session| session.account_id.to_string())
        })?;
        opaque_account_id(detected, &provider_account_id)
    } else {
        let stored = secrets.read_secret(&record.id).ok()?;
        resolved_credential_account_id(detected, &stored)
    };
    Some(PollIdentity {
        provider_id: record.provider_id,
        account_id,
    })
}
