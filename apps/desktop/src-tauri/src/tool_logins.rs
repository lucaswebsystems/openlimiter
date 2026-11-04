//! The sign ins nine coding tools save on this computer, read so their bars
//! appear with nothing to paste: Hermes (Nous Portal), Command Code, Cline,
//! Kilo Code, GitHub Copilot, Amp, Codebuff, Kiro and Crush (Charm Hyper).
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
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
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

/// The one `apps.json` entry read: the GitHub Copilot OAuth app on github.com
/// (Crush `oauth/copilot/disk.go`; the client id CodexBar's device flow uses).
/// An entry for any other host or app, an enterprise one included, is not.
const COPILOT_APP_KEY: &str = "github.com:Iv1.b507a08c87ecfe98";

/// Amp's secret key for its API key on the public server: `${name}@${url}`
/// with the URL normalized to `https://ampcode.com/` (the Amp CLI bundle).
const AMP_API_KEY: &str = "apiKey@https://ampcode.com/";

/// The mark of a saved Amp account beside the legacy login. The newer Amp CLI
/// keeps several accounts and a selection whose format no readable source
/// confirms, so a file holding one is not read at all.
const AMP_ACCOUNT_MARK: &str = "#cli-account=";

/// The Kiro CLI's token and profile rows (CodexBar `KiroUsageLimitsAPI.swift`).
const KIRO_TOKEN_KEY: &str = "kirocli:odic:token";
const KIRO_PROFILE_KEY: &str = "api.codewhisperer.profile";

/// The largest value read from the Kiro state database.
const MAX_KIRO_VALUE_BYTES: i64 = 65_536;

// Deliberately neither Debug nor Serialize: credentials never enter diagnostics.
pub(crate) struct ToolLogin {
    pub token: Zeroizing<String>,
    /// A stable account identity the file states, when it states one.
    pub account: Option<String>,
    pub expires_at_ms: Option<u64>,
    /// The one non secret value a request needs beside the token: Kiro's
    /// profile ARN, which `net.rs` validates before it writes the body.
    pub provider_account_id: Option<String>,
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
        provider_account_id: None,
    })
}

/// Command Code (`readCommandAuthFile` in the command-code bundle):
/// `{"apiKey", "userId", "userName", "keyName", "authenticatedAt"}`.
fn commandcode(root: &Map<String, Value>) -> Option<ToolLogin> {
    Some(ToolLogin {
        token: token(root.get("apiKey"))?,
        account: short_text(root, "userId"),
        expires_at_ms: None,
        provider_account_id: None,
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
        provider_account_id: None,
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
        provider_account_id: None,
    })
}

/// GitHub Copilot's `apps.json`: `{"github.com:<app id>": {"user",
/// "oauth_token", "githubAppId"}}` (Crush `oauth/copilot/disk.go`). Only the
/// github.com Copilot app's entry is read; the account is its `user`. The
/// Copilot CLI's own store (the `copilot-cli` system credential and
/// `~/.copilot/config.json`) is not read: its format is in the CLI's native
/// runtime and could not be confirmed from source.
fn copilot(root: &Map<String, Value>) -> Option<ToolLogin> {
    let app = object(root.get(COPILOT_APP_KEY))?;
    Some(ToolLogin {
        token: token(app.get("oauth_token"))?,
        account: short_text(app, "user"),
        expires_at_ms: None,
        provider_account_id: None,
    })
}

/// Amp's file secret storage, `secrets.json` in its data folder: a flat map of
/// `${name}@${url}` to the secret (`gf4` in the Amp CLI bundle). Only the API
/// key for the public server is read, and only from a file that holds no
/// saved multi account login beside it.
fn amp(root: &Map<String, Value>) -> Option<ToolLogin> {
    if root.keys().any(|key| key.contains(AMP_ACCOUNT_MARK)) {
        return None;
    }
    Some(ToolLogin {
        token: token(root.get(AMP_API_KEY))?,
        account: None,
        expires_at_ms: None,
        provider_account_id: None,
    })
}

