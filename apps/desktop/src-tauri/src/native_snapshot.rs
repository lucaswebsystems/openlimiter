use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::cache_write::{CacheWriteError, CacheWriter};
pub use crate::native_time::{
    epoch_ms_from_rfc3339, future_epoch_seconds, future_rfc3339, iso_from_epoch_ms,
};

pub const MAX_CACHE_ENTRIES: usize = 64;
const MAX_AMOUNT: f64 = 1_000_000.0;
const MAX_VALUE: f64 = 1_000_000_000_000.0;

/// Every provider code the cache vocabulary names, mirroring `ProviderCode` in
/// packages/core/src/types.ts. A registered code is not yet a displayed one:
/// `normalize_snapshot` also asks whether the provider is switched on, so a row
/// naming a 2.1 provider is dropped until its lane enables it.
const PROVIDER_CODES: &[&str] = &[
    "CLAUDE",
    "OPENROUTER",
    "CODEX",
    "ANTIGRAVITY",
    "GEMINI_CLI",
    "OPENCODE",
    "GROK",
    "KIMI",
    "CURSOR",
    "SYNTHETIC",
    "ZAI",
    "MINIMAX",
    "CLINE",
    "AUGMENT",
    "AMP",
    "KILO",
    "COPILOT",
    "MANUAL",
];
const VERIFICATIONS: &[&str] = &["UNVERIFIED", "VERIFIED_FIXTURES", "VERIFIED_LIVE"];
const SNAPSHOT_KINDS: &[&str] = &[
    "quota_percent",
    "money_balance",
    "spend",
    "token_count",
    "runtime_info",
];
const AVAILABILITIES: &[&str] = &[
    "missing_credentials",
    "expired_credentials",
    "access_denied",
    "missing_subscription",
    "unlimited",
    "quota_unavailable",
    "rate_limited",
    "network_failure",
    "schema_drift",
];

