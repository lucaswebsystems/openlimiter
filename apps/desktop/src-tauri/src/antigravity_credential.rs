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
    #[serde(default, borrow, rename = "refresh_token")]
    _refresh_token: Option<&'a str>,
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

#[cfg(all(not(windows), not(target_os = "macos")))]
fn read_raw() -> Result<Zeroizing<Vec<u8>>, AntigravityCredentialError> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| AntigravityCredentialError::Unreadable)?;
    let bytes = entry.get_secret().map_err(|error| match error {
        keyring::Error::NoEntry => AntigravityCredentialError::NotFound,
        _ => AntigravityCredentialError::Unreadable,
    })?;
    Ok(Zeroizing::new(bytes))
}

struct ReadGate(std::sync::atomic::AtomicBool);

impl ReadGate {
    const fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }
    fn retry(&self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
    fn read(
        &self,
        reader: impl FnOnce() -> Result<Zeroizing<Vec<u8>>, AntigravityCredentialError>,
    ) -> Result<Zeroizing<Vec<u8>>, AntigravityCredentialError> {
        use std::sync::atomic::Ordering;
        if self.0.load(Ordering::Acquire) {
            return Err(AntigravityCredentialError::Unreadable);
        }
        reader().inspect_err(|error| {
            if *error == AntigravityCredentialError::Unreadable {
                self.0.store(true, Ordering::Release);
            }
        })
    }
}

static READ_GATE: ReadGate = ReadGate::new();

pub(crate) fn retry_after_denial() {
    READ_GATE.retry();
}

#[cfg(target_os = "macos")]
fn read_raw() -> Result<Zeroizing<Vec<u8>>, AntigravityCredentialError> {
    // Security's per-query UI failure option never unlocks a keychain or raises a prompt.
    use std::ffi::c_void;
    type Ref = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: Ref,
            text: *const std::ffi::c_char,
            encoding: u32,
        ) -> Ref;
        fn CFDictionaryCreate(
            allocator: Ref,
            keys: *const Ref,
            values: *const Ref,
            count: isize,
            key_callbacks: Ref,
            value_callbacks: Ref,
        ) -> Ref;
        fn CFDataGetLength(data: Ref) -> isize;
        fn CFDataGetBytePtr(data: Ref) -> *const u8;
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFDataGetTypeID() -> usize;
        fn CFRelease(value: Ref);
        static kCFBooleanTrue: Ref;
    }
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecItemCopyMatching(query: Ref, result: *mut Ref) -> i32;
        static kSecClass: Ref;
        static kSecClassGenericPassword: Ref;
        static kSecAttrService: Ref;
        static kSecAttrAccount: Ref;
        static kSecReturnData: Ref;
        static kSecUseAuthenticationUI: Ref;
        static kSecUseAuthenticationUIFail: Ref;
    }
    unsafe {
        let nil = std::ptr::null();
        let service = CFStringCreateWithCString(nil, c"gemini".as_ptr(), 0x08000100);
        let account = CFStringCreateWithCString(nil, c"antigravity".as_ptr(), 0x08000100);
        if service.is_null() || account.is_null() {
            return Err(AntigravityCredentialError::Unreadable);
        }
        let keys = [
            kSecClass,
            kSecAttrService,
            kSecAttrAccount,
            kSecReturnData,
            kSecUseAuthenticationUI,
        ];
        let values = [
            kSecClassGenericPassword,
            service,
            account,
            kCFBooleanTrue,
            kSecUseAuthenticationUIFail,
        ];
        let query = CFDictionaryCreate(
            nil,
            keys.as_ptr(),
            values.as_ptr(),
            keys.len() as isize,
            nil,
            nil,
        );
        let mut data = nil;
        let status = if query.is_null() {
            -1
        } else {
            SecItemCopyMatching(query, &mut data)
        };
        if !query.is_null() {
            CFRelease(query);
        }
        CFRelease(service);
        CFRelease(account);
        let result = if status == -25300 {
            Err(AntigravityCredentialError::NotFound)
        } else if status != 0 || data.is_null() {
            Err(AntigravityCredentialError::Unreadable)
        } else if CFGetTypeID(data) != CFDataGetTypeID()
            || CFDataGetLength(data) <= 0
            || CFDataGetLength(data) as usize > MAX_CREDENTIAL_BYTES
        {
            Err(AntigravityCredentialError::Invalid)
        } else {
            Ok(Zeroizing::new(
                std::slice::from_raw_parts(CFDataGetBytePtr(data), CFDataGetLength(data) as usize)
                    .to_vec(),
            ))
        };
        if !data.is_null() {
            CFRelease(data);
        }
        result
    }
}

pub fn read() -> Result<AntigravityCredential, AntigravityCredentialError> {
    let mut raw = READ_GATE.read(read_raw)?;
    let result = parse(&raw);
    raw.zeroize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denial_is_latched_until_explicit_retry() {
        let gate = ReadGate::new();
        let calls = std::cell::Cell::new(0);
        for _ in 0..100 {
            assert!(gate
                .read(|| {
                    calls.set(calls.get() + 1);
                    Err(AntigravityCredentialError::Unreadable)
                })
                .is_err());
        }
        assert_eq!(calls.get(), 1);
        gate.retry();
        assert!(gate
            .read(|| {
                calls.set(calls.get() + 1);
                Ok(Zeroizing::new(Vec::new()))
            })
            .is_ok());
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn parses_the_observed_vendor_envelope_without_using_the_refresh_token_as_identity() {
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
