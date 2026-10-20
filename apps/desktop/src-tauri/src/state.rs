use std::env;
use std::path::PathBuf;

/// Where OpenLimiter keeps its state, and how to read the snapshot cache.
///
/// This module deliberately does no thinking about quota. It resolves one path
/// and reads one file, and everything about what the bytes mean, whether a
/// reading is still fresh, and what advice comes out of it, is decided by the
/// same TypeScript engine the command line tool uses, running in the webview.
/// One implementation of the rules, in one language, is the whole point.
///
/// The path convention below mirrors `resolveStateDirectory` in
/// `packages/core/src/cache.ts`. If that ever changes, this changes with it.
/// The cache file name is `openlimiter-cache.json`, from the same module.
const CACHE_FILE_NAME: &str = "openlimiter-cache.json";
pub(crate) const AUTHORITATIVE_CACHE_FILE_NAME: &str = "openlimiter-authoritative.json";

/// The manual quota document, from `packages/connectors/src/manual.ts`.
const MANUAL_FILE_NAME: &str = "manual.json";

/// The direct Claude usage request's one store of truth, beside the cache.
pub(crate) const CLAUDE_POLL_FILE_NAME: &str = "claude-poll.json";

/// The request's switch, read fresh at every call: `Ok(None)` when no choice
/// was recorded, `Ok(Some(enabled))` for a version 1 document, and `Err` for
/// anything else, which every caller reads as off. TypeScript twin: cache.ts
/// readClaudePoll.
pub(crate) fn read_claude_poll(directory: Option<&std::path::Path>) -> Result<Option<bool>, ()> {
    #[derive(serde::Deserialize)]
    struct Document {
        version: u32,
        enabled: bool,
    }
    let path = directory.ok_or(())?.join(CLAUDE_POLL_FILE_NAME);
    match crate::fsx::bounded_read_result(&path, crate::fsx::MAX_STATE_FILE_BYTES) {
        Err(crate::fsx::ReadFailure::Missing) => Ok(None),
        Err(_) => Err(()),
        Ok(text) => match serde_json::from_str::<Document>(&text) {
            Ok(document) if document.version == 1 => Ok(Some(document.enabled)),
            _ => Err(()),
        },
    }
}

#[cfg(not(test))]
pub(crate) fn home() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
pub(crate) fn home() -> Option<PathBuf> {
    state_directory()
}

pub(crate) fn non_empty(name: &str) -> Option<PathBuf> {
    match env::var_os(name) {
        Some(value) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

// The state directory for this operating system.
#[cfg(test)]
thread_local! {
    // Every test thread gets an owned root even when a legacy test forgot injection.
    static TEST_ROOT: crate::test_support::TempDir = crate::test_support::TempDir::new();
}

#[cfg(test)]
pub fn state_directory() -> Option<PathBuf> {
    Some(TEST_ROOT.with(|root| root.path().to_path_buf()))
}

#[cfg(not(test))]
pub fn state_directory() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let base = non_empty("LOCALAPPDATA").or_else(home)?;
        return Some(base.join("openlimiter"));
    }
    if cfg!(target_os = "macos") {
        return Some(
            home()?
                .join("Library")
                .join("Application Support")
                .join("openlimiter"),
        );
    }
    let base = non_empty("XDG_STATE_HOME")
        .or_else(|| home().map(|path| path.join(".local").join("state")))?;
    Some(base.join("openlimiter"))
}

/// Whether a row may reach a surface, by provenance and never by the file it
/// sits in. With the Claude request on, a Claude row counts only when the
/// request read it, plus the ACQUISITION row that carries the request's
/// availability; with it off, every Claude row except the request's counts,
/// with no weekly. Other providers always count. TypeScript twin: cache.ts
/// claudeRowCounts; both prove claude-poll-vectors.json `source`.
pub(crate) fn claude_row_counts(row: &crate::native_snapshot::Snapshot, poll_on: bool) -> bool {
    if row.provider != "CLAUDE" {
        return true;
    }
    if row.meter == "ACQUISITION" {
        return poll_on;
    }
    let remote = row
        .provenance
        .as_ref()
        .and_then(|value| value.get("sourceKind"))
        .and_then(serde_json::Value::as_str)
        == Some("remote_api");
    if poll_on {
        remote
    } else {
        !remote && !row.meter.starts_with("SEVEN_DAY")
    }
}

