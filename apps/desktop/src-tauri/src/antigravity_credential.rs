use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

use crate::native_snapshot::epoch_ms_from_rfc3339;

const SERVICE: &str = "gemini";
const ACCOUNT: &str = "antigravity";
const WINDOWS_TARGET: &str = "gemini:antigravity";
const MAX_CREDENTIAL_BYTES: usize = 16_384;
const MAX_ACCESS_TOKEN_BYTES: usize = 4_096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AntigravityCredentialError {
    NotFound,
    Unreadable,
    Invalid,
}

pub struct AntigravityCredential {
    pub access_token: Zeroizing<String>,
    pub expires_at_ms: Option<u64>,
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    token: Token<'a>,
}

#[derive(Deserialize)]
struct Token<'a> {
    #[serde(borrow)]
    access_token: &'a str,
    #[serde(default, borrow)]
    token_type: Option<&'a str>,
    #[serde(default, borrow)]
    expiry: Option<&'a str>,
}

fn valid_access_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ACCESS_TOKEN_BYTES
        && !value.chars().any(char::is_control)
}

fn parse(raw: &[u8]) -> Result<AntigravityCredential, AntigravityCredentialError> {
    if raw.is_empty() || raw.len() > MAX_CREDENTIAL_BYTES {
        return Err(AntigravityCredentialError::Invalid);
    }
    let envelope: Envelope<'_> =
        serde_json::from_slice(raw).map_err(|_| AntigravityCredentialError::Invalid)?;
    if !valid_access_token(envelope.token.access_token)
        || envelope
            .token
            .token_type
            .is_some_and(|value| !value.eq_ignore_ascii_case("bearer"))
    {
        return Err(AntigravityCredentialError::Invalid);
    }
    let expires_at_ms = match envelope.token.expiry {
        Some(value) => {
            Some(epoch_ms_from_rfc3339(value).ok_or(AntigravityCredentialError::Invalid)?)
        }
        None => None,
    };
    Ok(AntigravityCredential {
        access_token: Zeroizing::new(envelope.token.access_token.to_string()),
        expires_at_ms,
    })
}

#[cfg(windows)]
fn read_raw() -> Result<Zeroizing<Vec<u8>>, AntigravityCredentialError> {
    use keyring_core::api::CredentialStoreApi;

    let store = windows_native_keyring_store::Store::new()
        .map_err(|_| AntigravityCredentialError::Unreadable)?;
    let modifiers = std::collections::HashMap::from([("target", WINDOWS_TARGET)]);
    let entry = store
        .build(SERVICE, ACCOUNT, Some(&modifiers))
        .map_err(|_| AntigravityCredentialError::Unreadable)?;
    let bytes = entry.get_secret().map_err(|error| match error {
        keyring_core::Error::NoEntry => AntigravityCredentialError::NotFound,
        _ => AntigravityCredentialError::Unreadable,
    })?;
    Ok(Zeroizing::new(bytes))
}

#[cfg(not(windows))]
fn read_raw() -> Result<Zeroizing<Vec<u8>>, AntigravityCredentialError> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| AntigravityCredentialError::Unreadable)?;
    let bytes = entry.get_secret().map_err(|error| match error {
        keyring::Error::NoEntry => AntigravityCredentialError::NotFound,
        _ => AntigravityCredentialError::Unreadable,
    })?;
    Ok(Zeroizing::new(bytes))
}

pub fn read() -> Result<AntigravityCredential, AntigravityCredentialError> {
    let mut raw = read_raw()?;
    let result = parse(&raw);
    raw.zeroize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_observed_vendor_envelope_without_retaining_the_refresh_token() {
        let raw = br#"{
            "token": {
                "access_token": "antigravity-access-token-for-tests-only",
                "token_type": "Bearer",
                "refresh_token": "refresh-token-must-not-be-retained",
                "expiry": "2026-08-20T01:00:00.000Z"
            },
            "auth_method": "consumer"
        }"#;
        let parsed = parse(raw).expect("credential");
        assert_eq!(
            parsed.access_token.as_str(),
            "antigravity-access-token-for-tests-only"
        );
        assert!(parsed.expires_at_ms.is_some());
        assert!(!format!("{:?}", AntigravityCredentialError::Invalid)
            .contains("refresh-token-must-not-be-retained"));
    }

    #[test]
    fn malformed_credentials_have_payload_free_errors() {
        for raw in [
            br#"{}"#.as_slice(),
            br#"{"token":{"access_token":""}}"#.as_slice(),
            br#"{"token":{"access_token":"secret","token_type":"Basic"}}"#.as_slice(),
            br#"{"token":{"access_token":"secret","expiry":"not-a-time"}}"#.as_slice(),
        ] {
            let error = match parse(raw) {
                Ok(_) => panic!("malformed credential was accepted"),
                Err(error) => error,
            };
            let debug = format!("{error:?}");
            assert!(!debug.contains("secret"));
            assert!(!debug.contains("not-a-time"));
        }
    }
}