/// Codebuff's `credentials.json`: the `default` profile's `authToken`, its
/// account the profile's `id` (`cli/src/utils/auth.ts`). A profile whose token
/// moved to the system keychain (`tokenStore: "keychain"`) has none here.
fn codebuff(root: &Map<String, Value>) -> Option<ToolLogin> {
    let profile = object(root.get("default"))?;
    Some(ToolLogin {
        token: token(profile.get("authToken"))?,
        account: short_text(profile, "id"),
        expires_at_ms: None,
        provider_account_id: None,
    })
}

/// Crush's `crush.json`: the Hyper provider's OAuth token with its expiry in
/// epoch seconds when Crush signed in, else the key a person set
/// (`internal/config`, `ResolveHyperAPIKey`, `oauth.Token`). A key that names
/// an environment variable (`$NAME`) is not a key and is not read.
fn crush(root: &Map<String, Value>) -> Option<ToolLogin> {
    let hyper = object(object(root.get("providers"))?.get("hyper"))?;
    if let Some(oauth) = object(hyper.get("oauth")) {
        let seconds = oauth.get("expires_at").and_then(Value::as_u64).filter(|value| *value > 0);
        return Some(ToolLogin {
            token: token(oauth.get("access_token"))?,
            account: None,
            expires_at_ms: seconds.and_then(|value| value.checked_mul(1_000)),
            provider_account_id: None,
        });
    }
    let key = token(hyper.get("api_key"))?;
    (!key.starts_with('$')).then_some(ToolLogin {
        token: key,
        account: None,
        expires_at_ms: None,
        provider_account_id: None,
    })
}

/// One value of the Kiro state database, read only.
fn kiro_value(db: &Connection, sql: &str, key: &str) -> Option<Zeroizing<String>> {
    db.query_row(sql, rusqlite::params![key, MAX_KIRO_VALUE_BYTES], |row| row.get::<_, String>(0))
        .ok()
        .map(Zeroizing::new)
}

/// The Kiro CLI's `data.sqlite3`: table `auth_kv`, key `kirocli:odic:token`,
/// a JSON token with `access_token` and an RFC3339 `expires_at` (the token
/// layout of the Amazon Q Developer CLI, `auth/builder_id.rs`, which Kiro's
/// CLI continues); table `state`, key `api.codewhisperer.profile`, a JSON
/// profile whose `arn` the usage request names. Opened read only on the live
/// database and its WAL, never copied, never written, never refreshed. The
/// account is the profile.
fn kiro(path: &Path) -> Option<ToolLogin> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    // READ_ONLY reads the active WAL. Never use immutable, checkpoint, backup or copy.
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    db.busy_timeout(Duration::from_millis(250)).ok()?;
    kiro_login(&db, || ())
}