// New optional fields may be absent, but an explicit null is not a valid value.
fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationEvidence {
    pub provider_version: String,
    pub account_shape: String,
    pub os: String,
    /// Canonical ISO instant, using the same format as observed_at.
    pub date: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotWindow {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
/// Source = source plus provenance, precision = precision,
/// verification = labels.verification. Validation never upgrades verification.
pub struct ConnectorLabels {
    pub credential_origin: String,
    pub data_interface_status: String,
    pub automation_risk: String,
    pub verification: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub verification_evidence: Option<VerificationEvidence>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub provider: String,
    pub meter: String,
    pub value: f64,
    pub unit: String,
    pub window: SnapshotWindow,
    pub reset_at: Option<String>,
    pub source: String,
    pub precision: String,
    pub observed_at: String,
    pub expires_at: String,
    pub labels: ConnectorLabels,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// A human name for the account this row belongs to.
    ///
    /// `account_id` is an identifier, safe to key a cache on and unreadable.
    /// A surface that prints it prints exactly that, which is right for an
    /// account a person named and wrong for one this product had to invent,
    /// such as the Gemini CLI login borrowed for the shared Code Assist pool.
    /// Absent means the surface falls back to the identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Value>,
    /// Which OpenLimiter process last wrote this row.
    ///
    /// The cache is shared by every surface on the machine and two of them can
    /// poll: this tray, which runs all day, and the command line tool, which
    /// wakes up when a status line asks it to. Without this field neither can
    /// tell whether the other is already keeping the rows fresh, so both poll
    /// and the provider sees twice the traffic it should. The command line
    /// tool stamps `cli` and stands down when a `desktop` row is inside its
    /// freshness window; this build stamps `desktop` in `fold` so no reader
    /// has to remember to.
    ///
    /// This field also has to survive a write it did not cause. Every desktop
    /// write reads the whole document and writes it back, so a field this
    /// struct did not know about used to be dropped on the floor: a row the
    /// command line tool had stamped came back unstamped, and the two
    /// processes went back to polling in step. Reading it is as load bearing
    /// as writing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer: Option<String>,
    /// Absent means unknown. Never infer this from unit.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub kind: Option<String>,
    /// Consumers must never count a row carrying availability as a numeric reading,
    /// including when value is zero.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub availability: Option<String>,
    /// Canonical ISO instant, allowed only with rate_limited availability.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub retry_at: Option<String>,
}

/// The one value this process may stamp on a row.
///
/// Named here rather than at the call sites, because a second literal is how a
/// typo becomes a row nobody can attribute.
pub const DESKTOP_WRITER: &str = "desktop";

/// Every writer the shared cache format defines.
///
/// A row naming anything else is a row this build cannot believe, and an
/// unbelievable marker is dropped while the reading itself stands: how a
/// number arrived is a separate question from whether the number is in range.
const KNOWN_WRITERS: [&str; 2] = [DESKTOP_WRITER, "cli"];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Suppression {
    provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    reason: String,
    suppressed_at: String,
}

#[derive(Clone)]
pub enum CacheReport {
    Success(Vec<Snapshot>),
    Drift { observed_at: String },
    Unavailable,
}

fn safe_identifier(value: &str, uppercase: bool, maximum: usize) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    let valid_first = if uppercase {
        first.is_ascii_uppercase()
    } else {
        first.is_ascii_lowercase() || first.is_ascii_digit()
    };
    valid_first
        && value.len() <= maximum
        && bytes.all(|byte| {
            if uppercase {
                byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
            } else {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
            }
        })
}

fn is_canonical_iso(value: &str) -> bool {
    epoch_ms_from_rfc3339(value)
        .and_then(iso_from_epoch_ms)
        .is_some_and(|canonical| canonical == value)
}

pub(crate) fn normalize_snapshot(mut row: Snapshot) -> Option<Snapshot> {
    let provider_ok = PROVIDER_CODES.contains(&row.provider.as_str())
        && crate::provider_detection::code_enabled(&row.provider);
    let window_ok = ["rolling", "fixed", "lifetime", "unknown"].contains(&row.window.kind.as_str())
        && row
            .window
            .duration_seconds
            .is_none_or(|seconds| (1..=31_536_000).contains(&seconds));
    let labels_ok = [
        "official-local-tool",
        "user-key",
        "browser-session",
        "user-entered",
    ]
    .contains(&row.labels.credential_origin.as_str())
        && [
            "native-statusline-payload",
            "documented-api",
            "internal-endpoint",
            "authenticated-scrape",
            "manual",
        ]
        .contains(&row.labels.data_interface_status.as_str())
        && ["low", "high"].contains(&row.labels.automation_risk.as_str())
        && VERIFICATIONS.contains(&row.labels.verification.as_str())
        && row
            .labels
            .verification_evidence
            .as_ref()
            .is_none_or(|evidence| {
                row.labels.verification == "VERIFIED_LIVE"
                    && !evidence.provider_version.trim().is_empty()
                    && !evidence.account_shape.trim().is_empty()
                    && !evidence.os.trim().is_empty()
                    && is_canonical_iso(&evidence.date)
            });
    let basic = provider_ok
        && safe_identifier(&row.meter, true, 32)
        && row.value.is_finite()
        && row.value >= 0.0
        && row.value <= MAX_VALUE
        && ["PERCENT", "CREDITS", "TOKENS", "REQUESTS"].contains(&row.unit.as_str())
        && (row.unit != "PERCENT" || row.value <= 100.0)
        && window_ok
        && row.reset_at.as_deref().is_none_or(is_canonical_iso)
        && [
            "native_payload",
            "documented_api",
            "internal_payload",
            "authenticated_page",
            "manual_entry",
        ]
        .contains(&row.source.as_str())
        && ["exact", "estimated", "manual"].contains(&row.precision.as_str())
        && is_canonical_iso(&row.observed_at)
        && is_canonical_iso(&row.expires_at)
        && epoch_ms_from_rfc3339(&row.expires_at)? >= epoch_ms_from_rfc3339(&row.observed_at)?
        && row
            .account_id
            .as_deref()
            .is_none_or(|account| safe_identifier(account, false, 64))
        && labels_ok
        && row
            .kind
            .as_deref()
            .is_none_or(|kind| SNAPSHOT_KINDS.contains(&kind))
        && row
            .availability
            .as_deref()
            .is_none_or(|availability| AVAILABILITIES.contains(&availability))
        && row.retry_at.as_deref().is_none_or(|retry_at| {
            row.availability.as_deref() == Some("rate_limited") && is_canonical_iso(retry_at)
        });
    if !basic {
        return None;
    }
    /*
     * The amount pair, and why a used figure may exceed its limit.
     *
     * This used to require `used <= limit`, which read as a sanity check and
     * behaved as a silent edit: a paid overflow allowance that a working
     * session overran between two polls arrived with real dollars, failed that
     * one comparison, and reached disk as a full bar over no amounts at all,
     * which is the one reading nobody can act on. An overspend is not a
     * malformed pair, it is the state the account is actually in, and the
     * reader that produces it already caps the percentage at full.
     *
     * The bounds that remain are the ones that keep a row printable and
     * bounded: both figures finite, neither negative, neither past MAX_AMOUNT,
     * and a currency this cache stores. A pair failing those still costs
     * the pair, and never the row.
     */
    let amounts_ok = match (&row.used_amount, &row.limit_amount, &row.currency) {
        (None, None, None) => true,
        /* A balance or a spend may carry its currency alone: it has no
        denominator to travel in a pair with. The meter contract, in
        packages/core/src/data-rules.ts and data_rules::measure. */
        (None, None, Some(currency)) => {
            matches!(row.kind.as_deref(), Some("money_balance" | "spend"))
                && row.unit != "PERCENT"
                && ["USD", "CNY"].contains(&currency.as_str())
        }
        (Some(used), Some(limit), Some(currency)) => {
            used.is_finite()
                && limit.is_finite()
                && *used >= 0.0
                && *used <= MAX_AMOUNT
                && *limit >= 0.0
                && *limit <= MAX_AMOUNT
                && ["USD", "CNY"].contains(&currency.as_str())
        }
        _ => false,
    };
    if !amounts_ok {
        row.used_amount = None;
        row.limit_amount = None;
        row.currency = None;
    }
    /* A writer this build does not know is dropped rather than trusted, and
    dropping it is the honest answer: absent means unknown, which sends every
    reader back to polling, exactly as the product behaved before the field
    existed. */
    if !row
        .writer
        .as_deref()
        .is_none_or(|value| KNOWN_WRITERS.contains(&value))
    {
        row.writer = None;
    }
    /* The label is printed beside a bar, so it is bounded and free of control
    characters. A label that fails either is dropped and the surface falls back
    to the identifier. */
    if !row.account_label.as_deref().is_none_or(|value| {
        !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
    }) {
        row.account_label = None;
    }
    if row.provenance.as_ref().is_some_and(|value| {
        let source_kind = value.get("sourceKind").and_then(Value::as_str);
        let observed_via = value.get("observedVia").and_then(Value::as_str);
        ![
            "statusline_payload",
            "explicit_ingest",
            "manual_document",
            "remote_api",
            "unknown",
        ]
        .contains(&source_kind.unwrap_or_default())
            || ![
                "claude_code_statusline",
                "ingest_command",
                "manual_json",
                "local_event",
                "local_file",
                "local_command",
                "remote_http",
                "user_entry",
                "unknown",
            ]
            .contains(&observed_via.unwrap_or_default())
    }) {
        row.provenance = Some(serde_json::json!({
            "observedVia": "unknown",
            "sourceKind": "unknown"
        }));
    }
    Some(row)
}

fn read_document(text: Option<&str>) -> Result<(Vec<Snapshot>, Vec<Suppression>), CacheWriteError> {
    read_document_for_surface(text, false)
}

fn read_document_for_surface(
    text: Option<&str>,
    require_supported_version: bool,
) -> Result<(Vec<Snapshot>, Vec<Suppression>), CacheWriteError> {
    let root = text
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    if require_supported_version
        && root
            .get("version")
            .is_some_and(|version| !matches!(version.as_u64(), Some(1 | 2)))
    {
        return Err(CacheWriteError::NotJson);
    }
    let rows = root
        .get("snapshots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<Snapshot>(value.clone()).ok())
        .filter_map(normalize_snapshot)
        .collect();
    let suppressions = match root.get("suppressions") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(entries)) if entries.len() <= MAX_CACHE_ENTRIES => {
            let mut read = Vec::with_capacity(entries.len());
            for entry in entries {
                let suppression: Suppression =
                    serde_json::from_value(entry.clone()).map_err(|_| CacheWriteError::NotJson)?;
                let valid = suppression.reason == "drift"
                    && PROVIDER_CODES.contains(&suppression.provider.as_str())
                    && is_canonical_iso(&suppression.suppressed_at)
                    && suppression
                        .account_id
                        .as_deref()
                        .is_none_or(|account| safe_identifier(account, false, 64));
                if !valid {
                    return Err(CacheWriteError::NotJson);
                }
                read.push(suppression);
            }
            read
        }
        Some(_) => return Err(CacheWriteError::NotJson),
    };
    Ok((rows, suppressions))
}