/// Read the snapshot cache as text, or nothing at all.
///
/// A missing file, an unreadable file, an oversized file, and a path that is
/// not a regular file all come back the same way: no cache. Nothing is
/// repaired here and nothing is invented, because a reading that cannot be
/// trusted has to reach the engine as an absence, never as a zero.
///
/// Every surface reads through here, so this is where the Claude switch,
/// read at every call, chooses each Claude row's source (`claude_row_counts`):
/// the newest observation of an identity wins across the two files, and a
/// Claude drift suppression is dropped, because a failed Claude read is a flag
/// on its ACQUISITION row and never a withdrawal.
pub fn read_cache() -> Option<String> {
    use serde_json::Value;
    let main = read_state_file(CACHE_FILE_NAME);
    let authoritative = read_state_file(AUTHORITATIVE_CACHE_FILE_NAME);
    if main.is_none() && authoritative.is_none() {
        return None;
    }
    let poll_on = read_claude_poll(state_directory().as_deref()) == Ok(Some(true));
    let mut document = match main.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok()) {
        Some(document) => document,
        // A torn document alone reaches the caller as it is: unreadable.
        None if authoritative.is_none() => return main,
        None => serde_json::json!({"version": 3, "snapshots": []}),
    };
    let original = document.clone();
    let normalized = |value: &Value| {
        serde_json::from_value::<crate::native_snapshot::Snapshot>(value.clone())
            .ok()
            .and_then(crate::native_snapshot::normalize_snapshot)
    };
    let Some(target) = document.get_mut("snapshots").and_then(Value::as_array_mut) else {
        return main;
    };
    // A row that fails validation is left for the surface reader to drop.
    target.retain(|value| normalized(value).is_none_or(|row| claude_row_counts(&row, poll_on)));
    let source = authoritative
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.get("snapshots").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let identity = |value: &Value| {
        ["provider", "meter", "accountId"].map(|key| value.get(key).and_then(Value::as_str).map(str::to_owned))
    };
    let observed = |value: &Value| {
        value
            .get("observedAt")
            .and_then(Value::as_str)
            .and_then(crate::native_snapshot::epoch_ms_from_rfc3339)
            .unwrap_or(0)
    };
    for row in source {
        if !normalized(&row).is_some_and(|snapshot| claude_row_counts(&snapshot, poll_on)) {
            continue;
        }
        // Newest observation wins, a tie going to the authoritative row.
        match target.iter_mut().find(|candidate| identity(candidate) == identity(&row)) {
            Some(existing) if observed(&row) >= observed(existing) => *existing = row,
            Some(_) => {}
            None => target.push(row),
        }
    }
    if let Some(entries) = document.get_mut("suppressions").and_then(Value::as_array_mut) {
        entries.retain(|entry| entry.get("provider").and_then(Value::as_str) != Some("CLAUDE"));
    }
    if main.is_some() && document == original {
        return main;
    }
    serde_json::to_string(&document).ok()
}

/// Read the snapshot cache for the window, telling a cache that is not there
/// from one that is there but cannot be used right now.
///
/// `Ok(None)` is a cache that does not exist yet, which is ordinary: the window
/// is often opened before anything has written one. A cache that exists but
/// cannot be read or parsed is an error. On Windows that happens whenever the
/// collector or the terminal status line replaces the file during a read (a
/// sharing violation), and the window must then keep the readings it holds
/// rather than draw an empty cache.
pub fn read_cache_document() -> Result<Option<String>, String> {
    const UNREADABLE: &str = "The saved readings could not be read.";
    let Some(directory) = state_directory() else {
        return Ok(None);
    };
    let main_file = directory.join(CACHE_FILE_NAME);
    let authoritative_file = directory.join(AUTHORITATIVE_CACHE_FILE_NAME);
    let Some(text) = read_cache() else {
        // Absent only when the path names nothing at all: a link, a folder, a
        // file too large and a file another process holds all exist.
        return match (std::fs::symlink_metadata(&main_file), std::fs::symlink_metadata(&authoritative_file)) {
            (Err(main), Err(authoritative))
                if main.kind() == std::io::ErrorKind::NotFound && authoritative.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => Err(UNREADABLE.into()),
        };
    };
    // A torn or foreign document is a failed read, never an empty cache.
    serde_json::from_str::<serde_json::Value>(&text).map_err(|_| UNREADABLE.to_string())?;
    Ok(Some(text))
}

