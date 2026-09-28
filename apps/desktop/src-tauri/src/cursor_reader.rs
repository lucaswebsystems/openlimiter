// Independently implemented from endpoint facts in research/01-codenotch-harvest.md.
// No vendor code or identity is used. Live acquisition remains unverified.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::path::Path;

use crate::native_snapshot::{epoch_ms_from_rfc3339, iso_from_epoch_ms, Snapshot, SnapshotWindow};

// Deliberately neither Debug nor Serialize: credentials never enter diagnostics.
pub struct CursorSession {
    pub access_token: String,
    pub auth_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionFailure {
    MissingCredentials,
    AccessDenied,
    InvalidCredentials,
}

pub fn session(path: &Path) -> Result<CursorSession, SessionFailure> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            SessionFailure::MissingCredentials
        } else {
            SessionFailure::AccessDenied
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(SessionFailure::AccessDenied);
    }
    // READ_ONLY reads the active WAL. Never use immutable, checkpoint, backup or copy.
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| SessionFailure::AccessDenied)?;
    db.busy_timeout(std::time::Duration::from_millis(250))
        .map_err(|_| SessionFailure::AccessDenied)?;
    // A read transaction ensures both keys belong to one committed session revision.
    db.execute_batch("BEGIN")
        .map_err(|_| SessionFailure::AccessDenied)?;
    let read =
        |key: &str| -> Result<String, SessionFailure> {
            let value: Option<String> = db.query_row(
            "SELECT value FROM ItemTable WHERE key = ?1 AND length(value) BETWEEN 1 AND 16384",
            [key], |row| row.get(0),
        ).optional().map_err(|_| SessionFailure::InvalidCredentials)?;
            value.ok_or(SessionFailure::MissingCredentials)
        };
    let access_token = read("cursorAuth/accessToken")?;
    let auth_id = read("cursorAuth/stripeMembershipAuthId")?;
    if !cookie_component(&access_token) || !cookie_component(&auth_id) {
        return Err(SessionFailure::InvalidCredentials);
    }
    Ok(CursorSession {
        access_token,
        auth_id,
    })
}

pub fn cookie_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 16384
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub fn parse(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let root = root.as_object()?;
    if root.contains_key("error") {
        return None;
    }
    let start = epoch_ms_from_rfc3339(root.get("billingCycleStart")?.as_str()?)?;
    let end = epoch_ms_from_rfc3339(root.get("billingCycleEnd")?.as_str()?)?;
    if start > now_ms || end <= now_ms || end <= start || end - start > 366 * 86_400_000 {
        return None;
    }
    let individual = root.get("individualUsage")?.as_object()?;
    let plan = individual.get("plan").and_then(Value::as_object);
    let overall = individual.get("overall").and_then(Value::as_object);
    if (individual.contains_key("plan") && plan.is_none())
        || (individual.contains_key("overall") && overall.is_none())
    {
        return None;
    }
    let mut rows = Vec::new();
    let mut add = |meter: &str, percent: f64| -> Option<()> {
        let mut labels = super::labels("official-local-tool", "internal-endpoint", "high");
        labels.verification = "VERIFIED_FIXTURES".to_string();
        let mut row = super::base_snapshot(
            "CURSOR",
            meter,
            percent.min(100.0),
            SnapshotWindow {
                kind: "fixed".to_string(),
                duration_seconds: Some((end - start) / 1000),
            },
            Some(iso_from_epoch_ms(end)?),
            "internal_payload",
            if meter == "INCLUDED" {
                "estimated"
            } else {
                "exact"
            },
            &iso_from_epoch_ms(now_ms)?,
            &iso_from_epoch_ms(now_ms + 600_000)?,
            labels,
            account_id,
        );
        row.kind = Some("quota_percent".to_string());
        rows.push(row);
        Some(())
    };
    if let Some(plan) = plan {
        for (field, meter) in [("autoPercentUsed", "AUTO"), ("apiPercentUsed", "API")] {
            if let Some(value) = plan.get(field) {
                add(meter, super::number(Some(value), 1e12)?)?;
            }
        }
    }
    if let Some(overall) = overall {
        if overall.get("isUnlimited") != Some(&Value::Bool(true)) {
            let used = super::number(overall.get("used"), 1e12)?;
            let limit = super::number(overall.get("limit"), 1e12)?;
            if limit <= 0.0 {
                return None;
            }
            let percent = used / limit * 100.0;
            if !percent.is_finite() || percent > 1e12 {
                return None;
            }
            add("INCLUDED", percent)?;
        }
    }
    drop(add);
    let unlimited = root.get("isUnlimited") == Some(&Value::Bool(true))
        || individual.get("isUnlimited") == Some(&Value::Bool(true))
        || overall.and_then(|value| value.get("isUnlimited")) == Some(&Value::Bool(true));
    if unlimited {
        if !rows.is_empty() {
            return None;
        }
        let mut labels = super::labels("official-local-tool", "internal-endpoint", "high");
        labels.verification = "VERIFIED_FIXTURES".to_string();
        let mut row = super::base_snapshot(
            "CURSOR",
            "AUTO",
            0.0,
            SnapshotWindow {
                kind: "fixed".to_string(),
                duration_seconds: Some((end - start) / 1000),
            },
            Some(iso_from_epoch_ms(end)?),
            "internal_payload",
            "exact",
            &iso_from_epoch_ms(now_ms)?,
            &iso_from_epoch_ms(now_ms + 600_000)?,
            labels,
            account_id,
        );
        row.kind = Some("quota_percent".to_string());
        row.availability = Some("unlimited".to_string());
        rows.push(row);
    }
    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

pub(crate) async fn collect_account<T: crate::net::Transport>(
    detection: &crate::provider_detection::DetectionStore,
    policy: &crate::request_policy::RequestPolicy,
    transport: &T,
    writer: std::sync::Arc<crate::cache_write::CacheWriter>,
    account_id: &str,
    now_ms: u64,
) -> (bool, bool) {
    use crate::native_snapshot::{write_report, CacheReport};
    use crate::provider_detection::DetectedProviderId;
    use crate::request_policy::GateRejection;
    let provider = DetectedProviderId::Cursor;
    // Read once: the lease revision and request must describe the same session.
    let secret = detection.read_credential(provider, account_id);
    let revision = secret
        .as_ref()
        .map(|value| value.credential_revision.as_str())
        .unwrap_or("unavailable");
    let _lease = match policy.begin_with_revision(provider, account_id, now_ms, Some(revision)) {
        Ok(lease) => lease,
        Err(GateRejection::Deferred { .. } | GateRejection::Busy) => return (true, false),
        Err(GateRejection::Unavailable) => return (false, false),
    };
    let secret = match secret {
        Ok(secret) => secret,
        Err(error) => {
            let denied = matches!(
                error,
                crate::provider_detection::DetectedCredentialError::Unreadable
            );
            policy.refuse_account(provider, account_id, now_ms, denied);
            detection.mark_stale(provider, account_id);
            return (false, false);
        }
    };
    let response = crate::net::fetch_endpoint(
        transport,
        crate::net::ProviderEndpoint::CursorUsage,
        crate::reader_registry::AuthApplication::CursorSessionCookie,
        &secret.access_token,
        secret.provider_account_id.as_deref(),
    )
    .await;
    let report = match response {
        Ok(response) => match response.status {
            200..=299 => match response.body.as_deref().and_then(|body| {
                super::parse_body(
                    crate::reader_registry::ReaderId::CursorUsage,
                    body,
                    now_ms,
                    account_id,
                )
            }) {
                Some(rows) => CacheReport::Success(rows),
                None => {
                    let _ = writer.record_availability(
                        "CURSOR",
                        Some(account_id),
                        "schema_drift",
                        None,
                        now_ms,
                    );
                    policy.retry_account(provider, account_id, now_ms, None, false);
                    detection.mark_fallback(provider, account_id);
                    return (false, false);
                }
            },
            401 | 403 => {
                let denied = response.status == 403;
                policy.refuse_account(provider, account_id, now_ms, denied);
                detection.mark_stale(provider, account_id);
                return (false, denied);
            }
            429 => {
                policy.rate_limit_account(
                    provider,
                    account_id,
                    now_ms,
                    response.retry_after_seconds,
                );
                return (false, true);
            }
            _ => {
                policy.retry_account(provider, account_id, now_ms, None, false);
                detection.mark_fallback(provider, account_id);
                return (false, false);
            }
        },
        Err(_) => {
            policy.retry_account(provider, account_id, now_ms, None, false);
            detection.mark_fallback(provider, account_id);
            return (false, false);
        }
    };
    let cache_account = account_id.to_string();
    let committed = tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "CURSOR", Some(&cache_account), report)
    })
    .await
    .is_ok_and(|result| result.is_ok());
    if committed {
        policy.complete_after(provider, account_id, now_ms, 300);
        detection.mark_ready(provider, account_id);
    } else {
        policy.retry_account(provider, account_id, now_ms, None, false);
        detection.mark_fallback(provider, account_id);
    }
    (committed, false)
}