fn account_matches(existing: Option<&str>, target: Option<&str>) -> bool {
    existing == target
}

/// Read only display access to the same validated cache rows used by native writers.
/// A suppression withdraws a reading until that identity has a newer observation.
pub(crate) fn display_snapshots(text: Option<&str>) -> Vec<Snapshot> {
    let Ok((rows, suppressions)) = read_document_for_surface(text, true) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter(|row| {
            !suppressions.iter().any(|suppression| {
                row.provider == suppression.provider
                    && row.account_id == suppression.account_id
                    && row.observed_at <= suppression.suppressed_at
            })
        })
        .collect()
}

fn identity(row: &Snapshot) -> String {
    format!(
        "{} {}{}",
        row.provider,
        row.meter,
        row.account_id
            .as_deref()
            .map(|account| format!(" {account}"))
            .unwrap_or_default()
    )
}

fn fold(
    text: Option<&str>,
    provider: &str,
    account_id: Option<&str>,
    report: &CacheReport,
) -> Result<String, CacheWriteError> {
    let (mut rows, mut suppressions) = read_document(text)?;
    let observed = match report {
        CacheReport::Success(incoming) => incoming.iter().map(|row| row.observed_at.as_str()).max(),
        CacheReport::Drift { observed_at } => Some(observed_at.as_str()),
        CacheReport::Unavailable => None,
    };
    let delayed = observed.is_some_and(|at| {
        rows.iter().any(|row| {
            row.provider == provider
                && row.account_id.as_deref() == account_id
                && row.observed_at.as_str() > at
        }) || suppressions.iter().any(|entry| {
            entry.provider == provider
                && entry.account_id.as_deref() == account_id
                && entry.suppressed_at.as_str() > at
        })
    });
    let belongs = |existing: Option<&str>| match report {
        CacheReport::Unavailable => existing == account_id,
        CacheReport::Success(_) | CacheReport::Drift { .. } => {
            account_matches(existing, account_id)
        }
    };
    rows.retain(|row| delayed || row.provider != provider || !belongs(row.account_id.as_deref()));
    suppressions.retain(|entry| {
        delayed || entry.provider != provider || !belongs(entry.account_id.as_deref())
    });
    if !delayed {
        match report {
            /* Stamped here and nowhere else. Every row this process writes reaches
            disk through this fold, so one line makes the whole desktop attributable
            and no reader has to remember to set it. A row that arrives already
            claiming another writer is corrected: this process is the one writing
            it. */
            CacheReport::Success(incoming) => {
                rows.extend(incoming.iter().cloned().filter_map(|row| {
                    normalize_snapshot(Snapshot {
                        writer: Some(DESKTOP_WRITER.to_string()),
                        ..row
                    })
                }))
            }
            CacheReport::Drift { observed_at } => suppressions.push(Suppression {
                provider: provider.to_string(),
                account_id: account_id.map(str::to_string),
                reason: "drift".to_string(),
                suppressed_at: observed_at.clone(),
            }),
            CacheReport::Unavailable => {}
        }
    }
    let now = match report {
        CacheReport::Success(incoming) => incoming
            .iter()
            .filter_map(|row| epoch_ms_from_rfc3339(&row.observed_at))
            .max()
            .unwrap_or_else(crate::connections::now_epoch_ms),
        CacheReport::Drift { observed_at } => {
            epoch_ms_from_rfc3339(observed_at).unwrap_or_else(crate::connections::now_epoch_ms)
        }
        CacheReport::Unavailable => crate::connections::now_epoch_ms(),
    };
    rows.retain(|row| crate::data_rules::retained(row, now));
    let mut by_identity = BTreeMap::new();
    for row in rows {
        by_identity.insert(identity(&row), row);
    }
    let mut rows: Vec<Snapshot> = by_identity.into_values().collect();
    if rows.len() > MAX_CACHE_ENTRIES {
        rows.sort_by(|left, right| {
            let left_ms = epoch_ms_from_rfc3339(&left.observed_at).unwrap_or(0);
            let right_ms = epoch_ms_from_rfc3339(&right.observed_at).unwrap_or(0);
            right_ms
                .cmp(&left_ms)
                .then_with(|| identity(left).cmp(&identity(right)))
        });
        rows.truncate(MAX_CACHE_ENTRIES);
        rows.sort_by_key(identity);
    }
    if suppressions.len() > MAX_CACHE_ENTRIES {
        suppressions.sort_by(|left, right| {
            let left_ms = epoch_ms_from_rfc3339(&left.suppressed_at).unwrap_or(0);
            let right_ms = epoch_ms_from_rfc3339(&right.suppressed_at).unwrap_or(0);
            right_ms.cmp(&left_ms).then(Ordering::Equal)
        });
        suppressions.truncate(MAX_CACHE_ENTRIES);
    }
    let mut document = Map::new();
    document.insert(
        "snapshots".to_string(),
        serde_json::to_value(rows).map_err(|_| CacheWriteError::Io)?,
    );
    if !suppressions.is_empty() {
        document.insert(
            "suppressions".to_string(),
            serde_json::to_value(suppressions).map_err(|_| CacheWriteError::Io)?,
        );
    }
    document.insert("version".to_string(), Value::from(2));
    serde_json::to_string(&Value::Object(document)).map_err(|_| CacheWriteError::Io)
}

