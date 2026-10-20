//! The order provider blocks are shown in, one record every surface reads.
//!
//! Most used first is the default and what every version before 2.1.7 did.
//! The first time a person moves a block, the window or the edge panel writes
//! "custom" with the list it showed, and from then on the window, the edge
//! panel and the native tray menu follow that list. Choosing most used first
//! again keeps the list, so choosing the person's own order brings it back.
//!
//! Every write names the revision it was made from. The window and the edge
//! panel each hold a copy, so a write made from an old copy is refused rather
//! than silently undoing a newer one; the caller reloads. A missing,
//! unreadable or invalid file reads as most used first.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Sent to every webview after a write lands, with the new record.
pub const ORDER_CHANGED_EVENT: &str = "provider-order-changed";

const FILE_NAME: &str = "provider-order.json";
const DOCUMENT_VERSION: u32 = 1;
/// More than every provider the product knows, and small enough to bound.
const MAX_PROVIDERS: usize = 64;
/// The webviews read the revision as a JavaScript number.
const MAX_REVISION: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Usage,
    Custom,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOrder {
    pub mode: Mode,
    pub providers: Vec<String>,
    pub revision: u64,
}

impl ProviderOrder {
    /// Where a provider sits in a person's own order; None in most used
    /// first, and for a provider the list does not name yet.
    pub fn position(&self, code: &str) -> Option<usize> {
        if self.mode != Mode::Custom {
            return None;
        }
        self.providers.iter().position(|entry| entry == code)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    mode: Mode,
    providers: Vec<String>,
    revision: u64,
}

/// What a webview asks for: the record it wants, and the revision it saw.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrderInput {
    pub revision: u64,
    pub mode: Mode,
    pub providers: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OrderFailure {
    InvalidInput,
    StaleRevision,
    Storage,
}

/// Provider codes as every surface spells them: CLAUDE, GEMINI_CLI. Unique.
fn valid_list(providers: &[String]) -> bool {
    providers.len() <= MAX_PROVIDERS
        && providers.iter().enumerate().all(|(index, code)| {
            (1..=32).contains(&code.len())
                && code.as_bytes()[0].is_ascii_uppercase()
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
                && !providers[..index].contains(code)
        })
}

pub struct OrderStore {
    file: Option<PathBuf>,
    writing: Mutex<()>,
}

impl OrderStore {
    pub fn at(directory: Option<PathBuf>) -> Self {
        Self {
            file: directory.map(|directory| directory.join(FILE_NAME)),
            writing: Mutex::new(()),
        }
    }

    pub fn at_state_directory() -> Self {
        Self::at(crate::state::state_directory())
    }

    /// The record on disk, or most used first when there is none to trust.
    pub fn read(&self) -> ProviderOrder {
        self.file
            .as_deref()
            .and_then(crate::fsx::bounded_read)
            .and_then(|text| serde_json::from_str::<Document>(&text).ok())
            .filter(|document| {
                document.version == DOCUMENT_VERSION
                    && document.revision <= MAX_REVISION
                    && valid_list(&document.providers)
            })
            .map(|document| ProviderOrder {
                mode: document.mode,
                providers: document.providers,
                revision: document.revision,
            })
            .unwrap_or_default()
    }