/// The token and the profile from one committed state of the database. Both
/// are read inside one read transaction (as `cursor_reader.rs` does), so a
/// sign in the Kiro CLI writes between the two reads can never pair one
/// account's token with another account's profile. `between` runs between the
/// two reads; only a test gives it anything to do. The transaction is never
/// committed: dropping the connection ends it.
fn kiro_login(db: &Connection, between: impl FnOnce()) -> Option<ToolLogin> {
    db.execute_batch("BEGIN").ok()?;
    let token_text = kiro_value(
        db,
        "SELECT value FROM auth_kv WHERE key = ?1 AND length(value) <= ?2",
        KIRO_TOKEN_KEY,
    )?;
    between();
    let profile_text = kiro_value(
        db,
        "SELECT value FROM state WHERE key = ?1 AND length(value) <= ?2",
        KIRO_PROFILE_KEY,
    )?;
    let saved: Value = serde_json::from_str(&token_text).ok()?;
    let saved = saved.as_object()?;
    let profile: Value = serde_json::from_str(&profile_text).ok()?;
    let arn = short_text(profile.as_object()?, "arn")?;
    Some(ToolLogin {
        token: token(saved.get("access_token"))?,
        account: Some(arn.clone()),
        expires_at_ms: expiry(saved.get("expires_at")),
        provider_account_id: Some(arn),
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
        DetectedProviderId::Copilot => copilot,
        DetectedProviderId::Amp => amp,
        DetectedProviderId::Codebuff => codebuff,
        DetectedProviderId::Crush => crush,
        DetectedProviderId::Kiro => return kiro(path),
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
    fn copilot_reads_only_the_github_com_copilot_app() {
        let found = login(
            DetectedProviderId::Copilot,
            r#"{"github.com:Iv1.b507a08c87ecfe98":{"user":"octo","oauth_token":"gho_copilot","githubAppId":"Iv1.b507a08c87ecfe98"},"ghe.example.com:Iv1.b507a08c87ecfe98":{"user":"other","oauth_token":"enterprise"}}"#,
        )
        .expect("github.com login");
        assert_eq!(found.token.as_str(), "gho_copilot");
        assert_eq!(found.account.as_deref(), Some("octo"));
        for refused in [
            r#"{"ghe.example.com:Iv1.b507a08c87ecfe98":{"user":"other","oauth_token":"enterprise"}}"#,
            r#"{"github.com:Iv1.other":{"user":"octo","oauth_token":"other-app"}}"#,
            r#"{"github.com:Iv1.b507a08c87ecfe98":{"user":"octo"}}"#,
            "[]",
        ] {
            assert!(login(DetectedProviderId::Copilot, refused).is_none(), "{refused}");
        }
    }

    #[test]
    fn amp_reads_the_public_server_key_and_never_a_multi_account_file() {
        let found = login(
            DetectedProviderId::Amp,
            r#"{"apiKey@https://ampcode.com/":"amp-key","apiKey@https://amp.example.com/":"self-hosted"}"#,
        )
        .expect("key");
        assert_eq!(found.token.as_str(), "amp-key");
        assert_eq!(found.account, None);
        for refused in [
            r#"{"apiKey@https://amp.example.com/":"self-hosted"}"#,
            r#"{"apiKey@https://ampcode.com/":"amp-key","apiKey@https://ampcode.com/#cli-account=user-2":"other"}"#,
            r#"{"apiKey@https://ampcode.com/":""}"#,
        ] {
            assert!(login(DetectedProviderId::Amp, refused).is_none(), "{refused}");
        }
    }

    #[test]
    fn codebuff_reads_the_default_profile_and_not_a_keychain_pointer() {
        let found = login(
            DetectedProviderId::Codebuff,
            r#"{"default":{"id":"user-1","name":"","email":"person@example.com","authToken":"cb-token","fingerprintId":"fp"},"other":{"authToken":"x"}}"#,
        )
        .expect("token");
        assert_eq!(found.token.as_str(), "cb-token");
        assert_eq!(found.account.as_deref(), Some("user-1"));
        assert!(login(
            DetectedProviderId::Codebuff,
            r#"{"default":{"id":"user-1","email":"person@example.com","tokenStore":"keychain"}}"#
        )
        .is_none());
        assert!(login(DetectedProviderId::Codebuff, r#"{"other":{"authToken":"x"}}"#).is_none());
    }

    #[test]
    fn crush_prefers_the_oauth_token_with_its_expiry_and_never_reads_a_variable() {
        let oauth = login(
            DetectedProviderId::Crush,
            r#"{"providers":{"hyper":{"api_key":"hyper-token","oauth":{"access_token":"hyper-token","refresh_token":"never-read","expires_in":3600,"expires_at":1786107600}},"openai":{"api_key":"other"}}}"#,
        )
        .expect("oauth");
        assert_eq!(oauth.token.as_str(), "hyper-token");
        assert_eq!(oauth.expires_at_ms, Some(1_786_107_600_000));
        let key = login(DetectedProviderId::Crush, r#"{"providers":{"hyper":{"api_key":"hyper-key"}}}"#)
            .expect("key");
        assert_eq!((key.token.as_str(), key.expires_at_ms), ("hyper-key", None));
        for refused in [
            r#"{"providers":{"hyper":{"api_key":"$HYPER_API_KEY"}}}"#,
            r#"{"providers":{"openai":{"api_key":"other"}}}"#,
            r#"{"providers":{"hyper":{"oauth":{"refresh_token":"x"},"api_key":"ignored-beside-oauth"}}}"#,
        ] {
            assert!(login(DetectedProviderId::Crush, refused).is_none(), "{refused}");
        }
    }

    fn kiro_database(path: &Path, token: Option<&str>, profile: Option<&str>) {
        let db = Connection::open(path).unwrap();
        db.execute_batch(
            "CREATE TABLE auth_kv(key TEXT PRIMARY KEY, value TEXT); \
             CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
        if let Some(token) = token {
            db.execute("INSERT INTO auth_kv VALUES ('kirocli:odic:token', ?1)", [token]).unwrap();
        }
        if let Some(profile) = profile {
            db.execute("INSERT INTO state VALUES ('api.codewhisperer.profile', ?1)", [profile]).unwrap();
        }
    }

    #[test]
    fn kiro_reads_its_token_and_profile_read_only() {
        let dir = TempDir::new();
        let path = dir.path().join("data.sqlite3");
        let arn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE1";
        kiro_database(
            &path,
            Some(r#"{"access_token":"kiro-token","refresh_token":"never-read","expires_at":"2026-08-07T13:00:00Z","region":"us-east-1"}"#),
            Some(&format!(r#"{{"arn":"{arn}","profile_name":"Kiro"}}"#)),
        );
        let found = read(DetectedProviderId::Kiro, &path).expect("login");
        assert_eq!(found.token.as_str(), "kiro-token");
        assert_eq!(found.expires_at_ms, Some(1_786_107_600_000));
        assert_eq!(found.provider_account_id.as_deref(), Some(arn));
        assert_eq!(found.account.as_deref(), Some(arn));
        let missing = dir.path().join("no-profile.sqlite3");
        kiro_database(&missing, Some(r#"{"access_token":"kiro-token"}"#), None);
        assert!(read(DetectedProviderId::Kiro, &missing).is_none());
        let not_a_database = dir.path().join("plain.sqlite3");
        std::fs::write(&not_a_database, "not sqlite").unwrap();
        assert!(read(DetectedProviderId::Kiro, &not_a_database).is_none());
    }

    #[test]
    fn a_kiro_account_switch_between_the_two_reads_never_mixes_two_accounts() {
        /* The Kiro CLI signs another account in while the token was read and
        the profile was not yet: the read still yields one account's pair. */
        let dir = TempDir::new();
        let path = dir.path().join("data.sqlite3");
        let arn = |person: &str| format!("arn:aws:codewhisperer:us-east-1:123456789012:profile/{person}");
        let saved = |token: &str| format!(r#"{{"access_token":"{token}","expires_at":"2099-01-01T00:00:00Z"}}"#);
        let profile = |person: &str| format!(r#"{{"arn":"{}"}}"#, arn(person));
        kiro_database(&path, Some(saved("token-a").as_str()), Some(profile("A").as_str()));
        let writer = Connection::open(&path).unwrap();
        writer.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(())).unwrap();
        let reader = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        let found = kiro_login(&reader, || {
            writer
                .execute("UPDATE auth_kv SET value = ?1 WHERE key = 'kirocli:odic:token'", [saved("token-b")])
                .unwrap();
            writer
                .execute("UPDATE state SET value = ?1 WHERE key = 'api.codewhisperer.profile'", [profile("B")])
                .unwrap();
        })
        .expect("one account's login");
        assert_eq!(found.token.as_str(), "token-a");
        assert_eq!(found.provider_account_id.as_deref(), Some(arn("A").as_str()));
        drop(reader);
        /* The next read sees the switched account whole. */
        let switched = read(DetectedProviderId::Kiro, &path).expect("the new account");
        assert_eq!(switched.token.as_str(), "token-b");
        assert_eq!(switched.provider_account_id.as_deref(), Some(arn("B").as_str()));
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
