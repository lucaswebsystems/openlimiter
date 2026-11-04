//! OpenCode's own sign in, read from what the `opencode` CLI saved, so OpenCode
//! connects with nothing to paste.
//!
//! OpenCode 2 keeps its logins in `opencode.db`, table `credential`: a Console
//! sign in (`integration_id` "opencode", an `oauth` value) and Go API keys
//! ("opencode-go", an `api` value). OpenCode 1 kept keys in `auth.json`. Both are
//! read only. Nothing here writes them, and a sign in is never refreshed: the
//! Console hands out a new refresh token on every refresh, so a refresh from
//! here would sign OpenCode itself out. OpenCode renews its own sign in when it
//! runs; an expired one is reported so the person reopens OpenCode.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use zeroize::Zeroizing;

/// The Consoles whose sign in opencode.ai accepts. A self hosted Console's
/// token means nothing to the public usage address, so it is never sent there.
const PUBLIC_CONSOLES: [&str; 2] = ["https://opencode.ai/console", "https://console.opencode.ai"];

/// The most rows looked at; a real profile has a handful.
const MAX_ROWS: u32 = 32;

/// The largest token accepted, the same order as every other reader's bound.
const MAX_TOKEN_BYTES: usize = 16_384;

// Deliberately neither Debug nor Serialize: credentials never enter diagnostics.
pub(crate) struct OpencodeLogin {
    pub token: Zeroizing<String>,
    /// The Console account and workspace for a sign in; None for a bare key.
    pub account: Option<String>,
    pub email: Option<String>,
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

/// One stored value, as a login this reader may use, or None.
fn from_value(object: &Map<String, Value>) -> Option<OpencodeLogin> {
    match object.get("type")?.as_str()? {
        "oauth" => {
            let metadata = object.get("metadata")?.as_object()?;
            let server = metadata.get("server")?.as_str()?.trim_end_matches('/');
            if !PUBLIC_CONSOLES.contains(&server) {
                return None;
            }
            let account = short_text(metadata, "accountID")?;
            let workspace = short_text(metadata, "orgID").unwrap_or_default();
            Some(OpencodeLogin {
                token: token(object.get("access"))?,
                account: Some(format!("{account}\u{0}{workspace}")),
                email: short_text(metadata, "email"),
                expires_at_ms: object.get("expires").and_then(Value::as_u64),
            })
        }
        "api" => Some(OpencodeLogin {
            token: token(object.get("key"))?,
            account: None,
            email: None,
            expires_at_ms: None,
        }),
        _ => None,
    }
}

/// The best login in an OpenCode 2 database: the ACTIVE Console sign in (the
/// account OpenCode itself uses; another signed in account is not read), else
/// the newest Go API key.
pub(crate) fn from_database(path: &Path) -> Option<OpencodeLogin> {
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
    let mut statement = db
        .prepare(
            "SELECT value FROM credential \
             WHERE ((integration_id = 'opencode' AND active = 1) OR integration_id = 'opencode-go') \
             AND length(value) BETWEEN 2 AND 65536 \
             ORDER BY integration_id = 'opencode' DESC, time_updated DESC \
             LIMIT ?1",
        )
        .ok()?;
    let values: Vec<Zeroizing<String>> = statement
        .query_map([MAX_ROWS], |row| row.get::<_, String>(0).map(Zeroizing::new))
        .ok()?
        .flatten()
        .collect();
    values.iter().find_map(|text| {
        let value: Value = serde_json::from_str(&text).ok()?;
        from_value(value.as_object()?)
    })
}

/// The key in an OpenCode 1 `auth.json`: the Go entry first, then the Zen one.
pub(crate) fn from_auth_file(path: &Path) -> Option<OpencodeLogin> {
    let raw = Zeroizing::new(crate::fsx::bounded_read(path)?);
    let root: Value = serde_json::from_str(&raw).ok()?;
    let root = root.as_object()?;
    ["opencode-go", "opencode"]
        .iter()
        .find_map(|name| from_value(root.get(*name)?.as_object()?).filter(|login| login.account.is_none()))
}

/// The login at one candidate path: OpenCode 1's `auth.json`, or a database
/// (`opencode.db`, or whatever file `OPENCODE_DB` names). An `auth.json` beside
/// an `opencode.db` is OpenCode 1's leftover: OpenCode 2 reads the database,
/// and so does this.
pub(crate) fn at(path: &Path) -> Option<OpencodeLogin> {
    if path.file_name().is_none_or(|name| name != "auth.json") {
        return from_database(path);
    }
    if path.with_file_name("opencode.db").exists() {
        return None;
    }
    from_auth_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn database(dir: &TempDir, rows: &[(&str, Option<i64>, i64, &str)]) -> std::path::PathBuf {
        let path = dir.path().join("opencode.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, \
             value text NOT NULL, connector_id text, method_id text, active integer, \
             time_created integer NOT NULL, time_updated integer NOT NULL)",
        )
        .unwrap();
        for (index, (integration, active, updated, value)) in rows.iter().enumerate() {
            db.execute(
                "INSERT INTO credential VALUES (?1, ?2, 'label', ?3, NULL, NULL, ?4, 0, ?5)",
                rusqlite::params![format!("cred_{index}"), integration, value, active, updated],
            )
            .unwrap();
        }
        path
    }

    const SIGN_IN: &str = r#"{"type":"oauth","methodID":"device","access":"console-access-for-tests","refresh":"never-sent","expires":1893456000000,"metadata":{"server":"https://opencode.ai/console","accountID":"acc_1","email":"person@example.com","orgID":"org_1","orgName":"Personal"}}"#;

    #[test]
    fn a_console_sign_in_wins_over_a_newer_key_and_carries_its_identity() {
        let dir = TempDir::new();
        let path = database(&dir, &[
            ("opencode-go", None, 9, r#"{"type":"api","key":"go-key-for-tests"}"#),
            ("opencode", Some(1), 1, SIGN_IN),
        ]);
        let login = at(&path).expect("sign in");
        assert_eq!(login.token.as_str(), "console-access-for-tests");
        assert_eq!(login.account.as_deref(), Some("acc_1\u{0}org_1"));
        assert_eq!(login.email.as_deref(), Some("person@example.com"));
        assert_eq!(login.expires_at_ms, Some(1_893_456_000_000));
    }

    #[test]
    fn another_signed_in_account_is_not_read_and_the_newest_key_wins_over_it() {
        let dir = TempDir::new();
        let path = database(&dir, &[
            ("opencode", Some(0), 9, SIGN_IN),
            ("opencode-go", Some(1), 1, r#"{"type":"api","key":"older-active-key"}"#),
            ("opencode-go", None, 5, r#"{"type":"api","key":"newer-key"}"#),
        ]);
        let login = at(&path).expect("key");
        assert_eq!(login.token.as_str(), "newer-key");
        assert!(login.account.is_none());
    }

    #[test]
    fn a_database_override_with_any_name_is_read_as_a_database() {
        let dir = TempDir::new();
        let path = database(&dir, &[("opencode", Some(1), 1, SIGN_IN)]);
        let renamed = dir.path().join("credentials.sqlite");
        std::fs::rename(&path, &renamed).unwrap();
        assert_eq!(at(&renamed).expect("sign in").token.as_str(), "console-access-for-tests");
    }

    #[test]
    fn without_a_sign_in_the_newest_key_is_used() {
        let dir = TempDir::new();
        let path = database(&dir, &[
            ("opencode-go", None, 1, r#"{"type":"api","key":"older-key"}"#),
            ("opencode-go", None, 5, r#"{"type":"api","key":"newer-key"}"#),
        ]);
        let login = at(&path).expect("key");
        assert_eq!(login.token.as_str(), "newer-key");
        assert!(login.account.is_none());
    }

    #[test]
    fn a_self_hosted_console_or_a_bad_token_is_never_used() {
        let dir = TempDir::new();
        let path = database(&dir, &[
            ("opencode", Some(1), 1, &SIGN_IN.replace("https://opencode.ai/console", "https://console.example.com")),
            ("opencode-go", None, 1, r#"{"type":"api","key":"has a space"}"#),
            ("opencode-go", None, 1, r#"{"type":"api","key":""}"#),
        ]);
        assert!(at(&path).is_none());
    }

    #[test]
    fn a_database_without_the_table_reads_as_no_login() {
        let dir = TempDir::new();
        let path = dir.path().join("opencode.db");
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE other (x)").unwrap();
        assert!(at(&path).is_none());
    }

    #[test]
    fn auth_json_counts_only_without_a_database_beside_it() {
        let dir = TempDir::new();
        let auth = dir.path().join("auth.json");
        std::fs::write(&auth, r#"{"opencode-go":{"type":"api","key":"legacy-go-key"}}"#).unwrap();
        assert_eq!(at(&auth).expect("legacy key").token.as_str(), "legacy-go-key");
        database(&dir, &[]);
        assert!(at(&auth).is_none());
    }
}