/// One provider's current rows, taken from a cache document.
fn rows_for(text: Option<&str>, provider: &str) -> Vec<Snapshot> {
    let Ok((rows, _)) = read_document(text) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter(|row| row.provider == provider)
        .collect()
}

/// Copy one provider's rows onto another provider, under a stated account.
///
/// Antigravity and Gemini CLI draw on one Google Code Assist pool, so a
/// machine with a Gemini login already holds the numbers an Antigravity row
/// wants. Mirroring them is the last thing tried, after the running client and
/// after the provider's own endpoint, and it is filed under an account of its
/// own so a reading borrowed from another login can never be mistaken on a
/// bar, in the cache or in a sync for a login somebody made to Antigravity.
///
/// The whole thing happens inside one lock: the document is read, the mirror
/// is built from what was read, and the result is committed against the same
/// generation. Reading in one lock and writing in another is how a mirror ends
/// up copying rows that were replaced in between.
///
/// `Ok(false)` means the source had nothing to mirror, which is a fact and not
/// a failure.
pub fn mirror_provider(
    writer: &CacheWriter,
    source: &str,
    target: &str,
    account_id: &str,
    account_label: &str,
) -> Result<bool, CacheWriteError> {
    for round in 0..2 {
        let begun = writer.begin()?;
        let borrowed = rows_for(begun.text.as_deref(), source);
        if borrowed.is_empty() {
            writer.abort(begun.generation);
            return Ok(false);
        }
        /* The freshness is the source's, unchanged. A mirror is the same
        reading seen through another name, so restamping it with the instant it
        was copied would make a two hour old number look like a new one, and
        would let a reading that had already expired come back to life. Both
        rows age out together, which is the truth. */
        let mirrored: Vec<Snapshot> = borrowed
            .into_iter()
            .map(|row| Snapshot {
                provider: target.to_string(),
                account_id: Some(account_id.to_string()),
                account_label: Some(account_label.to_string()),
                ..row
            })
            .filter_map(normalize_snapshot)
            .collect();
        /* Nothing survived, so nothing is claimed. Without this a source whose
        rows had already expired would report a mirror that wrote no row, and
        the caller would tell somebody their bar was filled from the Gemini
        login when it was not filled at all. */
        if mirrored.is_empty() {
            writer.abort(begun.generation);
            return Ok(false);
        }
        let text = match fold(
            begun.text.as_deref(),
            target,
            Some(account_id),
            &CacheReport::Success(mirrored),
        ) {
            Ok(text) => text,
            Err(error) => {
                writer.abort(begun.generation);
                return Err(error);
            }
        };
        match writer.commit(&text, begun.generation) {
            Ok(()) => return Ok(true),
            Err(CacheWriteError::Busy | CacheWriteError::StaleGeneration) if round == 0 => {}
            Err(error) => return Err(error),
        }
    }
    Err(CacheWriteError::Busy)
}

pub fn write_report(
    writer: &CacheWriter,
    provider: &str,
    account_id: Option<&str>,
    report: CacheReport,
) -> Result<(), CacheWriteError> {
    for round in 0..2 {
        let begun = writer.begin()?;
        let text = match fold(begun.text.as_deref(), provider, account_id, &report) {
            Ok(text) => text,
            Err(error) => {
                writer.abort(begun.generation);
                return Err(error);
            }
        };
        match writer.commit(&text, begun.generation) {
            Ok(()) => return Ok(()),
            Err(CacheWriteError::Busy | CacheWriteError::StaleGeneration) if round == 0 => {}
            Err(error) => return Err(error),
        }
    }
    Err(CacheWriteError::Busy)
}

