//! The sign ins four command line tools save on this computer, read so their
//! bars appear with nothing to paste: Hermes (Nous Portal), Command Code, Cline
//! and Kilo Code.
//!
//! Every file is read only, bounded and never through a link (`fsx`). Nothing
//! here writes it, refreshes it or runs the tool: Hermes rotates its refresh
//! token on every refresh, so a refresh from here would sign Hermes itself
//! out, and the same caution holds for the others. A token that expired is
//! reported, and the person opens the tool so it renews its own sign in.
//!
//! The field names come from each tool's own source, recorded beside every
//! reader below and in its provider spec.

use std::path::Path;

use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::provider_detection::DetectedProviderId;

/// The largest token accepted, the same bound the detection scan uses.
const MAX_TOKEN_BYTES: usize = 4_096;

/// The one Nous Portal whose sign in the constant account address accepts.
/// Hermes keeps another portal only for development; that token is never sent.
const NOUS_PORTAL: &str = "https://portal.nousresearch.com";

/// Cline writes its OAuth bearer with this scheme prefix and sends it as is.
const CLINE_TOKEN_SCHEME: &str = "workos:";

// Deliberately neither Debug nor Serialize: credentials never enter diagnostics.
pub(crate) struct ToolLogin {
    pub token: Zeroizing<String>,
    /// A stable account identity the file states, when it states one.
    pub account: Option<String>,
    pub expires_at_ms: Option<u64>,
}

fn token(value: Option<&Value>) -> Option<Zeroizing<String>> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text.len() <= MAX_TOKEN_BYTES && text.bytes().all(|byte| byte.is_ascii_graphic()))
        .then(|| Zeroizing::new(text.to_string()))
}

fn short_text(object: &Map<String, Value>, name: &str) -> Option<String> {
    object
        .get(name)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= 256 && !text.chars().any(char::is_control))
        .map(str::to_string)
}

fn object<'a>(value: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    value?.as_object()
}

/// An expiry stated as an RFC3339 instant, or as epoch milliseconds above zero.
fn expiry(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::String(text) => crate::native_snapshot::epoch_ms_from_rfc3339(text),
        Value::Number(number) => number.as_u64().filter(|ms| *ms > 0),
        _ => None,
    }
}

/// Hermes (`hermes_cli/auth.py`): `{"providers": {"nous": {"access_token",
/// "expires_at", "portal_base_url", ...}}}`. Only the `nous` login is read;
/// the credential pool beside it and every other provider are ignored.
fn hermes(root: &Map<String, Value>) -> Option<ToolLogin> {
    let nous = object(object(root.get("providers"))?.get("nous"))?;
    if let Some(portal) = nous.get("portal_base_url").and_then(Value::as_str) {
        let portal = portal.trim().trim_end_matches('/');
        if !portal.is_empty() && portal != NOUS_PORTAL {
            return None;
        }
    }
    Some(ToolLogin {
        token: token(nous.get("access_token"))?,
        account: None,
        expires_at_ms: expiry(nous.get("expires_at")),
    })
}

/// Command Code (`readCommandAuthFile` in the command-code bundle):
/// `{"apiKey", "userId", "userName", "keyName", "authenticatedAt"}`.
fn commandcode(root: &Map<String, Value>) -> Option<ToolLogin> {
    Some(ToolLogin {
        token: token(root.get("apiKey"))?,
        account: short_text(root, "userId"),
        expires_at_ms: None,
    })
}

/// Cline's `providers.json`: `providers.cline.settings.auth.accessToken`, the
/// bearer Cline itself sends, `workos:` prefixed. The ClinePass entry and
/// every other provider beside it are ignored, and so is any stored key.
fn cline(root: &Map<String, Value>) -> Option<ToolLogin> {
    let cline = object(object(root.get("providers"))?.get("cline"))?;
    let auth = object(object(cline.get("settings"))?.get("auth"))?;
    let stored = token(auth.get("accessToken"))?;
    let bearer = if stored.starts_with(CLINE_TOKEN_SCHEME) {
        stored
    } else {
        Zeroizing::new(format!("{CLINE_TOKEN_SCHEME}{}", stored.as_str()))
    };
    (bearer.len() <= MAX_TOKEN_BYTES).then_some(ToolLogin {
        token: bearer,
        account: None,
        expires_at_ms: None,
    })
}

/// Kilo Code (`packages/opencode/src/auth/index.ts`): the `kilo` entry of
/// `auth.json`, an `oauth` value `{access, refresh, expires, accountId?}`.
/// A legacy migrated login states `expires: 0`, which means unknown, not past.
fn kilocode(root: &Map<String, Value>) -> Option<ToolLogin> {
    let kilo = object(root.get("kilo"))?;
    if kilo.get("type").and_then(Value::as_str) != Some("oauth") {
        return None;
    }
    Some(ToolLogin {
        token: token(kilo.get("access"))?,
        account: None,
        expires_at_ms: expiry(kilo.get("expires")),
    })
}

