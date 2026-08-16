use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::OffsetDateTime;

pub fn iso_from_epoch_ms(milliseconds: u64) -> Option<String> {
    let nanos = i128::from(milliseconds).checked_mul(1_000_000)?;
    let instant = OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    instant
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .ok()
}

pub fn epoch_ms_from_rfc3339(value: &str) -> Option<u64> {
    if value.len() > 64 {
        return None;
    }
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    let has_zone = trimmed.ends_with('Z')
        || trimmed.ends_with('z')
        || (bytes.len() >= 6 && matches!(bytes[bytes.len() - 6], b'+' | b'-'));
    let owned;
    let candidate = if has_zone {
        trimmed
    } else {
        owned = format!("{trimmed}Z");
        &owned
    };
    let instant = OffsetDateTime::parse(candidate, &Rfc3339).ok()?;
    let milliseconds = instant.unix_timestamp_nanos().div_euclid(1_000_000);
    u64::try_from(milliseconds).ok()
}

pub fn future_rfc3339(value: &str, now_ms: u64, max_ahead_seconds: u64) -> Option<String> {
    let parsed = epoch_ms_from_rfc3339(value)?;
    if parsed <= now_ms || parsed > now_ms.saturating_add(max_ahead_seconds.saturating_mul(1_000)) {
        return None;
    }
    iso_from_epoch_ms(parsed)
}

pub fn future_epoch_seconds(
    value: f64,
    now_ms: u64,
    max_ahead_seconds: Option<u64>,
) -> Option<String> {
    if !value.is_finite() || value <= 0.0 || value >= 1_000_000_000_000.0 {
        return None;
    }
    let milliseconds = (value * 1_000.0).round();
    if milliseconds <= now_ms as f64 || milliseconds > u64::MAX as f64 {
        return None;
    }
    let milliseconds = milliseconds as u64;
    if max_ahead_seconds
        .is_some_and(|seconds| milliseconds > now_ms.saturating_add(seconds.saturating_mul(1_000)))
    {
        return None;
    }
    iso_from_epoch_ms(milliseconds)
}