pub fn prune_cache(writer: &CacheWriter, now: u64) -> Result<usize, CacheWriteError> {
    let begun = writer.begin()?;
    let result = (|| {
        let (mut rows, suppressions) = read_document_for_surface(begun.text.as_deref(), true)?;
        let before = rows.len();
        rows.retain(|row| crate::data_rules::retained(row, now));
        if rows.len() == before {
            writer.abort(begun.generation);
            return Ok(0);
        }
        let count = before - rows.len();
        let text =
            serde_json::json!({ "version": 2, "snapshots": rows, "suppressions": suppressions })
                .to_string();
        writer.commit(&text, begun.generation)?;
        Ok(count)
    })();
    if result.is_err() {
        writer.abort(begun.generation);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_readers::parse_body;
    use crate::reader_registry::ReaderId;

    #[test]
    fn retention_and_delayed_accounts_never_alias_anonymous_rows() {
        let mut anonymous: Snapshot = serde_json::from_str(LEGACY_ROW).unwrap();
        anonymous.account_id = None;
        let mut current = anonymous.clone();
        current.account_id = Some("fixture-current".into());
        let mut old = current.clone();
        old.account_id = Some("fixture-old".into());
        old.observed_at = "2026-08-01T00:00:00.000Z".into();
        let text = serde_json::json!({"version":2,"snapshots":[anonymous, old]}).to_string();
        let written = fold(
            Some(&text),
            "CLAUDE",
            Some("fixture-current"),
            &CacheReport::Success(vec![current.clone()]),
        )
        .unwrap();
        let rows = display_snapshots(Some(&written));
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| row.account_id.is_none()));
        assert!(!rows
            .iter()
            .any(|row| row.account_id.as_deref() == Some("fixture-old")));
        let mut delayed = current.clone();
        delayed.observed_at = "2026-08-16T11:59:00.000Z".into();
        delayed.value = 10.0;
        let written = fold(
            Some(&written),
            "CLAUDE",
            Some("fixture-current"),
            &CacheReport::Success(vec![delayed]),
        )
        .unwrap();
        assert_eq!(
            display_snapshots(Some(&written))
                .iter()
                .find(|row| row.account_id == current.account_id)
                .unwrap()
                .value,
            current.value
        );
    }

    // Frozen serialization of the existing overspent_extra_usage test row.
    const LEGACY_ROW: &str = r#"{"provider":"CLAUDE","meter":"EXTRA_USAGE","value":100.0,"unit":"PERCENT","window":{"kind":"fixed"},"resetAt":null,"source":"internal_payload","precision":"exact","observedAt":"2026-08-16T12:00:00.000Z","expiresAt":"2026-08-16T12:20:00.000Z","labels":{"credentialOrigin":"official-local-tool","dataInterfaceStatus":"internal-endpoint","automationRisk":"high","verification":"UNVERIFIED"},"usedAmount":62.5,"limitAmount":50.0,"currency":"USD","accountId":"claude-overspend"}"#;

    fn contract_row() -> Value {
        serde_json::from_str(LEGACY_ROW).expect("legacy row")
    }

    fn validate_contract(value: Value) -> Option<Snapshot> {
        serde_json::from_value(value)
            .ok()
            .and_then(normalize_snapshot)
    }

    fn evidence() -> Value {
        serde_json::json!({
            "providerVersion": "2.0.0", "accountShape": "individual", "os": "windows",
            "date": "2026-01-01T00:00:00.000Z"
        })
    }

    #[test]
    fn local_contract_legacy_bytes() {
        let now = epoch_ms_from_rfc3339("2026-08-16T12:00:00.000Z").unwrap();
        assert_eq!(
            serde_json::to_string(&overspent_extra_usage(now)).unwrap(),
            LEGACY_ROW
        );
        let row: Snapshot = serde_json::from_str(LEGACY_ROW).unwrap();
        let result = normalize_snapshot(row).expect("legacy row still validates");
        assert_eq!(serde_json::to_string(&result).unwrap(), LEGACY_ROW);
        assert!(result.kind.is_none());
        assert!(result.availability.is_none());
        assert!(result.retry_at.is_none());
        assert!(result.labels.verification_evidence.is_none());
    }

    #[test]
    fn local_contract_verification() {
        for verification in VERIFICATIONS {
            let mut row = contract_row();
            row["labels"]["verification"] = Value::from(*verification);
            let result = validate_contract(row.clone()).expect("known verification");
            assert_eq!(result.labels.verification, *verification);
            assert_eq!(serde_json::to_value(&result).unwrap(), row);
            let parsed: Snapshot =
                serde_json::from_str(&serde_json::to_string(&result).unwrap()).unwrap();
            assert_eq!(
                normalize_snapshot(parsed).unwrap().labels.verification,
                *verification
            );
        }
        for verification in [
            Value::from("VERIFIED"),
            Value::from("verified_live"),
            Value::from(""),
            Value::Null,
            Value::from(1),
        ] {
            let mut row = contract_row();
            row["labels"]["verification"] = verification;
            assert!(validate_contract(row).is_none());
        }
        for verification in [None, Some("UNVERIFIED"), Some("VERIFIED_FIXTURES")] {
            let mut row = contract_row();
            if let Some(value) = verification {
                row["labels"]["verification"] = Value::from(value);
            } else {
                row["labels"]
                    .as_object_mut()
                    .unwrap()
                    .remove("verification");
            }
            row["labels"]["verificationEvidence"] = evidence();
            assert!(validate_contract(row).is_none());
        }
        let mut live = contract_row();
        live["labels"]["verification"] = Value::from("VERIFIED_LIVE");
        live["labels"]["verificationEvidence"] = evidence();
        let result = validate_contract(live.clone()).expect("live evidence");
        assert_eq!(serde_json::to_value(result).unwrap(), live);
        for invalid in [
            Value::Null,
            serde_json::json!([]),
            serde_json::json!({}),
            Value::from("proof"),
        ] {
            let mut row = live.clone();
            row["labels"]["verificationEvidence"] = invalid;
            assert!(validate_contract(row).is_none());
        }
        for (field, value) in [
            ("providerVersion", Value::from(" ")),
            ("accountShape", Value::from(1)),
            ("os", Value::from("")),
            ("date", Value::from("2026-01-01")),
            ("date", Value::from("2026-02-30T00:00:00.000Z")),
        ] {
            let mut row = live.clone();
            row["labels"]["verificationEvidence"][field] = value;
            assert!(validate_contract(row).is_none());
        }
    }

    #[test]
    fn local_contract_kind_currency() {
        for kind in SNAPSHOT_KINDS {
            let mut row = contract_row();
            row["kind"] = Value::from(*kind);
            assert_eq!(
                serde_json::to_value(validate_contract(row.clone()).unwrap()).unwrap(),
                row
            );
        }
        for kind in [
            Value::from("unknown"),
            Value::from("PERCENT"),
            Value::from(""),
            Value::Null,
            Value::from(1),
        ] {
            let mut row = contract_row();
            row["kind"] = kind;
            assert!(validate_contract(row).is_none());
        }
        for unit in ["PERCENT", "CREDITS", "TOKENS", "REQUESTS"] {
            let mut row = contract_row();
            row["unit"] = Value::from(unit);
            assert!(validate_contract(row).unwrap().kind.is_none());
        }
        for used in [0.0, 12.47, MAX_AMOUNT] {
            let mut row = contract_row();
            row["usedAmount"] = Value::from(used);
            row["currency"] = Value::from("CNY");
            let result = validate_contract(row.clone()).expect("CNY amount");
            assert_eq!(result.used_amount, Some(used));
            assert_eq!(result.limit_amount, Some(50.0));
            assert_eq!(result.currency.as_deref(), Some("CNY"));
            assert_eq!(serde_json::to_value(result).unwrap(), row);
        }
        assert_eq!(MAX_AMOUNT, 1_000_000.0);
        let mut row = contract_row();
        row["usedAmount"] = Value::from(MAX_AMOUNT + 1.0);
        row["currency"] = Value::from("CNY");
        assert!(validate_contract(row).unwrap().currency.is_none());
    }

    #[test]
    fn local_contract_availability() {
        let retry_at = "2026-01-01T00:01:00.000Z";
        for availability in AVAILABILITIES {
            let mut row = contract_row();
            row["value"] = Value::from(0.0);
            row["availability"] = Value::from(*availability);
            assert_eq!(
                serde_json::to_value(validate_contract(row.clone()).unwrap()).unwrap(),
                row
            );
            row["retryAt"] = Value::from(retry_at);
            let result = validate_contract(row);
            if *availability == "rate_limited" {
                assert_eq!(result.unwrap().retry_at.as_deref(), Some(retry_at));
            } else {
                assert!(result.is_none());
            }
        }
        for availability in [
            Value::from("unknown"),
            Value::from("no_credential"),
            Value::from(""),
            Value::Null,
            Value::from(1),
        ] {
            let mut row = contract_row();
            row["availability"] = availability;
            assert!(validate_contract(row).is_none());
        }
        let mut row = contract_row();
        row["retryAt"] = Value::from(retry_at);
        assert!(validate_contract(row).is_none());
        for retry_at in [
            Value::Null,
            Value::from(1),
            Value::from("soon"),
            Value::from("2026-01-01"),
            Value::from("2026-02-30T00:00:00.000Z"),
        ] {
            let mut row = contract_row();
            row["availability"] = Value::from("rate_limited");
            row["retryAt"] = retry_at;
            assert!(validate_contract(row).is_none());
        }
        let mut row = contract_row();
        row["value"] = Value::from(0.0);
        let result = validate_contract(row).expect("zero is a numeric reading");
        assert_eq!(result.value, 0.0);
        assert!(result.availability.is_none());
    }

    #[test]
    fn local_contract_provider_codes() {
        /* The 2.1 providers are registered here ahead of their readers, and a
        row naming one is refused until its provider is switched on, the same
        answer an unknown code gets. Every switched on code still validates. */
        for provider in PROVIDER_CODES {
            let mut row = contract_row();
            row["provider"] = Value::from(*provider);
            if crate::provider_detection::code_enabled(provider) {
                assert_eq!(validate_contract(row).unwrap().provider, *provider);
            } else {
                assert!(validate_contract(row).is_none(), "{provider} is switched off");
            }
        }
        for wave in ["SYNTHETIC", "ZAI", "MINIMAX", "CLINE", "AUGMENT", "AMP", "KILO", "COPILOT"] {
            assert!(PROVIDER_CODES.contains(&wave));
        }
        let mut row = contract_row();
        row["provider"] = Value::from("UNRECOGNIZED");
        assert!(validate_contract(row).is_none());
    }

    #[test]
    fn native_fold_commits_a_read_and_drift_never_writes_zero() {
        let now = epoch_ms_from_rfc3339("2026-08-16T12:00:00.000Z").expect("fixture clock");
        let account = "native-snapshot-test";
        let rows = parse_body(
            ReaderId::OpenrouterCredits,
            r#"{"data":{"total_credits":20,"total_usage":5}}"#,
            now,
            account,
        )
        .expect("readable fixture");
        let committed = fold(
            None,
            "OPENROUTER",
            Some(account),
            &CacheReport::Success(rows),
        )
        .expect("success fold");
        assert!(committed.contains("25.0"));
        let drifted = fold(
            Some(&committed),
            "OPENROUTER",
            Some(account),
            &CacheReport::Drift {
                observed_at: iso_from_epoch_ms(now + 1_000).expect("drift clock"),
            },
        )
        .expect("drift fold");
        let document: Value = serde_json::from_str(&drifted).expect("cache document");
        assert_eq!(document["snapshots"].as_array().map(Vec::len), Some(0));
        assert_eq!(document["suppressions"].as_array().map(Vec::len), Some(1));
        assert!(!drifted.contains("\"value\":0"));
    }

    /// Every row this process writes says so, and one line does it.
    ///
    /// The command line tool reads this marker to decide whether the tray is
    /// already keeping a provider fresh. A row that reaches disk unstamped
    /// reads as "nobody", which sends the terminal back to polling a provider
    /// this process polled ninety seconds ago.
    #[test]
    fn every_row_the_desktop_writes_is_stamped_desktop() {
        let now = epoch_ms_from_rfc3339("2026-09-07T12:00:00.000Z").expect("fixture clock");
        let rows = parse_body(
            ReaderId::OpenrouterCredits,
            r#"{"data":{"total_credits":20,"total_usage":5}}"#,
            now,
            "writer-marker",
        )
        .expect("readable fixture");
        assert!(rows.iter().all(|row| row.writer.is_none()));
        let committed = fold(
            None,
            "OPENROUTER",
            Some("writer-marker"),
            &CacheReport::Success(rows),
        )
        .expect("success fold");
        let document: Value = serde_json::from_str(&committed).expect("cache document");
        let written = document["snapshots"].as_array().expect("rows");
        assert!(!written.is_empty());
        for row in written {
            assert_eq!(row["writer"].as_str(), Some("desktop"));
        }
    }

    fn codex_body(now: u64) -> String {
        serde_json::json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 40,
                    "limit_window_seconds": 18_000,
                    "reset_at": (now + 3_600_000) / 1_000
                }
            }
        })
        .to_string()
    }

    /// A marker this process did not write survives a write it did not cause.
    ///
    /// Every desktop write reads the whole document and writes it back, so a
    /// field this struct does not know about is dropped on the floor. That is
    /// how a row the command line tool had stamped came back unstamped and the
    /// two processes went back to polling in step.
    #[test]
    fn another_writers_marker_survives_a_desktop_write() {
        let now = epoch_ms_from_rfc3339("2026-09-07T12:00:00.000Z").expect("fixture clock");
        let foreign = parse_body(
            ReaderId::CodexUsage,
            &codex_body(now),
            now,
            "codex-terminal",
        )
        .expect("readable codex fixture");
        let existing = fold(
            None,
            "CODEX",
            Some("codex-terminal"),
            &CacheReport::Success(foreign),
        )
        .expect("codex fold");
        let mut document: Value = serde_json::from_str(&existing).expect("cache document");
        for row in document["snapshots"].as_array_mut().expect("rows") {
            row["writer"] = Value::from("cli");
        }
        let foreign_document = document.to_string();

        let after = fold(
            Some(&foreign_document),
            "OPENROUTER",
            Some("openrouter-desktop"),
            &CacheReport::Success(
                parse_body(
                    ReaderId::OpenrouterCredits,
                    r#"{"data":{"total_credits":20,"total_usage":5}}"#,
                    now,
                    "openrouter-desktop",
                )
                .expect("readable fixture"),
            ),
        )
        .expect("second fold");
        let document: Value = serde_json::from_str(&after).expect("cache document");
        let rows = document["snapshots"].as_array().expect("rows");
        let codex: Vec<&Value> = rows
            .iter()
            .filter(|row| row["provider"].as_str() == Some("CODEX"))
            .collect();
        assert!(!codex.is_empty());
        for row in codex {
            assert_eq!(row["writer"], Value::from("cli"));
        }
        for row in rows
            .iter()
            .filter(|row| row["provider"].as_str() == Some("OPENROUTER"))
        {
            assert_eq!(row["writer"].as_str(), Some("desktop"));
        }
    }

    /// A writer name this build does not know costs the marker, never the row.
    #[test]
    fn an_unknown_writer_is_dropped_and_the_reading_stands() {
        let now = epoch_ms_from_rfc3339("2026-09-07T12:00:00.000Z").expect("fixture clock");
        let mut rows = parse_body(
            ReaderId::OpenrouterCredits,
            r#"{"data":{"total_credits":20,"total_usage":5}}"#,
            now,
            "writer-unknown",
        )
        .expect("readable fixture");
        rows[0].writer = Some("somebody-else".to_string());
        let normalized = normalize_snapshot(rows[0].clone()).expect("the reading still stands");
        assert_eq!(normalized.writer, None);
        assert_eq!(normalized.value, 25.0);
    }

    /// One account, one row, whichever process wrote it.
    ///
    /// The command line tool files a provider it cannot name under no account
    /// at all, and this build files the same provider under the account it
    /// resolved, so the same subscription used to appear twice in one cache.
    /// An anonymous observation cannot prove which named account emitted it.
    #[test]
    fn a_named_desktop_write_keeps_unproven_anonymous_identity_separate() {
        let now = epoch_ms_from_rfc3339("2026-09-07T12:00:00.000Z").expect("fixture clock");
        let mut unnamed = parse_body(ReaderId::CodexUsage, &codex_body(now), now, "ignored")
            .expect("readable codex fixture");
        for row in &mut unnamed {
            row.account_id = None;
        }
        let existing =
            fold(None, "CODEX", None, &CacheReport::Success(unnamed)).expect("unnamed fold");

        let named = parse_body(
            ReaderId::CodexUsage,
            &codex_body(now),
            now + 1_000,
            "codex-desktop",
        )
        .expect("readable codex fixture");
        let after = fold(
            Some(&existing),
            "CODEX",
            Some("codex-desktop"),
            &CacheReport::Success(named),
        )
        .expect("named fold");
        let document: Value = serde_json::from_str(&after).expect("cache document");
        let rows = document["snapshots"].as_array().expect("rows");
        assert!(!rows.is_empty());
        assert!(rows
            .iter()
            .any(|row| row["accountId"].as_str() == Some("codex-desktop")));
        assert!(rows.iter().any(|row| row.get("accountId").is_none()));
        assert!(rows
            .iter()
            .all(|row| row["writer"].as_str() == Some("desktop")));
    }

    #[test]
    fn unavailable_removes_only_the_scoped_remote_rows() {
        let now = crate::connections::now_epoch_ms();
        let mut scoped = parse_body(
            ReaderId::OpenrouterCredits,
            r#"{"data":{"total_credits":20,"total_usage":5}}"#,
            now,
            "work",
        )
        .expect("scoped fixture");
        let mut fallback = scoped[0].clone();
        fallback.account_id = None;
        scoped.push(fallback);
        let existing = fold(
            None,
            "OPENROUTER",
            Some("work"),
            &CacheReport::Success(scoped),
        )
        .expect("initial fold");
        let result = fold(
            Some(&existing),
            "OPENROUTER",
            Some("work"),
            &CacheReport::Unavailable,
        )
        .expect("unavailable fold");
        let document: Value = serde_json::from_str(&result).expect("cache document");
        let rows = document["snapshots"].as_array().expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("accountId"), None);
    }

    fn overspent_extra_usage(now: u64) -> Snapshot {
        Snapshot {
            provider: "CLAUDE".to_string(),
            meter: "EXTRA_USAGE".to_string(),
            value: 100.0,
            unit: "PERCENT".to_string(),
            window: SnapshotWindow {
                kind: "fixed".to_string(),
                duration_seconds: None,
            },
            reset_at: None,
            source: "internal_payload".to_string(),
            precision: "exact".to_string(),
            observed_at: iso_from_epoch_ms(now).expect("observed"),
            expires_at: iso_from_epoch_ms(now + 1_200_000).expect("expires"),
            labels: ConnectorLabels {
                credential_origin: "official-local-tool".to_string(),
                data_interface_status: "internal-endpoint".to_string(),
                automation_risk: "high".to_string(),
                verification: "UNVERIFIED".to_string(),
                verification_evidence: None,
            },
            used_amount: Some(62.5),
            limit_amount: Some(50.0),
            currency: Some("USD".to_string()),
            account_id: Some("claude-overspend".to_string()),
            account_label: None,
            writer: None,
            provenance: None,
            kind: None,
            availability: None,
            retry_at: None,
        }
    }

    /// A budget that was overrun is still a reading, on the way to disk and
    /// on the way back.
    ///
    /// The reader keeps an overspent extra usage allowance and caps its bar at
    /// full. Stripping the dollars here would undo exactly that: the row would
    /// arrive saying a hundred percent of nothing, which is the one number
    /// nobody can act on. Both amounts survive the write and the read.
    #[test]
    fn an_overspent_allowance_keeps_both_amounts_through_the_cache() {
        let now = epoch_ms_from_rfc3339("2026-08-16T12:00:00.000Z").expect("fixture clock");
        let committed = fold(
            None,
            "CLAUDE",
            Some("claude-overspend"),
            &CacheReport::Success(vec![overspent_extra_usage(now)]),
        )
        .expect("success fold");

        assert!(committed.contains("\"usedAmount\":62.5"));
        assert!(committed.contains("\"limitAmount\":50.0"));

        let (rows, _) = read_document(Some(&committed)).expect("cache document");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].meter, "EXTRA_USAGE");
        assert_eq!(rows[0].value, 100.0);
        assert_eq!(rows[0].used_amount, Some(62.5));
        assert_eq!(rows[0].limit_amount, Some(50.0));
        assert_eq!(rows[0].currency.as_deref(), Some("USD"));
    }

    /// The bounds that remain are the ones that keep a row printable: an
    /// amount outside them still costs the pair, an overspend does not.
    #[test]
    fn an_amount_outside_its_bounds_still_loses_the_pair() {
        let now = epoch_ms_from_rfc3339("2026-08-16T12:00:00.000Z").expect("fixture clock");
        for (used, limit, currency) in [
            (-1.0, 50.0, "USD"),
            (62.5, -50.0, "USD"),
            (MAX_AMOUNT + 1.0, 50.0, "USD"),
            (62.5, MAX_AMOUNT + 1.0, "USD"),
            (62.5, 50.0, "EUR"),
        ] {
            let mut row = overspent_extra_usage(now);
            row.used_amount = Some(used);
            row.limit_amount = Some(limit);
            row.currency = Some(currency.to_string());
            let normalized = normalize_snapshot(row).expect("the row itself survives");
            assert_eq!(normalized.used_amount, None);
            assert_eq!(normalized.limit_amount, None);
            assert_eq!(normalized.currency, None);
        }
    }
}
