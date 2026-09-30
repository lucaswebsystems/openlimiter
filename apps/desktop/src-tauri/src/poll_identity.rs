use crate::connections::ConnectionRecord;
use crate::credentials::{parse_codex_session_v1, SecretStore};

use crate::provider_detection::{
    opaque_account_id, provider_singleton_account_id, resolved_credential_account_id,
    DetectedProviderId,
};
use crate::reader_registry::ProviderId;

pub(crate) fn credential_revision(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}

/// Reject expiry metadata and JWT expiry before any saved credential is sent.
pub(crate) fn credential_expired(secret: &str, now_ms: u64) -> bool {
    use base64::Engine;
    fn inspect(value: &serde_json::Value, now: u64) -> bool {
        match value {
            serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
                if matches!(
                    key.as_str(),
                    "exp" | "expiresAt" | "expires_at" | "expiry_date" | "expiry" | "expires"
                ) {
                    let number = value
                        .as_f64()
                        .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
                        .filter(|number| number.is_finite());
                    if let Some(number) = number {
                        let milliseconds = if number < 100_000_000_000.0 {
                            number * 1000.0
                        } else {
                            number
                        };
                        return milliseconds <= now as f64;
                    }
                    if let Some(text) = value.as_str() {
                        if let Ok(date) = chrono::DateTime::parse_from_rfc3339(text) {
                            return date.timestamp_millis() <= now as i64;
                        }
                    }
                }
                inspect(value, now)
            }),
            serde_json::Value::String(token) => token
                .split('.')
                .nth(1)
                .and_then(|part| {
                    base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .decode(part)
                        .ok()
                })
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|payload| {
                    payload
                        .get("exp")
                        .and_then(|v| v.as_u64())
                        .is_some_and(|exp| exp.saturating_mul(1000) <= now)
                }),
            _ => false,
        }
    }
    let value = serde_json::from_str(secret)
        .unwrap_or_else(|_| serde_json::Value::String(secret.to_string()));
    inspect(&value, now_ms)
}

#[cfg(test)]
mod expiry_tests {
    use super::*;
    #[test]
    fn rejects_expiry_at_equality_and_nested_oauth() {
        assert!(credential_expired(
            r#"{"claudeAiOauth":{"expiresAt":1700000000000}}"#,
            1700000000000
        ));
        assert!(!credential_expired(
            r#"{"expires_at":1900000000}"#,
            1700000000000
        ));
        assert!(credential_expired(
            r#"{"expires_at":1700000000.0}"#,
            1700000000000
        ));
        assert!(credential_expired(
            "header.eyJleHAiOjE3MDAwMDAwMDB9.signature",
            1700000000000
        ));
    }
}

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

    pub(crate) const fn provider_id(&self) -> ProviderId {
        self.provider_id
    }

    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }
}

pub(crate) const fn detected_provider(provider_id: ProviderId) -> DetectedProviderId {
    match provider_id {
        ProviderId::Openrouter => DetectedProviderId::Openrouter,
        ProviderId::Codex => DetectedProviderId::Codex,
        ProviderId::Antigravity => DetectedProviderId::Antigravity,
        ProviderId::Opencode => DetectedProviderId::Opencode,
        ProviderId::Grok => DetectedProviderId::Grok,
        ProviderId::Kimi => DetectedProviderId::Kimi,
        ProviderId::Cursor => DetectedProviderId::Cursor,
        ProviderId::Synthetic => DetectedProviderId::Synthetic,
        ProviderId::Zai => DetectedProviderId::Zai,
        ProviderId::Minimax => DetectedProviderId::Minimax,
        ProviderId::Cline => DetectedProviderId::Cline,
    }
}

pub(crate) fn resolve_connection(
    record: &ConnectionRecord,
    secrets: &impl SecretStore,
) -> PollIdentity {
    let stored = secrets.read_secret(&record.id).ok();
    identity_for_secret(record, stored.as_ref().map(|secret| secret.as_str()))
}

/// The identity a saved connection's credential names: the one its readings,
/// its suppressions and its coverage are filed under. A collection derives it
/// from the credential it actually sent, so a key changed mid poll can never
/// file one account's answer under another.
pub(crate) fn identity_for_secret(record: &ConnectionRecord, secret: Option<&str>) -> PollIdentity {
    let detected = detected_provider(record.provider_id);
    /* A saved key is its fingerprint, so the key a person saved and the same
    key found in a client configuration are one account, polled once through
    the saved connection. See account_identity.rs. */
    if crate::account_identity::route(detected) == Some(crate::account_identity::AccountRoute::ApiKey) {
        let account_id = secret.map_or_else(
            || provider_singleton_account_id(detected),
            |secret| crate::account_identity::key_account_id(detected, secret),
        );
        return PollIdentity {
            provider_id: record.provider_id,
            account_id,
        };
    }
    let account_id = if record.provider_id == ProviderId::Codex {
        let provider_account_id = record.codex_account_id.clone().or_else(|| {
            parse_codex_session_v1(secret?)
                .ok()
                .map(|session| session.account_id.to_string())
        });
        provider_account_id.map_or_else(
            || provider_singleton_account_id(DetectedProviderId::Codex),
            |provider_account_id| {
                opaque_account_id(DetectedProviderId::Codex, &provider_account_id)
            },
        )
    } else {
        secret
            .and_then(|secret| resolved_credential_account_id(detected, secret))
            .unwrap_or_else(|| provider_singleton_account_id(detected))
    };
    PollIdentity {
        provider_id: record.provider_id,
        account_id,
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    use crate::reader_registry::{CredentialKind, ReaderId};

    #[test]
    fn a_saved_key_is_filed_under_the_key_that_was_sent() {
        /* The identity follows the credential a request carried, so a key
        replaced mid poll files its answer under the new key, never the old. */
        let record = ConnectionRecord {
            id: "fixture-connection".to_string(),
            provider_id: ProviderId::Synthetic,
            reader_id: ReaderId::SyntheticQuotas,
            credential_kind: CredentialKind::SyntheticKey,
            account_alias: "fixture".to_string(),
            codex_account_id: None,
            masked_label: "fixture".to_string(),
            created_at: 0,
            base_seconds: 0,
            next_refresh_at: None,
            last_attempt_at: None,
            last_success_at: None,
            attempt_generation: 0,
            body_delivered_generation: None,
            last_completion_at: None,
            ever_connected: false,
            consecutive_failures: 0,
            status: "READY_TO_ENABLE".to_string(),
            legacy_grandfathered: false,
            pause_reason: None,
        };
        let synthetic = DetectedProviderId::Synthetic;
        let first = identity_for_secret(&record, Some("fixture-key-one"));
        let second = identity_for_secret(&record, Some("fixture-key-two"));
        assert_eq!(
            first.account_id(),
            crate::account_identity::key_account_id(synthetic, "fixture-key-one")
        );
        assert_ne!(first, second);
        assert_eq!(
            identity_for_secret(&record, None).account_id(),
            provider_singleton_account_id(synthetic)
        );
    }
}