/// The login in one of these tools' files, or None for every other provider,
/// a missing or malformed file, or a login this build will not send anywhere.
pub(crate) fn read(provider: DetectedProviderId, path: &Path) -> Option<ToolLogin> {
    let parse: fn(&Map<String, Value>) -> Option<ToolLogin> = match provider {
        DetectedProviderId::Hermes => hermes,
        DetectedProviderId::Commandcode => commandcode,
        DetectedProviderId::Cline => cline,
        DetectedProviderId::Kilocode => kilocode,
        DetectedProviderId::Claude
        | DetectedProviderId::Codex
        | DetectedProviderId::Antigravity
        | DetectedProviderId::GeminiCli
        | DetectedProviderId::Opencode
        | DetectedProviderId::Openrouter
        | DetectedProviderId::Grok
        | DetectedProviderId::Kimi
        | DetectedProviderId::Cursor => return None,
    };
    let raw = Zeroizing::new(crate::fsx::bounded_read(path)?);
    let root: Value = serde_json::from_str(&raw).ok()?;
    parse(root.as_object()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn login(provider: DetectedProviderId, text: &str) -> Option<ToolLogin> {
        let dir = TempDir::new();
        let path = dir.path().join("login.json");
        std::fs::write(&path, text).unwrap();
        read(provider, &path)
    }

    #[test]
    fn hermes_reads_only_the_nous_login_of_the_public_portal() {
        let found = login(
            DetectedProviderId::Hermes,
            r#"{"version":1,"active_provider":"nous","providers":{"nous":{"access_token":"hermes-token","refresh_token":"never-read","expires_at":"2026-08-07T13:00:00+00:00","portal_base_url":"https://portal.nousresearch.com/"},"openai":{"access_token":"other"}},"credential_pool":{"nous":[{"access_token":"pooled"}]}}"#,
        )
        .expect("nous login");
        assert_eq!(found.token.as_str(), "hermes-token");
        assert_eq!(found.expires_at_ms, Some(1_786_107_600_000));
        for refused in [
            r#"{"providers":{"nous":{"access_token":"t","portal_base_url":"http://localhost:3000"}}}"#,
            r#"{"providers":{"openai":{"access_token":"t"}}}"#,
            r#"{"providers":{"nous":{"access_token":""}}}"#,
            r#"{"providers":{"nous":{"access_token":12}}}"#,
            r#"{"providers":"nous"}"#,
            "{not json",
            "[]",
        ] {
            assert!(login(DetectedProviderId::Hermes, refused).is_none(), "{refused}");
        }
    }

    #[test]
    fn command_code_reads_its_key_and_user() {
        let found = login(
            DetectedProviderId::Commandcode,
            r#"{"apiKey":"cc-key","userId":"user-1","userName":"someone","keyName":"laptop","authenticatedAt":"2026-08-01T00:00:00Z"}"#,
        )
        .expect("key");
        assert_eq!(found.token.as_str(), "cc-key");
        assert_eq!(found.account.as_deref(), Some("user-1"));
        assert_eq!(found.expires_at_ms, None);
        assert!(login(DetectedProviderId::Commandcode, r#"{"userId":"user-1"}"#).is_none());
    }

    #[test]
    fn cline_reads_the_cline_entry_and_keeps_the_workos_scheme() {
        let file = |settings: &str| {
            format!(r#"{{"providers":{{"cline":{{"settings":{settings}}},"cline-pass":{{"settings":{{"auth":{{"accessToken":"other"}}}}}}}}}}"#)
        };
        let prefixed = login(DetectedProviderId::Cline, &file(r#"{"auth":{"accessToken":"workos:abc"}}"#)).unwrap();
        assert_eq!(prefixed.token.as_str(), "workos:abc");
        let bare = login(DetectedProviderId::Cline, &file(r#"{"auth":{"accessToken":" abc "}}"#)).unwrap();
        assert_eq!(bare.token.as_str(), "workos:abc");
        for refused in [
            file(r#"{"apiKey":"a-key"}"#),
            file(r#"{"auth":{"accessToken":"  "}}"#),
            r#"{"providers":{"cline-pass":{"settings":{"auth":{"accessToken":"other"}}}}}"#.to_string(),
        ] {
            assert!(login(DetectedProviderId::Cline, &refused).is_none(), "{refused}");
        }
    }

    #[test]
    fn kilo_reads_only_its_oauth_entry_and_a_zero_expiry_is_unknown() {
        let found = login(
            DetectedProviderId::Kilocode,
            r#"{"kilo":{"type":"oauth","access":"kilo-token","refresh":"kilo-token","expires":1786107600000},"openai":{"type":"api","key":"other"}}"#,
        )
        .unwrap();
        assert_eq!(found.token.as_str(), "kilo-token");
        assert_eq!(found.expires_at_ms, Some(1_786_107_600_000));
        let legacy = login(
            DetectedProviderId::Kilocode,
            r#"{"kilo":{"type":"oauth","access":"kilo-token","refresh":"","expires":0,"accountId":"org"}}"#,
        )
        .unwrap();
        assert_eq!(legacy.expires_at_ms, None);
        assert!(login(DetectedProviderId::Kilocode, r#"{"kilo":{"type":"api","key":"k"}}"#).is_none());
        assert!(login(DetectedProviderId::Kilocode, r#"{"openai":{"type":"oauth","access":"x","refresh":"x","expires":1}}"#).is_none());
    }

    #[test]
    fn a_missing_file_and_other_providers_read_nothing() {
        let dir = TempDir::new();
        for provider in DetectedProviderId::ALL {
            assert!(read(provider, &dir.path().join("absent.json")).is_none());
        }
        assert!(login(DetectedProviderId::Opencode, r#"{"apiKey":"x"}"#).is_none());
    }
}
