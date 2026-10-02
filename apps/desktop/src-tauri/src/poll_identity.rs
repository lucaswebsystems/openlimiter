use crate::connections::ConnectionRecord;
use crate::credentials::SecretStore;

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
    }
}

pub(crate) fn resolve_connection(
    record: &ConnectionRecord,
    secrets: &impl SecretStore,
) -> PollIdentity {
    let account_id = if record.provider_id == ProviderId::Openrouter {
        /* OpenRouter keys do not expose a stable provider account identity.
        Each saved connection is therefore the account boundary used by the
        collector cache, authorization policy, UI row, and poll planner. */
        record.id.clone()
    } else if record.provider_id == ProviderId::Codex {
        record.codex_account_id.clone().map_or_else(
            || provider_singleton_account_id(DetectedProviderId::Codex),
            |provider_account_id| {
                opaque_account_id(DetectedProviderId::Codex, &provider_account_id)
            },
        )
    } else {
        let detected = detected_provider(record.provider_id);
        secrets
            .read_secret(&record.id)
            .ok()
            .and_then(|stored| resolved_credential_account_id(detected, &stored))
            .unwrap_or_else(|| provider_singleton_account_id(detected))
    };
    PollIdentity {
        provider_id: record.provider_id,
        account_id,
    }
}