/// Read the manual quota document as text, or nothing at all.
///
/// This is the one connector whose input lives on disk and needs no network,
/// so it is the one connector the window can run for itself. The parsing and
/// the validation happen in the engine, exactly as they do in the command line
/// tool. This function only hands over bytes.
pub fn read_manual() -> Option<String> {
    read_state_file(MANUAL_FILE_NAME)
}

fn read_state_file(name: &str) -> Option<String> {
    /* One bounded, link refusing, handle first read exists in this crate,
    in `fsx`, and every state file goes through it. */
    let file = state_directory()?.join(name);
    crate::fsx::bounded_read(&file)
}

#[cfg(test)]
mod tests {
    const DOCUMENT: &str = r#"{"version":2,"snapshots":[]}"#;

    #[test]
    fn an_absent_cache_reads_as_empty_and_an_unusable_one_as_an_error() {
        let cache = super::state_directory().unwrap().join(super::CACHE_FILE_NAME);
        assert_eq!(super::read_cache_document(), Ok(None), "nothing written yet");
        std::fs::write(&cache, DOCUMENT).unwrap();
        assert_eq!(super::read_cache_document(), Ok(Some(DOCUMENT.to_string())));
        // Caught half written: there, but not a document.
        std::fs::write(&cache, &DOCUMENT[..12]).unwrap();
        assert!(super::read_cache_document().is_err());
        // Something that is not a file where the cache belongs.
        std::fs::remove_file(&cache).unwrap();
        std::fs::create_dir(&cache).unwrap();
        assert!(super::read_cache_document().is_err());
        std::fs::remove_dir(&cache).unwrap();
        assert_eq!(super::read_cache_document(), Ok(None));
    }