    /// Write the record a webview asked for, one writer at a time, only from
    /// the revision on disk, and atomically. The new record comes back with
    /// the next revision; nothing changes when anything fails.
    pub fn write(&self, input: OrderInput) -> Result<ProviderOrder, OrderFailure> {
        if !valid_list(&input.providers) {
            return Err(OrderFailure::InvalidInput);
        }
        let _one_writer = self.writing.lock().map_err(|_| OrderFailure::Storage)?;
        let current = self.read();
        if input.revision != current.revision {
            return Err(OrderFailure::StaleRevision);
        }
        let revision = current.revision + 1;
        if revision > MAX_REVISION {
            return Err(OrderFailure::Storage);
        }
        let path = self.file.as_ref().ok_or(OrderFailure::Storage)?;
        let parent = path.parent().ok_or(OrderFailure::Storage)?;
        crate::fsx::ensure_private_dir(parent).map_err(|_| OrderFailure::Storage)?;
        let document = Document {
            version: DOCUMENT_VERSION,
            mode: input.mode,
            providers: input.providers,
            revision,
        };
        let text = serde_json::to_string(&document).map_err(|_| OrderFailure::Storage)?;
        crate::fsx::atomic_write(path, &text).map_err(|_| OrderFailure::Storage)?;
        Ok(ProviderOrder {
            mode: document.mode,
            providers: document.providers,
            revision,
        })
    }
}

fn commit(
    store: &OrderStore,
    input: OrderInput,
    announce: impl FnOnce(&ProviderOrder),
) -> Result<ProviderOrder, OrderFailure> {
    let next = store.write(input)?;
    announce(&next);
    Ok(next)
}

/// The record, for the window, the edge panel and Settings.
#[tauri::command]
pub fn provider_order(store: tauri::State<'_, OrderStore>) -> ProviderOrder {
    store.read()
}

/// Write the record, then tell every surface. A stale revision is refused.
#[tauri::command]
pub fn set_provider_order(
    app: tauri::AppHandle,
    store: tauri::State<'_, OrderStore>,
    input: OrderInput,
) -> Result<ProviderOrder, OrderFailure> {
    commit(&store, input, |order| {
        use tauri::Emitter;
        let _ = app.emit(ORDER_CHANGED_EVENT, order);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn input(revision: u64, mode: Mode, providers: &[&str]) -> OrderInput {
        OrderInput {
            revision,
            mode,
            providers: providers.iter().map(|code| code.to_string()).collect(),
        }
    }

    #[test]
    fn a_missing_file_is_most_used_first() {
        let dir = TempDir::new();
        let store = OrderStore::at(Some(dir.path().to_path_buf()));
        assert_eq!(store.read(), ProviderOrder::default());
        assert_eq!(store.read().mode, Mode::Usage);
        assert_eq!(OrderStore::at(None).read(), ProviderOrder::default());
    }

    #[test]
    fn an_unreadable_or_invalid_file_is_most_used_first() {
        let dir = TempDir::new();
        let path = dir.path().join(FILE_NAME);
        let store = OrderStore::at(Some(dir.path().to_path_buf()));
        for written in [
            "not json",
            "{}",
            r#"{"version":2,"mode":"custom","providers":["CLAUDE"],"revision":3}"#,
            r#"{"version":1,"mode":"sideways","providers":["CLAUDE"],"revision":3}"#,
            r#"{"version":1,"mode":"custom","providers":["claude"],"revision":3}"#,
            r#"{"version":1,"mode":"custom","providers":["CLAUDE","CLAUDE"],"revision":3}"#,
            r#"{"version":1,"mode":"custom","providers":["CLAUDE"],"revision":9007199254740992}"#,
            r#"{"version":1,"mode":"custom","providers":["CLAUDE"],"revision":3,"extra":true}"#,
        ] {
            std::fs::write(&path, written).expect("fixture");
            assert_eq!(store.read(), ProviderOrder::default(), "{written}");
        }
        std::fs::remove_file(&path).expect("remove fixture");
        std::fs::create_dir_all(&path).expect("a directory where the file belongs");
        assert_eq!(store.read(), ProviderOrder::default());
    }

    #[test]
    fn a_write_round_trips_with_the_next_revision() {
        let dir = TempDir::new();
        let store = OrderStore::at(Some(dir.path().to_path_buf()));
        let first = store
            .write(input(0, Mode::Custom, &["CODEX", "CLAUDE", "GEMINI_CLI"]))
            .expect("first write");
        assert_eq!(first.revision, 1);
        assert_eq!(first.mode, Mode::Custom);
        assert_eq!(first.providers, ["CODEX", "CLAUDE", "GEMINI_CLI"]);
        assert_eq!(store.read(), first);
        assert_eq!(OrderStore::at(Some(dir.path().to_path_buf())).read(), first, "it survives a restart");
        // Most used first keeps the list, so the person's own order can come back.
        let usage = store
            .write(input(1, Mode::Usage, &["CODEX", "CLAUDE", "GEMINI_CLI"]))
            .expect("mode write");
        assert_eq!((usage.mode, usage.revision), (Mode::Usage, 2));
        assert_eq!(usage.providers, first.providers);
        assert_eq!(usage.position("CODEX"), None, "most used first ignores the list");
        let back = store
            .write(input(2, Mode::Custom, &["CODEX", "CLAUDE", "GEMINI_CLI"]))
            .expect("mode back");
        assert_eq!(back.position("CLAUDE"), Some(1));
        assert_eq!(back.position("KIMI"), None);
    }

    #[test]
    fn a_stale_revision_is_refused_and_changes_nothing() {
        let dir = TempDir::new();
        let store = OrderStore::at(Some(dir.path().to_path_buf()));
        let first = store.write(input(0, Mode::Custom, &["CLAUDE", "CODEX"])).expect("first");
        // A second copy still at revision 0 tries to write.
        assert_eq!(
            store.write(input(0, Mode::Custom, &["CODEX", "CLAUDE"])),
            Err(OrderFailure::StaleRevision)
        );
        assert_eq!(
            store.write(input(7, Mode::Custom, &["CODEX", "CLAUDE"])),
            Err(OrderFailure::StaleRevision)
        );
        assert_eq!(store.read(), first);
    }

    #[test]
    fn invalid_input_is_refused_before_anything_is_written() {
        let dir = TempDir::new();
        let store = OrderStore::at(Some(dir.path().to_path_buf()));
        let many: Vec<String> = (0..65).map(|index| format!("P{index}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        for providers in [
            &["CLAUDE", "CLAUDE"][..],
            &["claude"][..],
            &["CLAUDE CODE"][..],
            &[""][..],
            &["1CLAUDE"][..],
            &many[..],
        ] {
            assert_eq!(
                store.write(input(0, Mode::Custom, providers)),
                Err(OrderFailure::InvalidInput),
                "{providers:?}"
            );
        }
        assert!(!dir.path().join(FILE_NAME).exists());
    }

    #[test]
    fn a_failed_write_leaves_the_record_as_it_was_and_announces_nothing() {
        let dir = TempDir::new();
        let store = OrderStore::at(Some(dir.path().to_path_buf()));
        let saved = store.write(input(0, Mode::Custom, &["CLAUDE", "CODEX"])).expect("saved");
        // A read only folder is not portable to every test machine; a folder
        // standing where the temporary file goes refuses the write everywhere.
        let blocked = OrderStore::at(Some(dir.path().join(FILE_NAME)));
        let mut announced = 0;
        assert_eq!(
            commit(&blocked, input(0, Mode::Custom, &["CODEX"]), |_| announced += 1),
            Err(OrderFailure::Storage)
        );
        assert_eq!(announced, 0);
        assert_eq!(store.read(), saved, "the record on disk is untouched");
        let mut stale = 0;
        assert_eq!(
            commit(&store, input(0, Mode::Custom, &["CODEX"]), |_| stale += 1),
            Err(OrderFailure::StaleRevision)
        );
        assert_eq!(stale, 0);
    }

    #[test]
    fn the_event_carries_the_new_record_only_after_it_is_on_disk() {
        let dir = TempDir::new();
        let store = OrderStore::at(Some(dir.path().to_path_buf()));
        let mut heard = Vec::new();
        let written = commit(&store, input(0, Mode::Custom, &["KIMI", "CLAUDE"]), |order| {
            assert_eq!(&store.read(), order, "announced before it was written");
            heard.push(order.clone());
        })
        .expect("written");
        assert_eq!(heard, [written.clone()]);
        assert_eq!(
            serde_json::to_value(&written).expect("serializes"),
            serde_json::json!({ "mode": "custom", "providers": ["KIMI", "CLAUDE"], "revision": 1 })
        );
        assert_eq!(
            serde_json::to_value(OrderFailure::StaleRevision).expect("serializes"),
            serde_json::json!({ "kind": "stale_revision" })
        );
    }

    #[test]
    fn concurrent_writers_from_one_revision_end_with_one_winner() {
        let dir = TempDir::new();
        let store = std::sync::Arc::new(OrderStore::at(Some(dir.path().to_path_buf())));
        let results: Vec<_> = (0..8)
            .map(|index| {
                let store = store.clone();
                std::thread::spawn(move || {
                    let code = format!("P{index}");
                    store.write(input(0, Mode::Custom, &[code.as_str()]))
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().expect("writer"))
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter(|result| result.is_err())
            .all(|result| *result == Err(OrderFailure::StaleRevision)));
        assert_eq!(store.read().revision, 1);
    }
}