pub async fn run_pass(
    app: &tauri::AppHandle,
    covered: &std::collections::HashSet<crate::poll_identity::PollIdentity>,
    automatic_account_limit: usize,
) -> bool {
    use crate::provider_detection::{DetectedProviderId, DetectionStore};
    use tauri::Manager;
    let detection = app.state::<DetectionStore>();
    let policy = app.state::<crate::request_policy::RequestPolicy>();
    let transport = app.state::<crate::net::ReqwestTransport>();
    let writer = app.state::<std::sync::Arc<crate::cache_write::CacheWriter>>();
    let accounts = detection
        .account_ids(DetectedProviderId::Cursor)
        .into_iter()
        .filter(|id| {
            !covered.contains(&crate::poll_identity::PollIdentity::detected(
                crate::reader_registry::ProviderId::Cursor,
                id.clone(),
            ))
        })
        .take(automatic_account_limit);
    let mut succeeded = true;
    for id in accounts {
        let (ok, abort) = collect_account(
            &detection,
            &policy,
            &*transport,
            std::sync::Arc::clone(&writer),
            &id,
            crate::connections::now_epoch_ms(),
        )
        .await;
        succeeded &= ok;
        if abort {
            break;
        }
    }
    succeeded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_committed_wal_pair_without_mutating_the_database() {
        let directory = std::env::temp_dir().join(format!(
            "openlimiter-cursor-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("state.vscdb");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);").unwrap();
        writer
            .execute(
                "INSERT INTO ItemTable VALUES (?1, ?2)",
                ["cursorAuth/accessToken", "synthetic-token"],
            )
            .unwrap();
        writer
            .execute(
                "INSERT INTO ItemTable VALUES (?1, ?2)",
                ["cursorAuth/stripeMembershipAuthId", "synthetic-auth"],
            )
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let wal = path.with_extension("vscdb-wal");
        let before_wal = std::fs::read(&wal).unwrap();
        let result = session(&path).unwrap();
        assert!(result.access_token == "synthetic-token");
        assert!(result.auth_id == "synthetic-auth");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read(&wal).unwrap(), before_wal);
        drop(writer);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cookie_components_cannot_inject_headers_or_another_cookie() {
        for value in ["", "a;b", "a\r\nb", "a::b", "a b"] {
            assert!(!cookie_component(value));
        }
    }
}