    /// What a reader meets while another process replaces the cache on
    /// Windows: the file is there and opening it is a sharing violation.
    #[cfg(windows)]
    #[test]
    fn a_cache_another_process_holds_is_an_error_until_it_lets_go() {
        use std::os::windows::fs::OpenOptionsExt;
        let cache = super::state_directory().unwrap().join(super::CACHE_FILE_NAME);
        std::fs::write(&cache, DOCUMENT).unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&cache)
            .unwrap();
        assert!(super::read_cache_document().is_err());
        drop(held);
        assert_eq!(super::read_cache_document(), Ok(Some(DOCUMENT.to_string())));
        std::fs::remove_file(&cache).unwrap();
    }

    /// One row of the shared Claude vectors (claude-poll-vectors.json), the
    /// section's row defaults filled in. TypeScript twin: cache.test.ts expand.
    fn vector_row(
        defaults: &serde_json::Map<String, serde_json::Value>,
        row: &serde_json::Value,
    ) -> serde_json::Value {
        let mut spec = defaults.clone();
        spec.extend(row.as_object().expect("row").clone());
        let meter = spec["meter"].as_str().expect("meter").to_string();
        let observed = spec["observedAt"].as_str().expect("observed").to_string();
        let observed_ms = crate::native_time::epoch_ms_from_rfc3339(&observed).expect("instant");
        let acquisition = meter == "ACQUISITION";
        let kind = spec["sourceKind"].as_str().map(str::to_string);
        let mut value = serde_json::json!({
            "provider": spec["provider"], "meter": meter, "value": spec["value"], "unit": "PERCENT",
            "window": if acquisition { serde_json::json!({"kind": "unknown"}) } else {
                serde_json::json!({"kind": "rolling", "durationSeconds": if meter.starts_with("SEVEN_DAY") { 604_800 } else { 18_000 }})
            },
            "resetAt": if acquisition { serde_json::Value::Null } else { spec["resetAt"].clone() },
            "source": match kind.as_deref() { Some("remote_api") => "internal_payload", Some("manual_document") => "manual_entry", _ => "native_payload" },
            "precision": "exact", "observedAt": observed,
            "expiresAt": crate::native_time::iso_from_epoch_ms(observed_ms + 465_000).expect("instant"),
            "labels": {"credentialOrigin": "official-local-tool", "dataInterfaceStatus": "internal-endpoint", "automationRisk": "high", "verification": "UNVERIFIED"},
        });
        if let Some(account) = spec["accountId"].as_str() {
            value["accountId"] = serde_json::json!(account);
        }
        if let Some(kind) = kind {
            let via = match kind.as_str() {
                "statusline_payload" => "claude_code_statusline",
                "remote_api" => "remote_http",
                "manual_document" => "manual_json",
                _ => "ingest_command",
            };
            value["provenance"] = serde_json::json!({"sourceKind": kind, "observedVia": via});
        }
        if acquisition {
            value["kind"] = serde_json::json!("runtime_info");
        }
        for field in ["availability", "retryAt"] {
            if let Some(text) = spec.get(field).and_then(serde_json::Value::as_str) {
                value[field] = serde_json::json!(text);
            }
        }
        value
    }

    /// 2.1.7: one source per Claude bar, chosen by the switch and each row's
    /// provenance, never by the file a row sits in. TypeScript twin:
    /// cache.test.ts, "shared Claude source vectors"; both read the same cases.
    #[test]
    fn every_shared_claude_source_vector() {
        use serde_json::{json, Value};
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/contracts/claude-poll-vectors.json"
        ))
        .expect("vectors");
        let source = &contract["source"];
        let defaults = source["rowDefaults"].as_object().expect("defaults").clone();
        let expand = |row: &Value| vector_row(&defaults, row);
        let key = |row: &Value| format!("{} {} {}", row["provider"].as_str().unwrap_or(""), row["meter"].as_str().unwrap_or(""), row["value"].as_f64().unwrap_or(-1.0));
        let directory = super::state_directory().unwrap();
        for case in source["cases"].as_array().expect("cases") {
            let id = case["id"].as_str().expect("id");
            let rows = case["rows"].as_array().expect("rows");
            let stored = |store: &str| rows.iter().filter(|row| row["store"] == store).map(&expand).collect::<Vec<_>>();
            for name in [super::CACHE_FILE_NAME, super::AUTHORITATIVE_CACHE_FILE_NAME, "claude-poll.json"] {
                let _ = std::fs::remove_file(directory.join(name));
            }
            if !stored("main").is_empty() || case.get("suppressions").is_some() {
                let mut document = json!({"version": 3, "snapshots": stored("main")});
                if let Some(suppressions) = case["suppressions"].as_array() {
                    document["suppressions"] = Value::Array(suppressions.iter().map(|entry| {
                        let mut entry = entry.clone();
                        entry["reason"] = json!("drift");
                        entry
                    }).collect());
                }
                std::fs::write(directory.join(super::CACHE_FILE_NAME), document.to_string()).unwrap();
            }
            if !stored("authoritative").is_empty() {
                std::fs::write(
                    directory.join(super::AUTHORITATIVE_CACHE_FILE_NAME),
                    json!({"version": 3, "snapshots": stored("authoritative")}).to_string(),
                )
                .unwrap();
            }
            let switch = match case["switch"].as_str().expect("switch") {
                "on" => Some(r#"{"version":1,"enabled":true}"#),
                "off" => Some(r#"{"version":1,"enabled":false}"#),
                "invalid" => Some(r#"{"version":2,"enabled":true}"#),
                _ => None,
            };
            if let Some(text) = switch {
                std::fs::write(directory.join("claude-poll.json"), text).unwrap();
            }
            let shown = crate::native_snapshot::display_snapshots(super::read_cache().as_deref());
            let mut shown = shown
                .iter()
                .map(|row| serde_json::to_value(row).expect("row"))
                .map(|row| key(&row))
                .collect::<Vec<_>>();
            shown.sort();
            let visible = case["visible"].as_array().expect("visible");
            let mut expected = rows
                .iter()
                .filter(|row| visible.contains(&row["ref"]))
                .map(|row| key(&expand(row)))
                .collect::<Vec<_>>();
            expected.sort();
            assert_eq!(shown, expected, "{id}");
        }
        for name in [super::CACHE_FILE_NAME, super::AUTHORITATIVE_CACHE_FILE_NAME, "claude-poll.json"] {
            let _ = std::fs::remove_file(directory.join(name));
        }
    }

    /// Astra fix round, finding 2: committing a poll read keeps every row
    /// another source wrote, a status line payload that arrived while the read
    /// was in flight included, and clears only the account's flag recorded no
    /// later than the read. TypeScript twin: cache.test.ts, "committing a poll
    /// read"; both read the same cases.
    #[test]
    fn every_shared_claude_poll_commit_vector() {
        use serde_json::{json, Value};
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/contracts/claude-poll-vectors.json"
        ))
        .expect("vectors");
        let defaults = contract["source"]["rowDefaults"].as_object().expect("defaults").clone();
        let commit = &contract["commit"];
        let observed = commit["observedAt"].as_str().expect("observed");
        let account = defaults["accountId"].as_str().expect("account").to_string();
        let identity = |row: &Value| {
            format!(
                "{} {} {} {}",
                row["provider"].as_str().unwrap_or(""),
                row["meter"].as_str().unwrap_or(""),
                row["accountId"].as_str().unwrap_or(""),
                row["value"].as_f64().unwrap_or(-1.0)
            )
        };
        for case in commit["cases"].as_array().expect("cases") {
            let id = case["id"].as_str().expect("id");
            let directory = crate::test_support::TempDir::new();
            let main = case["main"].as_array().expect("main");
            std::fs::write(
                directory.path().join(super::CACHE_FILE_NAME),
                json!({"version": 3, "snapshots": main.iter().map(|row| vector_row(&defaults, row)).collect::<Vec<_>>()}).to_string(),
            )
            .unwrap();
            let poll = commit["poll"]
                .as_array()
                .expect("poll")
                .iter()
                .map(|row| {
                    let mut row = row.clone();
                    row["observedAt"] = json!(observed);
                    serde_json::from_value(vector_row(&defaults, &row)).expect("snapshot")
                })
                .collect::<Vec<crate::native_snapshot::Snapshot>>();
            let writer = crate::cache_write::CacheWriter::at(Some(directory.path().to_path_buf()));
            crate::native_snapshot::write_report_with(
                &writer,
                "CLAUDE",
                Some(&account),
                crate::native_snapshot::CacheReport::Success(poll),
                true,
            )
            .expect(id);
            let text = std::fs::read_to_string(directory.path().join(super::CACHE_FILE_NAME)).expect("main");
            let document: Value = serde_json::from_str(&text).expect("document");
            let left = document["snapshots"].as_array().expect("rows").iter().map(identity).collect::<Vec<_>>();
            let named = |refs: &Value| {
                main.iter()
                    .filter(|row| refs.as_array().expect("refs").contains(&row["ref"]))
                    .map(|row| identity(&vector_row(&defaults, row)))
                    .collect::<Vec<_>>()
            };
            for kept in named(&case["kept"]) {
                assert!(left.contains(&kept), "{id}: {kept} stays, left {left:?}");
            }
            for gone in named(&case["gone"]) {
                assert!(!left.contains(&gone), "{id}: {gone} leaves, left {left:?}");
            }
        }
    }

    #[test]
    fn real_state_directory_is_never_resolved_by_tests() {
        let state = super::state_directory().unwrap();
        assert!(state
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("openlimiter-desktop-test-"));
        let account = state.join("accounts/codex/guardfixture");
        assert!(account.starts_with(&state));
        assert_eq!(std::fs::read_dir(&state).unwrap().count(), 0);
        assert_ne!(
            Some(state),
            super::home().map(|home| home.join(".local/state/openlimiter"))
        );
    }
}
