use std::sync::LazyLock;

use regex::Regex;

use crate::native_snapshot::{iso_from_epoch_ms, ConnectorLabels, Snapshot, SnapshotWindow};

const MAX_SEGMENT_BYTES: usize = 2_000;
const MAX_PAGE_CHARS: usize = 1_048_576;
const MAX_CONTAINER_DEPTH: usize = 6;
const MAX_WINDOW_SECONDS: u64 = 31_536_000;

static TAG_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<!--.*?-->|<\s*(/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>")
        .expect("constant tag pattern")
});
static MARKUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<!--.*?-->|<[^>]*>").expect("constant markup pattern"));
static PERCENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d{1,3})\s*%").expect("constant percentage pattern"));
static RESETS_IN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Resets in\s+((?:\d{1,6}\s*(?:day|hour|minute|second)s?\s*)+)")
        .expect("constant reset pattern")
});
static DURATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d{1,6})\s*(day|hour|minute|second)s?").expect("constant duration pattern")
});

#[derive(Clone)]
struct Tag {
    at: usize,
    end: usize,
    name: String,
    closing: bool,
    self_closing: bool,
}

struct Region {
    opened_at: usize,
    from: usize,
    to: usize,
}

fn void_element(name: &str) -> bool {
    [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
        "source", "track", "wbr",
    ]
    .contains(&name)
}

fn tags_in(html: &str, from: usize, to: usize) -> Vec<Tag> {
    let mut tags = Vec::new();
    let slice = &html[from..to];
    for captures in TAG_PATTERN.captures_iter(slice) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        let Some(name) = captures.get(2) else {
            continue;
        };
        let name = name.as_str().to_ascii_lowercase();
        let attributes = captures.get(3).map(|value| value.as_str()).unwrap_or("");
        tags.push(Tag {
            at: from + whole.start(),
            end: from + whole.end(),
            closing: captures.get(1).is_some_and(|value| value.as_str() == "/"),
            self_closing: attributes.trim_end().ends_with('/') || void_element(&name),
            name,
        });
    }
    tags
}

fn enclosing_element(html: &str, at: usize) -> Option<Region> {
    let search_from = at.saturating_sub(MAX_SEGMENT_BYTES);
    let before = tags_in(html, search_from, at);
    let mut pending_closes = 0usize;
    let mut container = None;
    for tag in before.into_iter().rev() {
        if tag.self_closing {
            continue;
        }
        if tag.closing {
            pending_closes += 1;
        } else if pending_closes > 0 {
            pending_closes -= 1;
        } else {
            container = Some(tag);
            break;
        }
    }
    let container = container?;
    let search_to = html
        .len()
        .min(container.end.saturating_add(MAX_SEGMENT_BYTES));
    let mut depth = 0usize;
    for tag in tags_in(html, container.end, search_to) {
        if tag.self_closing {
            continue;
        }
        if !tag.closing {
            depth += 1;
            continue;
        }
        if depth == 0 {
            return (tag.name == container.name).then_some(Region {
                opened_at: container.at,
                from: container.end,
                to: tag.at,
            });
        }
        depth -= 1;
    }
    None
}

fn flatten(fragment: &str) -> String {
    MARKUP
        .replace_all(fragment, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn window_region(html: &str, label_at: usize, other_labels: &[&str]) -> Option<String> {
    let mut position = label_at;
    for _ in 0..MAX_CONTAINER_DEPTH {
        let element = enclosing_element(html, position)?;
        let segment = flatten(&html[element.from..element.to]);
        if other_labels.iter().any(|label| segment.contains(label)) {
            return None;
        }
        if PERCENT.is_match(&segment) {
            return Some(segment);
        }
        position = element.opened_at;
    }
    None
}

fn duration_seconds(text: &str) -> Option<u64> {
    let mut total = 0u64;
    let mut seen = false;
    for captures in DURATION.captures_iter(text) {
        let count = captures.get(1)?.as_str().parse::<u64>().ok()?;
        let unit = match captures.get(2)?.as_str().to_ascii_lowercase().as_str() {
            "day" => 86_400,
            "hour" => 3_600,
            "minute" => 60,
            "second" => 1,
            _ => return None,
        };
        total = total.checked_add(count.checked_mul(unit)?)?;
        seen = true;
    }
    (seen && total > 0 && total <= MAX_WINDOW_SECONDS).then_some(total)
}

fn parse_windows(html: &str, now_ms: u64) -> Option<Vec<(u64, u64, Option<String>)>> {
    const WINDOWS: [(&str, u64); 3] = [
        ("Rolling Usage", 18_000),
        ("Weekly Usage", 604_800),
        ("Monthly Usage", 2_592_000),
    ];
    let mut found = Vec::new();
    for (label, seconds) in WINDOWS {
        let matches: Vec<usize> = html.match_indices(label).map(|(at, _)| at).collect();
        if matches.len() != 1 {
            return None;
        }
        found.push((matches[0], label, seconds));
    }
    found.sort_by_key(|entry| entry.0);
    let mut windows = Vec::new();
    for (at, label, window_seconds) in &found {
        let other_labels: Vec<&str> = found
            .iter()
            .filter_map(|(_, candidate, _)| (*candidate != *label).then_some(*candidate))
            .collect();
        let segment = window_region(html, *at, &other_labels)?;
        let captures = PERCENT.captures(&segment)?;
        let percent = captures.get(1)?.as_str().parse::<u64>().ok()?;
        if percent > 100 {
            return None;
        }
        let reset_at = RESETS_IN
            .captures(&segment)
            .and_then(|reset| reset.get(1))
            .and_then(|words| duration_seconds(words.as_str()))
            .and_then(|seconds| {
                now_ms
                    .checked_add(seconds.checked_mul(1_000)?)
                    .and_then(iso_from_epoch_ms)
            });
        windows.push((percent, *window_seconds, reset_at));
    }
    Some(windows)
}

pub fn parse_opencode(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    if body.is_empty() || body.chars().count() > MAX_PAGE_CHARS {
        return None;
    }
    let binding = parse_windows(body, now_ms)?
        .into_iter()
        .max_by_key(|window| window.0)?;
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at = iso_from_epoch_ms(now_ms.saturating_add(60_000))?;
    Some(vec![Snapshot {
        provider: "OPENCODE".to_string(),
        meter: "PRIMARY".to_string(),
        value: binding.0 as f64,
        unit: "PERCENT".to_string(),
        window: SnapshotWindow {
            kind: "rolling".to_string(),
            duration_seconds: Some(binding.1),
        },
        reset_at: binding.2,
        source: "authenticated_page".to_string(),
        precision: "estimated".to_string(),
        observed_at,
        expires_at,
        labels: ConnectorLabels {
            credential_origin: "browser-session".to_string(),
            data_interface_status: "authenticated-scrape".to_string(),
            automation_risk: "high".to_string(),
            verification: "UNVERIFIED".to_string(),
        },
        used_amount: None,
        limit_amount: None,
        currency: None,
        account_id: Some(account_id.to_string()),
        provenance: Some(serde_json::json!({
            "observedVia": "remote_http",
            "sourceKind": "remote_api"
        })),
    }])
}
